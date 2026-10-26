//! Parent-scoped child history reads. This path never acquires a child writer.
use super::*;

#[derive(Debug)]
pub enum ChildReadError {
    InvalidFence,
    UnrelatedChild,
    SourceUnavailable,
}

impl FreshCodexState {
    pub async fn read_child(
        &self,
        parent_session_id: &str,
        child_thread_id: &str,
        observed_epoch: Option<u64>,
        observed_generation: Option<u64>,
    ) -> Result<Value, ChildReadError> {
        crate::ownership_lane::wire_fence(observed_epoch, observed_generation)
            .map_err(|_| ChildReadError::InvalidFence)?;
        let parent = self.resolve_ownership_key(parent_session_id);
        let owner = self.ownership_snapshot(PROVIDER, &parent);
        if observed_epoch.is_some_and(|value| value != owner.epoch)
            || observed_generation.is_some_and(|value| value != owner.generation)
        {
            return Err(ChildReadError::SourceUnavailable);
        }
        // Resolve only the parent's existing registration. No child lifecycle,
        // provider startup, alternate HOME or gateway-side saved-history fallback.
        let (client, _) = self
            .snapshot_runtime_for(&parent)
            .await
            .map_err(|_| ChildReadError::SourceUnavailable)?;
        let parent_snapshot = self
            .get_snapshot(&parent, None)
            .await
            .map_err(|_| ChildReadError::SourceUnavailable)?;
        if !parent_snapshot["childThreads"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["threadId"] == child_thread_id)
        {
            return Err(ChildReadError::UnrelatedChild);
        }
        let projection = self
            .sessions
            .lock()
            .await
            .get(&parent)
            .filter(|session| Arc::ptr_eq(&session.client, &client))
            .map(|session| session.projection.clone())
            .ok_or(ChildReadError::SourceUnavailable)?;
        let fence = projection
            .lock()
            .expect("codex projection lock")
            .begin_history_read();
        let read = client.read_thread(child_thread_id, true).await;
        let (raw, materialized, unmaterialized) = match read {
            Ok(raw) => (raw, true, false),
            Err(error) => {
                let unmaterialized =
                    is_codex_include_turns_unavailable(&error) || is_codex_thread_not_found(&error);
                tracing::warn!(provider=PROVIDER, session_id=%parent, child_thread_id, error=%error, "freshagent.codex.child_history_unavailable");
                match client.read_thread(child_thread_id, false).await {
                    Ok(raw) => (raw, false, unmaterialized),
                    Err(_) => {
                        self.check_child_source(&parent, &client, &projection, &fence, &owner)
                            .await?;
                        if !unmaterialized {
                            return Err(ChildReadError::SourceUnavailable);
                        }
                        return Ok(observation(
                            &parent,
                            child_thread_id,
                            "unavailable",
                            "history_unavailable",
                            false,
                        ));
                    }
                }
            }
        };
        self.check_child_source(&parent, &client, &projection, &fence, &owner)
            .await?;
        if raw["thread"]["id"].as_str() != Some(child_thread_id)
            || raw["thread"]["parentThreadId"]
                .as_str()
                .is_some_and(|id| id != parent)
        {
            tracing::warn!(provider=PROVIDER, session_id=%parent, child_thread_id, reason="native_identity_mismatch", "freshagent.codex.child_read_rejected");
            return Err(ChildReadError::UnrelatedChild);
        }
        if raw["thread"]["ephemeral"] == true {
            return Ok(observation(
                &parent,
                child_thread_id,
                "unavailable",
                "ephemeral_history_unavailable",
                false,
            ));
        }
        if !materialized && !unmaterialized {
            return Err(ChildReadError::SourceUnavailable);
        }
        if !materialized || raw["thread"]["turns"].as_array().is_none_or(Vec::is_empty) {
            let live =
                normalize_codex_thread_status(&raw["thread"]["status"]) == CodexStatus::Running;
            let mut attempts = self.child_reads.lock().await;
            // The registration/projection id changes at a parent source replacement.
            let source = projection.lock().expect("codex projection lock").id.clone();
            let count = attempts
                .entry((parent.clone(), child_thread_id.to_owned(), source))
                .or_default();
            *count = count.saturating_add(1);
            return Ok(if live && *count < 3 {
                observation(
                    &parent,
                    child_thread_id,
                    "pending",
                    "history_unmaterialized",
                    true,
                )
            } else {
                observation(
                    &parent,
                    child_thread_id,
                    "unavailable",
                    "history_unavailable",
                    false,
                )
            });
        }
        let mut snapshot =
            build_codex_snapshot_json(child_thread_id, &raw, false, None, None, false)
                .map_err(|_| ChildReadError::SourceUnavailable)?;
        if snapshot["turns"].as_array().is_none_or(Vec::is_empty) {
            tracing::warn!(provider=PROVIDER, session_id=%parent, child_thread_id, reason="no_supported_history_items", "freshagent.codex.child_history_unavailable");
            return Ok(observation(
                &parent,
                child_thread_id,
                "unavailable",
                "history_unavailable",
                false,
            ));
        }
        stamp_readonly_child(&mut snapshot, &parent);
        // Availability does not imply a turn completed or persisted every token.
        snapshot["extensions"]["codex"]["childHistory"] = json!({
            "threadStatus":raw["thread"]["status"], "ephemeral":raw["thread"]["ephemeral"],
            "turns":raw["thread"]["turns"].as_array().into_iter().flatten().map(|turn| json!({"turnId":turn["id"],"status":turn["status"],"itemsView":turn["itemsView"]})).collect::<Vec<_>>()
        });
        let status =
            if normalize_codex_thread_status(&raw["thread"]["status"]) == CodexStatus::Running {
                "live"
            } else {
                "saved"
            };
        Ok(
            json!({"parentThreadId":parent, "childThreadId":child_thread_id, "status":status, "snapshot":snapshot}),
        )
    }

    async fn check_child_source(
        &self,
        parent: &str,
        client: &Arc<CodexAppServerClient>,
        projection: &Arc<StdMutex<projection::CodexProjection>>,
        fence: &projection::SnapshotReadFence,
        owner: &freshell_ownership::OwnershipSnapshot,
    ) -> Result<(), ChildReadError> {
        let current = self.ownership_snapshot(PROVIDER, parent);
        let same = self
            .sessions
            .lock()
            .await
            .get(parent)
            .is_some_and(|session| {
                Arc::ptr_eq(&session.client, client) && Arc::ptr_eq(&session.projection, projection)
            });
        if !same
            || current.epoch != owner.epoch
            || current.generation != owner.generation
            || current.state != owner.state
            || !projection
                .lock()
                .expect("codex projection lock")
                .matches_fence(fence)
        {
            tracing::warn!(
                provider = PROVIDER,
                session_id = parent,
                "freshagent.codex.child_source_changed"
            );
            return Err(ChildReadError::SourceUnavailable);
        }
        Ok(())
    }
}

pub fn stamp_readonly_child(snapshot: &mut Value, parent: &str) {
    if let Some(capabilities) = snapshot["capabilities"].as_object_mut() {
        for value in capabilities.values_mut() {
            if value.is_boolean() {
                *value = json!(false);
            }
        }
        capabilities.remove("settingScopes");
    }
    snapshot["pendingApprovals"] = json!([]);
    snapshot["pendingQuestions"] = json!([]);
    snapshot["extensions"]["codex"]["observer"] = json!({"parentThreadId":parent, "readOnly":true});
}

pub fn observation(
    parent: &str,
    child: &str,
    status: &str,
    reason: &str,
    retryable: bool,
) -> Value {
    json!({"parentThreadId":parent,"childThreadId":child,"status":status,"reason":reason,"retryable":retryable})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent() -> Value {
        json!({"thread":{"id":"parent","status":{"type":"idle"},"ephemeral":false,"turns":[{"id":"parent-turn","status":"completed","items":[{"id":"spawn","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","senderThreadId":"parent","receiverThreadIds":["child"],"agentsStates":{"child":{"status":"running"}}}]}]}})
    }

    async fn fixture(
        child: Value,
    ) -> (
        FreshCodexState,
        tokio::task::JoinHandle<Vec<(String, Value)>>,
    ) {
        fixture_for(parent(), child).await
    }

    async fn fixture_for(
        parent: Value,
        child: Value,
    ) -> (
        FreshCodexState,
        tokio::task::JoinHandle<Vec<(String, Value)>>,
    ) {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _) = CodexAppServerClient::connect(transport);
        let (state, _) = super::super::tests::state_with_bus();
        state
            .insert_session_for_test(
                parent["thread"]["id"].as_str().unwrap(),
                Arc::new(client),
                None,
            )
            .await;
        let driver = tokio::spawn(async move {
            let mut reads = vec![];
            loop {
                let request =
                    tokio::time::timeout(Duration::from_secs(2), peer.expect_request()).await;
                let Ok((id, method, params)) = request else {
                    break;
                };
                reads.push((method.clone(), params.clone()));
                if method == "initialize" {
                    peer.respond(&id, json!({"userAgent":"fixture", "codexHome":"/owned", "platformFamily":"unix", "platformOs":"linux"}));
                    let _ = peer.expect_notification().await;
                } else if method == "thread/read" {
                    if params["threadId"] != parent["thread"]["id"]
                        && params["includeTurns"] == true
                        && child["_historyUnavailable"] == true
                    {
                        peer.respond_error(
                            &id,
                            -32600,
                            child["_historyError"]
                                .as_str()
                                .unwrap_or("includeTurns is unavailable before first user message"),
                        );
                        continue;
                    }
                    peer.respond(
                        &id,
                        if params["threadId"] == parent["thread"]["id"] {
                            parent.clone()
                        } else {
                            child.clone()
                        },
                    );
                } else {
                    panic!("observer dispatched a writer operation: {method}");
                }
            }
            reads
        });
        (state, driver)
    }

    #[tokio::test]
    async fn child_read_replays_captured_0164_active_final_and_cold_saved_histories() {
        let capture: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/fresh-agent/codex/native-children-0.164.json"
        ))
        .unwrap();
        let parent = capture["parent"]["thread"]["id"].as_str().unwrap();
        for phase in ["active", "final", "saved"] {
            let raw = capture[phase].clone();
            let child = raw["thread"]["id"].as_str().unwrap().to_owned();
            let (state, driver) = fixture_for(capture["parent"].clone(), raw.clone()).await;
            let result = state.read_child(parent, &child, None, None).await.unwrap();
            assert_eq!(result["parentThreadId"], parent);
            assert_eq!(result["childThreadId"], child);
            assert_eq!(
                result["snapshot"]["extensions"]["codex"]["childHistory"]["threadStatus"],
                raw["thread"]["status"]
            );
            assert_eq!(result["snapshot"]["capabilities"]["send"], false);
            if phase != "active" {
                assert!(result["snapshot"]
                    .to_string()
                    .contains("Exact child final answer."));
            }
            state.shutdown().await;
            assert!(driver
                .await
                .unwrap()
                .iter()
                .all(|(method, _)| matches!(method.as_str(), "initialize" | "thread/read")));
        }
    }

    #[tokio::test]
    async fn child_read_uses_only_parent_client_and_preserves_exact_saved_body() {
        let (state, driver) = fixture(json!({"thread":{"id":"child","parentThreadId":"parent","status":{"type":"idle"},"ephemeral":false,"turns":[{"id":"child-turn","status":"completed","items":[{"id":"answer","type":"agentMessage","text":"Exact child answer"}]}]}})).await;
        let observed = state.read_child("parent", "child", Some(0), Some(0)).await;
        state.shutdown().await;
        let reads = driver.await.unwrap();
        let observed = observed.expect("available parent-scoped native history");
        assert_eq!(observed["status"], "saved");
        assert_eq!(observed["parentThreadId"], "parent");
        assert_eq!(observed["childThreadId"], "child");
        assert_eq!(observed["snapshot"]["threadId"], "child");
        assert_eq!(
            observed["snapshot"]["turns"][0]["items"][0]["text"],
            "Exact child answer"
        );
        for flag in [
            "send",
            "interrupt",
            "fork",
            "approvals",
            "questions",
            "undo",
            "redo",
        ] {
            assert_eq!(observed["snapshot"]["capabilities"][flag], false);
        }
        assert!(reads
            .iter()
            .all(|(method, _)| matches!(method.as_str(), "initialize" | "thread/read")));
        assert!(reads
            .iter()
            .any(|(_, params)| params["threadId"] == "child" && params["includeTurns"] == true));
    }

    #[tokio::test]
    async fn child_read_rejects_unrelated_identity_without_reading_it() {
        let (state, driver) = fixture(json!({})).await;
        let result = state.read_child("parent", "unrelated", None, None).await;
        state.shutdown().await;
        let reads = driver.await.unwrap();
        assert!(matches!(result, Err(ChildReadError::UnrelatedChild)));
        assert!(!reads
            .iter()
            .any(|(_, params)| params["threadId"] == "unrelated"));
    }

    #[tokio::test]
    async fn child_read_pending_materialization_is_bounded_and_ephemeral_is_terminal() {
        for ephemeral in [false, true] {
            let (state, driver) = fixture(json!({"thread":{"id":"child","parentThreadId":"parent","ephemeral":ephemeral,"status":{"type":"active"},"turns":[]}})).await;
            for attempt in 1..=4 {
                let value = state
                    .read_child("parent", "child", None, None)
                    .await
                    .unwrap();
                assert!(value.get("snapshot").is_none());
                if ephemeral {
                    assert_eq!(value["status"], "unavailable");
                    assert_eq!(value["reason"], "ephemeral_history_unavailable");
                    assert_eq!(value["retryable"], false);
                } else if attempt < 3 {
                    assert_eq!(value["status"], "pending");
                    assert_eq!(value["reason"], "history_unmaterialized");
                } else {
                    assert_eq!(value["status"], "unavailable");
                }
            }
            state.shutdown().await;
            assert!(driver
                .await
                .unwrap()
                .iter()
                .all(|(method, _)| matches!(method.as_str(), "initialize" | "thread/read")));
        }
    }

    #[tokio::test]
    async fn child_read_ephemeral_metadata_refusal_has_no_empty_success_snapshot() {
        let (state,driver) = fixture(json!({"_historyUnavailable":true,"thread":{"id":"child","parentThreadId":"parent","ephemeral":true,"status":{"type":"active"},"turns":[]}})).await;
        let value = state
            .read_child("parent", "child", None, None)
            .await
            .unwrap();
        assert_eq!(value["reason"], "ephemeral_history_unavailable");
        assert!(value.get("snapshot").is_none());
        assert_eq!(value["retryable"], false);
        state.shutdown().await;
        let reads = driver.await.unwrap();
        assert!(reads
            .iter()
            .any(|(_, params)| params["threadId"] == "child" && params["includeTurns"] == false));
    }

    #[tokio::test]
    async fn child_read_unknown_only_history_does_not_return_an_empty_readable_snapshot() {
        let (state,driver) = fixture(json!({"thread":{"id":"child","parentThreadId":"parent","status":{"type":"idle"},"turns":[{"id":"future-turn","items":[{"id":"future","type":"futureVariant"}]}]}})).await;
        let value = state
            .read_child("parent", "child", None, None)
            .await
            .unwrap();
        state.shutdown().await;
        let _ = driver.await.unwrap();
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["reason"], "history_unavailable");
        assert!(value.get("snapshot").is_none());
    }

    #[tokio::test]
    async fn child_read_temporary_source_failure_is_retryable_source_unavailable() {
        let (state,driver) = fixture(json!({"_historyUnavailable":true,"_historyError":"temporary provider read failure","thread":{"id":"child","parentThreadId":"parent","ephemeral":false,"status":{"type":"active"},"turns":[]}})).await;
        let result = state.read_child("parent", "child", None, None).await;
        state.shutdown().await;
        let _ = driver.await.unwrap();
        assert!(matches!(result,Err(ChildReadError::SourceUnavailable)),"temporary source failure must not become pending or permanently missing history: {result:?}");
    }

    #[tokio::test]
    async fn child_read_rejects_replaced_parent_source_during_paused_read() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _) = CodexAppServerClient::connect(transport);
        let (state, _) = super::super::tests::state_with_bus();
        state
            .insert_session_for_test("parent", Arc::new(client), None)
            .await;
        let read = {
            let state = state.clone();
            tokio::spawn(async move { state.read_child("parent", "child", None, None).await })
        };
        let (id, method, _) = tokio::time::timeout(Duration::from_secs(3), peer.expect_request())
            .await
            .expect("parent initialization must be requested");
        assert_eq!(method, "initialize");
        peer.respond(&id,json!({"userAgent":"fixture","codexHome":"/owned","platformFamily":"unix","platformOs":"linux"}));
        let _ = tokio::time::timeout(Duration::from_secs(3), peer.expect_notification())
            .await
            .expect("initialized notification");
        let (id, method, params) =
            tokio::time::timeout(Duration::from_secs(3), peer.expect_request())
                .await
                .expect("parent history read");
        assert_eq!(method, "thread/read");
        assert_eq!(params["threadId"], "parent");
        peer.respond(&id, parent());
        let (id, method, params) =
            tokio::time::timeout(Duration::from_secs(3), peer.expect_request())
                .await
                .expect("child history read after parent membership");
        assert_eq!(method, "thread/read");
        assert_eq!(params["threadId"], "child");
        state
            .sessions
            .lock()
            .await
            .get_mut("parent")
            .unwrap()
            .projection = Arc::new(StdMutex::new(projection::CodexProjection::new(
            "replacement".into(),
            "parent".into(),
        )));
        peer.respond(&id,json!({"thread":{"id":"child","parentThreadId":"parent","turns":[{"id":"t","items":[{"id":"a","type":"agentMessage","text":"Stale body"}]}]}}));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(3), read)
                .await
                .expect("child source refusal must settle")
                .unwrap(),
            Err(ChildReadError::SourceUnavailable)
        ));
        // ChannelTransport's reader owns the receive lock while awaiting the
        // peer. End that owned peer before asking the client to close it.
        drop(peer);
        state.shutdown().await;
    }
}

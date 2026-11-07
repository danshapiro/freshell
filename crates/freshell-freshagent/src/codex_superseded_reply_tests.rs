async fn assert_codex_superseded_recovery_owner_reply(route: &'static str) {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, OwnershipState, RuntimeOwnerKind,
        RuntimeOwnershipRegistry,
    };

    let _environment = super::tests::ENV_LOCK.lock().await;
    let id = "codex-superseded-owner-reply";
    let (mut state, mut bus, _sink) = super::tests::state_with_sink();
    let crashed = matches!(route, "crash-attach" | "crash-attach-legacy" | "send");
    let legacy = route.ends_with("-legacy");
    if crashed {
        super::tests::configure_fake_codex_cmd(&json!({"threadStartThreadId":id}).to_string());
        assert_eq!(
            super::tests::create_real_fake_session(&state, &mut bus).await,
            id
        );
        let (pid, runtime_id) = {
            let sessions = state.sessions.lock().await;
            let session = sessions.get(id).unwrap();
            (
                session.sidecar_pid.unwrap(),
                session.sidecar_ownership_id.clone(),
            )
        };
        assert!(
            crate::session_lease::kill_and_confirm_tree_dead(
                pid,
                CODEX_SIDECAR_OWNERSHIP_ENV,
                &runtime_id,
            )
            .await
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let settled = {
                    let sessions = state.sessions.lock().await;
                    let session = sessions.get(id).unwrap();
                    session.consumer.is_finished() && session.watcher.is_finished()
                };
                if settled {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the original native process and its observers settle before recovery");
        state.leases.clear_binding(PROVIDER, id);
    }

    let registry = Arc::new(RuntimeOwnershipRegistry::with_epoch(491));
    state.set_ownership(registry.clone());
    let handoff_generation = if route == "handoff" {
        let BeginOutcome::Granted { generation } = registry.begin_handoff(
            PROVIDER,
            id,
            RuntimeOwnerKind::FreshAgent,
            "superseded-owner-handoff",
            None,
            "test",
            1,
        ) else {
            panic!("the target resume starts under a real Handoff claim");
        };
        Some(generation)
    } else {
        None
    };
    let temporary = tempfile::tempdir().unwrap();
    let waiting = temporary.path().join("native-waiting");
    let release = temporary.path().join("native-release");
    let requests = temporary.path().join("native-requests.jsonl");
    super::tests::configure_fake_codex_cmd(
        &json!({
            "resumeWaitingPath":waiting,
            "waitForResumeReleasePath":release,
            "appendRequestLogPath":requests,
            "overrides":{"thread/resume":{"error":{
                "code":-32042,"message":"native resume failed after ownership changed"
            }}}
        })
        .to_string(),
    );
    let frames = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let captured = frames.clone();
    let st = state.clone();
    let request = tokio::spawn(async move {
        match route {
            "historical-attach"
            | "crash-attach"
            | "historical-attach-legacy"
            | "crash-attach-legacy" => {
                let mut attach = json!({
                    "provider":"codex", "sessionType":"freshcodex", "sessionId":id
                });
                if !legacy {
                    attach["requestId"] = json!("superseded-owner-request");
                    attach["viewId"] = json!("superseded-owner-view");
                }
                st.handle_attach(
                    serde_json::from_value(attach).unwrap(),
                    Arc::new(move |frame| {
                        captured
                            .lock()
                            .unwrap()
                            .push(serde_json::to_value(frame).unwrap())
                    }),
                )
                .await;
                None
            }
            "send" => {
                let CodexSendOutcome::Refused {
                    code,
                    message,
                    owner,
                    ..
                } = st.handle_send(send(id, "superseded-owner-request")).await
                else {
                    panic!("a superseded native resume must refuse the send");
                };
                Some((code, message, owner))
            }
            "handoff" => {
                let error = st
                    .resume_for_handoff(
                        id,
                        None,
                        "superseded-owner-handoff",
                        handoff_generation.unwrap(),
                    )
                    .await
                    .expect_err("the superseded target resume must refuse the handoff");
                Some((error.code, error.detail, error.owner))
            }
            _ => unreachable!(),
        }
    });
    tokio::time::timeout(Duration::from_secs(15), async {
        while !waiting.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the real native thread/resume request reaches its gate");
    let claim = registry.observe(PROVIDER, id);
    let (OwnershipState::Starting { operation_id, .. }
    | OwnershipState::Handoff { operation_id, .. }) = claim.state
    else {
        panic!("the waiting provider operation owns a real lifecycle claim");
    };
    registry.fail(PROVIDER, id, &operation_id, claim.generation, false);
    let BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        id,
        RuntimeOwnerKind::Terminal,
        "replacement-terminal",
        None,
        "test",
        2,
    ) else {
        panic!("the replacement terminal obtains the superseded operation's key");
    };
    assert_eq!(
        registry.commit_live(
            PROVIDER,
            id,
            "replacement-terminal",
            generation,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("replacement-terminal".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            },
        ),
        CommitOutcome::Committed
    );
    let replacement = registry.observe(PROVIDER, id);
    std::fs::write(&release, "release").unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(15), request)
        .await
        .expect("native failure settles the public requester")
        .unwrap();
    assert_eq!(registry.observe(PROVIDER, id), replacement);
    assert!(!state.is_known_dead_thread(id).await);
    let budget = state
        .session_recovery
        .status(&state.recovery_map_key(id))
        .await;
    state.shutdown().await;

    if let Some((code, message, owner)) = outcome {
        assert_eq!(
            code,
            if route == "send" {
                "CODEX_RESPAWN_FAILED"
            } else {
                "codex resume failed"
            }
        );
        assert!(
            message.contains("ownership") || message.contains("close"),
            "{message}"
        );
        assert_eq!(
            owner,
            Some(crate::ownership_lane::TerminalOwnerFields {
                owner_kind: "terminal",
                owner_epoch: 491,
                owner_generation: generation,
            })
        );
    }
    let methods: Vec<String> = std::fs::read_to_string(requests)
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["method"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        methods
            .iter()
            .filter(|method| *method == "thread/resume")
            .count(),
        1
    );
    assert!(!methods
        .iter()
        .any(|method| matches!(method.as_str(), "thread/start" | "turn/start")));
    if route == "handoff" {
        assert!(
            budget.is_none(),
            "under-ticket handoff does not enter shared recovery"
        );
        return;
    }
    let budget = budget.expect("the public request used shared recovery");
    assert_eq!(budget.failed_launches, 0);
    assert!(budget.retry_after_ms.is_none());
    let mut replies = frames.lock().unwrap().clone();
    replies.extend(
        std::iter::from_fn(|| bus.try_recv().ok())
            .map(|raw| serde_json::from_str::<Value>(&raw).unwrap())
            .filter(|frame| frame["requestId"] == "superseded-owner-request"),
    );
    assert_eq!(
        replies.len(),
        1,
        "{route}: exactly one requester reply: {replies:?}"
    );
    let reply = &replies[0];
    assert_eq!(
        json!([
            reply["ownerKind"],
            reply["ownerEpoch"],
            reply["ownerGeneration"]
        ]),
        json!(["terminal", 491, generation]),
        "{route}: {reply}"
    );
    if legacy {
        assert!(reply.get("requestId").is_none());
        assert!(reply.get("viewId").is_none());
    } else {
        assert_eq!(reply["requestId"], "superseded-owner-request");
    }
    if route == "send" {
        assert_eq!(reply["type"], "error");
        assert!(reply["message"]
            .as_str()
            .unwrap()
            .starts_with("CODEX_RESPAWN_FAILED:"));
    } else {
        if legacy {
            // Legacy replies return the captured provider error unchanged;
            // modern AttachOutcome owner enrichment cannot mask metadata loss.
            assert_eq!(reply["type"], "error");
        } else {
            assert_eq!(reply["type"], "freshAgent.attach.failed");
            assert_eq!(reply["viewId"], "superseded-owner-view");
        }
        assert_eq!(reply["code"], "INTERNAL_ERROR");
        let prefix = if crashed {
            "CODEX_ATTACH_RESPAWN_FAILED:"
        } else {
            "CODEX_ATTACH_RESUME_FAILED:"
        };
        assert!(reply["message"].as_str().unwrap().starts_with(prefix));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_superseded_recovery_historical_attach_preserves_owner() {
    assert_codex_superseded_recovery_owner_reply("historical-attach").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_superseded_recovery_crash_attach_preserves_owner() {
    assert_codex_superseded_recovery_owner_reply("crash-attach").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_superseded_recovery_historical_legacy_attach_preserves_owner() {
    assert_codex_superseded_recovery_owner_reply("historical-attach-legacy").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_superseded_recovery_crash_legacy_attach_preserves_owner() {
    assert_codex_superseded_recovery_owner_reply("crash-attach-legacy").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_superseded_recovery_send_preserves_owner() {
    assert_codex_superseded_recovery_owner_reply("send").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_superseded_recovery_handoff_preserves_owner() {
    assert_codex_superseded_recovery_owner_reply("handoff").await;
}

#[test]
fn codex_refusal_owner_decoration_preserves_typed_envelope_and_handles_malformed_event() {
    let owner = crate::ownership_lane::TerminalOwnerFields {
        owner_kind: "terminal",
        owner_epoch: 491,
        owner_generation: 7,
    };
    for event in [
        json!({"type":"freshAgent.error","message":"refused"}),
        json!("malformed"),
    ] {
        let frame = FreshAgentEvent {
            event: event.clone(),
            provider: PROVIDER.into(),
            session_id: "owner-helper".into(),
            session_type: SESSION_TYPE.into(),
        };
        let decorated = with_codex_refusal_owner(frame.clone(), Some(&owner));
        assert_eq!(decorated.provider, frame.provider);
        assert_eq!(decorated.session_id, frame.session_id);
        assert_eq!(decorated.session_type, frame.session_type);
        if event.is_object() {
            assert_eq!(
                decorated.event,
                json!({
                    "type":"freshAgent.error","message":"refused", "ownerKind":"terminal",
                    "ownerEpoch":491,"ownerGeneration":7,
                })
            );
        } else {
            assert_eq!(
                decorated.event, event,
                "malformed provider payloads are left intact without panicking"
            );
        }
        assert_eq!(with_codex_refusal_owner(frame.clone(), None), frame);
    }
}

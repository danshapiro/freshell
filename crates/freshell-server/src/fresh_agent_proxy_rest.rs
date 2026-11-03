//! REST/MCP ingress backed exclusively by the durable fresh-agent host.

use super::*;
use freshell_freshagent::rest_lane::RestLaneErrorCorrelation;

#[async_trait::async_trait]
impl FreshAgentRestLane for HostedFreshAgentProxy {
    async fn model_catalog_source(
        &self,
        context: freshell_freshagent::model_capabilities::CodexCatalogContext,
    ) -> Result<
        freshell_freshagent::model_capabilities::CodexCatalogSource,
        freshell_freshagent::model_capabilities::CapabilityError,
    > {
        use freshell_freshagent::model_capabilities::{
            runtime_pending, source_changed, CodexCatalogSource,
        };
        let requested = context.native_reference()?;
        let ownership = self.ownership.get().cloned();
        let owner = ownership.as_ref().map(|registry| {
            let id = registry.resolve_canonical("codex", requested);
            registry.observe("codex", &id)
        });
        if owner.as_ref().is_some_and(|owner| {
            context.observed_epoch.is_some_and(|v| v != owner.epoch)
                || context
                    .observed_generation
                    .is_some_and(|v| v != owner.generation)
        }) {
            return Err(source_changed());
        }
        let inventory = self
            .client
            .inventory()
            .await
            .map_err(|_| runtime_pending())?;
        let view = inventory
            .iter()
            .rev()
            .find(|view| {
                view.provider.as_deref() == Some("codex")
                    && view.fresh_agent_session_type.as_deref() == Some("freshcodex")
                    && (view.fresh_agent_session_id.as_deref() == Some(requested)
                        || view.native_session_id.as_deref() == Some(requested))
            })
            .ok_or_else(runtime_pending)?;
        if view.native_session_id.is_none()
            || view.launch_state != freshell_runtime_protocol::LaunchState::Running
            || view.recovery_state != freshell_runtime_protocol::RecoveryState::Live
            || view.desired_state != DesiredState::Running
        {
            return Err(runtime_pending());
        }
        let key = catalog_source_key(view, owner.as_ref());
        Ok(CodexCatalogSource {
            key,
            probe: Arc::new(HostedCodexCatalogProbe {
                client: self.client.clone(),
                view: view.clone(),
                context,
                ownership,
                owner,
            }),
        })
    }
    async fn read_child(
        &self,
        request: freshell_freshagent::rest_lane::RestLaneChildRead,
    ) -> Result<Option<serde_json::Value>, freshell_freshagent::codex::children::ChildReadError>
    {
        use freshell_freshagent::codex::children::{stamp_readonly_child, ChildReadError};
        let ownership = self.ownership.get().map(|registry| {
            let id = registry.resolve_canonical("codex", &request.parent_session_id);
            registry.observe("codex", &id)
        });
        if ownership.as_ref().is_some_and(|owner| {
            request
                .observed_epoch
                .is_some_and(|epoch| epoch != owner.epoch)
                || request
                    .observed_generation
                    .is_some_and(|generation| generation != owner.generation)
        }) {
            return Err(ChildReadError::SourceUnavailable);
        }
        let inventory = self
            .client
            .inventory()
            .await
            .map_err(|_| ChildReadError::SourceUnavailable)?;
        // The child is deliberately never looked up as a root soul.
        let Some(view) = inventory.iter().rev().find(|view| {
            view.provider.as_deref() == Some("codex")
                && view.fresh_agent_session_type.as_deref() == Some("freshcodex")
                && (view.fresh_agent_session_id.as_deref() == Some(&request.parent_session_id)
                    || view.native_session_id.as_deref() == Some(&request.parent_session_id))
        }) else {
            return Ok(None);
        };
        let parent = view
            .native_session_id
            .as_deref()
            .ok_or(ChildReadError::SourceUnavailable)?;
        let mut value = self.client.fresh_agent_read_child(view.soul_id.clone(), request.child_thread_id.clone()).await.map_err(|error| {
            tracing::warn!(provider="codex", soul_id=%view.soul_id, session_id=parent, child_thread_id=%request.child_thread_id, code=?error.runtime_code(), "fresh_agent.hosted_child_unavailable");
            ChildReadError::SourceUnavailable
        })?;
        let inventory_after = self
            .client
            .inventory()
            .await
            .map_err(|_| ChildReadError::SourceUnavailable)?;
        let latest = inventory_after
            .iter()
            .rev()
            .find(|row| row.soul_id == view.soul_id)
            .ok_or(ChildReadError::SourceUnavailable)?;
        let owner_changed =
            self.ownership
                .get()
                .zip(ownership.as_ref())
                .is_some_and(|(registry, before)| {
                    let id = registry.resolve_canonical("codex", &request.parent_session_id);
                    let after = registry.observe("codex", &id);
                    after.epoch != before.epoch
                        || after.generation != before.generation
                        || after.state != before.state
                });
        if owner_changed
            || !same_snapshot_source(view, latest)
            || value["parentThreadId"].as_str() != Some(parent)
            || value["childThreadId"].as_str() != Some(request.child_thread_id.as_str())
        {
            return Err(ChildReadError::SourceUnavailable);
        }
        if let Some(snapshot) = value.get_mut("snapshot") {
            if snapshot["threadId"].as_str() != Some(request.child_thread_id.as_str())
                || snapshot["provider"] != "codex"
                || snapshot["sessionType"] != "freshcodex"
            {
                return Err(ChildReadError::SourceUnavailable);
            }
            stamp_readonly_child(snapshot, parent);
        }
        Ok(Some(value))
    }
    async fn snapshot(
        &self,
        request: freshell_freshagent::rest_lane::RestLaneSnapshot,
    ) -> Result<Option<serde_json::Value>, freshell_freshagent::rest_lane::RestLaneSnapshotError>
    {
        use freshell_freshagent::rest_lane::RestLaneSnapshotError::{
            ManagedUnavailable, OwnershipUnavailable,
        };
        let (provider, session_type) =
            rest_agent_identity(&request.provider, &request.session_type)
                .map_err(|_| OwnershipUnavailable)?;
        let runtime_provider =
            fresh_provider(&Some(provider), session_type).ok_or(OwnershipUnavailable)?;
        let alias_key = (request.provider.clone(), request.session_id.clone());
        let inventory = match self.client.inventory().await {
            Ok(inventory) => inventory,
            Err(_) => {
                return Err(if self.aliases.lock().await.contains_key(&alias_key) {
                    ManagedUnavailable
                } else {
                    OwnershipUnavailable
                })
            }
        };
        let view = inventory.iter().rev().find(|view| {
            view.provider.as_deref() == Some(runtime_provider.as_str())
                && (view.fresh_agent_session_id.as_deref() == Some(&request.session_id)
                    || view.native_session_id.as_deref() == Some(&request.session_id))
        });
        let Some(view) = view else {
            return Ok(None);
        };
        self.aliases
            .lock()
            .await
            .insert(alias_key, view.soul_id.clone());
        let (mut snapshot, history_only) = match self
            .client
            .fresh_agent_snapshot(view.soul_id.clone())
            .await
        {
            Ok(snapshot) => (snapshot, false),
            Err(error) => {
                tracing::warn!(soul_id = %view.soul_id, code = ?error.runtime_code(), "fresh_agent.hosted_snapshot_unavailable");
                (
                    self.client
                        .fresh_agent_history(view.soul_id.clone())
                        .await
                        .map_err(|_| ManagedUnavailable)?,
                    true,
                )
            }
        };
        // Native history cannot carry an unassigned live provider diagnostic.
        // This is an optional enrichment: a missing or stalled retained read
        // must not prevent the owned saved history from being displayed.
        let retained_codex = if history_only
            && runtime_provider == FreshProvider::Codex
            && view.host_boot_id.is_some()
        {
            match tokio::time::timeout(
                Duration::from_secs(2),
                self.client
                    .fresh_agent_retained_state(view.soul_id.clone(), 1_500),
            )
            .await
            {
                Ok(Ok(retained)) => retained,
                Ok(Err(error)) => {
                    tracing::warn!(provider = "codex", soul_id = %view.soul_id,
                        code = ?error.runtime_code(), "fresh_agent.hosted_retained_diagnostic_unavailable");
                    None
                }
                Err(_) => {
                    tracing::warn!(provider = "codex", soul_id = %view.soul_id,
                        "fresh_agent.hosted_retained_diagnostic_timeout");
                    None
                }
            }
        } else {
            None
        };
        // A reply cannot cross a native identity, owner incarnation or source change.
        let current = self
            .client
            .inventory()
            .await
            .map_err(|_| ManagedUnavailable)?;
        let latest = current
            .iter()
            .rev()
            .find(|row| row.soul_id == view.soul_id)
            .ok_or(ManagedUnavailable)?;
        if !same_snapshot_source(view, latest)
            || snapshot["sessionType"].as_str() != Some(request.session_type.as_str())
            || snapshot["provider"].as_str() != Some(request.provider.as_str())
        {
            return Err(ManagedUnavailable);
        }
        if let Some(native) = view.native_session_id.as_deref() {
            if snapshot["threadId"].as_str() != Some(native) {
                return Err(ManagedUnavailable);
            }
        } else {
            // The actor has proven its exact local registration. Expose the existing
            // gateway alias only while OpenCode still has an empty, live zero-turn session.
            if history_only
                || runtime_provider != FreshProvider::Opencode
                || snapshot["turns"]
                    .as_array()
                    .is_none_or(|turns| !turns.is_empty())
                || snapshot["extensions"]["opencode"]["statusFromLiveState"] != true
                || snapshot["threadId"].as_str().is_none_or(str::is_empty)
            {
                return Err(ManagedUnavailable);
            }
            let public = view
                .fresh_agent_session_id
                .as_deref()
                .ok_or(ManagedUnavailable)?;
            snapshot["threadId"] = serde_json::json!(public);
            snapshot["sessionId"] = serde_json::json!(public);
        }
        if history_only {
            // Owned native history is display-only, regardless of adapter defaults.
            snapshot["status"] = serde_json::json!("idle");
            if let Some(capabilities) = snapshot["capabilities"].as_object_mut() {
                for value in capabilities.values_mut() {
                    if value.is_boolean() {
                        *value = serde_json::json!(false);
                    }
                }
            }
            snapshot["extensions"][&request.provider]["ownerKind"] = serde_json::json!("vacant");
            snapshot["extensions"][&request.provider]["nativeHistoryAvailable"] =
                serde_json::json!(true);
            snapshot["extensions"][&request.provider]["statusFromLiveState"] =
                serde_json::json!(false);
            if runtime_provider == FreshProvider::Codex {
                if let Some(codex) = snapshot["extensions"]["codex"].as_object_mut() {
                    // Saved native history has no authority over a retained
                    // session diagnostic, including its absence.
                    codex.remove("unattributedProviderError");
                    codex.remove("unattributedProviderErrorAuthoritative");
                    codex.remove("pendingProviderError");
                    codex.remove("pendingProviderErrorAuthoritative");
                }
            }
            if let Some(retained) = retained_codex.as_ref() {
                overlay_retained_codex_diagnostic(&mut snapshot, retained, view, latest);
            }
        }
        freshell_agent_runtime::snapshot_projection::project_hosted_rest_snapshot(
            &mut snapshot,
            &request.provider,
            &request.session_type,
        );
        Ok(Some(snapshot))
    }
    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, freshell_freshagent::rest_lane::RestLaneError> {
        let (provider, session_type) =
            rest_agent_identity(&request.provider, &request.session_type)?;
        let runtime_provider = fresh_provider(&Some(provider), session_type).ok_or(())?;
        let message = freshell_protocol::FreshAgentCreate {
            collaboration_mode: request.collaboration_mode,
            pane_id: request.pane_id,
            request_id: request.request_id,
            session_type,
            cwd: request.cwd,
            effort: request.effort,
            legacy_restore_context: None,
            model: request.model,
            model_selection: request.model_selection,
            observed_epoch: request.observed_epoch,
            observed_generation: request.observed_generation,
            permission_mode: request.permission_mode,
            plugins: request.plugins,
            provider: Some(provider),
            resume_session_id: None,
            sandbox: request.sandbox,
            session_ref: request.native_session_id.map(|session_id| SessionLocator {
                provider: provider_wire(&provider),
                session_id,
            }),
            tab_id: request.tab_id,
            naming_handle: request.naming_handle,
        };
        let session_id = presentation_id_for_create(
            &runtime_provider,
            &message.request_id,
            message
                .session_ref
                .as_ref()
                .map(|value| value.session_id.as_str()),
        );
        let cleanup_token = self
            .create(message)
            .await?
            .map(|receipt| serde_json::to_string(&receipt).map_err(|_| ()))
            .transpose()?;
        Ok(RestLaneCreated {
            session_id,
            cleanup_token,
            ..Default::default()
        })
    }

    async fn abandon_create(
        &self,
        _: &RestLaneCreate,
        created: &RestLaneCreated,
    ) -> Result<(), freshell_freshagent::rest_lane::RestLaneError> {
        use freshell_freshagent::rest_lane::{RestLaneError, RestLaneErrorKind};
        let Some(token) = created.cleanup_token.as_deref() else {
            return Ok(());
        };
        let (soul, revision): (SoulId, u64) = serde_json::from_str(token).map_err(|_| {
            RestLaneError::new(
                RestLaneErrorKind::Internal,
                "INVALID_CREATE_CLEANUP_TOKEN",
                "invalid hosted create cleanup receipt",
            )
        })?;
        let stopped = self
            .client
            .stop_expected(soul.clone(), Some(revision))
            .await;
        match stopped {
            Ok((StopOutcome::VerifiedEmpty, _)) => Ok(()),
            Err(error)
                if matches!(
                    error.runtime_code(),
                    Some(RuntimeErrorCode::StaleIntentRevision | RuntimeErrorCode::UnknownSoul)
                ) =>
            {
                Ok(())
            }
            result => {
                tracing::warn!(event = "fresh_agent.abandoned_create_cleanup_failed", soul_id = %soul, expected_intent_revision = revision, result = ?result);
                let mut error = RestLaneError::new(
                    RestLaneErrorKind::Unavailable,
                    "CREATE_CLEANUP_UNCONFIRMED",
                    "the abandoned hosted runtime could not be confirmed stopped",
                );
                error.retryable = Some(true);
                error.retry_after_ms = Some(250);
                Err(error)
            }
        }
    }

    async fn send_agent(
        &self,
        mut request: RestLaneSend,
    ) -> Result<RestLaneSendResult, freshell_freshagent::rest_lane::RestLaneError> {
        let (provider, session_type) =
            rest_agent_identity(&request.provider, &request.session_type)?;
        let soul = self
            .resolve_soul(&provider, session_type, &request.session_id)
            .await
            .ok_or(())?;
        let before = self
            .client
            .fresh_agent_events(soul.clone(), 0, 1)
            .await
            .map_err(|_| ())?;
        let request_id = RequestId::parse(request.request_id.clone()).map_err(|_| ())?;
        let text = std::mem::take(&mut request.text);
        let dispatch = self
            .client
            .fresh_agent_send(request_id, soul.clone(), text, None, None)
            .await;
        // The supervisor uses Completed for a previously accepted request.
        // Its matching settlement can predate this HTTP request's first read.
        let replayed = matches!(&dispatch, Ok(CommandState::Completed));
        match classify_hosted_send(provider, dispatch) {
            HostedSendOutcome::Accepted => {}
            HostedSendOutcome::Refused(message) => {
                tracing::warn!(provider=?provider, session_id=%request.session_id,
                    request_id=%request.request_id, "freshagent.hosted_rest.send_refused");
                return Err(hosted_rest_send_error(&request, message, false));
            }
            HostedSendOutcome::Ambiguous(message) => {
                tracing::warn!(provider=?provider, session_id=%request.session_id,
                    request_id=%request.request_id, "freshagent.hosted_rest.send_ambiguous");
                return Err(hosted_rest_send_error(&request, message, true));
            }
        }
        let completion = wait_for_completion(
            &self.client,
            soul,
            if replayed { 0 } else { before.head },
            &request.request_id,
            Duration::from_millis(request.timeout_ms),
        )
        .await;
        if let Some(status @ (HostedTurnStatus::Refused | HostedTurnStatus::Ambiguous)) =
            completion.status
        {
            let diagnostic = completion
                .error
                .unwrap_or_else(|| "The provider did not accept this message.".to_string());
            return Err(hosted_rest_send_error(
                &request,
                diagnostic,
                status == HostedTurnStatus::Ambiguous,
            ));
        }
        if let Some(
            status @ (HostedTurnStatus::Failed
            | HostedTurnStatus::Interrupted
            | HostedTurnStatus::Exited),
        ) = completion.status
        {
            let (code, message) = match status {
                HostedTurnStatus::Failed => (
                    if provider == AgentProvider::Codex {
                        "CODEX_TURN_FAILED"
                    } else {
                        "FRESH_AGENT_TURN_FAILED"
                    },
                    completion
                        .error
                        .unwrap_or_else(|| "the submitted turn failed".to_string()),
                ),
                HostedTurnStatus::Interrupted => (
                    if provider == AgentProvider::Codex {
                        "CODEX_TURN_INTERRUPTED"
                    } else {
                        "FRESH_AGENT_TURN_INTERRUPTED"
                    },
                    "the submitted turn was interrupted".to_string(),
                ),
                HostedTurnStatus::Exited => (
                    "FRESH_AGENT_SESSION_ENDED",
                    completion.error.unwrap_or_else(|| {
                        "the hosted session ended before the submitted turn completed".to_string()
                    }),
                ),
                HostedTurnStatus::Completed
                | HostedTurnStatus::Refused
                | HostedTurnStatus::Ambiguous => unreachable!(),
            };
            let mut error = RestLaneError::new(RestLaneErrorKind::Conflict, code, message);
            error.retryable = Some(false);
            tracing::warn!(provider=?provider, session_id=%request.session_id,
                request_id=%request.request_id, native_turn_id=?completion.turn_id,
                outcome=?status, "freshagent.hosted_rest.turn_failed");
            error.correlation = Some(Box::new(RestLaneErrorCorrelation {
                session_id: Some(request.session_id),
                request_id: Some(request.request_id),
                submitted_turn_id: completion.turn_id,
                ..Default::default()
            }));
            return Err(error);
        }
        let completed = completion.status == Some(HostedTurnStatus::Completed);
        tracing::info!(provider=?provider, session_id=%request.session_id,
            request_id=%request.request_id, native_turn_id=?completion.turn_id,
            completed, "freshagent.hosted_rest.send_observed");
        Ok(RestLaneSendResult {
            session_id: request.session_id,
            submitted_turn_id: completion.turn_id,
            completed,
            ..Default::default()
        })
    }

    async fn capture(
        &self,
        request: RestLaneCapture,
    ) -> Result<RestLaneCaptureResult, RestLaneCaptureError> {
        let (provider, session_type) =
            rest_agent_identity(&request.provider, &request.session_type)
                .map_err(|_| RestLaneCaptureError::Unavailable)?;
        let soul = self
            .resolve_soul(&provider, session_type, &request.session_id)
            .await
            .ok_or(RestLaneCaptureError::Unavailable)?;
        let capture = self
            .client
            .fresh_agent_capture(soul, request.max_bytes.min(256 * 1024) as u32)
            .await
            .map_err(|error| match error.runtime_code() {
                Some(RuntimeErrorCode::UnsupportedOperation) => RestLaneCaptureError::Unsupported,
                _ => RestLaneCaptureError::Unavailable,
            })?;
        Ok(RestLaneCaptureResult {
            session_id: capture.presentation_session_id,
            native_session_id: capture.native_session_id,
            text: capture.text,
            truncated: capture.truncated,
        })
    }
}

fn catalog_source_key(
    view: &freshell_runtime_protocol::RuntimeView,
    owner: Option<&freshell_ownership::OwnershipSnapshot>,
) -> String {
    serde_json::json!([
        "codex",
        view.soul_id,
        view.incarnation_id,
        view.host_boot_id,
        view.execution_generation,
        view.intent_revision,
        view.native_session_id,
        view.fresh_agent_session_id,
        view.fresh_agent_session_type,
        view.recovery_state,
        view.desired_state,
        owner.map(|o| (o.epoch, o.generation, format!("{:?}", o.state)))
    ])
    .to_string()
}

struct HostedCodexCatalogProbe {
    client: RuntimeClient,
    view: freshell_runtime_protocol::RuntimeView,
    context: freshell_freshagent::model_capabilities::CodexCatalogContext,
    ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
    owner: Option<freshell_ownership::OwnershipSnapshot>,
}

impl freshell_freshagent::model_capabilities::ModelCatalogProbe for HostedCodexCatalogProbe {
    fn probe<'a>(
        &'a self,
        cwd: Option<&'a str>,
    ) -> freshell_opencode::serve::BoxFuture<'a, freshell_freshagent::model_capabilities::CatalogOut>
    {
        Box::pin(async move {
            use freshell_freshagent::model_capabilities::{
                codex_capabilities, source_changed, CapabilityError,
            };
            let value = self.client.fresh_agent_model_catalog(self.view.soul_id.clone(),cwd.map(str::to_string)).await.map_err(|error| {
                tracing::warn!(provider="codex",session_id=?self.view.native_session_id,soul_id=%self.view.soul_id,code=?error.runtime_code(),"fresh_agent.hosted_catalog_unavailable");
                CapabilityError {code:"CAPABILITY_PROBE_FAILED".into(),message:"The conversation's Codex model catalog is unavailable".into(),retryable:true}
            })?;
            let inventory = self
                .client
                .inventory()
                .await
                .map_err(|_| source_changed())?;
            let current = inventory
                .iter()
                .rev()
                .find(|row| row.soul_id == self.view.soul_id)
                .ok_or_else(source_changed)?;
            let owner = self.ownership.as_ref().map(|registry| {
                let id = registry.resolve_canonical(
                    "codex",
                    self.context.native_reference().expect("validated context"),
                );
                registry.observe("codex", &id)
            });
            if !same_snapshot_source(&self.view, current)
                || catalog_source_key(current, owner.as_ref())
                    != catalog_source_key(&self.view, self.owner.as_ref())
            {
                return Err(source_changed());
            }
            let rows = serde_json::from_value(value).map_err(|_| CapabilityError {
                code: "CAPABILITY_PAYLOAD_INVALID".into(),
                message: "Codex host returned an invalid model catalog".into(),
                retryable: true,
            })?;
            Ok(codex_capabilities(rows))
        })
    }
}

fn overlay_retained_codex_diagnostic(
    snapshot: &mut serde_json::Value,
    retained: &serde_json::Value,
    before: &freshell_runtime_protocol::RuntimeView,
    after: &freshell_runtime_protocol::RuntimeView,
) {
    if !retained_batch_matches_source(Some(before), Some(after), Some(retained)) {
        return;
    }
    let projection_id = retained["source"]["projectionId"]
        .as_str()
        .filter(|id| !id.trim().is_empty());
    if projection_id.is_none()
        || retained["snapshot"]["extensions"]["codex"]["projection"]["id"].as_str() != projection_id
    {
        return;
    }
    merge_retained_codex_failures(snapshot, &retained["snapshot"]);
    let source = &retained["snapshot"]["extensions"]["codex"];
    let message = match source.get("unattributedProviderError") {
        None | Some(serde_json::Value::Null) => Some(None),
        Some(serde_json::Value::String(message)) if !message.trim().is_empty() => {
            Some(Some(serde_json::json!(message)))
        }
        _ => None,
    };
    let pending = match source.get("pendingProviderError") {
        None | Some(serde_json::Value::Null) => Some(None),
        Some(value) => match (value["turnId"].as_str(), value["message"].as_str()) {
            (Some(turn_id), Some(message))
                if !turn_id.trim().is_empty() && !message.trim().is_empty() =>
            {
                Some(Some(
                    serde_json::json!({"turnId":turn_id,"message":message}),
                ))
            }
            _ => None,
        },
    };
    let Some(codex) = snapshot["extensions"]["codex"].as_object_mut() else {
        return;
    };
    if let Some(message) = message {
        codex.remove("unattributedProviderError");
        if let Some(message) = message {
            codex.insert("unattributedProviderError".into(), message);
        }
        codex.insert("unattributedProviderErrorAuthoritative".into(), true.into());
    }
    if let Some(pending) = pending {
        codex.remove("pendingProviderError");
        if let Some(pending) = pending {
            codex.insert("pendingProviderError".into(), pending);
        }
        codex.insert("pendingProviderErrorAuthoritative".into(), true.into());
    }
}

// A provider can exit before native history records a failed turn. Preserve
// the saved history and add only settled, event-owned error rows from the
// validated retained projection; retained prompts and partial output are not
// authoritative saved history.
fn merge_retained_codex_failures(snapshot: &mut serde_json::Value, retained: &serde_json::Value) {
    use serde_json::Value;

    let projection = &retained["extensions"]["codex"]["projection"];
    let (Some(event_owned), Some(settled), Some(turn_rows), Some(retained_turns), Some(saved)) = (
        projection["eventOwnedTurnIds"].as_array(),
        projection["settledTurnIds"].as_array(),
        projection["turnRows"].as_object(),
        retained["turns"].as_array(),
        snapshot["turns"].as_array_mut(),
    ) else {
        return;
    };
    let row_owners: HashMap<&str, &str> = turn_rows
        .iter()
        .flat_map(|(native_id, rows)| {
            rows.as_array()
                .into_iter()
                .flatten()
                .filter_map(move |row| row.as_str().map(|row_id| (row_id, native_id.as_str())))
        })
        .collect();

    for native_id in event_owned.iter().filter_map(Value::as_str) {
        if native_id.trim().is_empty() || !settled.iter().any(|id| id.as_str() == Some(native_id)) {
            continue;
        }
        let Some(row_ids) = turn_rows.get(native_id).and_then(Value::as_array) else {
            continue;
        };
        for row in retained_turns {
            let Some(row_id) = row["turnId"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let Some(message) = row["error"]["message"]
                .as_str()
                .filter(|message| !message.trim().is_empty())
            else {
                continue;
            };
            if row["id"].as_str() != Some(row_id)
                || row["role"] != "assistant"
                || row["error"]["name"] != "CodexError"
                || row["items"]
                    .as_array()
                    .is_none_or(|items| !items.is_empty())
                || row["nativeTurnId"]
                    .as_str()
                    .is_some_and(|id| id != native_id)
                || !codex_row_belongs_to_turn(row, native_id)
                || !row_ids.iter().any(|id| id.as_str() == Some(row_id))
            {
                continue;
            }

            // A completed native snapshot may have synthesized an empty
            // response before the retained failure was received. It is not
            // provider output and would otherwise contradict the failure.
            saved.retain(|saved_row| !is_codex_empty_response(saved_row, native_id));
            if saved.iter().any(|saved_row| {
                codex_row_belongs_to_turn(saved_row, native_id)
                    && saved_row["role"] == "assistant"
                    && saved_row["error"]["name"] == "CodexError"
                    && saved_row["error"]["message"].as_str() == Some(message)
            }) {
                continue;
            }

            let occupied = |id: &str| {
                saved.iter().any(|turn| {
                    turn["id"].as_str() == Some(id) || turn["turnId"].as_str() == Some(id)
                })
            };
            let display_id = if !occupied(row_id) {
                row_id.to_owned()
            } else {
                (0usize..)
                    .map(|index| format!("{native_id}:row-{index}"))
                    .find(|candidate| !occupied(candidate))
                    .expect("a free display ID exists")
            };
            let last_matching = saved
                .iter()
                .rposition(|turn| codex_row_belongs_to_turn(turn, native_id));
            // When none of this turn was saved, its next retained native
            // turn can still anchor it ahead of later saved history. Match by
            // native turn rather than display-row ID: the saved and retained
            // representations can have different numbers of rows.
            let insert_at = last_matching.map(|index| index + 1).or_else(|| {
                let last_retained = retained_turns.iter().rposition(|turn| {
                    turn["turnId"]
                        .as_str()
                        .and_then(|id| row_owners.get(id))
                        .copied()
                        == Some(native_id)
                })?;
                retained_turns
                    .iter()
                    .skip(last_retained + 1)
                    .find_map(|turn| {
                        let next_native = turn["turnId"]
                            .as_str()
                            .and_then(|id| row_owners.get(id))
                            .copied()?;
                        if next_native == native_id {
                            return None;
                        }
                        saved
                            .iter()
                            .position(|row| codex_row_belongs_to_turn(row, next_native))
                    })
            });
            let ordinal = last_matching
                .and_then(|index| saved[index]["ordinal"].as_u64())
                .or_else(|| row["ordinal"].as_u64())
                .or_else(|| {
                    saved
                        .iter()
                        .filter_map(|turn| turn["ordinal"].as_u64())
                        .max()
                        .map(|ordinal| ordinal.saturating_add(1))
                })
                .unwrap_or(0);
            let failure = serde_json::json!({
                "id": display_id,
                "turnId": display_id,
                "ordinal": ordinal,
                "source": "live",
                "role": "assistant",
                "summary": "",
                "items": [],
                "error": {"name":"CodexError", "message":message},
                "outputState": {"provenance":"retained", "diagnostic":"unsaved", "refreshPending":false},
            });
            saved.insert(insert_at.unwrap_or(saved.len()), failure);
        }
    }
}

fn codex_row_belongs_to_turn(row: &serde_json::Value, native_id: &str) -> bool {
    if row["nativeTurnId"].as_str() == Some(native_id) {
        return true;
    }
    let Some(id) = row["turnId"].as_str() else {
        return false;
    };
    id == native_id
        || id
            .strip_prefix(native_id)
            .and_then(|suffix| suffix.strip_prefix(":row-"))
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|digit| digit.is_ascii_digit())
            })
}

fn is_codex_empty_response(row: &serde_json::Value, native_id: &str) -> bool {
    if !codex_row_belongs_to_turn(row, native_id)
        || row["role"] != "assistant"
        || !row["error"].is_null()
    {
        return false;
    }
    let Some([item]) = row["items"].as_array().map(Vec::as_slice) else {
        return false;
    };
    let item_id = format!("{native_id}:empty-response");
    item["id"].as_str() == Some(item_id.as_str())
        && item["kind"] == "text"
        && item["text"].as_str() == Some(freshell_freshagent::codex::CODEX_EMPTY_RESPONSE_TEXT)
}

pub(super) fn same_snapshot_source(
    before: &freshell_runtime_protocol::RuntimeView,
    after: &freshell_runtime_protocol::RuntimeView,
) -> bool {
    before.incarnation_id == after.incarnation_id
        && before.native_session_id == after.native_session_id
        && before.provider == after.provider
        && before.intent_revision == after.intent_revision
        && before.host_boot_id == after.host_boot_id
        && before.execution_generation == after.execution_generation
        && before.fresh_agent_session_id == after.fresh_agent_session_id
        && before.fresh_agent_session_type == after.fresh_agent_session_type
        && before.recovery_state == after.recovery_state
        && before.desired_state == after.desired_state
}

fn hosted_rest_send_error(
    request: &RestLaneSend,
    diagnostic: String,
    ambiguous: bool,
) -> RestLaneError {
    // Only the typed, already-public provider diagnostic reaches this helper.
    // Opaque host or transport errors were replaced by classify_hosted_send.
    let (code, message) = diagnostic
        .split_once(": ")
        .filter(|(code, _)| {
            !code.is_empty()
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or(("FRESH_AGENT_SEND_REFUSED", diagnostic.as_str()));
    let kind = match code {
        _ if ambiguous => RestLaneErrorKind::Conflict,
        "SESSION_RESERVED" | "STALE_CLAIM" | "CODEX_PREVIOUS_DELIVERY_AMBIGUOUS" => {
            RestLaneErrorKind::Conflict
        }
        "SESSION_NOT_FOUND" => RestLaneErrorKind::NotFound,
        code if code.starts_with("INVALID_") => RestLaneErrorKind::BadRequest,
        _ => RestLaneErrorKind::Unavailable,
    };
    let mut error = RestLaneError::new(kind, code, message);
    if ambiguous || code == "CODEX_PREVIOUS_DELIVERY_AMBIGUOUS" {
        error.retryable = Some(false);
    }
    error.correlation = Some(Box::new(RestLaneErrorCorrelation {
        session_id: Some(request.session_id.clone()),
        request_id: Some(request.request_id.clone()),
        ..Default::default()
    }));
    error
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostedTurnStatus {
    Completed,
    Failed,
    Interrupted,
    Exited,
    Refused,
    Ambiguous,
}

#[derive(Default)]
struct ObservedHostedTurn {
    status: Option<HostedTurnStatus>,
    error: Option<String>,
}

#[derive(Default)]
struct HostedTurnObservation {
    accepted_turn: Option<String>,
    turns: HashMap<String, ObservedHostedTurn>,
    request_settlement: Option<ObservedHostedTurn>,
    refusal: Option<String>,
    uncertainty: Option<String>,
}

struct HostedTurnCompletion {
    turn_id: Option<String>,
    status: Option<HostedTurnStatus>,
    error: Option<String>,
}

impl HostedTurnObservation {
    fn observe(&mut self, event: &AgentEvent, request_id: &str) {
        let AgentEvent::Provider { payload } = event else {
            return;
        };
        if payload["type"] == "error" && payload["requestId"] == request_id {
            if let Some(message) = payload["message"]
                .as_str()
                .filter(|message| !message.is_empty())
            {
                if message.starts_with("CODEX_DELIVERY_AMBIGUOUS:")
                    || message.starts_with("FRESH_AGENT_DELIVERY_AMBIGUOUS:")
                {
                    self.uncertainty = Some(message.to_string());
                    self.refusal = None;
                } else {
                    self.refusal = Some(message.to_string());
                    self.uncertainty = None;
                }
            }
            return;
        }
        if payload["type"] == "freshAgent.send.accepted" && payload["requestId"] == request_id {
            if let Some(turn_id) = payload["submittedTurnId"]
                .as_str()
                .filter(|turn_id| !turn_id.is_empty())
            {
                self.accepted_turn = Some(turn_id.to_owned());
            }
        }
        let event = payload.get("event").unwrap_or(payload);
        if event["type"] == "freshAgent.send.uncertain" && event["requestId"] == request_id {
            let message = event["message"]
                .as_str()
                .filter(|message| !message.trim().is_empty())
                .unwrap_or("Delivery could not be confirmed.");
            self.uncertainty = Some(
                if message.starts_with("CODEX_DELIVERY_AMBIGUOUS:")
                    || message.starts_with("FRESH_AGENT_DELIVERY_AMBIGUOUS:")
                {
                    message.to_string()
                } else {
                    format!("FRESH_AGENT_DELIVERY_AMBIGUOUS: {message}")
                },
            );
            self.refusal = None;
            return;
        }
        if event["type"] == "freshAgent.turn.settled"
            && event["requestIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == request_id))
        {
            let status = match event["outcome"].as_str() {
                Some("completed") => Some(HostedTurnStatus::Completed),
                Some("failed") => Some(HostedTurnStatus::Failed),
                Some("interrupted") => Some(HostedTurnStatus::Interrupted),
                Some("exited") => Some(HostedTurnStatus::Exited),
                _ => None,
            };
            if let Some(status) = status {
                if status == HostedTurnStatus::Completed {
                    // An exact successful settlement proves the send arrived.
                    self.uncertainty = None;
                }
                self.refusal = None;
                self.request_settlement = Some(ObservedHostedTurn {
                    status: Some(status),
                    error: event["message"]
                        .as_str()
                        .filter(|message| !message.trim().is_empty())
                        .map(str::to_owned),
                });
            }
            return;
        }
        if event["type"] != "freshAgent.transcript.patch" {
            return;
        }
        for operation in event["ops"].as_array().into_iter().flatten() {
            let Some(id) = operation["nativeTurnId"]
                .as_str()
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let turn = self.turns.entry(id.to_owned()).or_default();
            match operation["op"].as_str() {
                Some("resetTurn") => {
                    let error = operation["turns"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find_map(|row| {
                            row["error"]["message"]
                                .as_str()
                                .filter(|message| !message.trim().is_empty())
                                .map(str::to_owned)
                        });
                    if let Some(error) = error {
                        turn.error = Some(error);
                        if operation["correctSettled"] == true {
                            turn.status = Some(HostedTurnStatus::Failed);
                        }
                    }
                }
                Some("settleTurn") => match operation["status"].as_str() {
                    Some("failed") => turn.status = Some(HostedTurnStatus::Failed),
                    Some("interrupted") if turn.status != Some(HostedTurnStatus::Failed) => {
                        turn.status = Some(HostedTurnStatus::Interrupted);
                    }
                    Some("completed") if turn.status.is_none() => {
                        turn.status = Some(HostedTurnStatus::Completed);
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }

    fn is_settled(&self) -> bool {
        self.uncertainty.is_some()
            || self.refusal.is_some()
            || self.request_settlement.is_some()
            || self
                .accepted_turn
                .as_ref()
                .and_then(|turn_id| self.turns.get(turn_id))
                .is_some_and(|turn| turn.status.is_some())
    }

    fn finish(mut self) -> HostedTurnCompletion {
        let turn = self
            .accepted_turn
            .as_ref()
            .and_then(|turn_id| self.turns.remove(turn_id))
            .unwrap_or_default();
        let (status, error) = if let Some(message) = self.uncertainty {
            (Some(HostedTurnStatus::Ambiguous), Some(message))
        } else if let Some(settlement) = self.request_settlement {
            (settlement.status, settlement.error)
        } else if turn.status.is_some() {
            (turn.status, turn.error)
        } else if let Some(message) = self.refusal {
            (Some(HostedTurnStatus::Refused), Some(message))
        } else {
            (None, None)
        };
        HostedTurnCompletion {
            turn_id: self.accepted_turn,
            status,
            error,
        }
    }
}

async fn wait_for_completion(
    client: &RuntimeClient,
    soul: SoulId,
    mut cursor: u64,
    request_id: &str,
    budget: Duration,
) -> HostedTurnCompletion {
    let deadline = tokio::time::Instant::now() + budget;
    let mut observed = HostedTurnObservation::default();
    loop {
        let Ok(batch) = client.fresh_agent_events(soul.clone(), cursor, 128).await else {
            return observed.finish();
        };
        for entry in batch.events {
            cursor = cursor.max(entry.sequence);
            observed.observe(&entry.event, request_id);
        }
        if observed.is_settled() {
            return observed.finish();
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return observed.finish();
        }
        tokio::time::sleep((deadline - now).min(Duration::from_millis(50))).await;
    }
}

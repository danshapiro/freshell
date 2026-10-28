//! REST/MCP ingress backed exclusively by the durable fresh-agent host.

use super::*;

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
            collaboration_mode: None,
            pane_id: request.pane_id,
            request_id: request.request_id,
            session_type,
            cwd: request.cwd,
            effort: request.effort.map(Some),
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
        request: RestLaneSend,
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
        let request_id = RequestId::parse(request.request_id).map_err(|_| ())?;
        self.client
            .fresh_agent_send(request_id, soul.clone(), request.text, None, None)
            .await
            .map_err(|_| ())?;
        let completed = wait_for_completion(
            &self.client,
            soul,
            before.head,
            Duration::from_millis(request.timeout_ms),
        )
        .await;
        Ok(RestLaneSendResult {
            session_id: request.session_id,
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

fn same_snapshot_source(
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

async fn wait_for_completion(
    client: &RuntimeClient,
    soul: SoulId,
    mut cursor: u64,
    budget: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let Ok(batch) = client.fresh_agent_events(soul.clone(), cursor, 128).await else {
            return false;
        };
        for entry in batch.events {
            cursor = cursor.max(entry.sequence);
            if provider_event_completes_turn(&entry.event) {
                return true;
            }
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::time::sleep((deadline - now).min(Duration::from_millis(50))).await;
    }
}

pub(super) fn provider_event_completes_turn(event: &AgentEvent) -> bool {
    let AgentEvent::Provider { payload } = event else {
        return false;
    };
    let event = payload.get("event").unwrap_or(payload);
    let event_type = event
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    event_type == "freshAgent.turn.complete"
        || (event_type == "freshAgent.status"
            && event.get("status").and_then(serde_json::Value::as_str) == Some("idle"))
}

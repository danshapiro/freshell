//! REST/MCP ingress backed exclusively by the durable fresh-agent host.

use super::*;

#[async_trait::async_trait]
impl HostedFreshAgentRestGateway for HostedFreshAgentProxy {
    async fn create_agent(
        self: Arc<Self>,
        request: HostedRestCreate,
    ) -> Result<HostedRestCreated, ()> {
        let (provider, session_type) =
            rest_agent_identity(&request.provider, &request.session_type)?;
        let runtime_provider = fresh_provider(&Some(provider.clone()), session_type).ok_or(())?;
        let preferred_tab_id = request.preferred_tab_id;
        let preferred_pane_id = request.preferred_pane_id;
        let message = freshell_protocol::FreshAgentCreate {
            request_id: request.request_id,
            session_type,
            cwd: request.cwd,
            effort: request.effort,
            legacy_restore_context: None,
            model: request.model,
            model_selection: None,
            permission_mode: None,
            plugins: None,
            provider: Some(provider.clone()),
            resume_session_id: None,
            sandbox: None,
            session_ref: request.native_session_id.map(|session_id| SessionLocator {
                provider: provider_wire(&provider),
                session_id,
            }),
            tab_id: Some(preferred_tab_id.clone()),
        };
        let session_id = message
            .session_ref
            .as_ref()
            .map(|value| value.session_id.clone())
            .unwrap_or_else(|| managed_public_session_id(&runtime_provider, &message.request_id));
        self.create_with_view(message, Some(preferred_tab_id), Some(preferred_pane_id))
            .await?;
        Ok(HostedRestCreated { session_id })
    }

    async fn resolve_pane(&self, pane_id: &str) -> Result<Option<HostedRestPane>, ()> {
        let snapshot = self.client.inventory_snapshot().await.map_err(|_| ())?;
        Ok(hosted_rest_pane_from_snapshot(&snapshot, pane_id))
    }

    async fn send_agent(&self, request: HostedRestSend) -> Result<HostedRestSendResult, ()> {
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
            .map_err(|error| {
                tracing::warn!(%error, %soul, "managed fresh-agent REST pre-send event read failed");
            })?;
        let request_id = RequestId::parse(request.request_id).map_err(|error| {
            tracing::warn!(%error, %soul, "managed fresh-agent REST request id was invalid");
        })?;
        self.client
            .fresh_agent_send(request_id.clone(), soul.clone(), request.text, None)
            .await
            .map_err(|error| {
                tracing::warn!(%error, %soul, %request_id, "managed fresh-agent REST send failed");
            })?;
        let completed = wait_for_completion(
            &self.client,
            soul,
            before.head,
            Duration::from_millis(request.timeout_ms),
        )
        .await;
        Ok(HostedRestSendResult {
            session_id: request.session_id,
            completed,
        })
    }

    async fn capture(
        &self,
        request: HostedRestCapture,
    ) -> Result<HostedRestCaptureResult, HostedRestCaptureError> {
        let (provider, session_type) =
            rest_agent_identity(&request.provider, &request.session_type)
                .map_err(|_| HostedRestCaptureError::Unavailable)?;
        let soul = self
            .resolve_soul(&provider, session_type, &request.session_id)
            .await
            .ok_or(HostedRestCaptureError::Unavailable)?;
        let capture = self
            .client
            .fresh_agent_capture(soul, request.max_bytes.min(256 * 1024) as u32)
            .await
            .map_err(|error| match error.runtime_code() {
                Some(RuntimeErrorCode::UnsupportedOperation) => HostedRestCaptureError::Unsupported,
                _ => HostedRestCaptureError::Unavailable,
            })?;
        Ok(HostedRestCaptureResult {
            session_id: capture.presentation_session_id,
            native_session_id: capture.native_session_id,
            text: capture.text,
            truncated: capture.truncated,
        })
    }
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

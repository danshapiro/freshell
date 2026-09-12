//! Client for the installation-scoped managed-runtime supervisor control socket.
//!
//! The web server uses this crate as a capability client. It never receives a
//! Docker socket or a process handle. All destructive authority stays behind the
//! supervisor's registry-backed `OwnedRuntimeHandle` boundary.

use freshell_runtime_protocol::{
    read_frame, write_frame, AcknowledgeViewProjectionRequest, AdminCommand, AdminReply,
    AdminResult, ControlRole, Envelope, FreshAgentCapture, FreshAgentCaptureRequest,
    FreshAgentCompactRequest, FreshAgentForkRequest, FreshAgentInterruptRequest,
    FreshAgentReadEventsRequest, FreshAgentResolveRequest, FreshAgentRollbackDirection,
    FreshAgentRollbackMode, FreshAgentRollbackRequest, FreshAgentSendRequest, IncidentId,
    IncidentSummaryRequest, LaunchRequest, LossIncidentSummary, ManagedRolloutMode, MigrationPlan,
    MigrationPlanRequest, NoticeDeliveryState, NoticeId, NoticeReceiptRequest,
    PendingNoticesRequest, PendingViewProjectionsRequest, RecoverRequest, RecoveryProbeRequest,
    RecoveryTrigger, RepairAudit, RepairRequest, RequestId, RuntimeError, RuntimeErrorCode,
    RuntimeInventorySnapshot, RuntimeMetricsRequest, RuntimeMetricsSnapshot, RuntimeNotice,
    RuntimeView, SoulId, StopOutcome, StopRequest, TerminalInputRequest, TerminalReadOutputRequest,
    TerminalResizeRequest, UpdateLimitsRequest, UpdateLimitsResult, UpdateViewVisibilityRequest,
    UpsertViewIntentRequest, ViewIntent, ViewProjectionEvent, CONTROL_PROTOCOL_VERSION,
};
use std::{path::PathBuf, sync::Arc};
use tokio::{net::UnixStream, sync::RwLock};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("runtime supervisor I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("runtime supervisor protocol failed: {0}")]
    Protocol(String),
    #[error("runtime supervisor rejected request: {0:?}: {1}")]
    Runtime(RuntimeErrorCode, String),
    #[error("runtime supervisor returned an unexpected result")]
    UnexpectedResult,
}

impl ClientError {
    pub fn runtime_code(&self) -> Option<RuntimeErrorCode> {
        match self {
            Self::Runtime(code, _) => Some(*code),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct RuntimeClient {
    socket_path: Arc<PathBuf>,
    control_secret: Arc<String>,
    control_epoch: Arc<RwLock<Option<u64>>>,
}

impl RuntimeClient {
    pub async fn from_secret_file(
        socket_path: impl Into<PathBuf>,
        secret_file: impl Into<PathBuf>,
    ) -> Result<Self, ClientError> {
        let secret = tokio::fs::read_to_string(secret_file.into()).await?;
        let secret = secret.trim().to_string();
        if secret.len() < 16 {
            return Err(ClientError::Protocol(
                "runtime control secret is too short".into(),
            ));
        }
        Ok(Self::new(socket_path, secret))
    }

    pub fn new(socket_path: impl Into<PathBuf>, control_secret: impl Into<String>) -> Self {
        Self {
            socket_path: Arc::new(socket_path.into()),
            control_secret: Arc::new(control_secret.into()),
            control_epoch: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn health(&self) -> Result<(u64, String), ClientError> {
        match self.request(RequestId::new(), AdminCommand::Health).await? {
            AdminResult::Health {
                control_epoch,
                installation_id,
            } => {
                *self.control_epoch.write().await = Some(control_epoch);
                Ok((control_epoch, installation_id.to_string()))
            }
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn current_epoch(&self) -> Result<u64, ClientError> {
        if let Some(epoch) = *self.control_epoch.read().await {
            return Ok(epoch);
        }
        self.health().await.map(|(epoch, _)| epoch)
    }

    pub async fn inventory(
        &self,
    ) -> Result<Vec<freshell_runtime_protocol::RuntimeView>, ClientError> {
        match self
            .request(RequestId::new(), AdminCommand::Inventory)
            .await?
        {
            AdminResult::Inventory(views) => Ok(views),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn inventory_snapshot(&self) -> Result<RuntimeInventorySnapshot, ClientError> {
        match self
            .request(RequestId::new(), AdminCommand::InventorySnapshot)
            .await?
        {
            AdminResult::InventorySnapshot(snapshot) => Ok(snapshot),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn pending_view_projections(
        &self,
        limit: u32,
    ) -> Result<Vec<ViewProjectionEvent>, ClientError> {
        let epoch = self.current_epoch().await?;
        let mut request = PendingViewProjectionsRequest {
            limit,
            expected_control_epoch: Some(epoch),
        };
        match self
            .request(
                RequestId::new(),
                AdminCommand::PendingViewProjections(request.clone()),
            )
            .await
        {
            Ok(AdminResult::PendingViewProjections(events)) => Ok(events),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(
                        RequestId::new(),
                        AdminCommand::PendingViewProjections(request),
                    )
                    .await?
                {
                    AdminResult::PendingViewProjections(events) => Ok(events),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn acknowledge_view_projection(
        &self,
        event_id: freshell_runtime_protocol::ProjectionEventId,
    ) -> Result<(), ClientError> {
        let epoch = self.current_epoch().await?;
        let mut request = AcknowledgeViewProjectionRequest {
            event_id,
            expected_control_epoch: Some(epoch),
        };
        match self
            .request(
                RequestId::new(),
                AdminCommand::AcknowledgeViewProjection(request.clone()),
            )
            .await
        {
            Ok(AdminResult::ViewProjectionAcknowledged) => Ok(()),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(
                        RequestId::new(),
                        AdminCommand::AcknowledgeViewProjection(request),
                    )
                    .await?
                {
                    AdminResult::ViewProjectionAcknowledged => Ok(()),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn update_view_visibility(
        &self,
        request: UpdateViewVisibilityRequest,
    ) -> Result<ViewIntent, ClientError> {
        self.update_view_visibility_with_request_id(RequestId::new(), request)
            .await
    }

    pub async fn update_view_visibility_with_request_id(
        &self,
        request_id: RequestId,
        mut request: UpdateViewVisibilityRequest,
    ) -> Result<ViewIntent, ClientError> {
        request.expected_control_epoch = Some(self.current_epoch().await?);
        let original = request.clone();
        match self
            .request(
                request_id.clone(),
                AdminCommand::UpdateViewVisibility(request),
            )
            .await
        {
            Ok(AdminResult::ViewIntent(intent)) => Ok(intent),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                let mut retry = original;
                retry.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::UpdateViewVisibility(retry))
                    .await?
                {
                    AdminResult::ViewIntent(intent) => Ok(intent),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn upsert_view_intent(
        &self,
        request: UpsertViewIntentRequest,
    ) -> Result<ViewIntent, ClientError> {
        self.upsert_view_intent_with_request_id(RequestId::new(), request)
            .await
    }

    pub async fn upsert_view_intent_with_request_id(
        &self,
        request_id: RequestId,
        mut request: UpsertViewIntentRequest,
    ) -> Result<ViewIntent, ClientError> {
        request.expected_control_epoch = Some(self.current_epoch().await?);
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::UpsertViewIntent(request))
            .await
        {
            Ok(AdminResult::ViewIntent(intent)) => Ok(intent),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                let mut retry = original;
                retry.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::UpsertViewIntent(retry))
                    .await?
                {
                    AdminResult::ViewIntent(intent) => Ok(intent),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn update_limits(
        &self,
        soul_id: SoulId,
        limits: freshell_runtime_protocol::RuntimeLimits,
        expected_intent_revision: u64,
    ) -> Result<UpdateLimitsResult, ClientError> {
        self.update_limits_with_request_id(
            RequestId::new(),
            soul_id,
            limits,
            expected_intent_revision,
        )
        .await
    }

    pub async fn update_limits_with_request_id(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        limits: freshell_runtime_protocol::RuntimeLimits,
        expected_intent_revision: u64,
    ) -> Result<UpdateLimitsResult, ClientError> {
        let mut request = UpdateLimitsRequest {
            soul_id,
            limits,
            expected_intent_revision,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::UpdateLimits(request))
            .await
        {
            Ok(AdminResult::UpdateLimits(result)) => Ok(result),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::UpdateLimits(request))
                    .await?
                {
                    AdminResult::UpdateLimits(result) => Ok(result),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn pending_notices(
        &self,
        profile_id: String,
        limit: u32,
    ) -> Result<Vec<RuntimeNotice>, ClientError> {
        let mut request = PendingNoticesRequest {
            profile_id,
            limit,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(RequestId::new(), AdminCommand::PendingNotices(request))
            .await
        {
            Ok(AdminResult::PendingNotices(notices)) => Ok(notices),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(RequestId::new(), AdminCommand::PendingNotices(request))
                    .await?
                {
                    AdminResult::PendingNotices(notices) => Ok(notices),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn record_notice_receipt(
        &self,
        notice_id: NoticeId,
        profile_id: String,
        state: NoticeDeliveryState,
    ) -> Result<(), ClientError> {
        self.record_notice_receipt_with_request_id(RequestId::new(), notice_id, profile_id, state)
            .await
    }

    pub async fn record_notice_receipt_with_request_id(
        &self,
        request_id: RequestId,
        notice_id: NoticeId,
        profile_id: String,
        state: NoticeDeliveryState,
    ) -> Result<(), ClientError> {
        let mut request = NoticeReceiptRequest {
            notice_id,
            profile_id,
            state,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::NoticeReceipt(request))
            .await
        {
            Ok(AdminResult::NoticeReceiptRecorded) => Ok(()),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::NoticeReceipt(request))
                    .await?
                {
                    AdminResult::NoticeReceiptRecorded => Ok(()),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn incident_summary(
        &self,
        incident_id: IncidentId,
    ) -> Result<LossIncidentSummary, ClientError> {
        let mut request = IncidentSummaryRequest {
            incident_id,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(RequestId::new(), AdminCommand::IncidentSummary(request))
            .await
        {
            Ok(AdminResult::IncidentSummary(summary)) => Ok(summary),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(RequestId::new(), AdminCommand::IncidentSummary(request))
                    .await?
                {
                    AdminResult::IncidentSummary(summary) => Ok(summary),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn runtime_metrics_snapshot(&self) -> Result<RuntimeMetricsSnapshot, ClientError> {
        match self
            .request(RequestId::new(), AdminCommand::MetricsSnapshot)
            .await?
        {
            AdminResult::MetricsSnapshot(snapshot) => Ok(snapshot),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn migration_plan(
        &self,
        request: MigrationPlanRequest,
    ) -> Result<MigrationPlan, ClientError> {
        self.migration_plan_with_request_id(RequestId::new(), request)
            .await
    }

    pub async fn migration_plan_with_request_id(
        &self,
        request_id: RequestId,
        mut request: MigrationPlanRequest,
    ) -> Result<MigrationPlan, ClientError> {
        request.expected_control_epoch = Some(self.current_epoch().await?);
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::MigrationPlan(request))
            .await
        {
            Ok(AdminResult::MigrationPlan(plan)) => Ok(plan),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                let mut retry = original;
                retry.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::MigrationPlan(retry))
                    .await?
                {
                    AdminResult::MigrationPlan(plan) => Ok(plan),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn set_rollout_mode(
        &self,
        requested_mode: ManagedRolloutMode,
        backup_path: Option<String>,
        legacy_metadata_path: Option<String>,
    ) -> Result<MigrationPlan, ClientError> {
        self.migration_plan(MigrationPlanRequest {
            requested_mode,
            apply: true,
            backup_path,
            legacy_metadata_path,
            expected_control_epoch: None,
        })
        .await
    }

    pub async fn repair_audit(&self, apply: bool) -> Result<RepairAudit, ClientError> {
        self.repair_audit_with_request_id(RequestId::new(), apply)
            .await
    }

    pub async fn repair_audit_with_request_id(
        &self,
        request_id: RequestId,
        apply: bool,
    ) -> Result<RepairAudit, ClientError> {
        let mut request = RepairRequest {
            apply,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::RepairAudit(request))
            .await
        {
            Ok(AdminResult::RepairAudit(audit)) => Ok(audit),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::RepairAudit(request))
                    .await?
                {
                    AdminResult::RepairAudit(audit) => Ok(audit),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn launch(
        &self,
        request_id: RequestId,
        mut request: LaunchRequest,
    ) -> Result<freshell_runtime_protocol::LaunchResult, ClientError> {
        let epoch = self.current_epoch().await?;
        request.expected_control_epoch = Some(epoch);
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::Launch(Box::new(request)))
            .await
        {
            Ok(AdminResult::Launch(result)) => Ok(result),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                let (epoch, _) = self.health().await?;
                let mut retry = original;
                retry.expected_control_epoch = Some(epoch);
                match self
                    .request(request_id, AdminCommand::Launch(Box::new(retry)))
                    .await?
                {
                    AdminResult::Launch(result) => Ok(result),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn input(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        data: String,
    ) -> Result<freshell_runtime_protocol::CommandState, ClientError> {
        let epoch = self.current_epoch().await?;
        let request = TerminalInputRequest {
            soul_id,
            data,
            expected_control_epoch: Some(epoch),
        };
        match self
            .request(request_id, AdminCommand::TerminalInput(request))
            .await?
        {
            AdminResult::TerminalInput { state } => Ok(state),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn resize(&self, soul_id: SoulId, cols: u16, rows: u16) -> Result<(), ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::TerminalResize(TerminalResizeRequest {
                    soul_id,
                    cols,
                    rows,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::TerminalResize => Ok(()),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn read_output(
        &self,
        soul_id: SoulId,
        after_seq: u64,
        max_bytes: u64,
    ) -> Result<freshell_runtime_protocol::RuntimeOutputBatch, ClientError> {
        self.read_output_for_epoch(soul_id, after_seq, max_bytes, None)
            .await
    }

    pub async fn read_output_for_epoch(
        &self,
        soul_id: SoulId,
        after_seq: u64,
        max_bytes: u64,
        expected_stream_epoch: Option<String>,
    ) -> Result<freshell_runtime_protocol::RuntimeOutputBatch, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::TerminalReadOutput(TerminalReadOutputRequest {
                    soul_id,
                    after_seq,
                    max_bytes,
                    expected_stream_epoch,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::TerminalOutput(output) => Ok(output),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_send(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        text: String,
        settings: Option<freshell_runtime_protocol::FreshAgentTurnSettings>,
    ) -> Result<freshell_runtime_protocol::CommandState, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                request_id,
                AdminCommand::FreshAgentSend(FreshAgentSendRequest {
                    soul_id,
                    text,
                    settings,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentCommand { state } => Ok(state),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_fork(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        parent_session_id: String,
        input: Option<serde_json::Value>,
    ) -> Result<freshell_runtime_protocol::FreshAgentForkResult, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                request_id,
                AdminCommand::FreshAgentFork(FreshAgentForkRequest {
                    soul_id,
                    parent_session_id,
                    input,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentFork(result) => Ok(result),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_compact(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        instructions: Option<String>,
        cwd: Option<String>,
    ) -> Result<freshell_runtime_protocol::CommandState, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                request_id,
                AdminCommand::FreshAgentCompact(FreshAgentCompactRequest {
                    soul_id,
                    instructions,
                    cwd,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentCommand { state } => Ok(state),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_rollback(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        direction: FreshAgentRollbackDirection,
        mode: FreshAgentRollbackMode,
        turn_id: Option<String>,
        cwd: Option<String>,
    ) -> Result<freshell_runtime_protocol::CommandState, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                request_id,
                AdminCommand::FreshAgentRollback(FreshAgentRollbackRequest {
                    soul_id,
                    direction,
                    mode,
                    turn_id,
                    cwd,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentCommand { state } => Ok(state),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_snapshot(
        &self,
        soul_id: SoulId,
    ) -> Result<serde_json::Value, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::FreshAgentSnapshot(
                    freshell_runtime_protocol::FreshAgentSnapshotRequest {
                        soul_id,
                        expected_control_epoch: Some(epoch),
                    },
                ),
            )
            .await?
        {
            AdminResult::FreshAgentSnapshot(snapshot) => Ok(snapshot),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_capture(
        &self,
        soul_id: SoulId,
        max_bytes: u32,
    ) -> Result<FreshAgentCapture, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::FreshAgentCapture(FreshAgentCaptureRequest {
                    soul_id,
                    max_bytes,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentCapture(capture) => Ok(capture),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_resolve(
        &self,
        soul_id: SoulId,
        decision_id: String,
        decision: serde_json::Value,
    ) -> Result<freshell_runtime_protocol::CommandState, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::FreshAgentResolve(FreshAgentResolveRequest {
                    soul_id,
                    decision_id,
                    decision,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentCommand { state } => Ok(state),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_interrupt(&self, soul_id: SoulId) -> Result<(), ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::FreshAgentInterrupt(FreshAgentInterruptRequest {
                    soul_id,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentInterrupted => Ok(()),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn fresh_agent_events(
        &self,
        soul_id: SoulId,
        after_sequence: u64,
        max_events: u32,
    ) -> Result<freshell_runtime_protocol::AgentEventBatch, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::FreshAgentReadEvents(FreshAgentReadEventsRequest {
                    soul_id,
                    after_sequence,
                    max_events,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::FreshAgentEvents(events) => Ok(events),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn metrics(
        &self,
        soul_id: SoulId,
    ) -> Result<freshell_runtime_protocol::RuntimeMetrics, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::RuntimeMetrics(RuntimeMetricsRequest {
                    soul_id,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::RuntimeMetrics(metrics) => Ok(metrics),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn probe_recovery(
        &self,
        soul_id: SoulId,
    ) -> Result<freshell_runtime_protocol::RecoveryProbe, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::ProbeRecovery(RecoveryProbeRequest {
                    soul_id,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::RecoveryProbe(probe) => Ok(probe),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn recover(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
    ) -> Result<freshell_runtime_protocol::RecoveryResult, ClientError> {
        self.recover_expected(soul_id, trigger, None).await
    }

    pub async fn recover_expected(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        expected_intent_revision: Option<u64>,
    ) -> Result<freshell_runtime_protocol::RecoveryResult, ClientError> {
        self.recover_expected_with_request_id(
            RequestId::new(),
            soul_id,
            trigger,
            expected_intent_revision,
        )
        .await
    }

    pub async fn recover_expected_with_request_id(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        expected_intent_revision: Option<u64>,
    ) -> Result<freshell_runtime_protocol::RecoveryResult, ClientError> {
        let mut request = RecoverRequest {
            soul_id,
            trigger,
            expected_intent_revision,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::Recover(request))
            .await
        {
            Ok(AdminResult::Recovery(result)) => Ok(result),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::Recover(request))
                    .await?
                {
                    AdminResult::Recovery(result) => Ok(result),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn stop(&self, soul_id: SoulId) -> Result<StopOutcome, ClientError> {
        self.stop_expected(soul_id, None)
            .await
            .map(|(outcome, _)| outcome)
    }

    pub async fn stop_expected(
        &self,
        soul_id: SoulId,
        expected_intent_revision: Option<u64>,
    ) -> Result<(StopOutcome, RuntimeView), ClientError> {
        self.stop_expected_with_request_id(RequestId::new(), soul_id, expected_intent_revision)
            .await
    }

    pub async fn stop_expected_with_request_id(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        expected_intent_revision: Option<u64>,
    ) -> Result<(StopOutcome, RuntimeView), ClientError> {
        let mut request = StopRequest {
            soul_id,
            expected_intent_revision,
            expected_control_epoch: Some(self.current_epoch().await?),
        };
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::Stop(request))
            .await
        {
            Ok(AdminResult::Stop { outcome, view }) => Ok((outcome, view)),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                request = original;
                request.expected_control_epoch = Some(self.health().await?.0);
                match self
                    .request(request_id, AdminCommand::Stop(request))
                    .await?
                {
                    AdminResult::Stop { outcome, view } => Ok((outcome, view)),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn request(
        &self,
        request_id: RequestId,
        body: AdminCommand,
    ) -> Result<AdminResult, ClientError> {
        let mut stream = UnixStream::connect(self.socket_path.as_ref()).await?;
        let envelope = Envelope {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            role: ControlRole::Web,
            auth: Some(self.control_secret.as_ref().clone()),
            body,
        };
        write_frame(&mut stream, &envelope)
            .await
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        let reply: AdminReply = read_frame(&mut stream)
            .await
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        reply.result.map_err(runtime_error)
    }
}

fn runtime_error(error: RuntimeError) -> ClientError {
    ClientError::Runtime(error.code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{write_frame, AdminReply, AdminResult, InstallationId};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn health_authenticates_and_caches_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            assert_eq!(envelope.role, ControlRole::Web);
            assert_eq!(envelope.auth.as_deref(), Some("0123456789abcdef"));
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: envelope.request_id,
                    result: Ok(AdminResult::Health {
                        control_epoch: 41,
                        installation_id: InstallationId::new(),
                    }),
                },
            )
            .await
            .unwrap();
        });
        let client = RuntimeClient::new(&socket, "0123456789abcdef");
        assert_eq!(client.health().await.unwrap().0, 41);
        assert_eq!(client.current_epoch().await.unwrap(), 41);
        server.await.unwrap();
    }
}

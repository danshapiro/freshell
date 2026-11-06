#![cfg(feature = "managed-runtime-v1")]

//! Authenticated managed-runtime read/action API and durable view projector.
//!
//! The supervisor remains authoritative. This module keeps one retry-safe web
//! projection so browser reconstruction never depends on a live tab existing:
//! write the projection cache and pane identity ledger, broadcast a revisioned
//! notification, then acknowledge the supervisor outbox event. A web crash at
//! any point replays the same deterministic event without duplicating a view.

use crate::boot::{is_authed, unauthorized};
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use freshell_protocol::InventoryTerminal;
use freshell_runtime_client::{ClientError, RuntimeClient};
use freshell_runtime_protocol::{
    DesiredState, IncidentId, LostSoulRepairTarget, ManagedRolloutMode, MigrationPlanRequest,
    NoticeDeliveryState, NoticeId, RecoveryTrigger, RequestId, RuntimeInventorySnapshot,
    RuntimeLimits, RuntimeView, SoulId, UpdateViewVisibilityRequest, UpsertViewIntentRequest,
    ViewIntent, ViewIntentId, ViewIntentRequest, ViewProjectionEvent, ViewVisibilityIntent,
};
use freshell_ws::pane_ledger::{BindingWrite, PaneLedger, ProvenancePolicy};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

use freshell_freshagent::{
    host_agent_admission::{AdmissionError, AdmissionLease, HostAgentAdmissionGate},
    layout_store::{LayoutStore, PaneSnapshot},
};
use freshell_ownership::{
    OwnershipState, ReplayOwnerState, RuntimeOwnerKind, RuntimeOwnershipRegistry,
};
use freshell_terminal::TerminalRegistry;

const PROJECTION_SCHEMA_VERSION: u32 = 1;
const PROJECTOR_BATCH: u32 = 100;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProjectionDocument {
    schema_version: u32,
    inventory_revision: u64,
    views: BTreeMap<String, ViewIntent>,
}

#[derive(Clone)]
struct ManagedViewProjectionStore {
    path: Option<Arc<PathBuf>>,
    document: Arc<Mutex<ProjectionDocument>>,
}

impl ManagedViewProjectionStore {
    fn open(path: Option<PathBuf>) -> Result<Self, String> {
        let document = match path.as_ref() {
            Some(path) if path.is_file() => match std::fs::read(path) {
                Ok(bytes) => match serde_json::from_slice::<ProjectionDocument>(&bytes) {
                    Ok(document) if document.schema_version == PROJECTION_SCHEMA_VERSION => {
                        document
                    }
                    Ok(document) => {
                        tracing::warn!(
                            path = %path.display(),
                            schema_version = document.schema_version,
                            "managed_runtime.projection_cache_schema_rebuild"
                        );
                        ProjectionDocument::default()
                    }
                    Err(error) => {
                        tracing::warn!(
                            path = %path.display(),
                            error = %error,
                            "managed_runtime.projection_cache_rebuild"
                        );
                        ProjectionDocument::default()
                    }
                },
                Err(error) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %error,
                        "managed_runtime.projection_cache_read_failed"
                    );
                    ProjectionDocument::default()
                }
            },
            _ => ProjectionDocument::default(),
        };
        Ok(Self {
            path: path.map(Arc::new),
            document: Arc::new(Mutex::new(document)),
        })
    }

    async fn reconcile_snapshot(
        &self,
        snapshot: &RuntimeInventorySnapshot,
    ) -> Result<bool, String> {
        let views = snapshot
            .view_intents
            .iter()
            .cloned()
            .map(|intent| (intent.view_id.to_string(), intent))
            .collect::<BTreeMap<_, _>>();
        let next = ProjectionDocument {
            schema_version: PROJECTION_SCHEMA_VERSION,
            inventory_revision: snapshot.revision,
            views,
        };
        let mut current = self.document.lock().await;
        if *current == next {
            return Ok(false);
        }
        self.persist(next.clone()).await?;
        *current = next;
        Ok(true)
    }

    async fn apply_event(&self, event: &ViewProjectionEvent) -> Result<bool, String> {
        let mut current = self.document.lock().await;
        if current
            .views
            .get(event.view_intent.view_id.as_str())
            .is_some_and(|existing| existing.revision >= event.view_intent.revision)
            && current.inventory_revision >= event.inventory_revision
        {
            return Ok(false);
        }
        let mut next = current.clone();
        next.schema_version = PROJECTION_SCHEMA_VERSION;
        next.inventory_revision = next.inventory_revision.max(event.inventory_revision);
        next.views.insert(
            event.view_intent.view_id.to_string(),
            event.view_intent.clone(),
        );
        self.persist(next.clone()).await?;
        *current = next;
        Ok(true)
    }

    async fn persist(&self, document: ProjectionDocument) -> Result<(), String> {
        let Some(path) = self.path.as_ref().map(|path| path.as_ref().clone()) else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || atomic_write_json(&path, &document))
            .await
            .map_err(|error| format!("projection cache writer panicked: {error}"))?
    }

    #[cfg(test)]
    async fn snapshot(&self) -> ProjectionDocument {
        self.document.lock().await.clone()
    }
}

#[derive(Clone)]
pub struct ManagedRuntimeApiState {
    pub auth_token: Arc<String>,
    pub client: Option<RuntimeClient>,
    terminal_controller: Option<Arc<crate::managed_runtime::ServerManagedRuntimeController>>,
    projection_store: ManagedViewProjectionStore,
    pane_ledger: Arc<PaneLedger>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    readiness_layout_store: Option<LayoutStore>,
    readiness_terminals: Option<TerminalRegistry>,
    readiness_ownership: Option<Arc<RuntimeOwnershipRegistry>>,
    host_agent_admission: Option<HostAgentAdmissionGate>,
}

impl ManagedRuntimeApiState {
    pub async fn new(
        auth_token: Arc<String>,
        client: Option<RuntimeClient>,
        projection_path: Option<PathBuf>,
        pane_ledger: Arc<PaneLedger>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ) -> Result<Self, String> {
        let state = Self {
            auth_token,
            client,
            terminal_controller: None,
            projection_store: ManagedViewProjectionStore::open(projection_path)?,
            pane_ledger,
            broadcast_tx,
            readiness_layout_store: None,
            readiness_terminals: None,
            readiness_ownership: None,
            host_agent_admission: None,
        };
        if let Some(client) = state.client.as_ref() {
            let snapshot = client
                .inventory_snapshot()
                .await
                .map_err(|error| format!("managed runtime initial inventory: {error}"))?;
            state.projection_store.reconcile_snapshot(&snapshot).await?;
            state.project_all_bindings(&snapshot).await;
        }
        Ok(state)
    }

    pub fn with_terminal_controller(
        mut self,
        controller: Option<Arc<crate::managed_runtime::ServerManagedRuntimeController>>,
    ) -> Self {
        self.terminal_controller = controller;
        self
    }

    pub fn with_readiness_ownership_sources(
        mut self,
        layout_store: LayoutStore,
        terminals: TerminalRegistry,
        ownership: Arc<RuntimeOwnershipRegistry>,
    ) -> Self {
        self.readiness_layout_store = Some(layout_store);
        self.readiness_terminals = Some(terminals);
        self.readiness_ownership = Some(ownership);
        self
    }

    pub fn with_host_agent_admission(mut self, gate: HostAgentAdmissionGate) -> Self {
        self.host_agent_admission = Some(gate);
        self
    }

    pub fn spawn_projector(&self) {
        if self.client.is_none() {
            return;
        }
        let state = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = state.project_once().await {
                    tracing::warn!(error = %error, "managed_runtime.projector_retry");
                }
            }
        });
    }

    async fn project_once(&self) -> Result<(), String> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| "managed runtime unavailable".to_string())?;
        let snapshot = client
            .inventory_snapshot()
            .await
            .map_err(|error| error.to_string())?;
        if self.projection_store.reconcile_snapshot(&snapshot).await? {
            self.project_all_bindings(&snapshot).await;
            let _ = self.broadcast_tx.send(
                json!({
                    "type": "runtime.inventory.changed",
                    "revision": snapshot.revision,
                    "readiness": snapshot.readiness,
                })
                .to_string(),
            );
        }

        let soul_views = latest_soul_views(&snapshot.souls);
        let events = client
            .pending_view_projections(PROJECTOR_BATCH)
            .await
            .map_err(|error| error.to_string())?;
        for event in events {
            // The supervisor outbox and the web projection are separate
            // durable stores. Recheck the current soul/view revision before
            // applying an event so delayed pre-stop state cannot recreate a
            // running tab after a newer tombstone committed.
            let changed = if projection_event_is_current(&snapshot, &event) {
                self.projection_store.apply_event(&event).await?
            } else {
                false
            };
            if changed {
                if let Some(view) = soul_views.get(event.view_intent.soul_id.as_str()) {
                    self.project_binding(&event.view_intent, view).await;
                }
                let _ = self.broadcast_tx.send(
                    json!({
                        "type": "runtime.view.changed",
                        "inventoryRevision": event.inventory_revision,
                        "eventId": event.event_id,
                        "view": event.view_intent,
                    })
                    .to_string(),
                );
            }
            // Stale events are acknowledged only after the current snapshot
            // itself has been durably reconciled above.
            client
                .acknowledge_view_projection(event.event_id)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    async fn project_all_bindings(&self, snapshot: &RuntimeInventorySnapshot) {
        let soul_views = latest_soul_views(&snapshot.souls);
        for intent in &snapshot.view_intents {
            if let Some(view) = soul_views.get(intent.soul_id.as_str()) {
                self.project_binding(intent, view).await;
            }
        }
    }

    async fn project_binding(&self, intent: &ViewIntent, view: &RuntimeView) {
        let (Some(provider), Some(session_id), Some(terminal_id)) = (
            view.provider.clone(),
            view.native_session_id.clone(),
            view.terminal_id.clone(),
        ) else {
            return;
        };
        if provider == "shell" {
            return;
        }
        let mode = view
            .terminal_mode
            .clone()
            .unwrap_or_else(|| provider.clone());
        let cwd = view.terminal_cwd.clone();
        let create_request_id = view.terminal_create_request_id.clone();
        let ledger = Arc::clone(&self.pane_ledger);
        let now = now_millis();
        let view_id = intent.view_id.to_string();
        let result = tokio::task::spawn_blocking(move || {
            ledger.record_binding(&BindingWrite {
                provider: &provider,
                session_id: &session_id,
                terminal_id: &terminal_id,
                mode: &mode,
                cwd: cwd.as_deref(),
                create_request_id: create_request_id.as_deref(),
                origin_create_request_id: create_request_id.as_deref(),
                provenance: ProvenancePolicy::Inherit,
                observed_epoch: None,
                observed_generation: None,
                now_ms: now,
            })
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(
                view_id = %view_id,
                error = %error,
                "managed_runtime.pane_ledger_projection_failed"
            ),
            Err(error) => tracing::warn!(
                view_id = %view_id,
                error = %error,
                "managed_runtime.pane_ledger_projection_panicked"
            ),
        }
    }
}

pub fn router(state: ManagedRuntimeApiState) -> Router {
    Router::new()
        .route("/api/runtime/readiness", get(runtime_readiness))
        .route("/api/runtime/maintenance/status", get(maintenance_status))
        .route(
            "/api/runtime/maintenance/quiesce",
            post(maintenance_quiesce),
        )
        .route("/api/runtime/maintenance/renew", post(maintenance_renew))
        .route(
            "/api/runtime/maintenance/release",
            post(maintenance_release),
        )
        .route(
            "/api/runtime/maintenance/commit-stop",
            post(maintenance_commit_stop),
        )
        .route("/api/runtime/souls", get(list_souls))
        .route("/api/runtime/souls/{soul_id}", get(get_soul))
        .route(
            "/api/runtime/souls/{soul_id}/history",
            get(read_native_history),
        )
        .route("/api/runtime/souls/{soul_id}/retry", post(retry_soul))
        .route("/api/runtime/souls/{soul_id}/stop", post(stop_soul))
        .route("/api/runtime/soul-loss-repairs", post(restore_lost_souls))
        .route(
            "/api/runtime/soul-loss-repairs/preflight",
            post(preflight_lost_souls),
        )
        .route("/api/runtime/souls/{soul_id}/limits", patch(update_limits))
        .route(
            "/api/runtime/incidents/{incident_id}/summary",
            get(incident_summary),
        )
        .route("/api/runtime/notices", get(pending_notices))
        .route(
            "/api/runtime/notices/{notice_id}/receipt",
            post(record_notice_receipt),
        )
        .route("/api/runtime/metrics", get(runtime_metrics_snapshot))
        .route("/api/runtime/migration/plan", post(migration_plan))
        .route("/api/runtime/migration/apply", post(migration_apply))
        .route("/api/runtime/repair", post(repair_runtime))
        .route("/api/runtime/souls/{soul_id}/views", post(upsert_view))
        .route("/api/runtime/views/{view_id}", patch(update_view))
        .with_state(state)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoulsQuery {
    workspace_id: Option<String>,
}

async fn runtime_readiness(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    match collect_readiness(&state).await {
        Ok(report) => Json(report).into_response(),
        Err(rejection) => rejection.into_response(),
    }
}

const DEFAULT_MAINTENANCE_LEASE_MS: u64 = 30_000;
const MAX_MAINTENANCE_LEASE_MS: u64 = 300_000;
const DEFAULT_MAINTENANCE_DRAIN_MS: u64 = 10_000;
const MAX_MAINTENANCE_DRAIN_MS: u64 = 30_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaintenanceQuiesceRequest {
    owner_id: String,
    #[serde(default = "default_maintenance_lease_ms")]
    lease_duration_ms: u64,
    #[serde(default = "default_maintenance_drain_ms")]
    drain_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaintenanceLeaseRequest {
    owner_id: String,
    lease_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaintenanceRenewRequest {
    owner_id: String,
    lease_id: String,
    #[serde(default = "default_maintenance_lease_ms")]
    lease_duration_ms: u64,
}

fn default_maintenance_lease_ms() -> u64 {
    DEFAULT_MAINTENANCE_LEASE_MS
}

fn default_maintenance_drain_ms() -> u64 {
    DEFAULT_MAINTENANCE_DRAIN_MS
}

fn admission_gate(state: &ManagedRuntimeApiState) -> Result<&HostAgentAdmissionGate, ApiRejection> {
    state
        .host_agent_admission
        .as_ref()
        .ok_or_else(|| ApiRejection {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Host coding-agent maintenance admission is unavailable".into(),
        })
}

fn maintenance_error(error: AdmissionError) -> Response {
    let status = match error {
        AdmissionError::InvalidOwner | AdmissionError::InvalidLeaseDuration => {
            StatusCode::BAD_REQUEST
        }
        AdmissionError::LeaseBusy
        | AdmissionError::LeaseMismatch
        | AdmissionError::LeaseExpired
        | AdmissionError::NotDrained
        | AdmissionError::LeaseNotClean => StatusCode::CONFLICT,
        AdmissionError::DrainTimeout
        | AdmissionError::Maintenance
        | AdmissionError::ShutdownLatched => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(json!({"error": error.to_string()}))).into_response()
}

fn lease_json(lease: &AdmissionLease, gate: &HostAgentAdmissionGate) -> serde_json::Value {
    json!({
        "ownerId": lease.owner_id,
        "leaseId": lease.lease_id,
        "expiresInMs": gate.status().lease_expires_in_ms,
    })
}

fn status_json(gate: &HostAgentAdmissionGate) -> serde_json::Value {
    let status = gate.status();
    json!({
        "phase": status.phase,
        "activePermits": status.active_permits,
        "leaseOwner": status.lease_owner,
        "leaseExpiresInMs": status.lease_expires_in_ms,
    })
}

async fn maintenance_status(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    match admission_gate(&state) {
        Ok(gate) => Json(status_json(gate)).into_response(),
        Err(rejection) => rejection.into_response(),
    }
}

async fn maintenance_quiesce(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(request): Json<MaintenanceQuiesceRequest>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    if request.lease_duration_ms == 0
        || request.lease_duration_ms > MAX_MAINTENANCE_LEASE_MS
        || request.drain_timeout_ms > MAX_MAINTENANCE_DRAIN_MS
    {
        return bad_request(
            "leaseDurationMs and drainTimeoutMs must be within the supported bounds",
        );
    }
    let gate = match admission_gate(&state) {
        Ok(gate) => gate,
        Err(rejection) => return rejection.into_response(),
    };
    let lease = match gate.begin_quiesce(
        &request.owner_id,
        std::time::Duration::from_millis(request.lease_duration_ms),
    ) {
        Ok(lease) => lease,
        Err(error) => return maintenance_error(error),
    };
    if let Err(error) = gate
        .drain(
            &lease,
            std::time::Duration::from_millis(request.drain_timeout_ms),
        )
        .await
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": error.to_string(),
                "drained": false,
                "lease": lease_json(&lease, gate),
                "admission": status_json(gate),
            })),
        )
            .into_response();
    }

    let report = match collect_readiness(&state).await {
        Ok(report) => report,
        Err(rejection) => {
            let mut report = PaneOwnershipReport::incomplete();
            report.diagnostic = Some(rejection.message);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "managed runtime ownership census is unavailable",
                    "drained": true,
                    "readyToStop": false,
                    "lease": lease_json(&lease, gate),
                    "admission": status_json(gate),
                    "paneOwnership": report,
                })),
            )
                .into_response();
        }
    };
    let pane_ownership = report["paneOwnership"].clone();
    let ready_to_stop = pane_ownership_is_safe(&pane_ownership);
    if ready_to_stop {
        if let Err(error) = gate.mark_clean(&lease) {
            return maintenance_error(error);
        }
    }
    Json(json!({
        "drained": true,
        "readyToStop": ready_to_stop,
        "lease": lease_json(&lease, gate),
        "admission": status_json(gate),
        "readiness": report,
    }))
    .into_response()
}

async fn maintenance_renew(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(request): Json<MaintenanceRenewRequest>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    if request.lease_duration_ms == 0 || request.lease_duration_ms > MAX_MAINTENANCE_LEASE_MS {
        return bad_request("leaseDurationMs must be within the supported bounds");
    }
    let gate = match admission_gate(&state) {
        Ok(gate) => gate,
        Err(rejection) => return rejection.into_response(),
    };
    match gate.renew(
        &request.owner_id,
        &request.lease_id,
        std::time::Duration::from_millis(request.lease_duration_ms),
    ) {
        Ok(lease) => Json(json!({
            "lease": lease_json(&lease, gate),
            "admission": status_json(gate),
        }))
        .into_response(),
        Err(error) => maintenance_error(error),
    }
}

async fn maintenance_release(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(request): Json<MaintenanceLeaseRequest>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let gate = match admission_gate(&state) {
        Ok(gate) => gate,
        Err(rejection) => return rejection.into_response(),
    };
    match gate.release_for(&request.owner_id, &request.lease_id) {
        Ok(()) => Json(json!({"admission": status_json(gate)})).into_response(),
        Err(error) => maintenance_error(error),
    }
}

async fn maintenance_commit_stop(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(request): Json<MaintenanceLeaseRequest>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let gate = match admission_gate(&state) {
        Ok(gate) => gate,
        Err(rejection) => return rejection.into_response(),
    };
    let lease = AdmissionLease {
        owner_id: request.owner_id,
        lease_id: request.lease_id,
    };
    let report = match collect_readiness(&state).await {
        Ok(report) => report,
        Err(rejection) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": rejection.message, "readyToStop": false})),
            )
                .into_response();
        }
    };
    let pane_ownership = report["paneOwnership"].clone();
    if !pane_ownership_is_safe(&pane_ownership) {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "host-managed, unknown, or unattached coding work prevents shutdown",
                "readyToStop": false,
                "readiness": report,
            })),
        )
            .into_response();
    }
    if let Err(error) = gate.mark_clean(&lease) {
        return maintenance_error(error);
    }
    match gate.commit_stop(&lease) {
        Ok(()) => Json(json!({
            "committed": true,
            "admission": status_json(gate),
            "readiness": report,
        }))
        .into_response(),
        Err(error) => maintenance_error(error),
    }
}

fn pane_ownership_is_safe(value: &serde_json::Value) -> bool {
    value.get("complete").and_then(serde_json::Value::as_bool) == Some(true)
        && value
            .get("readyToStop")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
}

async fn collect_readiness(
    state: &ManagedRuntimeApiState,
) -> Result<serde_json::Value, ApiRejection> {
    let client = runtime_client(state)?;
    let before = client.health().await.map_err(client_rejection)?;
    let snapshot = client
        .inventory_snapshot()
        .await
        .map_err(client_rejection)?;
    let after = client.health().await.map_err(client_rejection)?;
    if before != after {
        return Err(ApiRejection {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Managed runtime changed while readiness was being read".into(),
        });
    }
    let pane_ownership = pane_ownership_report(
        state.readiness_layout_store.as_ref(),
        state.readiness_terminals.as_ref(),
        state.readiness_ownership.as_deref(),
        &snapshot.souls,
    );
    let (control_epoch, installation_id) = before;
    Ok(json!({
        "installationId": installation_id,
        "controlEpoch": control_epoch,
        "revision": snapshot.revision,
        "readiness": snapshot.readiness,
        "pendingProjectionCount": snapshot.pending_projection_count,
        "paneOwnership": pane_ownership,
    }))
}

fn client_rejection(error: ClientError) -> ApiRejection {
    let response = client_error(error);
    let status = response.status();
    ApiRejection {
        status,
        message: "Managed runtime readiness request failed".into(),
    }
}

async fn list_souls(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Query(query): Query<SoulsQuery>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client.inventory_snapshot().await {
        Ok(mut snapshot) => {
            if let Some(workspace_id) = query.workspace_id.as_deref() {
                let soul_ids = snapshot
                    .souls
                    .iter()
                    .filter(|view| view.project_key.as_deref() == Some(workspace_id))
                    .map(|view| view.soul_id.to_string())
                    .collect::<std::collections::HashSet<_>>();
                snapshot
                    .souls
                    .retain(|view| soul_ids.contains(view.soul_id.as_str()));
                snapshot.view_intents.retain(|view| {
                    view.workspace_id == workspace_id && soul_ids.contains(view.soul_id.as_str())
                });
            }
            Json(snapshot).into_response()
        }
        Err(error) => client_error(error),
    }
}

async fn get_soul(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let soul = match SoulId::parse(raw) {
        Ok(soul) => soul,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    let snapshot = match client.inventory_snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => return client_error(error),
    };
    let Some(view) = snapshot
        .souls
        .iter()
        .rev()
        .find(|view| view.soul_id == soul)
        .cloned()
    else {
        return not_found("managed soul not found");
    };
    let metrics = client.metrics(soul.clone()).await.ok();
    let view_intents = snapshot
        .view_intents
        .into_iter()
        .filter(|intent| intent.soul_id == soul)
        .collect::<Vec<_>>();
    Json(json!({
        "revision": snapshot.revision,
        "readiness": snapshot.readiness,
        "soul": view,
        "viewIntents": view_intents,
        "actualUsage": metrics,
    }))
    .into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionBody {
    request_id: Option<String>,
    expected_intent_revision: Option<u64>,
}

async fn retry_soul(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
    Json(body): Json<RevisionBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(revision) = body.expected_intent_revision else {
        return bad_request("expectedIntentRevision is required");
    };
    let soul = match SoulId::parse(raw) {
        Ok(soul) => soul,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    let result = if let Some(controller) = &state.terminal_controller {
        controller
            .retry_with_request_id(request_id, soul, revision)
            .await
    } else {
        client
            .recover_expected_with_request_id(
                request_id,
                soul,
                RecoveryTrigger::ManualRetry,
                Some(revision),
            )
            .await
    };
    match result {
        Ok(result) => Json(result).into_response(),
        Err(error) => client_error(error),
    }
}

async fn read_native_history(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let soul = match SoulId::parse(raw) {
        Ok(soul) => soul,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client.fresh_agent_history(soul).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => client_error(error),
    }
}

async fn stop_soul(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
    Json(body): Json<RevisionBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(revision) = body.expected_intent_revision else {
        return bad_request("expectedIntentRevision is required");
    };
    let soul = match SoulId::parse(raw) {
        Ok(soul) => soul,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .stop_expected_with_request_id(request_id, soul, Some(revision))
        .await
    {
        Ok((outcome, view)) => Json(json!({"outcome": outcome, "soul": view})).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreLostSoulsBody {
    idempotency_key: String,
    scope_id: String,
    source: freshell_runtime_protocol::RepairBatchSourceSelection,
    targets: Vec<LostSoulRepairTarget>,
    #[serde(default)]
    canonical_owners: Vec<freshell_runtime_protocol::CanonicalOwnerChoice>,
}

async fn restore_lost_souls(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(body): Json<RestoreLostSoulsBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match RequestId::parse(body.idempotency_key) {
        Ok(request_id) => request_id,
        Err(error) => return bad_request(error.to_string()),
    };
    let request = freshell_runtime_protocol::RestoreLostSoulsRequest {
        scope_id: body.scope_id.clone(),
        source: body.source.clone(),
        targets: body.targets.clone(),
        canonical_owners: body.canonical_owners.clone(),
        expected_control_epoch: None,
    };
    if let Err(error) = request.validate_payload() {
        return bad_request(error.message);
    }
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .restore_lost_souls(
            request_id,
            body.scope_id,
            body.source,
            body.targets,
            body.canonical_owners,
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreflightLostSoulsBody {
    #[serde(flatten)]
    source: freshell_runtime_protocol::RepairBatchSourceSelection,
    expected_control_epoch: Option<u64>,
}

async fn preflight_lost_souls(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(body): Json<PreflightLostSoulsBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .preflight_lost_souls_at_epoch(body.source, body.expected_control_epoch)
        .await
    {
        Ok(scope) => Json(scope).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitsBody {
    request_id: Option<String>,
    expected_intent_revision: Option<u64>,
    cpu_milli: u64,
    memory_bytes: u64,
    #[serde(default)]
    swap_bytes: u64,
    pids_max: u64,
}

async fn update_limits(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
    Json(body): Json<LimitsBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(revision) = body.expected_intent_revision else {
        return bad_request("expectedIntentRevision is required");
    };
    let soul = match SoulId::parse(raw) {
        Ok(soul) => soul,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .update_limits_with_request_id(
            request_id,
            soul,
            RuntimeLimits {
                cpu_milli: body.cpu_milli,
                memory_bytes: body.memory_bytes,
                swap_bytes: body.swap_bytes,
                pids_max: body.pids_max,
            },
            revision,
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => client_error(error),
    }
}

async fn incident_summary(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let incident_id = match IncidentId::parse(raw) {
        Ok(incident_id) => incident_id,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client.incident_summary(incident_id).await {
        Ok(summary) => Json(summary).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticesQuery {
    profile_id: Option<String>,
    limit: Option<u32>,
}

async fn pending_notices(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Query(query): Query<NoticesQuery>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(profile_id) = query.profile_id.filter(|value| !value.trim().is_empty()) else {
        return bad_request("profileId is required");
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .pending_notices(profile_id, query.limit.unwrap_or(20))
        .await
    {
        Ok(notices) => Json(json!({"notices": notices})).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticeReceiptBody {
    request_id: Option<String>,
    profile_id: String,
    state: NoticeDeliveryState,
}

async fn record_notice_receipt(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
    Json(body): Json<NoticeReceiptBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let notice_id = match NoticeId::parse(raw) {
        Ok(notice_id) => notice_id,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .record_notice_receipt_with_request_id(request_id, notice_id, body.profile_id, body.state)
        .await
    {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(error) => client_error(error),
    }
}

async fn runtime_metrics_snapshot(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client.runtime_metrics_snapshot().await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationBody {
    request_id: Option<String>,
    requested_mode: ManagedRolloutMode,
    #[serde(default)]
    backup_path: Option<String>,
    #[serde(default)]
    legacy_metadata_path: Option<String>,
}

async fn migration_plan(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(body): Json<MigrationBody>,
) -> Response {
    migration_response(state, headers, body, false).await
}

async fn migration_apply(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(body): Json<MigrationBody>,
) -> Response {
    migration_response(state, headers, body, true).await
}

async fn migration_response(
    state: ManagedRuntimeApiState,
    headers: HeaderMap,
    body: MigrationBody,
    apply: bool,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .migration_plan_with_request_id(
            request_id,
            MigrationPlanRequest {
                requested_mode: body.requested_mode,
                apply,
                backup_path: body.backup_path,
                legacy_metadata_path: body.legacy_metadata_path,
                expected_control_epoch: None,
            },
        )
        .await
    {
        Ok(plan) => Json(plan).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepairBody {
    request_id: Option<String>,
    #[serde(default)]
    apply: bool,
}

async fn repair_runtime(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    Json(body): Json<RepairBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .repair_audit_with_request_id(request_id, body.apply)
        .await
    {
        Ok(audit) => Json(audit).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertViewBody {
    request_id: Option<String>,
    view_id: Option<String>,
    intent: ViewIntentRequest,
    expected_revision: Option<u64>,
    expected_soul_intent_revision: Option<u64>,
}

async fn upsert_view(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
    Json(body): Json<UpsertViewBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let soul = match SoulId::parse(raw) {
        Ok(soul) => soul,
        Err(error) => return bad_request(error.to_string()),
    };
    let Some(soul_revision) = body.expected_soul_intent_revision else {
        return bad_request("expectedSoulIntentRevision is required");
    };
    let view_id = match body.view_id {
        Some(raw) => match ViewIntentId::parse(raw) {
            Ok(view_id) => Some(view_id),
            Err(error) => return bad_request(error.to_string()),
        },
        None => None,
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .upsert_view_intent_with_request_id(
            request_id,
            UpsertViewIntentRequest {
                soul_id: soul,
                view_id,
                intent: body.intent,
                expected_revision: body.expected_revision,
                expected_soul_intent_revision: soul_revision,
                expected_control_epoch: None,
            },
        )
        .await
    {
        Ok(intent) => Json(intent).into_response(),
        Err(error) => client_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewVisibilityBody {
    request_id: Option<String>,
    visibility: ViewVisibilityIntent,
    expected_revision: Option<u64>,
    expected_soul_intent_revision: Option<u64>,
}

async fn update_view(
    State(state): State<ManagedRuntimeApiState>,
    headers: HeaderMap,
    AxumPath(raw): AxumPath<String>,
    Json(body): Json<ViewVisibilityBody>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request_id = match mutation_request_id(body.request_id) {
        Ok(request_id) => request_id,
        Err(rejection) => return rejection.into_response(),
    };
    let view_id = match ViewIntentId::parse(raw) {
        Ok(view_id) => view_id,
        Err(error) => return bad_request(error.to_string()),
    };
    let (Some(view_revision), Some(soul_revision)) =
        (body.expected_revision, body.expected_soul_intent_revision)
    else {
        return bad_request("expectedRevision and expectedSoulIntentRevision are required");
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(rejection) => return rejection.into_response(),
    };
    match client
        .update_view_visibility_with_request_id(
            request_id,
            UpdateViewVisibilityRequest {
                view_id,
                visibility: body.visibility,
                expected_revision: view_revision,
                expected_soul_intent_revision: soul_revision,
                expected_control_epoch: None,
            },
        )
        .await
    {
        Ok(intent) => Json(intent).into_response(),
        Err(error) => client_error(error),
    }
}

fn projection_event_is_current(
    snapshot: &RuntimeInventorySnapshot,
    event: &ViewProjectionEvent,
) -> bool {
    let Some(current_view) = snapshot
        .view_intents
        .iter()
        .find(|view| view.view_id == event.view_intent.view_id)
    else {
        return false;
    };
    if current_view.revision != event.view_intent.revision
        || current_view.soul_intent_revision != event.soul_intent_revision
    {
        return false;
    }
    let Some(soul) = snapshot
        .souls
        .iter()
        .find(|soul| soul.soul_id == event.view_intent.soul_id)
    else {
        return false;
    };
    if soul.intent_revision != event.soul_intent_revision {
        return false;
    }
    soul.desired_state != DesiredState::Stopped
        || event.view_intent.visibility == ViewVisibilityIntent::Hidden
}

#[derive(Debug)]
struct ApiRejection {
    status: StatusCode,
    message: String,
}

impl IntoResponse for ApiRejection {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

fn mutation_request_id(raw: Option<String>) -> Result<RequestId, ApiRejection> {
    let rejection = |message: String| ApiRejection {
        status: StatusCode::BAD_REQUEST,
        message,
    };
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Err(rejection("requestId is required".into()));
    };
    RequestId::parse(raw).map_err(|error| rejection(error.to_string()))
}

fn runtime_client(state: &ManagedRuntimeApiState) -> Result<RuntimeClient, ApiRejection> {
    state.client.clone().ok_or_else(|| ApiRejection {
        status: StatusCode::SERVICE_UNAVAILABLE,
        message: "Managed runtime unavailable".into(),
    })
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PaneOwnership {
    Durable,
    HostManaged,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPaneOwnership {
    client_id: String,
    tab_id: String,
    pane_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip)]
    session_type: Option<String>,
    #[serde(skip)]
    create_request_id: Option<String>,
    #[serde(skip)]
    identity_consistent: bool,
    ownership: PaneOwnership,
    #[serde(skip_serializing_if = "Option::is_none")]
    soul_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    incarnation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnattachedProcess {
    kind: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    ownership: PaneOwnership,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneOwnershipReport {
    complete: bool,
    panes: Vec<AgentPaneOwnership>,
    unattached_processes: Vec<UnattachedProcess>,
    ready_to_stop: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
}

impl PaneOwnershipReport {
    fn incomplete() -> Self {
        Self {
            complete: false,
            panes: Vec::new(),
            unattached_processes: Vec::new(),
            ready_to_stop: false,
            diagnostic: None,
        }
    }
}

fn pane_ownership_report(
    layout_store: Option<&LayoutStore>,
    terminals: Option<&TerminalRegistry>,
    ownership: Option<&RuntimeOwnershipRegistry>,
    runtime_views: &[RuntimeView],
) -> PaneOwnershipReport {
    let terminal_rows = terminals
        .map(TerminalRegistry::inventory)
        .unwrap_or_default();
    let mut panes: Vec<AgentPaneOwnership> = layout_store
        .map(LayoutStore::live_pane_snapshots)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| agent_pane_identity(entry.client_id, entry.pane))
        // This is the census of work a web stop could interrupt. Retained
        // history panes are excluded only with affirmative process-exit or
        // supervisor cleanup evidence; missing and transitional work stays.
        .filter(|pane| !pane_is_confirmed_inactive(pane, runtime_views, &terminal_rows, terminals))
        .map(|mut pane| {
            let classification =
                classify_agent_pane(&pane, runtime_views, &terminal_rows, ownership);
            pane.ownership = classification.ownership;
            pane.soul_id = classification.soul_id;
            pane.incarnation_id = classification.incarnation_id;
            pane
        })
        .collect();
    panes.sort_by(|left, right| {
        left.client_id
            .cmp(&right.client_id)
            .then_with(|| left.tab_id.cmp(&right.tab_id))
            .then_with(|| left.pane_id.cmp(&right.pane_id))
    });
    let mut unattached_processes =
        unattached_processes(&panes, &terminal_rows, runtime_views, ownership);
    unattached_processes.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.terminal_id.cmp(&right.terminal_id))
            .then_with(|| left.session_id.cmp(&right.session_id))
            .then_with(|| left.source.cmp(&right.source))
    });
    let complete = layout_store.is_some() && terminals.is_some() && ownership.is_some();
    let ready_to_stop = complete
        && panes
            .iter()
            .all(|pane| pane.ownership == PaneOwnership::Durable)
        && unattached_processes.is_empty();
    PaneOwnershipReport {
        complete,
        panes,
        unattached_processes,
        ready_to_stop,
        diagnostic: None,
    }
}

fn unattached_processes(
    panes: &[AgentPaneOwnership],
    terminal_rows: &[InventoryTerminal],
    runtime_views: &[RuntimeView],
    ownership: Option<&RuntimeOwnershipRegistry>,
) -> Vec<UnattachedProcess> {
    let mut processes = Vec::new();
    for terminal in terminal_rows.iter().filter(|terminal| {
        terminal.mode != "shell" && terminal.status == freshell_protocol::TerminalRunStatus::Running
    }) {
        let matching_panes = panes
            .iter()
            .filter(|pane| pane.terminal_id.as_deref() == Some(terminal.terminal_id.as_str()))
            .collect::<Vec<_>>();
        let matching_soul_panes = match (
            terminal.soul_id.as_deref(),
            terminal.incarnation_id.as_deref(),
        ) {
            (Some(soul_id), Some(incarnation_id)) => panes
                .iter()
                .filter(|pane| {
                    pane.soul_id.as_deref() == Some(soul_id)
                        && pane.incarnation_id.as_deref() == Some(incarnation_id)
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let matching_inventory_count = terminal_rows
            .iter()
            .filter(|row| row.terminal_id == terminal.terminal_id)
            .count();
        let uniquely_durable = matching_inventory_count == 1
            && terminal_runtime_view(
                &terminal.mode,
                &terminal.terminal_id,
                Some(terminal),
                runtime_views,
            )
            .is_some_and(runtime_view_is_running)
            && matching_panes.iter().all(|pane| {
                pane.ownership == PaneOwnership::Durable
                    && terminal.soul_id.as_deref() == pane.soul_id.as_deref()
                    && terminal.incarnation_id.as_deref() == pane.incarnation_id.as_deref()
            })
            && matching_soul_panes.iter().all(|pane| {
                pane.ownership == PaneOwnership::Durable
                    && pane.terminal_id.as_deref() == Some(terminal.terminal_id.as_str())
            });
        if uniquely_durable {
            continue;
        }
        let ownership = match matching_panes.as_slice() {
            [pane] if pane.ownership == PaneOwnership::HostManaged => PaneOwnership::HostManaged,
            [] if terminal.soul_id.is_none() && terminal.incarnation_id.is_none() => {
                PaneOwnership::HostManaged
            }
            _ => PaneOwnership::Unknown,
        };
        processes.push(UnattachedProcess {
            kind: "terminal".into(),
            source: "terminal-registry".into(),
            provider: Some(terminal.mode.clone()),
            terminal_id: Some(terminal.terminal_id.clone()),
            session_id: terminal
                .session_ref
                .as_ref()
                .map(|session_ref| session_ref.session_id.clone()),
            ownership,
            reason: "running terminal has no unique current supervisor identity or has conflicting panes".into(),
        });
    }

    if let Some(ownership) = ownership {
        let live_terminal_ids = terminal_rows
            .iter()
            .filter(|terminal| {
                terminal.mode != "shell"
                    && terminal.status == freshell_protocol::TerminalRunStatus::Running
            })
            .map(|terminal| terminal.terminal_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        for record in ownership.snapshot_records() {
            if record.alias_of.is_some() || record.owner_kind == "vacant" {
                continue;
            }
            if record.owner_kind == "terminal"
                && record.state == ReplayOwnerState::Live
                && record
                    .terminal_id
                    .as_deref()
                    .is_some_and(|terminal_id| live_terminal_ids.contains(terminal_id))
            {
                continue;
            }
            let (kind, source, process_ownership, reason) =
                match (record.owner_kind.as_str(), record.state) {
                    ("fresh-agent", ReplayOwnerState::Live) => (
                        "fresh-agent",
                        "runtime-ownership-registry",
                        PaneOwnership::HostManaged,
                        "live host Fresh Agent owner is outside a durable soul",
                    ),
                    ("terminal", ReplayOwnerState::Live) => (
                        "terminal",
                        "runtime-ownership-registry",
                        PaneOwnership::Unknown,
                        "live terminal owner has no running terminal registry row",
                    ),
                    (_, _) => (
                        "coding-agent",
                        "runtime-ownership-registry",
                        PaneOwnership::Unknown,
                        "ownership record is in a transition or has an unknown owner",
                    ),
                };
            let matched_panes = panes
                .iter()
                .filter(|pane| {
                    pane.provider.as_deref() == Some(record.provider.as_str())
                        && pane.session_id.as_deref() == Some(record.session_id.as_str())
                })
                .collect::<Vec<_>>();
            let process_ownership = match matched_panes.as_slice() {
                [pane] if pane.ownership == PaneOwnership::HostManaged => process_ownership,
                [] => process_ownership,
                _ => PaneOwnership::Unknown,
            };
            processes.push(UnattachedProcess {
                kind: kind.into(),
                source: source.into(),
                provider: Some(record.provider),
                terminal_id: record.terminal_id,
                session_id: Some(record.session_id),
                ownership: process_ownership,
                reason: reason.into(),
            });
        }
    }
    processes
}

struct PaneClassification {
    ownership: PaneOwnership,
    soul_id: Option<String>,
    incarnation_id: Option<String>,
}

impl PaneClassification {
    fn unknown() -> Self {
        Self {
            ownership: PaneOwnership::Unknown,
            soul_id: None,
            incarnation_id: None,
        }
    }

    fn durable(view: &RuntimeView) -> Self {
        Self {
            ownership: PaneOwnership::Durable,
            soul_id: Some(view.soul_id.to_string()),
            incarnation_id: Some(view.incarnation_id.to_string()),
        }
    }

    fn host_managed() -> Self {
        Self {
            ownership: PaneOwnership::HostManaged,
            soul_id: None,
            incarnation_id: None,
        }
    }
}

fn classify_agent_pane(
    pane: &AgentPaneOwnership,
    runtime_views: &[RuntimeView],
    terminal_rows: &[InventoryTerminal],
    ownership: Option<&RuntimeOwnershipRegistry>,
) -> PaneClassification {
    if !pane.identity_consistent {
        return PaneClassification::unknown();
    }
    match pane.kind.as_str() {
        "terminal" => classify_terminal_pane(pane, runtime_views, terminal_rows),
        "fresh-agent" => classify_fresh_agent_pane(pane, runtime_views, ownership),
        _ => PaneClassification::unknown(),
    }
}

fn runtime_view_is_verified_empty(view: &RuntimeView) -> bool {
    view.desired_state == DesiredState::Stopped
        && view.cleanup_state == freshell_runtime_protocol::CleanupState::VerifiedEmpty
        && !view.launch_state.is_potentially_active()
}

fn pane_is_confirmed_inactive(
    pane: &AgentPaneOwnership,
    runtime_views: &[RuntimeView],
    terminal_rows: &[InventoryTerminal],
    terminals: Option<&TerminalRegistry>,
) -> bool {
    if !pane.identity_consistent {
        return false;
    }
    match pane.kind.as_str() {
        "terminal" => {
            let Some(provider) = pane.provider.as_deref() else {
                return false;
            };
            let terminal_id = match pane.terminal_id.as_deref() {
                Some(id) => id,
                None => {
                    // The ordinary client clears terminalId on natural exit.
                    // Its retained create key can identify one exact row, but
                    // multiple generations or an absent row prove nothing.
                    let (Some(create_id), Some(terminals)) =
                        (pane.create_request_id.as_deref(), terminals)
                    else {
                        return false;
                    };
                    if create_id.is_empty() {
                        return false;
                    }
                    let mut matching = terminal_rows.iter().filter(|row| {
                        terminals
                            .probe_create_request_id(&row.terminal_id)
                            .as_deref()
                            == Some(create_id)
                    });
                    let Some(row) = matching.next() else {
                        return false;
                    };
                    if matching.next().is_some() {
                        return false;
                    }
                    row.terminal_id.as_str()
                }
            };
            let matching_rows = terminal_rows
                .iter()
                .filter(|row| row.terminal_id == terminal_id)
                .collect::<Vec<_>>();
            let terminal = match matching_rows.as_slice() {
                [row]
                    if row.mode == provider
                        && row.status == freshell_protocol::TerminalRunStatus::Exited =>
                {
                    Some(*row)
                }
                [] => None,
                _ => return false,
            };
            if terminal.is_some_and(|row| row.soul_id.is_none() && row.incarnation_id.is_none()) {
                // Only confirmed local exits retain ordinary Exited rows.
                // Managed blocked facades also say Exited, so their exact
                // supervisor cleanup evidence is required below instead.
                return !runtime_views
                    .iter()
                    .any(|view| view.terminal_id.as_deref() == Some(terminal_id));
            }
            terminal_runtime_view(provider, terminal_id, terminal, runtime_views)
                .is_some_and(runtime_view_is_verified_empty)
        }
        "fresh-agent" => fresh_agent_runtime_view(pane, runtime_views)
            .is_some_and(runtime_view_is_verified_empty),
        _ => false,
    }
}

fn classify_terminal_pane(
    pane: &AgentPaneOwnership,
    runtime_views: &[RuntimeView],
    terminal_rows: &[InventoryTerminal],
) -> PaneClassification {
    let (Some(provider), Some(terminal_id)) =
        (pane.provider.as_deref(), pane.terminal_id.as_deref())
    else {
        return PaneClassification::unknown();
    };
    let matching_terminals = terminal_rows
        .iter()
        .filter(|terminal| terminal.terminal_id == terminal_id)
        .collect::<Vec<_>>();
    let [terminal] = matching_terminals.as_slice() else {
        return PaneClassification::unknown();
    };
    if terminal.mode != provider || terminal.status != freshell_protocol::TerminalRunStatus::Running
    {
        return PaneClassification::unknown();
    }
    match (
        terminal.soul_id.as_deref(),
        terminal.incarnation_id.as_deref(),
    ) {
        (Some(_), Some(_)) => {
            match terminal_runtime_view(provider, terminal_id, Some(terminal), runtime_views) {
                Some(view) if runtime_view_is_running(view) => PaneClassification::durable(view),
                _ => PaneClassification::unknown(),
            }
        }
        (None, None) => PaneClassification::host_managed(),
        _ => PaneClassification::unknown(),
    }
}

fn runtime_view_is_running(view: &RuntimeView) -> bool {
    view.desired_state == DesiredState::Running
        && view.launch_state == freshell_runtime_protocol::LaunchState::Running
}

/// Match the current supervisor identity independently of browser presence.
/// Any second view sharing its terminal, soul, or incarnation is ambiguous.
fn terminal_runtime_view<'a>(
    provider: &str,
    terminal_id: &str,
    terminal: Option<&InventoryTerminal>,
    runtime_views: &'a [RuntimeView],
) -> Option<&'a RuntimeView> {
    let mut candidates = runtime_views.iter().filter(|view| {
        view.terminal_id.as_deref() == Some(terminal_id)
            || terminal.is_some_and(|terminal| {
                terminal.soul_id.as_deref() == Some(view.soul_id.as_str())
                    || terminal.incarnation_id.as_deref() == Some(view.incarnation_id.as_str())
            })
    });
    let view = candidates.next()?;
    if candidates.next().is_some()
        || view.terminal_id.as_deref() != Some(terminal_id)
        || view.provider.as_deref() != Some(provider)
        || view.terminal_mode.as_deref() != Some(provider)
        || terminal.is_some_and(|terminal| {
            terminal.mode != provider
                || terminal.soul_id.as_deref() != Some(view.soul_id.as_str())
                || terminal.incarnation_id.as_deref() != Some(view.incarnation_id.as_str())
        })
    {
        return None;
    }
    Some(view)
}

fn classify_fresh_agent_pane(
    pane: &AgentPaneOwnership,
    runtime_views: &[RuntimeView],
    ownership: Option<&RuntimeOwnershipRegistry>,
) -> PaneClassification {
    let (Some(provider), Some(session_id)) = (pane.provider.as_deref(), pane.session_id.as_deref())
    else {
        return PaneClassification::unknown();
    };
    if runtime_views
        .iter()
        .any(|view| fresh_agent_session_matches(view, session_id))
    {
        return match fresh_agent_runtime_view(pane, runtime_views) {
            Some(view) if runtime_view_is_running(view) => PaneClassification::durable(view),
            _ => PaneClassification::unknown(),
        };
    }
    let Some(ownership) = ownership else {
        return PaneClassification::unknown();
    };
    match ownership.observe(provider, session_id).state {
        OwnershipState::Live { owner, .. }
            if owner.kind == RuntimeOwnerKind::FreshAgent
                && owner
                    .live_session_key
                    .as_deref()
                    .is_some_and(|key| !key.is_empty()) =>
        {
            PaneClassification::host_managed()
        }
        _ => PaneClassification::unknown(),
    }
}

fn fresh_agent_session_matches(view: &RuntimeView, session_id: &str) -> bool {
    // Materialization changes the pane's launch ID to the native session ID.
    // Both aliases belong to the same authoritative supervisor view.
    view.fresh_agent_session_id.as_deref() == Some(session_id)
        || view.native_session_id.as_deref() == Some(session_id)
}

fn fresh_agent_runtime_view<'a>(
    pane: &AgentPaneOwnership,
    runtime_views: &'a [RuntimeView],
) -> Option<&'a RuntimeView> {
    let (Some(provider), Some(session_id), Some(session_type)) = (
        pane.provider.as_deref(),
        pane.session_id.as_deref(),
        pane.session_type.as_deref(),
    ) else {
        return None;
    };
    let mut candidates = runtime_views
        .iter()
        .filter(|view| fresh_agent_session_matches(view, session_id));
    let view = candidates.next()?;
    if candidates.next().is_some()
        || view.provider.as_deref() != Some(provider)
        || view.fresh_agent_session_type.as_deref() != Some(session_type)
    {
        return None;
    }
    Some(view)
}

fn agent_pane_identity(client_id: String, pane: PaneSnapshot) -> Option<AgentPaneOwnership> {
    let content = pane.pane_content.as_ref()?;
    let kind = content.get("kind")?.as_str()?;
    let is_agent_pane = match kind {
        "fresh-agent" => true,
        "terminal" => content.get("mode").and_then(serde_json::Value::as_str) != Some("shell"),
        _ => false,
    };
    if !is_agent_pane {
        return None;
    }
    let provider = content
        .get("provider")
        .or_else(|| content.get("mode"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let pane_session_id = content
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let session_ref = content.get("sessionRef");
    let reference_session_id = session_ref
        .and_then(|value| value.get("sessionId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let reference_provider = session_ref
        .and_then(|value| value.get("provider"))
        .and_then(serde_json::Value::as_str);
    let mode_provider = content.get("mode").and_then(serde_json::Value::as_str);
    let identity_consistent = provider.as_deref().is_none_or(|provider| {
        mode_provider.is_none_or(|mode| mode == provider)
            && reference_provider.is_none_or(|reference_provider| reference_provider == provider)
    }) && pane_session_id
        .as_deref()
        .zip(reference_session_id.as_deref())
        .is_none_or(|(pane_id, reference_id)| pane_id == reference_id);
    Some(AgentPaneOwnership {
        client_id,
        tab_id: pane.tab_id,
        pane_id: pane.pane_id,
        kind: kind.to_owned(),
        provider,
        terminal_id: pane.terminal_id,
        session_id: pane_session_id.or(reference_session_id),
        session_type: content
            .get("sessionType")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        create_request_id: content
            .get("createRequestId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        identity_consistent,
        ownership: PaneOwnership::Unknown,
        soul_id: None,
        incarnation_id: None,
    })
}

fn latest_soul_views(views: &[RuntimeView]) -> HashMap<String, RuntimeView> {
    views
        .iter()
        .cloned()
        .map(|view| (view.soul_id.to_string(), view))
        .collect()
}

fn client_error(error: ClientError) -> Response {
    let status = match error.runtime_code() {
        Some(freshell_runtime_protocol::RuntimeErrorCode::UnknownSoul) => StatusCode::NOT_FOUND,
        Some(freshell_runtime_protocol::RuntimeErrorCode::StaleIntentRevision) => {
            StatusCode::CONFLICT
        }
        Some(freshell_runtime_protocol::RuntimeErrorCode::BlockedResource) => StatusCode::CONFLICT,
        Some(freshell_runtime_protocol::RuntimeErrorCode::InvalidRequest)
        | Some(freshell_runtime_protocol::RuntimeErrorCode::InvalidRuntimeLimits) => {
            StatusCode::BAD_REQUEST
        }
        Some(freshell_runtime_protocol::RuntimeErrorCode::RecoveryInProgress)
        | Some(freshell_runtime_protocol::RuntimeErrorCode::LossCertificationBlocked)
        | Some(freshell_runtime_protocol::RuntimeErrorCode::MigrationBlocked)
        | Some(freshell_runtime_protocol::RuntimeErrorCode::RepairBlocked) => StatusCode::CONFLICT,
        Some(freshell_runtime_protocol::RuntimeErrorCode::NoticeNotFound) => StatusCode::NOT_FOUND,
        Some(freshell_runtime_protocol::RuntimeErrorCode::IncidentPersistenceFailed) => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        _ => StatusCode::BAD_GATEWAY,
    };
    (status, Json(json!({"error": error.to_string()}))).into_response()
}

fn bad_request(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": message.into()})),
    )
        .into_response()
}

fn not_found(message: impl Into<String>) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": message.into()})),
    )
        .into_response()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn atomic_write_json(path: &Path, document: &ProjectionDocument) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| error.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "managed_runtime_api_stop_tests.rs"]
mod stop_contract_tests;

#[cfg(test)]
mod tests {
    use super::*;

    async fn maintenance_request(
        app: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        use tower::ServiceExt;

        let mut request = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            request = request.header("x-auth-token", token);
        }
        let body = if let Some(body) = body {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        } else {
            Body::empty()
        };
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    async fn maintenance_router(
        root: &std::path::Path,
        gate: HostAgentAdmissionGate,
        layout_store: LayoutStore,
        ownership: Arc<RuntimeOwnershipRegistry>,
    ) -> (Router, tokio::task::JoinHandle<()>) {
        maintenance_router_with_readiness_terminals(
            root,
            gate,
            layout_store,
            TerminalRegistry::new(),
            ownership,
        )
        .await
    }

    async fn maintenance_router_with_readiness_terminals(
        root: &std::path::Path,
        gate: HostAgentAdmissionGate,
        layout_store: LayoutStore,
        readiness_terminals: TerminalRegistry,
        ownership: Arc<RuntimeOwnershipRegistry>,
    ) -> (Router, tokio::task::JoinHandle<()>) {
        let (registry, _) = stop_contract_tests::fixture_fresh_soul_with_cleanup(
            root,
            false,
            "opencode",
            "freshopencode",
            "maintenance-managed-session",
            false,
        )
        .await;
        maintenance_router_with_registry(
            root,
            gate,
            layout_store,
            readiness_terminals,
            ownership,
            registry,
        )
        .await
    }

    async fn maintenance_router_with_registry(
        root: &std::path::Path,
        gate: HostAgentAdmissionGate,
        layout_store: LayoutStore,
        readiness_terminals: TerminalRegistry,
        ownership: Arc<RuntimeOwnershipRegistry>,
        registry: freshell_supervisor::registry::Registry,
    ) -> (Router, tokio::task::JoinHandle<()>) {
        use freshell_supervisor::backend::DockerEngineBackend;

        let backend = Arc::new(DockerEngineBackend::new(root.join("no-docker.sock")));
        let (socket, control) = stop_contract_tests::start_control(root, registry, backend).await;
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(4);
        let state = ManagedRuntimeApiState::new(
            Arc::new("maintenance-secret".into()),
            Some(RuntimeClient::new(&socket, "test-control-secret")),
            None,
            Arc::new(PaneLedger::new(None)),
            Arc::new(broadcast_tx),
        )
        .await
        .unwrap()
        .with_readiness_ownership_sources(layout_store, readiness_terminals, ownership)
        .with_host_agent_admission(gate);
        (router(state), control)
    }

    fn readiness_layout_sync(
        tab_id: &str,
        pane_id: &str,
        content: serde_json::Value,
    ) -> freshell_protocol::UiLayoutSync {
        serde_json::from_value(json!({
            "tabs": [{ "id": tab_id }],
            "activeTabId": tab_id,
            "layouts": { (tab_id): { "type": "leaf", "id": pane_id, "content": content } },
            "activePane": { (tab_id): pane_id },
            "timestamp": 1,
        }))
        .expect("readiness layout sync parses")
    }

    #[tokio::test]
    async fn maintenance_api_is_authenticated_and_lease_owner_bound() {
        let root = tempfile::tempdir().unwrap();
        let gate = HostAgentAdmissionGate::new();
        let layout_store = LayoutStore::default();
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let (app, control) =
            maintenance_router(root.path(), gate.clone(), layout_store, ownership).await;

        let (status, _) =
            maintenance_request(&app, "GET", "/api/runtime/maintenance/status", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/quiesce",
            None,
            Some(json!({"ownerId":"updater-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(gate.status().phase, "open");

        let (status, body) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/quiesce",
            Some("maintenance-secret"),
            Some(json!({"ownerId":"updater-a"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let lease = body["lease"].clone();
        assert_eq!(body["drained"], true);

        let (status, renewed) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/renew",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":"updater-a", "leaseId":lease["leaseId"],
                "leaseDurationMs":60000
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{renewed}");
        assert_eq!(renewed["lease"]["leaseId"], lease["leaseId"]);

        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/release",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":"updater-b", "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(gate.status().phase, "quiesced");

        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/renew",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":"updater-a", "leaseId":"stale-lease",
                "leaseDurationMs":30000
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/release",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":"updater-a", "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(gate.status().phase, "open");

        control.abort();
        let _ = control.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_quiesce_drains_delayed_host_create_and_reports_its_process() {
        use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity};
        use std::time::Duration;

        let root = tempfile::tempdir().unwrap();
        let gate = HostAgentAdmissionGate::new();
        let layout_store = LayoutStore::default();
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let (app, control) = maintenance_router(
            root.path(),
            gate.clone(),
            layout_store.clone(),
            Arc::clone(&ownership),
        )
        .await;

        // Model a REST Fresh Agent create that acquired its permit before
        // quiesce and publishes its process ownership and pane afterward.
        let permit = gate.try_admit().unwrap();
        let delayed_layout = layout_store.clone();
        let delayed_ownership = Arc::clone(&ownership);
        let create = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            delayed_layout.update_from_ui(
                &readiness_layout_sync(
                    "tab-host-race",
                    "pane-host-race",
                    json!({
                        "kind":"fresh-agent", "provider":"claude",
                        "sessionType":"freshclaude", "sessionId":"native-race-session",
                        "createRequestId":"host-race-create", "status":"running"
                    }),
                ),
                "client-host-race",
            );
            let BeginOutcome::Granted { generation } = delayed_ownership.begin_start(
                "claude",
                "native-race-session",
                RuntimeOwnerKind::FreshAgent,
                "host-race-create",
                None,
                "maintenance-race-test",
                1,
            ) else {
                panic!("fake delayed host create should acquire ownership")
            };
            assert_eq!(
                delayed_ownership.commit_live(
                    "claude",
                    "native-race-session",
                    "host-race-create",
                    generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some("freshclaude:native-race-session".into()),
                        pid: Some(42),
                        ownership_id: None,
                    },
                ),
                CommitOutcome::Committed
            );
            drop(permit);
        });

        let (status, body) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/quiesce",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":"updater-race", "leaseDurationMs":60000,
                "drainTimeoutMs":2000
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        create.await.unwrap();
        assert_eq!(body["drained"], true);
        assert_eq!(body["readyToStop"], false);
        assert_eq!(body["readiness"]["paneOwnership"]["complete"], true);
        assert_eq!(
            body["readiness"]["paneOwnership"]["panes"][0]["ownership"],
            "host-managed"
        );
        let unattached = body["readiness"]["paneOwnership"]["unattachedProcesses"]
            .as_array()
            .unwrap();
        assert!(unattached.iter().any(|process| {
            process["sessionId"] == "native-race-session" && process["ownership"] == "host-managed"
        }));
        assert_eq!(gate.status().phase, "quiesced");
        assert!(matches!(gate.try_admit(), Err(AdmissionError::Maintenance)));

        let lease = &body["lease"];
        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/commit-stop",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":lease["ownerId"], "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(gate.status().phase, "quiesced");

        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/release",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":lease["ownerId"], "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(gate.status().phase, "open");
        assert!(gate.try_admit().is_ok());

        control.abort();
        let _ = control.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_quiesce_drains_detached_session_handoff_before_census() {
        use freshell_freshagent::{HandoffRequest, HandoffTestHooks, SessionHandoffRunner};
        use freshell_ownership::{OwnershipState, RuntimeOwnerKind};
        use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, time::Duration};

        let root = match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(directory) => tempfile::tempdir_in(directory),
            None => tempfile::tempdir(),
        }
        .unwrap();
        let script = root.path().join("handoff-terminal.sh");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 300\n").unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let layout_store = LayoutStore::default();
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let registry = TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(32);
        let broadcast_tx = Arc::new(broadcast_tx);
        let auth_token = Arc::new("maintenance-secret".to_string());
        let cli_commands = Arc::new(vec![freshell_platform::CliCommandSpec {
            name: "claude".into(),
            label: "Claude CLI".into(),
            env_var: None,
            default_cmd: script.to_string_lossy().to_string(),
            base_args: Vec::new(),
            base_env: BTreeMap::new(),
            resume_args: Some(vec!["--resume".into(), "{{sessionId}}".into()]),
            create_session_args: Some(vec!["--session-id".into(), "{{sessionId}}".into()]),
            model_args: None,
            effort_args: None,
            sandbox_args: None,
            permission_mode_args: None,
        }]);
        let fresh_agent = freshell_freshagent::FreshAgentState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
        )
        .with_ownership(Arc::clone(&ownership))
        .with_terminal_registry(registry.clone())
        .with_cli_commands(Arc::clone(&cli_commands));
        let fresh_codex = freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({ "freshAgent": { "enabled": true } }),
        );
        let fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
        let fresh_opencode = freshell_freshagent::FreshOpencodeState::new(fresh_agent.clone());
        let spawn_pause = Arc::new(tokio::sync::Notify::new());
        let hooks = Arc::new(HandoffTestHooks {
            pause_in_target_spawn: Some(Arc::clone(&spawn_pause)),
            ..HandoffTestHooks::default()
        });
        let runner = Arc::new(
            SessionHandoffRunner::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                Arc::clone(&ownership),
                registry.clone(),
                fresh_codex,
                fresh_claude,
                fresh_opencode,
                fresh_agent.clone(),
                Arc::clone(&cli_commands),
            )
            .with_test_hooks(Arc::clone(&hooks)),
        );
        let (app, control) = maintenance_router_with_readiness_terminals(
            root.path(),
            fresh_agent.host_agent_admission(),
            layout_store,
            registry.clone(),
            Arc::clone(&ownership),
        )
        .await;

        let session_id = format!("handoff-race-{}", uuid::Uuid::new_v4());
        let handle = runner.spawn_handoff(HandoffRequest {
            action: freshell_freshagent::session_handoff::HandoffAction::Switch,
            provider: "claude".into(),
            session_id: session_id.clone(),
            target_kind: RuntimeOwnerKind::Terminal,
            session_type: None,
            mode: Some("claude".into()),
            cwd: Some(root.path().to_string_lossy().to_string()),
            tab_id: None,
            pane_id: None,
            observed_epoch: None,
            observed_generation: None,
            device_id: Some("maintenance-race-test".into()),
        });
        let freshell_freshagent::HandoffHandle { completion, task } = handle;
        // The HTTP requester disconnected; the runner remains detached.
        drop(completion);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let target_terminal = loop {
            let published = hooks.published_terminal_for_test();
            if published.is_some() {
                break published;
            }
            if tokio::time::Instant::now() >= deadline {
                break None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };

        let quiesce_app = app.clone();
        let quiesce = tokio::spawn(async move {
            maintenance_request(
                &quiesce_app,
                "POST",
                "/api/runtime/maintenance/quiesce",
                Some("maintenance-secret"),
                Some(json!({
                    "ownerId":"updater-handoff-race", "leaseDurationMs":60000,
                    "drainTimeoutMs":5000
                })),
            )
            .await
        });
        let quiesce_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while fresh_agent.host_agent_admission().status().phase != "quiesced"
            && tokio::time::Instant::now() < quiesce_deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let admission_drain_waited = !quiesce.is_finished();
        let permit_held_during_target_spawn =
            fresh_agent.host_agent_admission().status().active_permits == 1;

        // Always unpark the detached task before making assertions, so a red
        // test does not leave a sleeper process behind.
        spawn_pause.notify_one();
        let handoff_join = tokio::time::timeout(Duration::from_secs(15), task).await;
        let handoff_settled = matches!(handoff_join, Ok(Ok(())));
        let quiesce_result = tokio::time::timeout(Duration::from_secs(15), quiesce).await;
        let quiesce_result = match quiesce_result {
            Ok(Ok(result)) => Some(result),
            _ => None,
        };
        let (quiesce_status, quiesce_body) =
            quiesce_result.unwrap_or((StatusCode::INTERNAL_SERVER_ERROR, json!({})));
        let lease = quiesce_body["lease"].clone();
        let target_owned = match ownership.observe("claude", &session_id).state {
            OwnershipState::Live { owner, .. } => {
                owner.kind == RuntimeOwnerKind::Terminal
                    && owner.terminal_id == target_terminal.clone()
            }
            _ => false,
        };
        let census_reports_target = quiesce_body["readiness"]["paneOwnership"]
            ["unattachedProcesses"]
            .as_array()
            .is_some_and(|processes| {
                processes.iter().any(|process| {
                    process["terminalId"] == target_terminal.clone().unwrap_or_default()
                        && process["ownership"] == "host-managed"
                })
            });
        let ready_to_stop = quiesce_body["readyToStop"] == true;

        let (commit_status, _) = if lease["leaseId"].is_string() {
            maintenance_request(
                &app,
                "POST",
                "/api/runtime/maintenance/commit-stop",
                Some("maintenance-secret"),
                Some(json!({
                    "ownerId":lease["ownerId"], "leaseId":lease["leaseId"]
                })),
            )
            .await
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, json!({}))
        };
        if lease["leaseId"].is_string() {
            let _ = maintenance_request(
                &app,
                "POST",
                "/api/runtime/maintenance/release",
                Some("maintenance-secret"),
                Some(json!({
                    "ownerId":lease["ownerId"], "leaseId":lease["leaseId"]
                })),
            )
            .await;
        }
        if let Some(terminal_id) = target_terminal.as_ref() {
            registry.kill(terminal_id);
            let death_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while !registry.terminal_is_dead(terminal_id)
                && tokio::time::Instant::now() < death_deadline
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        control.abort();
        let _ = control.await;

        assert!(
            permit_held_during_target_spawn,
            "the detached handoff must hold admission while the target spawn is parked"
        );
        assert!(
            admission_drain_waited,
            "quiesce must wait for the detached handoff permit"
        );
        assert!(
            handoff_settled,
            "the detached handoff must settle after target spawn is released"
        );
        assert_eq!(quiesce_status, StatusCode::OK, "{quiesce_body}");
        assert!(
            target_owned,
            "the handoff must commit the published terminal as owner"
        );
        assert!(
            census_reports_target,
            "the final census must report the host-owned target: {quiesce_body}"
        );
        assert!(
            !ready_to_stop,
            "the host-owned terminal must block commit-stop"
        );
        assert_eq!(
            commit_status,
            StatusCode::CONFLICT,
            "host-owned work must refuse stop"
        );
        assert!(
            target_terminal.is_some(),
            "the target spawn hook must publish a terminal id"
        );
        assert!(
            !hooks.events.lock().expect("handoff hooks lock").is_empty(),
            "normal handoff completion must record its target start"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_commit_stop_requires_clean_census_and_latches_this_process() {
        let root = tempfile::tempdir().unwrap();
        let gate = HostAgentAdmissionGate::new();
        let layout_store = LayoutStore::default();
        layout_store.update_from_ui(
            &readiness_layout_sync(
                "tab-managed",
                "pane-managed",
                json!({
                    "kind":"fresh-agent", "provider":"opencode",
                    "sessionType":"freshopencode", "sessionId":"fresh-retained-thread",
                    "createRequestId":"managed-create", "status":"running"
                }),
            ),
            "client-managed",
        );
        let (app, control) = maintenance_router(
            root.path(),
            gate.clone(),
            layout_store,
            Arc::new(RuntimeOwnershipRegistry::new()),
        )
        .await;

        let (status, quiesce) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/quiesce",
            Some("maintenance-secret"),
            Some(json!({"ownerId":"updater-clean"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{quiesce}");
        assert_eq!(quiesce["readyToStop"], true);
        let lease = &quiesce["lease"];

        // A wrong owner cannot commit even if the census was clean.
        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/commit-stop",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":"other-updater", "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(gate.status().phase, "quiesced");

        let (status, committed) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/commit-stop",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":lease["ownerId"], "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{committed}");
        assert_eq!(committed["committed"], true);
        assert_eq!(gate.status().phase, "shutdown-latched");
        assert!(matches!(
            gate.try_admit(),
            Err(AdmissionError::ShutdownLatched)
        ));
        let (status, _) = maintenance_request(
            &app,
            "POST",
            "/api/runtime/maintenance/release",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":lease["ownerId"], "leaseId":lease["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        // This is a new process's gate; the old process's latch is not shared
        // globally or persisted across server starts.
        assert!(HostAgentAdmissionGate::new().try_admit().is_ok());

        control.abort();
        let _ = control.await;
    }

    #[test]
    fn ownership_census_fails_closed_for_missing_sources_and_unattached_live_agent() {
        use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity};

        let layout_store = LayoutStore::default();
        let terminals = TerminalRegistry::new();
        terminals.register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: "unattached-terminal".into(),
            stream_id: "unattached-stream".into(),
            mode: "claude".into(),
            resume_session_id: None,
            create_request_id: Some("unattached-terminal-create".into()),
            created_at: None,
        });
        let ownership = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            "unattached-session",
            RuntimeOwnerKind::FreshAgent,
            "server-owned-agent",
            None,
            "readiness-census-test",
            1,
        ) else {
            panic!("fake process should acquire ownership")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                "unattached-session",
                "server-owned-agent",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("freshcodex:unattached-session".into()),
                    pid: Some(44),
                    ownership_id: None,
                },
            ),
            CommitOutcome::Committed
        );

        let report =
            pane_ownership_report(Some(&layout_store), Some(&terminals), Some(&ownership), &[]);
        assert!(report.complete);
        assert!(!report.ready_to_stop);
        assert_eq!(report.unattached_processes.len(), 2);
        assert!(report.unattached_processes.iter().any(|process| {
            process.ownership == PaneOwnership::HostManaged
                && process.session_id.as_deref() == Some("unattached-session")
        }));
        assert!(report.unattached_processes.iter().any(|process| {
            process.ownership == PaneOwnership::HostManaged
                && process.terminal_id.as_deref() == Some("unattached-terminal")
        }));

        let incomplete = pane_ownership_report(Some(&layout_store), Some(&terminals), None, &[]);
        assert!(!incomplete.complete);
        assert!(!incomplete.ready_to_stop);
    }

    fn register_readiness_managed_terminal(terminals: &TerminalRegistry, view: &RuntimeView) {
        terminals.register_managed(
            freshell_terminal::registry::ManagedTerminalDescriptor {
                soul_id: view.soul_id.to_string(),
                incarnation_id: view.incarnation_id.to_string(),
                terminal_id: view.terminal_id.clone().unwrap(),
                stream_id: view.terminal_stream_id.clone().unwrap(),
                mode: view.terminal_mode.clone().unwrap(),
                cwd: "/workspace".into(),
                resume_session_id: view.native_session_id.clone(),
                create_request_id: view.terminal_create_request_id.clone(),
            },
            "Managed terminal".into(),
        );
    }

    async fn assert_maintenance_admits(app: &Router) {
        let (status, body) = maintenance_request(
            app,
            "GET",
            "/api/runtime/readiness",
            Some("maintenance-secret"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["paneOwnership"]["readyToStop"], true, "{body}");
        assert_eq!(body["paneOwnership"]["panes"], json!([]));
        assert_eq!(body["paneOwnership"]["unattachedProcesses"], json!([]));
        let (status, quiesce) = maintenance_request(
            app,
            "POST",
            "/api/runtime/maintenance/quiesce",
            Some("maintenance-secret"),
            Some(json!({"ownerId":"census-regression"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{quiesce}");
        assert_eq!(quiesce["readyToStop"], true, "{quiesce}");
        let (status, committed) = maintenance_request(
            app,
            "POST",
            "/api/runtime/maintenance/commit-stop",
            Some("maintenance-secret"),
            Some(json!({
                "ownerId":quiesce["lease"]["ownerId"],
                "leaseId":quiesce["lease"]["leaseId"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{committed}");
        assert_eq!(committed["committed"], true);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_admits_disconnected_managed_terminal_and_preserves_identity() {
        let root = tempfile::tempdir().unwrap();
        let (registry, view) = stop_contract_tests::fixture_terminal_soul_with_cleanup(
            root.path(),
            false,
            "codex",
            "disconnected-native-session",
            false,
        )
        .await;
        let terminals = TerminalRegistry::new();
        register_readiness_managed_terminal(&terminals, &view);
        let layouts = LayoutStore::default();
        layouts.update_from_ui(
            &readiness_layout_sync(
                "tab",
                "pane",
                json!({
                    "kind":"terminal", "mode":"codex", "terminalId":view.terminal_id,
                    "createRequestId":"managed-terminal-create", "status":"running"
                }),
            ),
            "client",
        );
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let before = pane_ownership_report(
            Some(&layouts),
            Some(&terminals),
            Some(&ownership),
            std::slice::from_ref(&view),
        );
        assert!(before.ready_to_stop);
        layouts.remove_client("client");
        assert!(layouts.live_pane_snapshots().is_empty());
        assert!(layouts.get_pane_snapshot("pane").is_some());
        let (app, control) = maintenance_router_with_registry(
            root.path(),
            HostAgentAdmissionGate::new(),
            layouts,
            terminals.clone(),
            ownership,
            registry.clone(),
        )
        .await;

        assert_maintenance_admits(&app).await;

        let after = registry.inventory().await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].soul_id, view.soul_id);
        assert_eq!(after[0].incarnation_id, view.incarnation_id);
        assert_eq!(after[0].desired_state, DesiredState::Running);
        assert_eq!(
            terminals.inventory()[0].status,
            freshell_protocol::TerminalRunStatus::Running
        );
        control.abort();
        let _ = control.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnected_managed_terminal_still_requires_unique_current_supervisor_evidence() {
        let root = tempfile::tempdir().unwrap();
        let (_, view) = stop_contract_tests::fixture_terminal_soul_with_cleanup(
            root.path(),
            false,
            "codex",
            "unpaired-native-session",
            false,
        )
        .await;
        let terminals = TerminalRegistry::new();
        register_readiness_managed_terminal(&terminals, &view);
        let layouts = LayoutStore::default();
        let ownership = RuntimeOwnershipRegistry::new();
        let mut conflicting = view.clone();
        conflicting.incarnation_id = freshell_runtime_protocol::IncarnationId::new();
        let mut inactive = view.clone();
        inactive.desired_state = DesiredState::Stopped;
        for views in [
            vec![],
            vec![conflicting.clone()],
            vec![view, conflicting],
            vec![inactive],
        ] {
            let report =
                pane_ownership_report(Some(&layouts), Some(&terminals), Some(&ownership), &views);
            assert!(!report.ready_to_stop);
            assert_eq!(report.unattached_processes.len(), 1);
            assert_eq!(
                report.unattached_processes[0].ownership,
                PaneOwnership::Unknown
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_admits_confirmed_ordinary_exit_and_preserves_saved_pane() {
        use freshell_ownership::{BeginOutcome, CommitOutcome};
        let root = tempfile::tempdir().unwrap();
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let terminals = TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        terminals.register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: "exited-terminal".into(),
            stream_id: "exited-stream".into(),
            mode: "codex".into(),
            resume_session_id: Some("exited-session".into()),
            create_request_id: Some("exited-create".into()),
            created_at: None,
        });
        let locator = freshell_protocol::SessionLocator {
            provider: "codex".into(),
            session_id: "exited-session".into(),
        };
        let BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            "exited-session",
            RuntimeOwnerKind::Terminal,
            "exit-owner",
            None,
            "census-exit",
            1,
        ) else {
            panic!("ordinary terminal fixture acquires ownership")
        };
        assert_eq!(
            terminals.commit_session_ref_ownership(
                &locator,
                "exit-owner",
                generation,
                "exited-terminal"
            ),
            CommitOutcome::Committed
        );
        let layouts = LayoutStore::default();
        let mut content = json!({"kind":"terminal", "mode":"codex", "terminalId":"exited-terminal", "createRequestId":"exited-create", "status":"exited"});
        layouts.update_from_ui(
            &readiness_layout_sync("tab", "pane", content.clone()),
            "client",
        );
        assert!(
            !pane_ownership_report(Some(&layouts), Some(&terminals), Some(&ownership), &[])
                .ready_to_stop,
            "UI exit status alone does not prove process exit"
        );
        assert!(terminals.finish_pty_exit("exited-terminal", 0));
        assert!(matches!(
            ownership.observe("codex", "exited-session").state,
            OwnershipState::Vacant
        ));
        assert!(
            pane_ownership_report(Some(&layouts), Some(&terminals), Some(&ownership), &[])
                .ready_to_stop
        );
        // The ordinary client clears terminalId after receiving terminal.exit.
        content.as_object_mut().unwrap().remove("terminalId");
        layouts.update_from_ui(
            &readiness_layout_sync("tab", "pane", content.clone()),
            "client",
        );
        let (app, control) = maintenance_router_with_readiness_terminals(
            root.path(),
            HostAgentAdmissionGate::new(),
            layouts.clone(),
            terminals.clone(),
            ownership,
        )
        .await;

        assert_maintenance_admits(&app).await;

        assert_eq!(
            layouts
                .get_pane_snapshot("pane")
                .unwrap()
                .pane_content
                .unwrap(),
            content
        );
        assert_eq!(
            terminals.inventory()[0].status,
            freshell_protocol::TerminalRunStatus::Exited
        );
        control.abort();
        let _ = control.await;
    }

    #[test]
    fn inactive_ordinary_pane_requires_unique_matching_exit_evidence() {
        let layouts = LayoutStore::default();
        let ownership = RuntimeOwnershipRegistry::new();
        let terminals = TerminalRegistry::new();
        let content = json!({"kind":"terminal", "mode":"codex", "createRequestId":"ordinary-create", "status":"exited"});
        layouts.update_from_ui(&readiness_layout_sync("tab", "pane", content), "client");
        assert!(
            !pane_ownership_report(Some(&layouts), Some(&terminals), Some(&ownership), &[])
                .ready_to_stop
        );
        for id in ["first", "second"] {
            terminals.register_headless(freshell_terminal::registry::HeadlessTerminal {
                terminal_id: id.into(),
                stream_id: format!("stream-{id}"),
                mode: "codex".into(),
                resume_session_id: None,
                create_request_id: Some("ordinary-create".into()),
                created_at: None,
            });
            assert!(terminals.finish_pty_exit(id, 0));
        }
        assert!(
            !pane_ownership_report(Some(&layouts), Some(&terminals), Some(&ownership), &[])
                .ready_to_stop,
            "ambiguous retained generations do not prove which pane exited"
        );
        layouts.update_from_ui(
            &readiness_layout_sync(
                "tab",
                "pane",
                json!({
                    "kind":"terminal", "mode":"claude", "terminalId":"first", "status":"exited"
                }),
            ),
            "client",
        );
        assert!(
            !pane_ownership_report(Some(&layouts), Some(&terminals), Some(&ownership), &[])
                .ready_to_stop,
            "an exited row for a different provider cannot establish absence"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn maintenance_admits_verified_empty_managed_panes_without_changing_identity() {
        for (provider, session_type) in [("codex", "freshcodex"), ("opencode", "freshopencode")] {
            for kind in ["terminal", "fresh-launch", "fresh-native"] {
                let root = tempfile::tempdir().unwrap();
                let (registry, view) = if kind == "terminal" {
                    stop_contract_tests::fixture_terminal_soul_with_cleanup(
                        root.path(),
                        true,
                        provider,
                        "stopped-native-session",
                        true,
                    )
                    .await
                } else {
                    stop_contract_tests::fixture_fresh_soul_with_cleanup(
                        root.path(),
                        true,
                        provider,
                        session_type,
                        "stopped-native-session",
                        true,
                    )
                    .await
                };
                let terminals = TerminalRegistry::new();
                let content = if kind == "terminal" {
                    register_readiness_managed_terminal(&terminals, &view);
                    terminals.publish_managed_lifecycle(
                        view.terminal_id.as_deref().unwrap(),
                        Some(freshell_terminal::registry::ManagedLifecycle {
                            state: freshell_terminal::registry::ManagedLifecycleState::Ended,
                            recovery_summary: None,
                        }),
                    );
                    json!({"kind":"terminal", "mode":provider, "terminalId":view.terminal_id, "status":"exited"})
                } else {
                    json!({"kind":"fresh-agent", "provider":provider, "sessionType":session_type,
                        "sessionId":if kind == "fresh-launch" {view.fresh_agent_session_id.clone()} else {view.native_session_id.clone()},
                        "createRequestId":"stopped-fresh-create", "status":"stopped"})
                };
                let layouts = LayoutStore::default();
                layouts.update_from_ui(
                    &readiness_layout_sync("tab", "pane", content.clone()),
                    "client",
                );
                let ownership = Arc::new(RuntimeOwnershipRegistry::new());
                // A stopped supervisor view also proves absence after a facade was retired.
                if kind == "terminal" {
                    assert!(
                        pane_ownership_report(
                            Some(&layouts),
                            Some(&TerminalRegistry::new()),
                            Some(&ownership),
                            std::slice::from_ref(&view)
                        )
                        .ready_to_stop
                    );
                }
                let (app, control) = maintenance_router_with_registry(
                    root.path(),
                    HostAgentAdmissionGate::new(),
                    layouts.clone(),
                    terminals,
                    ownership,
                    registry.clone(),
                )
                .await;

                assert_maintenance_admits(&app).await;

                assert_eq!(
                    layouts
                        .get_pane_snapshot("pane")
                        .unwrap()
                        .pane_content
                        .unwrap(),
                    content
                );
                let after = registry.inventory().await.unwrap();
                assert_eq!(after.len(), 1);
                assert_eq!(after[0].soul_id, view.soul_id);
                assert_eq!(after[0].incarnation_id, view.incarnation_id);
                assert_eq!(after[0].native_session_id, view.native_session_id);
                assert_eq!(
                    after[0].cleanup_state,
                    freshell_runtime_protocol::CleanupState::VerifiedEmpty
                );
                control.abort();
                let _ = control.await;
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inactive_census_keeps_missing_uncertain_conflicting_and_transitioning_work_blocking() {
        use freshell_runtime_protocol::{CleanupState, LaunchState};
        for terminal in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (_, view) = if terminal {
                stop_contract_tests::fixture_terminal_soul_with_cleanup(
                    root.path(),
                    true,
                    "codex",
                    "inactive-native-session",
                    true,
                )
                .await
            } else {
                stop_contract_tests::fixture_fresh_soul_with_cleanup(
                    root.path(),
                    true,
                    "codex",
                    "freshcodex",
                    "inactive-native-session",
                    true,
                )
                .await
            };
            let layouts = LayoutStore::default();
            layouts.update_from_ui(&readiness_layout_sync("tab", "pane", if terminal {
                json!({"kind":"terminal", "mode":"codex", "terminalId":view.terminal_id, "status":"exited"})
            } else {
                json!({"kind":"fresh-agent", "provider":"codex", "sessionType":"freshcodex", "sessionId":view.native_session_id, "status":"stopped"})
            }), "client");
            let terminals = TerminalRegistry::new();
            let ownership = RuntimeOwnershipRegistry::new();
            let uncertain_root = tempfile::tempdir().unwrap();
            let (_, uncertain) = if terminal {
                stop_contract_tests::fixture_terminal_soul_with_cleanup(
                    uncertain_root.path(),
                    true,
                    "codex",
                    "inactive-native-session",
                    false,
                )
                .await
            } else {
                stop_contract_tests::fixture_fresh_soul_with_cleanup(
                    uncertain_root.path(),
                    true,
                    "codex",
                    "freshcodex",
                    "inactive-native-session",
                    false,
                )
                .await
            };
            assert_eq!(
                uncertain.cleanup_state,
                CleanupState::TerminationUnconfirmed
            );
            let mut active = view.clone();
            active.launch_state = LaunchState::Running;
            let mut conflicting = view.clone();
            conflicting.incarnation_id = freshell_runtime_protocol::IncarnationId::new();
            for views in [
                vec![],
                vec![uncertain.clone()],
                vec![active],
                vec![view.clone(), conflicting.clone()],
            ] {
                assert!(
                    !pane_ownership_report(
                        Some(&layouts),
                        Some(&terminals),
                        Some(&ownership),
                        &views
                    )
                    .ready_to_stop
                );
            }
            if terminal {
                register_readiness_managed_terminal(&terminals, &view);
                assert!(
                    !pane_ownership_report(
                        Some(&layouts),
                        Some(&terminals),
                        Some(&ownership),
                        std::slice::from_ref(&view)
                    )
                    .ready_to_stop,
                    "a conflicting running facade must not be ignored"
                );
                terminals.publish_managed_lifecycle(
                    view.terminal_id.as_deref().unwrap(),
                    Some(freshell_terminal::registry::ManagedLifecycle {
                        state: freshell_terminal::registry::ManagedLifecycleState::Blocked,
                        recovery_summary: None,
                    }),
                );
                for views in [vec![], vec![uncertain], vec![conflicting]] {
                    assert!(
                        !pane_ownership_report(
                            Some(&layouts),
                            Some(&terminals),
                            Some(&ownership),
                            &views,
                        )
                        .ready_to_stop,
                        "an exited managed facade alone does not prove cleanup"
                    );
                }
            } else {
                let _ = ownership.begin_start(
                    "codex",
                    "inactive-native-session",
                    RuntimeOwnerKind::FreshAgent,
                    "transition",
                    None,
                    "census-transition",
                    1,
                );
                assert!(
                    !pane_ownership_report(
                        Some(&layouts),
                        Some(&terminals),
                        Some(&ownership),
                        &[view]
                    )
                    .ready_to_stop
                );
            }
        }
    }

    #[tokio::test]
    async fn runtime_readiness_rejects_missing_and_wrong_authentication() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(4);
        let state = ManagedRuntimeApiState::new(
            Arc::new("readiness-secret".into()),
            None,
            None,
            Arc::new(PaneLedger::new(None)),
            Arc::new(broadcast_tx),
        )
        .await
        .unwrap();
        let app = router(state);
        for token in [None, Some("wrong")] {
            let mut request = Request::builder().uri("/api/runtime/readiness");
            if let Some(token) = token {
                request = request.header("x-auth-token", token);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        for uri in [
            "/api/runtime/maintenance/renew",
            "/api/runtime/maintenance/release",
            "/api/runtime/maintenance/commit-stop",
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({"ownerId":"updater", "leaseId":"lease"}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
        }
    }

    #[tokio::test]
    async fn authenticated_readiness_reports_exact_disabled_runtime_response() {
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(4);
        let state = ManagedRuntimeApiState::new(
            Arc::new("readiness-secret".into()),
            None,
            None,
            Arc::new(PaneLedger::new(None)),
            Arc::new(broadcast_tx),
        )
        .await
        .unwrap();
        let (status, body) = maintenance_request(
            &router(state),
            "GET",
            "/api/runtime/readiness",
            Some("readiness-secret"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, json!({"error":"Managed runtime unavailable"}));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_reports_runtime_client_identity_scan_and_current_pane_ownership() {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity};
        use freshell_runtime_client::RuntimeClient;
        use freshell_supervisor::backend::DockerEngineBackend;
        use tower::ServiceExt;

        let root = tempfile::tempdir().unwrap();
        let (registry, managed_view) = stop_contract_tests::fixture_fresh_soul_with_cleanup(
            root.path(),
            false,
            "opencode",
            "freshopencode",
            "managed-native-session",
            false,
        )
        .await;
        let backend = Arc::new(DockerEngineBackend::new(root.path().join("no-docker.sock")));
        let (socket, control) =
            stop_contract_tests::start_control(root.path(), registry, backend).await;
        let direct_client = RuntimeClient::new(&socket, "test-control-secret");
        let direct_health = direct_client.health().await.unwrap();
        let direct_snapshot = direct_client.inventory_snapshot().await.unwrap();

        let layout_store = LayoutStore::default();
        layout_store.update_from_ui(
            &readiness_layout_sync(
                "tab-managed",
                "pane-managed",
                json!({
                    "kind": "fresh-agent", "provider": "opencode", "sessionType": "freshopencode",
                    "sessionId": managed_view.fresh_agent_session_id.clone().unwrap(),
                    "createRequestId": "managed-create", "status": "running"
                }),
            ),
            "client-managed",
        );
        layout_store.update_from_ui(
            &readiness_layout_sync(
                "tab-host",
                "pane-host",
                json!({
                    "kind": "fresh-agent", "provider": "claude", "sessionType": "freshclaude",
                    "sessionId": "host-native-session", "createRequestId": "host-create", "status": "running"
                }),
            ),
            "client-host",
        );
        layout_store.update_from_ui(
            &readiness_layout_sync(
                "tab-unknown",
                "pane-unknown",
                json!({
                    "kind": "fresh-agent", "provider": "codex", "sessionType": "freshcodex",
                    "sessionId": "unknown-native-session", "createRequestId": "unknown-create", "status": "running"
                }),
            ),
            "client-unknown",
        );
        layout_store.update_from_ui(
            &readiness_layout_sync(
                "tab-disconnected",
                "pane-disconnected",
                json!({
                    "kind": "fresh-agent", "provider": "claude", "sessionType": "freshclaude",
                    "sessionId": "host-native-session", "createRequestId": "stale-create", "status": "running"
                }),
            ),
            "client-disconnected",
        );
        layout_store.remove_client("client-disconnected");

        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let BeginOutcome::Granted { generation } = ownership.begin_start(
            "claude",
            "host-native-session",
            RuntimeOwnerKind::FreshAgent,
            "host-owner-test",
            None,
            "readiness-test",
            1,
        ) else {
            panic!("host-owned fixture must acquire its fake ownership record")
        };
        assert_eq!(
            ownership.commit_live(
                "claude",
                "host-native-session",
                "host-owner-test",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("freshclaude:host-native-session".into()),
                    pid: Some(42),
                    ownership_id: None,
                },
            ),
            CommitOutcome::Committed
        );

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(4);
        let state = ManagedRuntimeApiState::new(
            Arc::new("readiness-secret".into()),
            Some(RuntimeClient::new(&socket, "test-control-secret")),
            Some(root.path().join("managed-views.json")),
            Arc::new(PaneLedger::new(Some(root.path().join("ledger")))),
            Arc::new(broadcast_tx),
        )
        .await
        .unwrap()
        .with_readiness_ownership_sources(layout_store, TerminalRegistry::new(), ownership);
        let app = router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/runtime/readiness")
                    .header("x-auth-token", "readiness-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["installationId"], direct_health.1);
        assert_eq!(body["controlEpoch"], direct_health.0);
        assert_eq!(
            body["readiness"],
            serde_json::to_value(direct_snapshot.readiness).unwrap()
        );
        assert!(body["paneOwnership"]["complete"].as_bool().unwrap());
        assert_eq!(body["paneOwnership"]["readyToStop"], false);
        assert!(body["paneOwnership"]["unattachedProcesses"]
            .as_array()
            .unwrap()
            .iter()
            .any(|process| {
                process["sessionId"] == "host-native-session"
                    && process["ownership"] == "host-managed"
            }));
        let panes = body["paneOwnership"]["panes"].as_array().unwrap();
        assert_eq!(
            panes.len(),
            3,
            "all live layouts are reported; stale layouts are not"
        );
        let owner_by_pane = panes
            .iter()
            .map(|pane| {
                (
                    pane["paneId"].as_str().unwrap(),
                    pane["ownership"].as_str().unwrap(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(owner_by_pane.get("pane-managed"), Some(&"durable"));
        assert_eq!(owner_by_pane.get("pane-host"), Some(&"host-managed"));
        assert_eq!(owner_by_pane.get("pane-unknown"), Some(&"unknown"));
        assert!(!owner_by_pane.contains_key("pane-disconnected"));

        control.abort();
        let _ = control.await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ambiguous_fresh_agent_identity_is_not_reported_as_durable() {
        use freshell_runtime_protocol::{IncarnationId, SoulId};
        let root = tempfile::tempdir().unwrap();
        let (_registry, view) = stop_contract_tests::fixture_fresh_soul_with_cleanup(
            root.path(),
            false,
            "opencode",
            "freshopencode",
            "managed-native-session",
            false,
        )
        .await;
        let mut second = view.clone();
        second.soul_id = SoulId::new();
        second.incarnation_id = IncarnationId::new();
        let pane = AgentPaneOwnership {
            client_id: "client".into(),
            tab_id: "tab".into(),
            pane_id: "pane".into(),
            kind: "fresh-agent".into(),
            provider: Some("opencode".into()),
            terminal_id: None,
            session_id: view.fresh_agent_session_id.clone(),
            session_type: Some("freshopencode".into()),
            create_request_id: None,
            identity_consistent: true,
            ownership: PaneOwnership::Unknown,
            soul_id: None,
            incarnation_id: None,
        };
        let classification = classify_agent_pane(&pane, &[view, second], &[], None);
        assert_eq!(classification.ownership, PaneOwnership::Unknown);
        assert!(classification.soul_id.is_none());
        assert!(classification.incarnation_id.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fresh_agent_native_session_identity_matches_exact_managed_view() {
        use freshell_runtime_protocol::DesiredState;

        let root = tempfile::tempdir().unwrap();
        let (_registry, view) = stop_contract_tests::fixture_fresh_soul_with_cleanup(
            root.path(),
            false,
            "codex",
            "freshcodex",
            "managed-native-session",
            false,
        )
        .await;
        assert_eq!(view.desired_state, DesiredState::Running);
        assert_eq!(
            view.launch_state,
            freshell_runtime_protocol::LaunchState::Running
        );
        let pane = AgentPaneOwnership {
            client_id: "client".into(),
            tab_id: "tab".into(),
            pane_id: "pane".into(),
            kind: "fresh-agent".into(),
            provider: Some("codex".into()),
            terminal_id: None,
            session_id: view.native_session_id.clone(),
            session_type: Some("freshcodex".into()),
            create_request_id: None,
            identity_consistent: true,
            ownership: PaneOwnership::Unknown,
            soul_id: None,
            incarnation_id: None,
        };

        let classification = classify_agent_pane(&pane, &[view.clone()], &[], None);

        assert_eq!(classification.ownership, PaneOwnership::Durable);
        assert_eq!(
            classification.soul_id.as_deref(),
            Some(view.soul_id.as_str())
        );
        assert_eq!(
            classification.incarnation_id.as_deref(),
            Some(view.incarnation_id.as_str())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_pane_requires_matching_terminal_and_current_supervisor_identity() {
        use freshell_protocol::{InventoryTerminal, TerminalRunStatus};
        use freshell_runtime_protocol::DesiredState;

        let root = tempfile::tempdir().unwrap();
        let (_registry, mut view) = stop_contract_tests::fixture_fresh_soul_with_cleanup(
            root.path(),
            false,
            "codex",
            "freshcodex",
            "terminal-native-session",
            false,
        )
        .await;
        view.terminal_id = Some("managed-terminal".into());
        view.terminal_mode = Some("codex".into());
        view.provider = Some("codex".into());
        view.desired_state = DesiredState::Running;
        let pane = AgentPaneOwnership {
            client_id: "client".into(),
            tab_id: "tab".into(),
            pane_id: "pane".into(),
            kind: "terminal".into(),
            provider: Some("codex".into()),
            terminal_id: Some("managed-terminal".into()),
            session_id: None,
            session_type: None,
            create_request_id: None,
            identity_consistent: true,
            ownership: PaneOwnership::Unknown,
            soul_id: None,
            incarnation_id: None,
        };
        let terminal = InventoryTerminal {
            created_at: 1,
            last_activity_at: 1,
            mode: "codex".into(),
            status: TerminalRunStatus::Running,
            terminal_id: "managed-terminal".into(),
            title: "Codex".into(),
            codex_durability: None,
            cwd: None,
            description: None,
            runtime_status: None,
            soul_id: Some(view.soul_id.to_string()),
            incarnation_id: Some(view.incarnation_id.to_string()),
            recovery_summary: None,
            session_ref: None,
            session_name: None,
            name_ref: None,
        };
        let positive = classify_agent_pane(
            &pane,
            std::slice::from_ref(&view),
            &[terminal.clone()],
            None,
        );
        assert_eq!(positive.ownership, PaneOwnership::Durable);
        assert_eq!(positive.soul_id.as_deref(), Some(view.soul_id.as_str()));
        assert_eq!(
            positive.incarnation_id.as_deref(),
            Some(view.incarnation_id.as_str())
        );
        let mut durable_pane = pane.clone();
        durable_pane.ownership = positive.ownership;
        durable_pane.soul_id = positive.soul_id.clone();
        durable_pane.incarnation_id = positive.incarnation_id.clone();
        assert!(unattached_processes(
            &[durable_pane],
            std::slice::from_ref(&terminal),
            std::slice::from_ref(&view),
            None
        )
        .is_empty());

        let mut second_view = pane.clone();
        second_view.client_id = "second-client".into();
        second_view.pane_id = "second-pane".into();
        second_view.ownership = positive.ownership;
        second_view.soul_id = positive.soul_id.clone();
        second_view.incarnation_id = positive.incarnation_id.clone();
        let mut first_view = pane.clone();
        first_view.ownership = positive.ownership;
        first_view.soul_id = positive.soul_id.clone();
        first_view.incarnation_id = positive.incarnation_id.clone();
        assert!(
            unattached_processes(
                &[first_view.clone(), second_view],
                std::slice::from_ref(&terminal),
                std::slice::from_ref(&view),
                None,
            )
            .is_empty(),
            "two clients viewing the same uniquely managed terminal remain protected"
        );

        let mut wrong_incarnation = terminal.clone();
        wrong_incarnation.incarnation_id =
            Some(freshell_runtime_protocol::IncarnationId::new().to_string());
        let mismatch = classify_agent_pane(
            &pane,
            std::slice::from_ref(&view),
            &[wrong_incarnation.clone()],
            None,
        );
        assert_eq!(mismatch.ownership, PaneOwnership::Unknown);
        assert!(mismatch.soul_id.is_none());
        let mut unknown_pane = pane.clone();
        unknown_pane.ownership = mismatch.ownership;
        let mut conflicting_view = unknown_pane.clone();
        conflicting_view.client_id = "conflicting-client".into();
        conflicting_view.pane_id = "conflicting-pane".into();
        let unknown_processes = unattached_processes(
            &[first_view, conflicting_view],
            std::slice::from_ref(&terminal),
            std::slice::from_ref(&view),
            None,
        );
        assert_eq!(unknown_processes.len(), 1);
        assert_eq!(unknown_processes[0].ownership, PaneOwnership::Unknown);

        let duplicate_inventory = unattached_processes(
            &[unknown_pane],
            &[terminal, wrong_incarnation],
            &[view],
            None,
        );
        assert!(!duplicate_inventory.is_empty());
        assert!(duplicate_inventory
            .iter()
            .all(|process| process.ownership == PaneOwnership::Unknown));

        let host_terminal = InventoryTerminal {
            created_at: 1,
            last_activity_at: 1,
            mode: "codex".into(),
            status: TerminalRunStatus::Running,
            terminal_id: "managed-terminal".into(),
            title: "Codex".into(),
            codex_durability: None,
            cwd: None,
            description: None,
            runtime_status: None,
            soul_id: None,
            incarnation_id: None,
            recovery_summary: None,
            session_ref: None,
            session_name: None,
            name_ref: None,
        };
        let host = classify_agent_pane(&pane, &[], &[host_terminal], None);
        assert_eq!(host.ownership, PaneOwnership::HostManaged);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn durable_souls_routes_require_auth_before_control_or_registry_mutation() {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        use freshell_runtime_protocol::{LostSoulRepairTarget, RepairBatchSourceSelection};
        use freshell_supervisor::{backend::DockerEngineBackend, registry::Registry};
        use tower::ServiceExt;

        let root = tempfile::tempdir().unwrap();
        let mut targets = Vec::new();
        for index in 0..9 {
            let (_, view) = stop_contract_tests::fixture_fresh_soul_with_cleanup(
                root.path(),
                true,
                "opencode",
                "freshopencode",
                &format!("ses_auth_root_{}", index % 7),
                true,
            )
            .await;
            targets.push(LostSoulRepairTarget {
                soul_id: view.soul_id,
                incident_id: view.incident_id.unwrap(),
                expected_intent_revision: view.intent_revision,
            });
        }
        let registry = Registry::open(root.path(), None).unwrap();
        let backend = Arc::new(DockerEngineBackend::new(root.path().join("no-docker.sock")));
        let (socket, control) =
            stop_contract_tests::start_control(root.path(), registry.clone(), backend).await;
        let app = stop_contract_tests::web_router(&socket, root.path()).await;
        let before = registry.inventory().await.unwrap();
        let source = RepairBatchSourceSelection {
            source_store_id: "a".repeat(64),
            root_session_ids: (0..7)
                .map(|index| format!("ses_auth_root_{index}"))
                .collect(),
        };
        for token in [None, Some("wrong-token")] {
            for (route, body) in [
                (
                    "/api/runtime/soul-loss-repairs/preflight".to_owned(),
                    serde_json::to_value(&source).unwrap(),
                ),
                (
                    "/api/runtime/soul-loss-repairs".to_owned(),
                    serde_json::json!({"idempotencyKey":"auth-operation","scopeId":"b".repeat(64),"source":source,"targets":targets,"canonicalOwners":[]}),
                ),
                (
                    format!("/api/runtime/souls/{}/retry", targets[0].soul_id),
                    serde_json::json!({"requestId":RequestId::new()}),
                ),
            ] {
                let mut request = Request::builder()
                    .method("POST")
                    .uri(route)
                    .header("content-type", "application/json");
                if let Some(token) = token {
                    request = request.header("x-auth-token", token);
                }
                let response = app
                    .clone()
                    .oneshot(request.body(Body::from(body.to_string())).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                let body: serde_json::Value = serde_json::from_slice(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                )
                .unwrap();
                assert_eq!(body, serde_json::json!({"error":"Unauthorized"}));
            }
        }
        assert_eq!(registry.inventory().await.unwrap(), before);
        let conn = rusqlite::Connection::open(root.path().join("runtime.sqlite3")).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM stopped_repair_operations",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM stopped_repair_root_receipts",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
            0
        );
        assert!(!root.path().join("no-docker.sock").exists());
        control.abort();
        let _ = control.await;
    }
    use freshell_runtime_protocol::{
        InitialScanState, ProjectionEventId, RuntimeReadiness, ViewIntentKind,
    };

    fn intent(revision: u64) -> ViewIntent {
        ViewIntent {
            view_id: ViewIntentId::parse("view-test").unwrap(),
            soul_id: SoulId::parse("soul-test").unwrap(),
            owner_id: "owner".into(),
            workspace_id: "workspace".into(),
            kind: ViewIntentKind::AutomaticPrimary,
            preferred_tab_id: "tab-test".into(),
            preferred_pane_id: "pane-test".into(),
            title: "Recovered OpenCode agent".into(),
            placement_group: "Recovered agents".into(),
            visibility: ViewVisibilityIntent::Visible,
            revision,
            soul_intent_revision: 1,
            created_at: 1,
            updated_at: revision as i64,
        }
    }

    fn snapshot(revision: u64, view: ViewIntent) -> RuntimeInventorySnapshot {
        RuntimeInventorySnapshot {
            revision,
            readiness: RuntimeReadiness {
                inventory_revision: revision,
                initial_scan_state: InitialScanState::Complete,
                initial_scan_started_at: Some(1),
                initial_scan_finished_at: Some(2),
                blocked_subsystems: Vec::new(),
                startup_recovery_concurrency_limit: 4,
                startup_recovery_peak: 1,
                initial_scan_duration_ms: Some(1),
            },
            souls: Vec::new(),
            view_intents: vec![view],
            pending_projection_count: 0,
        }
    }

    #[tokio::test]
    async fn projection_store_replays_idempotently_and_rejects_older_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed-views.json");
        let store = ManagedViewProjectionStore::open(Some(path.clone())).unwrap();
        assert!(store
            .reconcile_snapshot(&snapshot(2, intent(2)))
            .await
            .unwrap());
        let stale = ViewProjectionEvent {
            event_id: ProjectionEventId::parse("projection-stale").unwrap(),
            inventory_revision: 1,
            view_intent: intent(1),
            soul_intent_revision: 1,
            event_kind: "view_intent.changed".into(),
            created_at: 1,
        };
        assert!(!store.apply_event(&stale).await.unwrap());
        assert_eq!(store.snapshot().await.views["view-test"].revision, 2);
        let reopened = ManagedViewProjectionStore::open(Some(path)).unwrap();
        assert_eq!(reopened.snapshot().await.views["view-test"].revision, 2);
    }

    #[test]
    fn mutations_require_a_correlation_request_id() {
        assert!(mutation_request_id(None).is_err());
        assert!(mutation_request_id(Some(String::new())).is_err());
        assert_eq!(
            mutation_request_id(Some("request-ui-save-1".into()))
                .unwrap()
                .as_str(),
            "request-ui-save-1"
        );
    }

    #[test]
    fn stale_projection_cannot_recreate_a_stopped_soul() {
        let mut current_intent = intent(4);
        current_intent.soul_intent_revision = 4;
        current_intent.visibility = ViewVisibilityIntent::Hidden;
        let mut stopped = snapshot(4, current_intent);
        stopped.souls.push(RuntimeView {
            native_identity_observation: None,
            soul_id: SoulId::parse("soul-test").unwrap(),
            incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
            launch_state: freshell_runtime_protocol::LaunchState::Stopped,
            cleanup_state: freshell_runtime_protocol::CleanupState::VerifiedEmpty,
            intent_revision: 4,
            container_id: None,
            host_boot_id: None,
            execution_generation: 1,
            effective_limits: None,
            configured_limits: None,
            view_intent_revision: Some(4),
            terminal_id: Some("terminal-test".into()),
            terminal_stream_id: Some("stream-test".into()),
            terminal_mode: Some("opencode".into()),
            terminal_cwd: Some("/workspace".into()),
            terminal_create_request_id: Some("create-test".into()),
            terminal_resume_session_id: Some("ses_test".into()),
            fresh_agent_session_id: None,
            fresh_agent_create_request_id: None,
            fresh_agent_session_type: None,
            fresh_agent_runtime_variant: None,
            fresh_agent_recovery: None,
            project_key: Some("workspace".into()),
            profile: Some(freshell_runtime_protocol::RuntimeProfile::DefaultAgent),
            desired_state: DesiredState::Stopped,
            recovery_state: freshell_runtime_protocol::RecoveryState::Stopped,
            durability_state: freshell_runtime_protocol::DurabilityState::ResumeCaptured,
            allocation_state: freshell_runtime_protocol::AllocationState::VerifiedDurable,
            provider: Some("opencode".into()),
            native_session_id: Some("ses_test".into()),
            recovery_reason: Some("STOP_INTENT".into()),
            incident_id: None,
            prior_incarnation_id: None,
            recovery_attempt_id: None,
            evidence_revision: 1,
            successful_recoveries_in_window: 0,
        });
        let event = ViewProjectionEvent {
            event_id: ProjectionEventId::parse("projection-old").unwrap(),
            event_kind: "view_intent.changed".into(),
            view_intent: intent(3),
            soul_intent_revision: 1,
            inventory_revision: 2,
            created_at: 2,
        };
        assert!(!projection_event_is_current(&stopped, &event));
    }
}

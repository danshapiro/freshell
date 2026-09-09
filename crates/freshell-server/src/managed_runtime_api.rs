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
use freshell_runtime_client::{ClientError, RuntimeClient};
use freshell_runtime_protocol::{
    DesiredState, IncidentId, ManagedRolloutMode, MigrationPlanRequest, NoticeDeliveryState,
    NoticeId, RecoveryTrigger, RequestId, RuntimeInventorySnapshot, RuntimeLimits, RuntimeView,
    SoulId, UpdateViewVisibilityRequest, UpsertViewIntentRequest, ViewIntent, ViewIntentId,
    ViewIntentRequest, ViewProjectionEvent, ViewVisibilityIntent,
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
    projection_store: ManagedViewProjectionStore,
    pane_ledger: Arc<PaneLedger>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
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
            projection_store: ManagedViewProjectionStore::open(projection_path)?,
            pane_ledger,
            broadcast_tx,
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
        .route("/api/runtime/souls", get(list_souls))
        .route("/api/runtime/souls/{soul_id}", get(get_soul))
        .route("/api/runtime/souls/{soul_id}/retry", post(retry_soul))
        .route("/api/runtime/souls/{soul_id}/stop", post(stop_soul))
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
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(response) => return response,
    };
    match client.inventory_snapshot().await {
        Ok(snapshot) => Json(json!({
            "revision": snapshot.revision,
            "readiness": snapshot.readiness,
            "pendingProjectionCount": snapshot.pending_projection_count,
        }))
        .into_response(),
        Err(error) => client_error(error),
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
    };
    match client
        .recover_expected_with_request_id(
            request_id,
            soul,
            RecoveryTrigger::ManualRetry,
            Some(revision),
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
    };
    let notice_id = match NoticeId::parse(raw) {
        Ok(notice_id) => notice_id,
        Err(error) => return bad_request(error.to_string()),
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(response) => return response,
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
        Err(response) => return response,
    };
    let client = match runtime_client(&state) {
        Ok(client) => client,
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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
        Err(response) => return response,
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

fn mutation_request_id(raw: Option<String>) -> Result<RequestId, Response> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Err(bad_request("requestId is required"));
    };
    RequestId::parse(raw).map_err(|error| bad_request(error.to_string()))
}

fn runtime_client(state: &ManagedRuntimeApiState) -> Result<RuntimeClient, Response> {
    state.client.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Managed runtime unavailable"})),
        )
            .into_response()
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
mod tests {
    use super::*;
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

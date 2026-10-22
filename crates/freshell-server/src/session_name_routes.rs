//! Unified agent names (Task 2): the canonical session-name HTTP surface —
//! `POST /api/session-names/read` and `PATCH /api/session-names` — plus the
//! shared helpers the convenience routes (session/terminal/pane/tab) and the
//! read projections (directory/resolve/terminal inventory) use, so EVERY
//! surface resolves the same `rename` call and the same canonical record.
//!
//! Ownership: the authority is the ONE `SessionNames` store constructed in
//! `main.rs` BEFORE publication; every mutation path lands in the store's
//! guarded current-document transaction (see `session_names.rs`), and
//! commits publish `session.name.updated` through the wired publisher — a
//! route response is the accepted update, never a second name authority.
//!
//! Error policy (plan "Name acceptance, storage, and publication"): every
//! error path logs STRUCTURED severity/operation/name-reference/revision/
//! failure-class JSONL (inline `tracing::warn!` under this crate's own
//! target — `tracing` is this server's JSONL channel) and answers the mapped
//! HTTP status with the stable machine-readable `NameError::code()`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use freshell_freshagent::naming::{
    name_ref_debug_key, NameError, RenameNameInput, SessionNaming, NAME_RESET_UNSUPPORTED,
};
use freshell_protocol::session_names::{
    LegacyNameImport, NameIntent, RenameSessionNameRequest, SessionNameRef, MAX_NAME_REVISION,
};
use freshell_ws::identity::TerminalIdentityRegistry;

use crate::boot::{is_authed, unauthorized};
use crate::session_name_migration::resolve_terminal_identity;
use crate::session_names::{
    is_boot_import_id, SessionNames, NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT,
};

/// Client batch reads are chunked to this many references per request (plan
/// rule 9 / the route contract).
pub(crate) const READ_CHUNK_LIMIT: usize = 100;

/// Shared state for the session-names sub-router.
#[derive(Clone)]
pub struct SessionNamesState {
    pub auth_token: Arc<String>,
    /// The ONE durable name authority, constructed in `main.rs` before
    /// publication and shared with every other surface's wiring.
    pub names: Arc<SessionNames>,
    /// Task 7: the identity ledger resolves `legacy_terminal` import targets
    /// (live and retired entries) before the store sees them; unresolved
    /// ones stay recovery-only.
    pub identity: TerminalIdentityRegistry,
    /// Name-reliability Task 4: the session index, the best-known folder of
    /// a session-key rename target. `None` when no provider home resolves.
    pub index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
}

/// The session-names sub-router (`POST /api/session-names/read` +
/// `PATCH /api/session-names` + Task 7's `POST /api/session-names/import`).
pub fn router(state: SessionNamesState) -> Router {
    Router::new()
        .route("/api/session-names/read", post(read_session_names))
        .route("/api/session-names", patch(rename_session_name))
        .route("/api/session-names/import", post(import_legacy_names))
        .with_state(state)
}

/// Map a store error onto the route wire shape: the mapped HTTP status (the
/// plan's 400/404/409/409/503/503/503) plus the stable machine-readable
/// code, with the structured JSONL error log already emitted by the caller.
pub(crate) fn name_error_response(error: &NameError, target: &SessionNameRef) -> Response {
    let status =
        StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let conflict_current = if let NameError::Conflict { current, .. } = error {
        current.clone()
    } else {
        None
    };
    let mut body = json!({
        "error": error.code(),
        "message": error.to_string(),
        "nameRef": target,
    });
    if let Some(current) = conflict_current {
        // The accepted record the editor should surface instead of an
        // invisible overwrite (plan rule 4).
        body["sessionName"] = serde_json::to_value(&current).unwrap_or(Value::Null);
        body["nameRef"] = serde_json::to_value(&current.name_ref).unwrap_or(Value::Null);
    }
    (status, Json(body)).into_response()
}

/// The shared scoped-rename drive every convenience route funnels into —
/// the ONE `rename` call with the intent default (`automatic`: an agent
/// suggestion never acquires a user rename's permanence) and the optional
/// `ifRevision` compare-and-set. `cwd` is the target's best-known folder
/// (name-reliability Task 4: an automation rename to it is refused as a
/// derived label). Returns the accepted update — carrying the rename's
/// `outcome` — or the mapped error response (with the structured error log
/// already emitted).
pub(crate) async fn rename_through_authority(
    sink: &dyn SessionNaming,
    target: SessionNameRef,
    name: String,
    intent: NameIntent,
    if_revision: Option<u64>,
    cwd: Option<String>,
) -> Result<freshell_protocol::session_names::SessionNameUpdate, Response> {
    match sink
        .rename(RenameNameInput {
            target: target.clone(),
            name,
            intent,
            if_revision,
            cwd,
        })
        .await
    {
        Ok(update) => Ok(update),
        Err(error) => {
            // Structured failure log under this server's own target
            // (`tracing` macro targets must be literals).
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "rename",
                name_ref = %name_ref_debug_key(&target),
                revision = error.log_revision(),
                class = %error.code(),
                "session_names.operation_failed: {error}"
            );
            Err(name_error_response(&error, &target))
        }
    }
}

/// Name-reliability Task 4 (LB-B8): the best-known folder of a rename
/// target. A session target reads its session index row (the published
/// snapshot only — a rename never waits on an index sweep); otherwise, or
/// when the index has no row, a terminal row bound to the target (the
/// identity table keeps the cwd of live and exited terminals). `None` when
/// nothing knows the folder: the rename then recognizes folder-free labels
/// only.
pub(crate) fn rename_target_cwd(
    target: &SessionNameRef,
    identity: &TerminalIdentityRegistry,
    index: Option<&freshell_sessions::directory_index::SessionIndex>,
) -> Option<String> {
    if let SessionNameRef::Session {
        provider,
        session_id,
    } = target
    {
        let indexed = index
            .and_then(|index| index.peek())
            .and_then(|items| {
                items
                    .iter()
                    .find(|row| row.provider == provider.as_str() && &row.session_id == session_id)
                    .and_then(|row| row.cwd.clone())
            })
            .filter(|cwd| !cwd.trim().is_empty());
        if indexed.is_some() {
            return indexed;
        }
        if let Some(cwd) = identity
            .find_all_by_session(provider.as_str(), session_id, None)
            .into_iter()
            .find_map(|row| row.cwd.filter(|cwd| !cwd.trim().is_empty()))
        {
            return Some(cwd);
        }
    }
    identity
        .list()
        .into_iter()
        .filter(|row| row.name_ref.as_ref() == Some(target))
        .find_map(|row| row.cwd.filter(|cwd| !cwd.trim().is_empty()))
}

/// Name-reliability Task 4 (LB-B8): a terminal's best-known folder — the
/// live registry row, else the identity row (which survives the terminal's
/// exit).
pub(crate) fn terminal_row_cwd(
    registry: &freshell_terminal::TerminalRegistry,
    identity: &TerminalIdentityRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .probe(terminal_id)
        .and_then(|row| row.cwd)
        .or_else(|| identity.get(terminal_id).and_then(|row| row.cwd))
        .filter(|cwd| !cwd.trim().is_empty())
}

/// Parse the rename-intent fields a convenience route may carry alongside
/// its legacy body: `nameIntent` (`user` | `automatic`, default automatic
/// when omitted) and `ifRevision` (compare-and-set, JS-safe ceiling).
/// Delta-review round 3, finding 8: an UNKNOWN `nameIntent` string is a
/// loud 400 (via [`Err`]), matching the canonical PATCH route's serde
/// rejection and the CLI/MCP argument gates — never a silent default to
/// `automatic`, which would quietly strip an intended rename's permanence
/// behind a typo. The safe direction is preserved either way: rejection
/// forces the caller to state the intent correctly.
/// Delta-review round 4, finding 3: a malformed `ifRevision` (a
/// non-integer, a negative, a boolean, or a number beyond the JS-safe
/// ceiling) is the SAME loud 400 — it used to be silently dropped, which
/// degraded the compare-and-set guard to an unguarded rename. Omitted or
/// `null` stays "no CAS"; a valid integer within the ceiling is honored.
pub(crate) fn parse_rename_intents(body: &Value) -> Result<(NameIntent, Option<u64>), String> {
    let intent = match body.get("nameIntent") {
        None | Some(Value::Null) => NameIntent::Automatic,
        Some(Value::String(text)) => match text.as_str() {
            "user" => NameIntent::User,
            "automatic" => NameIntent::Automatic,
            other => {
                return Err(format!(
                    "nameIntent must be \"user\" or \"automatic\", got {other:?}"
                ))
            }
        },
        Some(other) => {
            return Err(format!(
                "nameIntent must be \"user\" or \"automatic\", got {other}"
            ))
        }
    };
    let if_revision = match body.get("ifRevision") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => {
            let revision = number.as_u64().filter(|r| *r <= MAX_NAME_REVISION);
            match revision {
                Some(revision) => Some(revision),
                None => {
                    return Err(format!(
                        "ifRevision must be an integer within the JS-safe range (0..={MAX_NAME_REVISION}), got {number}"
                    ))
                }
            }
        }
        Some(other) => {
            return Err(format!(
                "ifRevision must be an integer within the JS-safe range (0..={MAX_NAME_REVISION}), got {other}"
            ))
        }
    };
    Ok((intent, if_revision))
}

/// `POST /api/session-names/read {refs}` → `{names: [SessionNameUpdate]}`.
/// Adopts the current document first (the common full-document refresh path
/// before name-dependent reads), then resolves the requested refs — unknown
/// refs are omitted (plan rule 7). A body naming more than
/// [`READ_CHUNK_LIMIT`] refs is a 400 (the client chunks).
async fn read_session_names(
    State(state): State<SessionNamesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(refs) = body.get("refs").and_then(Value::as_array) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": "refs array is required" })),
        )
            .into_response();
    };
    if refs.len() > READ_CHUNK_LIMIT {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Invalid request",
                "details": format!("refs must be chunked to at most {READ_CHUNK_LIMIT} references per request")
            })),
        )
            .into_response();
    }
    let mut targets: Vec<SessionNameRef> = Vec::with_capacity(refs.len());
    for raw in refs {
        match serde_json::from_value::<SessionNameRef>(raw.clone()) {
            Ok(target) => targets.push(target),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "Invalid request",
                        "details": format!("invalid SessionNameRef: {raw}")
                    })),
                )
                    .into_response();
            }
        }
    }
    // The common full-document adoption path before the name-dependent read:
    // a same-home cooperating process's commits (the 2s tick's own refresh)
    // are adopted here too, so a CLI/MCP read reflects current state without
    // polling. Adoption failures degrade to the last established snapshot
    // (the read still answers from it), loudly logged.
    if let Err(error) = state.names.refresh_current().await {
        tracing::warn!(
            target: "freshell_server::session_names",
            op = "refresh_current",
            name_ref = "-",
            revision = 0,
            class = %error.code(),
            "session_names.operation_failed: {error}"
        );
    }
    match state.names.get(targets).await {
        Ok(updates) => Json(json!({ "names": updates })).into_response(),
        Err(error) => {
            // `get` has no single target to name; log per the read's shape.
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "get",
                name_ref = "-",
                revision = 0,
                class = %error.code(),
                "session_names.operation_failed: {}",
                error
            );
            name_error_response(
                &NameError::Persistence(error.to_string()),
                &SessionNameRef::Pending { id: "-".into() },
            )
        }
    }
}

/// `PATCH /api/session-names` with `RenameSessionNameRequest` → the accepted
/// `SessionNameUpdate`. Omitted `nameIntent` defaults to `automatic`; a
/// scoped null/reset never clears a protected name through ANY route — the
/// dedicated reset control is gone (the route answers
/// [`NAME_RESET_UNSUPPORTED`] for a blank name).
async fn rename_session_name(
    State(state): State<SessionNamesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request: RenameSessionNameRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid request",
                    "details": format!("invalid RenameSessionNameRequest: {error}")
                })),
            )
                .into_response();
        }
    };
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": NAME_RESET_UNSUPPORTED,
                "message": "a scoped session's saved name is never cleared; rename it instead",
                "nameRef": request.target,
            })),
        )
            .into_response();
    }
    let target = request.target.clone();
    let intent = request.name_intent.unwrap_or(NameIntent::Automatic);
    let cwd = rename_target_cwd(&target, &state.identity, state.index.as_deref());
    match rename_through_authority(
        &*state.names,
        target,
        name,
        intent,
        request.if_revision,
        cwd,
    )
    .await
    {
        Ok(update) => Json(serde_json::to_value(&update).unwrap_or(Value::Null)).into_response(),
        Err(response) => response,
    }
}

/// Task 7: `POST /api/session-names/import` with the migration envelope →
/// `{acknowledged: string[], names: SessionNameUpdate[]}`. Per-candidate
/// acknowledgment only after the import's immutable backup and the canonical
/// commit (never an early whole-import shortcut). The reserved boot import
/// id FAMILY (`server-boot-v1` and its `--N` chunk derivations) is refused
/// here — the untrusted HTTP lane can never honor `explicit_rename`
/// (manual) or accepted-Freshell-AI classifications.
/// `legacy_terminal` targets resolve through the identity ledger first;
/// unresolved ones stay recovery-only.
async fn import_legacy_names(
    State(state): State<SessionNamesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let mut import: LegacyNameImport = match serde_json::from_value(body) {
        Ok(import) => import,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid request",
                    "details": format!("invalid LegacyNameImport: {error}")
                })),
            )
                .into_response();
        }
    };
    if is_boot_import_id(&import.import_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Invalid request",
                "details": "the server-boot import id is reserved"
            })),
        )
            .into_response();
    }
    if import.candidates.len() > NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Invalid request",
                "details": format!(
                    "a legacy-name import batches at most {NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT} candidates"
                )
            })),
        )
            .into_response();
    }
    // Resolve legacy terminal targets through the identity ledger (the
    // composition boundary); the unresolved stay recovery-only in the store.
    for candidate in &mut import.candidates {
        if let freshell_protocol::session_names::LegacyNameTarget::LegacyTerminal {
            terminal_id,
            ..
        } = &candidate.target
        {
            if let Some(resolved) = resolve_terminal_identity(&state.identity, terminal_id) {
                candidate.target =
                    freshell_protocol::session_names::LegacyNameTarget::Canonical(resolved);
            }
        }
    }
    match state.names.import_legacy(import).await {
        Ok(result) => Json(serde_json::to_value(&result).unwrap_or(Value::Null)).into_response(),
        Err(error) => {
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "import_legacy",
                name_ref = "-",
                revision = 0,
                class = %error.code(),
                "session_names.operation_failed: {error}"
            );
            name_error_response(&error, &SessionNameRef::Pending { id: "-".into() })
        }
    }
}

#[cfg(test)]
#[path = "session_name_routes_tests.rs"]
mod tests;

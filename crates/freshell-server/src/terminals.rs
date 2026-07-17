//! `/api/terminals` — the terminal directory REST surface, ported from
//! `server/terminals-router.ts` + `server/terminal-view/service.ts`:
//!
//! * `GET /api/terminals` (no read-model query) → `listTerminalDirectory()`:
//!   every live terminal, `config.terminalOverrides` merged (title/description
//!   overrides applied, `deleted` filtered out), `lastLine`/`last_line` extracted
//!   from the scrollback tail, sorted `lastActivityAt` desc then `terminalId` desc.
//! * `GET /api/terminals?cursor/priority/revision/limit` → the paged read-model
//!   directory (`getTerminalDirectoryPage`): zod-validated query (exact zod v4
//!   issue objects on 400), keyset cursor (base64url `{lastActivityAt,terminalId}`),
//!   `{items, nextCursor, revision}` page shape.
//! * `PATCH /api/terminals/{id}` → `TerminalPatchSchema` body, `cleanString`
//!   normalization, `configStore.patchTerminalOverride` JS-spread merge (see
//!   `SettingsStore::patch_terminal_override`), registry title/description
//!   write-through, `terminals.changed` broadcast, merged override as response.
//! * `DELETE /api/terminals/{id}` → `patchTerminalOverride(id, {deleted:true})`
//!   (single-key patch — other override keys survive), broadcast, `{ok:true}`.
//!
//! * `GET /api/terminals/{id}/search` (task-005f, PORT-GAP-002 condition) —
//!   `terminalViewService.searchTerminal` + `TerminalViewMirror.search`
//!   (`terminal-view/mirror.ts:111-134`): the mirror's logical-line model is
//!   the terminal's raw output normalized (`\r\n`→`\n`, bare `\r` dropped, CSI
//!   escapes stripped) and split on `\n`; matching is per-line lowercased
//!   `indexOf` (column = UTF-16 units into the LOWERCASED line), `limit`
//!   default 50, `nextCursor = String(lastMatchLine+1)` while more lines
//!   remain. JS quirks replicated byte-for-byte from live probes (2026-07-12,
//!   `~/freshell-scratch-005e/search-truth-orig.json`): `Number(cursor)`
//!   coercion (`"abc"`→NaN→empty page, `" "`→0, `"0x5"`/`"1e1"`/`"+5"`/`"5.0"`
//!   numeric, `"-0"`→0), and NEGATIVE/FRACTIONAL cursors reproduce the
//!   original's 500 `{"error":"Cannot read properties of undefined (reading
//!   'toLowerCase')"}` (`this.lines[-3]` is `undefined`). zod validation
//!   (outer route parse + `TerminalSearchQuerySchema`) with exact zod-v4 issue
//!   shapes/order.
//!
//! ## Deliberately NOT ported here (recorded in the parity ledger)
//!
//! * `GET /:id/viewport|scrollback` — backed by the original's
//!   `TerminalViewMirror` viewport state. NO production callers (SPA uses only
//!   the search subroute) — YAGNI per the council adjudication of PORT-GAP-002;
//!   axum answers 404 for these two subroutes (pinned in the sweep).
//! * The CLI-session rename cascade (`cascadeTerminalRenameToSession`): the Rust
//!   server has no terminal-metadata service yet (CLI panes land with the argv
//!   fidelity task); a PATCH title still write-throughs to the registry.
//!
//! ## Auth
//!
//! Same `httpAuthMiddleware` gate as every `/api/*` route (`is_authed`).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch},
    Json, Router,
};
use base64::Engine;
use freshell_protocol::TerminalRunStatus;
use freshell_terminal::TerminalRegistry;
use freshell_ws::identity::TerminalIdentityRegistry;
use serde_json::{json, Map, Value};

use crate::boot::{is_authed, unauthorized};
use crate::settings_store::SettingsStore;

/// `MAX_DIRECTORY_PAGE_ITEMS` (`shared/read-models.ts:6`).
const MAX_DIRECTORY_PAGE_ITEMS: i64 = 50;
/// `MAX_LAST_LINE_CHARS` (`terminal-view/service.ts:84`) — UTF-16 code units.
const MAX_LAST_LINE_CHARS: usize = 500;
/// `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH` (`terminals-router.ts:24`).
const MAX_TITLE_OVERRIDE_LEN: usize = 500;
const MAX_DESCRIPTION_OVERRIDE_LEN: usize = 2000;

/// Shared, cheaply-cloneable state for the terminals REST surface.
#[derive(Clone)]
pub struct TerminalsState {
    pub auth_token: Arc<String>,
    /// Live settings store — owns `config.terminalOverrides` (read + patch).
    pub settings: SettingsStore,
    /// The shared terminal registry (the directory's base records).
    pub registry: TerminalRegistry,
    /// The server→client broadcast bus (pre-serialized frames) for
    /// `terminals.changed` after a PATCH/DELETE (`ws-handler.ts:3670-3679`).
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// `WsHandler.terminalsRevision` — the ws-handler-scoped monotonic counter
    /// stamped on each `terminals.changed` broadcast (starts 0, `+1` per send).
    pub terminals_revision: Arc<AtomicI64>,
    /// Fix Spec: Session Naming Cluster (SYMPTOM 2a) — the shared terminal
    /// identity registry (`freshell_ws::identity`), read here to cascade a
    /// terminal-title rename to its coding-CLI session override
    /// (`cascadeTerminalRenameToSession`, `rename-cascade.ts:23-32`). `get()`
    /// (not `list()`) so the cascade still resolves on an ALREADY-EXITED
    /// terminal, matching `terminalMetadata.get?.(terminalId) ??
    /// .list().find(...)` (`terminals-router.ts:311-312`).
    pub identity: TerminalIdentityRegistry,
}

/// The terminals REST sub-router, pre-bound to its state (mergeable into the app).
pub fn router(state: TerminalsState) -> Router {
    Router::new()
        .route("/api/terminals", get(list_terminals))
        .route(
            "/api/terminals/{terminal_id}",
            patch(patch_terminal).delete(delete_terminal),
        )
        .route("/api/terminals/{terminal_id}/search", get(search_terminal))
        .with_state(state)
}

// ── GET / ──────────────────────────────────────────────────────────────────

/// One query param as express sees it: `typeof req.query.x === 'string'` is only
/// true when the param appears exactly once (a repeated param is an array →
/// treated as `undefined` by the router's ternaries, but still *present* for the
/// `hasReadModelQuery` check).
struct QueryParam {
    present: bool,
    value: Option<String>,
}

fn query_param(pairs: &[(String, String)], key: &str) -> QueryParam {
    let values: Vec<&String> = pairs
        .iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v)
        .collect();
    QueryParam {
        present: !values.is_empty(),
        value: if values.len() == 1 {
            Some(values[0].clone())
        } else {
            None
        },
    }
}

/// `Number(str)` for a query param (`terminals-router.ts:106-107`): empty/whitespace
/// → 0, else a float parse; unparseable → NaN.
fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // JS also accepts 0x/0o/0b literals; the SPA never sends them but parity is cheap.
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16)
            .map(|v| v as f64)
            .unwrap_or(f64::NAN);
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

// ── GET /{id}/search ────────────────────────────────────────────────────────

/// `GET /api/terminals/{id}/search` (`terminals-router.ts:229-286` +
/// `TerminalViewMirror.search`). Validation → 404 → mirror search; every
/// status/body byte-matched against the live original (probe battery
/// 2026-07-12).
async fn search_terminal(
    State(state): State<TerminalsState>,
    AxumPath(terminal_id): AxumPath<String>,
    headers: HeaderMap,
    Query(pairs): Query<Vec<(String, String)>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let query = query_param(&pairs, "query").value;
    let cursor = query_param(&pairs, "cursor").value;
    let limit_raw = query_param(&pairs, "limit").value;

    // OUTER route parse (`z.coerce.number()` on `limit`): the only outer
    // failure a non-empty path segment allows is a NaN limit. On outer
    // failure the INNER schema re-runs with ALL-undefined inputs and the
    // issue arrays are CONCATENATED (`terminals-router.ts:248-254`).
    let limit_num = limit_raw.as_deref().map(js_number);
    if let Some(v) = limit_num {
        if v.is_nan() {
            let details = json!([
                {
                    "expected": "number",
                    "code": "invalid_type",
                    "received": "NaN",
                    "path": ["limit"],
                    "message": "Invalid input: expected number, received NaN",
                },
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["query"],
                    "message": "Invalid input: expected string, received undefined",
                },
            ]);
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid request", "details": details })),
            )
                .into_response();
        }
    }

    // INNER `TerminalSearchQuerySchema` (`shared/read-models.ts:111-115`):
    // issues aggregate in schema field order query → cursor → limit; per
    // field the FIRST failing check wins (live: `-1.5` yields ONLY the
    // int/safeint issue; `-5` yields ONLY too_small).
    let mut issues: Vec<Value> = Vec::new();
    match query.as_deref() {
        None => issues.push(json!({
            "expected": "string",
            "code": "invalid_type",
            "path": ["query"],
            "message": "Invalid input: expected string, received undefined",
        })),
        Some("") => issues.push(json!({
            "origin": "string",
            "code": "too_small",
            "minimum": 1,
            "inclusive": true,
            "path": ["query"],
            "message": "Too small: expected string to have >=1 characters",
        })),
        Some(_) => {}
    }
    if cursor.as_deref() == Some("") {
        issues.push(json!({
            "origin": "string",
            "code": "too_small",
            "minimum": 1,
            "inclusive": true,
            "path": ["cursor"],
            "message": "Too small: expected string to have >=1 characters",
        }));
    }
    if let Some(v) = limit_num {
        const MAX_SAFE: f64 = 9007199254740991.0;
        if v.fract() != 0.0 || v.abs() > MAX_SAFE {
            issues.push(json!({
                "expected": "int",
                "format": "safeint",
                "code": "invalid_type",
                "path": ["limit"],
                "message": "Invalid input: expected int, received number",
            }));
        } else if v <= 0.0 {
            issues.push(json!({
                "origin": "number",
                "code": "too_small",
                "minimum": 0,
                "inclusive": false,
                "path": ["limit"],
                "message": "Too small: expected number to be >0",
            }));
        } else if v > 200.0 {
            issues.push(json!({
                "origin": "number",
                "code": "too_big",
                "maximum": 200,
                "inclusive": true,
                "path": ["limit"],
                "message": "Too big: expected number to be <=200",
            }));
        }
    }
    if !issues.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": issues })),
        )
            .into_response();
    }

    // `registry.get(terminalId)` — exited-but-undeleted terminals stay
    // registered and searchable; only an unknown id is 404.
    let Some(entry) = state
        .registry
        .directory()
        .into_iter()
        .find(|e| e.terminal_id == terminal_id)
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Terminal not found" })),
        )
            .into_response();
    };

    let lines = mirror_lines(&entry.snapshot);
    let cursor_val = cursor.as_deref().map(js_number).unwrap_or(0.0);
    let limit_val = limit_num.map(|v| v as usize).unwrap_or(50);
    match mirror_search(&lines, &query.unwrap_or_default(), cursor_val, limit_val) {
        Ok(page) => Json(page).into_response(),
        Err(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": message })),
        )
            .into_response(),
    }
}

/// The mirror's logical-line model (`TerminalViewMirror`): raw output
/// normalized (`\r\n`→`\n`, bare `\r` removed, CSI escapes stripped —
/// `mirror.ts:9-16`; note this is CSI-ONLY, unlike `lastEmittedLine`'s wider
/// strip) and split on `\n` (lines start `['']` + `appendLines` ==
/// `split('\n')` of the concatenation).
fn mirror_lines(snapshot: &str) -> Vec<String> {
    let no_cr = snapshot.replace("\r\n", "\n").replace('\r', "");
    strip_csi_escapes(&no_cr)
        .split('\n')
        .map(str::to_string)
        .collect()
}

/// `/\u001B\[[0-9;?]*[ -\/]*[@-~]/gu` (`mirror.ts:9`): a CSI sequence is ESC
/// `[`, then `[0-9;?]*` params, `[ -/]*` intermediates, and a REQUIRED final
/// `[@-~]`. An incomplete sequence does not match (the regex leaves the raw
/// bytes in place) — replicated by emitting the ESC and rescanning from `[`.
fn strip_csi_escapes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1B}' && i + 1 < chars.len() && chars[i + 1] == '[' {
            let mut j = i + 2;
            while j < chars.len() && matches!(chars[j], '0'..='9' | ';' | '?') {
                j += 1;
            }
            while j < chars.len() && (' '..='/').contains(&chars[j]) {
                j += 1;
            }
            if j < chars.len() && ('@'..='~').contains(&chars[j]) {
                i = j + 1; // full CSI match — drop it
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `TerminalViewMirror.search` (`mirror.ts:111-134`) with JS array/loop
/// semantics preserved: `for (let i = cursor; i < lines.length; i += 1)` where
/// `cursor = Number(cursorParam)`. NaN/`+Infinity` never enter the loop (empty
/// page); NEGATIVE or FRACTIONAL indices make `this.lines[i]` `undefined`, so
/// the original throws the TypeError the route surfaces as a 500 — replicated
/// byte-for-byte. `column` counts UTF-16 units into the LOWERCASED line
/// (`line.toLowerCase().indexOf(query.toLowerCase())`), while `text` is the
/// original line.
fn mirror_search(
    lines: &[String],
    query: &str,
    cursor: f64,
    limit: usize,
) -> Result<Value, String> {
    let needle = query.to_lowercase();
    let mut matches: Vec<Value> = Vec::new();
    let mut last_line: Option<usize> = None;

    let mut i = cursor;
    while i < lines.len() as f64 {
        if matches.len() >= limit {
            break;
        }
        // JS `lines[i]`: only a non-negative integer index (incl. `-0`) is a
        // real element; anything else is `undefined` → TypeError.
        if i < 0.0 || i.fract() != 0.0 {
            return Err("Cannot read properties of undefined (reading 'toLowerCase')".to_string());
        }
        let idx = i as usize;
        let line = &lines[idx];
        let lower = line.to_lowercase();
        if let Some(byte_pos) = lower.find(&needle) {
            let column = lower[..byte_pos].encode_utf16().count();
            matches.push(json!({ "line": idx, "column": column, "text": line }));
            last_line = Some(idx);
        }
        i += 1.0;
    }

    let next_cursor = match last_line {
        Some(l) if l + 1 < lines.len() => Value::String((l + 1).to_string()),
        _ => Value::Null,
    };
    Ok(json!({ "matches": matches, "nextCursor": next_cursor }))
}

async fn list_terminals(
    State(state): State<TerminalsState>,
    headers: HeaderMap,
    Query(pairs): Query<Vec<(String, String)>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let cursor = query_param(&pairs, "cursor");
    let priority = query_param(&pairs, "priority");
    let revision = query_param(&pairs, "revision");
    let limit = query_param(&pairs, "limit");

    let has_read_model_query =
        cursor.present || priority.present || revision.present || limit.present;

    let items = directory_items(&state).await;

    if !has_read_model_query {
        return Json(Value::Array(items)).into_response();
    }

    // ── the paged read-model branch (`TerminalDirectoryQuerySchema`) ──
    let mut issues: Vec<Value> = Vec::new();
    if let Some(c) = &cursor.value {
        if c.is_empty() {
            issues.push(json!({
                "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
                "path": ["cursor"],
                "message": "Too small: expected string to have >=1 characters"
            }));
        }
    }
    // `priority: ReadModelPrioritySchema` is REQUIRED (no `.optional()`), so a paged
    // query without a (single, valid) priority is a 400.
    match priority.value.as_deref() {
        Some("visible") | Some("background") => {}
        _ => issues.push(json!({
            "code": "invalid_value", "values": ["visible", "background"],
            "path": ["priority"],
            "message": "Invalid option: expected one of \"visible\"|\"background\""
        })),
    }
    if let Some(r) = &revision.value {
        issues.extend(number_issues(
            js_number(r),
            "revision",
            NumberRule::NonNegativeInt,
        ));
    }
    let mut limit_num: Option<f64> = None;
    if let Some(l) = &limit.value {
        let n = js_number(l);
        let errs = number_issues(n, "limit", NumberRule::PositiveIntMax50);
        if errs.is_empty() {
            limit_num = Some(n);
        }
        issues.extend(errs);
    }
    if !issues.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": issues })),
        )
            .into_response();
    }

    // `getTerminalDirectoryPage`: revision = max lastActivityAt over ALL items
    // (before cursor filtering), 0 when empty.
    let revision_out = items
        .iter()
        .filter_map(|i| i.get("lastActivityAt").and_then(Value::as_i64))
        .max()
        .unwrap_or(0);

    let cursor_payload = match cursor.value.as_deref() {
        None => None,
        Some(c) => match decode_cursor(c) {
            Ok(p) => Some(p),
            Err(()) => {
                // `decodeCursor` throws 'Invalid terminal-directory cursor'; the route's
                // catch maps /cursor/i → 400 with the bare error message.
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "Invalid terminal-directory cursor" })),
                )
                    .into_response();
            }
        },
    };

    let filtered: Vec<&Value> = match &cursor_payload {
        None => items.iter().collect(),
        Some((cur_activity, cur_id)) => items
            .iter()
            .filter(|item| {
                let a = item
                    .get("lastActivityAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let id = item.get("terminalId").and_then(Value::as_str).unwrap_or("");
                a < *cur_activity || (a == *cur_activity && id < cur_id.as_str())
            })
            .collect(),
    };

    let limit_eff = limit_num
        .map(|n| n as i64)
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS) as usize;
    let page_items: Vec<Value> = filtered
        .iter()
        .take(limit_eff)
        .map(|v| (*v).clone())
        .collect();
    let next_cursor: Value = if filtered.len() > limit_eff {
        match page_items.last() {
            Some(tail) => Value::String(encode_cursor(
                tail.get("lastActivityAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                tail.get("terminalId").and_then(Value::as_str).unwrap_or(""),
            )),
            None => Value::Null,
        }
    } else {
        Value::Null
    };

    Json(json!({
        "items": page_items,
        "nextCursor": next_cursor,
        "revision": revision_out,
    }))
    .into_response()
}

/// Which zod number pipeline to replicate (`shared/read-models.ts:70-75`).
enum NumberRule {
    /// `z.number().int().nonnegative()` (revision)
    NonNegativeInt,
    /// `z.number().int().positive().max(50)` (limit)
    PositiveIntMax50,
}

/// The exact zod v4 issues for one numeric query param (ground truth captured
/// from the live original schema — see the module tests).
fn number_issues(n: f64, key: &str, rule: NumberRule) -> Vec<Value> {
    if n.is_nan() {
        return vec![json!({
            "expected": "number", "code": "invalid_type", "received": "NaN",
            "path": [key], "message": "Invalid input: expected number, received NaN"
        })];
    }
    if n.is_infinite() {
        return vec![json!({
            "expected": "number", "code": "invalid_type", "received": "Infinity",
            "path": [key], "message": "Invalid input: expected number, received number"
        })];
    }
    if n.fract() != 0.0 || n.abs() > 9007199254740991.0 {
        return vec![json!({
            "expected": "int", "format": "safeint", "code": "invalid_type",
            "path": [key], "message": "Invalid input: expected int, received number"
        })];
    }
    match rule {
        NumberRule::NonNegativeInt => {
            if n < 0.0 {
                return vec![json!({
                    "origin": "number", "code": "too_small", "minimum": 0, "inclusive": true,
                    "path": [key], "message": "Too small: expected number to be >=0"
                })];
            }
        }
        NumberRule::PositiveIntMax50 => {
            if n <= 0.0 {
                return vec![json!({
                    "origin": "number", "code": "too_small", "minimum": 0, "inclusive": false,
                    "path": [key], "message": "Too small: expected number to be >0"
                })];
            }
            if n > 50.0 {
                return vec![json!({
                    "origin": "number", "code": "too_big", "maximum": 50, "inclusive": true,
                    "path": [key], "message": "Too big: expected number to be <=50"
                })];
            }
        }
    }
    Vec::new()
}

/// `encodeCursor` (`terminal-view/service.ts:105-107`): base64url (no padding) of
/// `JSON.stringify({lastActivityAt, terminalId})`.
fn encode_cursor(last_activity_at: i64, terminal_id: &str) -> String {
    let payload = json!({ "lastActivityAt": last_activity_at, "terminalId": terminal_id });
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
}

/// `decodeCursor` — any decode/parse/shape failure is the thrown
/// 'Invalid terminal-directory cursor'.
fn decode_cursor(cursor: &str) -> Result<(i64, String), ()> {
    // Node's Buffer.from(s,'base64url') is tolerant of padding; accept both.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.trim_end_matches('='))
        .map_err(|_| ())?;
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let last_activity_at = match parsed.get("lastActivityAt") {
        Some(Value::Number(n)) if n.is_i64() || n.is_f64() => {
            let f = n.as_f64().ok_or(())?;
            if !f.is_finite() {
                return Err(());
            }
            f as i64
        }
        _ => return Err(()),
    };
    let terminal_id = match parsed.get("terminalId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(()),
    };
    Ok((last_activity_at, terminal_id))
}

// ── the directory projection (`listTerminalDirectory`) ─────────────────────

/// JS truthiness for override values read back from config
/// (`override?.titleOverride || terminal.title`, `override?.deleted` filter).
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// The full sorted `TerminalDirectoryItem[]` (`listTerminalDirectory()`),
/// serialized in the original's exact key order with `undefined` keys omitted.
async fn directory_items(state: &TerminalsState) -> Vec<Value> {
    let overrides = state.settings.terminal_overrides();
    let mut entries = state.registry.directory();
    // compareTerminals: lastActivityAt desc, then b.terminalId.localeCompare(a) —
    // terminal ids share one alphabet+shape (uuid-style), so byte order matches
    // the ICU collation the original's localeCompare applies.
    entries.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| b.terminal_id.cmp(&a.terminal_id))
    });

    entries
        .into_iter()
        .filter(|e| {
            let deleted = overrides
                .get(&e.terminal_id)
                .and_then(Value::as_object)
                .and_then(|o| o.get("deleted"));
            !js_truthy(deleted)
        })
        .map(|e| {
            let ov = overrides.get(&e.terminal_id).and_then(Value::as_object);
            let title = match ov.and_then(|o| o.get("titleOverride")) {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                v if js_truthy(v) => v
                    .map(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .unwrap_or_else(|| e.title.clone()),
                _ => e.title.clone(),
            };
            let description = match ov.and_then(|o| o.get("descriptionOverride")) {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => e.description.clone(),
            };
            // buildDirectoryItem: sessionRef = terminal.sessionRef ?? (mode==='codex'
            // ? undefined : buildSessionRef(mode, resumeSessionId)).
            let session_ref: Option<Value> = if e.mode == "codex" || e.mode == "shell" {
                None
            } else {
                e.resume_session_id
                    .as_ref()
                    .map(|sid| json!({ "provider": e.mode, "sessionId": sid }))
            };
            let last_line = last_emitted_line(&e.snapshot);

            // Exact key order of the original's JSON (undefined keys omitted):
            // terminalId, title, description?, mode, sessionRef?, codexDurability?,
            // createdAt, lastActivityAt, status, hasClients, cwd?, lastLine?, last_line?
            let mut obj = Map::new();
            obj.insert("terminalId".into(), Value::String(e.terminal_id));
            obj.insert("title".into(), Value::String(title));
            if let Some(d) = description {
                obj.insert("description".into(), Value::String(d));
            }
            obj.insert("mode".into(), Value::String(e.mode));
            if let Some(sr) = session_ref {
                obj.insert("sessionRef".into(), sr);
            }
            // codexDurability: the Rust registry has no codex durability record yet
            // (codex panes land with the argv-fidelity task) — omitted, like the
            // original's undefined.
            obj.insert("createdAt".into(), json!(e.created_at));
            obj.insert("lastActivityAt".into(), json!(e.last_activity_at));
            obj.insert(
                "status".into(),
                Value::String(
                    match e.status {
                        TerminalRunStatus::Running => "running",
                        TerminalRunStatus::Exited => "exited",
                    }
                    .to_string(),
                ),
            );
            obj.insert("hasClients".into(), Value::Bool(e.has_clients));
            if let Some(cwd) = e.cwd {
                obj.insert("cwd".into(), Value::String(cwd));
            }
            if let Some(ll) = last_line {
                obj.insert("lastLine".into(), Value::String(ll.clone()));
                obj.insert("last_line".into(), Value::String(ll));
            }
            Value::Object(obj)
        })
        .collect()
}

/// `lastEmittedLine` (`terminal-view/service.ts:90-103`): strip ANSI escapes,
/// normalize `\r` → `\n`, take the last trimmed non-empty line that is not a
/// shell prompt, truncated to 500 UTF-16 units (497 + '...').
fn last_emitted_line(snapshot: &str) -> Option<String> {
    let stripped = strip_ansi(snapshot);
    let last = stripped
        .replace('\r', "\n")
        .split('\n')
        .map(str::trim)
        .filter(|l| !is_shell_prompt_line(l))
        .filter(|l| !l.is_empty())
        .next_back()?
        .to_string();
    let units: Vec<u16> = last.encode_utf16().collect();
    if units.len() <= MAX_LAST_LINE_CHARS {
        return Some(last);
    }
    let head = String::from_utf16_lossy(&units[..MAX_LAST_LINE_CHARS - 3]);
    Some(format!("{head}..."))
}

/// `/^[^\s@:]+@[^\s:]+:.+[#$%]\s*$/` (`isShellPromptLine`) — hand-rolled to avoid
/// a regex dependency; classes are ASCII-anchored except `\s` (Unicode ws).
fn is_shell_prompt_line(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    // [^\s@:]+ then '@'
    let mut i = 0;
    while i < n && !chars[i].is_whitespace() && chars[i] != '@' && chars[i] != ':' {
        i += 1;
    }
    if i == 0 || i >= n || chars[i] != '@' {
        return false;
    }
    i += 1;
    // [^\s:]+ then ':'
    let start = i;
    while i < n && !chars[i].is_whitespace() && chars[i] != ':' {
        i += 1;
    }
    if i == start || i >= n || chars[i] != ':' {
        return false;
    }
    i += 1;
    // .+[#$%]\s*$ — find the last [#$%] such that ≥1 char precedes it (after the
    // colon) and only whitespace follows.
    let mut j = n;
    while j > i {
        let c = chars[j - 1];
        if c == '#' || c == '$' || c == '%' {
            break;
        }
        if !c.is_whitespace() {
            return false;
        }
        j -= 1;
    }
    // chars[j-1] is the prompt sigil; need at least one `.` char before it (i < j-1).
    j > i && j - 1 > i
}

/// `/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g` — the ANSI escape stripper, as a
/// scanner replicating the regex's global-match semantics (an unmatched ESC is
/// kept, and scanning resumes at the next char).
fn strip_ansi(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1B}' && i + 1 < chars.len() {
            let c = chars[i + 1];
            // [@-Z\\-_] = 0x40-0x5A or 0x5C-0x5F
            if ('@'..='Z').contains(&c) || ('\\'..='_').contains(&c) {
                i += 2;
                continue;
            }
            if c == '[' {
                // \[[0-?]*[ -/]*[@-~]
                let mut j = i + 2;
                while j < chars.len() && ('0'..='?').contains(&chars[j]) {
                    j += 1;
                }
                while j < chars.len() && (' '..='/').contains(&chars[j]) {
                    j += 1;
                }
                if j < chars.len() && ('@'..='~').contains(&chars[j]) {
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// `cleanString` (`server/utils.ts:2`): trim; empty/whitespace/null → None.
fn clean_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

/// Validate one `TerminalPatchSchema` string field (`string().max(N).optional()
/// .nullable()`); pushes the exact zod v4 issue on violation.
fn validate_patch_string(
    body: &Map<String, Value>,
    key: &str,
    max: usize,
    issues: &mut Vec<Value>,
) {
    match body.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            if s.encode_utf16().count() > max {
                issues.push(json!({
                    "origin": "string", "code": "too_big", "maximum": max, "inclusive": true,
                    "path": [key],
                    "message": format!("Too big: expected string to have <={max} characters")
                }));
            }
        }
        Some(other) => {
            issues.push(json!({
                "expected": "string", "code": "invalid_type",
                "path": [key],
                "message": format!("Invalid input: expected string, received {}", zod_received(other))
            }));
        }
    }
}

/// zod v4's `received` type-name for a JSON value.
pub(crate) fn zod_received(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

async fn patch_terminal(
    State(state): State<TerminalsState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    body: axum::body::Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `req.body || {}`: an absent/empty body validates as `{}`. express.json()'s
    // STRICT mode only admits objects and arrays — any other top-level JSON (and
    // malformed JSON) is answered by express's default error handler BEFORE the
    // route runs: 400 with the canonical HTML error page (captured live from the
    // original — see `express_bad_request`). An array passes the parser and then
    // fails TerminalPatchSchema (zod invalid_type expected object).
    let parsed_body: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => v,
            Ok(_) | Err(_) => return express_bad_request(),
        }
    };

    // TerminalPatchSchema (zod v4 exact issues; unknown keys stripped, not errors).
    let body_obj: Map<String, Value> = match &parsed_body {
        Value::Object(m) => m.clone(),
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid request",
                    "details": [{
                        "expected": "object", "code": "invalid_type",
                        "path": [],
                        "message": format!("Invalid input: expected object, received {}", zod_received(other))
                    }]
                })),
            )
                .into_response();
        }
    };
    let mut issues: Vec<Value> = Vec::new();
    validate_patch_string(
        &body_obj,
        "titleOverride",
        MAX_TITLE_OVERRIDE_LEN,
        &mut issues,
    );
    validate_patch_string(
        &body_obj,
        "descriptionOverride",
        MAX_DESCRIPTION_OVERRIDE_LEN,
        &mut issues,
    );
    let deleted: Option<bool> = match body_obj.get("deleted") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(other) => {
            issues.push(json!({
                "expected": "boolean", "code": "invalid_type",
                "path": ["deleted"],
                "message": format!("Invalid input: expected boolean, received {}", zod_received(other))
            }));
            None
        }
    };
    if !issues.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": issues })),
        )
            .into_response();
    }

    let title_override = body_obj.get("titleOverride").and_then(clean_string);
    let description_override = body_obj.get("descriptionOverride").and_then(clean_string);

    // The route's patch object carries ALL THREE keys (undefined values overwrite
    // — the JS-spread semantics `patch_terminal_override` documents).
    let next = state
        .settings
        .patch_terminal_override(
            &terminal_id,
            &[
                ("titleOverride", title_override.clone().map(Value::String)),
                (
                    "descriptionOverride",
                    description_override.clone().map(Value::String),
                ),
                ("deleted", deleted.map(Value::Bool)),
            ],
        )
        .await;

    // Registry write-through (`terminals-router.ts:303-304`). `cleanString`
    // already trimmed, so a Some here is the non-empty trimmed string.
    if let Some(t) = &title_override {
        state.registry.update_title(&terminal_id, t);
    }
    if let Some(d) = &description_override {
        state.registry.update_description(&terminal_id, d);
    }
    // Cascade: if this terminal has a coding-CLI session, also rename the session
    // (`cascadeTerminalRenameToSession`, `rename-cascade.ts:23-32`, driven from
    // `terminals-router.ts:306-320`). `identity.get()` (NOT `.list()`) so the
    // cascade still fires for an ALREADY-EXITED terminal (retained/retired
    // entries preserve provider/sessionId — `terminals-router.ts:311-312`'s
    // `.get?.(terminalId) ?? .list().find(...)` fallback chain collapses to a
    // single `get()` here because this port's registry never forgets an entry
    // outright, only marks it retired).
    if let Some(t) = &title_override {
        if let Some(identity) = state.identity.get(&terminal_id) {
            if let (Some(provider), Some(session_id)) =
                (identity.provider.as_deref(), identity.session_id.as_deref())
            {
                let composite_key = format!("{provider}:{session_id}");
                state
                    .settings
                    .patch_session_override(
                        &composite_key,
                        &[
                            ("titleOverride", Some(Value::String(t.clone()))),
                            ("titleSource", Some(json!("user"))),
                        ],
                    )
                    .await;
            }
        }
    }

    broadcast_terminals_changed(&state);
    Json(next).into_response()
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn delete_terminal(
    State(state): State<TerminalsState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `configStore.deleteTerminal` = single-key `{deleted:true}` patch: existing
    // title/description overrides survive (unlike a PATCH, which overwrites all
    // three keys). Always `{ok:true}` — no 404 for unknown ids.
    state
        .settings
        .patch_terminal_override(&terminal_id, &[("deleted", Some(Value::Bool(true)))])
        .await;
    broadcast_terminals_changed(&state);
    Json(json!({ "ok": true })).into_response()
}

/// express's default error-handler response for a body the strict JSON parser
/// rejects (`entity.parse.failed`) — byte-captured from the LIVE original
/// (`PATCH /api/terminals/:id` with body `5`): 400, `text/html`, CSP
/// `default-src 'none'`, and the canonical "Bad Request" error page.
pub(crate) fn express_bad_request() -> Response {
    (
        StatusCode::BAD_REQUEST,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'none'"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Bad Request</pre>\n</body>\n</html>\n",
    )
        .into_response()
}

/// `wsHandler.broadcastTerminalsChanged()` (`ws-handler.ts:3670-3679`):
/// `{type:'terminals.changed', revision}` with the handler-scoped monotonic
/// revision (no `recoverableTerminalIds` from this REST path).
fn broadcast_terminals_changed(state: &TerminalsState) {
    let revision = state.terminals_revision.fetch_add(1, Ordering::SeqCst) + 1;
    let frame = json!({ "type": "terminals.changed", "revision": revision }).to_string();
    let _ = state.broadcast_tx.send(frame);
}

#[cfg(test)]
mod cascade_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;

    fn dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "frs-terminals-router-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    fn state(dir: &std::path::Path) -> TerminalsState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        TerminalsState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(Some(dir), vec!["claude".into()]),
            registry: TerminalRegistry::new(),
            broadcast_tx: Arc::new(tx),
            terminals_revision: Arc::new(AtomicI64::new(0)),
            identity: TerminalIdentityRegistry::new(),
        }
    }

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn patch_terminal_title(state: TerminalsState, terminal_id: &str, title: &str) -> Value {
        let resp = router(state)
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/terminals/{terminal_id}"))
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "titleOverride": title }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        body_json(resp).await
    }

    /// SYMPTOM 2a (forward direction): renaming a terminal running a coding-CLI
    /// session cascades the title to that session's override
    /// (`cascadeTerminalRenameToSession`, `rename-cascade.ts:23-32`).
    #[tokio::test]
    async fn rename_cascades_to_associated_live_session() {
        let dir = dir();
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = state(&dir);
        state
            .identity
            .upsert("term-1", Some("claude"), Some("sess-abc"), None, 1000);

        let resp = patch_terminal_title(state.clone(), "term-1", "My Renamed Terminal").await;
        assert_eq!(resp["titleOverride"], json!("My Renamed Terminal"));

        let overrides = state.settings.session_overrides();
        let session_override = overrides
            .get("claude:sess-abc")
            .expect("session override cascaded");
        assert_eq!(
            session_override["titleOverride"],
            json!("My Renamed Terminal")
        );
        assert_eq!(session_override["titleSource"], json!("user"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The forward cascade uses `identity.get()` (not `.list()`), so it still
    /// fires for a RETIRED (already-exited) terminal — `terminals-router.ts:311`'s
    /// `.get?.(terminalId) ?? .list().find(...)` fallback, preserved here because
    /// `retire()` never removes the entry, only marks it retired.
    #[tokio::test]
    async fn rename_cascades_even_after_the_terminal_has_exited() {
        let dir = dir();
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = state(&dir);
        state
            .identity
            .upsert("term-2", Some("codex"), Some("sess-xyz"), None, 1000);
        state.identity.retire("term-2");

        let resp = patch_terminal_title(state.clone(), "term-2", "Post-Exit Rename").await;
        assert_eq!(resp["titleOverride"], json!("Post-Exit Rename"));

        let overrides = state.settings.session_overrides();
        let session_override = overrides
            .get("codex:sess-xyz")
            .expect("session override cascaded even though the terminal exited");
        assert_eq!(session_override["titleOverride"], json!("Post-Exit Rename"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A terminal with no coding-CLI identity (plain shell) is a no-op cascade:
    /// no session override is fabricated.
    #[tokio::test]
    async fn rename_of_plain_shell_terminal_does_not_create_a_session_override() {
        let dir = dir();
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let state = state(&dir);
        // No identity.upsert() call at all -- unknown to the registry.

        let resp = patch_terminal_title(state.clone(), "term-3", "Shell Renamed").await;
        assert_eq!(resp["titleOverride"], json!("Shell Renamed"));
        assert!(state.settings.session_overrides().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── lastEmittedLine (ported reference cases) ──

    fn ln(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// Byte shapes/quirks pinned live 2026-07-12
    /// (`~/freshell-scratch-005e/search-truth-orig.json`, 22-case battery
    /// rust≡original).
    #[test]
    fn mirror_search_matches_js_semantics() {
        let lines = ln(&["alpha TOKEN", "nothing", "token again", "tail"]);
        // Case-insensitive indexOf; column in UTF-16 units of the lowercased line.
        let page = mirror_search(&lines, "TOKEN", 0.0, 50).unwrap();
        assert_eq!(
            page,
            json!({ "matches": [
                { "line": 0, "column": 6, "text": "alpha TOKEN" },
                { "line": 2, "column": 0, "text": "token again" },
            ], "nextCursor": "3" })
        );
        // limit pagination: nextCursor = String(lastMatchLine+1).
        let page = mirror_search(&lines, "token", 0.0, 1).unwrap();
        assert_eq!(page["matches"].as_array().unwrap().len(), 1);
        assert_eq!(page["nextCursor"], json!("1"));
        // cursor past matches / past end.
        assert_eq!(
            mirror_search(&lines, "token", 3.0, 50).unwrap(),
            json!({ "matches": [], "nextCursor": null })
        );
        assert_eq!(
            mirror_search(&lines, "token", 99999.0, 50).unwrap(),
            json!({ "matches": [], "nextCursor": null })
        );
        // NaN / +Infinity never enter the loop.
        assert_eq!(
            mirror_search(&lines, "token", f64::NAN, 50).unwrap()["matches"],
            json!([])
        );
        assert_eq!(
            mirror_search(&lines, "token", f64::INFINITY, 50).unwrap()["nextCursor"],
            json!(null)
        );
        // Negative / fractional / -Infinity → the original's TypeError 500.
        for bad in [-3.0, 1.5, -0.5, f64::NEG_INFINITY] {
            assert_eq!(
                mirror_search(&lines, "token", bad, 50).unwrap_err(),
                "Cannot read properties of undefined (reading 'toLowerCase')"
            );
        }
        // -0 indexes as 0 (JS `lines[-0] === lines[0]`).
        assert_eq!(
            mirror_search(&lines, "alpha", -0.0, 50).unwrap()["matches"][0]["line"],
            json!(0)
        );
        // Regex specials are literal (indexOf, not a regex).
        assert_eq!(
            mirror_search(&lines, "token.*", 0.0, 50).unwrap()["matches"],
            json!([])
        );
        // nextCursor null when the last match is the final line.
        let page = mirror_search(&ln(&["x", "token"]), "token", 0.0, 50).unwrap();
        assert_eq!(page["nextCursor"], json!(null));
    }

    #[test]
    fn mirror_lines_normalizes_like_the_original_mirror() {
        // \r\n → \n, bare \r dropped (NOT converted), CSI stripped.
        assert_eq!(mirror_lines("a\r\nb\rc"), ln(&["a", "bc"]));
        assert_eq!(mirror_lines("x\u{1B}[31mred\u{1B}[0my"), ln(&["xredy"]));
        // Non-CSI escapes (e.g. OSC) are KEPT — mirror.ts strips CSI only.
        assert_eq!(
            mirror_lines("a\u{1B}]0;title\u{7}b"),
            ln(&["a\u{1B}]0;title\u{7}b"])
        );
        // Incomplete CSI at end-of-input stays raw (the regex needs a final byte).
        assert_eq!(mirror_lines("a\u{1B}[12"), ln(&["a\u{1B}[12"]));
        // Empty snapshot == the mirror's initial [''] line model.
        assert_eq!(mirror_lines(""), ln(&[""]));
    }

    #[test]
    fn last_emitted_line_strips_ansi_and_prompts_and_takes_last() {
        // ANSI stripped, \r treated as newline, prompt lines dropped, empties dropped.
        let snap = "\u{1B}[32mhello\u{1B}[0m world\r\nuser@host:~/code$ \nnpm run build\r\n\n";
        assert_eq!(last_emitted_line(snap).as_deref(), Some("npm run build"));
        // Nothing but prompt + empties → None.
        assert_eq!(last_emitted_line("user@host:~$ \n\n"), None);
        assert_eq!(last_emitted_line(""), None);
        // \r alone splits lines.
        assert_eq!(last_emitted_line("a\rb"), Some("b".to_string()));
    }

    #[test]
    fn last_emitted_line_truncates_at_500_utf16_units() {
        let long = "x".repeat(600);
        let out = last_emitted_line(&long).unwrap();
        assert_eq!(out.encode_utf16().count(), 500);
        assert!(out.ends_with("..."));
        assert_eq!(&out[..497], &"x".repeat(497));
        // Exactly 500 → untruncated.
        let exact = "y".repeat(500);
        assert_eq!(last_emitted_line(&exact).unwrap(), exact);
    }

    #[test]
    fn shell_prompt_regex_parity() {
        // /^[^\s@:]+@[^\s:]+:.+[#$%]\s*$/
        assert!(is_shell_prompt_line("dan@box:~/code$"));
        assert!(is_shell_prompt_line("root@host:/etc# "));
        assert!(is_shell_prompt_line("u@h:x%"));
        assert!(!is_shell_prompt_line("dan@box:$")); // `.+` needs ≥1 char before sigil
        assert!(!is_shell_prompt_line("@host:~/x$"));
        assert!(!is_shell_prompt_line("dan box:~/x$"));
        assert!(!is_shell_prompt_line("plain output"));
        assert!(!is_shell_prompt_line("a@b:c")); // no sigil
    }

    #[test]
    fn strip_ansi_keeps_unmatched_escapes() {
        // All expectations verified against the live JS regex in node:
        //   'x\x1B]0;title\x07y'.replace(RE,'') === 'x0;title\u0007y'  (']' IS in [\\-_])
        //   'e\x1B'.replace(RE,'') === 'e\u001b'                        (bare ESC kept)
        //   '\x1B[incomplete'.replace(RE,'') === 'ncomplete'            ('i' is the final byte)
        assert_eq!(strip_ansi("a\u{1B}[31mb\u{1B}[0mc"), "abc");
        assert_eq!(strip_ansi("x\u{1B}]0;title\u{7}y"), "x0;title\u{7}y");
        assert_eq!(strip_ansi("e\u{1B}"), "e\u{1B}");
        assert_eq!(strip_ansi("\u{1B}[incomplete"), "ncomplete");
        assert_eq!(strip_ansi("\u{1B}\\"), ""); // ST (single-char class)
    }

    // ── cursor codec (ground truth from Buffer.from(...).toString('base64url')) ──

    #[test]
    fn cursor_roundtrip_matches_node_base64url() {
        let c = encode_cursor(1752200000000, "term-abc");
        assert_eq!(
            c,
            "eyJsYXN0QWN0aXZpdHlBdCI6MTc1MjIwMDAwMDAwMCwidGVybWluYWxJZCI6InRlcm0tYWJjIn0"
        );
        assert_eq!(
            decode_cursor(&c),
            Ok((1752200000000, "term-abc".to_string()))
        );
        assert!(decode_cursor("not-json!").is_err());
        assert!(decode_cursor("eyJ4IjoxfQ").is_err()); // {"x":1} — wrong shape
    }

    // ── zod v4 issue replication (ground truth captured from the live schemas) ──

    #[test]
    fn number_issues_match_zod_v4_ground_truth() {
        // NaN
        assert_eq!(
            number_issues(f64::NAN, "revision", NumberRule::NonNegativeInt),
            vec![
                json!({"expected":"number","code":"invalid_type","received":"NaN","path":["revision"],"message":"Invalid input: expected number, received NaN"})
            ]
        );
        // float → safeint issue (also for negative floats — int check wins)
        assert_eq!(
            number_issues(-1.5, "revision", NumberRule::NonNegativeInt),
            vec![
                json!({"expected":"int","format":"safeint","code":"invalid_type","path":["revision"],"message":"Invalid input: expected int, received number"})
            ]
        );
        // negative int
        assert_eq!(
            number_issues(-1.0, "revision", NumberRule::NonNegativeInt),
            vec![
                json!({"origin":"number","code":"too_small","minimum":0,"inclusive":true,"path":["revision"],"message":"Too small: expected number to be >=0"})
            ]
        );
        // limit 0 / -3 → >0; 51 → too_big; Infinity → invalid_type number
        assert_eq!(
            number_issues(0.0, "limit", NumberRule::PositiveIntMax50),
            vec![
                json!({"origin":"number","code":"too_small","minimum":0,"inclusive":false,"path":["limit"],"message":"Too small: expected number to be >0"})
            ]
        );
        assert_eq!(
            number_issues(51.0, "limit", NumberRule::PositiveIntMax50),
            vec![
                json!({"origin":"number","code":"too_big","maximum":50,"inclusive":true,"path":["limit"],"message":"Too big: expected number to be <=50"})
            ]
        );
        assert_eq!(
            number_issues(f64::INFINITY, "revision", NumberRule::NonNegativeInt),
            vec![
                json!({"expected":"number","code":"invalid_type","received":"Infinity","path":["revision"],"message":"Invalid input: expected number, received number"})
            ]
        );
        // valid values → no issues
        assert!(number_issues(0.0, "revision", NumberRule::NonNegativeInt).is_empty());
        assert!(number_issues(50.0, "limit", NumberRule::PositiveIntMax50).is_empty());
    }

    #[test]
    fn js_number_parity() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("  "), 0.0);
        assert_eq!(js_number("42"), 42.0);
        assert_eq!(js_number("1.5"), 1.5);
        assert!(js_number("abc").is_nan());
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
    }

    #[test]
    fn js_truthy_matrix() {
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&Value::Null)));
        assert!(!js_truthy(Some(&json!(false))));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(js_truthy(Some(&json!(true))));
        assert!(js_truthy(Some(&json!("x"))));
        assert!(js_truthy(Some(&json!({}))));
    }

    #[test]
    fn clean_string_parity() {
        assert_eq!(clean_string(&json!("  hi  ")), Some("hi".to_string()));
        assert_eq!(clean_string(&json!("   ")), None);
        assert_eq!(clean_string(&json!("")), None);
        assert_eq!(clean_string(&Value::Null), None);
    }
}

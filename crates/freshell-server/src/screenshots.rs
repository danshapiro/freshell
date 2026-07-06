//! `POST /api/screenshots` — the agent screenshot endpoint (Phase 3.18).
//!
//! Ports `server/agent-api/router.ts:1070` + `screenshot-path.ts`: capture the
//! live UI as a PNG by asking a connected screenshot-capable client to render
//! itself (`captureUiScreenshot` / html2canvas), then write the returned base64
//! PNG to disk and answer the agent-response envelope.
//!
//! The round-trip goes through the shared [`freshell_ws::screenshot::ScreenshotBroker`]:
//! register a `requestId`, broadcast the `screenshot.capture` `ui.command`, and
//! await the client's `ui.screenshot.result` (10 s, as in the reference). This is
//! what `browser-pane-screenshot.spec.ts:56` exercises end-to-end (after the HTTP
//! reverse proxy renders the iframe content).
//!
//! ## Faithful behaviour (matches `agent-api/router.ts`)
//! * `scope` must be `pane`|`tab`|`view`, else `400 { status:"error" }`.
//! * `pane` scope requires `paneId`; `tab` scope requires `tabId` (else `400`).
//! * no screenshot-capable client → `503` (the reference's `NO_SCREENSHOT_CLIENT`).
//! * output path resolved via the ported `resolve_screenshot_output_path`
//!   (`screenshot-path.ts`); a bad name/path is `400`.
//! * `!overwrite` and the file exists → `409`.
//! * a `!ok`/imageless UI reply → `422`; a timeout/closed socket → `503`.
//! * success → `200 { status:"ok", data:{ path, scope, tabId?, paneId?, width,
//!   height, changedFocus, restoredFocus, timestamp }, message:"screenshot saved" }`.
//!
//! Gated by the shared auth token ([`crate::boot::is_authed`]). Additive port code;
//! no `server/` or `shared/` source is touched.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine as _;
use freshell_ws::screenshot::ScreenshotBroker;
use serde_json::{json, Value};

/// The `ui.screenshot.result` wait budget (`ws-handler.ts:1051`, `timeoutMs=10_000`).
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(10);

/// Shared, cheaply-cloneable state for the screenshots endpoint.
#[derive(Clone)]
pub struct ScreenshotsState {
    /// The required auth token (`AUTH_TOKEN`) — the gate for the route.
    pub auth_token: Arc<String>,
    /// The shared UI-screenshot broker (capability gate + request correlation).
    pub broker: ScreenshotBroker,
}

/// The screenshots sub-router, pre-bound to its state (mergeable into the app).
pub fn router(state: ScreenshotsState) -> Router {
    Router::new()
        .route("/api/screenshots", post(create_screenshot))
        .with_state(state)
}

async fn create_screenshot(
    State(state): State<ScreenshotsState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));

    // scope: pane | tab | view (else 400) — `router.ts:1078`.
    let scope = match body.get("scope").and_then(Value::as_str) {
        Some(s @ ("pane" | "tab" | "view")) => s,
        _ => return fail(StatusCode::BAD_REQUEST, "scope must be pane, tab, or view"),
    };
    let pane_id = body.get("paneId").and_then(Value::as_str);
    let tab_id = body.get("tabId").and_then(Value::as_str);
    if scope == "pane" && pane_id.is_none() {
        return fail(StatusCode::BAD_REQUEST, "paneId required for pane scope");
    }
    if scope == "tab" && tab_id.is_none() {
        return fail(StatusCode::BAD_REQUEST, "tabId required for tab scope");
    }

    // No capable UI connected → 503 (the reference's NO_SCREENSHOT_CLIENT path).
    if !state.broker.has_capable_client() {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "No screenshot-capable UI client connected",
        );
    }

    // Resolve the output path (`screenshot-path.ts`); a bad name/path is 400.
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    let path_input = body.get("path").and_then(Value::as_str);
    let output_path = match resolve_screenshot_output_path(name, path_input) {
        Ok(p) => p,
        Err(e) => return fail(StatusCode::BAD_REQUEST, &e),
    };
    let overwrite = truthy(body.get("overwrite"));
    if !overwrite && Path::new(&output_path).exists() {
        return fail(
            StatusCode::CONFLICT,
            "output file already exists (use --overwrite)",
        );
    }

    // Drive the round-trip: register → broadcast capture → await the UI reply.
    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = state.broker.register(request_id.clone());
    state
        .broker
        .send_capture(&request_id, scope, tab_id, pane_id);

    let result = match tokio::time::timeout(SCREENSHOT_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            state.broker.cancel(&request_id);
            return fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "UI connection closed before screenshot response",
            );
        }
        Err(_) => {
            state.broker.cancel(&request_id);
            return fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "Timed out waiting for UI screenshot response",
            );
        }
    };

    let image_base64 = match (result.ok, result.image_base64.as_deref()) {
        (true, Some(img)) if !img.is_empty() => img.to_string(),
        _ => {
            return fail(
                StatusCode::UNPROCESSABLE_ENTITY,
                result.error.as_deref().unwrap_or("ui screenshot failed"),
            )
        }
    };

    let bytes = match base64::engine::general_purpose::STANDARD.decode(image_base64.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => return fail(StatusCode::UNPROCESSABLE_ENTITY, "invalid screenshot image data"),
    };

    if let Err(err) = write_file_atomic(&output_path, &bytes) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, &err);
    }

    // Success envelope (`ok(data, 'screenshot saved')`, `router.ts:1123`).
    let mut data = json!({
        "path": output_path,
        "scope": scope,
        "width": result.width,
        "height": result.height,
        "changedFocus": result.changed_focus.unwrap_or(false),
        "restoredFocus": result.restored_focus.unwrap_or(false),
        "timestamp": now_ms(),
    });
    // tabId/paneId echoed only when present (the reference omits `undefined`s).
    if let Some(tab_id) = tab_id {
        data["tabId"] = json!(tab_id);
    }
    if let Some(pane_id) = pane_id {
        data["paneId"] = json!(pane_id);
    }
    Json(json!({ "status": "ok", "data": data, "message": "screenshot saved" })).into_response()
}

// ── screenshot-path.ts port ─────────────────────────────────────────────────

/// Port of `resolveScreenshotOutputPath` (`screenshot-path.ts:47`).
fn resolve_screenshot_output_path(name: &str, path_input: Option<&str>) -> Result<String, String> {
    let base_name = normalize_screenshot_base_name(name)?;

    let Some(path_input) = path_input else {
        // No path → `<tmpdir>/<baseName>`.
        return Ok(std::env::temp_dir()
            .join(&base_name)
            .to_string_lossy()
            .into_owned());
    };

    let normalized = normalize_path_input(path_input)?;
    let candidate = absolutize(&normalized);
    let meta = std::fs::metadata(&candidate).ok();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let looks_like_dir = meta.is_none() && (normalized.ends_with('/') || normalized.ends_with('\\'));

    if is_dir || looks_like_dir {
        std::fs::create_dir_all(&candidate).map_err(|e| e.to_string())?;
        return Ok(candidate.join(&base_name).to_string_lossy().into_owned());
    }

    if let Some(parent) = candidate.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let candidate_str = candidate.to_string_lossy().into_owned();
    if ends_with_png(&candidate_str) {
        Ok(candidate_str)
    } else {
        Ok(format!("{candidate_str}.png"))
    }
}

/// Port of `normalizeScreenshotBaseName` (`screenshot-path.ts:13`).
fn normalize_screenshot_base_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name required".to_string());
    }
    if trimmed.contains('\0') {
        return Err("name must not contain null bytes".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("name must not contain path separators".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("invalid screenshot name".to_string());
    }
    Ok(ensure_png(trimmed))
}

/// Port of `normalizePathInput` (`screenshot-path.ts:34`).
fn normalize_path_input(path_input: &str) -> Result<String, String> {
    let trimmed = path_input.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path must not contain null bytes".to_string());
    }
    Ok(trimmed.to_string())
}

/// `ensurePngExtension` (`screenshot-path.ts:5`): append `.png` unless already `.png`.
fn ensure_png(name: &str) -> String {
    if ends_with_png(name) {
        name.to_string()
    } else {
        format!("{name}.png")
    }
}

fn ends_with_png(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.ends_with(".png")
}

/// `path.resolve(input)`: absolute inputs pass through; relative ones resolve
/// against the process cwd (the server's `PROJECT_ROOT`).
fn absolutize(input: &str) -> PathBuf {
    let p = PathBuf::from(input);
    if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(p)
    }
}

/// Port of `writeFileAtomic` (`agent-api/router.ts:491`): write a temp sibling then
/// rename over the target so a concurrent read never sees a half-written file.
fn write_file_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    let temp = format!("{path}.tmp-{}", uuid::Uuid::new_v4());
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&temp);
            Err(err.to_string())
        }
    }
}

/// `truthy(v)` — accept boolean `true`, `1`, `"true"`/`"1"` (the reference's coercion).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        Some(Value::String(s)) => {
            let s = s.trim().to_ascii_lowercase();
            s == "true" || s == "1"
        }
        _ => false,
    }
}

/// `Date.now()` — milliseconds since the Unix epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `401 { "error": "Unauthorized" }` — byte-shape-equal to the original's reject.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// `<status> { "status": "error", "message": <msg> }` — the agent-response `fail`
/// envelope (`agent-api/response.ts:6`).
fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "status": "error", "message": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_name_rules_match_original() {
        assert_eq!(normalize_screenshot_base_name("shot").unwrap(), "shot.png");
        assert_eq!(normalize_screenshot_base_name("shot.PNG").unwrap(), "shot.PNG");
        assert_eq!(normalize_screenshot_base_name("  a  ").unwrap(), "a.png");
        assert!(normalize_screenshot_base_name("").is_err());
        assert!(normalize_screenshot_base_name("a/b").is_err());
        assert!(normalize_screenshot_base_name("a\\b").is_err());
        assert!(normalize_screenshot_base_name(".").is_err());
        assert!(normalize_screenshot_base_name("..").is_err());
    }

    #[test]
    fn no_path_uses_tmpdir() {
        let out = resolve_screenshot_output_path("canary-screenshot", None).unwrap();
        let expected = std::env::temp_dir()
            .join("canary-screenshot.png")
            .to_string_lossy()
            .into_owned();
        assert_eq!(out, expected);
    }

    #[test]
    fn explicit_dir_path_joins_base_name() {
        let dir = std::env::temp_dir().join(format!("freshell-shots-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = resolve_screenshot_output_path("s", Some(dir.to_str().unwrap())).unwrap();
        assert_eq!(out, dir.join("s.png").to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truthy_coercions() {
        assert!(truthy(Some(&json!(true))));
        assert!(truthy(Some(&json!(1))));
        assert!(truthy(Some(&json!("true"))));
        assert!(truthy(Some(&json!("1"))));
        assert!(!truthy(Some(&json!(false))));
        assert!(!truthy(Some(&json!("no"))));
        assert!(!truthy(None));
    }

    #[test]
    fn write_file_atomic_roundtrips() {
        let path = std::env::temp_dir()
            .join(format!("freshell-atomic-{}.bin", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        write_file_atomic(&path, b"hello").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        let _ = std::fs::remove_file(&path);
    }
}

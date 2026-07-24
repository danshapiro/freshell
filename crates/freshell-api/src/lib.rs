//! # freshell-api
//!
//! The REST surface of the freshell Rust port. Phase 3.4a implements only the
//! pieces the connect handshake + oracle need:
//!
//! * `GET /api/health` — the readiness endpoint the oracle harness (and the
//!   original E2E `TestServer`) polls before opening a WebSocket. It returns the
//!   SAME 7-field shape as the original `server/health-router.ts`:
//!   `{ app: "freshell", ok: true, requiresAuth: true, version, ready, instanceId,
//!   startedAt }`, and is **unauthenticated**, matching
//!   `server/auth.ts#httpAuthMiddleware` (which lets `/api/health` through).
//!
//!   The full shape matters for cross-compatibility: the legacy Electron
//!   launcher's server discovery (`electron/launch-discovery.ts`
//!   `discoverLocalServers`) accepts a server as a launch candidate ONLY when
//!   `health.app === 'freshell' && health.ok === true`, and it consumes
//!   `version` / `instanceId` / `startedAt` / `requiresAuth` for the candidate.
//!   Returning only `{ ok, ready }` (the earlier stub) made the Electron app
//!   reject this server; the fields below close that gap additively.
//! * [`check_auth`] — the shared constant-time auth-token gate helper the
//!   authenticated routers (added in later steps) will use.
//!
//! The remaining routers (terminals, sessions, settings, files, network,
//! fresh-agent REST, proxy) are deferred.

use std::sync::Arc;

use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};

/// Shared, cheaply-cloneable REST state.
#[derive(Clone)]
pub struct ApiState {
    /// The required auth token (`AUTH_TOKEN`) — the security gate for the
    /// authenticated routers added later. `/api/health` does not consult it.
    pub auth_token: Arc<String>,
    /// Whether startup has finished; reflected in the health `ready` field.
    pub ready: bool,
    /// The app version string — the SAME value `GET /api/version` returns as
    /// `currentVersion` (threaded from the server so the two always agree).
    /// Surfaced as health `version` (mirrors `server/health-router.ts`
    /// `version: appVersion`).
    pub version: Arc<String>,
    /// The boot-scoped server instance id (`srv-<uuid>`) — the SAME value the
    /// WS connect handshake reports as `ready.serverInstanceId`. Surfaced as
    /// health `instanceId` so a discovered Electron launch candidate's id is
    /// stable/consistent between `/api/health` and the handshake.
    pub instance_id: Arc<String>,
    /// The server-start timestamp as an ISO-8601 string (millisecond precision +
    /// `Z`, matching JS `Date.toISOString()`), captured once at boot. Surfaced as
    /// health `startedAt` (mirrors `server/health-router.ts`
    /// `startedAt: startedAt.toISOString()`).
    pub started_at: Arc<String>,
}

/// The REST sub-router, pre-bound to its state (mergeable into the server app).
pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .with_state(state)
}

/// `GET /api/health` → the 7-field readiness/discovery body (see [`health_body`]).
/// No auth (the harness — and the Electron launcher's discovery probe — poll this
/// before authenticating), matching `server/auth.ts#httpAuthMiddleware`.
async fn health(State(state): State<ApiState>) -> Json<Value> {
    Json(health_body(&state))
}

/// Build the `/api/health` JSON body: the SAME 7 fields, in the SAME order, as
/// the original `server/health-router.ts` (`app`, `ok`, `requiresAuth`, `version`,
/// `ready`, `instanceId`, `startedAt`). `app`/`ok`/`requiresAuth` are the fixed
/// constants the original hard-codes; the rest are threaded from [`ApiState`].
///
/// Split out from the async handler so it is unit-testable without a runtime.
fn health_body(state: &ApiState) -> Value {
    json!({
        "app": "freshell",
        "ok": true,
        "requiresAuth": true,
        "version": &*state.version,
        "ready": state.ready,
        "instanceId": &*state.instance_id,
        "startedAt": &*state.started_at,
    })
}

/// Constant-time byte-slice equality for the auth-token gate. Mirrors
/// `auth.ts#timingSafeCompare`: unequal lengths short-circuit; equal lengths
/// XOR-accumulate so the compare time is independent of the mismatch position.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The shared auth gate: a request is authorized iff it presents the exact
/// token (via `x-auth-token` header / cookie, resolved by the caller). `None`
/// (no credential presented) is always rejected.
pub fn check_auth(provided: Option<&str>, expected: &str) -> bool {
    match provided {
        Some(token) => constant_time_eq(token.as_bytes(), expected.as_bytes()),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_auth_is_constant_time_and_rejects_absent() {
        assert!(check_auth(Some("abc123"), "abc123"));
        assert!(!check_auth(Some("abc124"), "abc123"));
        assert!(!check_auth(Some("abc"), "abc123")); // length mismatch
        assert!(!check_auth(None, "abc123"));
    }

    fn sample_state(ready: bool) -> ApiState {
        ApiState {
            auth_token: Arc::new("s3cr3t-token-abcdef".to_string()),
            ready,
            version: Arc::new("0.7.0".to_string()),
            instance_id: Arc::new("srv-11112222-3333-4444-5555-666677778888".to_string()),
            started_at: Arc::new("2024-01-15T12:34:56.789Z".to_string()),
        }
    }

    #[test]
    fn health_body_matches_original_seven_field_shape() {
        // The body must be byte-shape-equal to `server/health-router.ts`: same 7
        // fields, same order. The fixed constants (`app`/`ok`/`requiresAuth`) plus
        // the threaded `version`/`ready`/`instanceId`/`startedAt`.
        let body = health_body(&sample_state(true));

        assert_eq!(body["app"], json!("freshell"));
        assert_eq!(body["ok"], json!(true));
        assert_eq!(body["requiresAuth"], json!(true));
        assert_eq!(body["version"], json!("0.7.0"));
        assert!(body["ready"].is_boolean(), "ready must be a boolean");
        assert_eq!(body["ready"], json!(true));
        assert_eq!(
            body["instanceId"],
            json!("srv-11112222-3333-4444-5555-666677778888")
        );
        assert_eq!(body["startedAt"], json!("2024-01-15T12:34:56.789Z"));

        // Field ORDER parity (serde_json `preserve_order` is on workspace-wide),
        // matching the original's object literal order.
        let keys: Vec<&str> = body
            .as_object()
            .expect("health body is an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "app",
                "ok",
                "requiresAuth",
                "version",
                "ready",
                "instanceId",
                "startedAt"
            ]
        );
    }

    #[test]
    fn health_body_satisfies_electron_discovery_predicate() {
        // `electron/launch-discovery.ts` accepts the server as a launch candidate
        // ONLY when `health.app === 'freshell' && health.ok === true`.
        let body = health_body(&sample_state(false));
        let accepted = body["app"] == json!("freshell") && body["ok"] == json!(true);
        assert!(accepted, "must satisfy the Electron discovery predicate");
        // `ready` is independent of the predicate — a not-yet-ready server is still
        // a valid, discoverable freshell candidate.
        assert_eq!(body["ready"], json!(false));
    }
}

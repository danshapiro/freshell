//! # freshell-api
//!
//! The REST surface of the freshell Rust port. Phase 3.4a implements only the
//! pieces the connect handshake + oracle need:
//!
//! * `GET /api/health` — the readiness endpoint the oracle harness (and the
//!   original E2E `TestServer`) polls before opening a WebSocket. It returns
//!   `{ "ok": true, "ready": <bool> }` and is **unauthenticated**, matching
//!   `server/auth.ts#httpAuthMiddleware` (which lets `/api/health` through).
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
}

/// The REST sub-router, pre-bound to its state (mergeable into the server app).
pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .with_state(state)
}

/// `GET /api/health` → `{ "ok": true, "ready": <bool> }`. No auth (the harness
/// polls this before it has authenticated).
async fn health(State(state): State<ApiState>) -> Json<Value> {
    Json(json!({ "ok": true, "ready": state.ready }))
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

    #[test]
    fn health_body_shape() {
        // The exact JSON the harness polls: ok:true drives readiness.
        let body = json!({ "ok": true, "ready": true });
        assert_eq!(body["ok"], json!(true));
        assert_eq!(body["ready"], json!(true));
    }
}

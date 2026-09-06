//! Platform gating of the restart capability (review fix 4): the
//! replacement-fence ownership barrier can only prove quiescence on Linux, so
//! a server anywhere else must (a) withhold the `agentRestartV1` ready
//! advertisement and (b) reject every restart preflight with the typed
//! nonretryable `UNSUPPORTED_PLATFORM` — rather than persist a replacement
//! fence it could never recover.
//!
//! LB-13 test-binary isolation: the gate's env knob
//! (`FRESHELL_RESTART_PLATFORM_GATE`, read on EVERY call by
//! `restart_fence_recovery_supported`; production never sets it) is
//! process-global while sibling suites (`restart_protocol.rs`) read the same
//! handshake shape implicitly under parallel scheduling. These tests
//! therefore live in their own integration binary — their own process — with
//! a binary-local serialized env guard (the `LEASE_ENV_LOCK` /
//! `IsolatedCodexEnv` precedent from `freshagent_session_lease.rs`).

mod common;

use std::time::Duration;

use freshell_protocol::{AgentRestart, AgentRestartFailureCode, AgentRuntimeKind};
use freshell_ws::restart::{
    restart_fence_recovery_supported, ProductionRestartRuntime, RestartRuntime,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const GATE_ENV: &str = "FRESHELL_RESTART_PLATFORM_GATE";

/// Serializes every test in this binary that touches (or depends on the
/// production posture of) the process-global gate knob. The positive control
/// also acquires it: a forced-off sibling must not be mid-flight.
static GATE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held gate-knob override with restore-on-drop, so a sibling acquiring the
/// lock after us always observes the caller's original environment exactly.
struct EnvGate {
    previous: Option<std::ffi::OsString>,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl EnvGate {
    async fn set(value: &str) -> Self {
        let guard = GATE_ENV_LOCK.lock().await;
        let previous = std::env::var_os(GATE_ENV);
        std::env::set_var(GATE_ENV, value);
        Self {
            previous,
            _guard: guard,
        }
    }
}

impl Drop for EnvGate {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(GATE_ENV, value),
            None => std::env::remove_var(GATE_ENV),
        }
    }
}

/// Connect + hello (opted into `agentRestartV1`), consuming the 4-frame
/// handshake; returns the parsed `ready` frame.
async fn connect_and_read_ready(url: &str) -> serde_json::Value {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": common::AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": { "agentRestartV1": true },
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    let mut ready = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("ready") {
                ready = value;
            }
        }
    }
    assert!(!ready.is_null(), "handshake must contain ready");
    ready
}

#[tokio::test]
async fn gate_env_zero_forces_the_gate_closed() {
    let _env = EnvGate::set("0").await;
    assert!(
        !restart_fence_recovery_supported(),
        "gateway knob `=0` must force the platform gate closed"
    );
}

#[tokio::test]
async fn gate_env_one_cannot_fabricate_support_on_an_unsupported_host() {
    let _env = EnvGate::set("1").await;
    // `=1` is ignored: the gate is the bare `cfg!(linux)` check, so a test
    // can never fabricate support on a genuinely unsupported host — the
    // assertion is the cfg result itself, not `true`.
    assert_eq!(
        restart_fence_recovery_supported(),
        cfg!(target_os = "linux"),
        "gate must ignore `=1` and fall back to the compile-time platform"
    );
}

#[tokio::test]
async fn handshake_omits_restart_advertisement_when_platform_gate_closed() {
    let _env = EnvGate::set("0").await;
    let (url, registry, _state) = common::spawn_server_with_specs_and_state(vec![]).await;

    let ready = connect_and_read_ready(&url).await;
    assert!(
        ready
            .get("capabilities")
            .and_then(|c| c.get("agentRestartV1"))
            .is_none(),
        "gate-closed server must withhold the restart advertisement: {ready}"
    );

    registry.kill_all();
}

#[tokio::test]
async fn preflight_rejects_restart_when_platform_gate_closed() {
    let _env = EnvGate::set("0").await;
    let (_url, registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    let runtime = ProductionRestartRuntime::new(state);
    // Deliberately names a runtime that was never registered: the gate must
    // reject BEFORE any provider/runtime probing.
    let request = AgentRestart {
        request_id: "gate-closed-preflight".to_string(),
        provider: "claude".to_string(),
        session_id: "durable-gate-closed".to_string(),
        kind: AgentRuntimeKind::Terminal,
        live_id: "term-never-live".to_string(),
        expected_generation: 1,
    };

    let failure = runtime
        .preflight(&request)
        .await
        .expect_err("gate-closed preflight must reject");
    assert!(
        matches!(failure.code, AgentRestartFailureCode::UnsupportedPlatform),
        "expected UNSUPPORTED_PLATFORM, got {failure:?}"
    );
    assert!(
        !failure.retryable,
        "platform gating is permanent for this server; retrying cannot help"
    );

    registry.kill_all();
}

/// Linux positive control: with the knob absent (the production posture) the
/// gate is the bare cfg check, so the advertisement flows when the client
/// opts in. Also guards the EnvGate contract — a `Drop` that failed to
/// restore would close the gate here and fail this test.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn handshake_advertises_restart_when_platform_gate_open() {
    let _gate = GATE_ENV_LOCK.lock().await;
    assert!(
        restart_fence_recovery_supported(),
        "Linux without the knob must report fence recovery supported"
    );
    let (url, registry, _state) = common::spawn_server_with_specs_and_state(vec![]).await;

    let ready = connect_and_read_ready(&url).await;
    assert_eq!(
        ready["capabilities"]["agentRestartV1"],
        serde_json::json!(true),
        "gate-open server must advertise restart to an opted-in client: {ready}"
    );

    registry.kill_all();
}

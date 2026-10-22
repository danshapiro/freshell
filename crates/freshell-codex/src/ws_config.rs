//! Feature-gated WebSocket transport-cap builders
//! (docs/plans/2026-10-20-codex-proxy-ws-frame-cap.md §4.1). `tokio-tungstenite`
//! is an optional, default-off dependency (`real-transport`), so the cap
//! CONSTANTS live in always-compiled code ([`crate::remote_proxy_envelope`])
//! and only these [`WebSocketConfig`]-returning builders sit behind the
//! feature.
//!
//! - [`proxy_ws_config`] — the codex remote proxy's BOTH transport legs
//!   (the TUI-facing accept AND the upstream dial): read caps == the 256 MiB
//!   policy at exact equality.
//! - [`lane_ws_config`] — the fresh-lane app-server client and the probe dials:
//!   read caps == the independent, conservative 64 MiB lane constant.

// Verified against vendored sources: tungstenite 0.24's ROOT re-export list is
// `protocol::{Message, WebSocket}` only — WebSocketConfig is NOT at the root.
// tokio-tungstenite 0.24 re-exports the crate (`pub use tungstenite;`), so the
// path through this crate's existing deps is:
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::remote_proxy_envelope::{
    MAX_LANE_FRAME_BYTES, MAX_WS_FRAME_BYTES, MAX_WS_MESSAGE_BYTES,
};

/// The codex remote proxy's transport config: BOTH read caps at the policy
/// value (equality — the transport is the boundary that fires in practice;
/// the hub's own check remains as belt-and-suspenders).
pub fn proxy_ws_config() -> WebSocketConfig {
    ws_config_with_caps(MAX_WS_FRAME_BYTES, MAX_WS_MESSAGE_BYTES)
}

/// The fresh-lane transport config: BOTH read caps at the lane constant.
pub fn lane_ws_config() -> WebSocketConfig {
    ws_config_with_caps(MAX_LANE_FRAME_BYTES, MAX_LANE_FRAME_BYTES)
}

/// Build a [`WebSocketConfig`] with explicit read caps; every other field stays
/// at tungstenite's defaults. [`crate::remote_proxy::CodexRemoteProxy::start`]
/// builds its config from the options through this helper, so injected test
/// caps flow to both transport legs.
pub fn ws_config_with_caps(max_frame_size: usize, max_message_size: usize) -> WebSocketConfig {
    WebSocketConfig {
        max_frame_size: Some(max_frame_size),
        max_message_size: Some(max_message_size),
        ..WebSocketConfig::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_proxy::CodexRemoteProxyOptions;
    use crate::remote_proxy_envelope::{
        CANARY_BYTES, MAX_LANE_FRAME_BYTES, MAX_WS_FRAME_BYTES, MAX_WS_MESSAGE_BYTES,
    };

    // ── plan 2026-10-20-codex-proxy-ws-frame-cap.md §5.5: config propagation ──────

    #[test]
    fn proxy_ws_config_sets_both_read_caps_to_the_policy_constants() {
        let config = proxy_ws_config();
        assert_eq!(config.max_frame_size, Some(MAX_WS_FRAME_BYTES));
        assert_eq!(config.max_message_size, Some(MAX_WS_MESSAGE_BYTES));
        // Every other field stays at tungstenite's defaults — the read caps
        // are the only deliberate deviation.
        assert_eq!(config.write_buffer_size, 128 * 1024);
        assert_eq!(config.max_write_buffer_size, usize::MAX);
        assert!(!config.accept_unmasked_frames);
    }

    #[test]
    fn lane_ws_config_sets_both_read_caps_to_the_lane_constant() {
        let config = lane_ws_config();
        assert_eq!(config.max_frame_size, Some(MAX_LANE_FRAME_BYTES));
        assert_eq!(config.max_message_size, Some(MAX_LANE_FRAME_BYTES));
        assert_eq!(config.write_buffer_size, 128 * 1024);
        assert_eq!(config.max_write_buffer_size, usize::MAX);
        assert!(!config.accept_unmasked_frames);
    }

    /// The DEFAULT options install the production transport config — not just
    /// the constants (a constant test passes while a socket still runs
    /// defaults). Exercises the same options→config mapping
    /// [`crate::remote_proxy::CodexRemoteProxy::start`] builds from.
    #[test]
    fn default_proxy_options_install_the_production_transport_config() {
        let options = CodexRemoteProxyOptions::new("ws://127.0.0.1:1", true);
        assert_eq!(options.max_ws_frame_bytes, MAX_WS_FRAME_BYTES);
        assert_eq!(options.max_ws_message_bytes, MAX_WS_MESSAGE_BYTES);
        let installed = options.ws_config();
        let expected = proxy_ws_config();
        assert_eq!(installed.max_frame_size, expected.max_frame_size);
        assert_eq!(installed.max_message_size, expected.max_message_size);
        // The canary/interval plumbing this task lands for later tasks
        // (plan §4.3.1/§4.3.2) carries the plan's defaults.
        assert_eq!(options.canary_warn_bytes, CANARY_BYTES);
        assert_eq!(
            options.canary_min_warn_interval_ms,
            crate::remote_proxy::CANARY_MIN_WARN_INTERVAL_MS
        );
        assert_eq!(
            options.capacity_trigger_min_interval_ms,
            crate::remote_proxy::CAPACITY_TRIGGER_MIN_INTERVAL_MS
        );
    }
}

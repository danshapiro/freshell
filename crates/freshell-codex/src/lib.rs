//! # freshell-codex — the codex `app-server` JSON-RPC/WS client CORE
//!
//! Layer B of the fresh-agent runtime for the **codex** provider (`freshcodex`): the client
//! that drives a spawned `codex … app-server --listen ws://127.0.0.1:<port>` sidecar over a
//! JSON-RPC-2.0-shaped protocol on a WebSocket. A faithful, additive port of
//! `server/coding-cli/codex-app-server/{protocol,client}.ts`, the status-guarded turn
//! completion in `server/fresh-agent/adapters/codex/adapter.ts`, and the codex slice of
//! `shared/fresh-agent-models.ts`.
//!
//! ## Modules
//!
//! | Module | Ports | Role |
//! |---|---|---|
//! | [`protocol`] | `protocol.ts` + `client.ts` framing (`:567-641`) | pure JSON-RPC frame build/parse + typed notification classification + the validated turn-status extractor |
//! | [`app_server`] | `client.ts` | the async client over the injected [`app_server::WsTransport`]: initialize→initialized handshake, thread/turn drive (**effort VERBATIM**), request/response correlation, notification consumer |
//! | [`events`] | `adapter.ts:876-946` + `turn-complete-clock.ts` | the **STATUS-GUARDED** completion edge, thread-status normalization, the monotonic turn-complete clock |
//! | [`model`] | `fresh-agent-models.ts` (codex slice) + `adapter.ts:127-134` | model/effort normalization — **DEV-0003: `none`/`minimal` forwarded verbatim** |
//! | [`durability`] | `durability-store.ts` + `providers/codex.ts:417-421` + `runtime.ts` | codex thread-id (UUID) / rollout-id shapes + sidecar ownership ids (the `/proc` reaper tag) |
//! | [`transport`] | `client.ts` `ws` + `runtime.ts` reaper (behind `real-transport`) | the real `tokio-tungstenite` [`app_server::WsTransport`] + the Linux `/proc` ownership reaper |
//!
//! ## Injected IO (fake-driven, network-free tests)
//!
//! All IO is behind [`app_server::WsTransport`] — the `ws` socket seam from `client.ts`. The
//! CORE (framing, handshake, thread/turn drive, the notification consumer, and the
//! status-guarded completion edge) is unit-tested with the in-memory
//! [`app_server::ChannelTransport`] driven by the committed fake-app-server's message shapes
//! and NO real app-server / NO live API calls. The real backend in [`transport`] is additive
//! production wiring behind the default-off `real-transport` feature (verified to compile;
//! wired live in the next step, T2-over-rust).
//!
//! ## DEV-0003 (REJECTED — `port/oracle/DEVIATIONS.md`)
//!
//! Codex reasoning-effort `none`/`minimal` are VALID codex efforts (`protocol.ts:26`) and are
//! **forwarded VERBATIM** on `turn/start` (`adapter.ts:130-131`). The proposed "clamp
//! none/minimal" fix was rejected with ZERO differ tolerance: any old-vs-new divergence in
//! codex effort handling is a port defect. The seam is [`model::to_codex_reasoning_effort`]
//! and [`app_server::CodexAppServerClient::start_turn`], both pinned by tests here and in
//! `tests/`.

pub mod app_server;
pub mod durability;
pub mod events;
mod json_scan;
pub mod model;
pub mod protocol;
pub mod remote_proxy_envelope;
pub mod remote_proxy_side_effects;

#[cfg(feature = "real-transport")]
pub mod remote_proxy;
#[cfg(feature = "real-transport")]
pub mod transport;

pub use app_server::{
    new_channel_transport, BoxFuture, ChannelPeer, ChannelTransport, CodexAppServerClient,
    CodexAppServerError, StartThreadParams, StartTurnParams, StartedThread, StartedTurn,
    WsTransport, DEFAULT_REQUEST_TIMEOUT_MS,
};
pub use durability::{
    default_durability_store_dir, default_server_instance_id, extract_session_id_from_filename,
    is_codex_thread_id, mint_ownership_id, ownership_needle, CandidateImmutableError,
    DurabilityCandidate, CODEX_SIDECAR_OWNERSHIP_ENV,
};
pub use events::{
    next_monotonic_turn_complete_at, normalize_codex_thread_status, CodexAdapterEvent, CodexStatus,
    CodexSubscription,
};
pub use model::{
    normalize_freshcodex_effort, normalize_freshcodex_model, to_codex_reasoning_effort,
    CodexEffortError, CHEAPEST_T2_MODEL, FRESHCODEX_DEFAULT_EFFORT, FRESHCODEX_DEFAULT_MODEL,
    FRESHCODEX_EFFORTS_VERBATIM,
};
pub use protocol::{
    build_notification_frame, build_request_frame, classify_notification,
    extract_turn_notification_event, parse_client_frame, parse_incoming_frame, turn_status,
    ClientFrame, CodexNotification, CodexTurnEvent, IncomingMessage, RequestId, RpcError,
    TurnNotificationEvent, TURN_STATUSES,
};

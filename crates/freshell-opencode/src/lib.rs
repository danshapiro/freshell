//! # freshell-opencode — the opencode `serve` HTTP/SSE client CORE
//!
//! Layer B of the fresh-agent runtime for the opencode provider: the client that
//! manages an `opencode serve` sidecar (spawn → bounded health wait → session create →
//! send turn → SSE idle edge). A faithful, additive port of
//! `server/fresh-agent/adapters/opencode/{serve-manager,serve-events}.ts` plus the
//! opencode slice of `shared/fresh-agent-models.ts`.
//!
//! ## Modules
//!
//! | Module | Ports | Role |
//! |---|---|---|
//! | [`serve`] | `serve-manager.ts` | the `OpencodeServeManager` — spawn, the **DEV-0001** bounded health wait, HTTP session ops, the SSE idle-edge (`once_idle`) |
//! | [`events`] | `serve-events.ts` + `serve-manager.ts:35-55` | SSE event parse, the idle/activity classifiers, `sdk.*` mapping, the streaming block decoder |
//! | [`model`] | `fresh-agent-models.ts` (opencode slice) + `serve-events.ts:7-12` | model/effort normalization + `provider/model` wire split |
//! | [`transport`] | `fetchFn` / `spawnFn` / SSE (behind `real-transport`) | the real `reqwest` + `tokio::process` backends |
//!
//! ## Injected IO (fake-driven, network-free tests)
//!
//! All IO is behind traits ([`serve::ProcessSpawner`], [`serve::ServeHttp`],
//! [`serve::PortAllocator`], [`serve::EventSource`]) — the reference's `spawnFn` /
//! `fetchFn` / `allocatePort` / `connectEventStream` seams. The CORE logic, the
//! **DEV-0001** bounded-probe fix, and the parsers are unit-tested with fakes and NO
//! real serve / NO live API calls. The real backends in [`transport`] are additive
//! production wiring behind the default-off `real-transport` feature (verified to
//! compile; wired live in the next step, T2-over-rust).
//!
//! ## DEV-0001 (`port/oracle/DEVIATIONS.md`)
//!
//! The reference cold-serve `waitForHealth` issues an **un-timed** `/global/health` GET
//! (`serve-manager.ts:286`) that a cold serve can block past the deadline, defeating the
//! `while (Date.now() < deadline)` bound. The port bounds **each probe** and retries to
//! the unchanged outer deadline; a wedged serve fails as the bounded "did not become
//! healthy" error instead of hanging. Pinned by `tests/serve_health_bounded.rs`.

pub mod events;
pub mod model;
pub mod serve;

#[cfg(feature = "real-transport")]
pub mod transport;

pub use events::{
    is_idle_edge, is_idle_status_event, parse_serve_event, serve_event_to_sdk, ChangedReason,
    ParsedServeEvent, SdkProviderEvent, SnapshotStatus, SseDecoder,
};
pub use model::{
    normalize_opencode_effort, normalize_opencode_model, split_opencode_model, OpencodeModel,
    FRESHOPENCODE_DEFAULT_EFFORT, FRESHOPENCODE_DEFAULT_MODEL,
};
pub use serve::{
    is_healthy_response, CreatedSession, Endpoint, EventSource, EventStreamHandle, ForkedSession,
    OpencodeServeManager, PortAllocator, ProcessSpawner, Route, ServeConfig, ServeDeps, ServeError,
    ServeHttp, ServeHttpRequest, ServeHttpResponse, ServeProcess, SessionSignal, SpawnRequest,
    OPENCODE_SIDECAR_OWNERSHIP_ENV,
};

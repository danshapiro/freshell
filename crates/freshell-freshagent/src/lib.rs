//! # freshell-freshagent — the fresh-agent REST surface (opencode slice)
//!
//! The additive Phase 3.7 wiring that lets the equivalence oracle drive a live
//! opencode/Kimi T2 turn THROUGH the Rust server exactly as it drives the original,
//! and prove `original≡rust` at T2. A faithful port of the opencode path of
//! `server/agent-api/router.ts` (create-tab / send-keys / capture) on top of the
//! [`freshell_opencode`] serve client (`real-transport`).
//!
//! ## Surface (only what the opencode T2 invariant set + baseline need)
//!
//! | Route | Ports | Behaviour |
//! |---|---|---|
//! | `POST /api/tabs {agent:'opencode',…}` | `router.ts:695` + `createFreshAgentPane:546` | mint a `freshopencode-*` placeholder pane (NO serve yet — lazy), broadcast `ui.command{tab.create}`, return `{data:{tabId,paneId,sessionId}}` |
//! | `POST /api/panes/:id/send-keys` | `router.ts:1669` | **cold-start** the `opencode serve` (DEV-0001 fix → NO warm-proxy), create the durable `ses_*`, broadcast `freshAgent.session.materialized` + `sessions.changed`, drive one turn, resolve on the **idle edge** (`status:'idle'`) |
//! | `GET /api/panes/:id/capture` | `router.ts:904` | render the transcript (`listMessages`) as text |
//!
//! ## Cold-start = the DEV-0001 fingerprint
//!
//! The original needs an `OPENCODE_CMD` warm-proxy to step around DEV-0001's cold-serve
//! health-probe wedge. The Rust port carries the fix natively ([`freshell_opencode`]'s
//! bounded per-probe health wait), so the first `send-keys` cold-starts the real serve
//! with **no warm-proxy** — the observable fingerprint the T2-rust test asserts.
//!
//! ## Broadcasts
//!
//! `ui.command` / `freshAgent.session.materialized` / `sessions.changed` are pushed as
//! pre-serialized [`freshell_protocol`] frames onto a shared [`tokio::sync::broadcast`]
//! bus that the `freshell-ws` connections fan out to every client (incl. the oracle's
//! capture socket), so its `wsServerMessageTypes` set matches the original baseline.
//!
//! ## Safety
//!
//! All session data lands under the server's **isolated HOME** (the real `opencode serve`
//! writes `<HOME>/.local/share/opencode/opencode.db`); the user's store is never touched.
//! The spawned serve inherits the server's ownership sentinels and is reaped by
//! [`FreshAgentState::shutdown`] (SIGTERM + the `/proc` ownership sweep) and, as a
//! backstop, by the harness sentinel sweep — no orphans.

pub mod claude;
pub(crate) mod claude_snapshot;
pub mod codex;
pub mod identity_sink;
pub mod layout_store;
pub mod layout_tree;
pub mod model_capabilities;
pub mod opencode_ws;
pub mod pane_ops;
mod pane_resize;
pub mod rename_persistence;
pub mod rollback_record;
pub mod session_lease;
pub mod snapshot;
pub mod spawn_gate;
pub(crate) mod summary;
pub mod target_resolver;
pub mod terminal_tabs;

pub use claude::FreshClaudeState;
// Kata 09v1 + SYNC-06: the TWO claude_snapshot items visible outside this
// crate — the raw-file existence check freshell-server's IndexExistenceProbe
// shares with the attach arm, and the original-cwd reader the resume-resolve
// claude fallback pairs with it (`claude-transcript-locator.ts` parity).
// Keep the rest of claude_snapshot crate-private.
pub use claude_snapshot::{
    locate_transcript, locate_transcript_checked, transcript_cwd, transcript_cwd_bounded,
    transcript_cwd_checked,
};
pub use codex::FreshCodexState;
pub use identity_sink::{
    FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, SharedPaneIdentitySink,
    SinkWrite,
};
pub use opencode_ws::FreshOpencodeState;
pub use rename_persistence::{BoxFuture, RenamePersistence, SYNCABLE_TERMINAL_MODES};
pub use rollback_record::{
    now_ms, rollback_ack_frame, rollback_broadcast_frame, rollback_error_frame, RollbackDirection,
    RollbackEntry, RollbackModeReq, RollbackRecord, RollbackRequest, CODEX_OLD_CLI_COPY,
    LEDGER_WRITE_REFUSAL_COPY, OPENCODE_OLD_CLI_COPY, REDO_DESTROYED_MESSAGE, REDO_EMPTY_MESSAGE,
    REDO_REMOVED_HISTORY_COPY, ROLLBACK_BUSY_MESSAGE, ROLLBACK_RECORD_VERSION, UNDO_EMPTY_MESSAGE,
};
pub use snapshot::SnapshotState;
pub use spawn_gate::{SpawnGate, SpawnGateError};

/// Task 13b: the injected cross-kind liveness probe -- `(provider, session_id) -> bool`,
/// true when a live terminal PTY currently owns that session. Constructed by
/// `freshell-server`'s `main.rs` over the SAME probes the terminal D7 create-rung guard
/// uses (identity owner + registry row), so this crate never imports `freshell-ws`.
/// Defaults to "always false" (behavior-preserving for constructors that don't wire it).
pub type TerminalLivenessProbe = std::sync::Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// Door 3 (resume-validation): the gate-fired callback shape --
/// `(provider, stale_session_id)`. In production, `freshell-server`'s main.rs
/// implements it as pane-ledger `retire_missing` + `tracing::warn!`.
pub type OnStaleResume = std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Door 3 (resume-validation): the injected ASYNC sidecar-liveness probe --
/// `(mode, session_id) -> is that session live inside a fresh-agent sidecar`.
/// The REST create gate's registry consult is `TerminalRegistry`/PTY-scoped
/// and structurally BLIND to sessions live inside the fresh-agent sidecars
/// (sidecars never get PTY rows), so the in-gate liveness precondition needs
/// this second arm. Precedent: [`TerminalLivenessProbe`] solves the SAME
/// cross-crate liveness problem in the opposite direction -- same shape, made
/// async. Constructed by `freshell-server`'s `main.rs` over the SAME sidecar
/// instances the WS door's D7 join consults, so this crate never imports
/// `freshell-ws`. `None` (not wired, e.g. bare unit-test states) => the arm
/// contributes false.
pub type SidecarLivenessProbe = std::sync::Arc<
    dyn Fn(&str, &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// Handle pairing the shared gate with the permit-wait timeout
/// (`CreateProtectConfig.spawn_timeout_ms`, resolved once in main.rs so both
/// doors share one env snapshot).
#[derive(Clone)]
pub(crate) struct RestSpawnGate {
    pub(crate) gate: Arc<spawn_gate::SpawnGate>,
    pub(crate) timeout: std::time::Duration,
}

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use freshell_opencode::transport::{
    LoopbackPortAllocator, ReqwestEventSource, ReqwestServeHttp, TokioProcessSpawner,
};
use freshell_opencode::{
    normalize_opencode_effort, normalize_opencode_model, OpencodeServeManager, ServeConfig,
    ServeDeps, ServeError,
};
use freshell_protocol::{
    FreshAgentEvent, FreshAgentSessionMaterialized, ServerMessage, SessionLocator, SessionsChanged,
    UiCommand, LEGACY_RESUME_IDENTITY_REFUSAL,
};

use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO};

/// The opencode fresh-agent `sessionType` (`AGENT_SESSION_TYPES.opencode`, `router.ts:541`).
const SESSION_TYPE: &str = "freshopencode";
/// The runtime provider (`AGENT_SESSION_TYPES.opencode.provider`).
const PROVIDER: &str = "opencode";
/// `makePlaceholderSessionId(requestId)`'s prefix (`adapter.ts:75`, mirrored by
/// `create_tab` above and `opencode_ws::handle_create`): this port's ONE placeholder-id
/// format, `format!("freshopencode-{request_id}")`. By construction, an id with this shape
/// is never a real opencode `serve` session id (those are `ses_*`) -- see
/// [`FreshAgentState::get_opencode_snapshot`]'s Fix Task #3 short-circuit.
pub(crate) const OPENCODE_PLACEHOLDER_PREFIX: &str = "freshopencode-";
/// Fallback turn idle budget when `send-keys` carries no `timeout` (matches the harness's
/// generous Kimi budget; the request always supplies one in the oracle path).
const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(180);

/// The resume probe's bounded `get_session` budget resolution, extracted pure
/// (delta-r2 Fix 3 — the state-injection timeout tests prove boundedness; the
/// lib tests pin THE KNOB's parsing/default without ever mutating process
/// env). Layers, in order: `state_override` (the cfg(test) seam) >
/// `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` (the raw env string, read by the
/// caller) > 10_000ms default — the SAME env-parse semantics the WS resume
/// door applies (`opencode_ws.rs`); both doors resolve through this ONE
/// function so they can never drift. A `u64` parse rejects empty, garbage,
/// negative, overflowing, and whitespace-padded values alike; they all fall
/// to the default.
pub(crate) fn resolve_probe_timeout_ms(state_override: Option<u64>, env_raw: Option<&str>) -> u64 {
    if let Some(ms) = state_override {
        return ms;
    }
    env_raw
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(10_000u64)
}

/// Shared, cheaply-cloneable fresh-agent REST state (mergeable into the server app).
#[derive(Clone)]
pub struct FreshAgentState {
    auth_token: Arc<String>,
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection. `ui.command` / `freshAgent.session.materialized` /
    /// `sessions.changed` are pushed here.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// paneId → pane record (placeholder id, cwd, model/effort, durable id).
    panes: Arc<Mutex<HashMap<String, PaneEntry>>>,
    /// The single lazily-started `opencode serve` client for this server process.
    opencode: Arc<tokio::sync::Mutex<Option<OpencodeServeManager>>>,
    /// Monotonic `sessions.changed` revision.
    sessions_revision: Arc<AtomicI64>,
    /// Slice 1 (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`): the SAME
    /// terminal registry the WS `terminal.create` path uses, wired in from
    /// `freshell-server`'s `main.rs` via [`Self::with_terminal_registry`].
    /// `None` until wired -- every existing opencode-only test keeps working
    /// unchanged (terminal-mode routes 503 instead of touching a registry
    /// that was never given to them).
    pub(crate) terminal_registry: Option<freshell_terminal::TerminalRegistry>,
    /// Read-only session-identity lookup (in production: the WS-side
    /// TerminalIdentityRegistry behind the freshell-terminal
    /// SessionIdentityLookup seam, wired by freshell-server). Powers the
    /// identity arm of the REST D7 live-session guard. `None` (unwired)
    /// narrows the guard to the registry-row arm.
    pub(crate) session_identity:
        Option<Arc<dyn freshell_terminal::registry::SessionIdentityLookup>>,
    /// Write-side pane-identity seam (kata hbsa): lets the REST spawn
    /// pipeline write TerminalIdentityRegistry rows and PaneLedger bindings
    /// across the freshagent->ws crate boundary. Read-side twin:
    /// `session_identity`. `None` (tests without identity concerns) = the
    /// legacy no-write behavior.
    pub(crate) pane_identity: Option<Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>,
    /// paneId -> terminal pane record (Slice 1 `mode:'shell'` terminals
    /// created via `POST /api/tabs`). Disjoint from `panes` (fresh-agent-only)
    /// and `content_panes` (browser/editor) -- a pane id appears in exactly
    /// one of the three maps.
    pub(crate) terminal_panes: Arc<Mutex<HashMap<String, TerminalPaneEntry>>>,
    /// paneId -> browser/editor `paneContent` JSON (Slice 1's "cheap" content
    /// kinds -- no process, just the content the client folds via
    /// `ui.command{tab.create}`).
    pub(crate) content_panes: Arc<Mutex<HashMap<String, Value>>>,
    /// tabId -> legacy shadow record. `GET /api/tabs` reads the LayoutStore
    /// (AUTO-03), not this map; it remains only as `delete_tab`'s cleanup
    /// gate and `rename_tab`'s title mirror.
    pub(crate) tabs: Arc<Mutex<HashMap<String, TabRecord>>>,
    /// Slice 3b-1 (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`
    /// \u00a72.2 pane routes): paneId -> owning tabId, the reverse index
    /// `pane_ops`'s split/close/select handlers need to resolve a pane's tab
    /// without a full server-side layout tree (see `rename_pane`'s doc
    /// comment for why this port keeps no such tree). Populated by EVERY
    /// pane-minting call site (fresh-agent `create_tab`, `terminal_tabs`'s
    /// `create_content_tab`/`create_terminal_tab`/`spawn_terminal_pane`, and
    /// `pane_ops::split_pane`), so a pane created by ANY path is resolvable
    /// here -- this is the one piece of bookkeeping this slice adds to the
    /// pre-existing per-kind maps (`terminal_panes`/`content_panes`/`panes`)
    /// rather than duplicating tab-membership tracking inside each of them.
    pub(crate) pane_tabs: Arc<Mutex<HashMap<String, String>>>,
    /// restoreKey -> what a `restoreKey`-tagged create produced (continuity
    /// trio, `tabs_snapshots.rs:632`). The tabs-sync restore path tags every
    /// `POST /api/tabs`-pipeline create it drives with a DETERMINISTIC key so
    /// a retry can reconcile a create whose write-ahead marker promotion never
    /// landed (the crash window between the pre-create marker write and the
    /// post-create terminalId record). In-memory only: after a full process
    /// restart in-process terminals are dead anyway, and the restore path
    /// treats a missing key accordingly (recreate terminals; fail-loud for
    /// browser/editor panes it cannot prove undelivered).
    pub(crate) restore_keys: Arc<Mutex<HashMap<String, RestoreKeyEntry>>>,
    /// Slice 3a (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md): the
    /// registered coding-CLI command specs (claude/codex/opencode/gemini/
    /// kimi/amplifier/...), the SAME list `freshell_ws::WsState::cli_commands`
    /// resolves `terminal.create { mode: <cli> }` against -- wired in from
    /// `freshell-server`'s `main.rs` via [`Self::with_cli_commands`]. Empty
    /// until wired, matching every other Slice-1/3a field's "`None`/empty ==
    /// route degrades honestly instead of touching data it was never given"
    /// convention.
    pub(crate) cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    /// The SAME opencode session locator the WS `terminal.create` path arms
    /// (`freshell_ws::opencode_association::maybe_arm`), wired in from
    /// `freshell-server`'s main.rs via [`Self::with_opencode_locator`] so a
    /// REST-created fresh opencode pane arms the identical instance the
    /// periodic sweep (spawned once, against `WsState`, at boot) already
    /// polls -- association/broadcast parity falls out of sharing the one
    /// locator rather than standing up a second sweep loop this crate would
    /// have no way to drive (the sweep's `identity.upsert` target,
    /// `freshell_ws::identity::TerminalIdentityRegistry`, is `freshell-ws`-
    /// owned and unreachable here without a circular crate dependency).
    /// `None` when unwired (every pre-existing test).
    pub(crate) opencode_locator: Option<Arc<freshell_sessions::opencode_locator::OpencodeLocator>>,
    /// Sibling to [`Self::opencode_locator`] for the P1.14 / Incident-4
    /// codex hardening -- the SAME shared instance the WS
    /// `codex_association` entry points arm and the B2 sweep polls.
    pub(crate) codex_locator:
        Option<std::sync::Arc<freshell_sessions::codex_locator::CodexLocator>>,
    /// P1.13 identity-event sink (the pane-ledger bridge, [`identity_sink`]).
    /// Clone-shared + set-once: the state is cloned into consumer tasks, so
    /// the `OnceLock` sits behind an `Arc`. Wired post-construction by
    /// `freshell-server` (precedent: `TerminalRegistry::set_activity_observer`).
    identity_sink: Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
    /// Server-wide PTY spawn gate — the SAME instance the WS terminal.create
    /// path uses (ONE global concurrency budget; see
    /// docs/plans/2026-07-27-rest-spawn-gate.md). Clone-shared + set-once,
    /// wired post-construction by freshell-server (same shape as
    /// `identity_sink`). `None` = ungated (unwired unit tests keep legacy
    /// behavior; production always wires it).
    spawn_gate: Arc<std::sync::OnceLock<RestSpawnGate>>,
    /// Door 3 (resume-validation): the disk-existence probe consulted before
    /// a REST create turns a cached resume id into resume argv. Injected as
    /// [`freshell_platform::resume_gate::ResumeProbeFn`] because this crate
    /// must NOT depend on `freshell-ws` (whose probe trait would be circular
    /// -- see this Cargo.toml's freshell-sessions comment). `None` = feature
    /// off = today's behavior (every pre-existing test).
    pub(crate) resume_probe: Option<freshell_platform::resume_gate::ResumeProbeFn>,
    /// Door 3: called with `(provider, stale_session_id)` when the gate
    /// fires. `freshell-server`'s main.rs implements it as pane-ledger
    /// `retire_missing` + `tracing::warn!`. `None` = no-op.
    pub(crate) on_stale_resume: Option<OnStaleResume>,
    /// Door 3: arm 2 of the in-gate liveness precondition (see
    /// [`SidecarLivenessProbe`]). `None` = arm contributes false.
    pub(crate) sidecar_liveness: Option<SidecarLivenessProbe>,
    /// The shared server-side layout snapshot (AUTO-01 spine, Task 13): the
    /// WS `ui.layout.sync` ingestion (`freshell_ws::terminal`'s
    /// `ClientMessage::UiLayoutSync` arm) REPLACES it, and the REST
    /// automation surface (Tasks 14-16) reads/mutates the SAME store.
    /// `freshell-server`'s `main.rs` constructs ONE instance and wires it
    /// into both this state (via [`Self::with_layout`]) and
    /// `freshell_ws::WsState::layout`. A fresh `Default` store (empty, no
    /// snapshot) everywhere it isn't wired, matching the other Slice-1/3a
    /// fields' "unwired == degrades honestly" convention.
    pub layout: layout_store::LayoutStore,
    /// Task 16 (`PATCH /api/panes/:id` cascade): the injected `configStore`
    /// seam (`persistSyncableTerminalRename`'s terminal/session override
    /// writes, `router.ts:681-683`) — `freshell-server`'s `main.rs` wires its
    /// `SettingsRenamePersistence` here via [`Self::with_rename_persistence`].
    /// `None` until wired (the `amplifier_locator` Option-until-wired
    /// convention): the rename still lands in the layout store, only the
    /// persistence cascade is skipped (Node's own `!configStore` guard,
    /// `router.ts:668`).
    pub(crate) rename_persistence: Option<Arc<dyn rename_persistence::RenamePersistence>>,
    /// Task 16: the SAME handler-scoped `terminals.changed` revision counter
    /// the WS lifecycle + REST `/api/terminals` broadcasts stamp (`main.rs`),
    /// wired via [`Self::with_shared_terminals_revision`] so the rename
    /// cascade's broadcast draws from the ONE monotonic sequence. `None`
    /// until wired — the cascade then skips the broadcast honestly.
    pub(crate) terminals_revision: Option<Arc<AtomicI64>>,
    /// Fix round 1 (Task 23 gap): the injectable post-create seam Node covers
    /// with the registry's `'terminal.created'` EVENT (`server/index.ts:647-655`
    /// -> `seedFromTerminal` for EVERY terminal, REST creates included). The
    /// Rust registry has no such event mechanism, and the meta store
    /// (`freshell_ws::terminal_meta::TerminalMetaRegistry`) is unreachable
    /// from this crate (`freshell-ws` depends on THIS crate, not vice versa
    /// -- the same constraint `spawn_terminal_pane`'s exit hook documents for
    /// `identity.retire`). So `freshell-server`'s `main.rs` -- where both
    /// crates are visible -- wires a closure here (via
    /// [`Self::with_terminal_created_hook`]) that runs the SAME create-time
    /// meta seed -> async git enrich -> `terminal.meta.updated` broadcast the
    /// WS `terminal.create` path gets. Fired by
    /// [`terminal_tabs::spawn_terminal_pane`] after every successful
    /// REST-pipeline create (tab create, pane split, restore). `None` until
    /// wired (the `rename_persistence` convention): creates proceed, only the
    /// meta seeding is skipped.
    pub(crate) terminal_created_hook: Option<TerminalCreatedHook>,
    /// The `GET`/`POST /api/fresh-agent/model-capabilities/*` registry
    /// ([`model_capabilities`]): cwd-keyed TTL cache + single-flight coalescing
    /// over the transient opencode catalog probe, plus the static codex/claude
    /// catalogs. Constructed with the REAL transport probe in
    /// [`Self::new`] (there is no wiring ceremony — unlike the Option-until-
    /// wired fields above, production construction is unconditional); tests
    /// install a scripted probe via [`Self::with_model_capability_probe`].
    pub(crate) model_capabilities: Arc<model_capabilities::ModelCapabilityRegistry>,
    /// Task 4 test seam: the REST resume probe's `get_session` budget override
    /// (a wedged fake serve must NEVER wait the real 10s). Production
    /// resolution reads the same `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`
    /// env var the WS resume door parses, default 10_000ms — the override is
    /// consulted BEFORE the env parse by [`Self::resume_probe_budget_ms`].
    /// Configured via [`Self::set_resume_probe_timeout_ms_for_test`].
    #[cfg(test)]
    resume_probe_timeout_ms: Arc<Mutex<Option<u64>>>,
}

/// What [`terminal_tabs::spawn_terminal_pane`] hands the injected
/// terminal-created hook: the create-time identity Node's `seedFromTerminal`
/// reads off the registry record (`terminal-metadata-service.ts:138-146`).
/// `cwd` is the RESOLVED spawn cwd (what the registry record carries), not
/// the raw request field.
#[derive(Clone, Debug)]
pub struct TerminalCreatedEvent {
    pub terminal_id: String,
    pub mode: String,
    pub resume_session_id: Option<String>,
    pub cwd: Option<String>,
}

/// The injectable post-create hook (see
/// [`FreshAgentState::with_terminal_created_hook`]). Must be cheap and
/// non-blocking on the create path -- the production wiring only builds a
/// meta record and `tokio::spawn`s the git enrichment.
pub type TerminalCreatedHook = Arc<dyn Fn(TerminalCreatedEvent) + Send + Sync>;

/// A fresh-agent pane (the `paneContent` subset the opencode T2 path needs).
#[derive(Clone)]
struct PaneEntry {
    placeholder_id: String,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// The durable `ses_*` id after the first turn materializes it.
    durable_id: Option<String>,
}

/// A Slice-1 terminal pane's record: just enough to dispatch `send-keys` /
/// `capture` / `wait-for` to the right `terminal_id` in the shared registry.
#[derive(Clone)]
pub(crate) struct TerminalPaneEntry {
    pub(crate) terminal_id: String,
}

/// What a `restoreKey`-tagged create produced (continuity trio,
/// `tabs_snapshots.rs:632`): the minted tab/pane ids plus the spawned
/// terminal id (None for the no-process browser/editor content kinds), the
/// replayable create command, and the connections that received it.
#[derive(Clone, Debug)]
pub struct RestoreKeyEntry {
    pub tab_id: String,
    pub pane_id: String,
    pub terminal_id: Option<String>,
    pub ui_command: ServerMessage,
    pub delivered_to: HashSet<u64>,
}

/// Legacy per-tab shadow record. NOT the `GET /api/tabs` row -- that reads
/// the shared LayoutStore (AUTO-03). Load-bearing only for `pane_ops`:
/// `rename_tab` mirrors the title here, and `delete_tab` gates its legacy
/// shadow-map cleanup on this record's presence.
#[derive(Clone)]
pub(crate) struct TabRecord {
    pub(crate) title: Option<String>,
}

impl FreshAgentState {
    /// Build the state around the shared broadcast bus the WS connections fan out.
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ) -> Self {
        Self {
            auth_token,
            broadcast_tx,
            panes: Arc::new(Mutex::new(HashMap::new())),
            opencode: Arc::new(tokio::sync::Mutex::new(None)),
            sessions_revision: Arc::new(AtomicI64::new(0)),
            terminal_registry: None,
            session_identity: None,
            pane_identity: None,
            terminal_panes: Arc::new(Mutex::new(HashMap::new())),
            content_panes: Arc::new(Mutex::new(HashMap::new())),
            tabs: Arc::new(Mutex::new(HashMap::new())),
            pane_tabs: Arc::new(Mutex::new(HashMap::new())),
            restore_keys: Arc::new(Mutex::new(HashMap::new())),
            cli_commands: Arc::new(Vec::new()),
            opencode_locator: None,
            codex_locator: None,
            identity_sink: Arc::new(std::sync::OnceLock::new()),
            spawn_gate: Arc::new(std::sync::OnceLock::new()),
            resume_probe: None,
            on_stale_resume: None,
            sidecar_liveness: None,
            layout: layout_store::LayoutStore::default(),
            rename_persistence: None,
            terminals_revision: None,
            terminal_created_hook: None,
            model_capabilities: Arc::new(model_capabilities::ModelCapabilityRegistry::new(
                Arc::new(model_capabilities::OpencodeCatalogProbe::default()),
            )),
            #[cfg(test)]
            resume_probe_timeout_ms: Arc::new(Mutex::new(None)),
        }
    }

    /// Install a scripted model-catalog probe (tests) — the registry's
    /// `opencodeCatalogProvider` injection seam
    /// (`model-capability-registry.ts:196-202`). Rebuilds the registry around
    /// the replacement probe; any prior cache entries are discarded with it.
    pub fn with_model_capability_probe(
        mut self,
        probe: Arc<dyn model_capabilities::ModelCatalogProbe>,
    ) -> Self {
        self.model_capabilities = Arc::new(model_capabilities::ModelCapabilityRegistry::new(probe));
        self
    }

    /// Wire the P1.13 identity-event sink (set-once; later calls are no-ops).
    pub fn set_identity_sink(&self, sink: SharedPaneIdentitySink) {
        let _ = self.identity_sink.set(sink);
    }

    /// The wired identity sink, if any. Used by the REST send-keys
    /// materialization site ([`send_keys`]'s cold-start block).
    fn identity_sink(&self) -> Option<SharedPaneIdentitySink> {
        self.identity_sink.get().cloned()
    }

    /// Wire the server-wide spawn gate (set-once; later calls are no-ops).
    /// `timeout` bounds PERMIT ACQUISITION only, not spawn duration —
    /// identical semantics to the WS door.
    pub fn set_spawn_gate(&self, gate: Arc<spawn_gate::SpawnGate>, timeout: std::time::Duration) {
        let _ = self.spawn_gate.set(RestSpawnGate { gate, timeout });
    }

    /// The wired spawn gate, if any. `None` = ungated (unwired test states).
    pub(crate) fn spawn_gate(&self) -> Option<RestSpawnGate> {
        self.spawn_gate.get().cloned()
    }

    /// Boot-assertion probe (council enn3 follow-up): the spawn-gate
    /// OnceLock is a fail-OPEN seam — unwired means every REST create runs
    /// ungated. `freshell-server` asserts this at startup so a wiring
    /// regression fails LOUD at boot instead of silently ungating.
    pub fn spawn_gate_wired(&self) -> bool {
        self.spawn_gate.get().is_some()
    }

    /// Record what a `restoreKey`-tagged create produced (continuity trio,
    /// `tabs_snapshots.rs:632`). Called by `terminal_tabs`'s create paths
    /// immediately after the tab/pane maps are populated, so a restore retry
    /// in this SAME process can reconcile a create whose write-ahead marker
    /// promotion never landed (crash window between the pre-create marker
    /// write and the post-create terminalId record).
    pub(crate) fn record_restore_key(&self, key: &str, entry: RestoreKeyEntry) {
        self.restore_keys
            .lock()
            .expect("restore_keys mutex")
            .insert(key.to_string(), entry);
    }

    /// Look up what a prior `restoreKey`-tagged create produced in THIS
    /// process (`None` after a process restart — in-process terminals died
    /// with the process, so the restore path treats absence accordingly).
    pub fn lookup_restore_key(&self, key: &str) -> Option<RestoreKeyEntry> {
        self.restore_keys
            .lock()
            .expect("restore_keys mutex")
            .get(key)
            .cloned()
    }

    /// Record a synchronous targeted send. Restore serializes calls and invokes
    /// this immediately after `send_to_client` returns, before any await point.
    pub fn mark_restore_key_delivered(&self, key: &str, connection_id: u64) {
        if let Some(entry) = self
            .restore_keys
            .lock()
            .expect("restore_keys mutex")
            .get_mut(key)
        {
            entry.delivered_to.insert(connection_id);
        }
    }

    /// Retire a stale no-process content tab before force creates its
    /// replacement. Terminal entries are never retired through this path.
    pub fn retire_restore_key_content(&self, key: &str) -> Option<RestoreKeyEntry> {
        let entry = {
            let mut restore_keys = self.restore_keys.lock().expect("restore_keys mutex");
            let entry = restore_keys
                .get(key)
                .filter(|entry| entry.terminal_id.is_none())?
                .clone();
            restore_keys.remove(key);
            entry
        };
        self.content_panes
            .lock()
            .expect("content_panes mutex")
            .remove(&entry.pane_id);
        self.pane_tabs
            .lock()
            .expect("pane_tabs mutex")
            .remove(&entry.pane_id);
        self.tabs.lock().expect("tabs mutex").remove(&entry.tab_id);
        Some(entry)
    }

    /// Reissue a restore-owned terminal tab while keeping both its live PTY and
    /// its original tab/pane identity. Those ids were injected into the child
    /// as immutable `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` values at spawn, so a
    /// forced replay must close and recreate the same client identity.
    pub fn reissue_restore_key_terminal(&self, key: &str) -> Option<(String, RestoreKeyEntry)> {
        let mut replacement = self.lookup_restore_key(key)?;
        replacement.terminal_id.as_ref()?;
        let original_tab_id = replacement.tab_id.clone();
        replacement.delivered_to.clear();
        self.restore_keys
            .lock()
            .expect("restore_keys mutex")
            .insert(key.to_string(), replacement.clone());
        Some((original_tab_id, replacement))
    }

    /// Slice 3a: wire in the SAME registered coding-CLI command specs the WS
    /// `terminal.create` path resolves `mode` against
    /// (`freshell_ws::WsState::cli_commands`) -- so `POST /api/tabs` with
    /// `mode:"claude"/"codex"/"gemini"/"kimi"/"opencode"/"amplifier"` accepts
    /// the SAME set of modes the WS create path does, generically (no
    /// hardcoded mode list to drift out of sync). `freshell-server`'s
    /// `main.rs` calls this once at boot with the same `Arc` `WsState` holds.
    pub fn with_cli_commands(
        mut self,
        cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    ) -> Self {
        self.cli_commands = cli_commands;
        self
    }

    /// Slice 3a (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`): wire
    /// in the SAME [`freshell_sessions::opencode_locator::OpencodeLocator`]
    /// the WS `terminal.create` path arms, so a REST-created fresh opencode
    /// pane is armed in the identical instance the already-running periodic
    /// sweep polls. `freshell-server`'s `main.rs` calls this once at boot
    /// with the same `Arc` (or `None`) `WsState` holds.
    pub fn with_opencode_locator(
        mut self,
        locator: Option<Arc<freshell_sessions::opencode_locator::OpencodeLocator>>,
    ) -> Self {
        self.opencode_locator = locator;
        self
    }

    /// Sibling to [`Self::with_opencode_locator`] for the P1.14 /
    /// Incident-4 codex hardening's [`freshell_sessions::codex_locator::CodexLocator`].
    pub fn with_codex_locator(
        mut self,
        locator: Option<std::sync::Arc<freshell_sessions::codex_locator::CodexLocator>>,
    ) -> Self {
        self.codex_locator = locator;
        self
    }

    /// AUTO-01 spine (Task 13): wire in the SAME
    /// [`layout_store::LayoutStore`] `freshell_ws::WsState::layout` holds,
    /// so the WS `ui.layout.sync` ingestion and this crate's REST
    /// automation surface (Tasks 14-16) share ONE snapshot.
    /// `freshell-server`'s `main.rs` calls this once at boot. Mirrors the
    /// established `with_terminal_registry` builder pattern.
    pub fn with_layout(mut self, layout: layout_store::LayoutStore) -> Self {
        self.layout = layout;
        self
    }

    /// Task 16 (`PATCH /api/panes/:id` cascade): wire in the production
    /// [`RenamePersistence`] (`freshell-server`'s `SettingsRenamePersistence`
    /// over the live settings store). Unwired == the rename route still
    /// renames the store and broadcasts `ui.command{pane.rename}`, it just
    /// skips the syncable-terminal persistence cascade.
    pub fn with_rename_persistence(mut self, persistence: Arc<dyn RenamePersistence>) -> Self {
        self.rename_persistence = Some(persistence);
        self
    }

    /// Fix round 1 (Task 23 gap): wire the post-create hook `freshell-server`
    /// uses to run the WS-parity meta seed -> async git enrich ->
    /// `terminal.meta.updated` broadcast for every REST-pipeline create (see
    /// the field doc for why this seam exists). Unwired == creates proceed,
    /// meta seeding skipped. Mirrors [`Self::with_rename_persistence`].
    pub fn with_terminal_created_hook(mut self, hook: TerminalCreatedHook) -> Self {
        self.terminal_created_hook = Some(hook);
        self
    }

    /// Task 16: share the ONE handler-scoped `terminals.changed` revision
    /// counter (`main.rs`'s `terminals_revision`, also stamped by the WS
    /// lifecycle and REST `/api/terminals` broadcasts) so the rename
    /// cascade's `terminals.changed` never regresses the client's
    /// revision watermark. Mirrors [`Self::with_shared_sessions_revision`].
    pub fn with_shared_terminals_revision(mut self, revision: Arc<AtomicI64>) -> Self {
        self.terminals_revision = Some(revision);
        self
    }

    /// Slice 1 (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a79 Risk 1):
    /// wire in the SAME [`freshell_terminal::TerminalRegistry`] the WS
    /// `terminal.create` path uses, so Agent-API-created terminals live in ONE
    /// registry -- no orphan PTYs. `freshell-server`'s `main.rs` calls this
    /// once at boot. Mirrors the established `with_shared_sessions_revision`
    /// builder pattern.
    pub fn with_terminal_registry(mut self, registry: freshell_terminal::TerminalRegistry) -> Self {
        self.terminal_registry = Some(registry);
        self
    }

    /// D7 live-session guard (REST rung): wire in the read-only
    /// session-identity lookup (in production the WS-side
    /// `TerminalIdentityRegistry`, injected by `freshell-server`'s `main.rs`)
    /// so `spawn_terminal_pane` can probe the identity arm of
    /// [`freshell_terminal::TerminalRegistry::live_session_owner`]. Unwired
    /// (`None`), the guard degrades to the registry-row arm only.
    pub fn with_session_identity(
        mut self,
        identity: Arc<dyn freshell_terminal::registry::SessionIdentityLookup>,
    ) -> Self {
        self.session_identity = Some(identity);
        self
    }

    /// Write-side twin of [`Self::with_session_identity`] (kata hbsa): wire
    /// in the pane-identity binder so the REST spawn pipeline
    /// (`spawn_terminal_pane` -> `settle_gated_create`) can write identity
    /// rows and durable ledger bindings exactly like the WS create path.
    /// Unwired (`None`), REST creates keep the legacy no-write behavior.
    pub fn with_pane_identity_binder(
        mut self,
        binder: Arc<dyn freshell_terminal::registry::PaneIdentityBinder>,
    ) -> Self {
        self.pane_identity = Some(binder);
        self
    }

    /// Door 3 (resume-validation): wire the disk-existence probe the REST
    /// create pipeline consults before turning a cached resume id into
    /// resume argv. `freshell-server`'s main.rs builds it over the SAME
    /// `SessionExistenceProbe` the WS doors use. Unwired = feature off =
    /// today's behavior.
    pub fn with_resume_probe(
        mut self,
        probe: freshell_platform::resume_gate::ResumeProbeFn,
    ) -> Self {
        self.resume_probe = Some(probe);
        self
    }

    /// Door 3: wire the gate-fired callback (`(provider, stale_session_id)`),
    /// implemented by `freshell-server`'s main.rs as pane-ledger
    /// `retire_missing` + `tracing::warn!`.
    pub fn with_on_stale_resume(mut self, cb: OnStaleResume) -> Self {
        self.on_stale_resume = Some(cb);
        self
    }

    /// Door 3: wire arm 2 of the in-gate liveness precondition (see
    /// [`SidecarLivenessProbe`]). MUST stay a consuming `with_*` builder like
    /// its siblings, NOT a `set_*`/`OnceLock` late-bind: `FreshOpencodeState`
    /// holds a `FreshAgentState` clone by value, so a late-bound handle back
    /// to the sidecars would create a real Arc cycle.
    pub fn with_sidecar_liveness(mut self, probe: SidecarLivenessProbe) -> Self {
        self.sidecar_liveness = Some(probe);
        self
    }

    /// SESSION-09 fix-forward: replace this state's own `sessions_revision`
    /// counter with a SHARED one -- in production, `freshell-server` wires
    /// this to the SAME `Arc<AtomicI64>` as `freshell_ws::WsState::sessions_revision`
    /// (the periodic session-directory sweep's counter), so this crate's
    /// `sessions.changed` emission (`broadcast_sessions_changed`) and that
    /// sweep draw from ONE monotonic sequence instead of two independent
    /// ones. Without this, the client's "accept only if revision increases"
    /// watermark (`src/App.tsx:924-932`) can silently drop a real change from
    /// one producer behind a lower-or-equal revision from the other.
    pub fn with_shared_sessions_revision(mut self, shared: Arc<AtomicI64>) -> Self {
        self.sessions_revision = shared;
        self
    }

    /// Reap the opencode serve sidecar (SIGTERM/SIGKILL + the `/proc` ownership sweep).
    /// Called on server shutdown so the spawned serve leaves no orphan.
    pub async fn shutdown(&self) {
        let manager = self.opencode.lock().await.take();
        if let Some(manager) = manager {
            manager.shutdown().await;
        }
    }

    /// Shared with [`opencode_ws::FreshOpencodeState`] (same crate root), which pushes
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.session.materialized`
    /// / `freshAgent.killed` onto the SAME bus this REST slice uses.
    /// SESSION-09 fix-forward: bump the (possibly-shared, see
    /// `with_shared_sessions_revision`) `sessions_revision` counter and
    /// broadcast the resulting `sessions.changed` frame. Extracted from the
    /// durable-session materialization call site so the counter-unification
    /// fix is independently unit-testable without driving a full opencode
    /// `send-keys` turn.
    pub(crate) fn broadcast_sessions_changed(&self) {
        let revision = self.sessions_revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.broadcast(&ServerMessage::SessionsChanged(SessionsChanged {
            revision,
        }));
    }

    pub(crate) fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            // A send with no live receivers is fine (returns Err) — the capture socket
            // subscribed before the handshake, so it will observe every broadcast.
            let _ = self.broadcast_tx.send(frame);
        }
    }

    /// Get-or-create the single serve client. `ServeConfig::default()` reads `OPENCODE_CMD`
    /// (unset in the cold-start path → the real `opencode` binary). Cheap `Arc` clone.
    ///
    /// `pub(crate)` so [`opencode_ws::FreshOpencodeState`] reuses THIS ONE manager cell
    /// instead of constructing its own — the "never spawn a second `opencode serve`
    /// sidecar" invariant PR-2 depends on.
    pub(crate) async fn ensure_manager(&self) -> OpencodeServeManager {
        let mut guard = self.opencode.lock().await;
        if let Some(manager) = guard.as_ref() {
            return manager.clone();
        }
        let deps = ServeDeps {
            spawner: Arc::new(TokioProcessSpawner),
            http: Arc::new(ReqwestServeHttp::new()),
            ports: Arc::new(LoopbackPortAllocator),
            events: Arc::new(ReqwestEventSource::new()),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        *guard = Some(manager.clone());
        manager
    }

    /// Test-only: seed the manager cell with a fake-backed [`OpencodeServeManager`] so
    /// [`opencode_ws`]'s unit tests can drive `ensure_manager()` deterministically, with
    /// NO real `opencode` process spawned.
    #[cfg(test)]
    pub(crate) async fn set_manager_for_test(&self, manager: OpencodeServeManager) {
        *self.opencode.lock().await = Some(manager);
    }

    /// Task 4 test seam: bound the REST resume probe's `get_session` budget
    /// WITHOUT touching the process-global `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`
    /// env var — an existing opencode_ws.rs test already sets/removes that var
    /// unsynchronized, and parallel tokio tests would race it. Consulted BEFORE
    /// the env parse by [`Self::resume_probe_budget_ms`].
    #[cfg(test)]
    pub(crate) fn set_resume_probe_timeout_ms_for_test(&self, ms: u64) {
        *self
            .resume_probe_timeout_ms
            .lock()
            .expect("resume_probe_timeout_ms mutex") = Some(ms);
    }

    /// The REST resume probe's bounded `get_session` budget, in milliseconds:
    /// cfg(test) state override > `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`
    /// env parse > 10_000ms default — resolved purely by
    /// [`resolve_probe_timeout_ms`], the same function the WS resume door
    /// uses (`opencode_ws.rs`), so both doors share one parse semantics.
    fn resume_probe_budget_ms(&self) -> u64 {
        #[cfg(test)]
        let state_override = *self
            .resume_probe_timeout_ms
            .lock()
            .expect("resume_probe_timeout_ms mutex");
        #[cfg(not(test))]
        let state_override = None;
        resolve_probe_timeout_ms(
            state_override,
            std::env::var("FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS")
                .ok()
                .as_deref(),
        )
    }

    // ── GET /api/fresh-agent/threads/freshopencode/opencode/:threadId (Batch D PR-5) ──

    /// Build a `FreshAgentSnapshotSchema`-shaped JSON snapshot for an opencode session
    /// (`adapter.ts getSnapshot`, `adapter.ts:574-592` + `normalizeOpencodeSnapshot`,
    /// `normalize.ts:357-405`). `thread_id` is treated as the durable `ses_*` id (the id a
    /// materialized fresh-agent pane's REST/WS surfaces hand the client) -- there is no
    /// placeholder-session snapshot path here (an un-materialized pane has no opencode
    /// session to read yet; the client only calls this endpoint after a `sessionRef`/
    /// `sessionId` exists). Fetches the session's own info (`GET /session/:id`) and its
    /// message page (`GET /session/:id/message`) through the ONE shared `opencode serve`
    /// sidecar via [`Self::ensure_manager`].
    pub async fn get_opencode_snapshot(
        &self,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<Value, OpencodeSnapshotError> {
        // Fix Task #3 (defect 3): a `freshopencode-*` placeholder id (minted by
        // `create_tab` above and by `opencode_ws::handle_create`, BEFORE the pane's first
        // `send-keys`/`freshAgent.send` materializes a real `ses_*` opencode session) is,
        // by construction, never a live `opencode serve` session -- serve genuinely has no
        // such id and 500s, so the pane shows "Failed to load session" and is unusable
        // forever (there is no send-independent way to materialize it). Legacy
        // (`adapter.ts getSnapshot`, `adapter.ts:574-581`) guards this BEFORE ever touching
        // serve: `if (liveState && !liveState.realSessionId) return
        // normalizeOpencodeSnapshot({...no exported})` -- a schema-valid, EMPTY snapshot.
        // This port has no single in-memory map spanning both the REST `panes` map (this
        // struct) and the WS `opencode_ws::FreshOpencodeState::sessions` map, so mirror the
        // safe, general form of that guard: this port's ONE placeholder-id shape is
        // sufficient on its own (no `ses_*` id is ever the empty string prefixed this way),
        // so short-circuit on it directly, reusing [`build_opencode_snapshot_json`] with an
        // empty info/message page -- WITHOUT ever calling [`Self::ensure_manager`]/serve. A
        // `ses_*` (or any other) id serve genuinely doesn't know about still falls through
        // below and surfaces as a real `OpencodeSnapshotError::NotFound` (404).
        if thread_id.starts_with(OPENCODE_PLACEHOLDER_PREFIX) {
            return Ok(build_opencode_snapshot_json(
                thread_id,
                &json!({}),
                &json!([]),
                // A placeholder id never has a rollback record (rollback needs a
                // materialized session).
                None,
            ));
        }

        let manager = self.ensure_manager().await;
        let route: freshell_opencode::Route = cwd.map(str::to_string);

        let info = match manager.get_session(thread_id, &route).await {
            Ok(value) if value.is_object() => value,
            Ok(_) => return Err(OpencodeSnapshotError::NotFound),
            Err(ServeError::Http { status: 404, .. }) => {
                return Err(OpencodeSnapshotError::NotFound);
            }
            Err(err) => return Err(OpencodeSnapshotError::Serve(err)),
        };
        let messages = manager
            .list_messages(thread_id, &route)
            .await
            .map_err(OpencodeSnapshotError::Serve)?;

        // Kata 1wxv Task 5: the DURABLE rollback record (memory-fast sync read
        // over the ledger's write-through index) sources the marker bucket,
        // `canRedo`, `undoneDepth`, and the revision floor — durable even after
        // a native send deletes the reverted tail (decision 6).
        let rollback = self
            .identity_sink()
            .and_then(|s| s.load_rollback(PROVIDER, thread_id));
        Ok(build_opencode_snapshot_json(
            thread_id,
            &info,
            &messages,
            rollback.as_ref(),
        ))
    }
}

/// Why [`FreshAgentState::get_opencode_snapshot`] could not produce a snapshot.
#[derive(Debug)]
pub enum OpencodeSnapshotError {
    /// The serve reported no such session (a 404, or a non-object `/session/:id` body).
    NotFound,
    /// The serve request itself failed (transport, cold-start, etc.).
    Serve(ServeError),
}

impl std::fmt::Display for OpencodeSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpencodeSnapshotError::NotFound => write!(f, "opencode session not found"),
            OpencodeSnapshotError::Serve(err) => write!(f, "{err}"),
        }
    }
}

/// `modelFromInfo(info)` (`normalize.ts:30-37`): `providerID/modelID`, falling back to a bare
/// `modelID`/`model.id` when no provider is present.
fn opencode_model_from_info(info: &Value) -> Option<String> {
    let provider_id = info
        .get("providerID")
        .and_then(Value::as_str)
        .or_else(|| info.pointer("/model/providerID").and_then(Value::as_str));
    let model_id = info
        .get("modelID")
        .and_then(Value::as_str)
        .or_else(|| info.pointer("/model/modelID").and_then(Value::as_str))
        .or_else(|| info.pointer("/model/id").and_then(Value::as_str));
    match (provider_id, model_id) {
        (Some(provider), Some(model)) => Some(format!("{provider}/{model}")),
        (None, Some(model)) => Some(model.to_string()),
        _ => None,
    }
}

/// `tokenUsage(info)` (`normalize.ts:39-52`).
fn opencode_token_usage(info: &Value) -> Value {
    let tokens = info.get("tokens").cloned().unwrap_or_else(|| json!({}));
    let input = tokens.get("input").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let output = tokens.get("output").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let cached = tokens
        .pointer("/cache/read")
        .and_then(Value::as_f64)
        .map(|v| v as i64);
    let total = tokens
        .get("total")
        .and_then(Value::as_f64)
        .map(|v| v as i64)
        .unwrap_or(input + output + cached.unwrap_or(0));

    let mut usage = Map::new();
    usage.insert("inputTokens".to_string(), json!(input));
    usage.insert("outputTokens".to_string(), json!(output));
    if let Some(cached) = cached {
        usage.insert("cachedTokens".to_string(), json!(cached));
    }
    usage.insert("totalTokens".to_string(), json!(total));
    if let Some(reasoning) = tokens.get("reasoning").and_then(Value::as_f64) {
        usage.insert("contextTokens".to_string(), json!(reasoning as i64));
    }
    if let Some(cost) = info.get("cost").and_then(Value::as_f64) {
        usage.insert("costUsd".to_string(), json!(cost));
    }
    Value::Object(usage)
}

/// `normalizeOpencodeRole(value)` (`normalize.ts:24-28`).
fn opencode_role(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some("user") => Some("user"),
        Some("assistant") => Some("assistant"),
        Some("system") => Some("system"),
        Some("tool") => Some("tool"),
        _ => None,
    }
}

/// `fileAttachmentTarget(part)` (`normalize.ts:54-59`).
fn opencode_file_attachment_target(part: &Value) -> String {
    for key in ["filename", "name", "url", "path"] {
        if let Some(v) = part.get(key).and_then(Value::as_str) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "unknown file".to_string()
}

/// `normalizePatchChange(value)` (`normalize.ts:61-75`).
fn opencode_normalize_patch_change(value: &Value) -> Option<Value> {
    if let Some(s) = value.as_str() {
        return if s.is_empty() {
            None
        } else {
            Some(json!({ "path": s }))
        };
    }
    if let Some(obj) = value.as_object() {
        let mut change = obj.clone();
        let has_string_path = change.get("path").map(|v| v.is_string()).unwrap_or(false);
        if !has_string_path {
            let path = obj
                .get("file")
                .and_then(Value::as_str)
                .or_else(|| obj.get("name").and_then(Value::as_str));
            if let Some(path) = path {
                change.insert("path".to_string(), json!(path));
            }
        }
        return Some(Value::Object(change));
    }
    None
}

/// `normalizePatchChanges(files)` (`normalize.ts:77-86`).
fn opencode_normalize_patch_changes(files: Option<&Value>) -> Vec<Value> {
    let values: Vec<Value> = match files {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v @ Value::String(_)) => vec![v.clone()],
        Some(v @ Value::Object(_)) => vec![v.clone()],
        _ => vec![],
    };
    values
        .iter()
        .filter_map(opencode_normalize_patch_change)
        .collect()
}

/// `stripOpencodeRunArgumentQuoting(text)` (`normalize.ts:95-98`).
fn opencode_strip_run_argument_quoting(text: &str) -> String {
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

/// One text segment produced by [`opencode_normalize_balanced_think_tags`]/
/// [`opencode_items_from_assistant_text_part`] -- the Rust analog of `NormalizedTextSegment`
/// (`normalize.ts:100-103`).
struct OpencodeTextSegment {
    kind: &'static str,
    text: String,
}

/// `THINK_TAG_PATTERN` (`normalize.ts:105`): matches any open OR close `<think>`/`<thinking>`
/// tag (optionally carrying attributes), case-insensitively. Used both to detect leakage
/// (`hasThinkTag`) and to strip stray markers (`stripThinkTagMarkers`).
fn opencode_think_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)</?thinking\b[^>]*>|</?think\b[^>]*>")
            .expect("static think-tag pattern is valid")
    })
}

/// `BALANCED_THINK_TAG_PATTERN` (`normalize.ts:106`): a `<thinking>...</thinking>` or
/// `<think>...</think>` pair -- the backreference (`</\1>`) is why this needs `fancy-regex`
/// rather than the (backreference-free) `regex` crate: it must NOT match a `<thinking>` open
/// tag against a `</think>` close tag or vice versa.
fn opencode_balanced_think_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?is)<(thinking|think)\b[^>]*>(.*?)</\1>")
            .expect("static balanced think-tag pattern is valid")
    })
}

/// `LEADING_THINK_CLOSER_PATTERN` (`normalize.ts:107`): one or more stray CLOSING tags at the
/// very start of the text, with only whitespace between/after them.
fn opencode_leading_think_closer_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)^\s*(?:(?:</thinking>|</think>)\s*)+")
            .expect("static leading-closer pattern is valid")
    })
}

/// `THINK_OPEN_TAG_PATTERN` (`normalize.ts:108`): the first open tag, unbalanced (no matching
/// close survives the balanced pass).
fn opencode_think_open_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)<(thinking|think)\b[^>]*>")
            .expect("static open-tag pattern is valid")
    })
}

/// `THINK_CLOSE_TAG_PATTERN` (`normalize.ts:109`): the first close tag, unbalanced.
fn opencode_think_close_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)</(?:thinking|think)>")
            .expect("static close-tag pattern is valid")
    })
}

/// `hasThinkTag(text)` (`normalize.ts:112-115`).
fn opencode_has_think_tag(text: &str) -> bool {
    opencode_think_tag_pattern().is_match(text).unwrap_or(false)
}

/// `stripThinkTagMarkers(text)` (`normalize.ts:117-120`).
fn opencode_strip_think_tag_markers(text: &str) -> String {
    opencode_think_tag_pattern()
        .replace_all(text, "")
        .into_owned()
}

/// `normalizeBalancedThinkTags(text)` (`normalize.ts:122-140`): split `text` into alternating
/// `text`/`thinking` segments around every BALANCED `<thinking>...</thinking>`/
/// `<think>...</think>` pair. Returns `None` when there is no balanced pair at all (mirrors the
/// reference's `null` return, `normalize.ts:135`), signaling the caller to fall through to the
/// unbalanced-tag heuristics.
fn opencode_normalize_balanced_think_tags(text: &str) -> Option<Vec<OpencodeTextSegment>> {
    let re = opencode_balanced_think_tag_pattern();
    let mut segments = Vec::new();
    let mut cursor = 0usize;
    let mut matched = false;
    for cap in re.captures_iter(text) {
        let Ok(cap) = cap else { continue };
        let m = cap.get(0).expect("group 0 always matches");
        matched = true;
        if m.start() > cursor {
            segments.push(OpencodeTextSegment {
                kind: "text",
                text: opencode_strip_think_tag_markers(&text[cursor..m.start()]),
            });
        }
        let inner = cap
            .get(2)
            .map(|g| g.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        segments.push(OpencodeTextSegment {
            kind: "thinking",
            text: inner,
        });
        cursor = m.end();
    }
    if !matched {
        return None;
    }
    if cursor < text.len() {
        segments.push(OpencodeTextSegment {
            kind: "text",
            text: opencode_strip_think_tag_markers(&text[cursor..]),
        });
    }
    Some(segments)
}

/// `segmentsToItems(id, segments)` (`normalize.ts:142-150`): drop empty segments; a single
/// surviving segment keeps the plain `id`, multiple surviving segments each get a
/// `"{id}:{kind}-{index}"` id (index over the FILTERED list, matching the reference).
fn opencode_segments_to_items(id: &str, segments: Vec<OpencodeTextSegment>) -> Vec<Value> {
    let visible: Vec<OpencodeTextSegment> = segments
        .into_iter()
        .filter(|s| !s.text.is_empty())
        .collect();
    if visible.is_empty() {
        return vec![];
    }
    if visible.len() == 1 {
        let seg = &visible[0];
        return vec![json!({ "id": id, "kind": seg.kind, "text": seg.text })];
    }
    visible
        .iter()
        .enumerate()
        .map(|(index, seg)| json!({ "id": format!("{id}:{}-{index}", seg.kind), "kind": seg.kind, "text": seg.text }))
        .collect()
}

/// `itemsFromAssistantTextPart(text, id, leadingCloserIsThinking)` (`normalize.ts:155-189`):
/// OpenCode/Kimi can leak internal `<think>`/`<thinking>` reasoning markup into assistant text
/// parts. This normalizes that leakage into separate `{kind:'thinking'}` items rather than
/// rendering the raw tags as visible text, in priority order: no tags at all (passthrough) ->
/// balanced pair(s) (segmented) -> an unbalanced LEADING closer (the `followedByTool` caller
/// hint decides whether the orphaned content itself reads as `thinking` or `text`) -> an
/// unbalanced OPEN tag only (text-before / thinking-after) -> an unbalanced CLOSE tag only
/// (thinking-before / text-after) -> markers stripped with nothing else salvageable.
fn opencode_items_from_assistant_text_part(
    text: &str,
    id: &str,
    leading_closer_is_thinking: bool,
) -> Vec<Value> {
    if !opencode_has_think_tag(text) {
        return vec![json!({ "id": id, "kind": "text", "text": text })];
    }

    if let Some(segments) = opencode_normalize_balanced_think_tags(text) {
        return opencode_segments_to_items(id, segments);
    }

    let without_markers = opencode_strip_think_tag_markers(text);
    if opencode_leading_think_closer_pattern()
        .is_match(text)
        .unwrap_or(false)
    {
        let normalized = without_markers.trim().to_string();
        if normalized.is_empty() {
            return vec![];
        }
        let kind = if leading_closer_is_thinking {
            "thinking"
        } else {
            "text"
        };
        return vec![json!({ "id": id, "kind": kind, "text": normalized })];
    }

    if let Ok(Some(open_match)) = opencode_think_open_tag_pattern().find(text) {
        return opencode_segments_to_items(
            id,
            vec![
                OpencodeTextSegment {
                    kind: "text",
                    text: opencode_strip_think_tag_markers(&text[..open_match.start()]),
                },
                OpencodeTextSegment {
                    kind: "thinking",
                    text: opencode_strip_think_tag_markers(&text[open_match.end()..])
                        .trim()
                        .to_string(),
                },
            ],
        );
    }

    if let Ok(Some(close_match)) = opencode_think_close_tag_pattern().find(text) {
        return opencode_segments_to_items(
            id,
            vec![
                OpencodeTextSegment {
                    kind: "thinking",
                    text: opencode_strip_think_tag_markers(&text[..close_match.start()])
                        .trim()
                        .to_string(),
                },
                OpencodeTextSegment {
                    kind: "text",
                    text: opencode_strip_think_tag_markers(&text[close_match.end()..]),
                },
            ],
        );
    }

    if !without_markers.is_empty() {
        vec![json!({ "id": id, "kind": "text", "text": without_markers })]
    } else {
        vec![]
    }
}

/// `computeToolAfterByPartIndex(parts)` (`normalize.ts:240-248`): for each part index, is there
/// a `tool`-type part strictly AFTER it in the same message? Feeds
/// [`opencode_items_from_assistant_text_part`]'s `leading_closer_is_thinking` hint -- an
/// orphaned leading `</think>` closer immediately before a tool call reads as leaked reasoning,
/// not user-facing prose.
fn opencode_compute_tool_after_by_part_index(parts: &[Value]) -> Vec<bool> {
    let mut tool_after = vec![false; parts.len()];
    let mut has_tool_after = false;
    for index in (0..parts.len()).rev() {
        tool_after[index] = has_tool_after;
        if parts[index].get("type").and_then(Value::as_str) == Some("tool") {
            has_tool_after = true;
        }
    }
    tool_after
}

/// `itemFromPart(part, fallbackId, role, followedByTool)` (`normalize.ts:191-238`), covering
/// `text`, `reasoning`, `tool`, `file`, `patch`, and `compaction` part types -- the full set the
/// task scope calls for. Structural parts (`step-start`/`step-finish`) and any other
/// unrecognized part `type` fall through to the reference's `return []` default
/// (`normalize.ts:237`), same as an unrecognized type here.
///
/// Non-`user` text parts are routed through [`opencode_items_from_assistant_text_part`] (the
/// `<think>`/`<thinking>` leakage segmentation) rather than passed through as plain
/// `{kind:'text'}` -- this is the fix for the PR-6 review's "Important" finding: think-tag
/// leakage must become `{kind:'thinking'}` items, matching the reference exactly.
fn opencode_item_from_part(
    part: &Value,
    fallback_id: &str,
    role: Option<&str>,
    followed_by_tool: bool,
) -> Vec<Value> {
    let id = part
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_id);
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            let raw_text = part.get("text").and_then(Value::as_str).unwrap_or("");
            if role == Some("user") {
                let text = opencode_strip_run_argument_quoting(raw_text);
                vec![json!({ "id": id, "kind": "text", "text": text })]
            } else {
                opencode_items_from_assistant_text_part(raw_text, id, followed_by_tool)
            }
        }
        Some("reasoning") => {
            let text = part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let segment = if text.is_empty() {
                vec![]
            } else {
                vec![text.clone()]
            };
            vec![
                json!({ "id": id, "kind": "reasoning", "summary": segment.clone(), "content": segment, "text": text }),
            ]
        }
        Some("tool") => {
            let state = part
                .get("state")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let status = match state.get("status").and_then(Value::as_str) {
                Some("completed") => "completed",
                Some("error") => "failed",
                _ => "running",
            };
            let arguments = state.get("input").cloned().unwrap_or_else(|| json!({}));
            let content_items = state
                .get("output")
                .and_then(Value::as_str)
                .map(|s| json!([s]));
            let success = if status == "completed" {
                Some(true)
            } else {
                None
            };
            vec![json!({
                "id": id,
                "kind": "dynamic_tool",
                "namespace": "opencode",
                "tool": part.get("tool").and_then(Value::as_str).unwrap_or("tool"),
                "status": status,
                "arguments": arguments,
                "contentItems": content_items,
                "success": success,
            })]
        }
        Some("file") => vec![json!({
            "id": id,
            "kind": "text",
            "text": format!("Attached file: {}", opencode_file_attachment_target(part)),
        })],
        Some("patch") => vec![json!({
            "id": id,
            "kind": "file_change",
            "status": "completed",
            "changes": opencode_normalize_patch_changes(part.get("files")),
            "extensions": { "opencode": part },
        })],
        Some("compaction") => vec![json!({ "id": id, "kind": "context_compaction" })],
        _ => vec![],
    }
}

/// `textSummaryFromItems` + `normalizeOpencodeTurn`'s summary fallback (`normalize.ts:250-269,341-342`):
/// `SYNTHETIC_TEXT_SEGMENT_ID_SUFFIX_PATTERN` (`normalize.ts:110`): strips a trailing
/// `:text-N`/`:thinking-N` suffix that [`opencode_segments_to_items`] adds when a single part
/// splits into multiple segments, recovering that shared segment's original source id.
fn opencode_strip_synthetic_text_segment_suffix(id: &str) -> String {
    let Some(colon) = id.rfind(':') else {
        return id.to_string();
    };
    let suffix = &id[colon + 1..];
    let digits = suffix
        .strip_prefix("text-")
        .or_else(|| suffix.strip_prefix("thinking-"));
    match digits {
        Some(d) if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) => {
            id[..colon].to_string()
        }
        _ => id.to_string(),
    }
}

/// `textSummaryFromItems` + `normalizeOpencodeTurn`'s summary fallback (`normalize.ts:250-269,341-342`):
/// join every `{kind:'text'}` item's text, GROUPING consecutive items that share the same
/// source id (post `:text-N`/`:thinking-N`-suffix-stripping) by direct concatenation --
/// separate source ids join with `"\n\n"`. This grouping is what makes think-tag segmentation
/// safe: when one assistant text part splits into `[text, thinking, text]`, the two `text`
/// halves share the ORIGINAL part's source id and must read as one continuous excerpt, not two
/// paragraphs separated by a blank line they never had. Falls back to the first `reasoning`
/// item's `summary[0]` when there is no `text`-kind item at all.
fn opencode_turn_summary(items: &[Value]) -> (String, &'static str) {
    let text_items: Vec<(&str, &str)> = items
        .iter()
        .filter(|item| item.get("kind").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?;
            let text = item.get("text").and_then(Value::as_str)?;
            Some((id, text))
        })
        .collect();
    if !text_items.is_empty() {
        let mut groups: Vec<String> = Vec::new();
        let mut current_source: Option<String> = None;
        let mut current_text = String::new();
        for (id, text) in text_items {
            let source_id = opencode_strip_synthetic_text_segment_suffix(id);
            match &current_source {
                Some(cs) if *cs == source_id => current_text.push_str(text),
                None => {
                    current_source = Some(source_id);
                    current_text.push_str(text);
                }
                _ => {
                    if !current_text.is_empty() {
                        groups.push(std::mem::take(&mut current_text));
                    }
                    current_source = Some(source_id);
                    current_text.push_str(text);
                }
            }
        }
        if !current_text.is_empty() {
            groups.push(current_text);
        }
        return (truncate_summary(&groups.join("\n\n")), SUMMARY_KIND_ECHO);
    }
    let reasoning_excerpt = items
        .iter()
        .find(|item| item.get("kind").and_then(Value::as_str) == Some("reasoning"))
        .and_then(|item| item.get("summary").and_then(Value::as_array))
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .unwrap_or("");
    (truncate_summary(reasoning_excerpt), SUMMARY_KIND_ECHO)
}

/// A `FreshAgentTurnSchema`-shaped turn from one opencode `{info, parts}` message
/// (`normalizeOpencodeTurn`, `normalize.ts:324-355`). Every part is mapped via
/// [`opencode_item_from_part`] (`itemFromPart`, `normalize.ts:191-238`) -- `text`, `reasoning`,
/// `tool`, `file`, and `patch` parts all become visible transcript items today; only
/// structural (`step-start`/`step-finish`) and truly unrecognized part types are dropped,
/// matching the reference's own `return []` default.
///
/// kata 1wxv Task 3: the projection is factored as the shared per-message turn
/// builder — the rollback record's marker entries and `rolledBackTurns` bucket use the
/// SAME projection as `turns[]`, so markers match the transcript the model saw.
/// `None` for a message the transcript itself drops (an unknown role carrying
/// displayable items) — call sites `filter_map`.
pub(crate) fn opencode_message_turn_json(message: &Value, ordinal: usize) -> Option<Value> {
    let info = message.get("info").cloned().unwrap_or_else(|| json!({}));
    let id = info
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("message-{ordinal}"));
    let role = opencode_role(info.get("role").and_then(Value::as_str));
    let parts = message
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let tool_after_by_part_index = opencode_compute_tool_after_by_part_index(&parts);
    let items: Vec<Value> = parts
        .iter()
        .enumerate()
        .flat_map(|(index, part)| {
            let followed_by_tool = tool_after_by_part_index
                .get(index)
                .copied()
                .unwrap_or(false);
            opencode_item_from_part(part, &format!("{id}:part-{index}"), role, followed_by_tool)
        })
        .collect();

    if role.is_none() && !items.is_empty() {
        return None;
    }

    let mut turn = Map::new();
    turn.insert("id".to_string(), json!(id));
    turn.insert("turnId".to_string(), json!(id));
    turn.insert("messageId".to_string(), json!(id));
    turn.insert("ordinal".to_string(), json!(ordinal));
    turn.insert("source".to_string(), json!("durable"));
    if let Some(role) = role {
        turn.insert("role".to_string(), json!(role));
    }
    if let Some(model) = opencode_model_from_info(&info) {
        turn.insert("model".to_string(), json!(model));
    }
    let (summary, summary_kind) = opencode_turn_summary(&items);
    turn.insert("summary".to_string(), json!(summary));
    turn.insert("summaryKind".to_string(), json!(summary_kind));
    turn.insert("items".to_string(), json!(items));
    Some(Value::Object(turn))
}

/// `normalizeOpencodeSnapshot` (`normalize.ts:357-405`): map the session's own info + its
/// message page into the `FreshAgentSnapshotSchema` shape. `status` always reports `idle`
/// here -- this REST read has no live busy/idle bit to consult (that lives in the WS
/// session's in-memory turn task, not the serve's own session record) -- an honest
/// approximation the task report calls out; the client's WS-driven busy chrome already
/// covers the live case, this endpoint's job is the committed transcript.
fn build_opencode_snapshot_json(
    thread_id: &str,
    info: &Value,
    messages: &Value,
    // Kata 1wxv Task 5: the durable rollback record (None when the session never
    // rolled back through this server's ledger).
    rollback: Option<&RollbackRecord>,
) -> Value {
    let messages = messages.as_array().cloned().unwrap_or_default();
    // kata 1wxv Task 3 (VERIFIED wire shape, load-bearing correction item 2): the
    // serve returns the reverted tail rows UNFLAGGED in the message list; the
    // boundary is TOP-LEVEL `session.revert.messageID` (omitted when inactive —
    // there is no `info.revert` anywhere). `turns[]` is EXACTLY what the model sees
    // next (messages strictly before the pointer); a stale/unknown pointer keeps
    // the whole list in `turns[]` (never silently empties the transcript).
    // Task 5 (r3): with a ledger record the marker bucket is the record's
    // entries UNION (frozen prior epochs ++ the recorded current tail) — the
    // provider-tail projection below remains ONLY as the record-less fallback
    // (an out-of-band revert this ledger never observed).
    let boundary = info
        .get("revert")
        .and_then(|r| r.get("messageID"))
        .and_then(Value::as_str)
        .and_then(|pointer| {
            messages
                .iter()
                .position(|m| m.pointer("/info/id").and_then(Value::as_str) == Some(pointer))
        })
        .unwrap_or(messages.len());
    let mut turns: Vec<Value> = Vec::new();
    let mut rolled_back: Vec<Value> = Vec::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let Some(turn) = opencode_message_turn_json(message, ordinal) else {
            continue;
        };
        if ordinal < boundary {
            turns.push(turn);
        } else {
            let mut turn = turn;
            turn["rolledBack"] = json!(true);
            rolled_back.push(turn);
        }
    }
    let session_id = info
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(thread_id);
    let revision = info
        .pointer("/time/updated")
        .and_then(Value::as_i64)
        .unwrap_or(turns.len() as i64);
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    let summary = info.get("title").and_then(Value::as_str);

    let mut snapshot = Map::new();
    snapshot.insert("sessionType".to_string(), json!(SESSION_TYPE));
    snapshot.insert("provider".to_string(), json!(PROVIDER));
    snapshot.insert("threadId".to_string(), json!(thread_id));
    snapshot.insert("sessionId".to_string(), json!(session_id));
    snapshot.insert("revision".to_string(), json!(revision));
    snapshot.insert("latestTurnId".to_string(), latest_turn_id);
    snapshot.insert("status".to_string(), json!("idle"));
    if let Some(summary) = summary {
        snapshot.insert("summary".to_string(), json!(summary));
    }
    snapshot.insert(
        "capabilities".to_string(),
        json!({
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            "fork": true,
            "worktrees": false,
            "diffs": true,
            "childThreads": false,
            // Kata 1wxv Task 5: static stamps (LBC-2 verified the revert/unrevert
            // routes); an old-CLI runtime failure classifies at OP time to
            // UNSUPPORTED_CAPABILITY (Task 1's pinned copy), never at stamp time.
            "undo": true,
            "redo": true,
        }),
    );
    snapshot.insert("tokenUsage".to_string(), opencode_token_usage(info));
    snapshot.insert("pendingApprovals".to_string(), json!([]));
    snapshot.insert("pendingQuestions".to_string(), json!([]));
    snapshot.insert("worktrees".to_string(), json!([]));
    snapshot.insert("diffs".to_string(), json!([]));
    snapshot.insert("childThreads".to_string(), json!([]));
    snapshot.insert("turns".to_string(), json!(turns));
    if rollback.is_none() && !rolled_back.is_empty() {
        // Record-less fallback ONLY: the provider-tail projection covers an
        // out-of-band revert this ledger never observed. The strict contract key
        // is optional — a legacy-server payload simply never carries it.
        snapshot.insert("rolledBackTurns".to_string(), json!(rolled_back));
    }
    snapshot.insert("extensions".to_string(), json!({ "opencode": {} }));
    let mut snapshot = Value::Object(snapshot);
    if let Some(record) = rollback {
        // LEDGER-SOURCED bucket (r3): the entries union (frozen prior epochs ++
        // the recorded current tail) — durable even after a native send deletes
        // the reverted tail (decision 6). `canRedo` is the STORED bit (the only
        // source); the record doubles as the revision floor so a stale serve
        // timestamp never lets the client's monotonic watermark drop the
        // post-rollback snapshot.
        let floored = crate::rollback_record::stamp_rollback_snapshot(
            &mut snapshot,
            revision,
            record,
            record.can_redo(),
        );
        snapshot["revision"] = json!(floored);
    }
    snapshot
}

/// The fresh-agent sub-router, pre-bound to its state. Merges in
/// [`pane_ops::router`] (Slice 3b-1's pane/tab lifecycle routes:
/// split/close/select + tab select/rename/delete) so `freshell-server`'s
/// `main.rs` keeps mounting ONE router for this crate, unchanged.
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route("/api/tabs", post(create_tab).get(terminal_tabs::list_tabs))
        .route("/api/panes", get(terminal_tabs::list_panes))
        .route("/api/panes/{id}", patch(rename_pane))
        .route("/api/panes/{id}/send-keys", post(send_keys))
        .route("/api/panes/{id}/capture", get(capture))
        .route("/api/panes/{id}/wait-for", get(terminal_tabs::wait_for))
        .with_state(state.clone())
        .merge(model_capabilities::router(state.clone()))
        .merge(pane_ops::router(state))
}

// ── auth (constant-time, matches auth.ts#httpAuthMiddleware x-auth-token) ────────

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-auth-token")
        .and_then(|v| v.to_str().ok())
        .map(|provided| constant_time_eq(provided.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

// ── response envelopes (server/agent-api/response.ts) ────────────────────────────

/// `ok(data, message)` → `{status:'ok', data, message}` at HTTP 200.
fn ok_json(data: Value, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "status": "ok", "data": data, "message": message })),
    )
        .into_response()
}

/// `approx(data, message)` → `{status:'approx', …}` (turn did not reach idle by deadline).
fn approx_json(data: Value, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "status": "approx", "data": data, "message": message })),
    )
        .into_response()
}

/// `fail(message)` → `{status:'error', message}` at `status`.
fn fail_json(status: StatusCode, message: String) -> Response {
    (
        status,
        Json(json!({ "status": "error", "message": message })),
    )
        .into_response()
}

/// `fail_json` + a machine-readable code, matching how the WS side keys
/// errors (`error["code"] == "RESTORE_UNAVAILABLE"`). Envelope is additive:
/// `{status:"error", code, message}`.
pub(crate) fn fail_json_code(status: StatusCode, code: &str, message: String) -> Response {
    (
        status,
        Json(json!({ "status": "error", "code": code, "message": message })),
    )
        .into_response()
}

/// [`fail_json_code`] + machine-readable retry guidance for 429-family
/// rejections. The window rides BOTH the HTTP `Retry-After` header (whole
/// seconds, floor 1 — HTTP convention) and a `retryAfterMs` body field
/// (house convention, session-lease SESSION_RESERVED): body-only consumers
/// like the MCP bridge never see headers, HTTP-conventional clients never
/// read bodies. Lives here so the `{status:"error", code, message}` envelope
/// shape stays owned by ONE file.
pub(crate) fn fail_json_code_retry_after(
    status: StatusCode,
    code: &str,
    message: String,
    retry_after: std::time::Duration,
) -> Response {
    let mut response = (
        status,
        Json(json!({
            "status": "error",
            "code": code,
            "message": message,
            "retryAfterMs": retry_after.as_millis() as u64,
        })),
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::RETRY_AFTER,
        axum::http::HeaderValue::from(retry_after.as_secs().max(1)),
    );
    response
}

/// The error status the original maps serve failures to (`agentRouteErrorStatus`): a
/// bounded cold-start failure / transport error is a 5xx; everything else 500 here.
fn serve_error_status(err: &ServeError) -> StatusCode {
    match err {
        ServeError::NotHealthy { .. }
        | ServeError::Transport(_)
        | ServeError::Undelivered(_)
        | ServeError::ProcessExited { .. }
        | ServeError::Spawn(_)
        | ServeError::StartupFailed(_) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// ── POST /api/tabs (fresh-agent create) ──────────────────────────────────────────

async fn create_tab(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    // ejh6 (finding 3): door-top presence check. Reject whenever the body
    // CONTAINS the key resumeSessionId with ANY JSON value (string, empty,
    // null, number, object) — BEFORE any agent/browser/editor/terminal
    // branch, including the `terminal_tabs::create_terminal_or_content_tab`
    // delegation (this is the only REST entry to that function).
    if body.get("resumeSessionId").is_some() {
        return fail_json(
            StatusCode::BAD_REQUEST,
            LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
        );
    }
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a72.1): `agent`
    // absent -> terminal / browser / editor tab creation (router.ts:710-793).
    if agent.is_empty() {
        return terminal_tabs::create_terminal_or_content_tab(state, body).await;
    }
    // This surface is the opencode T2 slice; other agents are deferred (400, matching
    // the original's `unknown agent` rejection for anything without a mapping here).
    if agent != "opencode" {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!("unknown agent \"{agent}\""),
        );
    }

    let cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let effort = body
        .get("effort")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = body.get("name").and_then(Value::as_str).map(str::to_string);

    // Task 4 (adopted kata 2, freshagent-sessionref-regression): the `sessionRef`
    // resume branch. Placed AFTER the agent gate — and strictly after the frozen
    // door-top `resumeSessionId` refusal, so a dual carrier (resumeSessionId +
    // sessionRef) hits the frozen 400, never this branch. A body WITHOUT
    // `sessionRef` takes the plain placeholder-create path below unchanged.
    if let Some(session_ref_value) = body.get("sessionRef") {
        return resume_session_ref_tab(&state, session_ref_value, cwd, model, effort, name).await;
    }

    // A1 (naming-sweep ledger deferral): the shared LayoutStore mints
    // {tabId, paneId} -- Node does the same for fresh-agent tabs
    // (`layoutStore.createTab`, router.ts:701) -- so REST/MCP-created
    // fresh-agent tabs are visible to GET /api/tabs + GET /api/panes and
    // renamable via PATCH /api/panes/:id, exactly like the
    // terminal/browser/editor paths (`terminal_tabs::create_content_tab`).
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    // `makePlaceholderSessionId(requestId)` = `freshopencode-<requestId>` (adapter.ts:75).
    let request_id = Uuid::new_v4().simple().to_string();
    let placeholder = format!("freshopencode-{request_id}");

    // The `paneContent` the original attaches + echoes in the ui.command payload.
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "sessionId": placeholder,
        "createRequestId": request_id,
        "status": "connected",
    });
    if let Some(cwd) = &cwd {
        pane_content["initialCwd"] = json!(cwd);
    }
    if let Some(model) = &model {
        pane_content["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        pane_content["effort"] = json!(effort);
    }

    register_fresh_agent_tab(
        &state,
        &tab_id,
        &pane_id,
        name.as_deref(),
        &pane_content,
        PaneEntry {
            placeholder_id: placeholder.clone(),
            cwd: cwd.clone(),
            model,
            effort,
            durable_id: None,
        },
    );

    // P1.13 (Task 3): pending identity marker at REST create (AWAITED before
    // the tab.create broadcast — durable-before-answer), mirroring the WS
    // create path (`opencode_ws.rs` `handle_create`). A failed write surfaces
    // as a user-visible LEDGER_WRITE_FAILED frame, never blocks the create.
    if let Some(sink) = state.identity_sink() {
        if let Err(e) = sink
            .record_pending(&placeholder, SESSION_TYPE, cwd.as_deref())
            .await
        {
            tracing::warn!(error = %e, placeholder = %placeholder, "freshagent.opencode.rest_pending_write_failed");
            state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                event: json!({
                    "type": "freshAgent.error",
                    "sessionId": placeholder,
                    "code": "LEDGER_WRITE_FAILED",
                    "message": "Failed to persist this pane's identity marker - identity may not survive a crash.",
                }),
                provider: PROVIDER.to_string(),
                session_id: placeholder.clone(),
                session_type: SESSION_TYPE.to_string(),
            }));
        }
    }

    broadcast_tab_create(&state, &tab_id, &pane_id, name.as_deref(), &pane_content);

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "sessionId": placeholder }),
        "fresh-agent pane created",
    )
}

/// The registration every fresh-agent pane-minting path needs: attach the pane
/// content to the shared store, record the legacy shadow `TabRecord` + the
/// [`PaneEntry`], and index pane→tab. Every pane-minting path records its owning
/// tab in the shared `pane_tabs` reverse index so `pane_ops`'s
/// split/close/select handlers can resolve this pane's tab.
fn register_fresh_agent_tab(
    state: &FreshAgentState,
    tab_id: &str,
    pane_id: &str,
    name: Option<&str>,
    pane_content: &Value,
    pane_entry: PaneEntry,
) {
    state
        .layout
        .attach_pane_content(tab_id, pane_id, pane_content.clone());
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.to_string(),
        TabRecord {
            title: name.map(str::to_string),
        },
    );
    state
        .panes
        .lock()
        .expect("panes mutex")
        .insert(pane_id.to_string(), pane_entry);
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .insert(pane_id.to_string(), tab_id.to_string());
}

/// Broadcast `ui.command{tab.create}` — AFTER registration (Node's order is
/// createTab -> runtime create -> attachPaneContent -> broadcast -> respond,
/// router.ts:546-589, and `create_content_tab` likewise inserts before
/// broadcasting). Shape note (validated): Node OMITS the `title` key when no
/// name was provided (JSON.stringify drops undefined, router.ts:704). Serialize
/// the same shape instead of `"title": null` -- the shared client tolerates
/// both (`payload.title ||`, tabsSlice.ts:306), but keep the broadcast
/// Node-shaped.
fn broadcast_tab_create(
    state: &FreshAgentState,
    tab_id: &str,
    pane_id: &str,
    name: Option<&str>,
    pane_content: &Value,
) {
    let mut create_payload = json!({
        "id": tab_id,
        "paneId": pane_id,
        "paneContent": pane_content,
    });
    if let Some(name) = name {
        create_payload["title"] = json!(name);
    }
    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(create_payload),
    }));
}

/// Task 4 (adopted kata 2, freshagent-sessionref-regression): the `sessionRef`
/// resume branch of [`create_tab`] — `POST /api/tabs {agent:'opencode',
/// sessionRef}` resumes the referenced opencode session instead of minting a
/// fresh placeholder pane.
///
/// DIVERGENCE FROM FROZEN NODE PARITY (deliberate, plan-authorized): the Node
/// REST fresh-agent create (`router.ts:546-589`, `createFreshAgentPane`)
/// ignores `sessionRef` entirely — resume identity on its fresh-agent pane
/// surfaces rides only the WS `freshAgent.create{resumeSessionId}` door. This
/// branch exceeds that parity so a placeholder-keyed pane snapshot can be
/// restored in situ through REST after a restart.
///
/// Loud failures, never a silent placeholder substitution: malformed
/// `sessionRef` / provider mismatch / unknown identity shape → 400; unknown
/// durable id / unresolvable placeholder → 404; bounded-probe timeout → 504;
/// other probe errors → 502.
async fn resume_session_ref_tab(
    state: &FreshAgentState,
    session_ref_value: &Value,
    body_cwd: Option<String>,
    body_model: Option<String>,
    body_effort: Option<String>,
    name: Option<String>,
) -> Response {
    // 1. Parse. Presence-triggered and LOUD: a malformed locator is rejected,
    // never silently treated as "no resume" — the silent-placeholder-
    // substitution bug class this branch exists to close.
    let locator: SessionLocator = match serde_json::from_value(session_ref_value.clone()) {
        Ok(locator) => locator,
        Err(_) => {
            return fail_json(
                StatusCode::BAD_REQUEST,
                format!(
                    "malformed sessionRef: expected {{\"provider\":\"...\",\"sessionId\":\"...\"}}, got {session_ref_value}"
                ),
            );
        }
    };
    // 2. Provider gate: this route resumes opencode panes only.
    if locator.provider != PROVIDER {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!(
                "sessionRef provider mismatch: this route resumes \"{PROVIDER}\" panes, got \"{}\"",
                locator.provider
            ),
        );
    }
    // 3. Resolve the resume identity: a durable ses_* id resumes directly; a
    // freshopencode-<createRequestId> placeholder resolves through the
    // pane-identity ledger's create-requestId lineage (Task 3). Miss-or-no-sink
    // → 404 naming the placeholder; any other shape → 400.
    let durable_id = if locator.session_id.starts_with("ses_") {
        locator.session_id.clone()
    } else if let Some(create_request_id) =
        locator.session_id.strip_prefix(OPENCODE_PLACEHOLDER_PREFIX)
    {
        let resolved = state
            .identity_sink()
            .and_then(|sink| sink.lookup_by_create_request_id(PROVIDER, create_request_id));
        match resolved {
            Some(id) => id,
            None => {
                return fail_json(
                    StatusCode::NOT_FOUND,
                    format!(
                        "sessionRef {} could not be resolved: no pane with create requestId {create_request_id} was materialized on this server",
                        locator.session_id
                    ),
                );
            }
        }
    } else {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!(
                "sessionRef sessionId \"{}\" is neither a durable ses_* id nor a {OPENCODE_PLACEHOLDER_PREFIX}<createRequestId> placeholder",
                locator.session_id
            ),
        );
    };

    // 4. LEDGER BEFORE PROBE (ordering is load-bearing, review-verified):
    // `get_session` applies the route directory as the `?directory=` query
    // param (serve.rs:634 via `with_route`) and a route-sensitive serve can
    // reject a wrong directory — so the probe route carries the ledger's
    // recorded cwd when one exists, else NO directory; NEVER the body cwd
    // (last in precedence) even when it is present.
    let sink = state.identity_sink();
    let recovered = sink
        .as_ref()
        .and_then(|s| s.load_settings(PROVIDER, &durable_id));
    let was_recorded = sink
        .as_ref()
        .is_some_and(|s| s.was_recorded(PROVIDER, &durable_id));
    let probe_route: freshell_opencode::Route = recovered.as_ref().and_then(|rec| rec.cwd.clone());

    // 5. Bounded probe. Budget layers: cfg(test) state override >
    // FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS > 10_000ms — resolved purely by
    // `resolve_probe_timeout_ms`, shared with the WS resume door.
    let manager = state.ensure_manager().await;
    let budget = state.resume_probe_budget_ms();
    let get = tokio::time::timeout(
        Duration::from_millis(budget),
        manager.get_session(&durable_id, &probe_route),
    )
    .await;
    let info = match get {
        Err(_elapsed) => {
            return fail_json(
                StatusCode::GATEWAY_TIMEOUT,
                format!("opencode session {durable_id} did not answer within {budget}ms"),
            );
        }
        Ok(Ok(value)) if value.is_object() => value,
        Ok(Ok(_)) | Ok(Err(ServeError::Http { status: 404, .. })) => {
            return fail_json(
                StatusCode::NOT_FOUND,
                format!("opencode session {durable_id} not found"),
            );
        }
        Ok(Err(err)) => {
            return fail_json(StatusCode::BAD_GATEWAY, err.to_string());
        }
    };

    // 6. SETTINGS_RESET edge (mirror opencode_ws.rs:1506-1541): the alarm arms
    // ONLY for a settings-bearing record that is now unrecoverable — a
    // lineage-only row (`was_recorded == false` under the Task 3 keying) and a
    // never-recorded session both resume silently. The alarm never blocks the
    // resume.
    if was_recorded && recovered.is_none() {
        tracing::warn!(session = %durable_id, "freshagent.opencode.rest_resume_settings_record_unrecoverable");
        state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: json!({
                "type": "freshAgent.error",
                "sessionId": durable_id,
                "code": "SETTINGS_RESET",
                "message": "Session settings could not be recovered after restart - the agent is running with default model and effort. Reconfirm your settings.",
            }),
            provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
            session_type: SESSION_TYPE.to_string(),
        }));
    }

    // 7. Merge AFTER probe: explicit request values win model/effort over the
    // ledger; cwd is ledger > serve-directory-from-probe > body.
    let rec = recovered.unwrap_or_default();
    let serve_dir = info
        .get("directory")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map(str::to_string);
    let cwd = rec.cwd.or(serve_dir).or(body_cwd);
    let model = body_model.or(rec.model);
    let effort = body_effort.or(rec.effort);

    // 8. Born-durable pane: `placeholder_id` IS the durable id (no
    // `freshopencode-`-prefixed id is ever minted for a resumed pane — the
    // snapshot/serve path sees a normal `ses_*` id from creation, behaving as
    // any already-materialized durable pane) with a FRESH uuid createRequestId.
    // The ledger stays READ-ONLY on resume: no pending marker (Task 3's
    // pending write is create-only), no binding row, NO materialized frame, NO
    // sessions.changed.
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    let request_id = Uuid::new_v4().simple().to_string();
    let session_ref = json!({ "provider": PROVIDER, "sessionId": durable_id });
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "sessionId": durable_id,
        "createRequestId": request_id,
        "status": "connected",
        "sessionRef": session_ref,
    });
    if let Some(cwd) = &cwd {
        pane_content["initialCwd"] = json!(cwd);
    }
    if let Some(model) = &model {
        pane_content["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        pane_content["effort"] = json!(effort);
    }
    register_fresh_agent_tab(
        state,
        &tab_id,
        &pane_id,
        name.as_deref(),
        &pane_content,
        PaneEntry {
            placeholder_id: durable_id.clone(),
            cwd,
            model,
            effort,
            durable_id: Some(durable_id.clone()),
        },
    );
    broadcast_tab_create(state, &tab_id, &pane_id, name.as_deref(), &pane_content);

    ok_json(
        json!({
            "tabId": tab_id,
            "paneId": pane_id,
            "sessionId": durable_id,
            "sessionRef": session_ref,
        }),
        "fresh-agent pane resumed",
    )
}

// ── PATCH /api/panes/:id (rename pane) ──────────────────────────────────────

/// `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH` (`terminals-router.ts:24`), reused for the
/// pane-name length bound per `router.ts:1400-1402`.
const MAX_PANE_NAME_LEN: usize = 500;

/// `parseRequiredName` (`agent-api/router.ts:603-606`): trim; empty/absent -> `None`.
pub(crate) fn parse_required_name(value: Option<&Value>) -> Option<String> {
    let trimmed = value.and_then(Value::as_str).unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `PATCH /api/panes/:id` (`router.ts:1396-1427`): renames a pane in the
/// SHARED server-side layout store (Task 16 — kills D10's fake acknowledgement,
/// which answered `{paneId, tabRenamed:false}` for ANY id without touching any
/// state). Node behavior, clause for clause:
///
/// 1. name validation (blank → 400 `name required`; >500 → 400 length message);
/// 2. `getPaneSnapshot` BEFORE the rename (the cascade reads PRE-rename content);
/// 3. `renamePane` outcome — a miss answers 200 `ok({message})`
///    (`'pane not found'` / `'no layout snapshot'`, `router.ts:1411`+`:1423`);
/// 4. on success, the best-effort syncable-terminal cascade
///    ([`rename_persistence::persist_syncable_terminal_rename`]);
/// 5. `tabRenamed` = the tab has exactly one pane — computed against the
///    client snapshot where the pane resolved (multi-client store; Node reads
///    its single snapshot); broadcast
///    `ui.command{pane.rename,{tabId,paneId,title}}`; respond
///    `ok({tabId, paneId, tabRenamed}, 'pane renamed')`.
async fn rename_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let Some(name) = parse_required_name(body.get("name")) else {
        return fail_json(StatusCode::BAD_REQUEST, "name required".to_string());
    };
    if name.len() > MAX_PANE_NAME_LEN {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!("name must be {MAX_PANE_NAME_LEN} characters or fewer"),
        );
    }

    // Snapshot BEFORE the rename (`router.ts:1407`) so the cascade sees the
    // pane's pre-rename content (terminalId/mode/session fields).
    let pane_snapshot = state.layout.get_pane_snapshot(&pane_id);
    let outcome = state.layout.rename_pane(&pane_id, &name);

    let Some(tab_id) = outcome.tab_id else {
        // Node's `{message:'pane not found'|'no layout snapshot'}` at 200
        // (`renamePane` miss, `router.ts:1411`+`:1423`).
        let message = outcome.message.unwrap_or("pane renamed");
        return ok_json(json!({ "message": message }), message);
    };
    // `result.paneId || paneId` (`router.ts:1420`).
    let pane_id = outcome.pane_id.unwrap_or(pane_id);

    if let Some(snapshot) = pane_snapshot.as_ref() {
        rename_persistence::persist_syncable_terminal_rename(&state, snapshot, &name).await;
    }

    // `tabRenamed` = single-pane tab (`router.ts:1414-1415`), computed from
    // the client snapshot where the pane actually RESOLVED (multi-client
    // store) — another client's same-id tab may have a different shape, so
    // Node's `listPanes(tabId)` read would answer from the wrong snapshot.
    let tab_renamed = state.layout.pane_is_sole_in_tab(&pane_id);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.rename".to_string(),
        payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "title": name })),
    }));

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "tabRenamed": tab_renamed }),
        "pane renamed",
    )
}

// ── POST /api/panes/:id/send-keys (drive one turn) ───────────────────────────────

async fn send_keys(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a72.2): terminal
    // panes are a DISJOINT map from the fresh-agent `panes` map below, so this
    // never touches (or is touched by) the opencode/claude/codex send-keys path.
    if let Some(resp) = terminal_tabs::maybe_send_keys(&state, &pane_id, &body) {
        return resp;
    }

    let text = body
        .get("data")
        .or_else(|| body.get("keys"))
        .or_else(|| body.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return fail_json(StatusCode::BAD_REQUEST, "text is required".to_string());
    }

    let pane = match state
        .panes
        .lock()
        .expect("panes mutex")
        .get(&pane_id)
        .cloned()
    {
        Some(pane) => pane,
        None => return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string()),
    };

    let turn_timeout = body
        .get("timeout")
        .and_then(value_as_secs)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TURN_TIMEOUT);

    let manager = state.ensure_manager().await;
    let route = pane.cwd.clone();

    // AGENT-08 continuity fix: create the durable session ONLY the FIRST time this pane
    // sends (mirrors `adapter.ts materializeOrSend:349` — `if (!state.realSessionId)`).
    // Before this fix, every call unconditionally ran `create_session`, so a second
    // `send-keys` on the same pane silently started a BRAND NEW opencode session instead
    // of continuing the first — the exact context-loss bug the WS `handle_send`
    // continuity regression test (`opencode_ws.rs`) guards against on the WS path.
    let durable_id = if let Some(durable_id) = pane.durable_id.clone() {
        durable_id
    } else {
        // COLD-START + create the durable session. `create_session` runs `ensure_started`
        // (spawn serve → bounded health wait — the DEV-0001 fix, NO warm-proxy) then
        // `POST /session`. Success here IS the cold-start-clean fingerprint.
        //
        // bccd item 4 (council enn3 D-D evaluate-and-decide) — DELIBERATELY
        // UNGATED. Decision reversed at plan validation: gating this
        // cold-start would hold a spawn permit for a worst-case ~50-70s
        // (health_timeout 20_000ms serve.rs:303 + request_timeout 30_000ms
        // serve.rs:308,546 under the permit; the serialized `running`-mutex
        // queue adds ~20s per failing holder) vs the 10s gate waits at
        // every other door — and k cold first-sends queued on the singleton
        // mutex would hold k permits, starving ALL spawn doors. The
        // double-mutex single-flight already bounds actual sidecar forks
        // to AT MOST ONE server-wide: the gate would add starvation
        // without reducing fork concurrency. Moving the acquire inside
        // the single-flight would invert lock order (cycle hazard).
        // Decision record: docs/plans/2026-07-29-znhn-bccd-followups.md §D-7.
        let created = match manager
            .create_session(None, None, pane.cwd.as_deref())
            .await
        {
            Ok(created) => created,
            Err(err) => return fail_json(serve_error_status(&err), err.to_string()),
        };
        let durable_id = created.id;

        // Persist the durable id back onto the pane (so /capture and the next
        // `send-keys` on this pane can reuse it instead of re-materializing).
        if let Some(entry) = state.panes.lock().expect("panes mutex").get_mut(&pane_id) {
            entry.durable_id = Some(durable_id.clone());
        }

        // P1.13: binding row at REST materialization (AWAITED BEFORE the materialized
        // broadcast -- durable-before-answer), resolving the pane's placeholder id.
        // Without this site, REST-created sessions (the e2e seeding surface) never get
        // a resume record (V10 A13-N1). Opencode has no sandbox/permission concepts.
        //
        // Task 3: lineage recording is UNCONDITIONAL — even an all-blank settings
        // snapshot writes the row, because its `create_request_id` lineage (derived
        // from the pane's placeholder id) is what lets a placeholder-keyed pane
        // resolve to this durable session via `lookup_by_create_request_id` after a
        // restart. The false-SETTINGS_RESET hazard an all-blank row used to pose
        // (the reason this write was once gated on settings recordability) moved to
        // the `was_recorded` keying (`identity_sink.rs`): lineage-only rows answer
        // was_recorded()==false, so a legitimately-default create can never alarm
        // on a later resume. `create_request_id`: `freshopencode-<createRequestId>`
        // strips to Some(createRequestId); a born-durable placeholder strips to None.
        if let Some(sink) = state.identity_sink() {
            if let Err(e) = sink
                .record_binding(identity_sink::FreshAgentBindingUpsert {
                    provider: PROVIDER.into(),
                    session_id: durable_id.clone(),
                    mode: SESSION_TYPE.into(),
                    create_request_id: pane
                        .placeholder_id
                        .strip_prefix(OPENCODE_PLACEHOLDER_PREFIX)
                        .map(str::to_string),
                    resolves_pending: Some(pane.placeholder_id.clone()),
                    supersedes: None,
                    settings: identity_sink::FreshAgentSettings {
                        model: pane.model.clone(),
                        sandbox: None,
                        permission_mode: None,
                        effort: pane.effort.clone(),
                        cwd: pane.cwd.clone(),
                    },
                })
                .await
            {
                tracing::warn!(error = %e, session = %durable_id, "freshagent.opencode.rest_binding_write_failed");
                // Same LEDGER_WRITE_FAILED frame shape the WS sites emit (top-level
                // sessionType/provider + user-facing message), via state.broadcast.
                state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                    event: json!({
                        "type": "freshAgent.error",
                        "sessionId": durable_id,
                        "code": "LEDGER_WRITE_FAILED",
                        "message": "Failed to persist this session's resume record - settings may not survive a server restart.",
                    }),
                    provider: PROVIDER.to_string(),
                    session_id: durable_id.clone(),
                    session_type: SESSION_TYPE.to_string(),
                }));
            }
        }

        let session_ref = SessionLocator {
            provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
        };

        // Broadcast the placeholder→durable materialization (router.ts:1734, broadcast to
        // ALL) — emitted EXACTLY ONCE per pane, only on the send that actually materializes.
        state.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
            FreshAgentSessionMaterialized {
                previous_session_id: pane.placeholder_id.clone(),
                provider: PROVIDER.to_string(),
                session_id: durable_id.clone(),
                session_type: SESSION_TYPE.to_string(),
                session_ref: Some(session_ref.clone()),
            },
        ));

        // A durable session was persisted → sessions.changed (the original's
        // session-indexer watcher fires this on the isolated opencode.db write; we
        // surface it directly). Also once-only: subsequent turns on an already-durable
        // session don't create a new session-directory entry. SESSION-09 fix-forward:
        // routes through `broadcast_sessions_changed` so this draws from the SAME
        // shared revision sequence as `freshell-ws`'s sweep when the server wires
        // `with_shared_sessions_revision` (see that method's doc comment).
        state.broadcast_sessions_changed();

        durable_id
    };

    // Drive the turn: normalize model/effort (adapter.ts:80-83), send, block on the IDLE
    // edge (session.idle / session.status{idle}) surfaced by run_turn.
    let model = normalize_opencode_model(pane.model.as_deref());
    let effort = normalize_opencode_effort(pane.model.as_deref(), pane.effort.as_deref());
    let submitted_turn_id = Uuid::new_v4().to_string();

    match manager
        .run_turn(
            &durable_id,
            &text,
            model.as_deref(),
            effort.as_deref(),
            turn_timeout,
            route,
        )
        .await
    {
        Ok(()) => ok_json(
            json!({
                "paneId": pane_id,
                "sessionId": durable_id,
                "submittedTurnId": submitted_turn_id,
                "sessionRef": { "provider": PROVIDER, "sessionId": durable_id },
                "status": "idle",
            }),
            "prompt sent",
        ),
        // Idle deadline missed → approx (the turn was accepted; it just did not idle in time).
        Err(ServeError::IdleTimeout { .. }) => approx_json(
            json!({
                "paneId": pane_id,
                "sessionId": durable_id,
                "submittedTurnId": submitted_turn_id,
                "sessionRef": { "provider": PROVIDER, "sessionId": durable_id },
                "status": "approx",
            }),
            "prompt sent; turn did not complete within deadline",
        ),
        Err(err) => fail_json(serve_error_status(&err), err.to_string()),
    }
}

/// A `timeout` value in seconds (number or numeric string), clamped ≥ 0.
fn value_as_secs(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64),
        _ => None,
    }
}

// ── GET /api/panes/:id/capture (render transcript) ───────────────────────────────

async fn capture(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a72.2): terminal
    // and content (browser/editor) panes are DISJOINT maps from the fresh-agent
    // `panes` map below -- checked first, falling through unchanged otherwise.
    if let Some(resp) = terminal_tabs::maybe_capture(&state, &pane_id, &params) {
        return resp;
    }

    let pane = match state
        .panes
        .lock()
        .expect("panes mutex")
        .get(&pane_id)
        .cloned()
    {
        Some(pane) => pane,
        None => return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string()),
    };
    let Some(durable_id) = pane.durable_id else {
        // No turn yet → empty transcript (text/plain), matching a fresh pane.
        return text_plain(String::new());
    };

    let manager = { state.opencode.lock().await.clone() };
    let Some(manager) = manager else {
        return text_plain(String::new());
    };

    match manager.list_messages(&durable_id, &pane.cwd).await {
        Ok(messages) => text_plain(render_transcript(&messages)),
        Err(err) => fail_json(serve_error_status(&err), err.to_string()),
    }
}

fn text_plain(body: String) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        body,
    )
        .into_response()
}

/// Render an opencode message page to plain text: collect every `{type:'text', text}`
/// part's text (the transcript's assistant + user turns), joined by newlines. Robust to
/// the exact message/part envelope (walks the tree). Falls back to the raw JSON so the
/// oracle's `captureNonEmpty` never trips on an unexpected shape.
fn render_transcript(value: &Value) -> String {
    let mut out: Vec<String> = Vec::new();
    collect_text_parts(value, &mut out);
    if out.is_empty() {
        // Non-empty guarantee: a shape we did not recognise still yields the raw body.
        return value.to_string();
    }
    out.join("\n")
}

fn collect_text_parts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let is_text_part = map.get("type").and_then(Value::as_str) == Some("text");
            if is_text_part {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(text.to_string());
                    }
                }
            }
            for child in map.values() {
                collect_text_parts(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text_parts(item, out);
            }
        }
        _ => {}
    }
}

// ── freshAgent.create requestId dedup (provider-generic) ───────────────────────────

/// Default bound for [`FreshAgentCreateDedup`]'s completed-create cache. Legacy's
/// `createdFreshAgentByRequestId` (`server/ws-handler.ts:569`) has NO size bound at
/// all -- entries live until `freshAgent.kill` clears them
/// (`clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`, called only
/// from `ws-handler.ts:3673`) or the process shuts down (`ws-handler.ts:3907`). This
/// cap is a Rust-port addition BEYOND legacy parity: a long-lived server process that
/// never restarts would otherwise grow this cache forever. 512 is generous relative to
/// any realistic number of concurrently-`creating` panes.
pub const DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP: usize = 512;

/// Provider-generic single-flight + replay cache for `freshAgent.create`, keyed by
/// `requestId`. A faithful port of legacy's `freshAgentCreateLocks` +
/// `createdFreshAgentByRequestId` (`server/ws-handler.ts:568-569`, `1027-1050`,
/// `3359-3425`) -- reusable across every fresh-agent provider (codex/claude/opencode),
/// since the requestId-dedup problem it solves (the frozen client resends
/// `freshAgent.create` with the SAME `requestId` on every reconnect while a pane is
/// `status==creating`, `FreshAgentView.tsx`) is provider-agnostic.
///
/// Semantics:
/// - **Single-flight**: concurrent `create`s sharing a `requestId` serialize --
///   [`Self::acquire_or_replay`] blocks a second caller on the SAME key until the first
///   finishes (its [`FreshAgentCreateGuard`] drops), then re-checks the cache before
///   letting a genuinely new attempt proceed. Mirrors `withFreshAgentCreateLock`'s
///   promise-chain-per-key (`ws-handler.ts:1027-1042`).
/// - **Replay cache**: a completed create is cached by `requestId`
///   ([`Self::record_success`]), so a REPLAYED `create` reattaches to the SAME session
///   instead of minting a new one -- until [`Self::clear_for_session`] evicts it.
/// - **Failures are never cached**: mirrors legacy (the `catch` branch,
///   `ws-handler.ts:3443-3460`, never populates `createdFreshAgentByRequestId`) -- a
///   later retry with the same `requestId` genuinely re-attempts creation. A caller
///   that receives [`FreshAgentCreateOutcome::Proceed`] and does NOT call
///   `record_success` (i.e. the attempt failed) simply drops the guard; the next
///   attempt for that `requestId` finds no cache entry and proceeds fresh.
/// - **A session that exits on its own is NOT evicted**: legacy calls
///   `clearFreshAgentCreateCachesForSession` ONLY from the `freshAgent.kill` handler
///   (`ws-handler.ts:3673`) -- an UNREQUESTED sidecar exit has no such hook. A replay
///   after a natural/crash exit therefore re-serves the dead session's id, matching
///   legacy behavior exactly rather than "helpfully" recreating. Callers must invoke
///   [`Self::clear_for_session`] explicitly on an EXPLICIT kill, mirroring
///   `ws-handler.ts:3673`, and must NOT invoke it on an unrequested exit.
/// - **Bounded** (oldest-first eviction of entries whose per-key lock is provably
///   unused, i.e. no in-flight creation still holds it): a Rust-port addition beyond
///   legacy parity -- see [`DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP`].
pub struct FreshAgentCreateDedup<T: Clone + Send + 'static> {
    inner: tokio::sync::Mutex<FreshAgentCreateDedupInner<T>>,
    cap: usize,
}

struct FreshAgentCreateDedupInner<T> {
    /// requestId -> completed create record (the replay cache).
    cache: HashMap<String, T>,
    /// Insertion order of `cache` keys, oldest first, for bounded FIFO eviction.
    cache_order: std::collections::VecDeque<String>,
    /// requestId -> per-key single-flight lock. An entry exists for the lifetime of
    /// every requestId this process has ever seen a `create` for, until opportunistic
    /// eviction (see [`FreshAgentCreateDedupInner::evict_if_over_cap`]) reclaims it.
    inflight: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

impl<T> FreshAgentCreateDedupInner<T> {
    /// Reclaim `inflight` entries once the table grows past `cap`, but ONLY entries
    /// whose lock nobody currently holds (`Arc::strong_count(..) <= 1`, i.e. only this
    /// map's own reference remains) -- never evict a lock an in-flight creation (or a
    /// waiting duplicate) still references, which would break single-flight
    /// serialization for that requestId.
    fn evict_if_over_cap(&mut self, cap: usize) {
        if self.inflight.len() <= cap {
            return;
        }
        let stale: Vec<String> = self
            .inflight
            .iter()
            .filter(|(_, lock)| Arc::strong_count(lock) <= 1)
            .map(|(key, _)| key.clone())
            .take(self.inflight.len() - cap)
            .collect();
        for key in stale {
            self.inflight.remove(&key);
        }
    }
}

/// The outcome of [`FreshAgentCreateDedup::acquire_or_replay`].
pub enum FreshAgentCreateOutcome<T> {
    /// A completed create already exists for this `requestId` -- replay it verbatim
    /// (e.g. re-broadcast `freshAgent.created` with the cached sessionId); do NOT spawn
    /// a second session.
    Replay(T),
    /// This caller won the single-flight race for this `requestId`: proceed with the
    /// real creation. Hold the returned guard for the ENTIRE creation attempt
    /// (including any resume/retry sub-calls) so concurrent duplicate `create`s keep
    /// serializing against it; it releases automatically when dropped. On success, call
    /// [`FreshAgentCreateDedup::record_success`] with the same `requestId` before the
    /// guard drops -- the guard itself caches nothing (failures must never be cached).
    Proceed(FreshAgentCreateGuard),
}

/// Holds the per-`requestId` single-flight lock for the duration of one `create`
/// attempt. Dropping it (including via an early `return` on any failure path) releases
/// the lock so a queued duplicate (or a fresh retry) can proceed.
pub struct FreshAgentCreateGuard {
    _permit: tokio::sync::OwnedMutexGuard<()>,
}

/// A clone-shared per-key single-flight registry for one-shot runtime operations
/// (delta-review round 2, D2-F2: `freshAgent.fork` duplicate-click suppression on
/// BOTH the codex and opencode arms). [`Self::try_acquire`] inserts the key and
/// hands back an RAII guard; a second acquisition for the SAME key while the guard
/// is held answers `None` so the caller can refuse loudly. The guard's `Drop`
/// removes the key, so EVERY handler exit path — success, refusal, and the codex
/// post-archive containment alike — releases it: no leg can strand the key.
///
/// [`Self::try_acquire_pair`] (delta-review round 3) inserts up to TWO keys
/// atomically under the same map lock: the codex fork guard must cover the
/// RESOLVED parent id across the mint-new respawn re-key (the materialized
/// broadcast re-keys the pane mid-flight, so the duplicate click arrives addressed
/// to a DIFFERENT id than the one clicked) while still holding the clicked id.
/// Neither key is inserted unless both are free, and the guard releases both in a
/// single lock acquisition — there is no partial state a racing click could slip
/// through.
///
/// The critical sections are tiny `HashSet` ops, never held across `.await`, so a
/// plain std mutex suffices (the crate's existing `Arc<Mutex<…>>`-in-std pattern,
/// e.g. `ClaudeSession.pending`).
#[derive(Clone, Default)]
pub(crate) struct InFlightRegistry {
    keys: Arc<Mutex<HashSet<String>>>,
}

impl InFlightRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Insert `key`; `None` when an operation for this key is already in flight.
    /// The returned guard removes the key on drop.
    pub(crate) fn try_acquire(&self, key: &str) -> Option<InFlightGuard> {
        self.try_acquire_all(&[key])
    }

    /// Insert BOTH keys atomically under one map lock; `None` when an operation for
    /// EITHER key is already in flight (a partial acquisition would leak the
    /// unguarded key space entirely). The returned guard removes both on drop, also
    /// under one lock. `first`-equals-`second` degrades to the single-key shape.
    pub(crate) fn try_acquire_pair(&self, first: &str, second: &str) -> Option<InFlightGuard> {
        self.try_acquire_all(&[first, second])
    }

    fn try_acquire_all(&self, keys: &[&str]) -> Option<InFlightGuard> {
        let mut held: Vec<String> = Vec::with_capacity(keys.len());
        for key in keys {
            if !held.iter().any(|h| h == key) {
                held.push((*key).to_string());
            }
        }
        let mut guard = self.keys.lock().expect("in-flight registry lock");
        if held.iter().any(|key| guard.contains(key)) {
            return None;
        }
        guard.extend(held.iter().cloned());
        Some(InFlightGuard {
            keys: Arc::clone(&self.keys),
            held,
        })
    }

    /// Snapshot membership check — never an acquisition. Claude's `handle_send`
    /// parks while a rollback names this durable id (kata 1wxv task 4 review C1):
    /// a session-map resolve miss inside the rollback's teardown→respawn window
    /// must WAIT for the re-insert, never refuse with SESSION_NOT_FOUND.
    pub(crate) fn contains(&self, key: &str) -> bool {
        self.keys
            .lock()
            .expect("in-flight registry lock")
            .contains(key)
    }
}

/// RAII release for an [`InFlightRegistry`] acquisition: removes its held key(s)
/// when the driving handler returns, on every terminal path.
pub(crate) struct InFlightGuard {
    keys: Arc<Mutex<HashSet<String>>>,
    held: Vec<String>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut keys = self.keys.lock().expect("in-flight registry lock");
        for key in &self.held {
            keys.remove(key);
        }
    }
}

#[cfg(test)]
mod in_flight_registry_tests {
    use super::*;

    #[test]
    fn contains_tracks_acquire_and_drop_without_acquiring() {
        let registry = InFlightRegistry::new();
        assert!(!registry.contains("dur-1"));
        let guard = registry.try_acquire("dur-1").expect("first acquire");
        assert!(registry.contains("dur-1"));
        // contains is a snapshot, NOT an acquisition: a second try_acquire still
        // refuses (single-flight) while contains never blocks.
        assert!(registry.try_acquire("dur-1").is_none());
        assert!(registry.contains("dur-1"));
        drop(guard);
        assert!(!registry.contains("dur-1"));
    }
}

/// RAII holder for a claimed fresh-agent session lease (Task 12, mirror of
/// `SessionRefLeaseGuard` in `freshell-ws/src/terminal.rs`). `Drop` calls `fail()` ONLY
/// while armed AND no kill handle was recorded: once a live child exists (kill handle
/// set), a panic between `set_kill_handle` and `complete` must never release un-killed —
/// the lease stays held (TTL + tree-kill is the recovery path).
pub struct FreshSessionLeaseGuard {
    leases: Arc<session_lease::FreshAgentSessionLeases>,
    provider: &'static str,
    session_id: String,
    request_id: String,
    armed: bool,
    kill_handle_set: bool,
}

impl FreshSessionLeaseGuard {
    /// Wrap a just-acquired claim ([`session_lease::FreshSessionClaim::Acquired`]).
    pub fn armed(
        leases: Arc<session_lease::FreshAgentSessionLeases>,
        provider: &'static str,
        session_id: &str,
        request_id: &str,
    ) -> Self {
        Self {
            leases,
            provider,
            session_id: session_id.to_string(),
            request_id: request_id.to_string(),
            armed: true,
            kill_handle_set: false,
        }
    }

    /// Record the spawned sidecar's pid + ownership tag on the lease (arms the
    /// TTL tree-kill path).
    pub fn set_kill_handle(&mut self, pid: u32, ownership_id: &str) {
        self.leases.set_kill_handle(
            self.provider,
            &self.session_id,
            &self.request_id,
            pid,
            ownership_id,
        );
        self.kill_handle_set = true;
    }

    /// Winner registered its session: bind + release in one lock scope. Returns `false`
    /// when the lease was revoked/foreign — the caller must tear down its own child and
    /// then call [`Self::fail`] (the guard stays armed).
    pub fn complete(&mut self, live_session_key: &str) -> bool {
        let ok = self.leases.complete(
            self.provider,
            &self.session_id,
            &self.request_id,
            live_session_key,
        );
        if ok {
            self.armed = false;
        }
        ok
    }

    /// Spawn/resume failed AND the caller's own tree is (being) torn down: release.
    pub fn fail(&mut self) {
        if self.armed {
            self.leases
                .fail(self.provider, &self.session_id, &self.request_id);
            self.armed = false;
        }
    }
}

impl Drop for FreshSessionLeaseGuard {
    fn drop(&mut self) {
        if self.armed && !self.kill_handle_set {
            self.leases
                .fail(self.provider, &self.session_id, &self.request_id);
        } else if self.armed {
            // A live child may exist (kill handle set) — never blanket-release; the
            // TTL + tree-kill path recovers this lease.
            tracing::warn!(
                provider = self.provider,
                session_id = %self.session_id,
                "fresh_agent_lease_guard_dropped_armed_with_kill_handle: holding for TTL recovery"
            );
        }
    }
}

impl<T: Clone + Send + 'static> Default for FreshAgentCreateDedup<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone + Send + 'static> FreshAgentCreateDedup<T> {
    /// Build a dedup engine with [`DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP`].
    pub fn new() -> Self {
        Self::with_cap(DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP)
    }

    /// Build a dedup engine with an explicit cap (tests use a small one).
    pub fn with_cap(cap: usize) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(FreshAgentCreateDedupInner {
                cache: HashMap::new(),
                cache_order: std::collections::VecDeque::new(),
                inflight: HashMap::new(),
            }),
            cap,
        }
    }

    /// Single-flight-acquire (or replay) a `create` for `request_id`. See the type-level
    /// doc for full semantics.
    pub async fn acquire_or_replay(&self, request_id: &str) -> FreshAgentCreateOutcome<T> {
        loop {
            let key_lock = {
                let mut inner = self.inner.lock().await;
                if let Some(hit) = inner.cache.get(request_id) {
                    return FreshAgentCreateOutcome::Replay(hit.clone());
                }
                let lock = inner
                    .inflight
                    .entry(request_id.to_string())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                    .clone();
                inner.evict_if_over_cap(self.cap);
                lock
            };

            let permit = key_lock.lock_owned().await;

            // Re-check under the per-key permit: another caller may have completed
            // (and cached) while we were waiting for the lock.
            let inner = self.inner.lock().await;
            if inner.cache.contains_key(request_id) {
                drop(inner);
                drop(permit);
                continue;
            }
            drop(inner);
            return FreshAgentCreateOutcome::Proceed(FreshAgentCreateGuard { _permit: permit });
        }
    }

    /// Cache a completed create's result under `request_id` (bounded FIFO eviction of
    /// the oldest cache entry once over `cap`). Call this ONLY on success -- legacy
    /// never caches a failed create.
    pub async fn record_success(&self, request_id: &str, value: T) {
        let mut inner = self.inner.lock().await;
        if !inner.cache.contains_key(request_id) {
            inner.cache_order.push_back(request_id.to_string());
        }
        inner.cache.insert(request_id.to_string(), value);
        while inner.cache.len() > self.cap {
            match inner.cache_order.pop_front() {
                Some(oldest) => {
                    inner.cache.remove(&oldest);
                }
                None => break,
            }
        }
    }

    /// Evict every cache entry whose value matches `predicate` (e.g. `|r| r.session_id
    /// == killed_id`). Mirrors `clearFreshAgentCreateCachesForSession`
    /// (`ws-handler.ts:1044-1050`) -- call this ONLY from an explicit kill path, never
    /// from an unrequested-exit path (see the type-level doc).
    pub async fn clear_for_session(&self, predicate: impl Fn(&T) -> bool) {
        let mut inner = self.inner.lock().await;
        let stale: Vec<String> = inner
            .cache
            .iter()
            .filter(|(_, value)| predicate(value))
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            inner.cache.remove(&key);
            if let Some(pos) = inner.cache_order.iter().position(|k| k == &key) {
                inner.cache_order.remove(pos);
            }
        }
    }
}

#[cfg(test)]
mod fresh_agent_create_dedup_tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Rec(String);

    #[tokio::test]
    async fn sequential_duplicate_request_id_replays_the_cached_value() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::new();

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {
                dedup
                    .record_success("req-1", Rec("session-a".to_string()))
                    .await;
            }
            FreshAgentCreateOutcome::Replay(_) => panic!("first call must not replay"),
        }

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Replay(rec) => {
                assert_eq!(rec, Rec("session-a".to_string()));
            }
            FreshAgentCreateOutcome::Proceed(_) => {
                panic!("duplicate requestId must replay, not proceed to create again")
            }
        }
    }

    #[tokio::test]
    async fn distinct_request_ids_never_replay_each_other() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::new();

        for (req, session) in [("req-a", "session-a"), ("req-b", "session-b")] {
            match dedup.acquire_or_replay(req).await {
                FreshAgentCreateOutcome::Proceed(_guard) => {
                    dedup.record_success(req, Rec(session.to_string())).await;
                }
                FreshAgentCreateOutcome::Replay(_) => {
                    panic!("distinct requestId must never replay another's cache entry")
                }
            }
        }
    }

    #[tokio::test]
    async fn concurrent_duplicate_request_id_serializes_and_both_see_the_same_value() {
        let dedup: Arc<FreshAgentCreateDedup<Rec>> = Arc::new(FreshAgentCreateDedup::new());
        let barrier = Arc::new(tokio::sync::Barrier::new(2));

        let run = |dedup: Arc<FreshAgentCreateDedup<Rec>>, barrier: Arc<tokio::sync::Barrier>| async move {
            barrier.wait().await;
            match dedup.acquire_or_replay("req-race").await {
                FreshAgentCreateOutcome::Proceed(_guard) => {
                    // Simulate real creation work, widening the race window so the
                    // second task's `acquire_or_replay` is genuinely blocked on the
                    // first's guard rather than winning outright.
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    dedup
                        .record_success("req-race", Rec("session-race".to_string()))
                        .await;
                    Rec("session-race".to_string())
                }
                FreshAgentCreateOutcome::Replay(rec) => rec,
            }
        };

        let (a, b) = tokio::join!(
            run(dedup.clone(), barrier.clone()),
            run(dedup.clone(), barrier.clone()),
        );

        assert_eq!(a, Rec("session-race".to_string()));
        assert_eq!(b, Rec("session-race".to_string()));
    }

    #[tokio::test]
    async fn clear_for_session_evicts_matching_entries_so_a_later_duplicate_recreates() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::new();

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {
                dedup
                    .record_success("req-1", Rec("session-a".to_string()))
                    .await;
            }
            FreshAgentCreateOutcome::Replay(_) => panic!("first call must not replay"),
        }

        dedup.clear_for_session(|rec| rec.0 == "session-a").await;

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {
                // Expected: the explicit-kill eviction means a later duplicate
                // genuinely re-creates instead of replaying the killed session.
            }
            FreshAgentCreateOutcome::Replay(_) => {
                panic!("cache entry must be gone after clear_for_session matched it")
            }
        }
    }

    #[tokio::test]
    async fn bounded_cache_evicts_the_oldest_entry_past_cap() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::with_cap(2);

        for req in ["req-1", "req-2", "req-3"] {
            match dedup.acquire_or_replay(req).await {
                FreshAgentCreateOutcome::Proceed(_guard) => {
                    dedup
                        .record_success(req, Rec(format!("session-{req}")))
                        .await;
                }
                FreshAgentCreateOutcome::Replay(_) => panic!("{req} must not replay"),
            }
        }

        // req-1 was the oldest of 3 entries against a cap of 2 -- evicted, so a
        // duplicate for it must now genuinely re-create (Proceed), not replay.
        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {}
            FreshAgentCreateOutcome::Replay(_) => {
                panic!("req-1 should have been evicted past the cap of 2")
            }
        }

        // req-3 (most recent) must still replay.
        match dedup.acquire_or_replay("req-3").await {
            FreshAgentCreateOutcome::Replay(rec) => {
                assert_eq!(rec, Rec("session-req-3".to_string()))
            }
            FreshAgentCreateOutcome::Proceed(_) => {
                panic!("req-3 must still be cached (most recent, within cap)")
            }
        }
    }
}

#[cfg(test)]
mod spawn_gate_seam_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    fn bare_state() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
    }

    #[test]
    fn unwired_state_has_no_spawn_gate() {
        assert!(bare_state().spawn_gate().is_none());
    }

    /// Boot-assertion seam (council enn3 follow-up): the OnceLock is a
    /// fail-OPEN seam — an unwired gate silently ungates every REST create.
    /// `spawn_gate_wired` is the public probe `freshell-server` asserts at
    /// startup so a wiring regression fails LOUD at boot.
    #[test]
    fn spawn_gate_wired_reflects_oncelock_state() {
        let state = bare_state();
        assert!(!state.spawn_gate_wired(), "bare state must report unwired");
        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            Duration::from_millis(100),
        );
        assert!(state.spawn_gate_wired(), "wired state must report wired");
    }

    #[test]
    fn set_spawn_gate_is_visible_to_every_clone_and_set_once() {
        let state = bare_state();
        let clone_taken_before_set = state.clone();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(4, 64));
        state.set_spawn_gate(Arc::clone(&gate), Duration::from_millis(1234));

        // Clones share the Arc<OnceLock>, so even a clone taken BEFORE the
        // set observes the wiring (the ledger-injection property).
        let wired = clone_taken_before_set.spawn_gate().expect("wired");
        assert!(Arc::ptr_eq(&wired.gate, &gate), "same gate instance");
        assert_eq!(wired.timeout, Duration::from_millis(1234));

        // Second set is ignored (OnceLock).
        let other = Arc::new(crate::spawn_gate::SpawnGate::new(1, 1));
        state.set_spawn_gate(other, Duration::from_millis(1));
        let still = state.spawn_gate().expect("still wired");
        assert!(Arc::ptr_eq(&still.gate, &gate), "first wiring wins");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
    }

    #[test]
    fn authorized_is_constant_time_and_requires_header() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "tok")); // absent
        headers.insert("x-auth-token", "nope".parse().unwrap());
        assert!(!authorized(&headers, "tok"));
        headers.insert("x-auth-token", "tok".parse().unwrap());
        assert!(authorized(&headers, "tok"));
    }

    #[test]
    fn value_as_secs_parses_number_and_string() {
        assert_eq!(value_as_secs(&json!(180)), Some(180));
        assert_eq!(value_as_secs(&json!("90")), Some(90));
        assert_eq!(value_as_secs(&json!(-1)), None);
        assert_eq!(value_as_secs(&json!("nan")), None);
        assert_eq!(value_as_secs(&json!(null)), None);
    }

    #[test]
    fn render_transcript_collects_text_parts_and_contains_reply() {
        // A representative opencode /message page: user prompt + assistant reply parts.
        let page = json!([
            { "info": { "role": "user" }, "parts": [{ "type": "text", "text": "Reply with freshell-t2-ok" }] },
            { "info": { "role": "assistant" }, "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "freshell-t2-ok" }
            ] }
        ]);
        let rendered = render_transcript(&page);
        assert!(rendered.contains("freshell-t2-ok"), "{rendered}");
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn render_transcript_falls_back_to_raw_for_unknown_shape() {
        let page = json!({ "unexpected": "shape" });
        let rendered = render_transcript(&page);
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn materialized_frame_carries_placeholder_and_durable() {
        // The broadcast frame shape the oracle's wire.session-materialized invariant reads.
        let msg = ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: "freshopencode-abc".to_string(),
            provider: PROVIDER.to_string(),
            session_id: "ses_123".to_string(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: "ses_123".to_string(),
            }),
        });
        let wire: Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(wire["type"], "freshAgent.session.materialized");
        assert_eq!(wire["previousSessionId"], "freshopencode-abc");
        assert_eq!(wire["sessionId"], "ses_123");
        assert_eq!(wire["provider"], "opencode");
    }

    #[tokio::test]
    async fn shutdown_is_safe_when_no_serve_started() {
        // No manager was ever created → shutdown is a clean no-op (never panics).
        state().shutdown().await;
    }

    // -- SESSION-09 fix-forward: unify `sessions.changed` revision counters --
    //
    // `freshell-freshagent` previously maintained its OWN `sessions_revision`
    // counter, entirely independent of `freshell-ws`'s `WsState::sessions_revision`
    // (the periodic session-directory sweep's counter). Because the client's
    // dedupe watermark (`src/App.tsx:924-932`) only accepts a `sessions.changed`
    // frame whose `revision` INCREASES over the last one it saw, two
    // independently-incrementing producers of the same message type could, in
    // rare interleavings, cause a real change from one producer to be masked by
    // a lower-or-equal revision from the other. `with_shared_sessions_revision`
    // lets the real server wiring (`freshell-server`'s `main.rs`) point this
    // crate's counter at the SAME `Arc<AtomicI64>` `WsState` uses, so both
    // producers draw from one monotonic sequence.

    #[test]
    fn with_shared_sessions_revision_draws_from_the_injected_counter() {
        let shared = Arc::new(AtomicI64::new(41));
        let st = state().with_shared_sessions_revision(Arc::clone(&shared));

        // The crate's own emission (`broadcast_sessions_changed`, the refactor
        // of the inline fetch_add call at the durable-session materialization
        // site) must bump the INJECTED counter, not a fresh internal one.
        st.broadcast_sessions_changed();

        assert_eq!(
            shared.load(Ordering::SeqCst),
            42,
            "the crate's own sessions.changed emission must bump the shared counter"
        );
    }

    #[test]
    fn sessions_changed_revision_is_unified_across_ws_and_freshagent_producers() {
        // Reproduces the exact `fetch_add(1, SeqCst) + 1` pattern
        // `freshell_ws::terminal::broadcast_sessions_changed` uses, on the SAME
        // shared `Arc<AtomicI64>`, interleaved with THIS crate's own emission --
        // proving both producers now draw from one unified, never-regressing
        // sequence (the two-independent-counters bug this fix closes).
        let shared = Arc::new(AtomicI64::new(0));
        let st = state().with_shared_sessions_revision(Arc::clone(&shared));

        // "ws" producer bumps first.
        let ws_revision_1 = shared.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(ws_revision_1, 1);

        // "freshagent" producer bumps next -- must see revision 1 and produce 2,
        // not restart its own independent sequence at 1.
        st.broadcast_sessions_changed();
        assert_eq!(shared.load(Ordering::SeqCst), 2);

        // "ws" producer bumps again -- must see freshagent's bump reflected.
        let ws_revision_2 = shared.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(
            ws_revision_2, 3,
            "ws and freshagent producers must share ONE strictly-increasing \
             sequence -- a lower-or-equal revision from either side risks the \
             client's \"accept only if revision increases\" watermark silently \
             dropping a real change"
        );
    }

    // ── GET /api/fresh-agent/threads/freshopencode/opencode/:threadId (Batch D PR-5) ──

    use freshell_opencode::{
        Endpoint, EventSource, EventStreamHandle, PortAllocator, ServeDeps, ServeHttp,
        ServeHttpError, ServeHttpRequest, ServeHttpResponse,
    };

    /// Fakes `GET /session/:id` (session info) and `GET /session/:id/message` (the page)
    /// with fixed, scripted bodies; anything else (health, etc.) is a benign `{}`.
    struct FixedSessionHttp {
        session_body: Value,
        messages_body: Value,
    }
    impl ServeHttp for FixedSessionHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let body = if req.url.contains("/message") {
                serde_json::to_vec(&self.messages_body).unwrap()
            } else if req.url.contains("/session/") {
                serde_json::to_vec(&self.session_body).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    /// Answers the serve's own `/global/health` probe (so `ensure_started()` succeeds) but
    /// 404s any `/session/:id` GET (unknown session).
    struct NotFoundHttp;
    impl ServeHttp for NotFoundHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                Ok(ServeHttpResponse::new(404, b"not found".to_vec()))
            })
        }
    }

    struct FakeAllocator;
    impl PortAllocator for FakeAllocator {
        fn allocate(&self) -> Result<Endpoint, String> {
            Ok(Endpoint {
                hostname: "127.0.0.1".into(),
                port: 1,
            })
        }
    }
    struct NoopHandle;
    impl EventStreamHandle for NoopHandle {}
    struct NoopEventSource;
    impl EventSource for NoopEventSource {
        fn connect(
            &self,
            _url: String,
            _sink: freshell_opencode::serve::EventSink,
        ) -> Box<dyn EventStreamHandle> {
            Box::new(NoopHandle)
        }
    }
    struct NoopSpawner;
    impl freshell_opencode::ProcessSpawner for NoopSpawner {
        fn spawn(
            &self,
            _req: freshell_opencode::serve::SpawnRequest,
        ) -> Result<Box<dyn freshell_opencode::ServeProcess>, String> {
            struct NoopProcess;
            impl freshell_opencode::ServeProcess for NoopProcess {
                fn exited(&self) -> Option<i32> {
                    None
                }
                fn take_fatal_startup_error(&self) -> Option<String> {
                    None
                }
                fn kill(&self) {}
            }
            Ok(Box::new(NoopProcess))
        }
    }

    async fn state_with_fixed_session_http(
        session_body: Value,
        messages_body: Value,
    ) -> FreshAgentState {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(FixedSessionHttp {
                session_body,
                messages_body,
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st
    }

    #[tokio::test]
    async fn get_opencode_snapshot_returns_a_schema_shaped_snapshot_with_turn_text() {
        let session_body = json!({
            "id": "ses_1",
            "title": "a session",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
            "tokens": { "input": 10, "output": 20, "total": 30 },
        });
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
            { "info": { "id": "msg-2", "role": "assistant" }, "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "hello from opencode" }
            ] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;

        let snapshot = st
            .get_opencode_snapshot("ses_1", None)
            .await
            .expect("snapshot builds");

        assert_eq!(snapshot["sessionType"], json!("freshopencode"));
        assert_eq!(snapshot["provider"], json!("opencode"));
        assert_eq!(snapshot["threadId"], json!("ses_1"));
        assert_eq!(snapshot["sessionId"], json!("ses_1"));
        assert_eq!(snapshot["revision"], json!(1_700_000_005_000i64));
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(snapshot["summary"], json!("a session"));
        assert_eq!(snapshot["tokenUsage"]["inputTokens"], json!(10));
        assert_eq!(snapshot["tokenUsage"]["outputTokens"], json!(20));
        assert_eq!(snapshot["tokenUsage"]["totalTokens"], json!(30));
        assert_eq!(snapshot["pendingApprovals"], json!([]));
        assert_eq!(snapshot["extensions"]["opencode"], json!({}));

        let turns = snapshot["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["role"], json!("user"));
        assert_eq!(turns[0]["items"][0]["kind"], json!("text"));
        assert_eq!(turns[0]["items"][0]["text"], json!("hi"));
        assert_eq!(turns[1]["role"], json!("assistant"));
        assert_eq!(turns[1]["summary"], json!("hello from opencode"));
        assert_eq!(turns[1]["summaryKind"], json!("echo"));
        assert_eq!(snapshot["latestTurnId"], turns[1]["turnId"]);
    }

    /// Fix Task #3: a session id this process never created/attached to via any WS/REST
    /// pane (a stand-in for a HISTORICAL session opened from the sidebar) still serves a
    /// snapshot -- `get_opencode_snapshot` has no "is this in a live pane map" gate; it
    /// goes straight to the shared serve manager's `GET /session/:id` + `/message`, which
    /// opencode's own sqlite-backed store answers for ANY session id it knows about,
    /// regardless of which process created it or when.
    #[tokio::test]
    async fn get_opencode_snapshot_serves_a_session_never_created_by_this_process() {
        let session_body = json!({
            "id": "ses_historical",
            "title": "a session from a previous server lifetime",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
        });
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "old message" }] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;

        // No `handle_create`/`handle_send` ever ran for this id in this test -- there is no
        // pane, no durable-id map entry, nothing. The snapshot must still build.
        let snapshot = st
            .get_opencode_snapshot("ses_historical", None)
            .await
            .expect("a historical session (never created by this process) still snapshots");
        assert_eq!(snapshot["threadId"], json!("ses_historical"));
        assert_eq!(snapshot["sessionType"], json!("freshopencode"));
    }

    #[tokio::test]
    async fn get_opencode_snapshot_of_unknown_session_is_not_found() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(NotFoundHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let err = st
            .get_opencode_snapshot("does-not-exist", None)
            .await
            .expect_err("unknown session");
        assert!(matches!(err, OpencodeSnapshotError::NotFound));
    }

    // -- P1.13 Task 7: REST send-keys materialization writes a binding row --

    /// Like `opencode_ws::tests::FakeHttp`: `POST /session` mints `ses_1`; everything
    /// else (health, prompt, status) answers a benign `{}`.
    struct CreateCapableHttp;
    impl ServeHttp for CreateCapableHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let is_create = matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && (req.url.ends_with("/session") || req.url.contains("/session?"));
            let body = if is_create {
                serde_json::to_vec(&json!({ "id": "ses_1", "directory": null })).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    /// The REST half of the Task 7 identity-event coverage (V10 A13-N1): a REST-created
    /// pane (POST /api/tabs seeds model/effort) whose first `send-keys` cold-start
    /// materializes the durable `ses_*` id must record a binding through the pane
    /// ledger sink -- without this site, REST-created sessions never get a resume record.
    #[tokio::test]
    async fn rest_send_keys_materialization_records_binding() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        // A REST-created pane carrying model/effort (what POST /api/tabs records).
        st.panes.lock().expect("panes mutex").insert(
            "pane-1".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-r1".to_string(),
                cwd: Some("/w".to_string()),
                model: Some("big-model".to_string()),
                effort: Some("high".to_string()),
                durable_id: None,
            },
        );

        // Drive the REST send-keys cold-start materialization. `timeout: 0` bounds the
        // inline `run_turn` idle-wait (the fake never reports activity); the
        // materialization + binding write happen BEFORE the turn is driven.
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let _resp = send_keys(
            State(st.clone()),
            Path("pane-1".to_string()),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == "ses_1")
            .expect("binding recorded at REST send-keys materialization");
        assert_eq!(b.provider, "opencode");
        assert_eq!(b.mode, "freshopencode");
        assert_eq!(b.resolves_pending.as_deref(), Some("freshopencode-r1"));
        assert_eq!(b.settings.model.as_deref(), Some("big-model"));
        assert_eq!(b.settings.effort.as_deref(), Some("high"));
        assert_eq!(b.settings.cwd.as_deref(), Some("/w"));
        // Task 3 (corrected semantics): `create_request_id` is the CREATE's
        // requestId, derived from the pane's placeholder id
        // (`freshopencode-r1` → `r1`) — the WS path previously stamped the
        // SEND's requestId and the REST path stamped `None`; the placeholder
        // is the lineage source of truth on both paths now.
        assert_eq!(b.create_request_id.as_deref(), Some("r1"));
        // A settings-bearing row keeps "recorded" status under the new keying.
        drop(bindings);
        assert!(fake.was_recorded("opencode", "ses_1"));
    }

    /// Task 3 (corrected semantics — this test previously asserted the WAVE-B
    /// no-laundering SKIP): lineage recording is UNCONDITIONAL. A REST-created
    /// pane with NO model/effort/cwd (the all-blank shape) still records its
    /// materialization binding — the row's `create_request_id` lineage is what
    /// lets a placeholder-keyed pane resolve to its durable `ses_*` session via
    /// `lookup_by_create_request_id` after a restart. The false-SETTINGS_RESET
    /// hazard the skip was built against moved to the `was_recorded` keying:
    /// a lineage-only row answers `was_recorded == false` and
    /// `load_settings == None`, so no alarm arms on a later resume.
    #[tokio::test]
    async fn rest_send_keys_materialization_records_lineage_for_all_blank_settings() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        // A REST-created pane with NO model/effort/cwd -- the all-blank shape.
        st.panes.lock().expect("panes mutex").insert(
            "pane-blank".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-b1".to_string(),
                cwd: None,
                model: None,
                effort: None,
                durable_id: None,
            },
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let _resp = send_keys(
            State(st.clone()),
            Path("pane-blank".to_string()),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;

        // The lineage row EXISTS: unconditional recording, placeholder-derived
        // create_request_id, blank settings payload.
        let b = {
            let bindings = fake.bindings.lock().unwrap();
            bindings
                .iter()
                .find(|b| b.session_id == "ses_1")
                .expect("lineage binding recorded even for an all-blank settings snapshot")
                .clone()
        };
        assert_eq!(b.provider, "opencode");
        assert_eq!(b.mode, "freshopencode");
        assert_eq!(
            b.create_request_id.as_deref(),
            Some("b1"),
            "lineage key derived from the pane's placeholder id"
        );
        assert_eq!(b.resolves_pending.as_deref(), Some("freshopencode-b1"));
        assert_eq!(
            b.settings,
            identity_sink::FreshAgentSettings::default(),
            "blank settings payload is recorded verbatim"
        );

        // ...but a lineage-only row is NOT a settings-bearing record: the
        // `was_recorded` keying (Task 3 semantics) keeps a later resume from
        // arming a FALSE SETTINGS_RESET for this legitimately-default create.
        assert!(
            fake.load_settings("opencode", "ses_1").is_none(),
            "lineage-only row answers no settings snapshot"
        );
        assert!(
            !fake.was_recorded("opencode", "ses_1"),
            "lineage-only row must not count as recorded (false SETTINGS_RESET)"
        );
    }

    // -- Task 3: REST create_tab records the pending identity marker --

    /// Mirrors the WS create path (`opencode_ws.rs` `handle_create`): POST
    /// /api/tabs for a fresh-agent pane must write a pending marker under the
    /// pane's placeholder id (`freshopencode-<createRequestId>`), AWAITED
    /// before the tab.create broadcast (durable-before-answer). Without the
    /// marker, a crash between create and materialization leaves no evidence
    /// identity establishment was in flight.
    #[tokio::test]
    async fn create_tab_records_pending_marker() {
        let st = state();
        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = create_tab(
            State(st.clone()),
            headers,
            Json(json!({ "agent": "opencode", "cwd": "/w" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let placeholder = st
            .panes
            .lock()
            .expect("panes mutex")
            .values()
            .next()
            .expect("the pane was created")
            .placeholder_id
            .clone();
        assert!(placeholder.starts_with("freshopencode-"));
        let pendings = fake.pendings.lock().unwrap();
        assert!(
            pendings.iter().any(|(id, mode, cwd)| id == &placeholder
                && mode == "freshopencode"
                && cwd.as_deref() == Some("/w")),
            "pending marker recorded at REST create under the placeholder id: {pendings:?}"
        );
    }

    /// The pending write must never block the create (failure policy parity
    /// with the WS path): a failed write surfaces as a user-visible
    /// `LEDGER_WRITE_FAILED` `freshAgent.error` broadcast AND the pane is
    /// still created.
    #[tokio::test]
    async fn create_tab_pending_write_failure_broadcasts_ledger_write_failed_and_still_creates() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        fake.fail_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        st.set_identity_sink(fake.clone());

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = create_tab(
            State(st.clone()),
            headers,
            Json(json!({ "agent": "opencode", "cwd": "/w" })),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "a failed marker write never blocks the create"
        );

        let placeholder = st
            .panes
            .lock()
            .expect("panes mutex")
            .values()
            .next()
            .expect("the pane was created despite the write failure")
            .placeholder_id
            .clone();

        let mut saw_ledger_write_failed = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            if text.contains("LEDGER_WRITE_FAILED") {
                let v: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(v["provider"], "opencode");
                assert_eq!(v["sessionType"], "freshopencode");
                assert_eq!(v["sessionId"], placeholder);
                saw_ledger_write_failed = true;
            }
        }
        assert!(
            saw_ledger_write_failed,
            "a failed pending write must surface a user-visible LEDGER_WRITE_FAILED frame"
        );
    }

    // -- Batch D PR-6: rich transcript items for the opencode snapshot endpoint --

    #[test]
    fn opencode_item_from_part_tool_part_renders_dynamic_tool_kind_with_exact_schema_keys() {
        let part = json!({
            "type": "tool", "id": "part-1", "tool": "bash",
            "state": { "status": "completed", "input": { "command": "ls" }, "output": "a.txt\n" },
        });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items[0],
            json!({
                "id": "part-1", "kind": "dynamic_tool", "namespace": "opencode", "tool": "bash",
                "status": "completed", "arguments": { "command": "ls" }, "contentItems": ["a.txt\n"], "success": true,
            })
        );
    }

    #[test]
    fn opencode_item_from_part_running_tool_has_no_content_items_or_success() {
        let part = json!({ "type": "tool", "id": "part-2", "tool": "bash", "state": { "status": "running", "input": {} } });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(items[0]["status"], json!("running"));
        assert_eq!(items[0]["contentItems"], Value::Null);
        assert_eq!(items[0]["success"], Value::Null);
    }

    #[test]
    fn opencode_item_from_part_patch_renders_file_change_kind_with_exact_schema_keys() {
        let part = json!({ "type": "patch", "id": "part-3", "files": ["src/main.rs"] });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items[0],
            json!({
                "id": "part-3", "kind": "file_change", "status": "completed",
                "changes": [{ "path": "src/main.rs" }], "extensions": { "opencode": part },
            })
        );
    }

    #[test]
    fn opencode_item_from_part_reasoning_renders_reasoning_kind() {
        let part = json!({ "type": "reasoning", "id": "part-4", "text": "considering options" });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items[0],
            json!({
                "id": "part-4", "kind": "reasoning",
                "summary": ["considering options"], "content": ["considering options"], "text": "considering options",
            })
        );
    }

    #[test]
    fn opencode_item_from_part_structural_step_start_is_skipped_matching_reference_default() {
        let part = json!({ "type": "step-start", "id": "part-5" });
        assert_eq!(
            opencode_item_from_part(&part, "fallback", Some("assistant"), false),
            Vec::<Value>::new()
        );
    }

    // -- Fix task: opencode <think>/<thinking> leakage segmentation --

    #[test]
    fn opencode_item_from_part_balanced_think_tag_splits_into_thinking_and_text_items() {
        let part = json!({
            "type": "text", "id": "part-6",
            "text": "Before.<thinking>reasoning here</thinking>After.",
        });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        // Text-before + thinking + text-after: 3 segments around the one balanced pair.
        assert_eq!(
            items.len(),
            3,
            "text-before + thinking + text-after: {items:?}"
        );
        assert_eq!(items[0]["kind"], json!("text"));
        assert_eq!(items[0]["text"], json!("Before."));
        assert_eq!(items[1]["kind"], json!("thinking"));
        assert_eq!(items[1]["text"], json!("reasoning here"));
        assert_eq!(items[2]["kind"], json!("text"));
        assert_eq!(items[2]["text"], json!("After."));
        // Multi-segment ids are suffixed by kind + index (over the visible/filtered list).
        assert_eq!(items[0]["id"], json!("part-6:text-0"));
        assert_eq!(items[1]["id"], json!("part-6:thinking-1"));
        assert_eq!(items[2]["id"], json!("part-6:text-2"));
    }

    #[test]
    fn opencode_item_from_part_balanced_think_short_tag_alias_also_segments() {
        // `<think>`/`</think>` is an accepted alias for `<thinking>`/`</thinking>`
        // (`THINK_OPEN_TAG_PATTERN`/`BALANCED_THINK_TAG_PATTERN`, normalize.ts:106-108).
        let part =
            json!({ "type": "text", "id": "part-7", "text": "<think>quiet plan</think>Ready." });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], json!("thinking"));
        assert_eq!(items[0]["text"], json!("quiet plan"));
        assert_eq!(items[1]["kind"], json!("text"));
        assert_eq!(items[1]["text"], json!("Ready."));
    }

    #[test]
    fn opencode_item_from_part_text_without_any_think_tag_is_unchanged() {
        let part = json!({ "type": "text", "id": "part-8", "text": "Ran the command." });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items,
            vec![json!({ "id": "part-8", "kind": "text", "text": "Ran the command." })]
        );
    }

    #[test]
    fn opencode_item_from_part_unbalanced_open_tag_only_splits_text_before_and_thinking_after() {
        // No closing tag at all -- an unbalanced OPEN-only leak. Everything after the open tag
        // is orphaned reasoning content; everything before is ordinary text.
        let part = json!({ "type": "text", "id": "part-9", "text": "Plan:<thinking>still going" });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], json!("text"));
        assert_eq!(items[0]["text"], json!("Plan:"));
        assert_eq!(items[1]["kind"], json!("thinking"));
        assert_eq!(items[1]["text"], json!("still going"));
    }

    #[test]
    fn opencode_item_from_part_user_text_is_never_segmented_even_with_think_tags() {
        // Segmentation is an assistant-text-leakage workaround; user-authored text passes
        // through the run-argument-quote-stripping path only, tags and all.
        let part = json!({ "type": "text", "id": "part-10", "text": "<thinking>not reasoning</thinking>" });
        let items = opencode_item_from_part(&part, "fallback", Some("user"), false);
        assert_eq!(
            items,
            vec![
                json!({ "id": "part-10", "kind": "text", "text": "<thinking>not reasoning</thinking>" })
            ]
        );
    }

    #[test]
    fn opencode_message_turn_json_renders_both_tool_and_text_parts_in_one_message() {
        let message = json!({
            "info": { "id": "msg-1", "role": "assistant" },
            "parts": [
                { "type": "tool", "id": "t-1", "tool": "bash", "state": { "status": "completed", "input": {}, "output": "done" } },
                { "type": "text", "id": "x-1", "text": "Ran the command." },
            ],
        });
        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");
        let items = turn["items"].as_array().expect("items array");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], json!("dynamic_tool"));
        assert_eq!(items[0]["tool"], json!("bash"));
        assert_eq!(items[1]["kind"], json!("text"));
        assert_eq!(items[1]["text"], json!("Ran the command."));
        // Summary joins the (single) text item's text.
        assert_eq!(turn["summary"], json!("Ran the command."));
        assert_eq!(turn["summaryKind"], json!("echo"));
    }

    #[test]
    fn opencode_turn_summary_truncates_the_text_join_and_tags_echo() {
        let long = "y".repeat(200);
        let items = vec![json!({ "id": "p-0", "kind": "text", "text": long })];
        let (summary, kind) = opencode_turn_summary(&items);
        assert_eq!(summary.chars().count(), 140);
        assert_eq!(kind, SUMMARY_KIND_ECHO);

        // The reasoning fallback is the adapter's own projection of full reasoning
        // text — echo, NOT authored (see the plan's deviation note).
        let reasoning_only = vec![
            json!({ "id": "p-1", "kind": "reasoning", "summary": ["full reasoning text"], "content": [], "text": "full reasoning text" }),
        ];
        assert_eq!(
            opencode_turn_summary(&reasoning_only),
            ("full reasoning text".to_string(), SUMMARY_KIND_ECHO)
        );
    }

    // ── resolve_probe_timeout_ms (Task 4 knob, pinned purely) ────────────────
    // The resume probe's budget layers: state override >
    // `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` parse > 10_000ms default —
    // the SAME env-parse semantics the WS resume door applies
    // (`opencode_ws.rs`). The state-injection timeout tests prove boundedness;
    // these pin the KNOB's parsing/default. Pure: NO process env is mutated
    // (the caller reads `std::env::var` and hands the raw Option<&str> in).

    #[test]
    fn resolve_probe_timeout_ms_state_override_beats_env() {
        assert_eq!(resolve_probe_timeout_ms(Some(250), Some("5000")), 250);
        assert_eq!(resolve_probe_timeout_ms(Some(250), None), 250);
    }

    #[test]
    fn resolve_probe_timeout_ms_env_parse_wins_over_default() {
        assert_eq!(resolve_probe_timeout_ms(None, Some("7500")), 7500);
        // "0" parses: an explicit zero budget is the operator's choice.
        assert_eq!(resolve_probe_timeout_ms(None, Some("0")), 0);
    }

    #[test]
    fn resolve_probe_timeout_ms_garbage_env_falls_to_default() {
        assert_eq!(resolve_probe_timeout_ms(None, Some("not-a-number")), 10_000);
        assert_eq!(resolve_probe_timeout_ms(None, Some("")), 10_000);
        // Negative and overflowing values fail the u64 parse, same as garbage.
        assert_eq!(resolve_probe_timeout_ms(None, Some("-50")), 10_000);
        assert_eq!(
            resolve_probe_timeout_ms(None, Some("99999999999999999999999999")),
            10_000
        );
        // Whitespace is NOT trimmed (the parse semantics the WS door has
        // always had — no silent behavior drift).
        assert_eq!(resolve_probe_timeout_ms(None, Some(" 7500")), 10_000);
    }

    #[test]
    fn resolve_probe_timeout_ms_missing_env_is_default() {
        assert_eq!(resolve_probe_timeout_ms(None, None), 10_000);
    }

    // ── kata 1wxv Task 3: the FUNCTIONAL active-prefix / tail-marker filter ──────
    //
    // The serve returns the reverted tail rows UNFLAGGED in the message list; the
    // VERIFIED wire shape puts the boundary at TOP-LEVEL `session.revert.messageID`
    // (no `info.revert` exists anywhere). `turns[]` is EXACTLY what the model sees
    // next (messages strictly before the pointer); the tail becomes
    // `rolledBackTurns` markers in conversation order, each stamped rolledBack:true.

    fn three_turn_opencode_messages() -> Value {
        json!([
            { "info": { "id": "msg_u1", "role": "user" }, "parts": [{ "type": "text", "text": "prompt one" }] },
            { "info": { "id": "msg_a1", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer one" }] },
            { "info": { "id": "msg_u2", "role": "user" }, "parts": [{ "type": "text", "text": "prompt two" }] },
            { "info": { "id": "msg_a2", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer two" }] },
            { "info": { "id": "msg_u3", "role": "user" }, "parts": [{ "type": "text", "text": "prompt three" }] },
            { "info": { "id": "msg_a3", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer three" }] },
        ])
    }

    #[test]
    fn opencode_snapshot_filters_turns_to_the_active_prefix_and_marks_the_tail() {
        // Top-LEVEL session.revert.messageID = the middle USER message; the message
        // list is served in FULL (tail unflagged, exactly like the real provider).
        let info = json!({ "id": "ses_x", "title": "t", "revert": { "messageID": "msg_u2" } });
        // No ledger record (kata 1wxv Task 5): the provider tail is the marker
        // projection source ONLY in the record-less (out-of-band revert) case.
        let snap =
            build_opencode_snapshot_json("ses_x", &info, &three_turn_opencode_messages(), None);

        let turns = snap["turns"].as_array().expect("turns array");
        let ids: Vec<&str> = turns.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["msg_u1", "msg_a1"],
            "turns[] == the active prefix ONLY (strictly before the pointer) — a \
             regression to mapping every served message into turns[] fails here"
        );

        let markers = snap["rolledBackTurns"]
            .as_array()
            .expect("the marker bucket is present while a tail is rolled back");
        let marker_ids: Vec<&str> = markers
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(
            marker_ids,
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "the tail rows in their ORIGINAL conversation order"
        );
        assert!(
            markers.iter().all(|t| t["rolledBack"] == json!(true)),
            "every marker is stamped rolledBack:true (decision 6)"
        );
    }

    #[test]
    fn opencode_snapshot_marker_order_is_stable_across_repeated_undos() {
        // Revert the LAST user message, build; then revert the MIDDLE user message,
        // build: the second snapshot's rolledBackTurns order equals the surviving
        // tail's conversation order — never wire/undo order ([u3,a3,u2,a2]).
        let first = build_opencode_snapshot_json(
            "ses_x",
            &json!({ "id": "ses_x", "revert": { "messageID": "msg_u3" } }),
            &three_turn_opencode_messages(),
            None,
        );
        let first_ids: Vec<&str> = first["rolledBackTurns"]
            .as_array()
            .expect("markers after the first undo")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(first_ids, vec!["msg_u3", "msg_a3"]);

        let second = build_opencode_snapshot_json(
            "ses_x",
            &json!({ "id": "ses_x", "revert": { "messageID": "msg_u2" } }),
            &three_turn_opencode_messages(),
            None,
        );
        let second_ids: Vec<&str> = second["rolledBackTurns"]
            .as_array()
            .expect("markers after the second undo")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(
            second_ids,
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "markers follow the surviving tail's conversation order across repeated undos"
        );
        // No revert pointer (legacy behavior): everything stays in turns[], no bucket.
        let plain = build_opencode_snapshot_json(
            "ses_x",
            &json!({ "id": "ses_x" }),
            &three_turn_opencode_messages(),
            None,
        );
        assert_eq!(
            plain["turns"].as_array().expect("turns").len(),
            6,
            "no pointer ⇒ no filtering (legacy-server parity)"
        );
        assert!(
            plain.get("rolledBackTurns").is_none(),
            "the marker bucket is omitted entirely when nothing is rolled back"
        );
    }

    // ── kata 1wxv Task 5: snapshot rollback surfacing (opencode) ──────────────
    //
    // Stamps are static `{undo:true, redo:true}` (LBC-2 verified the
    // revert/unrevert routes). The marker bucket IS the ledger record's
    // entries union (r3 — frozen prior epochs ++ the current serve-revert
    // tail, recorded at write time); `turns[]` still comes from the
    // provider's active prefix. `canRedo` is the STORED bit (the only source);
    // `undoneDepth` is the USER-role step count of the bucket (r3 finding 5 —
    // the same step count the client's `Rolled back (N)` label shows), never
    // `entries.len()`.

    /// Build a ledger entry's removed-turns from fixture messages (the verbatim
    /// FreshAgentTurn JSON the Task 3 handler records at write time).
    fn opencode_record_entry(
        msgs: &[Value],
        prompt: &str,
    ) -> crate::rollback_record::RollbackEntry {
        let removed_turns = msgs
            .iter()
            .enumerate()
            .map(|(i, m)| opencode_message_turn_json(m, i).expect("marker turn"))
            .collect();
        crate::rollback_record::RollbackEntry {
            removed_turns,
            prompt_text: prompt.into(),
            at_ms: 90,
            epoch: 0,
        }
    }

    #[test]
    fn opencode_snapshot_stamps_capabilities_and_the_ledger_marker_bucket() {
        let msgs = three_turn_opencode_messages();
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(opencode_record_entry(&[msgs[2].clone()], "prompt two"), 100);
        record.set_can_redo(true, 100);
        // The serve carries NO revert pointer: the bucket is PROVABLY
        // ledger-sourced (a provider-tail projection would show nothing).
        let info = json!({ "id": "ses_x", "title": "t", "time": { "updated": 5 } });
        let snap = build_opencode_snapshot_json("ses_x", &info, &msgs, Some(&record));
        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["msg_u2"] })
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 1);
        assert_eq!(bucket[0]["turnId"], json!("msg_u2"));
        assert!(
            bucket.iter().all(|t| t["rolledBack"] == json!(true)),
            "every marker is stamped rolledBack:true (decision 6)"
        );
        assert_eq!(
            snap["turns"].as_array().expect("turns").len(),
            6,
            "turns[] still comes from the provider state (no pointer ⇒ the full list)"
        );
        assert_eq!(
            snap["revision"],
            json!(100),
            "the record's lastOpAtMs is the revision floor (basis 5 loses)"
        );
    }

    #[test]
    fn opencode_snapshot_undone_depth_counts_user_steps_not_entries() {
        // r3 finding 5: a REBUILT single entry carrying the two-step tail
        // ([u2, a2, u3, a3] — Task 3's union rebuild over a two-step undo).
        let msgs = three_turn_opencode_messages();
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(
            opencode_record_entry(
                &[
                    msgs[2].clone(),
                    msgs[3].clone(),
                    msgs[4].clone(),
                    msgs[5].clone(),
                ],
                "prompt two",
            ),
            100,
        );
        record.set_can_redo(true, 100);
        let info = json!({ "id": "ses_x", "time": { "updated": 5 } });
        let snap = build_opencode_snapshot_json("ses_x", &info, &msgs, Some(&record));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 2, "redoableTurnIds": ["msg_u2", "msg_u3"] }),
            "two undone USER steps — never entries.len(); every current-epoch user row is redoable"
        );
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 4);
    }

    #[test]
    fn opencode_snapshot_destroyed_redo_keeps_the_marked_bucket_alive() {
        let msgs = three_turn_opencode_messages();
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(opencode_record_entry(&[msgs[2].clone()], "prompt two"), 100);
        record.set_can_redo(true, 100);
        record.destroy_redo(120); // decision 5: kills redo, NEVER the markers (decision 6)
        let info = json!({ "id": "ses_x", "time": { "updated": 5 } });
        let snap = build_opencode_snapshot_json("ses_x", &info, &msgs, Some(&record));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] }),
            "the stored bit cleared; the bucket's user-step count is untouched; no marker is redoable"
        );
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 1);
        assert_eq!(
            snap["revision"],
            json!(120),
            "the destroy also lifts the floor"
        );
    }

    #[tokio::test]
    async fn get_opencode_snapshot_surfaces_the_durable_rollback_record() {
        let session_body = json!({
            "id": "ses_rb",
            "title": "rolled back session",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
        });
        // The serve knows NOTHING about a revert pointer — the marker bucket
        // must still surface from the ledger.
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
            { "info": { "id": "msg-2", "role": "assistant" }, "parts": [{ "type": "text", "text": "hello" }] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let marker_source = json!({ "info": { "id": "msg-9", "role": "user" }, "parts": [{ "type": "text", "text": "later" }] });
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(
            opencode_record_entry(&[marker_source], "later"),
            1_702_000_000_000,
        );
        record.set_can_redo(true, 1_702_000_000_000);
        crate::identity_sink::PaneIdentitySink::record_rollback(
            fake.as_ref(),
            "opencode",
            "ses_rb",
            record,
        )
        .await
        .expect("record write");

        let snapshot = st
            .get_opencode_snapshot("ses_rb", None)
            .await
            .expect("snapshot builds");
        assert_eq!(snapshot["capabilities"]["undo"], json!(true));
        assert_eq!(snapshot["capabilities"]["redo"], json!(true));
        assert_eq!(
            snapshot["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["msg-9"] })
        );
        assert_eq!(snapshot["rolledBackTurns"][0]["turnId"], json!("msg-9"));
        assert_eq!(snapshot["rolledBackTurns"][0]["rolledBack"], json!(true));
        assert_eq!(
            snapshot["revision"],
            json!(1_702_000_000_000i64),
            "a stale serve timestamp never beats the record floor"
        );
    }
}

// ── PATCH /api/panes/:id (rename pane) ───────────────────────────────────

#[cfg(test)]
#[path = "rename_cascade_tests.rs"]
mod rename_cascade_tests;

#[cfg(test)]
mod rename_pane_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;

    fn app() -> Router {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        router(FreshAgentState::new(
            Arc::new("tok".to_string()),
            Arc::new(tx),
        ))
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn patch_pane(name: Option<&str>, auth: bool) -> (StatusCode, Value) {
        let body = match name {
            Some(n) => json!({ "name": n }).to_string(),
            None => "{}".to_string(),
        };
        let mut req = Request::builder()
            .method("PATCH")
            .uri("/api/panes/pane-123")
            .header("content-type", "application/json");
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        let resp = app()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    /// Task 16 (kills D10's fake ack): with NO layout snapshot ingested yet,
    /// the route answers Node's `renamePane` miss shape at 200 —
    /// `ok({message:'no layout snapshot'})` (`layout-store.ts:559` via
    /// `router.ts:1411`+`:1423`) — never the old unconditional
    /// `{paneId, tabRenamed:false}` acknowledgement.
    #[tokio::test]
    async fn rename_without_layout_snapshot_is_200_with_message() {
        let (status, body) = patch_pane(Some("My New Title"), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], json!("ok"));
        assert_eq!(body["data"], json!({ "message": "no layout snapshot" }));
        assert_eq!(body["message"], json!("no layout snapshot"));
    }

    /// `parseRequiredName(undefined) -> undefined` -> 400 `'name required'`
    /// (`router.ts:1398-1399`).
    #[tokio::test]
    async fn missing_name_is_400_name_required() {
        let (status, body) = patch_pane(None, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], json!("name required"));
    }

    /// `parseRequiredName` trims and rejects blank-only input the same as absent.
    #[tokio::test]
    async fn blank_name_is_400_name_required() {
        let (status, body) = patch_pane(Some("   "), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], json!("name required"));
    }

    /// `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH` (`terminals-router.ts:24`) = 500,
    /// reused here per the fix spec (`router.ts:1400-1402`).
    #[tokio::test]
    async fn name_over_500_chars_is_400_length_message() {
        let long = "x".repeat(501);
        let (status, body) = patch_pane(Some(&long), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["message"],
            json!("name must be 500 characters or fewer")
        );
    }

    #[tokio::test]
    async fn name_exactly_500_chars_is_ok() {
        let exact = "y".repeat(500);
        let (status, _body) = patch_pane(Some(&exact), true).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn missing_auth_is_401() {
        let (status, body) = patch_pane(Some("Title"), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["status"], json!("error"));
    }

    /// Confirms the route is actually mounted (as opposed to falling through to
    /// axum's SPA-fallback, which is the exact bug this task fixes): a matched
    /// route always answers with the `ok`/`error` JSON envelope, never a bare
    /// 404 with no body.
    #[tokio::test]
    async fn route_is_matched_not_fallback_404() {
        let (status, body) = patch_pane(Some("Title"), true).await;
        assert_ne!(status, StatusCode::NOT_FOUND);
        assert!(body.get("status").is_some());
    }
}

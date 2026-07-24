//! Server-side terminal **registry** — the port of `server/terminal-registry.ts`
//! ownership model + the multi-client fan-out of `server/terminal-stream/broker.ts`,
//! reduced to the `mode:'shell'` path (`port/machine/specs/terminal-core.md` §1).
//!
//! ## Why this exists (the T3 breadth gap)
//!
//! In 3.4b a terminal was owned by the WS connection that created it: its PTY and
//! its produced `terminal.output` frames lived on the connection, streamed only to
//! that one socket, and were killed when it closed. That fails every
//! detach/attach/background-session flow — a *second* or *reconnected* socket has
//! no shared object to re-attach to (`multi-client`, `reconnection`, `tab-management`
//! hot-across-reload).
//!
//! This registry moves ownership off the connection: a terminal (PTY + its seq'd
//! replay log + geometry) is keyed by `terminalId` and outlives any socket. Per the
//! spec's state machine (`§1.2`):
//!
//! * **create** registers a running terminal (PTY spawned, no client attached yet).
//! * **attach** from ANY connection sends `terminal.attach.ready`, then **replays the
//!   scrollback** (frames with `seqStart > sinceSeq`) and streams live — the
//!   snapshot-on-attach + live handoff (`§3.5`, `broker.ts:312-610`).
//! * **detach / socket-close** removes that connection's subscription but leaves the
//!   PTY **running** — `detached ≡ clients.size === 0` while `running` (`§1.2`, the
//!   background session).
//! * **kill / exit** removes the terminal and sends `terminal.exit` to every
//!   attached connection (`§1.2`, `§6.3`).
//!
//! ## Concurrency (`§7`)
//!
//! Each terminal owns an `Arc<Mutex<TerminalShared>>` holding its replay log +
//! subscriber set. The PTY reader thread's sink ([`ingest`]) locks it to append one
//! frame and fan it out; an attach locks it to snapshot the replay set and register
//! the subscriber. Because both take the SAME per-terminal lock, an attach that
//! registers a subscriber and enqueues the replay while holding the lock guarantees
//! **replay-then-live** ordering with no gap and no duplicate across the handoff
//! (the reader can't append until the attach releases the lock; frames it then
//! appends are strictly newer than the replayed span). Per-terminal seq order and
//! the `attachRequestId` stamping from 3.10 are preserved: every frame a connection
//! receives is stamped with THAT connection's active `attachRequestId`.
//!
//! Transport-agnostic on purpose: a subscriber is a bare [`FrameSink`] callback, so
//! this crate keeps its no-tokio boundary (`freshell-ws` backs the sink with a tokio
//! mpsc sender feeding the socket).

use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use freshell_platform::SpawnSpec;
use freshell_protocol::{
    GeometryAuthority, InventoryTerminal, OutputSource, ServerMessage, SessionLocator,
    TerminalAttachReady, TerminalExit, TerminalOutput, TerminalRunStatus,
};

use crate::barrier_scanner::{BarrierReason, BarrierScanner, ScannerState};
use crate::batch::{
    build_batch_wire_payloads, build_terminal_output_batches, utf16_len, BatchBuildInput,
    BatchInputFrame,
};
use crate::fragment::terminal_stream_batch_max_bytes;
use crate::pty::{MessageSink, PtyTerminal};

/// Deliver one server→client message to a single attached connection's socket.
/// Kept as an `Arc`'d `Fn` so the registry never depends on the transport: the
/// reader thread and attach path both invoke it, and `freshell-ws` provides one
/// that forwards into that connection's tokio mpsc → WebSocket.
pub type FrameSink = Arc<dyn Fn(ServerMessage) + Send + Sync>;

/// `DEFAULT_MAX_SCROLLBACK_CHARS` (`terminal-registry.ts:57`): the replay-log
/// byte cap used when no `settings.terminal.scrollback` value has been wired
/// into the registry yet (TERM-13's "absent" default -- mirrors the legacy
/// `computeScrollbackMaxChars`'s not-a-finite-number fallback).
const DEFAULT_MAX_SCROLLBACK_CHARS: i64 = 512 * 1024;
/// `MIN_SCROLLBACK_CHARS` (`terminal-registry.ts:58`).
const MIN_SCROLLBACK_CHARS: i64 = 64 * 1024;
/// `MAX_SCROLLBACK_CHARS` (`terminal-registry.ts:59`).
const MAX_SCROLLBACK_CHARS: i64 = 4 * 1024 * 1024;
/// `APPROX_CHARS_PER_LINE` (`terminal-registry.ts:60`).
const APPROX_CHARS_PER_LINE: i64 = 300;

/// `computeScrollbackMaxChars(settings)` (`terminal-registry.ts:1328-1333`):
/// `settings.terminal.scrollback` LINES converted to an approximate **CHAR**
/// cap (UTF-16 code units, matching legacy `ChunkRingBuffer`'s `chunk.length`
/// accounting) via `APPROX_CHARS_PER_LINE`, clamped to
/// `[MIN_SCROLLBACK_CHARS, MAX_SCROLLBACK_CHARS]`. Callers (`freshell-server`'s
/// boot wiring) pass the real `settings.terminal.scrollback` value; the
/// registry's OWN default before any such wiring happens is
/// `DEFAULT_MAX_SCROLLBACK_CHARS` (see `TerminalRegistry::new`), matching the
/// legacy not-a-number fallback for a constructor called with no settings at
/// all.
///
/// NOTE (unit-honesty scope limit): this function, `TerminalRegistry::
/// scrollback_max_bytes`/`set_scrollback_max_bytes`, and the
/// `scrollback_max_bytes` field all keep their historical "bytes" names for
/// public-API stability -- `crates/freshell-server/src/main.rs` calls them
/// across the crate boundary, outside this fix's file ownership. Despite the
/// name, every one of them carries a CHAR (UTF-16 code-unit) budget, never a
/// byte budget. The consumer that actually measured this cap in bytes --
/// `TerminalShared::replay_chars`/`max_replay_chars` in this same file, see
/// `ingest()` below -- has been fixed to count chars, closing the real parity
/// gap (a reviewer "Important" finding on commit f7b2c9e6). Renaming the
/// public functions/fields is left for a follow-up that also touches
/// `freshell-server`.
pub fn compute_scrollback_max_bytes(scrollback_lines: i64) -> i64 {
    scrollback_lines
        .saturating_mul(APPROX_CHARS_PER_LINE)
        .clamp(MIN_SCROLLBACK_CHARS, MAX_SCROLLBACK_CHARS)
}

/// `Date.now()` — epoch milliseconds.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One attached connection's subscription to a terminal's live stream.
struct Subscriber {
    /// Where this connection's frames go (its socket, via a tokio mpsc in `freshell-ws`).
    sink: FrameSink,
    /// The connection's active attach correlation id, stamped onto every frame it
    /// receives (`TerminalView#isCurrentAttachMessage` drops unstamped/mismatched
    /// frames — see 3.10). Per-subscriber, so two clients get their OWN id.
    attach_request_id: Option<String>,
    /// `hello.capabilities.terminalOutputBatchV1` for this connection (`ws-handler.ts:1846-1848`,
    /// stored on the attachment `broker.ts:399`). Batch framing is used **only** when
    /// this is set AND `attach_request_id` is present (`broker.ts:1315-1343`); otherwise
    /// the connection receives legacy per-frame `terminal.output` (the T1 default).
    terminal_output_batch_v1: bool,
}

/// One retained produced frame plus its persistent barrier classification (the ring's
/// `ReplayFrame` role — `replay-ring.ts:9-20`). The `output` is the canonical
/// (unstamped) `terminal.output` for legacy replay/fan-out; the classification fields
/// feed the `terminal.output.batch` merge for batch-capable subscribers.
#[derive(Clone)]
struct RetainedFrame {
    output: TerminalOutput,
    barrier: bool,
    barrier_reason: Option<BarrierReason>,
    state_before: ScannerState,
    state_after: ScannerState,
}

impl RetainedFrame {
    /// Project to a [`BatchInputFrame`] for the batch builder.
    fn to_batch_input(&self) -> BatchInputFrame {
        BatchInputFrame {
            seq_start: self.output.seq_start,
            seq_end: self.output.seq_end,
            data: self.output.data.clone(),
            bytes: self.output.data.len(),
            stream_id: self.output.stream_id.clone(),
            barrier: self.barrier,
            barrier_reason: self.barrier_reason,
            state_before: self.state_before,
            state_after: self.state_after,
        }
    }
}

/// The per-terminal stream state the reader-thread sink mutates and the registry
/// reads. Split from the PTY handle so the sink can hold an `Arc` to this without
/// owning the PTY (the create-time chicken-and-egg: the PTY is spawned WITH a sink
/// that references this).
struct TerminalShared {
    terminal_id: String,
    stream_id: String,
    /// Every produced frame (with its persistent barrier classification), in seq
    /// order — the authoritative replay buffer (`ReplayRing` role; the PTY's
    /// `OutputFramer` already assigned the seqs). Stored canonical/unstamped; each
    /// delivery stamps per-subscriber and projects to `terminal.output` (legacy) or
    /// `terminal.output.batch` (batch-capable).
    replay: VecDeque<RetainedFrame>,
    /// Total retained scrollback size in **UTF-16 code units**, matching legacy
    /// `ChunkRingBuffer`'s `this.size += chunk.length` accounting (`str.length`
    /// is UTF-16 code units in JS) -- NOT UTF-8 bytes. See [`crate::batch::utf16_len`].
    /// (Named `_chars` rather than `_bytes`: a prior port counted `data.len()`
    /// UTF-8 bytes here, which evicted non-ASCII-heavy content, e.g. box-drawing
    /// TUIs, up to 3x sooner than an ASCII session under the identical configured
    /// `terminal.scrollback` cap. Fixed to count the same unit as legacy.)
    replay_chars: usize,
    /// `settings.terminal.scrollback`, converted to a **char** (UTF-16 code-unit)
    /// cap via [`compute_scrollback_max_bytes`] and captured ONCE at
    /// terminal-creation time (TERM-13). Replaces the previous fixed 8MiB
    /// constant in the eviction loop below.
    ///
    /// NOTE: [`compute_scrollback_max_bytes`] keeps its historical "bytes" name
    /// for public-API stability (`freshell-server`'s boot wiring calls it across
    /// the crate boundary, outside this crate's ownership) despite returning a
    /// CHAR budget -- see that function's doc comment. This field and
    /// `replay_chars` are named honestly since they are private to this module.
    max_replay_chars: usize,
    /// The per-terminal stateful VT [`BarrierScanner`] (`replay-ring.ts:48`). Classifies
    /// each ingested frame in order; its mode/CSI/string state persists across frames.
    scanner: BarrierScanner,
    /// Highest `seqEnd` produced (drives `attach.ready.headSeq`).
    head_seq: i64,
    status: TerminalRunStatus,
    /// The exit code from the last `terminal.exit` fan-out (kill or natural exit).
    /// `None` while `status == Running`. Kept so a client that attaches AFTER the
    /// terminal already exited (the create-then-instant-exit race) can still be
    /// told the process is dead instead of silently seeing nothing (DEFECT 5b /
    /// "blank pane" -- see `attach`'s already-exited synthetic-exit branch).
    exit_code: Option<i64>,
    created_at: i64,
    last_activity_at: i64,
    /// Current PTY geometry + epoch (`§5.3`): epoch starts 1, +1 only on real change.
    cols: u16,
    rows: u16,
    geometry_epoch: i64,
    cwd: Option<String>,
    /// Directory metadata (`terminal-registry.ts:1614` stores `getModeLabel(opts.mode)`
    /// as the title at create; `getModeLabel('shell') === 'Shell'`). Defaults preserve
    /// the pre-meta behavior for the shell-only create path; `set_meta` (called from
    /// the WS `terminal.create` handler once CLI panes land) overrides per-mode.
    title: String,
    description: Option<String>,
    /// `TerminalMode` (`'shell' | 'claude' | 'codex' | …`).
    mode: String,
    /// The session id a CLI pane resumed from (feeds the directory `sessionRef`).
    resume_session_id: Option<String>,
    /// Attached connections, keyed by connection id (multi-client fan-out, `§7.3`).
    subscribers: HashMap<u64, Subscriber>,
}

impl TerminalShared {
    /// `single_client` while at most one socket is attached; `multi_client_unknown`
    /// once a second attaches (`§5.3`, `broker.ts:394-395`). The client uses this to
    /// decide checkpoint/delta-replay validity, so it must reflect reality.
    fn geometry_authority(&self) -> GeometryAuthority {
        if self.subscribers.len() >= 2 {
            GeometryAuthority::MultiClientUnknown
        } else {
            GeometryAuthority::SingleClient
        }
    }

    /// This terminal's `terminal.inventory` row (`registry.list()` →
    /// `normalizeTerminalInventoryForClient`, `terminal-registry.ts:4250-4263`). The
    /// SPA reads `terminalId` + `status==='running'` to keep a persisted terminal
    /// (else `clearDeadTerminals` recreates it, losing scrollback).
    fn inventory(&self) -> InventoryTerminal {
        InventoryTerminal {
            created_at: self.created_at,
            last_activity_at: self.last_activity_at,
            mode: self.mode.clone(),
            status: self.status,
            terminal_id: self.terminal_id.clone(),
            title: self.title.clone(),
            codex_durability: None,
            cwd: self.cwd.clone(),
            description: self.description.clone(),
            runtime_status: None,
            session_ref: None,
        }
    }
}

/// One terminal's row for the identity-invariant sweep
/// ([`TerminalRegistry::identity_probe_rows`]): the identity-relevant fields
/// only — deliberately NO scrollback snapshot (unlike [`DirectoryEntry`]), so
/// a periodic sweep stays cheap.
#[derive(Debug, Clone)]
pub struct IdentityProbeRow {
    pub terminal_id: String,
    pub mode: String,
    pub status: TerminalRunStatus,
    pub created_at: i64,
    /// The registry-side resume/session id (create-time resume OR a locator
    /// association written back via `set_meta`) — a terminal with this set is
    /// identity-resolved even if the caller's identity registry has no entry
    /// (e.g. REST-created resumes, whose creates can't reach the WS-owned
    /// identity registry across the crate boundary).
    pub resume_session_id: Option<String>,
}

/// One terminal's row for the REST terminal directory (`registry.list()` as consumed
/// by `terminal-view/service.ts#listTerminalDirectory`): the raw registry record the
/// `/api/terminals` router projects into the wire `TerminalDirectoryItem` (override
/// merge, `sessionRef` derivation, and `lastLine` extraction happen in the router).
#[derive(Debug, Clone)]
pub struct DirectoryEntry {
    pub terminal_id: String,
    pub title: String,
    pub description: Option<String>,
    pub mode: String,
    pub resume_session_id: Option<String>,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub status: TerminalRunStatus,
    /// `clients.size > 0` — whether any connection is currently attached.
    pub has_clients: bool,
    pub cwd: Option<String>,
    /// The retained scrollback reassembled in seq order (the original's
    /// `record.buffer.snapshot()` — both sides are byte-capped rings, so this is
    /// the same tail the original's `lastEmittedLine` reads).
    pub snapshot: String,
}

/// The registry's control handle for one terminal: the shared stream state plus the
/// PTY (for input/resize/kill). `pty` is `Option` so tests can register a headless
/// terminal and drive the stream logic deterministically without a real child.
struct TerminalHandle {
    shared: Arc<Mutex<TerminalShared>>,
    pty: Option<PtyTerminal>,
}

struct RegistryInner {
    terminals: HashMap<String, TerminalHandle>,
    /// Run-monotonic inventory revision (`terminals.changed.revision`, `§7.5`). Only
    /// its monotonic increase is asserted by the oracle, not the value.
    revision: i64,
}

/// Shared, cheaply-cloneable owner of all live terminals, keyed by `terminalId`.
/// Lives in `WsState` so every `/ws` connection resolves terminals through the SAME
/// registry — the whole point: a terminal survives its creating socket.
/// `settings.safety.autoKillIdleMinutes` default (`server/settings.ts:791`,
/// mirrored at `crates/freshell-server/src/settings.rs:70`). Applied whenever
/// a [`TerminalRegistry`] is constructed but `set_auto_kill_idle_minutes`
/// hasn't been called yet (e.g. before the boot-time settings load completes).
const DEFAULT_AUTO_KILL_IDLE_MINUTES: i64 = 15;

/// TERM-15/TERM-16 activity tap: the registry-level lifecycle events the
/// activity hub (`freshell-ws`) subscribes to. `Created`/`Exit` fire for
/// every mode; `Input`/`Output` fire only for CLI modes (`mode != "shell"`)
/// so plain shells pay zero per-chunk tap cost. The observer runs on the
/// caller's thread (`Created`/`Input`/kill-`Exit`) or the PTY reader thread
/// (`Output`/natural-exit `Exit`) — it must be cheap and non-blocking.
#[derive(Debug, Clone, PartialEq)]
pub enum ActivityEvent {
    Created {
        terminal_id: String,
        mode: String,
        resume_session_id: Option<String>,
        at: i64,
    },
    Input {
        terminal_id: String,
        data: String,
        at: i64,
    },
    Output {
        terminal_id: String,
        data: String,
        at: i64,
    },
    Exit {
        terminal_id: String,
        at: i64,
    },
}

/// The activity tap callback (see [`ActivityEvent`]).
pub type ActivityObserver = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

#[derive(Clone)]
pub struct TerminalRegistry {
    inner: Arc<Mutex<RegistryInner>>,
    conn_seq: Arc<AtomicU64>,
    /// DIAG-05: a LIVE count of currently-open `/ws` connections (distinct
    /// from `conn_seq`, which is a monotonic minting counter that never goes
    /// down). Incremented in [`Self::new_connection_id`] (called once per
    /// connection establish, `freshell_ws::terminal::run`), decremented in
    /// [`Self::remove_connection`] (called once per connection close, same
    /// call site) -- both call sites already exist and are unchanged; only
    /// their bodies gained this counter. Surfaced via [`Self::connection_count`]
    /// as `GET /api/debug`'s `wsConnections` (legacy
    /// `wsHandler.connectionCount()`, `server/debug-router.ts:16`).
    active_connections: Arc<AtomicI64>,
    /// `this.settings.safety.autoKillIdleMinutes` (`terminal-registry.ts:1409`,
    /// read fresh on every sweep tick from `this.settings`, which `setSettings`
    /// keeps current). Stored as an atomic so `enforce_idle_kills` never needs
    /// the registry lock just to read the threshold, and so a live settings
    /// change (`set_auto_kill_idle_minutes`) is visible on the NEXT sweep
    /// without restarting the monitor.
    auto_kill_idle_minutes: Arc<AtomicI64>,
    /// `this.scrollbackMaxChars` (`terminal-registry.ts:1276`, computed by
    /// `computeScrollbackMaxChars` from `settings.terminal.scrollback`).
    /// Captured into each new terminal's `max_replay_chars` at [`Self::create`]
    /// time (TERM-13) -- see [`compute_scrollback_max_bytes`].
    scrollback_max_bytes: Arc<AtomicI64>,
    /// TERM-15/TERM-16 activity tap (see [`ActivityEvent`]). Set once at boot
    /// by the activity hub; `None` (the default) keeps every fire point a
    /// cheap no-op. RwLock: read per event, written once.
    activity_observer: Arc<std::sync::RwLock<Option<ActivityObserver>>>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome of an [`TerminalRegistry::attach`]: whether the terminal existed (the
/// `attach.ready` + replay were enqueued to the caller's sink) — `false` mirrors the
/// reference's `INVALID_TERMINAL_ID` (attach to an unknown/exited terminal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachOutcome {
    pub found: bool,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                terminals: HashMap::new(),
                revision: 0,
            })),
            conn_seq: Arc::new(AtomicU64::new(1)),
            active_connections: Arc::new(AtomicI64::new(0)),
            auto_kill_idle_minutes: Arc::new(AtomicI64::new(DEFAULT_AUTO_KILL_IDLE_MINUTES)),
            scrollback_max_bytes: Arc::new(AtomicI64::new(DEFAULT_MAX_SCROLLBACK_CHARS)),
            activity_observer: Arc::new(std::sync::RwLock::new(None)),
        }
    }

    /// Mint a unique id for one WS connection (used to key its subscriptions so
    /// socket-close can sweep them out of every terminal).
    pub fn new_connection_id(&self) -> u64 {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        self.conn_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// DIAG-05: the live count of currently-open `/ws` connections (see
    /// `active_connections`'s field doc for exactly which call sites
    /// increment/decrement it). Surfaced as `GET /api/debug`'s
    /// `wsConnections`.
    pub fn connection_count(&self) -> usize {
        self.active_connections.load(Ordering::Relaxed).max(0) as usize
    }

    /// `registry.setSettings(settings)`'s `autoKillIdleMinutes` slice
    /// (`terminal-registry.ts:1316-1322`): update the idle-kill threshold the
    /// NEXT sweep reads. Callers (the boot-time settings load, and any future
    /// live `PATCH /api/settings` wiring) push `settings.safety.autoKillIdleMinutes`
    /// here; `<= 0` disables the sweep (legacy: `!killMinutes || killMinutes <= 0`).
    /// Install the TERM-15/TERM-16 activity tap (see [`ActivityEvent`]).
    /// Set once at boot by the activity hub; later calls replace it.
    pub fn set_activity_observer(&self, observer: ActivityObserver) {
        *self
            .activity_observer
            .write()
            .expect("activity observer lock") = Some(observer);
    }

    /// Fire the activity tap, if installed. Cheap no-op otherwise.
    fn notify_activity(&self, event: ActivityEvent) {
        let guard = self
            .activity_observer
            .read()
            .expect("activity observer lock");
        if let Some(observer) = guard.as_ref() {
            observer(event);
        }
    }

    pub fn set_auto_kill_idle_minutes(&self, minutes: i64) {
        self.auto_kill_idle_minutes
            .store(minutes, Ordering::Relaxed);
    }

    /// The currently-configured idle-kill threshold, minutes.
    pub fn auto_kill_idle_minutes(&self) -> i64 {
        self.auto_kill_idle_minutes.load(Ordering::Relaxed)
    }

    /// `registry.setSettings(settings)`'s `scrollbackMaxChars` recompute
    /// (`terminal-registry.ts:1317-1321`): update the replay-log byte cap NEW
    /// terminals will be created with (TERM-13). Callers pass
    /// `compute_scrollback_max_bytes(settings.terminal.scrollback)`, keeping this
    /// crate settings-type-agnostic (mirrors `set_auto_kill_idle_minutes`).
    ///
    /// NOTE (documented scope limit): legacy's `setSettings` ALSO resizes every
    /// ALREADY-CREATED terminal's buffer in place (`t.buffer.setMaxChars(...)`
    /// loop). This port only applies the cap to terminals created AFTER this
    /// call, matching the task's "respected at create" acceptance bar. Live
    /// `PATCH /api/settings` -> registry wiring DOES exist (commit f766ad6c:
    /// `apply_live_registry_settings`), so the setting applies without restart
    /// to newly-created terminals; in-place resize of already-open terminals
    /// remains deferred.
    pub fn set_scrollback_max_bytes(&self, max_bytes: i64) {
        self.scrollback_max_bytes
            .store(max_bytes, Ordering::Relaxed);
    }

    /// The byte cap NEW terminals are created with.
    pub fn scrollback_max_bytes(&self) -> i64 {
        self.scrollback_max_bytes.load(Ordering::Relaxed)
    }

    /// `enforceIdleKills()` (`terminal-registry.ts:1406-1425`): auto-kill every
    /// DETACHED **running** terminal idle beyond the configured threshold.
    /// `auto_kill_idle_minutes() <= 0` is legacy's disabled state -- a no-op.
    /// "Detached" mirrors `term.clients.size > 0` continue-guard: any attached
    /// subscriber exempts the terminal regardless of idle time. Returns the
    /// killed terminal ids (empty when nothing was eligible), for callers that
    /// want to log/observe the sweep and for deterministic test assertions.
    ///
    /// Callers drive the 30s cadence externally (`startIdleMonitor`,
    /// `tr:1335-1340`) -- this crate is deliberately tokio-free (see module
    /// docs), so the periodic timer lives in `freshell-ws`
    /// (`spawn_idle_monitor`), not here.
    pub fn enforce_idle_kills(&self) -> Vec<String> {
        let auto_kill_idle_minutes = self.auto_kill_idle_minutes();
        if auto_kill_idle_minutes <= 0 {
            return Vec::new();
        }
        let now = now_ms();
        let idle_threshold_ms = auto_kill_idle_minutes.saturating_mul(60_000);
        let mut candidates: Vec<String> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .iter()
                .filter_map(|(id, handle)| {
                    let s = handle.shared.lock().expect("terminal lock");
                    if s.status != TerminalRunStatus::Running {
                        return None; // only running
                    }
                    if !s.subscribers.is_empty() {
                        return None; // only detached
                    }
                    if now.saturating_sub(s.last_activity_at) < idle_threshold_ms {
                        return None; // not idle long enough yet
                    }
                    Some(id.clone())
                })
                .collect()
        };
        // Deterministic order for observability/tests; the reference iterates a
        // `Map` in insertion order, which this doesn't reproduce exactly, but no
        // caller (log line, test) depends on kill ORDER across multiple victims.
        candidates.sort();
        for id in &candidates {
            self.kill_internal(id, "idle");
        }
        // DIAG-01: a single summary event per sweep -- only when it actually
        // killed something (a no-op sweep, the common case on a 30s cadence,
        // would otherwise spam the log every tick).
        if !candidates.is_empty() {
            tracing::info!(count = candidates.len(), "terminal.idle_reap");
        }
        candidates
    }

    /// `registry.create()` (`terminal-registry.ts:1544-1740`): spawn the PTY and
    /// register it as a **running** terminal owned by no connection. The PTY's reader
    /// thread frames output straight into this terminal's replay log (and fans out to
    /// any attached subscriber) via [`ingest`]. Bumps the inventory revision.
    ///
    /// Create does NOT attach — the client sends `terminal.attach` next (`§1.2`).
    ///
    /// `mode` and `resume_session_id` are the REAL launch identity, stamped
    /// onto the record (and the `terminal.created` tracing event) from birth.
    /// Both used to be hardcoded (`mode: "shell"`, `resume: None`) until the
    /// WS handler's later `set_meta` overwrote them — during the 2026-07-22
    /// codex-resume incident that lying log reported six codex panes as plain
    /// shells and actively misled the forensic investigation.
    ///
    /// 8 arguments (`clippy::too_many_arguments`): every one is a distinct,
    /// non-optional create input; a params struct would just restate the
    /// `terminal.create` wire message this crate deliberately doesn't own
    /// (same justification as [`Self::attach`]).
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        spec: &SpawnSpec,
        env: &std::collections::BTreeMap<String, String>,
        terminal_id: String,
        stream_id: String,
        mode: &str,
        resume_session_id: Option<&str>,
        ring_max_bytes: Option<i64>,
        on_exit: Option<crate::pty::ExitHook>,
    ) -> io::Result<()> {
        let now = now_ms();
        let shared = Arc::new(Mutex::new(TerminalShared {
            terminal_id: terminal_id.clone(),
            stream_id: stream_id.clone(),
            replay: VecDeque::new(),
            replay_chars: 0,
            // TERM-13: capture the CURRENTLY-configured scrollback cap at
            // creation time (`compute_scrollback_max_bytes`'s output -- a CHAR
            // budget despite the name, see that fn's doc comment -- seeded
            // from `settings.terminal.scrollback` at boot).
            max_replay_chars: self.scrollback_max_bytes().max(0) as usize,
            scanner: BarrierScanner::new(),
            head_seq: 0,
            status: TerminalRunStatus::Running,
            exit_code: None,
            created_at: now,
            last_activity_at: now,
            cols: spec.cols,
            rows: spec.rows,
            geometry_epoch: 1,
            cwd: spec.cwd.clone(),
            title: "Shell".to_string(),
            description: None,
            mode: mode.to_string(),
            resume_session_id: resume_session_id.map(str::to_string),
            subscribers: HashMap::new(),
        }));

        // The reader thread invokes this for every framed terminal.output: append to
        // the replay log + fan out (stamped) to subscribers. Captures the shared
        // state, NOT the PTY (which does not exist yet).
        let sink_shared = Arc::clone(&shared);
        // TERM-15/TERM-16 output tap: CLI modes forward each framed output
        // chunk to the activity observer (BEL turn-complete detection +
        // liveness). Shell terminals skip the tap entirely (`tapped` false):
        // zero per-chunk overhead beyond one bool test.
        let tapped = mode != "shell";
        let tap_observer = Arc::clone(&self.activity_observer);
        let tap_terminal_id = terminal_id.clone();
        let sink: MessageSink = Box::new(move |msg| {
            if tapped {
                if let ServerMessage::TerminalOutput(frame) = &msg {
                    let guard = tap_observer.read().expect("activity observer lock");
                    if let Some(observer) = guard.as_ref() {
                        observer(ActivityEvent::Output {
                            terminal_id: tap_terminal_id.clone(),
                            data: frame.data.clone(),
                            at: now_ms(),
                        });
                    }
                }
            }
            ingest(&sink_shared, msg)
        });

        let pty = PtyTerminal::spawn_with_sink(
            spec,
            env,
            terminal_id.clone(),
            stream_id,
            ring_max_bytes,
            Some(sink),
            on_exit,
        )?;

        // DIAG-01: terminal lifecycle event -- captured BEFORE `pty` is moved
        // into the registry, from the just-spawned PTY (so `pid` reflects
        // the real child, not a stale/absent value).
        let pid = pty.pid();

        let mut inner = self.inner.lock().expect("registry lock");
        inner.terminals.insert(
            terminal_id.clone(),
            TerminalHandle {
                shared,
                pty: Some(pty),
            },
        );
        inner.revision += 1;
        drop(inner);

        // DIAG-01 + 2026-07-22 incident fix: log the REAL mode and whether a
        // resume id was applied. This line used to hardcode `mode = "shell"`,
        // which reported resumed codex panes as plain shells and misled the
        // incident investigation. (The wire `terminal.created` frame was
        // already correct -- it's built in the WS handler; only this LOG lied.)
        tracing::info!(
            terminal_id = %terminal_id,
            mode = %mode,
            resume_applied = resume_session_id.is_some(),
            cwd = %spec.cwd.as_deref().unwrap_or(""),
            pid = pid.unwrap_or(0),
            "terminal.created"
        );
        // TERM-15/TERM-16 tap: Created fires for every mode (the hub filters).
        self.notify_activity(ActivityEvent::Created {
            terminal_id,
            mode: mode.to_string(),
            resume_session_id: resume_session_id.map(str::to_string),
            at: now,
        });
        Ok(())
    }

    /// `broker.attach*()` (`broker.ts:258-610`): attach connection `conn_id` (with its
    /// `sink`) to `terminal_id`. Under the per-terminal lock: snapshot the replay set
    /// (`seqStart > sinceSeq`), register the subscriber, then enqueue `attach.ready`
    /// followed by the replayed frames (stamped + `source:'replay'`). Live frames the
    /// reader appends after we release the lock fan out to `sink` strictly after the
    /// replay — no gap, no duplicate (`§7.4`).
    ///
    /// Re-attaching the same `conn_id` REPLACES its subscription (new `attachRequestId`,
    /// re-replay) — the reconnect / viewport-hydrate path.
    ///
    /// `session_ref` is the terminal's canonical session identity, resolved by
    /// the CALLER (the WS handler owns the identity registry — this crate is
    /// deliberately identity-agnostic) and stamped verbatim onto the
    /// `terminal.attach.ready` frame (STATE-SYNC FIX 1 increment 2a: the frozen
    /// client folds `attach.ready.sessionRef` into pane identity via
    /// `reconcileTerminalSessionAssociation`, a repair channel that was dead
    /// while this frame hardcoded `None`).
    ///
    /// 8 arguments (`clippy::too_many_arguments`): every one is a distinct,
    /// non-optional attach input with exactly one call site outside tests
    /// (`freshell_ws::terminal::handle_attach`, which forwards the parsed
    /// `terminal.attach` frame fields 1:1) — a params struct would just
    /// restate the wire message this crate deliberately doesn't own.
    #[allow(clippy::too_many_arguments)]
    pub fn attach(
        &self,
        terminal_id: &str,
        conn_id: u64,
        sink: FrameSink,
        attach_request_id: Option<String>,
        since_seq: i64,
        terminal_output_batch_v1: bool,
        session_ref: Option<SessionLocator>,
    ) -> AttachOutcome {
        // Take the terminal's shared Arc under the registry lock, then drop the
        // registry lock so we hold ONLY the per-terminal lock during the handoff.
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get(terminal_id) {
                Some(h) => Arc::clone(&h.shared),
                None => return AttachOutcome { found: false },
            }
        };

        let mut s = shared.lock().expect("terminal lock");
        let effective_since = since_seq.max(0);

        // Snapshot the replay window: every retained frame newer than the client's
        // cursor (`replaySince`, `replay-deque.ts:89-98`).
        let replay: Vec<RetainedFrame> = s
            .replay
            .iter()
            .filter(|f| f.output.seq_start > effective_since)
            .cloned()
            .collect();
        let head_seq = s.head_seq;
        // replayFromSeq/replayToSeq = first/last replayed span, else headSeq+1/headSeq
        // (`broker.ts:488-489`).
        let (replay_from, replay_to) = match (replay.first(), replay.last()) {
            (Some(a), Some(b)) => (a.output.seq_start, b.output.seq_end),
            _ => (head_seq + 1, head_seq),
        };

        // Register BEFORE enqueuing so any live frame the reader appends after we
        // release the lock is delivered strictly after this replay (the reader is
        // blocked on this same lock until we return).
        s.subscribers.insert(
            conn_id,
            Subscriber {
                sink: Arc::clone(&sink),
                attach_request_id: attach_request_id.clone(),
                terminal_output_batch_v1,
            },
        );

        let ready = ServerMessage::TerminalAttachReady(TerminalAttachReady {
            head_seq,
            replay_from_seq: replay_from,
            replay_to_seq: replay_to,
            stream_id: s.stream_id.clone(),
            terminal_id: terminal_id.to_string(),
            attach_request_id: attach_request_id.clone(),
            effective_since_seq: Some(effective_since),
            geometry_authority: Some(s.geometry_authority()),
            geometry_epoch: Some(s.geometry_epoch),
            replay_reset_reason: None,
            requested_since_seq: Some(since_seq),
            session_ref,
        });
        sink(ready);

        // Batch framing is used only with the capability AND an attachRequestId present
        // (`broker.ts:1315-1343`); otherwise legacy per-frame `terminal.output` (T1).
        match (terminal_output_batch_v1, attach_request_id.as_deref()) {
            (true, Some(arid)) => {
                deliver_batches(&sink, terminal_id, &replay, arid, "replay");
            }
            _ => {
                for frame in replay {
                    let mut out = frame.output;
                    out.attach_request_id = attach_request_id.clone();
                    out.source = Some(OutputSource::Replay);
                    sink(ServerMessage::TerminalOutput(out));
                }
            }
        }

        // DEFECT 5b ("blank pane" on an instant-exit CLI failure): a terminal
        // that already exited before this attach (the create-then-instant-exit
        // race -- e.g. a resumed coding-CLI session whose process dies within
        // milliseconds) fanned its `terminal.exit` out to zero subscribers
        // (finish_pty_exit/kill run with nobody attached yet). Without this,
        // the newly-attached client gets replayed output (if any) and then
        // silence forever: no error, no exited state, no live output -- a
        // permanently blank/frozen pane. Synthesize the exit here so a client
        // attaching to an already-dead terminal is told, exactly once, just
        // like a client that was already attached when the process died.
        if s.status == TerminalRunStatus::Exited {
            let exit = ServerMessage::TerminalExit(TerminalExit {
                exit_code: s.exit_code.unwrap_or(0),
                terminal_id: terminal_id.to_string(),
            });
            sink(exit);
            s.subscribers.remove(&conn_id);
        }

        AttachOutcome { found: true }
    }

    /// `broker.detach()` (`broker.ts:618-639`): drop `conn_id`'s subscription. The PTY
    /// keeps running and buffering — the background session (`§1.3`). No-op if the
    /// terminal or subscription is already gone.
    pub fn detach(&self, terminal_id: &str, conn_id: u64) {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        if let Some(shared) = shared {
            shared
                .lock()
                .expect("terminal lock")
                .subscribers
                .remove(&conn_id);
        }
    }

    /// On socket close: sweep `conn_id` out of EVERY terminal's subscriber set. All
    /// PTYs keep running (background sessions), reattachable by a future socket.
    pub fn remove_connection(&self, conn_id: u64) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        for shared in shareds {
            shared
                .lock()
                .expect("terminal lock")
                .subscribers
                .remove(&conn_id);
        }
    }

    /// `terminal.input` write path (`terminal-registry.ts:3867-3894`): write bytes to
    /// the PTY; bump `lastActivityAt`. No wire reply.
    pub fn input(&self, terminal_id: &str, data: &[u8]) {
        let tapped_mode = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get_mut(terminal_id) {
                Some(handle) => {
                    if let Some(pty) = handle.pty.as_mut() {
                        let _ = pty.write_input(data);
                    }
                    let mut s = handle.shared.lock().expect("terminal lock");
                    s.last_activity_at = now_ms();
                    s.mode != "shell"
                }
                None => false,
            }
        };
        // TERM-15/TERM-16 tap (outside the registry lock): CLI-mode input
        // feeds submit detection. Shell terminals skip it entirely.
        if tapped_mode {
            self.notify_activity(ActivityEvent::Input {
                terminal_id: terminal_id.to_string(),
                data: String::from_utf8_lossy(data).into_owned(),
                at: now_ms(),
            });
        }
    }

    /// `terminal.resize` (`terminal-registry.ts:3975-3995`): `unchanged` when cols/rows
    /// already match; else set them, `+1` the geometry epoch (`§5.3`), and resize the
    /// PTY (errors swallowed, as node-pty's are).
    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        let mut inner = self.inner.lock().expect("registry lock");
        if let Some(handle) = inner.terminals.get_mut(terminal_id) {
            {
                let mut s = handle.shared.lock().expect("terminal lock");
                if s.cols == cols && s.rows == rows {
                    return;
                }
                s.cols = cols;
                s.rows = rows;
                s.geometry_epoch += 1;
            }
            if let Some(pty) = handle.pty.as_ref() {
                pty.resize(cols, rows);
            }
        }
    }

    /// `registry.kill()` (`terminal-registry.ts:3997-4033`): remove the terminal, send
    /// `terminal.exit{exitCode:0}` to every attached connection, and SIGKILL+reap the
    /// PTY. Bumps the inventory revision. Returns whether the terminal existed.
    ///
    /// DIAG-01: this is the "api"-initiated kill path (a client's explicit
    /// `terminal.kill`); see [`Self::kill_internal`] for the `by`-tagged
    /// event other callers (idle-reap, shutdown) use.
    pub fn kill(&self, terminal_id: &str) -> bool {
        self.kill_internal(terminal_id, "api")
    }

    /// Shared kill implementation. `by` distinguishes the caller for the
    /// `terminal.killed` DIAG-01 event (`"api"` | `"idle"` | `"shutdown"`)
    /// without adding a public parameter to [`Self::kill`] (preserving that
    /// method's existing signature for `freshell-ws` and any other caller).
    fn kill_internal(&self, terminal_id: &str, by: &'static str) -> bool {
        let handle = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.remove(terminal_id) {
                Some(handle) => {
                    inner.revision += 1;
                    Some(handle)
                }
                None => None,
            }
        };
        let Some(mut handle) = handle else {
            return false;
        };
        let was_running = {
            let mut s = handle.shared.lock().expect("terminal lock");
            let was_running = s.status == TerminalRunStatus::Running;
            s.status = TerminalRunStatus::Exited;
            s.exit_code = Some(0);
            let exit = ServerMessage::TerminalExit(TerminalExit {
                exit_code: 0,
                terminal_id: terminal_id.to_string(),
            });
            for sub in s.subscribers.values() {
                (sub.sink)(exit.clone());
            }
            s.subscribers.clear();
            was_running
        };
        // SAFE-11/TERM-22 (stale-pid group-kill hardening, second independent
        // layer): only ever call `pty.kill()` when the registry itself still
        // believed this terminal was Running. A terminal already marked
        // `Exited` (via `finish_pty_exit` -- RETAINED in the inventory, see
        // that function's doc comment) reaches this same `kill()` whenever a
        // later, unrelated sweep (`kill_all`'s shutdown sweep walks EVERY
        // tracked id, including retained-exited ones) names it. Its
        // `PtyTerminal`'s cached OS pid may since have been recycled by the
        // kernel to a completely unrelated process group; blindly calling
        // `pty.kill()` here would attempt to SIGKILL that unrelated group.
        // (The `PtyTerminal` itself is independently hardened too --
        // `mark_naturally_exited` marks it reaped + drops the cached pid at
        // natural-exit time -- but this check means the registry never even
        // ATTEMPTS the call for a non-Running terminal, regardless of the
        // `PtyTerminal`'s own state.)
        if was_running {
            if let Some(mut pty) = handle.pty.take() {
                pty.kill();
            }
        }
        tracing::info!(terminal_id = %terminal_id, by = by, "terminal.killed");
        // TERM-15/TERM-16 tap: a kill clears activity too — no stale blue.
        self.notify_activity(ActivityEvent::Exit {
            terminal_id: terminal_id.to_string(),
            at: now_ms(),
        });
        true
    }

    /// SAFE-11/TERM-22: reap **every** currently-tracked terminal on server
    /// shutdown — legacy parity with `terminal-registry.ts:4843`
    /// `shutdownGracefully()` (SIGTERM every running PTY, wait up to a
    /// timeout, force-kill the remainder) applied to the whole registry
    /// instead of one id at a time. This port's per-terminal [`Self::kill`]
    /// is already an immediate SIGKILL-and-reap (see `PtyTerminal::kill`'s
    /// doc comment), so `kill_all` reuses that same convention for every
    /// tracked terminal rather than introducing a second, SIGTERM-then-wait
    /// code path that no other caller in this port uses.
    ///
    /// Snapshots the id set first (rather than holding the registry lock
    /// while killing) so a `kill()` reentered from a terminal's own exit
    /// fan-out can't deadlock against this call. Returns the number of
    /// terminals actually killed, for shutdown logging/tests.
    pub fn kill_all(&self) -> usize {
        let ids: Vec<String> = {
            let inner = self.inner.lock().expect("registry lock");
            inner.terminals.keys().cloned().collect()
        };
        ids.iter()
            .filter(|id| self.kill_internal(id, "shutdown"))
            .count()
    }

    /// `finishTerminalPtyExit` (`terminal-registry.ts:1479-1510`), non-codex core —
    /// the NATURAL-exit path (the kill path stays in [`kill`](Self::kill), which
    /// removes the record first so this lookup misses, mirroring the original's
    /// `record.status === 'exited'` early-return at `tr:1760`). Marks the record
    /// `exited` (RETAINED in the inventory — the original reaps only beyond
    /// `MAX_EXITED_TERMINALS`, `tr:1512-1528`), stamps `lastActivityAt`, fans
    /// `terminal.exit{exitCode}` out to every attached connection, and drops the
    /// subscriptions (`record.clients.clear()`). Live-pinned against the original
    /// 2026-07-13 (`~/freshell-scratch-007/exit-{orig,rust}.json`): typing `exit`
    /// yields `terminal.exit{exitCode:0}` + inventory `status:"exited"`,
    /// `hasClients:false`, record retained.
    ///
    /// Called from the PTY reader thread's exit hook (after the final output
    /// frame; the exit code comes from the waiter thread's `child.wait()`).
    /// Deliberately does NOT drop the `TerminalHandle.pty` here — that would join
    /// the very reader thread this runs on.
    pub fn finish_pty_exit(&self, terminal_id: &str, exit_code: i64) -> bool {
        let shared = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get_mut(terminal_id) {
                Some(handle) => {
                    // SAFE-11/TERM-22 (stale-pid group-kill hardening): mark
                    // the underlying PtyTerminal reaped + drop its cached pid
                    // NOW, at the moment of natural exit, rather than leaving
                    // it live in the (retained) record for a later, unrelated
                    // `kill()`/`kill_all()` to potentially re-signal against a
                    // since-recycled pid. Safe to call from here: it neither
                    // blocks nor joins any thread (see its own doc comment),
                    // which matters because natural exit runs THIS callback
                    // from inside the PtyTerminal's own reader thread.
                    if let Some(pty) = handle.pty.as_mut() {
                        pty.mark_naturally_exited();
                    }
                    Arc::clone(&handle.shared)
                }
                None => return false, // killed (kill removes the record) or unknown
            }
        };
        let mut s = shared.lock().expect("terminal lock");
        if s.status == TerminalRunStatus::Exited {
            return false;
        }
        s.status = TerminalRunStatus::Exited;
        s.exit_code = Some(exit_code);
        s.last_activity_at = now_ms();
        let exit = ServerMessage::TerminalExit(TerminalExit {
            exit_code,
            terminal_id: terminal_id.to_string(),
        });
        for sub in s.subscribers.values() {
            (sub.sink)(exit.clone());
        }
        s.subscribers.clear();
        drop(s);
        tracing::info!(terminal_id = %terminal_id, exit_code = exit_code, "terminal.exited");
        // TERM-15/TERM-16 tap: natural exit clears activity (the hub removes
        // the record — no stale blue after exit, TERM-18 semantics).
        self.notify_activity(ActivityEvent::Exit {
            terminal_id: terminal_id.to_string(),
            at: now_ms(),
        });
        true
    }

    /// The live terminals for `terminal.inventory.terminals` (handshake + any refetch),
    /// sorted by `createdAt` then `terminalId` for a deterministic order.
    pub fn inventory(&self) -> Vec<InventoryTerminal> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        let mut out: Vec<InventoryTerminal> = shareds
            .iter()
            .map(|s| s.lock().expect("terminal lock").inventory())
            .collect();
        out.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.terminal_id.cmp(&b.terminal_id))
        });
        out
    }

    /// Lightweight identity-probe rows for the STATE-SYNC invariant sweep
    /// (`freshell_ws::invariants`): terminal id, mode, run status, creation
    /// time, and the registry-side resume id — WITHOUT the reassembled
    /// scrollback snapshot [`Self::directory`] pays for, so a periodic sweep
    /// can call this every tick.
    pub fn identity_probe_rows(&self) -> Vec<IdentityProbeRow> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        shareds
            .iter()
            .map(|shared| {
                let s = shared.lock().expect("terminal lock");
                IdentityProbeRow {
                    terminal_id: s.terminal_id.clone(),
                    mode: s.mode.clone(),
                    status: s.status,
                    created_at: s.created_at,
                    resume_session_id: s.resume_session_id.clone(),
                }
            })
            .collect()
    }

    /// Set a terminal's directory metadata (title/description/mode/resumeSessionId) —
    /// the values `terminal-registry.ts:1544-1740` derives at create time
    /// (`getModeLabel(opts.mode)` title, the CLI resume session id, …). Split from
    /// [`create`](Self::create) so the shell-only create path keeps its signature;
    /// the WS `terminal.create` handler calls this with mode context. `None` leaves
    /// a field unchanged.
    pub fn set_meta(
        &self,
        terminal_id: &str,
        title: Option<String>,
        description: Option<String>,
        mode: Option<String>,
        resume_session_id: Option<String>,
    ) {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        if let Some(shared) = shared {
            let mut s = shared.lock().expect("terminal lock");
            if let Some(title) = title {
                s.title = title;
            }
            if let Some(description) = description {
                s.description = Some(description);
            }
            if let Some(mode) = mode {
                s.mode = mode;
            }
            if let Some(rsid) = resume_session_id {
                s.resume_session_id = Some(rsid);
            }
        }
    }

    /// `registry.updateTitle()` — the PATCH `/api/terminals/:id` write-through when a
    /// non-empty `titleOverride` lands (`terminals-router.ts:303`).
    pub fn update_title(&self, terminal_id: &str, title: &str) {
        self.set_meta(terminal_id, Some(title.to_string()), None, None, None);
    }

    /// `registry.updateDescription()` — the PATCH write-through for
    /// `descriptionOverride` (`terminals-router.ts:304`).
    pub fn update_description(&self, terminal_id: &str, description: &str) {
        self.set_meta(terminal_id, None, Some(description.to_string()), None, None);
    }

    /// `registry.list()` as consumed by the `/api/terminals` directory
    /// (`terminal-view/service.ts#listTerminalDirectory`): every registered
    /// terminal's raw record, including the reassembled scrollback snapshot the
    /// `lastLine` extraction reads. Unsorted — the router applies the original's
    /// `compareTerminals` (lastActivityAt desc, then terminalId desc).
    pub fn directory(&self) -> Vec<DirectoryEntry> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        shareds
            .iter()
            .map(|shared| {
                let s = shared.lock().expect("terminal lock");
                DirectoryEntry {
                    terminal_id: s.terminal_id.clone(),
                    title: s.title.clone(),
                    description: s.description.clone(),
                    mode: s.mode.clone(),
                    resume_session_id: s.resume_session_id.clone(),
                    created_at: s.created_at,
                    last_activity_at: s.last_activity_at,
                    status: s.status,
                    has_clients: !s.subscribers.is_empty(),
                    cwd: s.cwd.clone(),
                    snapshot: s.replay.iter().map(|f| f.output.data.as_str()).collect(),
                }
            })
            .collect()
    }

    /// The current `terminals.changed.revision` (run-monotonic, `§7.5`).
    pub fn revision(&self) -> i64 {
        self.inner.lock().expect("registry lock").revision
    }

    /// Whether a terminal is currently registered (running). For teardown assertions.
    pub fn is_running(&self, terminal_id: &str) -> bool {
        self.inner
            .lock()
            .expect("registry lock")
            .terminals
            .contains_key(terminal_id)
    }
}

/// The reader-thread sink body (`onTerminalOutputRaw` → append + live flush,
/// `broker.ts:777-826`): classify the produced frame with the persistent barrier
/// scanner, store it in the replay log, and fan it out — stamped with each
/// subscriber's `attachRequestId` — to every attached connection, as
/// `terminal.output` (legacy) or `terminal.output.batch` (batch-capable).
fn ingest(shared: &Arc<Mutex<TerminalShared>>, msg: ServerMessage) {
    let ServerMessage::TerminalOutput(frame) = msg else {
        return;
    };
    let mut s = shared.lock().expect("terminal lock");
    s.head_seq = s.head_seq.max(frame.seq_end);
    s.last_activity_at = now_ms();

    // Classify with the persistent per-terminal scanner (state persists across frames,
    // `replay-ring.ts:62-79`). Non-truncated frames (every graded chunk) classify by
    // the scan result directly.
    let classification = s.scanner.scan(&frame.data);
    let retained = RetainedFrame {
        output: frame,
        barrier: classification.barrier,
        barrier_reason: classification.reason,
        state_before: classification.state_before,
        state_after: classification.state_after,
    };
    let terminal_id = s.terminal_id.clone();

    // Fan out LIVE per-subscriber. Batch-capable subscribers (cap + attachRequestId)
    // receive `terminal.output.batch`; everyone else the legacy `terminal.output`
    // (source stays 'live'). A single live frame is one small batch — the merge logic
    // is the same as replay's (proven byte-exact by the deterministic crate goldens).
    for sub in s.subscribers.values() {
        match (
            sub.terminal_output_batch_v1,
            sub.attach_request_id.as_deref(),
        ) {
            (true, Some(arid)) => {
                deliver_batches(
                    &sub.sink,
                    &terminal_id,
                    std::slice::from_ref(&retained),
                    arid,
                    "live",
                );
            }
            _ => {
                let mut f = retained.output.clone();
                f.attach_request_id = sub.attach_request_id.clone();
                (sub.sink)(ServerMessage::TerminalOutput(f));
            }
        }
    }

    // Retain canonical (unstamped) for future replay; whole-frame FIFO eviction past
    // the char cap (keep at least one frame). Counts **UTF-16 code units**
    // (`utf16_len`), matching legacy `ChunkRingBuffer`'s `this.size += chunk.length`
    // -- NOT UTF-8 bytes -- so a box-drawing/unicode-heavy session evicts at the
    // same rate as an ASCII session under the identical configured
    // `terminal.scrollback` cap.
    s.replay_chars += utf16_len(&retained.output.data).max(0) as usize;
    s.replay.push_back(retained);
    while s.replay_chars > s.max_replay_chars && s.replay.len() > 1 {
        if let Some(old) = s.replay.pop_front() {
            s.replay_chars -= utf16_len(&old.output.data).max(0) as usize;
        }
    }
}

/// Build `terminal.output.batch` wire payloads from a run of classified frames and
/// deliver them to one subscriber's sink (`broker.ts:1315-1343` flush → batch path).
/// A batch payload deserializes into `ServerMessage::TerminalOutputBatch`; an oversize
/// single-segment fallback deserializes into `ServerMessage::TerminalOutput`.
fn deliver_batches(
    sink: &FrameSink,
    terminal_id: &str,
    frames: &[RetainedFrame],
    attach_request_id: &str,
    source: &str,
) {
    if frames.is_empty() {
        return;
    }
    let batch_max = terminal_stream_batch_max_bytes() as i64;
    let inputs: Vec<BatchInputFrame> = frames.iter().map(|f| f.to_batch_input()).collect();
    let batches = build_terminal_output_batches(&BatchBuildInput {
        frames: &inputs,
        max_serialized_bytes: batch_max,
        max_total_serialized_bytes: None,
        terminal_id: terminal_id.to_string(),
        attach_request_id: Some(attach_request_id.to_string()),
        source: Some(source.to_string()),
    });
    for batch in &batches {
        for payload in
            build_batch_wire_payloads(terminal_id, batch, attach_request_id, source, batch_max)
        {
            // The wire payload is exact JSON (camelCase, `type`-tagged); it round-trips
            // into the frozen `ServerMessage` variant it names.
            if let Ok(msg) = serde_json::from_value::<ServerMessage>(payload) {
                sink(msg);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── DIAG-01 lifecycle tracing events ─────────────────────────────────
    //
    // A minimal capturing `tracing_subscriber::Layer` (dev-dependency only)
    // that records every event's message + string-rendered fields, installed
    // as the THREAD's default subscriber (`tracing::subscriber::set_default`,
    // scoped to the returned guard) rather than the process-global one --
    // `freshell-server`'s `logging::init` owns that (frozen, out of scope
    // here). This proves the lifecycle events fire with the documented
    // fields; the JSONL formatting itself is `freshell-server`'s concern.
    mod tracing_capture {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::span::Attributes;
        use tracing::{Event, Id, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        #[derive(Debug, Clone, Default)]
        pub struct CapturedEvent {
            pub message: String,
            pub fields: BTreeMap<String, String>,
        }

        #[derive(Default)]
        struct FieldVisitor {
            message: String,
            fields: BTreeMap<String, String>,
        }

        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let rendered = format!("{value:?}");
                if field.name() == "message" {
                    self.message = rendered;
                } else {
                    self.fields.insert(field.name().to_string(), rendered);
                }
            }

            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = value.to_string();
                } else {
                    self.fields
                        .insert(field.name().to_string(), value.to_string());
                }
            }

            fn record_i64(&mut self, field: &Field, value: i64) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }

            fn record_u64(&mut self, field: &Field, value: u64) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }

            fn record_bool(&mut self, field: &Field, value: bool) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }

        struct CaptureLayer {
            events: Arc<Mutex<Vec<CapturedEvent>>>,
        }

        impl<S> Layer<S> for CaptureLayer
        where
            S: Subscriber,
        {
            fn on_new_span(&self, _attrs: &Attributes<'_>, _id: &Id, _ctx: Context<'_, S>) {}

            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push(CapturedEvent {
                        message: visitor.message,
                        fields: visitor.fields,
                    });
            }
        }

        /// Install a thread-local capturing subscriber for the life of the
        /// returned guard. `#[test]` functions run synchronously on their own
        /// test-harness thread, so this reliably observes every `tracing`
        /// event emitted by (synchronous) registry calls made while the
        /// guard is held.
        pub fn capture() -> (
            Arc<Mutex<Vec<CapturedEvent>>>,
            tracing::subscriber::DefaultGuard,
        ) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            let guard = tracing::subscriber::set_default(subscriber);
            (events, guard)
        }
    }

    /// **RED before implementation**: `TerminalRegistry::create` must emit a
    /// `terminal.created` tracing event (fields: `terminal_id`, `mode`, `cwd`,
    /// `pid`) -- DIAG-01's terminal lifecycle slice.
    #[test]
    fn create_emits_terminal_created_event_with_expected_fields() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-diag-created".to_string(),
            "S-diag-created".to_string(),
            "shell",
            None,
            None,
            None,
        )
        .expect("spawn /bin/sh -c 'sleep 30'");

        let captured = events.lock().unwrap();
        let created = captured
            .iter()
            .find(|e| e.message == "terminal.created")
            .expect("expected a terminal.created tracing event");
        assert_eq!(
            created.fields.get("terminal_id").map(String::as_str),
            Some("T-diag-created")
        );
        assert_eq!(
            created.fields.get("mode").map(String::as_str),
            Some("shell")
        );
        assert_eq!(created.fields.get("cwd").map(String::as_str), Some("/tmp"));
        assert!(
            created.fields.contains_key("pid"),
            "terminal.created must carry the spawned PTY's pid"
        );

        drop(captured);
        reg.kill("T-diag-created");
    }

    /// **RED (2026-07-22 incident)**: the `terminal.created` tracing event used
    /// to hardcode `mode = "shell"` (and the initial record's mode/resume) no
    /// matter what was actually launched -- during the codex-resume incident it
    /// reported six resumed-with-`resume <id>`-expected codex panes as plain
    /// shells, actively misleading the forensic investigation. The event (and
    /// the record, from birth -- no stamping window) must carry the REAL mode
    /// and whether a resume id was applied.
    #[test]
    fn create_emits_terminal_created_event_with_real_mode_and_resume() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-diag-created-codex".to_string(),
            "S-diag-created-codex".to_string(),
            "codex",
            Some("sess-codex-resume-1"),
            None,
            None,
        )
        .expect("spawn /bin/sh -c 'sleep 30'");

        let captured = events.lock().unwrap();
        let created = captured
            .iter()
            .find(|e| e.message == "terminal.created")
            .expect("expected a terminal.created tracing event");
        assert_eq!(
            created.fields.get("mode").map(String::as_str),
            Some("codex"),
            "the created event must log the REAL mode, not a hardcoded 'shell'"
        );
        assert_eq!(
            created.fields.get("resume_applied").map(String::as_str),
            Some("true"),
            "the created event must say whether resume args were applied"
        );
        drop(captured);

        // The record itself carries the real mode/resume from birth -- no
        // misleading window before the WS handler's `set_meta` stamps them.
        let rows = reg.identity_probe_rows();
        let row = rows
            .iter()
            .find(|r| r.terminal_id == "T-diag-created-codex")
            .expect("registry lists the created terminal");
        assert_eq!(row.mode, "codex");
        assert_eq!(
            row.resume_session_id.as_deref(),
            Some("sess-codex-resume-1")
        );

        reg.kill("T-diag-created-codex");
    }

    /// **RED before implementation**: `TerminalRegistry::finish_pty_exit`
    /// (the NATURAL-exit path) must emit a `terminal.exited` event (fields:
    /// `terminal_id`, `exit_code`).
    #[test]
    fn finish_pty_exit_emits_terminal_exited_event_with_exit_code() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-diag-exit", "S-diag-exit");

        assert!(reg.finish_pty_exit("T-diag-exit", 3));

        let captured = events.lock().unwrap();
        let exited = captured
            .iter()
            .find(|e| e.message == "terminal.exited")
            .expect("expected a terminal.exited tracing event");
        assert_eq!(
            exited.fields.get("terminal_id").map(String::as_str),
            Some("T-diag-exit")
        );
        assert_eq!(
            exited.fields.get("exit_code").map(String::as_str),
            Some("3")
        );
    }

    /// **RED before implementation**: `TerminalRegistry::kill` must emit a
    /// `terminal.killed` event (fields: `terminal_id`, `by`), and the
    /// idle-reaper sweep must ADDITIONALLY emit a summary `terminal.idle_reap`
    /// event (field: `count`) -- but only when it actually killed something.
    #[test]
    fn enforce_idle_kills_emits_killed_by_idle_and_a_sweep_summary_event() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-diag-idle", "S-diag-idle");
        reg.set_auto_kill_idle_minutes(5);
        reg.backdate_last_activity("T-diag-idle", now_ms() - 6 * 60_000);

        let killed = reg.enforce_idle_kills();
        assert_eq!(killed, vec!["T-diag-idle".to_string()]);

        let captured = events.lock().unwrap();
        let killed_evt = captured
            .iter()
            .find(|e| {
                e.message == "terminal.killed"
                    && e.fields.get("terminal_id").map(String::as_str) == Some("T-diag-idle")
            })
            .expect("expected a terminal.killed tracing event for the idle victim");
        assert_eq!(
            killed_evt.fields.get("by").map(String::as_str),
            Some("idle")
        );

        let sweep = captured
            .iter()
            .find(|e| e.message == "terminal.idle_reap")
            .expect("expected a terminal.idle_reap sweep-summary event");
        assert_eq!(sweep.fields.get("count").map(String::as_str), Some("1"));
    }

    /// A sweep that kills nothing must NOT emit the summary event (the task
    /// spec: "idle-reap sweep (count killed, only when >0)").
    #[test]
    fn enforce_idle_kills_emits_no_sweep_event_when_nothing_was_killed() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-diag-fresh", "S-diag-fresh");
        reg.set_auto_kill_idle_minutes(5);
        // Freshly created -- not idle long enough to be a candidate.

        let killed = reg.enforce_idle_kills();
        assert!(killed.is_empty());

        let captured = events.lock().unwrap();
        assert!(
            !captured.iter().any(|e| e.message == "terminal.idle_reap"),
            "a no-op sweep must not emit terminal.idle_reap"
        );
    }
    use std::sync::Mutex as StdMutex;

    /// A `FrameSink` that records every delivered message for assertions.
    fn collector() -> (FrameSink, Arc<StdMutex<Vec<ServerMessage>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);
        let sink: FrameSink = Arc::new(move |msg| seen2.lock().unwrap().push(msg));
        (sink, seen)
    }

    fn frame(seq: i64, data: &str, stream_id: &str) -> TerminalOutput {
        TerminalOutput {
            data: data.to_string(),
            seq_start: seq,
            seq_end: seq,
            stream_id: stream_id.to_string(),
            terminal_id: "T".to_string(),
            attach_request_id: None,
            source: Some(OutputSource::Live),
        }
    }

    impl TerminalRegistry {
        /// Register a headless terminal (no PTY) so the stream logic can be driven
        /// deterministically by [`feed`](Self::feed) instead of real child output.
        fn insert_headless(&self, terminal_id: &str, stream_id: &str) {
            self.insert_headless_at(terminal_id, stream_id, now_ms());
        }

        /// Same as [`insert_headless`](Self::insert_headless), but with an
        /// explicit `created_at` instead of the wall clock. Needed by tests that
        /// must pin two terminals to the SAME timestamp (e.g. exercising
        /// `inventory()`'s tie-break) without racing real `now_ms()` resolution
        /// under load -- see `inventory_lists_running_terminals_sorted_and_reflects_revision`.
        fn insert_headless_at(&self, terminal_id: &str, stream_id: &str, created_at: i64) {
            let shared = Arc::new(Mutex::new(TerminalShared {
                terminal_id: terminal_id.to_string(),
                stream_id: stream_id.to_string(),
                replay: VecDeque::new(),
                replay_chars: 0,
                max_replay_chars: self.scrollback_max_bytes().max(0) as usize,
                scanner: BarrierScanner::new(),
                head_seq: 0,
                status: TerminalRunStatus::Running,
                exit_code: None,
                created_at,
                last_activity_at: created_at,
                cols: 120,
                rows: 30,
                geometry_epoch: 1,
                cwd: None,
                title: "Shell".to_string(),
                description: None,
                mode: "shell".to_string(),
                resume_session_id: None,
                subscribers: HashMap::new(),
            }));
            let mut inner = self.inner.lock().unwrap();
            inner.terminals.insert(
                terminal_id.to_string(),
                TerminalHandle { shared, pty: None },
            );
            inner.revision += 1;
        }

        /// Test-only: force a terminal's `lastActivityAt` to an arbitrary value so
        /// idle-kill sweep tests don't need to sleep for real minutes.
        fn backdate_last_activity(&self, terminal_id: &str, last_activity_at: i64) {
            let inner = self.inner.lock().unwrap();
            let handle = inner.terminals.get(terminal_id).unwrap();
            handle.shared.lock().unwrap().last_activity_at = last_activity_at;
        }

        /// Simulate the reader thread producing one frame (append + fan-out).
        fn feed(&self, terminal_id: &str, frame: TerminalOutput) {
            let shared = {
                let inner = self.inner.lock().unwrap();
                Arc::clone(&inner.terminals.get(terminal_id).unwrap().shared)
            };
            ingest(&shared, ServerMessage::TerminalOutput(frame));
        }
    }

    fn outputs(seen: &Arc<StdMutex<Vec<ServerMessage>>>) -> Vec<TerminalOutput> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutput(o) => Some(o.clone()),
                _ => None,
            })
            .collect()
    }

    fn attach_ready(seen: &Arc<StdMutex<Vec<ServerMessage>>>) -> Option<TerminalAttachReady> {
        seen.lock().unwrap().iter().find_map(|m| match m {
            ServerMessage::TerminalAttachReady(r) => Some(r.clone()),
            _ => None,
        })
    }

    fn batches(
        seen: &Arc<StdMutex<Vec<ServerMessage>>>,
    ) -> Vec<freshell_protocol::TerminalOutputBatch> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutputBatch(b) => Some(b.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn batch_capability_gates_output_framing_legacy_stays_default() {
        // The T1 no-regression invariant AT THE REGISTRY: a subscriber that does NOT
        // negotiate the capability receives legacy per-frame `terminal.output`; one that
        // DOES receives `terminal.output.batch` — and both reassemble to identical bytes.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Background scrollback (replayed on attach).
        reg.feed("T", frame(1, "hello ", "S"));
        reg.feed("T", frame(2, "world\r\n", "S"));

        // (a) legacy subscriber (no capability) — must get `terminal.output` only.
        let (legacy_sink, legacy_seen) = collector();
        reg.attach("T", 1, legacy_sink, Some("legacy".into()), 0, false, None);
        let legacy = outputs(&legacy_seen);
        assert!(
            !legacy.is_empty(),
            "legacy attach replays terminal.output frames"
        );
        assert!(
            batches(&legacy_seen).is_empty(),
            "legacy attach must NOT emit batch frames"
        );
        let legacy_data: String = {
            let mut v: Vec<_> = legacy
                .iter()
                .map(|f| (f.seq_start, f.data.clone()))
                .collect();
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };

        // (b) batch subscriber (capability + attachRequestId) — must get
        // `terminal.output.batch`, reassembling to the SAME bytes, with UTF-16
        // endOffsets and a self-consistent serializedBytes.
        let (batch_sink, batch_seen) = collector();
        reg.attach("T", 2, batch_sink, Some("batch".into()), 0, true, None);
        let bs = batches(&batch_seen);
        assert!(
            !bs.is_empty(),
            "batch attach emits terminal.output.batch frames"
        );
        assert!(
            outputs(&batch_seen).is_empty(),
            "batch attach must NOT emit legacy terminal.output"
        );
        let batch_data: String = {
            let mut v: Vec<_> = bs.iter().map(|b| (b.seq_start, b.data.clone())).collect();
            v.sort_by_key(|(s, _)| *s);
            v.into_iter().map(|(_, d)| d).collect()
        };
        assert_eq!(
            batch_data, legacy_data,
            "batch and legacy reassemble to identical bytes"
        );
        assert_eq!(batch_data, "hello world\r\n");
        for b in &bs {
            assert_eq!(b.attach_request_id, "batch");
            assert!(matches!(b.source, freshell_protocol::OutputSource::Replay));
            assert!(b.serialized_bytes > 0, "serializedBytes fixpoint converged");
            // Segment endOffsets are UTF-16 cumulative and slice the data exactly.
            let mut prev = 0i64;
            let mut reassembled = String::new();
            for seg in &b.segments {
                reassembled.push_str(&crate::batch::slice_utf16(&b.data, prev, seg.end_offset));
                prev = seg.end_offset;
            }
            assert_eq!(
                reassembled, b.data,
                "UTF-16 endOffsets reconstruct the batch data"
            );
        }
    }

    #[test]
    fn batch_multibyte_endoffset_is_utf16_not_bytes() {
        // A batch containing an emoji must carry a UTF-16 endOffset (2 per emoji), not
        // the 4-byte UTF-8 length — the §9.3 Top-risk-#2 proof at the registry.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "a\u{1F600}b\r\n", "S")); // a😀b␍␊

        let (sink, seen) = collector();
        reg.attach("T", 1, sink, Some("m".into()), 0, true, None);
        let bs = batches(&seen);
        assert_eq!(bs.len(), 1);
        let b = &bs[0];
        assert_eq!(b.data, "a\u{1F600}b\r\n");
        // "a😀b␍␊" = 1+2+1+1+1 = 6 UTF-16 code units, but 8 UTF-8 bytes.
        let last = b.segments.last().unwrap();
        assert_eq!(last.end_offset, 6, "UTF-16 code units");
        assert_ne!(last.end_offset, 8, "must NOT be the byte length");
    }

    #[test]
    fn attach_replays_scrollback_in_seq_order_stamped_as_replay() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Three frames produced BEFORE any client attaches (the background scrollback).
        reg.feed("T", frame(1, "one\r\n", "S"));
        reg.feed("T", frame(2, "two\r\n", "S"));
        reg.feed("T", frame(3, "three\r\n", "S"));

        let (sink, seen) = collector();
        let out = reg.attach("T", 1, sink, Some("att-1".into()), 0, false, None);
        assert!(out.found);

        // attach.ready first, then the 3 replayed frames.
        let ready = attach_ready(&seen).expect("attach.ready sent");
        assert_eq!(ready.head_seq, 3);
        assert_eq!(ready.replay_from_seq, 1);
        assert_eq!(ready.replay_to_seq, 3);
        assert_eq!(
            ready.geometry_authority,
            Some(GeometryAuthority::SingleClient)
        );

        let frames = outputs(&seen);
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["one\r\n", "two\r\n", "three\r\n"]
        );
        // Replayed frames are stamped with THIS attach's id and source:'replay'.
        for f in &frames {
            assert_eq!(f.attach_request_id.as_deref(), Some("att-1"));
            assert_eq!(f.source, Some(OutputSource::Replay));
        }
    }

    #[test]
    fn detach_keeps_terminal_running_and_buffering_then_replays_on_reattach() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        let (sink_a, seen_a) = collector();
        reg.attach("T", 1, sink_a, Some("a".into()), 0, false, None);
        reg.feed("T", frame(1, "before\r\n", "S"));
        assert_eq!(outputs(&seen_a).len(), 1);

        // Detach: subscription gone, but the terminal keeps running + buffering.
        reg.detach("T", 1);
        assert!(
            reg.is_running("T"),
            "terminal survives detach (background session)"
        );
        reg.feed("T", frame(2, "while-detached\r\n", "S"));
        // The detached connection receives nothing more.
        assert_eq!(outputs(&seen_a).len(), 1);

        // A fresh attach replays the FULL scrollback (both frames).
        let (sink_b, seen_b) = collector();
        reg.attach("T", 2, sink_b, Some("b".into()), 0, false, None);
        let replayed = outputs(&seen_b);
        assert_eq!(
            replayed.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["before\r\n", "while-detached\r\n"]
        );
    }

    #[test]
    fn two_attached_sockets_both_get_live_output_each_with_its_own_attach_id() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        let (sink_a, seen_a) = collector();
        let (sink_b, seen_b) = collector();
        reg.attach("T", 1, sink_a, Some("aaa".into()), 0, false, None);
        // Second attach: geometry authority flips to multi_client_unknown.
        reg.attach("T", 2, sink_b, Some("bbb".into()), 0, false, None);
        let ready_b = attach_ready(&seen_b).unwrap();
        assert_eq!(
            ready_b.geometry_authority,
            Some(GeometryAuthority::MultiClientUnknown)
        );

        // One live frame fans out to BOTH sockets, each stamped with its own id.
        reg.feed("T", frame(1, "shared\r\n", "S"));
        let a = outputs(&seen_a);
        let b = outputs(&seen_b);
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].data, "shared\r\n");
        assert_eq!(b[0].data, "shared\r\n");
        assert_eq!(a[0].attach_request_id.as_deref(), Some("aaa"));
        assert_eq!(b[0].attach_request_id.as_deref(), Some("bbb"));
    }

    #[test]
    fn reconnect_catches_up_by_seq_only_replaying_newer_frames() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink_a, seen_a) = collector();
        reg.attach("T", 1, sink_a, Some("a".into()), 0, false, None);
        for i in 1..=5 {
            reg.feed("T", frame(i, &format!("line-{i}\r\n"), "S"));
        }
        assert_eq!(outputs(&seen_a).len(), 5);

        // Reconnect: the client already rendered through seq 3, so it re-attaches
        // with sinceSeq=3. Only frames 4 and 5 are replayed (seqStart > 3).
        reg.detach("T", 1);
        let (sink_r, seen_r) = collector();
        reg.attach("T", 2, sink_r, Some("a2".into()), 3, false, None);
        let ready = attach_ready(&seen_r).unwrap();
        assert_eq!(ready.effective_since_seq, Some(3));
        assert_eq!(ready.replay_from_seq, 4);
        assert_eq!(ready.replay_to_seq, 5);
        let replayed = outputs(&seen_r);
        assert_eq!(
            replayed.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["line-4\r\n", "line-5\r\n"]
        );
    }

    #[test]
    fn attach_after_reconnect_streams_new_live_output_in_order_after_replay() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "old\r\n", "S"));

        let (sink, seen) = collector();
        reg.attach("T", 7, sink, Some("z".into()), 0, false, None);
        // A live frame produced AFTER attach must arrive after the replayed one.
        reg.feed("T", frame(2, "new\r\n", "S"));

        let frames = outputs(&seen);
        assert_eq!(
            frames.iter().map(|f| f.data.as_str()).collect::<Vec<_>>(),
            vec!["old\r\n", "new\r\n"]
        );
        // The live frame keeps source:'live'; the replayed one is 'replay'.
        assert_eq!(frames[0].source, Some(OutputSource::Replay));
        assert_eq!(frames[1].source, Some(OutputSource::Live));
        // Both stamped with the connection's attach id.
        assert!(frames
            .iter()
            .all(|f| f.attach_request_id.as_deref() == Some("z")));
    }

    #[test]
    fn attach_to_unknown_terminal_reports_not_found() {
        let reg = TerminalRegistry::new();
        let (sink, seen) = collector();
        let out = reg.attach("nope", 1, sink, None, 0, false, None);
        assert!(!out.found);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn kill_removes_terminal_notifies_subscribers_and_bumps_revision() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let rev_before = reg.revision();
        let (sink, seen) = collector();
        reg.attach("T", 1, sink, Some("a".into()), 0, false, None);

        assert!(reg.kill("T"));
        assert!(!reg.is_running("T"), "killed terminal is removed");
        assert!(reg.revision() > rev_before, "revision bumped");

        // The attached connection received terminal.exit.
        let got_exit = seen
            .lock()
            .unwrap()
            .iter()
            .any(|m| matches!(m, ServerMessage::TerminalExit(_)));
        assert!(got_exit);
        // Killing an unknown terminal is a no-op false.
        assert!(!reg.kill("T"));
    }

    #[test]
    fn kill_all_reaps_every_running_terminal_and_notifies_subscribers() {
        // SAFE-11/TERM-22: the shutdown path must reap EVERY tracked terminal
        // (not just the one a caller happens to name), mirroring
        // `terminal-registry.ts:4843` `shutdownGracefully()` applied to the
        // whole registry instead of one id at a time.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-a", "S1");
        reg.insert_headless("T-b", "S2");
        let (sink_a, seen_a) = collector();
        let (sink_b, seen_b) = collector();
        reg.attach("T-a", 1, sink_a, None, 0, false, None);
        reg.attach("T-b", 2, sink_b, None, 0, false, None);
        let rev_before = reg.revision();

        let killed = reg.kill_all();

        assert_eq!(killed, 2, "both tracked terminals were reaped");
        assert!(!reg.is_running("T-a"));
        assert!(!reg.is_running("T-b"));
        assert!(reg.revision() > rev_before, "revision bumped");
        for seen in [&seen_a, &seen_b] {
            let got_exit = seen
                .lock()
                .unwrap()
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalExit(_)));
            assert!(got_exit, "each attached subscriber saw terminal.exit");
        }
        // Idempotent / empty-registry-safe: a second call finds nothing left to kill.
        assert_eq!(reg.kill_all(), 0);
    }

    /// SAFE-11/TERM-22 stale-pid group-kill hardening (reviewer "Important"
    /// finding on `edf1e93d`): a terminal that exits NATURALLY is RETAINED in
    /// the registry (`finish_pty_exit` never removes the record -- see its
    /// doc comment), so a LATER, unrelated `kill_all()` sweep (e.g. server
    /// shutdown) still walks it. Its `PtyTerminal`'s cached OS pid may, by
    /// the time that sweep runs, have been recycled by the kernel to a
    /// completely unrelated process (and process group) leader.
    /// `kill_all`/`kill` must never re-attempt the group-kill signal
    /// (`libc::kill(-pid, SIGKILL)`) against a terminal the registry doesn't
    /// believe is still Running -- proven here via the pty.rs test-only
    /// signal-recording seam, not just by checking the terminal "looks" dead.
    #[test]
    fn kill_all_never_group_signals_a_terminal_that_already_exited_naturally() {
        let reg = TerminalRegistry::new();
        let reg_for_exit = reg.clone();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 0".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        let terminal_id = "T-natural-exit".to_string();
        let on_exit_id = terminal_id.clone();
        reg.create(
            &spec,
            &env,
            terminal_id.clone(),
            "S".to_string(),
            "shell",
            None,
            None,
            Some(Box::new(move |code| {
                // Mirrors the production wiring (`freshell-ws`'s on_exit hook):
                // the reader thread calls `finish_pty_exit` on natural exit.
                reg_for_exit.finish_pty_exit(&on_exit_id, code);
            })),
        )
        .expect("spawn /bin/sh -c 'exit 0'");

        // Wait for the natural exit to be observed (bounded poll; the child
        // exits near-instantly, so this deadline is generous headroom, not a
        // real-time dependency). NOTE: `is_running` only checks the record's
        // presence in the map -- a naturally-exited terminal is RETAINED
        // (still present), so it never goes false here; the actual signal is
        // the record's `status` flipping to `Exited` (`finish_pty_exit`).
        let exited = |reg: &TerminalRegistry| {
            reg.inventory()
                .iter()
                .any(|t| t.terminal_id == terminal_id && t.status == TerminalRunStatus::Exited)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !exited(&reg) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            exited(&reg),
            "the spawned child must exit naturally within the deadline"
        );

        // Discard anything recorded incidentally before the operation under test.
        let _ = crate::pty::take_group_kill_log();

        let killed = reg.kill_all();
        assert_eq!(killed, 1, "the retained-exited terminal is still reaped");

        assert!(
            crate::pty::take_group_kill_log().is_empty(),
            "kill_all must NOT attempt a group-kill signal against a terminal \
             that already exited naturally -- its cached pid may have been \
             recycled to an unrelated process group"
        );
    }

    /// Positive control for the test above: a terminal that IS still Running
    /// when `kill()` is called must still be group-signaled (the SAFE-11 fix
    /// from `edf1e93d` this hardening must not silently disable).
    #[test]
    fn kill_group_signals_a_still_running_terminal() {
        let reg = TerminalRegistry::new();
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        let terminal_id = "T-running".to_string();
        reg.create(
            &spec,
            &env,
            terminal_id.clone(),
            "S".to_string(),
            "shell",
            None,
            None,
            None,
        )
        .expect("spawn /bin/sh -c 'sleep 30'");
        assert!(reg.is_running(&terminal_id));

        let _ = crate::pty::take_group_kill_log();
        assert!(reg.kill(&terminal_id));

        assert_eq!(
            crate::pty::take_group_kill_log().len(),
            1,
            "kill() on a still-Running terminal must group-signal its PTY exactly once"
        );
    }

    #[test]
    fn inventory_lists_running_terminals_sorted_and_reflects_revision() {
        let reg = TerminalRegistry::new();
        assert!(reg.inventory().is_empty());
        // Pin both terminals to the SAME created_at instead of relying on two
        // back-to-back now_ms() calls happening to land in the same millisecond:
        // under parallel/loaded test execution the wall clock can tick between
        // the two inserts, which would make this a real (not tied) createdAt
        // ordering and flake the fixed expectation below. Forcing an exact tie
        // here is what actually exercises the tie-break this test documents.
        reg.insert_headless_at("T-b", "S1", 1_000);
        reg.insert_headless_at("T-a", "S2", 1_000);
        let inv = reg.inventory();
        assert_eq!(inv.len(), 2);
        for t in &inv {
            assert_eq!(t.status, TerminalRunStatus::Running);
            assert_eq!(t.mode, "shell");
        }
        // created_at ties broken by terminalId → deterministic order. Necessary
        // because (unlike the legacy JS Map, whose iteration preserves insertion
        // order) Rust's HashMap iteration order is arbitrary, so without a total
        // tiebreak a same-timestamp tie would sort non-deterministically per run.
        assert_eq!(inv[0].terminal_id, "T-a");
        assert_eq!(inv[1].terminal_id, "T-b");

        reg.kill("T-a");
        let inv2 = reg.inventory();
        assert_eq!(inv2.len(), 1);
        assert_eq!(inv2[0].terminal_id, "T-b");
    }

    #[test]
    fn set_meta_flows_into_inventory_and_directory_defaults_stay_shell() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");

        // Defaults preserve the pre-meta behavior (getModeLabel('shell') === 'Shell').
        let inv = reg.inventory();
        assert_eq!(inv[0].title, "Shell");
        assert_eq!(inv[0].mode, "shell");
        assert_eq!(inv[0].description, None);
        let dir = reg.directory();
        assert_eq!(dir[0].title, "Shell");
        assert_eq!(dir[0].mode, "shell");
        assert_eq!(dir[0].resume_session_id, None);
        assert!(!dir[0].has_clients);

        // set_meta (the WS create handler's mode context) overrides all fields.
        reg.set_meta(
            "T",
            Some("Claude".into()),
            Some("resumed pane".into()),
            Some("claude".into()),
            Some("sess-1".into()),
        );
        let inv = reg.inventory();
        assert_eq!(inv[0].title, "Claude");
        assert_eq!(inv[0].mode, "claude");
        assert_eq!(inv[0].description.as_deref(), Some("resumed pane"));
        let dir = reg.directory();
        assert_eq!(dir[0].mode, "claude");
        assert_eq!(dir[0].resume_session_id.as_deref(), Some("sess-1"));

        // None leaves fields unchanged (updateTitle only touches the title).
        reg.update_title("T", "Renamed");
        let dir = reg.directory();
        assert_eq!(dir[0].title, "Renamed");
        assert_eq!(dir[0].mode, "claude");
        reg.update_description("T", "new desc");
        assert_eq!(reg.directory()[0].description.as_deref(), Some("new desc"));
    }

    #[test]
    fn directory_reassembles_snapshot_and_reports_clients() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.feed("T", frame(1, "hello ", "S"));
        reg.feed("T", frame(2, "world\r\n", "S"));
        let dir = reg.directory();
        assert_eq!(dir[0].snapshot, "hello world\r\n");
        assert_eq!(dir[0].status, TerminalRunStatus::Running);
        assert!(!dir[0].has_clients);

        let (sink, _seen) = collector();
        reg.attach("T", 9, sink, Some("a".into()), 0, false, None);
        assert!(reg.directory()[0].has_clients);
        reg.detach("T", 9);
        assert!(!reg.directory()[0].has_clients);
    }

    #[test]
    fn resize_updates_geometry_epoch_only_on_change() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, seen) = collector();
        // default 120x30, epoch 1.
        reg.resize("T", 120, 30); // unchanged -> no epoch bump
        reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        assert_eq!(attach_ready(&seen).unwrap().geometry_epoch, Some(1));

        // A real change bumps the epoch (observed on the next attach.ready).
        reg.resize("T", 100, 40);
        let (sink2, seen2) = collector();
        reg.attach("T", 2, sink2, Some("b".into()), 0, false, None);
        assert_eq!(attach_ready(&seen2).unwrap().geometry_epoch, Some(2));
    }

    #[test]
    fn remove_connection_sweeps_subscriptions_from_all_terminals() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T1", "S1");
        reg.insert_headless("T2", "S2");
        let (sink1, seen1) = collector();
        let (sink2, seen2) = collector();
        reg.attach("T1", 42, sink1, Some("a".into()), 0, false, None);
        reg.attach("T2", 42, sink2, Some("a".into()), 0, false, None);

        reg.remove_connection(42);
        // Both terminals survive; the swept connection receives no further output.
        assert!(reg.is_running("T1") && reg.is_running("T2"));
        reg.feed("T1", frame(1, "x\r\n", "S1"));
        reg.feed("T2", frame(1, "y\r\n", "S2"));
        assert!(outputs(&seen1).is_empty());
        assert!(outputs(&seen2).is_empty());
    }
    /// Reproduces DEFECT 5b: a terminal that exits (e.g. an instant-exit CLI
    /// failure) BEFORE any client attaches never gets its `terminal.exit`
    /// delivered (finish_pty_exit fanned out to zero subscribers). A client
    /// that attaches afterward currently gets replayed output only -- no
    /// signal the process is dead -- which renders as a permanently blank/
    /// frozen pane. Legacy-parity fix: attach() must synthesize `terminal.exit`
    /// for a terminal that is already `Exited` by the time of attach.
    #[test]
    fn attach_to_already_exited_terminal_delivers_synthetic_exit() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Simulate the race: the PTY exits with a nonzero code before any
        // client ever attaches (finish_pty_exit fans out to zero subscribers).
        assert!(reg.finish_pty_exit("T", 7));

        let (sink, seen) = collector();
        let outcome = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        assert!(outcome.found);

        let exit = seen.lock().unwrap().iter().find_map(|m| match m {
            ServerMessage::TerminalExit(e) => Some(e.clone()),
            _ => None,
        });
        let exit = exit.expect("attach to an already-exited terminal must deliver terminal.exit");
        assert_eq!(exit.exit_code, 7);
        assert_eq!(exit.terminal_id, "T");
    }

    // `enforce_idle_kills` (TERM-11, `autoKillIdleMinutes`): legacy parity port
    // of `enforceIdleKills` (`terminal-registry.ts:1406-1425`). Each test backdates
    // `lastActivityAt` directly instead of sleeping for real minutes.

    #[test]
    fn new_registry_defaults_auto_kill_idle_minutes_to_legacy_default() {
        // `server/settings.ts:791` `autoKillIdleMinutes: 15` -- the Rust default
        // (`crates/freshell-server/src/settings.rs:70`) must match so a boot that
        // never calls `set_auto_kill_idle_minutes` (e.g. a settings load failure)
        // still behaves like the documented default, not "disabled".
        let reg = TerminalRegistry::new();
        assert_eq!(reg.auto_kill_idle_minutes(), 15);
    }

    #[test]
    fn enforce_idle_kills_kills_detached_terminal_past_threshold() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(5);
        // 6 minutes idle, 5-minute threshold -> eligible.
        reg.backdate_last_activity("T", now_ms() - 6 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T".to_string()]);
        assert!(
            reg.inventory().is_empty(),
            "kill() removes the terminal record"
        );
    }

    #[test]
    fn enforce_idle_kills_leaves_terminal_under_threshold_running() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(5);
        // Only 4 minutes idle, 5-minute threshold -> not yet eligible.
        reg.backdate_last_activity("T", now_ms() - 4 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_never_kills_an_attached_terminal() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let outcome = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        assert!(outcome.found);
        reg.set_auto_kill_idle_minutes(1);
        // Far past any threshold, but a client is attached -- legacy:
        // `if (term.clients.size > 0) continue // only detached`.
        reg.backdate_last_activity("T", now_ms() - 999 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_disabled_when_minutes_zero() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(0);
        reg.backdate_last_activity("T", now_ms() - 999 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(
            killed.is_empty(),
            "0 must disable the sweep, matching legacy's `!killMinutes` guard"
        );
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn enforce_idle_kills_disabled_when_minutes_negative() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(-1);
        reg.backdate_last_activity("T", now_ms() - 999 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    // `compute_scrollback_max_bytes` (TERM-13, `settings.terminal.scrollback`):
    // legacy parity port of `computeScrollbackMaxChars` (`terminal-registry.ts:1328-1333`).

    #[test]
    fn compute_scrollback_max_bytes_converts_lines_via_chars_per_line() {
        // Legacy's ACTUAL settings default (`server/settings.ts:794`): 10_000
        // lines * 300 chars/line = 3_000_000 -- within [MIN, MAX], no clamp.
        assert_eq!(compute_scrollback_max_bytes(10_000), 3_000_000);
    }

    #[test]
    fn compute_scrollback_max_bytes_clamps_to_minimum() {
        // 1 line * 300 = 300, far below MIN_SCROLLBACK_CHARS (64 KiB).
        assert_eq!(compute_scrollback_max_bytes(1), 64 * 1024);
    }

    #[test]
    fn compute_scrollback_max_bytes_clamps_to_maximum() {
        // 100_000 lines * 300 = 30_000_000, far above MAX_SCROLLBACK_CHARS (4 MiB).
        assert_eq!(compute_scrollback_max_bytes(100_000), 4 * 1024 * 1024);
    }

    #[test]
    fn compute_scrollback_max_bytes_clamps_negative_input_to_minimum() {
        // A malformed/negative setting must never underflow or panic.
        assert_eq!(compute_scrollback_max_bytes(-5), 64 * 1024);
    }

    #[test]
    fn new_registry_defaults_scrollback_max_bytes_to_legacy_absent_default() {
        // `DEFAULT_MAX_SCROLLBACK_CHARS` (`terminal-registry.ts:57`): the
        // fallback when NO settings have been wired into the registry yet.
        let reg = TerminalRegistry::new();
        assert_eq!(reg.scrollback_max_bytes(), 512 * 1024);
    }

    #[test]
    fn terminal_created_after_a_small_scrollback_cap_evicts_at_that_cap() {
        // Configure a tiny cap BEFORE creating the terminal (mirrors "respected
        // at create"), then feed frames well past it and confirm the earliest
        // frame(s) were evicted -- proving `max_replay_chars` (not the old fixed
        // 8 MiB constant) drives the eviction threshold. All-ASCII data here, so
        // "10 chars" and "10 bytes" are the same 10 UTF-16 code units either way
        // -- see the box-drawing tests below for the unit-sensitive case.
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(10); // 10 chars (== bytes for ASCII) -- tiny on purpose
        reg.insert_headless("T", "S");

        reg.feed("T", frame(1, "0123456789", "S")); // 10 bytes, exactly at cap
        reg.feed("T", frame(2, "abcdefghij", "S")); // another 10 bytes -> over cap

        let (sink, seen) = collector();
        reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        let replayed = outputs(&seen);
        // Whole-frame FIFO eviction keeps at least one frame; the FIRST frame
        // must have been evicted once the second pushed bytes over the cap.
        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0].data, "abcdefghij");
    }

    #[test]
    fn terminal_created_after_a_large_scrollback_cap_retains_every_frame() {
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(4 * 1024 * 1024); // legacy MAX -- generous
        reg.insert_headless("T", "S");

        reg.feed("T", frame(1, "0123456789", "S"));
        reg.feed("T", frame(2, "abcdefghij", "S"));

        let (sink, seen) = collector();
        reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        let replayed = outputs(&seen);
        assert_eq!(
            replayed.len(),
            2,
            "a generous cap must not evict either frame"
        );
    }

    // Scrollback cap UNIT parity (reviewer finding on f7b2c9e6): the cap
    // (`compute_scrollback_max_bytes`, legacy `computeScrollbackMaxChars`) is a
    // UTF-16 CODE-UNIT ("char") budget -- legacy's `ChunkRingBuffer` measures
    // `this.size += chunk.length` (JS `String.length` == UTF-16 code units), NOT
    // `Buffer.byteLength`. The retained-scrollback accounting below must count the
    // SAME unit, or non-ASCII-heavy sessions (box-drawing TUIs, unicode prompts)
    // evict far sooner than an ASCII session configured with the identical
    // `terminal.scrollback` setting.

    #[test]
    fn ascii_and_box_drawing_fills_retain_same_char_count_under_same_cap() {
        // Box-drawing chars (U+2500 range) are 1 UTF-16 code unit each but 3 UTF-8
        // bytes. A byte-denominated cap would retain roughly 1/3 as many
        // box-drawing characters as ASCII for the identical configured cap; a
        // correct char-denominated cap retains the SAME count either way.
        let cap = 12; // 12 "chars" (UTF-16 code units) -- exactly two 6-char frames.

        let reg_ascii = TerminalRegistry::new();
        reg_ascii.set_scrollback_max_bytes(cap);
        reg_ascii.insert_headless("A", "S");
        reg_ascii.feed("A", frame(1, "abcdef", "S")); // 6 chars, 6 bytes
        reg_ascii.feed("A", frame(2, "ghijkl", "S")); // 6 chars, 6 bytes -> 12 total, at cap
        let (sink_a, seen_a) = collector();
        reg_ascii.attach("A", 1, sink_a, Some("r".into()), 0, false, None);
        let ascii_chars: usize = outputs(&seen_a)
            .iter()
            .map(|f| f.data.chars().count())
            .sum();

        let reg_box = TerminalRegistry::new();
        reg_box.set_scrollback_max_bytes(cap);
        reg_box.insert_headless("B", "S");
        // Each frame: 6 box-drawing chars = 6 UTF-16 units but 18 UTF-8 bytes.
        reg_box.feed(
            "B",
            frame(1, "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}", "S"),
        );
        reg_box.feed(
            "B",
            frame(2, "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}", "S"),
        );
        let (sink_b, seen_b) = collector();
        reg_box.attach("B", 1, sink_b, Some("r".into()), 0, false, None);
        let box_chars: usize = outputs(&seen_b)
            .iter()
            .map(|f| f.data.chars().count())
            .sum();

        assert_eq!(
            ascii_chars, 12,
            "ascii fill retains the full 12-char budget"
        );
        assert_eq!(
            box_chars, ascii_chars,
            "box-drawing fill must retain the SAME char count as ascii under an \
             identical char-denominated cap -- a byte-denominated cap would evict \
             one whole box-drawing frame that an equivalent ascii cap keeps"
        );
    }

    // ── TERM-15/TERM-16 activity observer ───────────────────────────────────
    //
    // The registry-level tap the activity hub (freshell-ws) subscribes to:
    // Created (all modes), Input/Output (CLI modes only — shell terminals
    // never pay the tap cost), Exit (all removal paths). The observer runs on
    // the caller's thread (Input/Created) or the PTY reader thread (Output/
    // natural Exit), so it must be cheap and non-blocking — the hub forwards
    // into an unbounded channel.

    fn wait_for<F: Fn() -> bool>(deadline_ms: u64, f: F) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(deadline_ms) {
            if f() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        f()
    }

    #[test]
    fn activity_observer_sees_created_output_input_and_exit_for_cli_modes() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));

        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "printf ready-marker; sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-act".to_string(),
            "S-act".to_string(),
            "claude",
            Some("sess-act-1"),
            None,
            None,
        )
        .expect("spawn");

        // Created fires synchronously with the REAL mode + resume identity.
        {
            let events = seen.lock().unwrap();
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    ActivityEvent::Created { terminal_id, mode, resume_session_id, .. }
                        if terminal_id == "T-act"
                            && mode == "claude"
                            && resume_session_id.as_deref() == Some("sess-act-1")
                )),
                "expected a Created event, got {events:?}"
            );
        }

        // Output arrives from the PTY reader thread.
        assert!(
            wait_for(5_000, || {
                seen.lock().unwrap().iter().any(|e| {
                    matches!(
                        e,
                        ActivityEvent::Output { terminal_id, data, .. }
                            if terminal_id == "T-act" && data.contains("ready-marker")
                    )
                })
            }),
            "expected an Output event carrying the PTY output"
        );

        // Input fires synchronously on write.
        reg.input("T-act", b"\r");
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Input { terminal_id, data, .. }
                    if terminal_id == "T-act" && data == "\r"
            )),
            "expected an Input event for the Enter write"
        );

        // Kill fires Exit.
        reg.kill("T-act");
        assert!(
            wait_for(5_000, || {
                seen.lock().unwrap().iter().any(|e| {
                    matches!(
                        e,
                        ActivityEvent::Exit { terminal_id, .. } if terminal_id == "T-act"
                    )
                })
            }),
            "expected an Exit event after kill"
        );
    }

    #[test]
    fn activity_observer_skips_input_and_output_for_shell_terminals() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));

        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "printf shell-out; sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let env = std::collections::BTreeMap::new();
        reg.create(
            &spec,
            &env,
            "T-shell".to_string(),
            "S-shell".to_string(),
            "shell",
            None,
            None,
            None,
        )
        .expect("spawn");

        // Give the PTY time to produce output; the tap must stay silent for
        // Input/Output on a plain shell (zero per-chunk overhead).
        reg.input("T-shell", b"\r");
        assert!(
            wait_for(2_000, || {
                // Wait until the PTY produced SOMETHING (visible via replay),
                // then check the tap saw none of it.
                reg.is_running("T-shell")
            }),
            "shell must be running"
        );
        std::thread::sleep(std::time::Duration::from_millis(300));
        let events = seen.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ActivityEvent::Created { mode, .. } if mode == "shell")),
            "Created fires for every mode"
        );
        assert!(
            !events.iter().any(|e| matches!(
                e,
                ActivityEvent::Input { .. } | ActivityEvent::Output { .. }
            )),
            "no Input/Output tap for shell terminals, got {events:?}"
        );
        drop(events);
        reg.kill("T-shell");
    }

    #[test]
    fn activity_observer_sees_exit_on_natural_pty_exit() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));
        reg.insert_headless("T-nat", "S-nat");
        assert!(reg.finish_pty_exit("T-nat", 0));
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Exit { terminal_id, .. } if terminal_id == "T-nat"
            )),
            "natural exit must fire the Exit tap"
        );
    }

    #[test]
    fn eviction_on_box_drawing_content_never_panics_and_stays_within_char_cap() {
        // Many small multi-byte frames driving continuous eviction: proves the
        // char-count bookkeeping never underflows/panics and the retained total
        // never exceeds the configured char cap, even though every char here is a
        // 3-byte (UTF-8) / 1-unit (UTF-16) box-drawing glyph.
        let cap = 20;
        let reg = TerminalRegistry::new();
        reg.set_scrollback_max_bytes(cap);
        reg.insert_headless("T", "S");

        for i in 0..50 {
            reg.feed("T", frame(i, "\u{2500}\u{2502}\u{2503}", "S")); // 3 chars/frame
        }

        let (sink, seen) = collector();
        reg.attach("T", 1, sink, Some("r".into()), 0, false, None);
        let retained_chars: usize = outputs(&seen).iter().map(|f| f.data.chars().count()).sum();
        assert!(
            retained_chars as i64 <= cap,
            "retained {retained_chars} chars must not exceed the {cap}-char cap"
        );
    }
}

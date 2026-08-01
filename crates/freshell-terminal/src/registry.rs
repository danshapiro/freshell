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
    TerminalAttachIntent, TerminalAttachReady, TerminalExit, TerminalOutput, TerminalRunStatus,
};

use crate::barrier_scanner::{BarrierReason, BarrierScanner, ScannerState};
use crate::batch::{
    build_batch_wire_payloads, build_terminal_output_batches, utf16_len, BatchBuildInput,
    BatchInputFrame,
};
use crate::fragment::terminal_stream_batch_max_bytes;
use crate::idle_noise::NoiseScanner;
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
    /// Per-terminal repaint-noise fingerprinter feeding
    /// `last_meaningful_activity_at` (DEV-0009). Independent of the barrier
    /// scanner: separate state, separate concern (reaping, not batching).
    noise: NoiseScanner,
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
    /// The idle-kill reap clock (DEV-0009): last MEANINGFUL activity — user
    /// input, or PTY output carrying genuinely new content per
    /// [`NoiseScanner`]. Unlike `last_activity_at` (wire-visible via
    /// `inventory()`/`DirectoryEntry` and spec-pinned to bump on EVERY
    /// output frame, terminal-core.md §1.3), repaint noise (spinner frames,
    /// ticking counters, status-bar redraws) does not refresh this.
    /// Read ONLY by `enforce_idle_kills`.
    last_meaningful_activity_at: i64,
    /// Current PTY geometry + epoch (`§5.3`): epoch starts 1, +1 only on a real change after the first client geometry record.
    cols: u16,
    rows: u16,
    geometry_epoch: i64,
    /// TERM-07 parity with Node's `hasPreviousGeometry` (`broker.ts:666-686`):
    /// false until the first client-supplied geometry is recorded. The first
    /// record applies dims WITHOUT bumping `geometry_epoch` (spawn defaults
    /// never count as a prior record); later real changes bump.
    has_client_geometry: bool,
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
    /// The pane's stable creation key (`terminal.create.requestId`), stamped
    /// ATOMICALLY with the registry insert — it is a field of the inserted row,
    /// so no observer can ever see a row without its key (reconciliation
    /// handshake design §5.1). `None` for creates that carried no key (e.g.
    /// REST ingress, which mints none — design §5.5 precondition 2).
    create_request_id: Option<String>,
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
    /// The terminal's working directory — carried so the §5.4 adopt branch can
    /// echo the EXISTING terminal's cwd on its `terminal.created` frame.
    pub cwd: Option<String>,
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

/// Registration options for a terminal record with NO backing PTY.
///
/// This is the registry's headless seam (reconciliation-handshake design §9.1:
/// "the registry supports headless terminals for exactly this"): crate tests —
/// including `freshell-ws`'s wire-level reconcile tests, which sit across the
/// crate boundary and cannot reach the private [`TerminalShared`] — seed
/// live/exited terminal generations deterministically without spawning real
/// children. Never called on a production path (production terminals are only
/// ever registered by [`TerminalRegistry::create`], which spawns the PTY).
#[derive(Debug, Clone, Default)]
pub struct HeadlessTerminal {
    pub terminal_id: String,
    pub stream_id: String,
    /// `TerminalMode` string; empty is normalized to `"shell"`.
    pub mode: String,
    pub resume_session_id: Option<String>,
    /// The pane's stable creation key (see [`TerminalRegistry::create`]).
    pub create_request_id: Option<String>,
    /// Explicit creation timestamp (epoch ms); `None` = now.
    pub created_at: Option<i64>,
}

struct RegistryInner {
    terminals: HashMap<String, TerminalHandle>,
    /// Run-monotonic inventory revision (`terminals.changed.revision`, `§7.5`). Only
    /// its monotonic increase is asserted by the oracle, not the value.
    revision: i64,
    /// Respawn-generation counters per `createRequestId` (reconciliation design
    /// §7.5): consecutive generations that exited WITHIN the liveness window.
    /// Reset to 0 whenever a generation survives the window. Read by
    /// [`TerminalRegistry::respawn_exhausted`], which turns an infinite
    /// respawn ↔ instant-exit loop into a terminal `dead_session` verdict.
    respawn_generations: HashMap<String, u32>,
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
        /// true = the process died on its own (finish_pty_exit); false = a
        /// freshell-initiated kill (api / idle reaper / shutdown). Human-requested
        /// closes must never ring the attention bell.
        spontaneous: bool,
    },
}

/// The activity tap callback (see [`ActivityEvent`]).
pub type ActivityObserver = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

/// Reconciliation §7.5 defaults: a resumed CLI that exits within 30s of
/// spawn, 3 generations in a row, is a respawn ↔ instant-exit loop.
const DEFAULT_RESPAWN_LIVENESS_WINDOW_MS: i64 = 30_000;
const DEFAULT_RESPAWN_GENERATION_CAP: i64 = 3;

/// Explicit wall-clock backstop for a hung holder. NOT derived from any
/// "spawn budget" — the 10s constant at create_limit.rs:49 (spawn_timeout_ms,
/// env FRESHELL_SPAWN_GATE_TIMEOUT_MS) bounds the spawn-GATE PERMIT wait,
/// not spawn duration; spawns run unbounded in spawn_blocking. Task 6 makes
/// this env-tunable and adds spawn-duration instrumentation to tune it on
/// evidence.
pub const SESSION_REF_LEASE_TTL_MS: u64 = 20_000;
pub const SESSION_RESERVED_RETRY_AFTER_MS: u64 = 1_000;

/// The effective lease TTL: `FRESHELL_SESSION_REF_LEASE_TTL_MS` when set to a
/// positive integer, else [`SESSION_REF_LEASE_TTL_MS`]. Same sanitizing-parse
/// shape as the spawn-gate timeout's `FRESHELL_SPAWN_GATE_TIMEOUT_MS`
/// (`freshell-ws/src/create_limit.rs`) — unset/unparseable/zero → default.
/// Kept next to the const so the client's re-drive window derivation
/// (Task 12: window > TTL + margin) stays visible in one place.
pub fn session_ref_lease_ttl_ms() -> u64 {
    std::env::var("FRESHELL_SESSION_REF_LEASE_TTL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(SESSION_REF_LEASE_TTL_MS)
}

/// Whether `pid` is still alive (`kill(pid, 0)`): the ESRCH death-confirm
/// probe of the kill-before-release discipline (council rule 8). Only ESRCH
/// confirms death — EPERM (or any other errno) reports ALIVE, so an
/// uncertain probe can never release a lease it shouldn't. Non-unix: PTY
/// pids are never recorded there ([`crate::pty::PtyTerminal::pid`] is
/// `None`), so no pid-carrying lease can exist and this is unreachable.
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 performs existence/permission checking only; no
        // signal is delivered.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Outcome of [`TerminalRegistry::claim_session_ref`] (council rule 7, D8:
/// one in-flight create per sessionRef, liveness-bound).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRefClaim {
    Acquired,
    Held {
        retry_after_ms: u64,
    },
    /// TTL expired on a holder with a recorded child: caller must kill the
    /// holder's spawn via the REGISTRY handle (group-kill discipline,
    /// pty.rs:352-386 — never a raw single-pid SIGKILL), CONFIRM death, then
    /// call force_release_after_confirmed_kill and re-claim. The pid is for
    /// ESRCH-confirmation, not for raw kill().
    ExpiredNeedsKill {
        pid: u32,
    },
    BoundElsewhere {
        terminal_id: String,
    },
}

/// One in-flight sessionRef create reservation (value side of
/// `TerminalRegistry::session_ref_leases`, keyed `"provider\u{0}sessionId"`).
/// Released on spawn complete (bind), spawn fail (error), or holder
/// connection death; [`SESSION_REF_LEASE_TTL_MS`] is the wall-clock backstop
/// for a hung holder — expiry is KILL-BEFORE-RELEASE (a pid-carrying lease
/// stays held until the caller confirms the kill; a pid-less one is revoked
/// and held closed, never released except via holder conn death or spawn
/// failure, both of which prove no orphan child exists).
#[derive(Debug, Clone)]
struct SessionRefLease {
    /// Stored alongside the string key so conn-death cleanup can hand
    /// callers real [`SessionLocator`]s without parsing NUL-joined keys.
    locator: SessionLocator,
    holder_create_request_id: String,
    holder_conn: u64,
    acquired_at_ms: u64,
    /// The spawned child's pid once the holder records it
    /// ([`TerminalRegistry::set_session_ref_lease_pid`]) — presence decides
    /// TTL expiry's shape (`ExpiredNeedsKill` vs revoke-and-hold-closed).
    pid: Option<u32>,
    /// Set when TTL expired on a pid-less holder: there is nothing to kill,
    /// so the lease is held closed and the holder's late
    /// [`TerminalRegistry::complete_session_ref_claim`] is rejected.
    revoked: bool,
}

/// A sessionRef lease's map key: `"provider\u{0}sessionId"` (NUL joint —
/// neither side can contain it, so the key is collision-free).
fn session_ref_key(locator: &SessionLocator) -> String {
    format!("{}\u{0}{}", locator.provider, locator.session_id)
}

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
    /// Reconciliation §7.5: a generation that exits within this window of its
    /// creation counts toward the respawn cap; one that survives it resets the
    /// counter. Atomic (mirrors `auto_kill_idle_minutes`) so tests can shrink
    /// it without sleeping.
    respawn_liveness_window_ms: Arc<AtomicI64>,
    /// Reconciliation §7.5: consecutive short-lived generations after which
    /// [`Self::respawn_exhausted`] fires.
    respawn_generation_cap: Arc<AtomicI64>,
    /// §5.4 single-flight: `createRequestId`s with a keyed create currently
    /// in flight (claimed before the spawn, released after the insert). The
    /// spawn takes milliseconds and the row only becomes observable at
    /// insert, so without this reservation two truly concurrent creates for
    /// one key could BOTH pass the `newest_live_by_create_request_id` check
    /// and both spawn — the exact duplicate-writer shape the dedupe closes.
    keyed_create_inflight: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Same-id double-resume guard (amplifier identity plan, F5/V7): resume
    /// ids with an amplifier create currently in flight, keyed
    /// `"resume:{mode}:{sid}"`. A SIBLING of `keyed_create_inflight`
    /// (identical claim-before-spawn / release-after-insert semantics — the
    /// §5.4 TOCTOU doc applies verbatim), deliberately NOT the same set: WS
    /// `handle_create` claims client-supplied `createRequestId`s in
    /// `keyed_create_inflight` itself, so a client could send a requestId
    /// shaped `resume:amplifier:<sid>` and collide with the guard's keys.
    resume_create_inflight: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Council rule 7 (D8): one in-flight create per sessionRef. Keyed
    /// `"provider\u{0}sessionId"` ([`session_ref_key`]); see
    /// [`SessionRefLease`] for the release/TTL/kill-before-release rules.
    /// Mirrors the `keyed_create_inflight` shape (claim before spawn,
    /// release after bind/fail/conn-death).
    session_ref_leases: Arc<Mutex<HashMap<String, SessionRefLease>>>,
    /// locator key ([`session_ref_key`]) → the terminalId a completed claim
    /// bound the sessionRef to. Consulted by
    /// [`Self::claim_session_ref`] alongside
    /// [`Self::live_terminal_for_session_ref`]; a binding whose terminal is
    /// KNOWN dead (registered but not Running) is pruned instead of
    /// answering `BoundElsewhere`, so a dead winner never strands losers.
    session_ref_bindings: Arc<Mutex<HashMap<String, String>>>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome of an [`TerminalRegistry::attach`]: whether the terminal existed (the
/// `attach.ready` + replay were enqueued to the caller's sink) — `false` draws the
/// reference's `INVALID_TERMINAL_ID` reply (attach to an unknown terminal; an
/// exited-but-still-registered terminal is `found: true` + a synthetic exit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub struct AttachOutcome {
    pub found: bool,
}

/// Outcome of [`TerminalRegistry::input`]: whether the terminal existed (the
/// bytes were written to its PTY when one is attached; headless terminals
/// still count as found and take the activity bump). `false` mirrors the
/// reference's unknown-id input reply (`server/ws-handler.ts:2991-3002`) —
/// the WS layer answers `terminal.input.blocked{reason:unknown_terminal}`,
/// the REST send-keys path logs a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub struct InputOutcome {
    pub found: bool,
}

/// Outcome of the attach-time geometry application (TERM-07;
/// `broker.ts:358-397` `shouldResize` + `resizeIfSessionMatches` parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachResizeStatus {
    /// Geometry changed: cols/rows updated, epoch bumped, PTY resized.
    Resized,
    /// Geometry already matched: no epoch bump, no PTY syscall (Node `unchanged`).
    Unchanged,
    /// The intent/subscriber condition said not to resize (Node `shouldResize` false).
    Skipped,
    /// Terminal is not running (Node `not_running`): no mutation.
    NotRunning,
    /// Unknown terminal id (Node `missing`).
    Missing,
}

/// Read-only lookup into a session-identity store (in production: the WS-side
/// `TerminalIdentityRegistry` in `freshell-ws`). Injected across the crate
/// boundary so the D7 live-session guard can join BOTH stores from crates that
/// cannot depend on `freshell-ws` (`freshell-freshagent` -- would be circular).
/// Implementations must NOT return retired/dead bindings.
pub trait SessionIdentityLookup: Send + Sync + std::fmt::Debug {
    /// The terminal_id currently bound to `(provider, session_id)`, if any.
    fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String>;
}

/// Write-side pane-identity seam — [`SessionIdentityLookup`]'s twin for the
/// REST spawn pipeline (kata hbsa). Consumed by `freshell-freshagent`'s REST
/// create/split/respawn call sites (which cannot depend on `freshell-ws` —
/// circular); produced by `freshell-ws`'s `LedgerPaneIdentityBinder`
/// (identity registry + pane ledger), wired in `freshell-server::main`.
///
/// Fully synchronous ON PURPOSE: every underlying operation is sync (the
/// identity registry is a plain `RwLock`, every ledger writer a plain
/// `fn -> io::Result<()>`), and the one caller that CANNOT be async is the
/// pane exit hook — [`crate::pty::ExitHook`] is a `FnOnce` invoked on the
/// plain OS reader thread where no tokio runtime exists. Async REST call
/// sites hop ledger-touching calls through `tokio::task::spawn_blocking`.
pub trait PaneIdentityBinder: Send + Sync + std::fmt::Debug {
    /// PIN 2 durability-before-argv: durable claude binding row written
    /// BEFORE the spawn makes the preallocated id observable. Callers gate
    /// this on their fresh-prealloc flag ONLY (eaa25b7d).
    fn record_prespawn_claude_binding(
        &self,
        session_id: &str,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    );
    /// Compensating delete when the spawn that minted the id fails.
    /// MUST be gated on the SAME predicate as the record (eaa25b7d).
    fn delete_prespawn_claude_binding(&self, session_id: &str);
    /// Post-spawn identity registration, mirroring the WS post-spawn block
    /// (freshell-ws/src/terminal.rs): identity row + durable binding for any
    /// non-shell create with a session id; pending marker for the
    /// locator-resolved providers (codex/opencode/amplifier) without one.
    fn register_create_identity(
        &self,
        terminal_id: &str,
        mode: &str,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    );
    /// Exit-side hygiene (load-bearing ledger A2): mirrors the WS pane
    /// EXIT hook (terminal.rs:1334-1342) EXACTLY — retire the identity row
    /// (in-memory flag flip) and delete any pending marker. Deliberately
    /// does NOT touch the ledger binding: `retire_closed` is the
    /// explicit-user-close trigger only ("P1.8 trigger (e)", the WS kill
    /// command path, terminal.rs:3849-3868), never the natural-exit path,
    /// and the Bound-after-natural-exit ledger row is load-bearing —
    /// `auto_resume::pre_respawn_guard` reads a still-Bound row as "pane
    /// still wants this session" (auto_resume.rs:445-450) and the recovery
    /// inventory keys on `RetiredReason::Closed` meaning deliberate close
    /// (recovery_inventory.rs:299-301). Both A2 hazards are closed by the
    /// identity-row retire alone: the session directory joins identity
    /// rows for liveness (session_directory.rs:716-766, and the rename
    /// cascade with it, sessions.rs:167-187), and the claude drain's no-op
    /// arm checks `current.retired` (claude_signal.rs:253-342), so a late
    /// new-id SessionStart cannot durably rebind a dead pane. Idempotent;
    /// harmless no-op for terminals with no identity row. Called from the
    /// pane exit hook for ALL non-shell creates. SYNC ON PURPOSE: the exit
    /// hook is a plain FnOnce on the PTY reader thread — blocking IO is
    /// safe there, .await is impossible (mirrors the WS exit hook,
    /// terminal.rs:1334-1342).
    fn retire_pane_identity(&self, terminal_id: &str);
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                terminals: HashMap::new(),
                revision: 0,
                respawn_generations: HashMap::new(),
            })),
            conn_seq: Arc::new(AtomicU64::new(1)),
            active_connections: Arc::new(AtomicI64::new(0)),
            auto_kill_idle_minutes: Arc::new(AtomicI64::new(DEFAULT_AUTO_KILL_IDLE_MINUTES)),
            scrollback_max_bytes: Arc::new(AtomicI64::new(DEFAULT_MAX_SCROLLBACK_CHARS)),
            activity_observer: Arc::new(std::sync::RwLock::new(None)),
            respawn_liveness_window_ms: Arc::new(AtomicI64::new(
                DEFAULT_RESPAWN_LIVENESS_WINDOW_MS,
            )),
            respawn_generation_cap: Arc::new(AtomicI64::new(DEFAULT_RESPAWN_GENERATION_CAP)),
            keyed_create_inflight: Arc::new(Mutex::new(std::collections::HashSet::new())),
            resume_create_inflight: Arc::new(Mutex::new(std::collections::HashSet::new())),
            session_ref_leases: Arc::new(Mutex::new(HashMap::new())),
            session_ref_bindings: Arc::new(Mutex::new(HashMap::new())),
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

    /// Reconciliation §7.5: shrink/grow the liveness window a generation must
    /// survive to reset the respawn counter (tests use small values).
    pub fn set_respawn_liveness_window_ms(&self, ms: i64) {
        self.respawn_liveness_window_ms.store(ms, Ordering::Relaxed);
    }

    /// Reconciliation §7.5: how many consecutive short-lived generations
    /// exhaust a key.
    pub fn set_respawn_generation_cap(&self, cap: i64) {
        self.respawn_generation_cap.store(cap, Ordering::Relaxed);
    }

    /// Reconciliation §7.5: whether this `createRequestId` has hit the
    /// respawn-generation cap — the verdict derivation returns
    /// `dead_session(reason='respawn_exhausted')` instead of another
    /// `respawn`, restoring §7's "at most one respawn" bound as a guarantee.
    pub fn respawn_exhausted(&self, create_request_id: &str) -> bool {
        let cap = self.respawn_generation_cap.load(Ordering::Relaxed).max(1) as u32;
        let inner = self.inner.lock().expect("registry lock");
        inner
            .respawn_generations
            .get(create_request_id)
            .is_some_and(|count| *count >= cap)
    }

    /// `enforceIdleKills()` (`terminal-registry.ts:1406-1425`): auto-kill every
    /// DETACHED **running** terminal idle beyond the configured threshold.
    /// `auto_kill_idle_minutes() <= 0` is legacy's disabled state -- a no-op.
    /// Idleness is measured against `last_meaningful_activity_at` (DEV-0009):
    /// self-generated repaint noise does not keep a detached terminal alive.
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
                    // DEV-0009: idleness is measured against the MEANINGFUL
                    // activity clock, not the every-frame last_activity_at —
                    // otherwise a detached animated TUI (spinner / ticking
                    // counter) is exempt from this sweep forever.
                    if now.saturating_sub(s.last_meaningful_activity_at) < idle_threshold_ms {
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
        create_request_id: Option<&str>,
        ring_max_bytes: Option<i64>,
        on_exit: Option<crate::pty::ExitHook>,
    ) -> io::Result<()> {
        // Duplicate-live-resume enforcement (amplifier identity plan,
        // validated fix F5/V7): the callers' `has_live_resume` pre-check is
        // check-then-act and can race across WS/REST tasks — this registry's
        // own §5.4 doc (keyed_create_inflight) names the exact TOCTOU. Claim
        // a resume-scoped reservation BEFORE the spawn and re-check live
        // rows under it; the row itself is inserted before the reservation
        // is released, so no observable gap remains. Scoped to amplifier:
        // other modes keep their existing create semantics.
        let resume_guard_key = if mode == "amplifier" {
            resume_session_id.map(|sid| format!("resume:{mode}:{sid}"))
        } else {
            None
        };
        if let Some(key) = &resume_guard_key {
            let claimed = self.begin_resume_create(key);
            let duplicate_live = self.identity_probe_rows().iter().any(|row| {
                row.mode == mode
                    && row.status == TerminalRunStatus::Running
                    && row.resume_session_id.as_deref() == resume_session_id
            });
            if !claimed || duplicate_live {
                if claimed {
                    self.end_resume_create(key);
                }
                // Distinguishable error contract consumed by the WS/REST
                // handlers: ErrorKind::AlreadyExists ⇒ "session already
                // open" reject.
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "duplicate live resume: {mode} session {} is already open in a live terminal",
                        resume_session_id.unwrap_or_default()
                    ),
                ));
            }
        }

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
            noise: NoiseScanner::new(),
            head_seq: 0,
            status: TerminalRunStatus::Running,
            exit_code: None,
            created_at: now,
            last_activity_at: now,
            last_meaningful_activity_at: now,
            cols: spec.cols,
            rows: spec.rows,
            geometry_epoch: 1,
            has_client_geometry: false,
            cwd: spec.cwd.clone(),
            title: "Shell".to_string(),
            description: None,
            mode: mode.to_string(),
            resume_session_id: resume_session_id.map(str::to_string),
            create_request_id: create_request_id.map(str::to_string),
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

        let pty = match PtyTerminal::spawn_with_sink(
            spec,
            env,
            terminal_id.clone(),
            stream_id,
            ring_max_bytes,
            Some(sink),
            on_exit,
        ) {
            Ok(pty) => pty,
            Err(err) => {
                // Spawn failed: release the resume reservation so a retry
                // isn't wedged behind a leaked claim (release-on-failure).
                if let Some(key) = &resume_guard_key {
                    self.end_resume_create(key);
                }
                return Err(err);
            }
        };

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

        // The row is now observable (inserted above) — release the resume
        // reservation. Insert-before-release means a concurrent create can
        // never observe "no reservation AND no row" (release-on-success).
        if let Some(key) = &resume_guard_key {
            self.end_resume_create(key);
        }

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
        // §5.4 backstop: two live PTYs on one createRequestId is the
        // duplicate-writer data-loss shape — make it loud.
        if let Some(key) = create_request_id {
            self.warn_on_duplicate_live_ptys(key);
        }
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
            let mut s = shared.lock().expect("terminal lock");
            if s.subscribers.remove(&conn_id).is_some()
                && s.subscribers.is_empty()
                && s.status == TerminalRunStatus::Running
            {
                // DEV-0009: a freshly-detached terminal gets a full idle
                // threshold of grace — its meaningful clock may have expired
                // while a watcher was attached (attached => reaper-exempt).
                s.last_meaningful_activity_at = s.last_meaningful_activity_at.max(now_ms());
            }
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
            let mut s = shared.lock().expect("terminal lock");
            if s.subscribers.remove(&conn_id).is_some()
                && s.subscribers.is_empty()
                && s.status == TerminalRunStatus::Running
            {
                // DEV-0009: a freshly-detached terminal gets a full idle
                // threshold of grace — its meaningful clock may have expired
                // while a watcher was attached (attached => reaper-exempt).
                // The `.is_some()` gate is essential here: this sweep visits
                // EVERY terminal, and an unconditional bump would reset the
                // countdown of unrelated, already-detached terminals on
                // every socket close.
                s.last_meaningful_activity_at = s.last_meaningful_activity_at.max(now_ms());
            }
        }
    }

    /// `terminal.input` write path (`terminal-registry.ts:3867-3894`): write bytes to
    /// the PTY; bump `lastActivityAt` and the DEV-0009 meaningful-activity reap clock.
    /// Unknown terminal => `InputOutcome { found: false }` (kata dtfn: previously a
    /// silent no-op; the caller now replies on the wire).
    pub fn input(&self, terminal_id: &str, data: &[u8]) -> InputOutcome {
        let (found, tapped_mode) = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get_mut(terminal_id) {
                Some(handle) => {
                    if let Some(pty) = handle.pty.as_mut() {
                        let _ = pty.write_input(data);
                    } else {
                        // Headless rows have no PTY to receive bytes. Unreachable in
                        // production today (`register_headless` has no production
                        // callers — ledger A16), but never let input vanish without
                        // a trace (kata dtfn).
                        tracing::warn!(terminal_id, "input_to_headless_terminal_dropped");
                    }
                    let mut s = handle.shared.lock().expect("terminal lock");
                    let now = now_ms();
                    s.last_activity_at = now;
                    // User keystrokes are always meaningful (DEV-0009).
                    s.last_meaningful_activity_at = now;
                    (true, s.mode != "shell")
                }
                None => (false, false),
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
        InputOutcome { found }
    }

    /// Node-parity geometry floor (`broker.ts:672-673`):
    /// `Math.max(2, Math.floor(Number.isFinite(cols) ? cols : 80))`. For
    /// `u16` input — always finite, always integral — the formula reduces
    /// exactly to `.max(2)`; the `floor` and non-finite-fallback arms are
    /// unrepresentable in the Rust type.
    pub(crate) const MIN_GEOMETRY_DIM: u16 = 2;

    /// `terminal.resize` (`terminal-registry.ts:3975-3995`): `unchanged` when cols/rows
    /// already match; else set them, `+1` the geometry epoch (`§5.3`) unless this is the
    /// first client geometry record (see `has_client_geometry`), and resize the PTY
    /// (errors swallowed, as node-pty's are).
    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        let cols = cols.max(Self::MIN_GEOMETRY_DIM);
        let rows = rows.max(Self::MIN_GEOMETRY_DIM);
        let mut inner = self.inner.lock().expect("registry lock");
        if let Some(handle) = inner.terminals.get_mut(terminal_id) {
            {
                let mut s = handle.shared.lock().expect("terminal lock");
                let first_record = !s.has_client_geometry;
                s.has_client_geometry = true;
                if s.cols == cols && s.rows == rows {
                    return;
                }
                s.cols = cols;
                s.rows = rows;
                if !first_record {
                    s.geometry_epoch += 1;
                }
            }
            if let Some(pty) = handle.pty.as_ref() {
                pty.resize(cols, rows);
            }
        }
    }

    /// TERM-07: apply the `terminal.attach`-supplied viewport geometry BEFORE
    /// the broker attach/replay, replicating Node's `shouldResize`
    /// (`broker.ts:358-362`): `viewport_hydrate` always resizes;
    /// `transport_reconnect` resizes only when no OTHER socket is attached or
    /// this same connection is re-attaching; `keepalive_delta` never resizes.
    /// Node samples the client set PRE-attach, so call this before `attach`
    /// inserts the subscriber (the insert would also destroy the
    /// "existing attachment" evidence for the same `conn_id`).
    /// Epoch semantics match `resize` (Task 2): the first-ever client
    /// geometry record never bumps; later real changes bump. A record also
    /// happens on unchanged dims when the resize is allowed, but never when
    /// the intent condition skips it (Node `broker.ts:373, 387-392`).
    pub fn resize_for_attach(
        &self,
        terminal_id: &str,
        conn_id: u64,
        intent: TerminalAttachIntent,
        cols: u16,
        rows: u16,
    ) -> AttachResizeStatus {
        let cols = cols.max(Self::MIN_GEOMETRY_DIM);
        let rows = rows.max(Self::MIN_GEOMETRY_DIM);
        let inner = self.inner.lock().expect("registry lock");
        let Some(handle) = inner.terminals.get(terminal_id) else {
            return AttachResizeStatus::Missing;
        };
        {
            let mut s = handle.shared.lock().expect("terminal lock");
            let has_other_attached = s.subscribers.keys().any(|k| *k != conn_id);
            let existing_attachment = s.subscribers.contains_key(&conn_id);
            let should_resize = match intent {
                TerminalAttachIntent::ViewportHydrate => true,
                TerminalAttachIntent::TransportReconnect => {
                    !has_other_attached || existing_attachment
                }
                TerminalAttachIntent::KeepaliveDelta => false,
            };
            if !should_resize {
                return AttachResizeStatus::Skipped;
            }
            if s.status != TerminalRunStatus::Running {
                return AttachResizeStatus::NotRunning;
            }
            // Node records geometry for BOTH 'resized' and 'unchanged' results
            // when shouldResize is true (broker.ts:387-392); a skipped attach
            // never records (broker.ts:373). The first-ever record applies
            // dims WITHOUT bumping the epoch (recordTerminalGeometry,
            // broker.ts:666-686) -- the same rule `resize` follows since Task 2.
            let first_record = !s.has_client_geometry;
            s.has_client_geometry = true;
            if s.cols == cols && s.rows == rows {
                return AttachResizeStatus::Unchanged;
            }
            s.cols = cols;
            s.rows = rows;
            if !first_record {
                s.geometry_epoch += 1;
            }
        }
        if let Some(pty) = handle.pty.as_ref() {
            pty.resize(cols, rows);
        }
        AttachResizeStatus::Resized
    }

    /// Current geometry bookkeeping as `(cols, rows, geometry_epoch)`; `None`
    /// for an unknown terminal id. Test/diagnostic seam for the TERM-07
    /// attach-time resize (the values `attach.ready` stamps come from here).
    pub fn geometry(&self, terminal_id: &str) -> Option<(u16, u16, i64)> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|shared| {
            let s = shared.lock().expect("terminal lock");
            (s.cols, s.rows, s.geometry_epoch)
        })
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
        // sessionRef lease fix (finding 1): the kill path REMOVES the row
        // entirely, so `claim_session_ref`'s "known dead" probe (which needs
        // a registered-but-not-Running row) can never fire for a killed
        // winner — an UNKNOWN id would be honored as `BoundElsewhere{dead-id}`
        // forever. Prune any sessionRef binding pointing at this terminal at
        // row-removal time instead. This is the ONLY row-removal site
        // (natural exit RETAINS the row via `finish_pty_exit`). The `inner`
        // lock is already released here, so no ordering hazard.
        self.session_ref_bindings
            .lock()
            .expect("session-ref bindings lock")
            .retain(|_, bound_id| bound_id != terminal_id);
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
            spontaneous: false,
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

    /// Read-only liveness probe: is a terminal with this id currently in the
    /// registry? Used by `freshell-ws`'s `terminal.create` requestId-dedupe
    /// guard for lazy eviction of settled entries whose terminal is gone
    /// (killed/exited). Registry-lock + `contains_key` — no tokio, no
    /// side effects.
    pub fn exists(&self, terminal_id: &str) -> bool {
        self.inner
            .lock()
            .expect("registry lock")
            .terminals
            .contains_key(terminal_id)
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
        let now = now_ms();
        s.status = TerminalRunStatus::Exited;
        s.exit_code = Some(exit_code);
        s.last_activity_at = now;
        s.last_meaningful_activity_at = now;
        let respawn_key = s.create_request_id.clone();
        let lifetime_ms = now.saturating_sub(s.created_at);
        let exit = ServerMessage::TerminalExit(TerminalExit {
            exit_code,
            terminal_id: terminal_id.to_string(),
        });
        for sub in s.subscribers.values() {
            (sub.sink)(exit.clone());
        }
        s.subscribers.clear();
        drop(s);
        // Reconciliation §7.5: a generation that died inside the liveness
        // window counts toward the respawn cap; one that survived it resets
        // the counter (a healthy resume is not penalized). Natural exits only
        // — a user-initiated `kill` removes the record without passing here.
        if let Some(key) = respawn_key {
            let window = self.respawn_liveness_window_ms.load(Ordering::Relaxed);
            let mut inner = self.inner.lock().expect("registry lock");
            if lifetime_ms < window {
                *inner.respawn_generations.entry(key).or_insert(0) += 1;
            } else {
                inner.respawn_generations.remove(&key);
            }
        }
        tracing::info!(terminal_id = %terminal_id, exit_code = exit_code, "terminal.exited");
        // TERM-15/TERM-16 tap: natural exit clears activity (the hub removes
        // the record — no stale blue after exit, TERM-18 semantics).
        self.notify_activity(ActivityEvent::Exit {
            terminal_id: terminal_id.to_string(),
            at: now_ms(),
            spontaneous: true,
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
                    cwd: s.cwd.clone(),
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

    /// Register a terminal record with NO backing PTY — see [`HeadlessTerminal`]
    /// for exactly who this seam exists for. The row (including its
    /// `create_request_id` stamp) is inserted atomically under the registry
    /// lock, same as [`Self::create`].
    pub fn register_headless(&self, opts: HeadlessTerminal) {
        let created_at = opts.created_at.unwrap_or_else(now_ms);
        let mode = if opts.mode.is_empty() {
            "shell".to_string()
        } else {
            opts.mode
        };
        let create_request_id = opts.create_request_id.clone();
        let shared = Arc::new(Mutex::new(TerminalShared {
            terminal_id: opts.terminal_id.clone(),
            stream_id: opts.stream_id,
            replay: VecDeque::new(),
            replay_chars: 0,
            max_replay_chars: self.scrollback_max_bytes().max(0) as usize,
            scanner: BarrierScanner::new(),
            noise: NoiseScanner::new(),
            head_seq: 0,
            status: TerminalRunStatus::Running,
            exit_code: None,
            created_at,
            last_activity_at: created_at,
            last_meaningful_activity_at: created_at,
            cols: 120,
            rows: 30,
            geometry_epoch: 1,
            has_client_geometry: false,
            cwd: None,
            title: "Shell".to_string(),
            description: None,
            mode,
            resume_session_id: opts.resume_session_id,
            create_request_id,
            subscribers: HashMap::new(),
        }));
        {
            let mut inner = self.inner.lock().expect("registry lock");
            inner.terminals.insert(
                opts.terminal_id.clone(),
                TerminalHandle { shared, pty: None },
            );
            inner.revision += 1;
        }
        if let Some(key) = opts
            .create_request_id
            .or_else(|| self.probe_create_request_id(&opts.terminal_id))
        {
            self.warn_on_duplicate_live_ptys(&key);
        }
    }

    /// Terminals (of any status) matching a `createRequestId`, NEWEST
    /// generation first (`created_at` desc, `terminal_id` desc tie-break).
    fn terminals_by_create_request_id(&self, key: &str) -> Vec<(String, TerminalRunStatus)> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        let mut rows: Vec<(i64, String, TerminalRunStatus)> = shareds
            .iter()
            .filter_map(|shared| {
                let s = shared.lock().expect("terminal lock");
                if s.create_request_id.as_deref() == Some(key) {
                    Some((s.created_at, s.terminal_id.clone(), s.status))
                } else {
                    None
                }
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        rows.into_iter()
            .map(|(_, id, status)| (id, status))
            .collect()
    }

    /// The newest **live** terminal for a `createRequestId` — the idempotency
    /// keystone (design §7) and the single-flight create-dedupe key (§5.4).
    /// Exited generations are excluded; a key whose every generation has
    /// exited returns `None`.
    pub fn newest_live_by_create_request_id(&self, key: &str) -> Option<String> {
        self.terminals_by_create_request_id(key)
            .into_iter()
            .find(|(_, status)| *status == TerminalRunStatus::Running)
            .map(|(id, _)| id)
    }

    /// The newest terminal for a `createRequestId` INCLUDING exited
    /// generations — used by the verdict derivation (§5.2 step 2) to recover a
    /// retired terminal's identity before declaring `fresh`.
    pub fn newest_by_create_request_id(&self, key: &str) -> Option<String> {
        self.terminals_by_create_request_id(key)
            .into_iter()
            .next()
            .map(|(id, _)| id)
    }

    /// Whether a terminal is registered AND currently running (an exited-but-
    /// retained record is NOT live — contrast [`Self::is_running`], which only
    /// checks registration).
    pub fn is_live(&self, terminal_id: &str) -> bool {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        match shared {
            Some(shared) => {
                shared.lock().expect("terminal lock").status == TerminalRunStatus::Running
            }
            None => false,
        }
    }

    /// One terminal's [`IdentityProbeRow`] (mode / status / registry-side
    /// resume id) — the per-terminal getter the reconcile derivation uses to
    /// resolve identity across the crate boundary for REST-created resumes
    /// (design §2 assumption 1's acceptance check).
    pub fn probe(&self, terminal_id: &str) -> Option<IdentityProbeRow> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|shared| {
            let s = shared.lock().expect("terminal lock");
            IdentityProbeRow {
                terminal_id: s.terminal_id.clone(),
                mode: s.mode.clone(),
                status: s.status,
                created_at: s.created_at,
                resume_session_id: s.resume_session_id.clone(),
                cwd: s.cwd.clone(),
            }
        })
    }

    /// A terminal's stamped `createRequestId`, if any.
    pub fn probe_create_request_id(&self, terminal_id: &str) -> Option<String> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.and_then(|shared| {
            shared
                .lock()
                .expect("terminal lock")
                .create_request_id
                .clone()
        })
    }

    /// §5.4 single-flight claim: reserve `key` for an in-flight keyed create.
    /// `false` means another create currently holds the reservation — the
    /// caller should re-check for a live terminal (adopt) instead of
    /// spawning. Pair with [`Self::end_keyed_create`].
    pub fn begin_keyed_create(&self, key: &str) -> bool {
        self.keyed_create_inflight
            .lock()
            .expect("keyed-create inflight lock")
            .insert(key.to_string())
    }

    /// Release a [`Self::begin_keyed_create`] reservation (success OR failure
    /// — the spawn's outcome is discoverable via the registry itself).
    pub fn end_keyed_create(&self, key: &str) {
        self.keyed_create_inflight
            .lock()
            .expect("keyed-create inflight lock")
            .remove(key);
    }

    /// Same-id double-resume guard claim (see `resume_create_inflight`'s
    /// field doc): reserve a `"resume:{mode}:{sid}"` key for an in-flight
    /// amplifier resume create. `false` means another create currently holds
    /// it. Mirrors [`Self::begin_keyed_create`]; pair with
    /// [`Self::end_resume_create`].
    fn begin_resume_create(&self, key: &str) -> bool {
        self.resume_create_inflight
            .lock()
            .expect("resume-create inflight lock")
            .insert(key.to_string())
    }

    /// Release a [`Self::begin_resume_create`] reservation (success OR
    /// failure — mirrors [`Self::end_keyed_create`]).
    fn end_resume_create(&self, key: &str) {
        self.resume_create_inflight
            .lock()
            .expect("resume-create inflight lock")
            .remove(key);
    }

    /// Council rule 7 (D8): claim the one in-flight create slot for a
    /// sessionRef. Checks, in order:
    ///
    /// 1. A live terminal already carrying the ref
    ///    ([`Self::live_terminal_for_session_ref`]) or a recorded binding
    ///    whose terminal is not KNOWN dead → `BoundElsewhere` (attach to the
    ///    winner). A binding whose terminal is known dead (registered but
    ///    not Running) is pruned instead — a dead winner must not strand
    ///    losers.
    /// 2. A held, unexpired lease → `Held` (retry after
    ///    [`SESSION_RESERVED_RETRY_AFTER_MS`]).
    /// 3. A held lease past `acquired_at_ms + `[`SESSION_REF_LEASE_TTL_MS`]:
    ///    with a recorded pid → `ExpiredNeedsKill` (KILL-BEFORE-RELEASE: the
    ///    lease stays held until [`Self::force_release_after_confirmed_kill`]);
    ///    without one (holder hung pre-spawn, nothing to kill) → revoke the
    ///    lease, ERROR-log, and answer `Held` — hold closed, never release
    ///    what you can't kill.
    /// 4. Otherwise the slot is free → record the lease, `Acquired`.
    ///
    /// `now_ms` is caller-supplied wall-clock so tests never sleep.
    pub fn claim_session_ref(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        holder_conn: u64,
        now_ms: u64,
    ) -> SessionRefClaim {
        let key = session_ref_key(locator);

        // 1a. Row-join liveness: a live terminal already carries this ref.
        if let Some(terminal_id) = self.live_terminal_for_session_ref(locator) {
            return SessionRefClaim::BoundElsewhere { terminal_id };
        }

        // 1b. Recorded binding — honored unless its terminal is KNOWN dead
        // (a registered row that is no longer Running). Lock order: the
        // bindings mutex is held across the liveness probes, which take only
        // the registry `inner` + terminal locks; no path acquires bindings
        // while holding those, so the order is acyclic.
        {
            let mut bindings = self
                .session_ref_bindings
                .lock()
                .expect("session-ref bindings lock");
            if let Some(terminal_id) = bindings.get(&key).cloned() {
                let known_dead = self.is_running(&terminal_id) && !self.is_live(&terminal_id);
                if known_dead {
                    bindings.remove(&key);
                } else {
                    return SessionRefClaim::BoundElsewhere { terminal_id };
                }
            }
        }

        self.claim_session_ref_lease_phase(locator, holder_create_request_id, holder_conn, now_ms)
    }

    /// Lease phase of [`Self::claim_session_ref`] (steps 2-4: held /
    /// expired / free). Split out so the claim-side TOCTOU re-check
    /// (final review finding 1) can be pinned by a test that stages
    /// "loser passed checks 1a/1b before the winner registered" without
    /// threads: a full `claim_session_ref` call is always caught by step
    /// 1b while a binding exists, so only a direct entry here can
    /// exercise the under-lock re-check.
    fn claim_session_ref_lease_phase(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        holder_conn: u64,
        now_ms: u64,
    ) -> SessionRefClaim {
        let key = session_ref_key(locator);
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        match leases.get_mut(&key) {
            None => {
                // Claim-side TOCTOU (final review finding 1): checks 1a/1b
                // ran BEFORE this lock was taken. A loser preempted across
                // the winner's register -> `complete_session_ref_claim`
                // window arrives here after complete removed the winner's
                // lease -- seeing no lease -- while only the bindings map
                // records the winner. Re-check bindings WHILE HOLDING the
                // leases lock: a recorded binding means a winner already
                // completed, so answer `BoundElsewhere` instead of
                // double-acquiring (a second spawn on one sessionRef is the
                // duplicate-writer shape D8 exists to close). Lock order
                // leases -> bindings matches `complete_session_ref_claim`
                // and is acyclic: step 1b's bindings block ends before the
                // leases lock is taken, and no path acquires the leases
                // lock while holding bindings. A binding observed here is
                // either freshly completed (live winner) or, if its winner
                // has since died, handled on the loser's retry claim, whose
                // step 1b prunes known-dead winners.
                let bound = self
                    .session_ref_bindings
                    .lock()
                    .expect("session-ref bindings lock")
                    .get(&key)
                    .cloned();
                if let Some(terminal_id) = bound {
                    return SessionRefClaim::BoundElsewhere { terminal_id };
                }
                leases.insert(
                    key,
                    SessionRefLease {
                        locator: locator.clone(),
                        holder_create_request_id: holder_create_request_id.to_string(),
                        holder_conn,
                        acquired_at_ms: now_ms,
                        pid: None,
                        revoked: false,
                    },
                );
                SessionRefClaim::Acquired
            }
            Some(lease) => {
                let expired = now_ms > lease.acquired_at_ms + session_ref_lease_ttl_ms();
                if !expired {
                    return SessionRefClaim::Held {
                        retry_after_ms: SESSION_RESERVED_RETRY_AFTER_MS,
                    };
                }
                match lease.pid {
                    Some(pid) => SessionRefClaim::ExpiredNeedsKill { pid },
                    None => {
                        if !lease.revoked {
                            lease.revoked = true;
                            tracing::error!(target: "invariant",
                                provider = %locator.provider,
                                session_id = %locator.session_id,
                                holder_create_request_id = %lease.holder_create_request_id,
                                acquired_at_ms = lease.acquired_at_ms,
                                now_ms,
                                "session_ref_lease_revoked: TTL expired on a pid-less holder; held closed");
                        }
                        SessionRefClaim::Held {
                            retry_after_ms: SESSION_RESERVED_RETRY_AFTER_MS,
                        }
                    }
                }
            }
        }
    }

    /// Record the holder's spawned child pid on its lease, arming the TTL
    /// expiry's `ExpiredNeedsKill` path. No-op if the lease is gone or held
    /// by a different `createRequestId`.
    pub fn set_session_ref_lease_pid(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        pid: u32,
    ) {
        let key = session_ref_key(locator);
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        if let Some(lease) = leases.get_mut(&key) {
            if lease.holder_create_request_id == holder_create_request_id {
                lease.pid = Some(pid);
            }
        }
    }

    /// Spawn succeeded: record binding, release lease, run the duplicate alarm.
    /// Returns false if the lease was revoked while spawning (caller must kill
    /// its own child and fail the create loudly). A revoked lease is NOT
    /// released here — kill-before-release: the caller confirms its child's
    /// death, then calls [`Self::force_release_after_confirmed_kill`].
    pub fn complete_session_ref_claim(
        &self,
        locator: &SessionLocator,
        holder_create_request_id: &str,
        terminal_id: &str,
    ) -> bool {
        let key = session_ref_key(locator);
        {
            let mut leases = self
                .session_ref_leases
                .lock()
                .expect("session-ref lease lock");
            match leases.get(&key) {
                Some(lease)
                    if lease.holder_create_request_id == holder_create_request_id
                        && !lease.revoked =>
                {
                    leases.remove(&key);
                    // ATOMICITY (fix round 1, finding 2): the binding MUST be
                    // inserted while the leases lock is still held. Releasing
                    // the lease first and binding under a separate lock opens
                    // a window where a racing `claim_session_ref` sees no live
                    // row, no binding, and no lease -> `Acquired` -> a second
                    // spawn: the exact duplicate-writer race this primitive
                    // exists to close. Lock order leases -> bindings is
                    // acyclic: `claim_session_ref`'s bindings block ends
                    // before it takes the leases lock, and no other path
                    // acquires the leases lock while holding bindings.
                    self.session_ref_bindings
                        .lock()
                        .expect("session-ref bindings lock")
                        .insert(key, terminal_id.to_string());
                }
                _ => return false,
            }
        }
        self.alarm_if_duplicate_session_ref(locator);
        true
    }

    /// Spawn failed: release the holder's lease (no child exists — the spawn
    /// itself errored — so release is safe even for a revoked lease). No-op
    /// if the lease is gone or held by a different `createRequestId`.
    pub fn fail_session_ref_claim(&self, locator: &SessionLocator, holder_create_request_id: &str) {
        let key = session_ref_key(locator);
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        if leases
            .get(&key)
            .is_some_and(|l| l.holder_create_request_id == holder_create_request_id)
        {
            leases.remove(&key);
        }
    }

    /// Connection death: release this conn's leases. Returns (locator_key, pid)
    /// pairs whose in-flight children the caller must kill (kill-before-release
    /// applies: entries WITH a pid are returned still-held; caller kills,
    /// confirms, then calls force_release_after_confirmed_kill).
    pub fn release_session_ref_leases_for_conn(
        &self,
        conn: u64,
    ) -> Vec<(SessionLocator, Option<u32>)> {
        let mut leases = self
            .session_ref_leases
            .lock()
            .expect("session-ref lease lock");
        let mut out = Vec::new();
        leases.retain(|_, lease| {
            if lease.holder_conn != conn {
                return true;
            }
            out.push((lease.locator.clone(), lease.pid));
            // pid-less: nothing spawned, release now. pid-carrying: keep held
            // until the caller confirms the kill (kill-before-release).
            lease.pid.is_some()
        });
        out
    }

    /// The caller killed the holder's child via the registry PTY handle and
    /// CONFIRMED death (ESRCH): release the lease so the next claim wins.
    pub fn force_release_after_confirmed_kill(&self, locator: &SessionLocator) {
        self.session_ref_leases
            .lock()
            .expect("session-ref lease lock")
            .remove(&session_ref_key(locator));
    }

    /// The terminalId a completed claim bound this sessionRef to
    /// ([`Self::complete_session_ref_claim`]), if any — the read side of the
    /// registry binding map (Task 6 winner bind; also a test probe).
    pub fn bound_terminal_for_session_ref(&self, locator: &SessionLocator) -> Option<String> {
        self.session_ref_bindings
            .lock()
            .expect("session-ref bindings lock")
            .get(&session_ref_key(locator))
            .cloned()
    }

    /// The live child pid behind `terminal_id`'s PTY handle (unix only;
    /// `None` for headless/exited terminals). Task 6: the winner records this
    /// on its sessionRef lease ([`Self::set_session_ref_lease_pid`]).
    pub fn pid_of(&self, terminal_id: &str) -> Option<u32> {
        let inner = self.inner.lock().expect("registry lock");
        inner
            .terminals
            .get(terminal_id)
            .and_then(|h| h.pty.as_ref())
            .and_then(|p| p.pid())
    }

    /// The terminal whose PTY handle carries `pid`. The kill-before-release
    /// paths (lease TTL expiry, holder conn death) must kill through the
    /// REGISTRY handle ([`Self::kill`] → group-kill discipline, `pty.rs`) —
    /// NEVER a raw single-pid SIGKILL — so they resolve the recorded pid back
    /// to its owning terminal first.
    pub fn live_terminal_for_pid(&self, pid: u32) -> Option<String> {
        let inner = self.inner.lock().expect("registry lock");
        inner.terminals.iter().find_map(|(id, h)| {
            (h.pty.as_ref().and_then(|p| p.pid()) == Some(pid)).then(|| id.clone())
        })
    }

    /// §5.4 backstop detector (always-on, capability-independent): if a key
    /// now has two or more LIVE terminals, make it loud — two live PTYs on one
    /// `createRequestId` means two JSONL writers on one session file.
    fn warn_on_duplicate_live_ptys(&self, key: &str) {
        let live: Vec<String> = self
            .terminals_by_create_request_id(key)
            .into_iter()
            .filter(|(_, status)| *status == TerminalRunStatus::Running)
            .map(|(id, _)| id)
            .collect();
        if live.len() >= 2 {
            tracing::warn!(
                create_request_id = %key,
                terminal_ids = ?live,
                "ws.reconcile.duplicate_pty"
            );
        }
    }

    /// Live terminal ids currently carrying this sessionRef via the
    /// registry-row join: `mode == locator.provider &&
    /// resume_session_id == Some(locator.session_id) && status Running`,
    /// newest generation first (`created_at` desc, `terminal_id` desc
    /// tie-break, mirroring [`Self::terminals_by_create_request_id`]).
    ///
    /// LOOKUP DESIGN (validator-corrected): registry rows have NO dedicated
    /// `session_ref` field ([`TerminalShared::inventory`] hardcodes
    /// `session_ref: None`), so row identity IS this join. Rows are one of
    /// the TWO identity stores — the other is `freshell-ws`'s identity
    /// registry, which this crate cannot see (dep direction) — so ws-side
    /// callers consult both.
    fn live_terminal_ids_for_session_ref(&self, locator: &SessionLocator) -> Vec<String> {
        let shareds: Vec<Arc<Mutex<TerminalShared>>> = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .values()
                .map(|h| Arc::clone(&h.shared))
                .collect()
        };
        let mut rows: Vec<(i64, String)> = shareds
            .iter()
            .filter_map(|shared| {
                let s = shared.lock().expect("terminal lock");
                if s.status == TerminalRunStatus::Running
                    && s.mode == locator.provider
                    && s.resume_session_id.as_deref() == Some(locator.session_id.as_str())
                {
                    Some((s.created_at, s.terminal_id.clone()))
                } else {
                    None
                }
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        rows.into_iter().map(|(_, id)| id).collect()
    }

    /// Council rule 6: the live terminal (newest first) currently carrying
    /// this sessionRef, if any — the reconcile derivation and the create-path
    /// lease (Tasks 5/6) attach every other client's claim for the same ref
    /// to this winner, regardless of `createRequestId`.
    pub fn live_terminal_for_session_ref(&self, locator: &SessionLocator) -> Option<String> {
        self.live_terminal_ids_for_session_ref(locator)
            .into_iter()
            .next()
    }

    /// D7 live-session guard predicate, shared by the WS `terminal.create`
    /// path (`freshell-ws/src/terminal.rs`) and the REST spawn pipeline
    /// (`freshell-freshagent/src/terminal_tabs.rs`): returns the terminal_id
    /// of a currently-RUNNING terminal that already owns `(mode, session_id)`,
    /// if any. Two arms, exactly the WS guard's join (see commit d9b71f50):
    /// 1. identity arm: the injected identity store's owner, probed Running;
    /// 2. row arm: any directory row with this mode + resume_session_id, Running.
    ///
    /// `identity: None` (e.g. the seam is unwired) narrows to the row arm.
    pub fn live_session_owner(
        &self,
        identity: Option<&dyn SessionIdentityLookup>,
        mode: &str,
        session_id: &str,
    ) -> Option<String> {
        if let Some(owner_tid) = identity
            .and_then(|ident| ident.terminal_for_session(mode, session_id))
            .filter(|tid| {
                self.probe(tid)
                    .is_some_and(|r| r.status == TerminalRunStatus::Running)
            })
        {
            return Some(owner_tid);
        }
        self.directory().into_iter().find_map(|entry| {
            (entry.mode == mode
                && entry.resume_session_id.as_deref() == Some(session_id)
                && entry.status == TerminalRunStatus::Running)
                .then_some(entry.terminal_id)
        })
    }

    /// Council rule 9, D8 backstop: >=2 live PTYs carrying one sessionRef is
    /// the two-writers corruption shape. Alarm loudly (ERROR-level invariant
    /// log); never kill silently. Returns whether the invariant is violated.
    pub fn alarm_if_duplicate_session_ref(&self, locator: &SessionLocator) -> bool {
        let live = self.live_terminal_ids_for_session_ref(locator);
        if live.len() >= 2 {
            tracing::error!(target: "invariant",
                provider = %locator.provider,
                session_id = %locator.session_id,
                live = live.len(),
                terminal_ids = ?live,
                "duplicate_pty_for_session_ref: >=2 live PTYs share one sessionRef");
            return true;
        }
        false
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

    /// True only while the terminal's PTY is still running. Unlike the
    /// presence-only `exists()`/`is_running`, this goes false when the
    /// terminal exits naturally, even though the record is retained for
    /// restore/replay. Drives create-dedupe eviction: legacy parity with
    /// the Node server's delete-at-exit requestId pruning.
    pub fn is_pty_running(&self, terminal_id: &str) -> bool {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get(terminal_id) {
                Some(handle) => Arc::clone(&handle.shared),
                None => return false,
            }
        };
        let s = shared.lock().expect("terminal lock");
        s.status == TerminalRunStatus::Running
    }
}

/// Same-id double-resume guard (launcher-assigned amplifier identity plan):
/// does any RUNNING terminal of `mode` already carry `session_id` as its
/// resume id? Amplifier has no upstream concurrency guard — two live PTYs
/// resuming one session id would interleave writes into one session dir.
/// Shared here so both the WS create path (`freshell-ws`) and the REST
/// create path (`freshell-freshagent`) apply the identical predicate.
/// NOTE: this is the friendly PRE-CHECK only — the race-free enforcement
/// lives inside [`TerminalRegistry::create`] (validated fix F5).
pub fn has_live_resume(rows: &[IdentityProbeRow], mode: &str, session_id: &str) -> bool {
    rows.iter().any(|row| {
        row.mode == mode
            && row.status == TerminalRunStatus::Running
            && row.resume_session_id.as_deref() == Some(session_id)
    })
}

/// [`has_live_resume`] EXCLUDING one terminal id — the exit-hook stub-GC
/// guard (validated fix F5/V7's GC-vs-second-resume race): "is another live
/// terminal (not me) currently resuming this session id?" Used by both
/// exit hooks before deleting a never-used stub.
pub fn has_other_live_resume(
    rows: &[IdentityProbeRow],
    mode: &str,
    session_id: &str,
    excluding_terminal_id: &str,
) -> bool {
    rows.iter().any(|row| {
        row.terminal_id != excluding_terminal_id
            && row.mode == mode
            && row.status == TerminalRunStatus::Running
            && row.resume_session_id.as_deref() == Some(session_id)
    })
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
    // DEV-0009: only genuinely-new content refreshes the idle-kill reap
    // clock. Spinner repaints / ticking counters / status-bar redraws still
    // bump the wire-visible last_activity_at above (terminal-core.md §1.3
    // holds for every consumer except the reaper) but must not exempt a
    // detached terminal from enforce_idle_kills forever.
    if s.noise.observe(&frame.data) {
        s.last_meaningful_activity_at = s.last_activity_at;
    }

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
            self.register_headless(HeadlessTerminal {
                terminal_id: terminal_id.to_string(),
                stream_id: stream_id.to_string(),
                mode: "shell".to_string(),
                resume_session_id: None,
                create_request_id: None,
                created_at: Some(created_at),
            });
        }

        /// Test-only: force a terminal's `lastActivityAt` AND its DEV-0009
        /// meaningful-activity reap clock to an arbitrary value so idle-kill
        /// sweep tests don't need to sleep for real minutes.
        fn backdate_last_activity(&self, terminal_id: &str, last_activity_at: i64) {
            let inner = self.inner.lock().unwrap();
            let handle = inner.terminals.get(terminal_id).unwrap();
            let mut s = handle.shared.lock().unwrap();
            s.last_activity_at = last_activity_at;
            s.last_meaningful_activity_at = last_activity_at;
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
        let _ = reg.attach("T", 1, legacy_sink, Some("legacy".into()), 0, false, None);
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
        let _ = reg.attach("T", 2, batch_sink, Some("batch".into()), 0, true, None);
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
        let _ = reg.attach("T", 1, sink, Some("m".into()), 0, true, None);
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
        let _ = reg.attach("T", 1, sink_a, Some("a".into()), 0, false, None);
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
        let _ = reg.attach("T", 2, sink_b, Some("b".into()), 0, false, None);
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
        let _ = reg.attach("T", 1, sink_a, Some("aaa".into()), 0, false, None);
        // Second attach: geometry authority flips to multi_client_unknown.
        let _ = reg.attach("T", 2, sink_b, Some("bbb".into()), 0, false, None);
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
        let _ = reg.attach("T", 1, sink_a, Some("a".into()), 0, false, None);
        for i in 1..=5 {
            reg.feed("T", frame(i, &format!("line-{i}\r\n"), "S"));
        }
        assert_eq!(outputs(&seen_a).len(), 5);

        // Reconnect: the client already rendered through seq 3, so it re-attaches
        // with sinceSeq=3. Only frames 4 and 5 are replayed (seqStart > 3).
        reg.detach("T", 1);
        let (sink_r, seen_r) = collector();
        let _ = reg.attach("T", 2, sink_r, Some("a2".into()), 3, false, None);
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
        let _ = reg.attach("T", 7, sink, Some("z".into()), 0, false, None);
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
    fn input_to_unknown_terminal_reports_not_found() {
        // Silent-loss fix (kata dtfn): the None branch used to be a pure no-op.
        let reg = TerminalRegistry::new();
        let out = reg.input("nope", b"lost bytes");
        assert!(!out.found);
    }

    #[test]
    fn input_to_headless_terminal_reports_found() {
        // Headless => no PTY write, but the terminal EXISTS: found must be true
        // (the activity bump in input_write_resets_the_idle_reap_clock depends
        // on headless input still counting).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.input("T", b"ls\n");
        assert!(out.found);
    }

    #[test]
    fn kill_removes_terminal_notifies_subscribers_and_bumps_revision() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let rev_before = reg.revision();
        let (sink, seen) = collector();
        let _ = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);

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
        let _ = reg.attach("T-a", 1, sink_a, None, 0, false, None);
        let _ = reg.attach("T-b", 2, sink_b, None, 0, false, None);
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

    /// `is_pty_running` must report run-status, not record presence: a
    /// naturally-exited terminal is RETAINED in the registry (for restore),
    /// so `exists()` stays true while `is_pty_running()` goes false. This is
    /// the distinction create-dedupe eviction anchors to (legacy parity with
    /// the Node server's delete-at-exit requestId pruning).
    #[test]
    fn is_pty_running_false_for_exited_retained_terminal() {
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
        let terminal_id = "T-pty-running-natural-exit".to_string();
        let on_exit_id = terminal_id.clone();
        reg.create(
            &spec,
            &env,
            terminal_id.clone(),
            "S".to_string(),
            "shell",
            None,
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
        // real-time dependency).
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

        assert!(
            reg.exists(&terminal_id),
            "exited terminal record is retained for restore"
        );
        assert!(
            !reg.is_pty_running(&terminal_id),
            "is_pty_running must go false at natural exit even though the record is retained"
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
        let _ = reg.attach("T", 9, sink, Some("a".into()), 0, false, None);
        assert!(reg.directory()[0].has_clients);
        reg.detach("T", 9);
        assert!(!reg.directory()[0].has_clients);
    }

    #[test]
    fn resize_updates_geometry_epoch_only_on_change() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        reg.resize("T", 100, 40); // first record: applied, no bump
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        reg.resize("T", 100, 40); // identical dims: no bump
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        reg.resize("T", 90, 35); // subsequent real change: bump
        assert_eq!(reg.geometry("T"), Some((90, 35, 2)));
    }

    #[test]
    fn resize_floors_dimensions_at_two_node_broker_parity() {
        // Node: recordTerminalGeometry floors both dims at 2 (broker.ts:672-673).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.resize("T", 0, 0); // first record: floored to (2,2), no epoch bump
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        reg.resize("T", 1, 1); // floors to (2,2): unchanged, no bump
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        reg.resize("T", 1, 40); // floors to (2,40): real change, bump
        assert_eq!(reg.geometry("T"), Some((2, 40, 2)));
        reg.resize("T", 2, 2); // exact minimum passes through unaltered
        assert_eq!(reg.geometry("T"), Some((2, 2, 3)));
        reg.resize("T", 95, 41); // normal values pass through unaltered
        assert_eq!(reg.geometry("T"), Some((95, 41, 4)));
    }

    #[test]
    fn resize_for_attach_floors_dimensions_at_two_node_broker_parity() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let status = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 0, 1);
        assert!(matches!(status, AttachResizeStatus::Resized));
        assert_eq!(reg.geometry("T"), Some((2, 2, 1))); // first record: no bump
        let status = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 1, 2);
        assert!(matches!(status, AttachResizeStatus::Unchanged)); // floored dup
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        let status = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert!(matches!(status, AttachResizeStatus::Resized));
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn first_client_geometry_records_without_epoch_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1, no client geometry yet
                                       // First client-supplied geometry: applied + recorded, NO epoch bump
                                       // (Node recordTerminalGeometry: hasPreviousGeometry=false => no bump,
                                       // broker.ts:666-686; spawn dims never count, broker.ts:692-697).
        reg.resize("T", 100, 40);
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        // Second real change: bumps.
        reg.resize("T", 90, 35);
        assert_eq!(reg.geometry("T"), Some((90, 35, 2)));
    }

    #[test]
    fn unchanged_first_geometry_still_counts_as_recorded() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Node records geometry on 'unchanged' results too (ws-handler.ts:2995
        // records for both 'resized' and 'unchanged'), so the NEXT change bumps.
        reg.resize("T", 120, 30); // dims equal the spawn default: records, no change
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        reg.resize("T", 95, 41);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn geometry_reports_cols_rows_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // headless default: 120x30, epoch 1
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));

        assert_eq!(reg.geometry("nope"), None);
    }

    #[test]
    fn resize_for_attach_viewport_hydrate_applies_first_geometry_without_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        // First-ever client geometry: applied, epoch NOT bumped (Node
        // first-record-no-bump, broker.ts:666-686).
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_second_change_bumps_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 100, 50);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((100, 50, 2)));
    }

    #[test]
    fn resize_for_attach_unchanged_geometry_records_but_does_not_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 120, 30);
        assert_eq!(out, AttachResizeStatus::Unchanged);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        // Node records geometry on 'unchanged' results too (broker.ts:387-392),
        // so the next real change must bump.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn resize_for_attach_keepalive_delta_never_resizes_or_records() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::KeepaliveDelta, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        // A skipped attach must NOT count as a geometry record (Node's forced
        // 'unchanged' at broker.ts:373 never records): the next applied
        // geometry is still the FIRST record, so no bump.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_applies_when_alone() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // No subscribers at all -> no other attached sockets -> resize.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_skips_when_other_socket_attached() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let _ = reg.attach("T", 1, sink, Some("a".into()), 0, false, None); // conn 1 is attached
                                                                            // conn 2 reconnects with another socket attached and no prior attachment of its own.
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_applies_when_same_conn_reattaches() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink1, _seen1) = collector();
        let (sink2, _seen2) = collector();
        let _ = reg.attach("T", 1, sink1, Some("a".into()), 0, false, None);
        let _ = reg.attach("T", 2, sink2, Some("b".into()), 0, false, None);
        // conn 2 already has an attachment -> resize even though conn 1 is also attached
        // (Node: existingAttachment wins over hasOtherAttachedSockets).
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        // First-ever geometry record: no epoch bump.
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_missing_terminal() {
        let reg = TerminalRegistry::new();
        let out = reg.resize_for_attach("nope", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Missing);
    }

    #[test]
    fn resize_for_attach_exited_terminal_not_running() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // finish_pty_exit flips a headless terminal to Exited while RETAINING
        // the record (registry.rs:1112) -- the same seam the existing test
        // attach_to_already_exited_terminal_delivers_synthetic_exit uses.
        assert!(reg.finish_pty_exit("T", 7));
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::NotRunning);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn remove_connection_sweeps_subscriptions_from_all_terminals() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T1", "S1");
        reg.insert_headless("T2", "S2");
        let (sink1, seen1) = collector();
        let (sink2, seen2) = collector();
        let _ = reg.attach("T1", 42, sink1, Some("a".into()), 0, false, None);
        let _ = reg.attach("T2", 42, sink2, Some("a".into()), 0, false, None);

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
    fn enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        // Warm-up: the FIRST paint of a status line is genuinely new content
        // and legitimately counts as activity.
        reg.feed("T", frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S"));
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        // Codex-style repaint noise after the backdate: same status line,
        // only the braille glyph and the digits tick. Each frame still bumps
        // the wire-visible last_activity_at (unchanged legacy semantics) but
        // must NOT refresh the reap clock.
        for (i, paint) in [
            "\r\x1b[2K⠙ (2s • esc to interrupt)",
            "\r\x1b[2K⠹ (3s • esc to interrupt)",
            "\r\x1b[2K⠸ (14s • esc to interrupt)",
            "\r\x1b[2K⠼ (65s • esc to interrupt)",
        ]
        .iter()
        .enumerate()
        {
            reg.feed("T", frame(i as i64 + 2, paint, "S"));
        }

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T".to_string()]);
        assert!(reg.inventory().is_empty());
    }

    #[test]
    fn enforce_idle_kills_spares_detached_terminal_streaming_genuine_output() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        // A long build streaming REAL new log lines: genuine work, must
        // survive the sweep even while detached.
        reg.feed(
            "T",
            frame(1, "   Compiling freshell-terminal v0.1.0\n", "S"),
        );
        reg.feed(
            "T",
            frame(2, "warning: unused variable `x` in registry.rs\n", "S"),
        );

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn input_write_resets_the_idle_reap_clock() {
        // User keystrokes are always activity (headless => the PTY write is
        // skipped but the activity bump still happens, matching input()).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert!(reg.input("T", b"ls\n").found);

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn detach_grants_full_idle_threshold_of_grace() {
        // A user may WATCH a spinner-only terminal attached for hours: the
        // attached exemption forbids reaping, but nothing refreshes the
        // meaningful clock, so it pre-expires underneath them. Detaching
        // must therefore grant one full threshold of grace (DEV-0009) —
        // otherwise the very next 30s sweep kills a terminal the user
        // deliberately backgrounded seconds earlier (legacy never reaped it;
        // terminal-core.md A13: "terminal stays running").
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let outcome = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        assert!(outcome.found);
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        reg.detach("T", 1);

        // Freshly detached: the transition bump spares it a full threshold.
        assert!(reg.enforce_idle_kills().is_empty());
        assert_eq!(reg.inventory().len(), 1);

        // Once it goes stale again AFTER the detach, it is reaped normally.
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        assert_eq!(reg.enforce_idle_kills(), vec!["T".to_string()]);
    }

    #[test]
    fn disconnect_grants_full_idle_threshold_of_grace() {
        // Socket-close cleanup (remove_connection) is the other live
        // transition-to-detached path and must grant the same grace as an
        // explicit detach. The bump is gated on "this connection actually
        // subscribed here AND the set became empty AND status is Running" —
        // remove_connection iterates EVERY terminal, and an unconditional
        // bump would reset unrelated detached terminals' countdowns on
        // every socket close.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        let outcome = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
        assert!(outcome.found);
        // A second, already-detached terminal whose countdown must NOT be
        // disturbed by conn 1's disconnect.
        reg.insert_headless("U", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        reg.backdate_last_activity("U", now_ms() - 10 * 60_000);
        reg.remove_connection(1);

        let killed = reg.enforce_idle_kills();

        // T was freshly detached by the disconnect => spared one threshold.
        // U never had a subscriber => its stale countdown stands => reaped.
        assert_eq!(killed, vec!["U".to_string()]);
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
        let _ = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
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
        let _ = reg.attach("T", 1, sink, Some("a".into()), 0, false, None);
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
        let _ = reg_ascii.attach("A", 1, sink_a, Some("r".into()), 0, false, None);
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
        let _ = reg_box.attach("B", 1, sink_b, Some("r".into()), 0, false, None);
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
        assert!(reg.input("T-act", b"\r").found);
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
            None,
        )
        .expect("spawn");

        // Give the PTY time to produce output; the tap must stay silent for
        // Input/Output on a plain shell (zero per-chunk overhead).
        assert!(reg.input("T-shell", b"\r").found);
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
    fn kill_emits_a_non_spontaneous_exit_event() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));
        reg.insert_headless("T-kill", "S-kill");
        assert!(reg.kill("T-kill"));
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Exit { terminal_id, spontaneous, .. }
                    if terminal_id == "T-kill" && !spontaneous
            )),
            "a freshell-initiated kill must emit Exit with spontaneous == false"
        );
    }

    #[test]
    fn natural_pty_exit_emits_a_spontaneous_exit_event() {
        let reg = TerminalRegistry::new();
        let seen: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        reg.set_activity_observer(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));
        reg.insert_headless("T-spont", "S-spont");
        assert!(reg.finish_pty_exit("T-spont", 0));
        assert!(
            seen.lock().unwrap().iter().any(|e| matches!(
                e,
                ActivityEvent::Exit { terminal_id, spontaneous, .. }
                    if terminal_id == "T-spont" && *spontaneous
            )),
            "a natural PTY exit must emit Exit with spontaneous == true"
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
        let _ = reg.attach("T", 1, sink, Some("r".into()), 0, false, None);
        let retained_chars: usize = outputs(&seen).iter().map(|f| f.data.chars().count()).sum();
        assert!(
            retained_chars as i64 <= cap,
            "retained {retained_chars} chars must not exceed the {cap}-char cap"
        );
    }

    // ------------------------------------------------------------------
    // Reconciliation handshake (design §5.1): createRequestId stamped
    // atomically with the registry insert + the two newest-generation
    // accessors + the ≥2-live-PTYs-per-key backstop detector.
    // ------------------------------------------------------------------

    fn headless(reg: &TerminalRegistry, id: &str, key: Option<&str>, created_at: i64) {
        reg.register_headless(HeadlessTerminal {
            terminal_id: id.to_string(),
            stream_id: format!("S-{id}"),
            mode: "claude".to_string(),
            resume_session_id: None,
            create_request_id: key.map(str::to_string),
            created_at: Some(created_at),
        });
    }

    #[test]
    fn create_stamps_create_request_id_visible_via_newest_live_accessor() {
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
            "T-crid".to_string(),
            "S-crid".to_string(),
            "shell",
            None,
            Some("cr-stamp-1"),
            None,
            None,
        )
        .expect("spawn /bin/sh");

        assert_eq!(
            reg.newest_live_by_create_request_id("cr-stamp-1"),
            Some("T-crid".to_string())
        );
        reg.kill("T-crid");
    }

    #[test]
    fn newest_live_by_key_prefers_newest_generation_and_excludes_exited() {
        let reg = TerminalRegistry::new();
        headless(&reg, "gen1", Some("cr-k"), 1_000);
        headless(&reg, "gen2", Some("cr-k"), 2_000);
        // Exit the OLD generation: newest live is gen2.
        reg.finish_pty_exit("gen1", 0);
        assert_eq!(
            reg.newest_live_by_create_request_id("cr-k"),
            Some("gen2".to_string())
        );
        // Exit the newest too: no live generation left.
        reg.finish_pty_exit("gen2", 0);
        assert_eq!(reg.newest_live_by_create_request_id("cr-k"), None);
        // ... but the exited-inclusive accessor still finds the NEWEST one.
        assert_eq!(
            reg.newest_by_create_request_id("cr-k"),
            Some("gen2".to_string())
        );
        assert_eq!(reg.newest_by_create_request_id("cr-unknown"), None);
    }

    #[test]
    fn is_live_distinguishes_running_exited_and_unknown() {
        let reg = TerminalRegistry::new();
        headless(&reg, "T-live", None, 1_000);
        headless(&reg, "T-dead", None, 1_000);
        reg.finish_pty_exit("T-dead", 1);
        assert!(reg.is_live("T-live"));
        assert!(!reg.is_live("T-dead"));
        assert!(!reg.is_live("T-ghost"));
    }

    #[test]
    fn probe_returns_identity_row_with_mode_and_resume_id() {
        let reg = TerminalRegistry::new();
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-probe".to_string(),
            stream_id: "S-probe".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("sess-9".to_string()),
            create_request_id: Some("cr-probe".to_string()),
            created_at: None,
        });
        let row = reg.probe("T-probe").expect("registered");
        assert_eq!(row.mode, "codex");
        assert_eq!(row.resume_session_id.as_deref(), Some("sess-9"));
        assert_eq!(row.status, TerminalRunStatus::Running);
        assert!(reg.probe("T-ghost").is_none());
    }

    /// §5.4 backstop detector: whenever a create completes and the key now has
    /// two or more LIVE terminals, a `ws.reconcile.duplicate_pty` warn event
    /// makes the violation loud instead of a silent second JSONL writer.
    #[test]
    fn second_live_terminal_on_one_key_emits_duplicate_pty_warning() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        headless(&reg, "dup1", Some("cr-dup"), 1_000);
        {
            let captured = events.lock().unwrap();
            assert!(
                !captured
                    .iter()
                    .any(|e| e.message == "ws.reconcile.duplicate_pty"),
                "one live terminal must not trip the detector"
            );
        }
        headless(&reg, "dup2", Some("cr-dup"), 2_000);
        let captured = events.lock().unwrap();
        let warn = captured
            .iter()
            .find(|e| e.message == "ws.reconcile.duplicate_pty")
            .expect("two live PTYs on one createRequestId must emit the detector event");
        assert_eq!(
            warn.fields.get("create_request_id").map(String::as_str),
            Some("cr-dup")
        );
    }

    /// Council rule 6 support: the registry-row join (mode +
    /// resume_session_id + Running) finds the live terminal carrying a
    /// sessionRef — exited generations and other providers/sessions never
    /// match.
    #[test]
    fn live_terminal_for_session_ref_joins_rows_on_mode_and_resume_id() {
        let reg = TerminalRegistry::new();
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-ref".to_string(),
            stream_id: "S-ref".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("sess-r".to_string()),
            create_request_id: Some("cr-a".to_string()),
            created_at: Some(1_000),
        });
        let locator = SessionLocator {
            provider: "codex".to_string(),
            session_id: "sess-r".to_string(),
        };
        assert_eq!(
            reg.live_terminal_for_session_ref(&locator),
            Some("T-ref".to_string())
        );
        // Wrong provider / wrong session never match.
        assert!(reg
            .live_terminal_for_session_ref(&SessionLocator {
                provider: "claude".to_string(),
                session_id: "sess-r".to_string(),
            })
            .is_none());
        assert!(reg
            .live_terminal_for_session_ref(&SessionLocator {
                provider: "codex".to_string(),
                session_id: "other".to_string(),
            })
            .is_none());
        // An exited terminal is not a live carrier.
        reg.finish_pty_exit("T-ref", 0);
        assert!(reg.live_terminal_for_session_ref(&locator).is_none());
    }

    /// Council rule 9 (D8 backstop): >=2 live PTYs stamped with ONE
    /// sessionRef is the two-writers corruption shape — the alarm returns
    /// true and ERROR-logs `duplicate_pty_for_session_ref`; one live carrier
    /// returns false and stays silent.
    #[test]
    fn alarm_if_duplicate_session_ref_fires_only_on_two_live_carriers() {
        let (events, _guard) = tracing_capture::capture();
        let reg = TerminalRegistry::new();
        let stamped = |id: &str, created_at: i64| HeadlessTerminal {
            terminal_id: id.to_string(),
            stream_id: format!("S-{id}"),
            mode: "claude".to_string(),
            resume_session_id: Some("sess-dup".to_string()),
            create_request_id: None,
            created_at: Some(created_at),
        };
        let locator = SessionLocator {
            provider: "claude".to_string(),
            session_id: "sess-dup".to_string(),
        };

        reg.register_headless(stamped("dupA", 1_000));
        assert!(
            !reg.alarm_if_duplicate_session_ref(&locator),
            "one live carrier must not trip the alarm"
        );

        reg.register_headless(stamped("dupB", 2_000));
        assert!(reg.alarm_if_duplicate_session_ref(&locator));
        let captured = events.lock().unwrap();
        let alarm = captured
            .iter()
            .find(|e| e.message.contains("duplicate_pty_for_session_ref"))
            .expect(">=2 live PTYs on one sessionRef must emit the invariant alarm");
        assert_eq!(
            alarm.fields.get("session_id").map(String::as_str),
            Some("sess-dup")
        );
    }

    // ------------------------------------------------------------------
    // Council rule 7 (D8): sessionRef liveness-bound lease — claim /
    // complete / fail / conn-death release / TTL kill-before-release.
    // ------------------------------------------------------------------

    fn test_registry() -> TerminalRegistry {
        TerminalRegistry::new()
    }

    fn locator(provider: &str, session_id: &str) -> SessionLocator {
        SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn second_claim_while_held_is_reserved() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-A", 1, 1000),
            SessionRefClaim::Acquired
        ));
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 1500),
            SessionRefClaim::Held { .. }
        ));
    }

    #[test]
    fn completed_claim_yields_bound_elsewhere() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        assert!(reg.complete_session_ref_claim(&s, "cr-A", "term-1"));
        match reg.claim_session_ref(&s, "cr-B", 2, 2000) {
            SessionRefClaim::BoundElsewhere { terminal_id } => assert_eq!(terminal_id, "term-1"),
            other => panic!("expected BoundElsewhere, got {other:?}"),
        }
    }

    /// winner-dies-mid-claim (council red test): holder conn death releases the
    /// pid-less lease; the loser's next claim wins.
    #[test]
    fn winner_dies_mid_claim_releases_lease() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        let to_kill = reg.release_session_ref_leases_for_conn(1);
        assert!(to_kill.iter().all(|(_, pid)| pid.is_none()));
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 1500),
            SessionRefClaim::Acquired
        ));
    }

    /// winner-hangs-mid-claim (council red test): TTL expiry with a recorded
    /// child pid demands kill-before-release; confirmed kill releases; a pid-less
    /// hung holder is revoked and HELD CLOSED, never released.
    #[test]
    fn winner_hangs_mid_claim_ttl_is_kill_before_release() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        reg.set_session_ref_lease_pid(&s, "cr-A", 4242);
        let late = 1000 + SESSION_REF_LEASE_TTL_MS + 1;
        match reg.claim_session_ref(&s, "cr-B", 2, late) {
            SessionRefClaim::ExpiredNeedsKill { pid } => assert_eq!(pid, 4242),
            other => panic!("expected ExpiredNeedsKill, got {other:?}"),
        }
        reg.force_release_after_confirmed_kill(&s);
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, late + 1),
            SessionRefClaim::Acquired
        ));
    }

    #[test]
    fn hung_holder_without_pid_is_revoked_and_held_closed() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        reg.claim_session_ref(&s, "cr-A", 1, 1000);
        let late = 1000 + SESSION_REF_LEASE_TTL_MS + 1;
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, late),
            SessionRefClaim::Held { .. }
        ));
        // The revoked holder's late completion is rejected.
        assert!(!reg.complete_session_ref_claim(&s, "cr-A", "term-late"));
    }

    /// Fix round 1, finding 1: a KILLED winner must not strand the
    /// sessionRef. The kill path REMOVES the terminal row entirely
    /// ([`TerminalRegistry::kill_internal`]), so the binding's terminal id
    /// becomes UNKNOWN to the registry — the claim-time "known dead" probe
    /// can never fire. The binding must instead be pruned at row-removal
    /// time so the next claim wins, rather than answering
    /// `BoundElsewhere{dead-id}` forever.
    #[test]
    fn killed_winner_binding_is_pruned_so_next_claim_acquires() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-A", 1, 1000),
            SessionRefClaim::Acquired
        ));
        // The winner's spawn registers a real row carrying the ref, then binds.
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-win".to_string(),
            stream_id: "S-win".to_string(),
            mode: "claude".to_string(),
            resume_session_id: Some("s1".to_string()),
            create_request_id: Some("cr-A".to_string()),
            created_at: Some(1_000),
        });
        assert!(reg.complete_session_ref_claim(&s, "cr-A", "T-win"));
        // User kills the winner: the real kill path removes the row entirely.
        assert!(reg.kill("T-win"));
        // The dead winner must not strand losers.
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 2000),
            SessionRefClaim::Acquired
        ));
    }

    /// Final-review finding 1 (claim-side TOCTOU): loser B passes checks
    /// 1a/1b while both maps are still empty, is preempted across the
    /// winner's register -> `complete_session_ref_claim` window, then takes
    /// the leases lock AFTER complete removed the lease. Pre-fix the lease
    /// phase saw "no lease" and answered `Acquired` -> a second spawn for
    /// the same sessionRef (the duplicate-writer shape D8 exists to close).
    ///
    /// Staged sequentially, no threads: the winner claims, registers its
    /// row, and completes (binding recorded, lease gone); B then enters the
    /// lease phase DIRECTLY -- exactly the state B is in after its early
    /// (empty) 1a/1b pass. A full `claim_session_ref` call from B cannot
    /// pin the fix: while the binding exists, step 1b always intercepts it,
    /// so only direct entry exercises the under-lock bindings re-check.
    #[test]
    fn lease_phase_rechecks_bindings_under_leases_lock() {
        let reg = test_registry();
        let s = locator("claude", "s1");
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-A", 1, 1000),
            SessionRefClaim::Acquired
        ));
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-win".to_string(),
            stream_id: "S-win".to_string(),
            mode: "claude".to_string(),
            resume_session_id: Some("s1".to_string()),
            create_request_id: Some("cr-A".to_string()),
            created_at: Some(1_000),
        });
        assert!(reg.complete_session_ref_claim(&s, "cr-A", "T-win"));
        // B resumes at the lease phase; its 1a/1b ran before the winner
        // existed, so neither check fired. It must NOT acquire.
        match reg.claim_session_ref_lease_phase(&s, "cr-B", 2, 2000) {
            SessionRefClaim::BoundElsewhere { terminal_id } => {
                assert_eq!(terminal_id, "T-win")
            }
            other => panic!("expected BoundElsewhere, got {other:?}"),
        }
        // The full claim path agrees (step 1a/1b catch it sequentially).
        assert!(matches!(
            reg.claim_session_ref(&s, "cr-B", 2, 2000),
            SessionRefClaim::BoundElsewhere { .. }
        ));
    }

    /// §5.1 atomic-stamp insert-edge interleave (§9.1 test 5): the key is part
    /// of the row inserted under the registry lock, so an observer's
    /// `newest_live_by_create_request_id` sees either no row or the
    /// row-with-key — never a row that later gains its key.
    #[test]
    fn concurrent_inserts_never_expose_a_row_without_its_key() {
        let reg = TerminalRegistry::new();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let reader = {
            let reg = reg.clone();
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut observed = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    if let Some(id) = reg.newest_live_by_create_request_id("cr-race") {
                        assert!(
                            id == "race1" || id == "race2",
                            "by-key lookup must only ever see fully-stamped rows, got {id}"
                        );
                        observed.push(id);
                    }
                }
                observed
            })
        };

        let w1 = {
            let reg = reg.clone();
            std::thread::spawn(move || headless(&reg, "race1", Some("cr-race"), 1_000))
        };
        let w2 = {
            let reg = reg.clone();
            std::thread::spawn(move || headless(&reg, "race2", Some("cr-race"), 2_000))
        };
        w1.join().unwrap();
        w2.join().unwrap();
        stop.store(true, Ordering::Relaxed);
        reader.join().unwrap();

        // After both inserts, the newest generation (by created_at) wins.
        assert_eq!(
            reg.newest_live_by_create_request_id("cr-race"),
            Some("race2".to_string())
        );
    }

    // ------------------------------------------------------------------
    // Respawn-generation cap (design §7.5): a respawn ↔ instant-exit loop
    // must converge to a terminal dead_session verdict instead of thrashing.
    // ------------------------------------------------------------------

    #[test]
    fn respawn_cap_exhausts_after_n_short_lived_generations() {
        let reg = TerminalRegistry::new();
        reg.set_respawn_liveness_window_ms(10_000);
        reg.set_respawn_generation_cap(3);

        for gen in 1..=3 {
            let id = format!("cap-gen{gen}");
            // created_at = now → the exit below is inside the liveness window.
            headless(&reg, &id, Some("cr-cap"), now_ms());
            assert!(
                !reg.respawn_exhausted("cr-cap"),
                "cap must not fire before generation {gen} exits"
            );
            reg.finish_pty_exit(&id, 1);
        }
        assert!(
            reg.respawn_exhausted("cr-cap"),
            "3 short-lived generations must exhaust the cap"
        );
        // An unrelated key is unaffected.
        assert!(!reg.respawn_exhausted("cr-other"));
    }

    #[test]
    fn healthy_generation_resets_the_respawn_counter() {
        let reg = TerminalRegistry::new();
        reg.set_respawn_liveness_window_ms(10_000);
        reg.set_respawn_generation_cap(3);

        for gen in 1..=2 {
            let id = format!("reset-gen{gen}");
            headless(&reg, &id, Some("cr-reset"), now_ms());
            reg.finish_pty_exit(&id, 1);
        }
        // A generation that SURVIVED the liveness window (created long ago)
        // exits: the counter resets — a healthy resume is not penalized.
        headless(&reg, "reset-healthy", Some("cr-reset"), now_ms() - 60_000);
        reg.finish_pty_exit("reset-healthy", 0);
        assert!(!reg.respawn_exhausted("cr-reset"));

        // The next two short-lived exits count from zero again.
        for gen in 3..=4 {
            let id = format!("reset-gen{gen}");
            headless(&reg, &id, Some("cr-reset"), now_ms());
            reg.finish_pty_exit(&id, 1);
        }
        assert!(
            !reg.respawn_exhausted("cr-reset"),
            "only 2 short-lived generations since the healthy reset"
        );
    }

    /// §5.4 single-flight claim: the in-flight keyed-create reservation that
    /// closes the check-then-spawn window between two truly concurrent
    /// creates for one key (the spawn itself takes milliseconds; the row only
    /// becomes observable at insert).
    #[test]
    fn keyed_create_claim_is_exclusive_until_released() {
        let reg = TerminalRegistry::new();
        assert!(reg.begin_keyed_create("cr-claim"), "first claim wins");
        assert!(
            !reg.begin_keyed_create("cr-claim"),
            "a second concurrent create must NOT also claim the key"
        );
        assert!(
            reg.begin_keyed_create("cr-other"),
            "unrelated keys are free"
        );
        reg.end_keyed_create("cr-claim");
        assert!(
            reg.begin_keyed_create("cr-claim"),
            "a released key is claimable again"
        );
    }

    #[test]
    fn exits_without_a_create_request_id_never_count() {
        let reg = TerminalRegistry::new();
        reg.set_respawn_liveness_window_ms(10_000);
        reg.set_respawn_generation_cap(1);
        headless(&reg, "keyless", None, now_ms());
        reg.finish_pty_exit("keyless", 1);
        assert!(!reg.respawn_exhausted(""));
    }

    #[derive(Debug)]
    struct StubIdentity {
        provider: &'static str,
        session_id: &'static str,
        terminal_id: &'static str,
    }

    impl SessionIdentityLookup for StubIdentity {
        fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String> {
            (provider == self.provider && session_id == self.session_id)
                .then(|| self.terminal_id.to_string())
        }
    }

    #[test]
    fn live_session_owner_finds_running_row_by_resume_session_id() {
        let registry = TerminalRegistry::new();
        registry.register_headless(HeadlessTerminal {
            terminal_id: "t-row-owner".into(),
            stream_id: "s-row-owner".into(),
            mode: "claude".into(),
            resume_session_id: Some("sess-live".into()),
            create_request_id: None,
            created_at: None,
        });

        assert_eq!(
            registry.live_session_owner(None, "claude", "sess-live"),
            Some("t-row-owner".to_string()),
            "row arm: Running row with matching mode+resume_session_id is a live owner"
        );
        // Wrong mode / unknown session: no owner.
        assert_eq!(
            registry.live_session_owner(None, "codex", "sess-live"),
            None
        );
        assert_eq!(
            registry.live_session_owner(None, "claude", "sess-other"),
            None
        );

        registry.kill("t-row-owner");
    }

    #[test]
    fn live_session_owner_ignores_exited_rows() {
        let registry = TerminalRegistry::new();
        registry.register_headless(HeadlessTerminal {
            terminal_id: "t-exited".into(),
            stream_id: "s-exited".into(),
            mode: "claude".into(),
            resume_session_id: Some("sess-done".into()),
            create_request_id: None,
            created_at: None,
        });
        assert!(registry.finish_pty_exit("t-exited", 0));

        assert_eq!(
            registry.live_session_owner(None, "claude", "sess-done"),
            None,
            "an Exited owner must not block resume"
        );
    }

    #[test]
    fn live_session_owner_finds_identity_bound_running_terminal() {
        // Locator-adopted shape (d9b71f50's case): Running row with NO
        // resume_session_id; the session binding exists only in the identity store.
        let registry = TerminalRegistry::new();
        registry.register_headless(HeadlessTerminal {
            terminal_id: "t-adopted".into(),
            stream_id: "s-adopted".into(),
            mode: "codex".into(),
            resume_session_id: None,
            create_request_id: None,
            created_at: None,
        });
        let identity = StubIdentity {
            provider: "codex",
            session_id: "sess-adopted",
            terminal_id: "t-adopted",
        };

        assert_eq!(
            registry.live_session_owner(Some(&identity), "codex", "sess-adopted"),
            Some("t-adopted".to_string()),
            "identity arm: identity-bound session of a Running terminal is live"
        );

        registry.kill("t-adopted");
    }

    #[test]
    fn live_session_owner_identity_binding_to_dead_terminal_is_not_live() {
        let registry = TerminalRegistry::new();
        // No registry row at all for "t-gone" -- identity binding alone must not count.
        let identity = StubIdentity {
            provider: "codex",
            session_id: "sess-gone",
            terminal_id: "t-gone",
        };
        assert_eq!(
            registry.live_session_owner(Some(&identity), "codex", "sess-gone"),
            None,
            "identity arm requires the owner terminal to probe Running"
        );
    }

    // ------------------------------------------------------------------
    // Same-id double-resume guard (amplifier identity plan, F5/V7):
    // shared predicates over identity-probe rows.
    // ------------------------------------------------------------------

    /// Build an [`IdentityProbeRow`] with the given identity-relevant fields
    /// (remaining fields defaulted).
    fn probe_row(
        terminal_id: &str,
        mode: &str,
        status: TerminalRunStatus,
        resume_session_id: Option<&str>,
    ) -> IdentityProbeRow {
        IdentityProbeRow {
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            status,
            created_at: 0,
            resume_session_id: resume_session_id.map(str::to_string),
            cwd: None,
        }
    }

    #[test]
    fn has_live_resume_matches_only_running_same_mode_same_id() {
        let rows = vec![
            probe_row("t1", "amplifier", TerminalRunStatus::Running, Some("sid-1")),
            probe_row("t2", "amplifier", TerminalRunStatus::Exited, Some("sid-2")),
            probe_row("t3", "codex", TerminalRunStatus::Running, Some("sid-3")),
        ];
        assert!(has_live_resume(&rows, "amplifier", "sid-1"));
        assert!(!has_live_resume(&rows, "amplifier", "sid-2")); // exited
        assert!(!has_live_resume(&rows, "amplifier", "sid-3")); // other mode
        assert!(!has_live_resume(&rows, "amplifier", "sid-9")); // unknown
    }

    #[test]
    fn has_other_live_resume_excludes_the_named_terminal() {
        let rows = vec![probe_row(
            "t1",
            "amplifier",
            TerminalRunStatus::Running,
            Some("sid-1"),
        )];
        assert!(!has_other_live_resume(&rows, "amplifier", "sid-1", "t1")); // only me
        assert!(has_other_live_resume(&rows, "amplifier", "sid-1", "t9")); // someone else
    }

    /// A long-lived spawn spec (stays Running for the test's lifetime) —
    /// the same `/bin/sh -c 'sleep 30'` shape the DIAG-01 create tests use.
    fn sleeper_spawn_spec() -> SpawnSpec {
        SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        }
    }

    /// **RED (F5)**: two creates, same mode `"amplifier"`, same
    /// `resume_session_id`, first still Running ⇒ the second must return
    /// `ErrorKind::AlreadyExists` (the WS/REST handlers map this to the
    /// "session already open" reject).
    #[test]
    fn amplifier_create_with_duplicate_live_resume_returns_already_exists() {
        let registry = test_registry();
        let spec = sleeper_spawn_spec();
        let env = std::collections::BTreeMap::new();
        registry
            .create(
                &spec,
                &env,
                "T-amp-dup-a".into(),
                "S-amp-dup-a".into(),
                "amplifier",
                Some("sid-dup"),
                Some("req-a"),
                None,
                None,
            )
            .expect("first create succeeds");
        let err = registry
            .create(
                &spec,
                &env,
                "T-amp-dup-b".into(),
                "S-amp-dup-b".into(),
                "amplifier",
                Some("sid-dup"),
                Some("req-b"),
                None,
                None,
            )
            .expect_err("second live resume of the same amplifier session must fail");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        registry.kill("T-amp-dup-a");
    }

    /// Release-on-success: once the first live resume is GONE (killed —
    /// kill removes the row), a new create with the same session id must
    /// succeed, proving the successful create released its reservation.
    #[test]
    fn amplifier_resume_reservation_is_released_after_successful_create() {
        let registry = test_registry();
        let spec = sleeper_spawn_spec();
        let env = std::collections::BTreeMap::new();
        registry
            .create(
                &spec,
                &env,
                "T-amp-rel-a".into(),
                "S-amp-rel-a".into(),
                "amplifier",
                Some("sid-rel"),
                Some("req-rel-a"),
                None,
                None,
            )
            .expect("first create succeeds");
        registry.kill("T-amp-rel-a");
        registry
            .create(
                &spec,
                &env,
                "T-amp-rel-b".into(),
                "S-amp-rel-b".into(),
                "amplifier",
                Some("sid-rel"),
                Some("req-rel-b"),
                None,
                None,
            )
            .expect("re-resume after the first terminal died must succeed");
        registry.kill("T-amp-rel-b");
    }

    /// Release-on-failure: a spawn failure (bad program) must release the
    /// reservation, so a subsequent valid create with the same session id
    /// succeeds instead of being wedged behind a leaked claim.
    #[test]
    fn amplifier_resume_reservation_is_released_after_spawn_failure() {
        let registry = test_registry();
        let env = std::collections::BTreeMap::new();
        let bad_spec = SpawnSpec {
            program: "/nonexistent/definitely-not-a-program".into(),
            args: vec![],
            env_overrides: std::collections::BTreeMap::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        };
        let err = registry
            .create(
                &bad_spec,
                &env,
                "T-amp-fail-a".into(),
                "S-amp-fail-a".into(),
                "amplifier",
                Some("sid-fail"),
                Some("req-fail-a"),
                None,
                None,
            )
            .expect_err("spawn of a nonexistent program must fail");
        assert_ne!(
            err.kind(),
            std::io::ErrorKind::AlreadyExists,
            "a spawn failure is not the duplicate-resume signal"
        );
        registry
            .create(
                &sleeper_spawn_spec(),
                &env,
                "T-amp-fail-b".into(),
                "S-amp-fail-b".into(),
                "amplifier",
                Some("sid-fail"),
                Some("req-fail-b"),
                None,
                None,
            )
            .expect("valid create after a failed spawn must succeed (reservation released)");
        registry.kill("T-amp-fail-b");
    }
}

//! TERM-15/TERM-16 activity hub: the async wiring around the pure
//! `freshell-activity` state machines.
//!
//! One hub per server process. It:
//!
//! * consumes the [`freshell_terminal::ActivityEvent`] registry tap
//!   (Created/Input/Output/Exit) via an unbounded channel — the tap callback
//!   never blocks a PTY reader thread;
//! * routes events by terminal mode into the claude / codex / amplifier
//!   trackers (gemini/kimi and every other mode stay status-inert — TERM-16);
//! * broadcasts `*.activity.updated`, `terminal.turn.complete`, and the NEW
//!   `terminal.idle` frames on the shared server→client bus;
//! * answers `*.activity.list` requests from live tracker state (reconnect
//!   seeding — the completions carry per-terminal `completionSeq`, which is
//!   what makes the client's dedupe-across-reconnect work);
//! * owns the amplifier events.jsonl lanes: one inotify watcher + offset
//!   tailer per associated terminal, attached at `Start` for a fresh
//!   association (replays the young file's history, which is exactly the
//!   `prompt:submit` that confirms the provisional busy) or `Eof` for a
//!   resume.
//!
//! ## Zero-polling guarantee
//!
//! The hub task sleeps on (a) the event channel and (b) at most ONE one-shot
//! deadline — the min of every tracker's `next_deadline()` and the idle
//! gate's. With no busy/pending terminal and no pending idle window there is
//! NO armed timer and the task wakes only for real events. File reads happen
//! only on inotify change events or the amplifier deadman's force-read
//! failsafe; [`ActivityHubStats`] counts every tail read + timer wake so
//! tests can assert steady-state silence.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use freshell_activity::amplifier::tailer::{AttachAt, TailerDegradeReason, TailerReadOutcome};
use freshell_activity::amplifier::{
    create_reducer_state, reduce_amplifier_event, AmplifierActivityTracker, AmplifierEventsTailer,
    ReducerEffect, ReducerState,
};
use freshell_activity::claude::ClaudeActivityTracker;
use freshell_activity::codex::CodexActivityTracker;
use freshell_activity::idle::{IdleGate, IdleGatePhase};
use freshell_activity::opencode::{OpencodeActivityTracker, OpencodeStatus};
use freshell_activity::TrackerEffect;
use freshell_protocol::{
    AgentProvider, AmplifierActivityRecord, AmplifierActivityUpdated, ClaudeActivityRecord,
    ClaudeActivityUpdated, CodexActivityRecord, CodexActivityUpdated, OpencodeActivityRecord,
    OpencodeActivityUpdated, ServerMessage, TerminalIdle, TerminalIdleReason, TerminalTurnComplete,
    TurnCompletionSnapshot,
};
use freshell_terminal::ActivityEvent;

use crate::terminal::now_ms;

/// Resolves an amplifier session id to its `events.jsonl` path (used for
/// resume-created terminals, whose session dir already exists). Supplied by
/// `freshell-server` from the amplifier home; `None` when unresolvable.
pub type AmplifierEventsPathResolver = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// G8 parity with the frozen TS reference
/// (server/coding-cli/amplifier-activity-integration.ts:50): never replay an
/// events backlog larger than this at Start-attach — attach at Eof instead
/// and let live records take over.
pub(crate) const AMPLIFIER_CATCHUP_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Decide the effective attach point for an events lane. `file_len` is `None`
/// when the events file could not be stat'ed (fresh sessions create
/// events.jsonl lazily) — that must NOT count as over-cap.
pub(crate) fn effective_attach_at(requested: AttachAt, file_len: Option<u64>) -> AttachAt {
    match (requested, file_len) {
        (AttachAt::Start, Some(len)) if len > AMPLIFIER_CATCHUP_MAX_BYTES => AttachAt::Eof,
        (requested, _) => requested,
    }
}

/// G4: bounded re-attach backoff schedule for a degraded events lane.
/// Index = failures-1; after the last entry the cap repeats forever; the
/// first past-schedule failure rings crash semantics (#605).
/// Shape mirrors the repo's bounded-retry exemplar
/// (crates/freshell-tauri/src/renderer_recovery.rs:44).
pub(crate) const AMPLIFIER_LANE_RETRY_DELAYS_MS: [i64; 3] = [250, 1000, 3000];

/// #605: past the bounded schedule the lane retries FOREVER at this cap —
/// a degraded events lane is never abandoned (the crash-semantics bell at
/// schedule exhaustion is the loud signal; recovery stays possible).
pub(crate) const AMPLIFIER_LANE_RETRY_CAP_MS: i64 = 3_000;

/// Backoff delay before the retry that follows the `failures`-th
/// consecutive failure (1-based). Never gives up: past the schedule the
/// cap repeats.
pub(crate) fn lane_retry_delay_ms(failures: u32) -> i64 {
    failures
        .checked_sub(1)
        .and_then(|i| AMPLIFIER_LANE_RETRY_DELAYS_MS.get(i as usize).copied())
        .unwrap_or(AMPLIFIER_LANE_RETRY_CAP_MS)
}

/// #612: how long an observed quit-intent input suppresses the death bell.
/// Covers slow TUI shutdowns (including opencode's 5s dispose cap) while a
/// "much later" real crash still rings.
pub(crate) const QUIT_INTENT_TTL_MS: i64 = 15_000;

/// #612: is a quit-intent marker still live at exit time? Marker rules:
/// set (overwrite) at each quit-intent input; cleared by a later
/// NonQuitSubmit; expired `QUIT_INTENT_TTL_MS` after it was set.
pub(crate) fn quit_intent_active(marker_at: Option<i64>, exit_at: i64) -> bool {
    marker_at.is_some_and(|t| exit_at - t <= QUIT_INTENT_TTL_MS)
}

/// G9: resolve a resumed codex terminal's session id to its rollout file
/// (ownership-proof walk of the codex sessions root). `None` -> the terminal
/// runs the PTY-only lane, same degradation as the amplifier resolver.
pub type CodexRolloutLocator = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// Diagnostics counters backing the zero-polling tests.
#[derive(Debug, Default)]
pub struct ActivityHubStats {
    /// Times the hub task woke because its one-shot deadline fired.
    pub timer_wakes: AtomicU64,
    /// Incremental tail reads of amplifier events files (change events +
    /// force-reads + attach).
    pub tail_reads: AtomicU64,
}

enum HubEvent {
    Registry(ActivityEvent),
    /// Attach an amplifier events lane (fresh association or resume).
    AmplifierAttach {
        terminal_id: String,
        session_id: String,
        events_path: PathBuf,
        attach_at: AttachAt,
    },
    /// The inotify watcher saw a change on a lane's events file.
    AmplifierFsChange {
        terminal_id: String,
    },
    /// Bind a codex terminal's adopted session identity (hub-task emission).
    CodexBind {
        terminal_id: String,
        session_id: String,
    },
    /// Attach a codex rollout-reconcile lane (resume-created terminal).
    /// Channel-deferred like `AmplifierAttach` so the Created arm's own
    /// frames are emitted before the lane's seeding frames.
    CodexAttach {
        terminal_id: String,
        session_id: String,
        rollout_path: PathBuf,
    },
    /// Rollout file changed on disk -- drain on the hub task (mirror of
    /// `AmplifierFsChange`; the notify thread NEVER drains or emits itself,
    /// preserving the single-emitter frame-ordering invariant).
    CodexFsChange {
        terminal_id: String,
    },
    /// S5.a + kata codex-turn-thread-scope: a proxy TurnStarted/TurnCompleted
    /// for a managed codex terminal, carrying the EMITTING thread's identity
    /// (which may be a sub-agent/review/fork thread, not the bound one) and,
    /// for completions, the raw turn status. The tracker owns the guards.
    CodexProxyTurn {
        terminal_id: String,
        thread_id: String,
        turn_id: Option<String>,
        status: Option<String>,
        completed: bool,
    },
    /// Task 7: a sniffed server→client approval request (`requested: true`)
    /// or its resolution (`requested: false`) for a managed codex terminal.
    /// Requests may carry the emitting thread's id (the tracker's thread
    /// guard drops sub-agent approvals); resolves never do.
    CodexApproval {
        terminal_id: String,
        thread_id: Option<String>,
        request_id: String,
        requested: bool,
    },
    /// Task 8: bind an opencode terminal's adopted session identity
    /// (hub-task emission, mirror of `CodexBind`; Task 10 wires the
    /// producers).
    OpencodeBind {
        terminal_id: String,
        session_id: String,
    },
    /// Task 8: one generation-stamped opencode SSE-lane event (Task 9's
    /// lane is the producer; hub-level tests inject directly).
    /// `generation` is the hub-issued attach generation the ingress guard
    /// matches against `opencode_lanes`; `cycle`/`stream` guard intra-lane
    /// reconnect staleness inside the tracker.
    OpencodeLane {
        terminal_id: String,
        generation: u64,
        cycle: u64,
        stream: u64,
        event: OpencodeLaneEvent,
    },
    /// Task 9: attach (or re-attach) a terminal's opencode SSE lane.
    /// Channel-deferred so the hub task issues the attach generation and
    /// swaps the lane registry entry serially with Exit (A6).
    OpencodeAttach {
        terminal_id: String,
        base_url: String,
    },
    /// A requested stop of the terminal's unit began (Stage 2: LB-37): from
    /// now until its exit the terminal produces no idle, turn-complete or
    /// death-bell edge.
    StopRequested {
        terminal_id: String,
    },
}

/// The opencode SSE lane's event vocabulary ([`crate::opencode_lane`]
/// produces these from the per-pane sidecar's `/event` stream +
/// `/session/status` snapshots; the hub routes them into the pure
/// `OpencodeActivityTracker`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OpencodeLaneEvent {
    /// `/session/status` snapshot (absence == idle).
    Snapshot {
        statuses: Vec<(String, OpencodeStatus)>,
    },
    /// `session.created` — folds the parentID chain into the root map.
    SessionCreated {
        session_id: String,
        parent_id: Option<String>,
    },
    /// `session.status` edge (busy | retry | idle).
    Status {
        session_id: String,
        status: OpencodeStatus,
    },
    /// `session.idle` — the deprecated twin of `session.status{idle}`.
    SessionIdle { session_id: String },
    /// `session.error` (and Task 9's abort-marked `message.updated`,
    /// translated into this same shape).
    SessionError {
        session_id: String,
        error_name: String,
    },
    /// `permission.asked` — the turn pauses on a human.
    PermissionAsked {
        session_id: String,
        permission_id: String,
    },
    /// `permission.replied` — the pause ends.
    PermissionReplied { permission_id: String },
    /// The verify/connect `/session/status` probe failed in a way that
    /// must NOT read as idle (#603/#604). The hub applies crash semantics
    /// via [`OpencodeActivityTracker::note_verify_failed`].
    SnapshotFailed { error: String },
    /// #608: the authoritative pending-ask listing fetched from GET
    /// /permission + GET /question (noted only when BOTH succeeded). The
    /// hub drains any locally-pending id not listed — see
    /// OpencodeActivityTracker::note_permissions_synced.
    PermissionsSynced { pending_ids: Vec<String> },
}

struct AmplifierLane {
    tailer: AmplifierEventsTailer,
    reducer_state: ReducerState,
    /// Retained so a degrade can schedule a bounded re-attach (G4).
    session_id: String,
    events_path: PathBuf,
    /// Keeps the inotify watcher alive for the lane's lifetime.
    _watcher: notify::RecommendedWatcher,
}

/// G4: bookkeeping for a degraded amplifier events lane awaiting bounded
/// re-attach. Lives on `HubInner` (the lane itself is dropped on degrade).
#[derive(Debug, Clone)]
struct LaneRetry {
    session_id: String,
    events_path: PathBuf,
    /// Consecutive failures (degrades + failed re-attaches) since the last
    /// successful read. Reset by an `Ok` read, not by a successful attach.
    failures: u32,
    /// When the next re-attach fires. `None` while an attempt is in flight or
    /// has landed and awaits its first `Ok` read — arms no timer.
    next_attempt_at: Option<i64>,
    /// #605 gap-loss rule: the events file length captured at the FIRST
    /// failure of this degrade episode (`None` when the stat failed —
    /// e.g. the file was already gone). At re-attach time a differing
    /// length means records landed while we were blind: the in-flight
    /// turn is unverifiable and crash semantics apply before the Eof
    /// attach.
    bytes_at_degrade: Option<u64>,
}

/// G9: one rollout-reconcile lane per bound codex terminal (narrowed port of
/// the legacy whole-library `reconcileProjects` -- deviations documented in
/// `freshell-activity/src/codex.rs`).
struct CodexLane {
    tailer: crate::codex_reconcile::RolloutTailer,
    /// Keeps the inotify watcher alive for the lane's lifetime.
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
struct HubInner {
    claude: ClaudeActivityTracker,
    codex: CodexActivityTracker,
    amplifier: AmplifierActivityTracker,
    opencode: OpencodeActivityTracker,
    idle: IdleGate,
    /// terminal id → mode, for every tracked CLI terminal.
    modes: HashMap<String, String>,
    lanes: HashMap<String, AmplifierLane>,
    /// G4: terminal id → pending bounded re-attach bookkeeping.
    lane_retries: HashMap<String, LaneRetry>,
    codex_lanes: HashMap<String, CodexLane>,
    codex_rollout_locator: Option<CodexRolloutLocator>,
    /// Task 8/9: terminal id → (hub-issued attach generation, lane task,
    /// verify-request sender — #603: `expire_due` asks the lane to
    /// re-fetch `/session/status` through it). The `OpencodeLane` ingress
    /// guard drops any event whose stamped generation doesn't match the
    /// CURRENT entry; Exit removes the entry so post-exit stragglers fail
    /// the match too. The `OpencodeAttach` arm populates this for real;
    /// hub-level tests insert dummies.
    opencode_lanes: HashMap<
        String,
        (
            u64,
            tokio::task::JoinHandle<()>,
            tokio::sync::mpsc::UnboundedSender<()>,
        ),
    >,
    /// Task 9: monotonic attach-generation counter — bumped on EVERY
    /// `OpencodeAttach` (A6), so events from a replaced lane can never
    /// impersonate its successor.
    opencode_lane_next_generation: u64,
    /// Task 9: the SSE lane's injected IO seams. `None` until installed
    /// (Task 10 wires the reqwest impls at boot); attach without deps only
    /// retires old lanes.
    opencode_lane_deps: Option<Arc<crate::opencode_lane::OpencodeLaneDeps>>,
    /// #606: the claude session-JSONL truth source answering deadman
    /// verifies. `None` until installed at boot (`FsClaudeTruth`) or by
    /// tests (fakes) — no truth source = probe failure = crash semantics
    /// (owner ruling).
    claude_truth: Option<Arc<dyn crate::claude_truth::ClaudeTruth>>,
    /// #611: terminal id → `(session_id, transcript byte offset)` stashed
    /// at submit time; consumed by the confirm probe ONLY when the
    /// currently-bound session id equals the stashed one (else the probe
    /// is Unavailable — deadman backstop). Session-scoping is
    /// load-bearing: A7's resume/fork mints a new file, and Task 10's
    /// rebinds re-point the tracker mid-flight.
    claude_submit_offsets: HashMap<String, (String, u64)>,
    /// #612: terminal id → per-terminal quit-intent line-buffer state
    /// (bracketed-paste framing + escape accumulator survive chunk
    /// boundaries; see `signal::classify_input` for the exact rules).
    quit_intent_lines: HashMap<String, freshell_activity::signal::QuitIntentState>,
    /// #612: terminal id → timestamp of the last observed quit-intent
    /// input. Set (overwritten) on QuitIntent, cleared on NonQuitSubmit,
    /// consulted (with the TTL) by the Exit arm's ring predicate.
    quit_intents: HashMap<String, i64>,
    /// Test-only send-side recorder of `note_opencode_lane_event` calls:
    /// (generation, cycle, stream, event), in call order. The stamps are
    /// not wire-visible, so lane tests pin them here.
    #[cfg(test)]
    lane_ingress_log: Vec<(u64, u64, u64, OpencodeLaneEvent)>,
}

/// Cloneable handle to the hub (stored on `WsState`).
#[derive(Clone)]
pub struct ActivityHub {
    inner: Arc<Mutex<HubInner>>,
    tx: tokio::sync::mpsc::UnboundedSender<HubEvent>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    stats: Arc<ActivityHubStats>,
    resolver: Option<AmplifierEventsPathResolver>,
}

impl ActivityHub {
    /// Construct the hub and spawn its task. Requires a tokio runtime.
    pub fn new(
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
        resolver: Option<AmplifierEventsPathResolver>,
    ) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let hub = Self {
            inner: Arc::new(Mutex::new(HubInner::default())),
            tx,
            broadcast_tx,
            stats: Arc::new(ActivityHubStats::default()),
            resolver,
        };
        hub.spawn_task(rx);
        hub
    }

    pub fn stats(&self) -> &ActivityHubStats {
        &self.stats
    }

    /// The registry tap callback ([`freshell_terminal::TerminalRegistry::set_activity_observer`]).
    pub fn registry_observer(&self) -> freshell_terminal::ActivityObserver {
        let tx = self.tx.clone();
        Arc::new(move |event| {
            let _ = tx.send(HubEvent::Registry(event));
        })
    }

    /// Test-only model of the create-time events-lane attach: enqueues the
    /// same `HubEvent::AmplifierAttach` (with `AttachAt::Start`) the
    /// production `ActivityEvent::Created` resolver arm enqueues for an
    /// amplifier terminal whose `events.jsonl` already exists. Its production
    /// caller was the deleted post-spawn amplifier association (kata qmpk —
    /// identity is launcher-assigned at create time now); the unit tests
    /// below keep using it to pin real lane behavior. `Start` replays the
    /// young file from byte 0 — the recorded `prompt:submit` is what
    /// confirms the tracker's provisional busy.
    #[cfg(test)]
    pub fn attach_amplifier_association(
        &self,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
    ) {
        let _ = self.tx.send(HubEvent::AmplifierAttach {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            events_path: events_path.to_path_buf(),
            attach_at: AttachAt::Start,
        });
    }

    /// G3: bind a codex terminal's session identity into the activity
    /// tracker (candidate adoption / rollout-reconcile lane). Idempotent;
    /// silent no-op for untracked terminals. Channel-deferred (mirror of
    /// `attach_amplifier_association`) so the resulting
    /// `codex.activity.updated` identity upsert is emitted on the hub task,
    /// preserving the single-emitter frame-ordering invariant; subsequent
    /// `terminal.turn.complete` frames then carry `sessionId`.
    pub fn bind_codex_session(&self, terminal_id: &str, session_id: &str) {
        let _ = self.tx.send(HubEvent::CodexBind {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
        });
    }

    /// S5.a: proxy (managed-launch) turn lane -- channel-deferred like
    /// `bind_codex_session` so all frame emission stays on the hub task.
    /// `status` is only meaningful for completions (`turn/completed` carries
    /// 'completed' | 'interrupted' | 'failed' | 'inProgress'); pass `None`
    /// for starts.
    pub fn note_codex_proxy_turn(
        &self,
        terminal_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        status: Option<&str>,
        completed: bool,
    ) {
        let _ = self.tx.send(HubEvent::CodexProxyTurn {
            terminal_id: terminal_id.to_string(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.map(str::to_string),
            status: status.map(str::to_string),
            completed,
        });
    }

    /// A requested stop of the terminal's unit began (Stage 2: LB-37; the
    /// unit lifecycle calls this for every stop except an agent exit):
    /// channel-deferred like `note_codex_proxy_turn`, so it is ordered after
    /// every event already queued. The terminal's armed grace window is
    /// dropped, and until its exit no `terminal.idle`, no
    /// `terminal.turn.complete` and no death bell is produced for it. A crash
    /// never comes through here and still rings at its exit.
    pub fn note_stop_requested(&self, terminal_id: &str) {
        let _ = self.tx.send(HubEvent::StopRequested {
            terminal_id: terminal_id.to_string(),
        });
    }

    /// Task 7: proxy (managed-launch) approval lane -- channel-deferred like
    /// `note_codex_proxy_turn` so all frame emission stays on the hub task.
    /// `requested: true` is a sniffed server→client approval request;
    /// `false` is its resolution. `thread_id` is best-effort and only
    /// present on requests.
    pub fn note_codex_approval(
        &self,
        terminal_id: &str,
        thread_id: Option<&str>,
        request_id: &str,
        requested: bool,
    ) {
        let _ = self.tx.send(HubEvent::CodexApproval {
            terminal_id: terminal_id.to_string(),
            thread_id: thread_id.map(str::to_string),
            request_id: request_id.to_string(),
            requested,
        });
    }

    /// Task 8: bind an opencode terminal's session identity into the
    /// activity tracker (SQLite locator / TUI rebind plugin — Task 10
    /// wires the producers). Channel-deferred (mirror of
    /// `bind_codex_session`) so all frame emission stays on the hub task.
    pub fn bind_opencode_session(&self, terminal_id: &str, session_id: &str) {
        let _ = self.tx.send(HubEvent::OpencodeBind {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
        });
    }

    /// Task 8: generation-stamped SSE-lane ingress (Task 9's lane is the
    /// caller). Channel-deferred like every other producer — the
    /// single-emitter frame-ordering invariant.
    pub(crate) fn note_opencode_lane_event(
        &self,
        terminal_id: &str,
        generation: u64,
        cycle: u64,
        stream: u64,
        event: OpencodeLaneEvent,
    ) {
        // Test-only send-side recorder: generation/cycle/stream stamps are
        // not wire-visible (frames carry neither), so lane tests pin them
        // here — BEFORE the ingress guard, recording what the lane produced.
        #[cfg(test)]
        self.inner
            .lock()
            .expect("activity hub lock")
            .lane_ingress_log
            .push((generation, cycle, stream, event.clone()));
        let _ = self.tx.send(HubEvent::OpencodeLane {
            terminal_id: terminal_id.to_string(),
            generation,
            cycle,
            stream,
            event,
        });
    }

    /// Task 9: install the SSE lane's injected IO seams (reqwest impls in
    /// production, wired by `freshell-server` at boot — Task 10; fakes in
    /// tests). Option'd — hub tests that never attach leave it unset, and
    /// `OpencodeAttach` then only retires old lanes.
    pub fn set_opencode_lane_deps(&self, deps: Arc<crate::opencode_lane::OpencodeLaneDeps>) {
        let mut inner = self.inner.lock().expect("activity hub lock");
        inner.opencode_lane_deps = Some(deps);
    }

    /// Task 9: attach (or re-attach) the per-terminal opencode SSE lane.
    /// Channel-deferred (mirror of `attach_codex_rollout`) so the hub task
    /// issues the attach generation and swaps the registry entry serially
    /// with Exit — the single-emitter frame-ordering invariant.
    pub fn attach_opencode_serve(&self, terminal_id: &str, hostname: &str, port: u16) {
        let _ = self.tx.send(HubEvent::OpencodeAttach {
            terminal_id: terminal_id.to_string(),
            base_url: format!("http://{hostname}:{port}"),
        });
    }

    /// Test-only view of the send-side lane ingress recorder.
    #[cfg(test)]
    pub(crate) fn lane_ingress_log(&self) -> Vec<(u64, u64, u64, OpencodeLaneEvent)> {
        self.inner
            .lock()
            .expect("activity hub lock")
            .lane_ingress_log
            .clone()
    }

    /// Test-only view of the lane registry size.
    #[cfg(test)]
    pub(crate) fn opencode_lane_count(&self) -> usize {
        self.inner
            .lock()
            .expect("activity hub lock")
            .opencode_lanes
            .len()
    }

    /// Test-only view of a terminal's current attach generation.
    #[cfg(test)]
    pub(crate) fn opencode_lane_generation(&self, terminal_id: &str) -> Option<u64> {
        self.inner
            .lock()
            .expect("activity hub lock")
            .opencode_lanes
            .get(terminal_id)
            .map(|(generation, _, _)| *generation)
    }

    /// Hub-level episode tests register a dummy `opencode_lanes` entry so
    /// their injected lane events pass the generation guard without going
    /// through `OpencodeAttach`; `opencode_lane` tests use it to admit a
    /// directly-spawned lane's stamped generation.
    #[cfg(test)]
    pub(crate) fn register_opencode_lane_for_tests(&self, terminal_id: &str, generation: u64) {
        let mut inner = self.inner.lock().expect("activity hub lock");
        // Dummy verify channel: episode tests never service verify
        // requests (the receiver is dropped, sends fail silently).
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        inner.opencode_lanes.insert(
            terminal_id.to_string(),
            (generation, tokio::spawn(async {}), tx),
        );
    }

    /// Test-scale hook: shrink the opencode busy-deadman window. Call
    /// BEFORE driving any busy event — the hub scheduler recomputes its
    /// one-shot deadline only on a HubEvent or timer fire, so a shrink
    /// after the busy edge leaves the production window armed.
    #[cfg(test)]
    pub(crate) fn set_opencode_busy_deadman_for_tests(&self, ms: i64) {
        self.inner
            .lock()
            .expect("activity hub lock")
            .opencode
            .set_busy_deadman_ms(ms);
    }

    /// #606: install the claude session-JSONL truth source (production:
    /// `FsClaudeTruth::from_env()` at boot, next to the opencode lane
    /// deps; tests inject fakes). Unset = every deadman verify fails =
    /// crash semantics.
    pub fn set_claude_truth(&self, truth: std::sync::Arc<dyn crate::claude_truth::ClaudeTruth>) {
        self.inner.lock().expect("activity hub lock").claude_truth = Some(truth);
    }

    /// Test-scale hook: shrink the claude busy-deadman window. Call
    /// BEFORE driving any busy event (same ordering rule as
    /// `set_opencode_busy_deadman_for_tests`).
    #[cfg(test)]
    pub(crate) fn set_claude_busy_deadman_for_tests(&self, ms: i64) {
        self.inner
            .lock()
            .expect("activity hub lock")
            .claude
            .set_busy_deadman_ms(ms);
    }

    /// Test-only view of the claude tracker's bound session id.
    #[cfg(test)]
    pub(crate) fn claude_session_id_for_tests(&self, terminal_id: &str) -> Option<String> {
        self.inner
            .lock()
            .expect("activity hub lock")
            .claude
            .session_id_of(terminal_id)
    }

    /// #606/#611: bind the claude tracker to the pane's CURRENT session.
    /// This is the producer that was missing: the SessionStart rebind
    /// path updated identity/registry/ledger but never the activity
    /// tracker, so after an in-TUI /resume or /clear the deadman verify
    /// and submit probes read the OLD session's JSONL (and resume/fork
    /// mints a NEW <session-id>.jsonl, so "old" also means "no longer
    /// written"). Called from apply_claude_signal's rebind tail.
    pub fn bind_claude_session(&self, terminal_id: &str, session_id: &str) {
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let effects = inner.claude.bind_session(terminal_id, session_id);
            // ForceRead only arises from expire()
            let (frames, _) = claude_frames(&mut inner.idle, effects);
            frames
        };
        self.emit(frames);
    }

    /// Install the resume-time rollout locator (called once from
    /// `freshell-server` at boot; tests inject tempdir-backed closures).
    pub fn set_codex_rollout_locator(&self, locator: CodexRolloutLocator) {
        let mut inner = self.inner.lock().expect("activity hub lock");
        inner.codex_rollout_locator = Some(locator);
    }

    /// G9: attach the rollout-reconcile lane for a bound codex terminal.
    /// Channel-deferred like `attach_amplifier_association` (:147-159): the
    /// caller (WS dispatch / candidate adopt / spawn_blocking locator) only
    /// enqueues -- the tailer attach (file I/O), watcher registration, and
    /// ALL frame emission run on the single hub task, preserving the
    /// one-emitter frame-ordering invariant.
    pub fn attach_codex_rollout(&self, terminal_id: &str, session_id: &str, rollout_path: &Path) {
        let _ = self.tx.send(HubEvent::CodexAttach {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            rollout_path: rollout_path.to_path_buf(),
        });
    }

    /// Hub-task worker for `HubEvent::CodexAttach` (mirror of `attach_lane`).
    /// Binds identity (idempotent), tails the rollout (bounded initial read),
    /// watches it via inotify, and runs the initial drain -- which performs
    /// resume-busy seeding when the rollout shows an unresolved turn.
    fn attach_codex_lane(&self, terminal_id: &str, session_id: &str, rollout_path: &Path) {
        use notify::Watcher;
        // Deferred-attach guard: the resume-path locator runs on a blocking
        // thread (35ms warm, seconds cold). A terminal that exits inside that
        // window has its Exit processed FIRST (the Exit arm removes it from
        // `modes` and `codex_lanes`); installing a lane afterwards would leak
        // an inotify watcher that nothing ever removes. Check before building
        // the tailer/watcher (cheapest exit) -- safe against interleaving
        // because Exit and CodexAttach are both processed serially on the
        // single hub task.
        {
            let inner = self.inner.lock().expect("activity hub lock");
            if inner.modes.get(terminal_id).map(String::as_str) != Some("codex") {
                tracing::debug!(
                    terminal_id = %terminal_id,
                    rollout = %rollout_path.display(),
                    "codex rollout attach skipped: terminal no longer tracked"
                );
                return;
            }
        }
        let mut tailer = crate::codex_reconcile::RolloutTailer::new(rollout_path);
        if let Err(err) = tailer.attach() {
            tracing::warn!(
                terminal_id = %terminal_id,
                rollout = %rollout_path.display(),
                error = %err,
                "codex rollout lane attach failed; PTY-only lane continues"
            );
            return;
        }
        // Watcher: mirror the amplifier watcher EXACTLY. The closure
        // captures only the hub-event sender + terminal id (never a hub
        // clone: that would put an Arc cycle inside HubInner and let the
        // notify thread emit frames out of order with the hub task). The
        // event filter is the SHARED `fs_event_is_relevant` (same fn as the
        // amplifier lane): data-mutation kinds only, plus the Rescan
        // miss-recovery override -- see its doc comment (kata namg).
        let tx = self.tx.clone();
        let watched_terminal = terminal_id.to_string();
        let mut watcher =
            match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                let Ok(event) = res else { return };
                if fs_event_is_relevant(&event) {
                    let _ = tx.send(HubEvent::CodexFsChange {
                        terminal_id: watched_terminal.clone(),
                    });
                }
            }) {
                Ok(w) => w,
                Err(err) => {
                    tracing::warn!(error = %err, "codex rollout watcher construction failed");
                    return;
                }
            };
        if let Err(err) = watcher.watch(rollout_path, notify::RecursiveMode::NonRecursive) {
            tracing::warn!(
                rollout = %rollout_path.display(),
                error = %err,
                "codex rollout watch failed; PTY-only lane continues"
            );
            return;
        }

        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let bind = inner.codex.bind_session(terminal_id, session_id);
            let (frames, _force_reads) = codex_frames(&mut inner.idle, bind);
            // Re-attach REPLACES the lane: a mid-session fork moves the pane to a
            // NEW rollout file; keeping the old tailer would keep busy/turn
            // signals keyed to the abandoned parent file (stale-tailer defect,
            // plan 2026-07-28-stale-resume-identity.md).
            inner.codex_lanes.insert(
                terminal_id.to_string(),
                CodexLane {
                    tailer,
                    _watcher: watcher,
                },
            );
            frames
        };
        self.emit(frames);
        // Initial drain: resume-busy seeding for a rollout already mid-turn.
        self.drain_codex_lane(terminal_id);
    }

    /// Read new rollout lines and reconcile them into the codex tracker.
    fn drain_codex_lane(&self, terminal_id: &str) {
        self.stats.tail_reads.fetch_add(1, Ordering::SeqCst);
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let Some(lane) = inner.codex_lanes.get_mut(terminal_id) else {
                return;
            };
            let lines = lane.tailer.read_new_lines();
            if lines.is_empty() {
                return;
            }
            let events = crate::codex_reconcile::fold_task_events(&lines);
            if events.is_empty() {
                return;
            }
            let now = crate::terminal::now_ms();
            let effects = inner.codex.reconcile_rollout(terminal_id, &events, now);
            let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
            frames
        };
        self.emit(frames);
    }

    /// `claude.activity.list` state (records + latest completions).
    pub fn claude_list(&self) -> (Vec<ClaudeActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (inner.claude.list(), inner.claude.list_latest_completions())
    }

    /// `codex.activity.list` state.
    pub fn codex_list(&self) -> (Vec<CodexActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (inner.codex.list(), inner.codex.list_latest_completions())
    }

    /// `opencode.activity.list` state.
    pub fn opencode_list(&self) -> (Vec<OpencodeActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (
            inner.opencode.list(),
            inner.opencode.list_latest_completions(),
        )
    }

    /// `amplifier.activity.list` state.
    pub fn amplifier_list(&self) -> (Vec<AmplifierActivityRecord>, Vec<TurnCompletionSnapshot>) {
        let inner = self.inner.lock().expect("activity hub lock");
        (
            inner.amplifier.list(),
            inner.amplifier.list_latest_completions(),
        )
    }

    fn spawn_task(&self, mut rx: tokio::sync::mpsc::UnboundedReceiver<HubEvent>) {
        let hub = self.clone();
        tokio::spawn(async move {
            loop {
                let deadline = {
                    let inner = hub.inner.lock().expect("activity hub lock");
                    hub_next_deadline(&inner)
                };
                match deadline {
                    None => match rx.recv().await {
                        Some(event) => hub.handle_event(event),
                        None => break,
                    },
                    Some(deadline_ms) => {
                        let wait = std::time::Duration::from_millis(
                            (deadline_ms - now_ms()).max(0) as u64,
                        );
                        tokio::select! {
                            event = rx.recv() => match event {
                                Some(event) => hub.handle_event(event),
                                None => break,
                            },
                            _ = tokio::time::sleep(wait) => {
                                hub.stats.timer_wakes.fetch_add(1, Ordering::SeqCst);
                                hub.expire_due();
                            }
                        }
                    }
                }
            }
        });
    }

    fn emit(&self, frames: Vec<ServerMessage>) {
        for frame in frames {
            if let Ok(json) = serde_json::to_string(&frame) {
                let _ = self.broadcast_tx.send(json);
            }
        }
    }

    fn handle_event(&self, event: HubEvent) {
        match event {
            HubEvent::Registry(event) => self.handle_registry_event(event),
            HubEvent::AmplifierAttach {
                terminal_id,
                session_id,
                events_path,
                attach_at,
            } => self.attach_lane(&terminal_id, &session_id, &events_path, attach_at),
            HubEvent::AmplifierFsChange { terminal_id } => {
                self.drain_lane(&terminal_id);
            }
            HubEvent::StopRequested { terminal_id } => {
                let mut inner = self.inner.lock().expect("activity hub lock");
                // Only a tracked terminal has gate state or an exit that
                // clears the mark (an untracked one never rings anyway).
                if inner.modes.contains_key(&terminal_id) {
                    inner.idle.note_stopping(&terminal_id);
                }
            }
            HubEvent::CodexBind {
                terminal_id,
                session_id,
            } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = inner.codex.bind_session(&terminal_id, &session_id);
                    let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
            HubEvent::CodexAttach {
                terminal_id,
                session_id,
                rollout_path,
            } => {
                self.attach_codex_lane(&terminal_id, &session_id, &rollout_path);
            }
            HubEvent::CodexFsChange { terminal_id } => {
                self.drain_codex_lane(&terminal_id);
            }
            HubEvent::CodexProxyTurn {
                terminal_id,
                thread_id,
                turn_id,
                status,
                completed,
            } => {
                let at = now_ms();
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = if completed {
                        inner.codex.note_proxy_turn_completed(
                            &terminal_id,
                            &thread_id,
                            turn_id.as_deref(),
                            status.as_deref(),
                            at,
                        )
                    } else {
                        inner.codex.note_proxy_turn_started(
                            &terminal_id,
                            &thread_id,
                            turn_id.as_deref(),
                            at,
                        )
                    };
                    let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
            HubEvent::CodexApproval {
                terminal_id,
                thread_id,
                request_id,
                requested,
            } => {
                let at = now_ms();
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = if requested {
                        inner.codex.note_approval_requested(
                            &terminal_id,
                            thread_id.as_deref(),
                            &request_id,
                            at,
                        )
                    } else {
                        inner
                            .codex
                            .note_approval_resolved(&terminal_id, &request_id, at)
                    };
                    let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
            HubEvent::OpencodeBind {
                terminal_id,
                session_id,
            } => {
                let at = now_ms();
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = inner.opencode.bind_session(&terminal_id, &session_id, at);
                    // ForceRead only arises from expire()
                    let (frames, _) = opencode_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
            HubEvent::OpencodeLane {
                terminal_id,
                generation,
                cycle,
                stream,
                event,
            } => {
                let at = now_ms();
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    // Attach-generation guard (A6): tokio `abort()` is asynchronous and
                    // never retracts already-enqueued mpsc messages — a replaced lane can
                    // legally enqueue events AFTER its successor's attach. Drop anything
                    // not stamped with the CURRENT lane generation (Exit removes the map
                    // entry, so post-exit stragglers drop too). cycle/stream still guard
                    // intra-lane reconnect staleness inside the tracker.
                    if inner.opencode_lanes.get(&terminal_id).map(|(g, _, _)| *g)
                        != Some(generation)
                    {
                        return;
                    }
                    let effects = match event {
                        OpencodeLaneEvent::Snapshot { statuses } => {
                            inner
                                .opencode
                                .note_snapshot(&terminal_id, &statuses, cycle, stream, at)
                        }
                        OpencodeLaneEvent::SessionCreated {
                            session_id,
                            parent_id,
                        } => inner.opencode.note_session_created(
                            &terminal_id,
                            &session_id,
                            parent_id.as_deref(),
                            at,
                        ),
                        OpencodeLaneEvent::Status { session_id, status } => inner
                            .opencode
                            .note_status(&terminal_id, &session_id, status, cycle, stream, at),
                        OpencodeLaneEvent::SessionIdle { session_id } => inner
                            .opencode
                            .note_session_idle(&terminal_id, &session_id, cycle, stream, at),
                        OpencodeLaneEvent::SessionError {
                            session_id,
                            error_name,
                        } => inner.opencode.note_error(
                            &terminal_id,
                            &session_id,
                            &error_name,
                            cycle,
                            stream,
                            at,
                        ),
                        OpencodeLaneEvent::PermissionAsked {
                            session_id,
                            permission_id,
                        } => inner.opencode.note_permission_asked(
                            &terminal_id,
                            &session_id,
                            &permission_id,
                            at,
                        ),
                        OpencodeLaneEvent::PermissionReplied { permission_id } => inner
                            .opencode
                            .note_permission_replied(&terminal_id, &permission_id, at),
                        OpencodeLaneEvent::SnapshotFailed { error } => {
                            tracing::error!(
                                terminal_id = %terminal_id,
                                %error,
                                "opencode snapshot probe failed; applying crash semantics (clear busy + attention)"
                            );
                            inner.opencode.note_verify_failed(&terminal_id, at)
                        }
                        OpencodeLaneEvent::PermissionsSynced { pending_ids } => inner
                            .opencode
                            .note_permissions_synced(&terminal_id, &pending_ids, at),
                    };
                    // ForceRead only arises from expire()
                    let (frames, _) = opencode_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
            HubEvent::OpencodeAttach {
                terminal_id,
                base_url,
            } => {
                let mut inner = self.inner.lock().expect("activity hub lock");
                // Deferred-attach guard (mirror of `attach_codex_lane`'s):
                // an Exit processed before this attach already tore the
                // terminal down — spawning now would leak a lane task
                // nothing ever removes. Race-free because Exit and
                // OpencodeAttach are processed serially on the hub task.
                if inner.modes.get(&terminal_id).map(String::as_str) != Some("opencode") {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        "opencode lane attach skipped: terminal no longer tracked"
                    );
                    return;
                }
                // A6: hub-issued monotonic generation, bumped on EVERY
                // attach — events from a replaced lane can never impersonate
                // the current one.
                inner.opencode_lane_next_generation += 1;
                let generation = inner.opencode_lane_next_generation;
                match inner.opencode_lane_deps.clone() {
                    Some(deps) => {
                        let (handle, verify_tx) = crate::opencode_lane::spawn_opencode_lane(
                            deps,
                            self.clone(),
                            terminal_id.clone(),
                            base_url,
                            generation,
                        );
                        // Replacement is the contract: a respawned pane
                        // re-allocates a NEW port, so the old lane is
                        // aborted, never shared. (Its already-enqueued
                        // events fail the generation guard.)
                        if let Some(old) = inner
                            .opencode_lanes
                            .insert(terminal_id, (generation, handle, verify_tx))
                        {
                            old.1.abort();
                        }
                    }
                    None => {
                        // No deps installed (unit tests / pre-Task-10 boot):
                        // still retire any existing lane so stragglers fail
                        // the guard.
                        if let Some((_, old, _)) = inner.opencode_lanes.remove(&terminal_id) {
                            old.abort();
                        }
                    }
                }
            }
        }
    }

    fn handle_registry_event(&self, event: ActivityEvent) {
        match event {
            ActivityEvent::Created {
                terminal_id,
                mode,
                resume_session_id,
                at,
            } => {
                let mut frames = Vec::new();
                {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    match mode.as_str() {
                        "claude" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.claude.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            // ForceRead only arises from expire()
                            let (mut f, _) = claude_frames(&mut inner.idle, effects);
                            frames.append(&mut f);
                        }
                        "codex" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.codex.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            let (mut f, _force_reads) = codex_frames(&mut inner.idle, effects);
                            frames.append(&mut f);
                        }
                        "amplifier" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.amplifier.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            let (mut f, _force) = amplifier_frames(&mut inner.idle, effects);
                            frames.append(&mut f);
                        }
                        // Task 8: opencode tracking starts at create; the
                        // SSE lane attach itself is Task 9/10.
                        "opencode" => {
                            inner.modes.insert(terminal_id.clone(), mode.clone());
                            let effects = inner.opencode.track_terminal(
                                &terminal_id,
                                resume_session_id.as_deref(),
                                at,
                            );
                            // ForceRead only arises from expire()
                            let (mut f, _) = opencode_frames(&mut inner.idle, effects);
                            frames.append(&mut f);
                        }
                        // Gemini/Kimi and every other mode: status-inert.
                        _ => {}
                    }
                }
                // Resume-created amplifier terminals: attach the events lane
                // at EOF via the resolver (the session dir already exists).
                if mode == "amplifier" {
                    if let (Some(resolver), Some(session_id)) =
                        (self.resolver.as_ref(), resume_session_id.as_deref())
                    {
                        if let Some(events_path) = resolver(session_id) {
                            let _ = self.tx.send(HubEvent::AmplifierAttach {
                                terminal_id: terminal_id.clone(),
                                session_id: session_id.to_string(),
                                events_path,
                                attach_at: AttachAt::Eof,
                            });
                        }
                    }
                }
                // G9: resume-created codex terminals attach the rollout-
                // reconcile lane via the locator (fresh terminals get theirs
                // from the candidate-adopt path instead). Channel-deferred
                // like AmplifierAttach so create's frames land first.
                //
                // MEASURED (load-bearing validation, F6): the locator's walk
                // of a real ~/.codex/sessions tree (8k+ files) is 35-55ms
                // warm and seconds-scale cold -- NEVER run it inline on the
                // hub task (the amplifier resolver stays inline because its
                // path is deterministic and cheap; this one is not). The
                // walk runs on a blocking thread; the attach event was
                // already channel-deferred, so frame ordering vs the Created
                // upsert is unchanged.
                if mode == "codex" {
                    if let Some(session_id) = resume_session_id.as_deref() {
                        let locator = {
                            let inner = self.inner.lock().expect("activity hub lock");
                            inner.codex_rollout_locator.clone()
                        };
                        if let Some(locator) = locator {
                            let tx = self.tx.clone();
                            let terminal_id = terminal_id.clone();
                            let session_id = session_id.to_string();
                            tokio::task::spawn_blocking(move || {
                                if let Some(rollout_path) = locator(&session_id) {
                                    let _ = tx.send(HubEvent::CodexAttach {
                                        terminal_id,
                                        session_id,
                                        rollout_path,
                                    });
                                }
                            });
                        }
                    }
                }
                self.emit(frames);
            }
            ActivityEvent::Input {
                terminal_id,
                data,
                at,
            } => {
                let submit = freshell_activity::signal::is_submit_input(&data);
                // The claude confirmable-submit path needs
                // `transcript_len`, which does a locate() directory scan —
                // filesystem IO that must NOT run under the hub lock.
                // Convention (see service_claude_verify): snapshot what the
                // probe needs under a short lock, drop it, do the IO,
                // re-lock to apply. Every other mode (and every claude
                // input that cannot probe) completes under the first lock
                // exactly as before.
                let (frames, probe) = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let Some(mode) = inner.modes.get(&terminal_id).cloned() else {
                        return;
                    };
                    // Any submit-shaped input means "a turn may be starting":
                    // cancel a pending idle window before the tracker runs.
                    if submit {
                        inner.idle.note_busy(&terminal_id);
                    }
                    // #612: quit-intent bookkeeping on the input stream
                    // freshell owns. Rules: see signal::classify_input.
                    let quit_state = inner
                        .quit_intent_lines
                        .entry(terminal_id.clone())
                        .or_default();
                    match freshell_activity::signal::classify_input(quit_state, &data) {
                        freshell_activity::signal::InputClass::QuitIntent => {
                            inner.quit_intents.insert(terminal_id.clone(), at);
                        }
                        freshell_activity::signal::InputClass::NonQuitSubmit => {
                            inner.quit_intents.remove(&terminal_id);
                        }
                        freshell_activity::signal::InputClass::Other => {}
                    }
                    match mode.as_str() {
                        "claude" => {
                            let probe = if submit {
                                match (
                                    inner.claude.session_id_of(&terminal_id),
                                    inner.claude_truth.clone(),
                                ) {
                                    (Some(session_id), Some(truth)) => Some((session_id, truth)),
                                    _ => None,
                                }
                            } else {
                                None
                            };
                            if probe.is_some() {
                                // note_input is deferred to the re-locked
                                // apply phase: `confirmable` depends on the
                                // probe result.
                                (Vec::new(), probe)
                            } else {
                                // No session/truth (or not a submit):
                                // confirmable is false, no IO — complete
                                // under this lock as before.
                                let effects =
                                    inner.claude.note_input(&terminal_id, &data, at, false);
                                let (frames, _) = claude_frames(&mut inner.idle, effects);
                                (frames, None)
                            }
                        }
                        "codex" => {
                            let effects = inner.codex.note_input(&terminal_id, &data, at);
                            let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                            (frames, None)
                        }
                        "amplifier" => {
                            let effects = inner.amplifier.note_input(&terminal_id, &data, at);
                            let (frames, _force) = amplifier_frames(&mut inner.idle, effects);
                            (frames, None)
                        }
                        // Task 8: SSE-driven — PTY bytes carry no protocol
                        // signal for opencode, NO heuristic bells.
                        "opencode" => (Vec::new(), None),
                        _ => (Vec::new(), None),
                    }
                };
                let frames = if let Some((session_id, truth)) = probe {
                    // Filesystem IO with the hub lock released.
                    let len = truth.transcript_len(&session_id);
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let confirmable = match len {
                        Some(len) => {
                            // #611 + A7: the offset is valid ONLY for this
                            // session — resume/fork mints a new file.
                            // Double-Enter: keep the FIRST offset. ANY
                            // activity after the FIRST Enter is the correct
                            // confirmation baseline; re-stashing here would
                            // re-baseline past a live turn's evidence (the
                            // prompt record Enter #1 appended) and falsely
                            // revert it. The awaiting-confirm guard is
                            // decided HERE, at stash time under the
                            // re-acquired lock — atomic with the insert and
                            // the note_input below, exactly as the pre-split
                            // single-lock code had it. A snapshot taken
                            // before the IO could go stale against a
                            // concurrent resolution and re-stash over a
                            // live turn's baseline.
                            if !inner.claude.is_awaiting_submit_confirm(&terminal_id) {
                                inner
                                    .claude_submit_offsets
                                    .insert(terminal_id.clone(), (session_id.clone(), len));
                            }
                            true
                        }
                        None => false,
                    };
                    let effects = inner
                        .claude
                        .note_input(&terminal_id, &data, at, confirmable);
                    let (frames, _) = claude_frames(&mut inner.idle, effects);
                    frames
                } else {
                    frames
                };
                self.emit(frames);
            }
            ActivityEvent::Output {
                terminal_id,
                data,
                at,
            } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let Some(mode) = inner.modes.get(&terminal_id).cloned() else {
                        return;
                    };
                    match mode.as_str() {
                        "claude" => {
                            let effects = inner.claude.note_output(&terminal_id, &data, at);
                            // ForceRead only arises from expire()
                            let (frames, _) = claude_frames(&mut inner.idle, effects);
                            frames
                        }
                        "codex" => {
                            let effects = inner.codex.note_output(&terminal_id, &data, at);
                            let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                            frames
                        }
                        "amplifier" => {
                            inner.amplifier.note_output(&terminal_id, at);
                            Vec::new()
                        }
                        // Task 8: SSE-driven — PTY bytes carry no protocol
                        // signal for opencode, NO heuristic bells.
                        "opencode" => Vec::new(),
                        _ => Vec::new(),
                    }
                };
                self.emit(frames);
            }
            ActivityEvent::Exit {
                terminal_id,
                at,
                spontaneous,
            } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    // Read engagement BEFORE any teardown: `idle.note_exit` deletes the
                    // per-terminal gate state and `modes.remove` would early-return.
                    // Task 7: a pane blocked on an approval whose process dies must
                    // ring even after its 2s boundary already rang, so pending
                    // approvals count as engagement too.
                    // D4: candidate/ambiguous opencode ownership never death-rings —
                    // even when a candidate-armed permission pause is pending
                    // (residual D8(i)). `blocks_death_bell` is false for terminals
                    // the opencode tracker doesn't know, so claude/codex/amplifier
                    // behavior is unchanged.
                    let opencode_death_eligible = !inner.opencode.blocks_death_bell(&terminal_id);
                    // #612: an unexpired quit-intent marker (user-typed
                    // /quit, /exit, Ctrl+C, Ctrl+D on freshell's own input
                    // stream) suppresses the death bell — external kills
                    // still ring (owner ruling 6).
                    let quit_intent =
                        quit_intent_active(inner.quit_intents.get(&terminal_id).copied(), at);
                    // Stage 2: LB-37: a terminal whose stop was requested
                    // never rings (a crash never marks it stopping).
                    let ring_death_bell = spontaneous
                        && !quit_intent
                        && !inner.idle.is_stopping(&terminal_id)
                        && ((inner.idle.is_engaged(&terminal_id) && opencode_death_eligible)
                            || inner.codex.has_pending_approvals(&terminal_id)
                            || (inner.opencode.has_pending_permissions(&terminal_id)
                                && opencode_death_eligible));
                    if spontaneous && quit_intent {
                        tracing::info!(
                            terminal_id = %terminal_id,
                            "death bell suppressed: human quit intent observed on the input stream (#612)"
                        );
                    }
                    let mut frames = Vec::new();
                    if ring_death_bell {
                        // Spontaneous death while engaged: same frame, same reason —
                        // no wire change. reason MUST be Grace: the client zod enum
                        // (shared/ws-protocol.ts:210-215) and the Rust enum
                        // (freshell-protocol server_messages.rs:397-402) allow ONLY
                        // grace|queue-empty — a novel reason is silently dropped by
                        // the Node schema and unrepresentable here. `at` is the fresh
                        // exit timestamp (client dedupe is per-terminal monotonic
                        // `at`). Immediate (no grace): a dead process emits nothing
                        // further, so nothing could ever cancel it. Exactly once per
                        // terminal: the modes.remove below guarantees the teardown
                        // runs once, and a later shutdown sweep of a retained exited
                        // row arrives with spontaneous=false.
                        frames.push(ServerMessage::TerminalIdle(TerminalIdle {
                            terminal_id: terminal_id.clone(),
                            at,
                            reason: TerminalIdleReason::Grace,
                        }));
                    }
                    if let Some(mode) = inner.modes.remove(&terminal_id) {
                        inner.idle.note_exit(&terminal_id);
                        inner.lanes.remove(&terminal_id);
                        inner.claude_submit_offsets.remove(&terminal_id);
                        inner.quit_intents.remove(&terminal_id);
                        inner.quit_intent_lines.remove(&terminal_id);
                        inner.lane_retries.remove(&terminal_id);
                        inner.codex_lanes.remove(&terminal_id);
                        if let Some((_, lane_task, _)) = inner.opencode_lanes.remove(&terminal_id) {
                            // Stop the SSE lane with its pane; the map removal
                            // ALSO makes any already-enqueued stragglers fail
                            // the generation guard (abort never retracts
                            // enqueued events).
                            lane_task.abort();
                        }
                        let tracker_frames = match mode.as_str() {
                            "claude" => {
                                let effects = inner.claude.note_exit(&terminal_id);
                                // ForceRead only arises from expire()
                                let (frames, _) = claude_frames(&mut inner.idle, effects);
                                frames
                            }
                            "codex" => {
                                let effects = inner.codex.note_exit(&terminal_id);
                                let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                                frames
                            }
                            "amplifier" => {
                                let effects = inner.amplifier.note_exit(&terminal_id);
                                let (frames, _force) = amplifier_frames(&mut inner.idle, effects);
                                frames
                            }
                            "opencode" => {
                                let effects = inner.opencode.note_exit(&terminal_id);
                                // ForceRead only arises from expire()
                                let (frames, _) = opencode_frames(&mut inner.idle, effects);
                                frames
                            }
                            _ => Vec::new(),
                        };
                        frames.extend(tracker_frames);
                    }
                    frames
                };
                self.emit(frames);
            }
        }
    }

    fn attach_lane(
        &self,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
        attach_at: AttachAt,
    ) {
        use notify::Watcher;
        let mut tailer = AmplifierEventsTailer::new(events_path);
        // G8: never replay an unbounded backlog. Stat once at the call site;
        // a failed stat means "file not created yet" and keeps Start.
        let file_len = std::fs::metadata(events_path).ok().map(|m| m.len());
        let effective = effective_attach_at(attach_at, file_len);
        if effective != attach_at {
            tracing::warn!(
                terminal_id = %terminal_id,
                session_id = %session_id,
                size_bytes = file_len.unwrap_or(0),
                cap_bytes = AMPLIFIER_CATCHUP_MAX_BYTES,
                "amplifier_events_catchup_skipped: events backlog exceeds the catch-up cap; attaching at EOF (live records take over)"
            );
        }
        let attach_at = effective;
        if let Err((reason, message)) = tailer.attach(attach_at) {
            tracing::warn!(
                terminal_id = %terminal_id,
                reason = ?reason,
                message = %message,
                "amplifier_events_lane_degraded: attach failed"
            );
            self.handle_attach_failure(
                terminal_id,
                session_id,
                events_path,
                matches!(reason, TailerDegradeReason::SchemaMismatch),
            );
            return;
        }
        let tx = self.tx.clone();
        let watched_terminal = terminal_id.to_string();
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            // Event filter: the SHARED `fs_event_is_relevant` (same fn as
            // the codex lane) -- data-mutation kinds only (zero-polling:
            // our own reads must not self-trigger), plus the Rescan
            // miss-recovery override. See its doc comment (kata namg).
            if let Ok(event) = res {
                if fs_event_is_relevant(&event) {
                    let _ = tx.send(HubEvent::AmplifierFsChange {
                        terminal_id: watched_terminal.clone(),
                    });
                }
            }
        });
        let mut watcher = match watcher {
            Ok(watcher) => watcher,
            Err(error) => {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    error = %error,
                    "amplifier_events_lane_degraded: watcher create failed"
                );
                self.handle_attach_failure(terminal_id, session_id, events_path, false);
                return;
            }
        };
        if let Err(error) = watcher.watch(events_path, notify::RecursiveMode::NonRecursive) {
            tracing::warn!(
                terminal_id = %terminal_id,
                error = %error,
                "amplifier_events_lane_degraded: watch failed"
            );
            self.handle_attach_failure(terminal_id, session_id, events_path, false);
            return;
        }

        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            // Track + bind (a resume-created terminal is already tracked; a
            // locator-associated one is too — bind_session updates identity).
            let mut frames = Vec::new();
            let track = inner
                .amplifier
                .track_terminal(terminal_id, Some(session_id), now_ms());
            let (mut f, _) = amplifier_frames(&mut inner.idle, track);
            frames.append(&mut f);
            let bind = inner.amplifier.bind_session(terminal_id, session_id);
            let (mut f, _) = amplifier_frames(&mut inner.idle, bind);
            frames.append(&mut f);
            inner.lanes.insert(
                terminal_id.to_string(),
                AmplifierLane {
                    tailer,
                    reducer_state: create_reducer_state(),
                    session_id: session_id.to_string(),
                    events_path: events_path.to_path_buf(),
                    _watcher: watcher,
                },
            );
            frames
        };
        self.emit(frames);
        // Initial drain: at Start this replays the young file's history
        // (the prompt:submit that confirms provisional busy); at Eof it is a
        // cheap size==offset no-op that also validates readability.
        self.drain_lane(terminal_id);
    }

    /// Incremental read + reduce + apply for one lane. Called on inotify
    /// change events, force-read failsafes, and once at attach.
    fn drain_lane(&self, terminal_id: &str) {
        self.stats.tail_reads.fetch_add(1, Ordering::SeqCst);
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let Some(mut lane) = inner.lanes.remove(terminal_id) else {
                return;
            };
            let mut frames = Vec::new();
            match lane.tailer.read() {
                TailerReadOutcome::Ok {
                    records,
                    bytes_consumed,
                    ..
                } => {
                    if bytes_consumed > 0 {
                        // File activity: the session is still doing something
                        // — extend any pending truly-idle window.
                        inner.idle.note_activity(terminal_id, now_ms());
                    }
                    for record in records {
                        let (next_state, effects) =
                            reduce_amplifier_event(&lane.reducer_state, &record);
                        lane.reducer_state = next_state;
                        for effect in effects {
                            if matches!(effect, ReducerEffect::TurnBegan { .. }) {
                                inner.idle.note_busy(terminal_id);
                            }
                            let tracker_effects =
                                inner
                                    .amplifier
                                    .apply_lifecycle(terminal_id, &effect, now_ms());
                            let (mut f, _) = amplifier_frames(&mut inner.idle, tracker_effects);
                            frames.append(&mut f);
                        }
                    }
                    // A successful read is the recovery signal: reset the
                    // bounded-retry bookkeeping (and its timer).
                    inner.lane_retries.remove(terminal_id);
                    inner.lanes.insert(terminal_id.to_string(), lane);
                }
                TailerReadOutcome::Degraded { reason, message } => {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        reason = ?reason,
                        message = %message,
                        "amplifier_events_lane_degraded"
                    );
                    // Signal loss (#605): a CONFIRMED busy holds its light —
                    // the tracker answers with a ForceRead which is
                    // intentionally DROPPED here; only a provisional busy
                    // reverts. The lane (and its watcher) is dropped and a
                    // re-attach is scheduled (G4, capped forever).
                    // ForceRead against a degraded tailer would loop; the
                    // bounded re-attach owns recovery.
                    let effects = inner
                        .amplifier
                        .note_events_signal_lost(terminal_id, now_ms());
                    let (mut f, _dropped_force_reads) = amplifier_frames(&mut inner.idle, effects);
                    frames.append(&mut f);
                    self.note_lane_failure(
                        &mut inner,
                        terminal_id,
                        &lane.session_id,
                        &lane.events_path,
                        matches!(reason, TailerDegradeReason::SchemaMismatch),
                        &mut frames,
                    );
                }
            }
            frames
        };
        self.emit(frames);
    }

    /// Record a lane failure (degrade or failed [re-]attach) and schedule
    /// the next re-attach — bounded schedule first, then the cap FOREVER
    /// (#605: no give-up arm). The first past-schedule failure escalates to
    /// crash semantics. Caller holds the `HubInner` lock; client-visible
    /// frames are pushed onto `frames` and must be emitted by the caller
    /// AFTER releasing the lock.
    fn note_lane_failure(
        &self,
        inner: &mut HubInner,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
        permanent: bool,
        frames: &mut Vec<ServerMessage>,
    ) {
        let failures = inner
            .lane_retries
            .get(terminal_id)
            .map(|retry| retry.failures)
            .unwrap_or(0)
            + 1;
        let delay_ms = lane_retry_delay_ms(failures);
        // #605 crash-semantics escalation: the FIRST failure past the
        // bounded schedule clears busy and rings the attention boundary
        // (owner ruling: verify failure = crash) — but retries continue
        // at the cap; a later Ok read resets `failures` and recovery is
        // full. `permanent` failures escalate immediately.
        let exhausted = permanent || failures == AMPLIFIER_LANE_RETRY_DELAYS_MS.len() as u32 + 1;
        if exhausted {
            tracing::error!(
                terminal_id = %terminal_id,
                failures,
                permanent,
                "amplifier_events_lane_verify_failed: events lane unreadable past bounded re-attach; ringing attention and continuing capped retries"
            );
            let effects = inner.amplifier.note_verify_failed(terminal_id, now_ms());
            let (mut f, _) = amplifier_frames(&mut inner.idle, effects);
            frames.append(&mut f);
        } else {
            tracing::warn!(
                terminal_id = %terminal_id,
                failures,
                delay_ms,
                "amplifier_events_lane_retry_scheduled"
            );
        }
        // Gap-loss bookkeeping (#605): capture the file length at the
        // FIRST failure of the episode; later failures keep it.
        let bytes_at_degrade = if failures == 1 {
            std::fs::metadata(events_path).ok().map(|m| m.len())
        } else {
            inner
                .lane_retries
                .get(terminal_id)
                .and_then(|retry| retry.bytes_at_degrade)
        };
        inner.lane_retries.insert(
            terminal_id.to_string(),
            LaneRetry {
                session_id: session_id.to_string(),
                events_path: events_path.to_path_buf(),
                failures,
                next_attempt_at: Some(now_ms() + delay_ms),
                bytes_at_degrade,
            },
        );
    }

    /// Attach failed before a lane existed — route into the same bounded
    /// retry machinery (lock is NOT held by the caller).
    fn handle_attach_failure(
        &self,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
        permanent: bool,
    ) {
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let mut frames = Vec::new();
            self.note_lane_failure(
                &mut inner,
                terminal_id,
                session_id,
                events_path,
                permanent,
                &mut frames,
            );
            frames
        };
        self.emit(frames);
    }

    /// The one-shot deadline fired: run every tracker's expiry + the idle
    /// gate, then service any codex + amplifier force-read requests,
    /// opencode verify requests (#603), and claude JSONL verify requests
    /// (#606).
    fn expire_due(&self) {
        let now = now_ms();
        let (
            frames,
            codex_force_reads,
            force_reads,
            opencode_verifies,
            claude_verifies,
            reattaches,
        ) = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let mut frames = Vec::new();
            let claude = inner.claude.expire(now);
            let (mut f, claude_verifies) = claude_frames(&mut inner.idle, claude);
            frames.append(&mut f);
            let codex = inner.codex.expire(now);
            let (mut f, codex_force_reads) = codex_frames(&mut inner.idle, codex);
            frames.append(&mut f);
            let amplifier = inner.amplifier.expire(now);
            let (mut f, force_reads) = amplifier_frames(&mut inner.idle, amplifier);
            frames.append(&mut f);
            let opencode = inner.opencode.expire(now);
            let (mut f, opencode_verifies) = opencode_frames(&mut inner.idle, opencode);
            frames.append(&mut f);
            for emission in inner.idle.expire(now) {
                frames.push(ServerMessage::TerminalIdle(TerminalIdle {
                    terminal_id: emission.terminal_id,
                    at: emission.at,
                    reason: emission.reason,
                }));
            }
            let now = now_ms();
            let mut reattaches: Vec<(String, String, PathBuf, Option<u64>)> = Vec::new();
            for (terminal_id, retry) in inner.lane_retries.iter_mut() {
                if matches!(retry.next_attempt_at, Some(at) if at <= now) {
                    // Mark in flight: arms no timer until the attempt resolves.
                    retry.next_attempt_at = None;
                    reattaches.push((
                        terminal_id.clone(),
                        retry.session_id.clone(),
                        retry.events_path.clone(),
                        retry.bytes_at_degrade,
                    ));
                }
            }
            (
                frames,
                codex_force_reads,
                force_reads,
                opencode_verifies,
                claude_verifies,
                reattaches,
            )
        };
        self.emit(frames);
        // KATA namg: service codex deadman force-reads -- the self-healing
        // floor for a missed rollout fs event. drain_codex_lane no-ops when
        // the lane is gone (get_mut miss), which is correct: exit tears the
        // tracker down with the lane, and a re-attach replaces both.
        for terminal_id in codex_force_reads {
            self.drain_codex_lane(&terminal_id);
        }
        for terminal_id in force_reads {
            self.drain_lane(&terminal_id);
        }
        for terminal_id in opencode_verifies {
            self.request_opencode_verify(&terminal_id);
        }
        for terminal_id in claude_verifies {
            self.service_claude_verify(&terminal_id);
        }
        for (terminal_id, session_id, stored_path, bytes_at_degrade) in reattaches {
            // Port of the legacy resolveEventsPath semantics: the path is
            // keyed by session id — re-resolve at every attempt, falling
            // back to the path captured at degrade time (unit tests run
            // with resolver = None). Covers same-sid path moves only; an
            // in-terminal amplifier restart mints a NEW sid, which nothing
            // re-attaches — an inherited legacy gap, out of scope (DD6).
            // The gap-loss length-delta rule (#605) below is scoped to a
            // session-id's lifetime — a FRESH amplifier restart mints a new
            // sid → a new events.jsonl that nothing re-attaches; that is
            // THIS legacy gap (DD6), unchanged by #605. `amplifier session
            // resume <sid>` reuses the file and IS covered. Accepted
            // residual: growth during a blind gap consisting only of
            // status-inert records still rings — deterministic, aligned
            // with owner ruling 4 (unverifiable ⇒ ring).
            let events_path = self
                .resolver
                .as_ref()
                .and_then(|resolve| resolve(&session_id))
                .unwrap_or(stored_path);
            // #605 gap-loss rule: records appended during a degrade gap are
            // unverifiable (re-attach is Eof). Re-stat the resolved path:
            // a length differing from the degrade-time snapshot means the
            // in-flight turn cannot be verified — crash semantics, then
            // attach at Eof for fresh tracking. Unchanged length = nothing
            // was missed — safe hold (the writer is append-only within a
            // sid; a shrink already degrades via FileReset).
            let current_len = std::fs::metadata(&events_path).ok().map(|m| m.len());
            if current_len != bytes_at_degrade {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = inner.amplifier.note_verify_failed(&terminal_id, now_ms());
                    let (frames, _) = amplifier_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
            tracing::info!(
                terminal_id = %terminal_id,
                "amplifier_events_lane_reattach_attempt"
            );
            // Always Eof: a rotated/reset file's history is not ours to
            // replay. attach_lane builds a FRESH tailer + reducer state
            // (both degrade latches are sticky), and its failure paths feed
            // back into note_lane_failure, escalating `failures`.
            self.attach_lane(&terminal_id, &session_id, &events_path, AttachAt::Eof);
        }
    }

    /// #603: ask the terminal's lane to re-fetch /session/status. A pane
    /// with no lane has no truth source — owner ruling: probe failure =
    /// crash semantics, applied immediately.
    fn request_opencode_verify(&self, terminal_id: &str) {
        let send_failed = {
            let inner = self.inner.lock().expect("activity hub lock");
            match inner.opencode_lanes.get(terminal_id) {
                Some((_, _, verify_tx)) => verify_tx.send(()).is_err(),
                None => true,
            }
        };
        if send_failed {
            let frames = {
                let mut inner = self.inner.lock().expect("activity hub lock");
                let at = now_ms();
                let effects = inner.opencode.note_verify_failed(terminal_id, at);
                let (frames, _) = opencode_frames(&mut inner.idle, effects);
                frames
            };
            self.emit(frames);
        }
    }

    /// #606: answer a claude deadman verify from the session-JSONL truth
    /// source. Probe runs OUTSIDE the hub lock (file IO). No bound
    /// session / no truth source / unreadable transcript = probe failure
    /// = crash semantics (owner ruling).
    fn service_claude_verify(&self, terminal_id: &str) {
        use crate::claude_truth::TurnProbe;
        let (session, truth, awaiting_confirm, offset) = {
            let inner = self.inner.lock().expect("activity hub lock");
            (
                inner.claude.session_id_of(terminal_id),
                inner.claude_truth.clone(),
                inner.claude.is_awaiting_submit_confirm(terminal_id),
                inner.claude_submit_offsets.get(terminal_id).cloned(),
            )
        };
        if awaiting_confirm {
            use crate::claude_truth::SubmitProbe;
            // #611 + A7: the stash is (session_id, offset) — usable ONLY
            // if the currently-bound session equals the stashed one.
            // Resume/fork mints a NEW <session-id>.jsonl and Task 10's
            // rebinds re-point the tracker mid-flight; probing a foreign
            // file with a stale offset would be an undefined read, so a
            // mismatch is a probe failure (Unavailable) and the #606
            // deadman backstop takes over.
            let probe = match (&session, &truth, &offset) {
                (Some(session_id), Some(truth), Some((stashed_session, offset)))
                    if stashed_session == session_id =>
                {
                    truth.probe_submit(session_id, *offset)
                }
                _ => SubmitProbe::Unavailable,
            };
            let frames = {
                let mut inner = self.inner.lock().expect("activity hub lock");
                let at = now_ms();
                let effects = match probe {
                    SubmitProbe::Confirmed => inner.claude.note_submit_confirmed(terminal_id, at),
                    SubmitProbe::NoTurnStarted => {
                        inner.claude.note_submit_unconfirmed(terminal_id, at)
                    }
                    SubmitProbe::Unavailable => {
                        // Dead stash — drop it. The tracker call clears the
                        // grace deadline and thereby exits the awaiting-
                        // confirm state, so the pane's NEXT ForceRead falls
                        // through to the deadman-verify flavor below and
                        // crash semantics stay reachable at the 120s mark.
                        inner.claude_submit_offsets.remove(terminal_id);
                        inner.claude.note_submit_probe_unavailable(terminal_id);
                        Vec::new()
                    }
                };
                let (frames, _) = claude_frames(&mut inner.idle, effects);
                frames
            };
            self.emit(frames);
            return;
        }
        let probe = match (&session, &truth) {
            (Some(session_id), Some(truth)) => truth.probe_turn_state(session_id),
            _ => TurnProbe::Unavailable,
        };
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let at = now_ms();
            let effects = match probe {
                TurnProbe::InFlight => inner.claude.note_verified_busy(terminal_id, at),
                TurnProbe::Ended => inner.claude.note_verified_ended(terminal_id, at),
                TurnProbe::Unavailable => inner.claude.note_verify_failed(terminal_id, at),
            };
            let (frames, _) = claude_frames(&mut inner.idle, effects);
            frames
        };
        self.emit(frames);
    }
}

/// Shared fs-event filter for the codex and amplifier tail watchers.
///
/// Kind filter: only DATA-mutation events drive a tail read. This is the
/// zero-polling guarantee: our OWN read opens the file, which inotify
/// reports as `Access(..)` (IN_OPEN/IN_CLOSE_NOWRITE) and -- via the atime
/// update -- `Modify(Metadata(..))` (IN_ATTRIB); forwarding either would
/// self-trigger one extra read per real read. Appends arrive as
/// `Modify(Data(..))` (IN_MODIFY); `Create`/`Remove`/`Modify(Name)` cover
/// rotation edge cases.
///
/// Rescan override (kata namg): notify's inotify backend reports kernel
/// IN_Q_OVERFLOW as `Event::new(EventKind::Other).set_flag(Flag::Rescan)`
/// (notify-6.1.1 inotify.rs:208-211) -- "you may have missed events,
/// re-check". It is the library's ONE miss-recovery signal; dropping it
/// leaves a lane silently wedged until an unrelated future write. Gate on
/// `need_rescan()` rather than `EventKind::Other`: the kqueue backend emits
/// flagless `Other` as a `_ =>` catch-all (kqueue.rs:271), which must NOT
/// trigger reads.
fn fs_event_is_relevant(event: &notify::Event) -> bool {
    event.need_rescan()
        || matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
                | notify::EventKind::Modify(notify::event::ModifyKind::Any)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                | notify::EventKind::Create(_)
                | notify::EventKind::Remove(_)
                | notify::EventKind::Any
        )
}

fn hub_next_deadline(inner: &HubInner) -> Option<i64> {
    [
        inner.claude.next_deadline(),
        inner.codex.next_deadline(),
        inner.amplifier.next_deadline(),
        inner.opencode.next_deadline(),
        inner.idle.next_deadline(),
        inner
            .lane_retries
            .values()
            .filter_map(|retry| retry.next_attempt_at)
            .min(),
    ]
    .into_iter()
    .flatten()
    .min()
}

/// Map claude tracker effects onto wire frames + idle-gate interactions.
/// Claude effects additionally surface deadman verify requests
/// (`ForceRead`, #606) — the hub answers them from the session-JSONL
/// truth source after the lock is released (expire_due only).
fn claude_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<ClaudeActivityRecord>>,
) -> (Vec<ServerMessage>, Vec<String>) {
    let mut frames = Vec::new();
    let mut force_reads = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            if r.phase == freshell_protocol::ClaudePhase::Busy {
                                IdleGatePhase::Busy
                            } else {
                                IdleGatePhase::Idle
                            },
                        )
                    }),
                    &remove,
                );
                frames.push(ServerMessage::ClaudeActivityUpdated(
                    ClaudeActivityUpdated { remove, upsert },
                ));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                // Stage 2: LB-37: a stopping terminal's turn end is silent.
                if idle.is_stopping(&terminal_id) {
                    continue;
                }
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Claude,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            // #606: the deadman's verify request — the hub answers it from
            // the session-JSONL truth source (expire_due only).
            TrackerEffect::ForceRead { terminal_id, .. } => force_reads.push(terminal_id),
            TrackerEffect::AttentionBoundary { terminal_id, at } => {
                // Arm the gate WITHOUT a terminal.turn.complete frame — an approval
                // pause is not a turn end. Effect order guarantees the Idle phase
                // Changed was processed first, so the boundary arms.
                idle.note_turn_boundary(&terminal_id, at);
            }
        }
    }
    (frames, force_reads)
}

/// Codex effects additionally surface force-read requests (the lane drains
/// them after the lock is released -- expire_due only; kata namg).
fn codex_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<CodexActivityRecord>>,
) -> (Vec<ServerMessage>, Vec<String>) {
    let mut frames = Vec::new();
    let mut force_reads = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            match r.phase {
                                freshell_protocol::CodexPhase::Busy => IdleGatePhase::Busy,
                                freshell_protocol::CodexPhase::Pending => IdleGatePhase::Pending,
                                _ => IdleGatePhase::Idle,
                            },
                        )
                    }),
                    &remove,
                );
                frames.push(ServerMessage::CodexActivityUpdated(CodexActivityUpdated {
                    remove,
                    upsert,
                }));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                // Stage 2: LB-37: a stopping terminal's turn end is silent.
                if idle.is_stopping(&terminal_id) {
                    continue;
                }
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Codex,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            TrackerEffect::ForceRead { terminal_id, .. } => force_reads.push(terminal_id),
            TrackerEffect::AttentionBoundary { terminal_id, at } => {
                // Arm the gate WITHOUT a terminal.turn.complete frame — an approval
                // pause is not a turn end. Effect order guarantees the Idle phase
                // Changed was processed first, so the boundary arms.
                idle.note_turn_boundary(&terminal_id, at);
            }
        }
    }
    (frames, force_reads)
}

/// Map opencode tracker effects onto wire frames + idle-gate interactions.
/// Opencode effects additionally surface deadman verify requests
/// (`ForceRead`, #603) — the hub services them through the SSE lane's
/// verify channel after the lock is released (expire_due only).
fn opencode_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<OpencodeActivityRecord>>,
) -> (Vec<ServerMessage>, Vec<String>) {
    let mut frames = Vec::new();
    let mut force_reads = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                // remove -> note_removed clears gate state; the boundary that FOLLOWS
                // in the same batch re-arms grace-only (D7 — the Node emitter's
                // "activityRemove followed by turnComplete" contract). Busy is
                // the ONLY opencode phase on the wire, so every upsert maps to
                // IdleGatePhase::Busy.
                note_changed_to_gate(
                    idle,
                    upsert
                        .iter()
                        .map(|r| (r.terminal_id.as_str(), IdleGatePhase::Busy)),
                    &remove,
                );
                frames.push(ServerMessage::OpencodeActivityUpdated(
                    OpencodeActivityUpdated { remove, upsert },
                ));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                // Stage 2: LB-37: a stopping terminal's turn end is silent.
                if idle.is_stopping(&terminal_id) {
                    continue;
                }
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Opencode,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            TrackerEffect::AttentionBoundary { terminal_id, at } => {
                // Arms the bell WITHOUT a frame — a permission pause is not a
                // turn end. Effect order guarantees the record removal was
                // processed first, so the boundary arms.
                idle.note_turn_boundary(&terminal_id, at);
            }
            // #603: the deadman's verify request — the hub re-fetches
            // /session/status through the lane's verify channel.
            TrackerEffect::ForceRead { terminal_id, .. } => force_reads.push(terminal_id),
        }
    }
    (frames, force_reads)
}

/// Amplifier effects additionally surface force-read requests (the lane
/// drains them after the lock is released).
fn amplifier_frames(
    idle: &mut IdleGate,
    effects: Vec<TrackerEffect<AmplifierActivityRecord>>,
) -> (Vec<ServerMessage>, Vec<String>) {
    let mut frames = Vec::new();
    let mut force_reads = Vec::new();
    for effect in effects {
        match effect {
            TrackerEffect::Changed { upsert, remove } => {
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            if r.phase == freshell_protocol::AmplifierPhase::Busy {
                                IdleGatePhase::Busy
                            } else {
                                IdleGatePhase::Idle
                            },
                        )
                    }),
                    &remove,
                );
                frames.push(ServerMessage::AmplifierActivityUpdated(
                    AmplifierActivityUpdated { remove, upsert },
                ));
            }
            TrackerEffect::TurnComplete {
                terminal_id,
                session_id,
                at,
                completion_seq,
            } => {
                // Stage 2: LB-37: a stopping terminal's turn end is silent.
                if idle.is_stopping(&terminal_id) {
                    continue;
                }
                idle.note_turn_boundary(&terminal_id, at);
                frames.push(turn_complete_frame(
                    AgentProvider::Amplifier,
                    terminal_id,
                    session_id,
                    at,
                    completion_seq,
                ));
            }
            TrackerEffect::ForceRead { terminal_id, .. } => force_reads.push(terminal_id),
            TrackerEffect::AttentionBoundary { terminal_id, at } => {
                // #605: crash-semantics boundary — arms the gate WITHOUT a
                // turn.complete frame, same contract as codex approvals.
                idle.note_turn_boundary(&terminal_id, at);
            }
        }
    }
    (frames, force_reads)
}

/// Forward a tracker `Changed` effect to the idle gate IN FULL: every phase
/// edge (busy AND idle — the gate's busy-awareness needs both) and every
/// removal. Uniform across the claude/codex/amplifier lanes.
fn note_changed_to_gate<'a>(
    idle: &mut IdleGate,
    upserts: impl Iterator<Item = (&'a str, IdleGatePhase)>,
    remove: &[String],
) {
    for (terminal_id, phase) in upserts {
        idle.note_phase(terminal_id, phase);
    }
    for terminal_id in remove {
        idle.note_removed(terminal_id);
    }
}

fn turn_complete_frame(
    provider: AgentProvider,
    terminal_id: String,
    session_id: Option<String>,
    at: i64,
    completion_seq: i64,
) -> ServerMessage {
    ServerMessage::TerminalTurnComplete(TerminalTurnComplete {
        at,
        completion_seq,
        provider,
        terminal_id,
        session_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn hub() -> (ActivityHub, tokio::sync::broadcast::Receiver<String>) {
        let (broadcast_tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        let hub = ActivityHub::new(Arc::new(broadcast_tx), None);
        (hub, rx)
    }

    fn observer_send(hub: &ActivityHub, event: ActivityEvent) {
        (hub.registry_observer())(event);
    }

    /// Wait for the first frame of `wanted` type that also satisfies `pred`.
    /// (Tracker create emits an initial `phase:"idle"` upsert — parity with
    /// legacy `commitState(state, undefined)` — so tests select the exact
    /// transition they care about instead of the first frame of a type.)
    async fn next_frame_matching(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        wanted: &str,
        timeout_ms: u64,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value = serde_json::from_str(&frame).ok()?;
                    if value["type"] == wanted && pred(&value) {
                        return Some(value);
                    }
                }
                _ => return None,
            }
        }
    }

    async fn next_frame_of_type(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        wanted: &str,
        timeout_ms: u64,
    ) -> Option<serde_json::Value> {
        next_frame_matching(rx, wanted, timeout_ms, |_| true).await
    }

    /// KATA namg: notify's inotify backend reports kernel IN_Q_OVERFLOW as
    /// Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)) -- "events
    /// were dropped, re-check the file" (notify-6.1.1 inotify.rs:208-211).
    /// Both lane watchers must forward it as an fs-change so a real overflow
    /// triggers an immediate catch-up read. Gate on the Rescan FLAG, not on
    /// EventKind::Other: the kqueue backend emits flagless Other as a
    /// catch-all (kqueue.rs:271), which must NOT trigger reads, and our own
    /// tail reads produce Access events which must never self-trigger
    /// (zero-polling invariant).
    #[test]
    fn rescan_overflow_is_relevant_but_flagless_other_and_access_are_not() {
        use notify::event::{AccessKind, Flag};
        use notify::{Event, EventKind};

        let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(
            fs_event_is_relevant(&overflow),
            "IN_Q_OVERFLOW rescan must trigger a catch-up read"
        );

        let flagless_other = Event::new(EventKind::Other);
        assert!(
            !fs_event_is_relevant(&flagless_other),
            "kqueue catch-all Other (no Rescan flag) must not trigger reads"
        );

        let access = Event::new(EventKind::Access(AccessKind::Any));
        assert!(
            !fs_event_is_relevant(&access),
            "our own tail reads (Access) must never self-trigger"
        );

        let append = Event::new(EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Any,
        )));
        assert!(fs_event_is_relevant(&append), "real appends still read");
    }

    fn amplifier_line(event: &str) -> String {
        // A LIVE timestamp, like the real CLI writes: the tracker folds the
        // record's ts into last_observed_at, so a stale fixture ts would
        // (correctly!) look like >deadman silence and trigger a force-read.
        format!(
            "{}\n",
            serde_json::json!({
                "ts": crate::now_iso(),
                "schema": { "name": "amplifier.log", "ver": "1.0.0" },
                "event": event,
                "session_id": "sess-1",
                "data": {}
            })
        )
    }

    /// A lifecycle record whose schema version fails the gate (major != 1) —
    /// drives the tailer's deterministic SchemaMismatch degrade.
    fn bad_schema_line(event: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "ts": crate::now_iso(),
                "schema": { "name": "amplifier.log", "ver": "2.0.0" },
                "event": event,
                "session_id": "sess-1",
                "data": {}
            })
        )
    }

    /// TERM-15: a claude submit broadcasts a busy upsert; the Stop-hook BEL
    /// broadcasts idle + exactly one TERM-16 turn.complete; the truly-idle
    /// grace then emits exactly one terminal.idle.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_submit_bel_turn_complete_and_terminal_idle_flow() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let busy = next_frame_matching(&mut rx, "claude.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t1");

        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        let idle_upsert = next_frame_matching(&mut rx, "claude.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("idle upsert");
        assert_eq!(idle_upsert["upsert"][0]["terminalId"], "t1");

        // The turn.complete frame followed (order: changed then completion).
        let mut rx2 = rx;
        let complete = next_frame_of_type(&mut rx2, "terminal.turn.complete", 2_000)
            .await
            .expect("turn complete");
        assert_eq!(complete["provider"], "claude");
        assert_eq!(complete["terminalId"], "t1");
        assert_eq!(complete["completionSeq"], 1);

        // The truly-idle edge fires once after the grace window.
        let idle = next_frame_of_type(&mut rx2, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(idle["reason"], "grace");

        // List state reflects the completion for reconnect seeding.
        let (records, completions) = hub.claude_list();
        assert_eq!(records.len(), 1);
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].completion_seq, 1);
    }

    /// TERM-16: a queued prompt (submit during the grace window) suppresses
    /// terminal.idle — the busy re-entry cancels the pending window.
    #[tokio::test(flavor = "multi_thread")]
    async fn queued_prompt_suppresses_terminal_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        // Queued prompt: a new submit lands right after the turn boundary.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // No terminal.idle may arrive while the next turn is running.
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_000)
                .await
                .is_none(),
            "a queued prompt must suppress terminal.idle"
        );
    }

    /// TERM-15 no-stale-state: exit broadcasts a remove and clears the list.
    #[tokio::test(flavor = "multi_thread")]
    async fn exit_broadcasts_remove_and_clears_state() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let pending = next_frame_matching(&mut rx, "codex.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "pending"
        })
        .await
        .expect("pending upsert");
        assert_eq!(pending["upsert"][0]["terminalId"], "t1");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: false,
            },
        );
        let removed = next_frame_matching(&mut rx, "codex.activity.updated", 2_000, |v| {
            v["remove"][0] == "t1"
        })
        .await
        .expect("remove");
        assert_eq!(removed["remove"][0], "t1");
        let (records, _) = hub.codex_list();
        assert!(records.is_empty());
    }

    /// Decision 3 death bell: a spontaneous exit (the process died on its
    /// own) while ENGAGED (confirmed busy) rings exactly one terminal.idle.
    /// This test doubles as the audit-A17 ordering pin: if the hub read
    /// engagement AFTER `idle.note_exit` (which deletes the per-terminal
    /// state), the read would always be false and no frame would arrive.
    #[tokio::test(flavor = "multi_thread")]
    async fn spontaneous_exit_while_busy_rings_terminal_idle_once() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-1".into()),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");

        // Drive to CONFIRMED busy via the proxy turn lane.
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");

        // The process dies mid-turn.
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_000)
            .await
            .expect("terminal.idle death bell for a spontaneous exit while busy");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one terminal.idle for the death, never a duplicate"
        );
    }

    /// Decision 3: a freshell-initiated kill (api / idle reaper / shutdown —
    /// spontaneous=false) stays silent even mid-turn.
    #[tokio::test(flavor = "multi_thread")]
    async fn freshell_initiated_kill_while_busy_stays_silent() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-1".into()),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: false,
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "a requested exit must never ring the death bell"
        );
    }

    #[test]
    fn quit_intent_activity_window() {
        assert!(quit_intent_active(Some(1_000), 1_000 + QUIT_INTENT_TTL_MS));
        assert!(!quit_intent_active(Some(1_000), 1_001 + QUIT_INTENT_TTL_MS));
        assert!(!quit_intent_active(None, 5_000));
    }

    /// #612: busy pane + observed quit input + spontaneous exit ⇒ NO
    /// death bell; busy pane + ordinary input + spontaneous exit ⇒ the
    /// bell still rings (both directions pinned).
    #[tokio::test(flavor = "multi_thread")]
    async fn quit_intent_suppresses_the_death_bell_and_ordinary_input_does_not() {
        let (hub, mut rx) = hub();

        // Terminal 1: busy, then Ctrl+D (quit intent), then a
        // spontaneous exit — the death bell is SUPPRESSED.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\u{4}".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 300)
                .await
                .is_none(),
            "an observed human quit intent must suppress the death bell"
        );

        // Terminal 2: busy, ordinary (non-quit) input, spontaneous exit
        // — the death bell still RINGS.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t2".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t2".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t2".into(),
                data: "fix it\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t2".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle =
            next_frame_matching(&mut rx, "terminal.idle", 3_000, |v| v["terminalId"] == "t2")
                .await
                .expect("ordinary input must not suppress the death bell");
        assert_eq!(idle["reason"], "grace");

        // Terminal 3: the clearing rule — a quit-intent marker followed
        // by a NonQuitSubmit is CLEARED, so the exit rings.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t3".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t3".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t3".into(),
                data: "\u{4}".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t3".into(),
                data: "continue\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t3".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle =
            next_frame_matching(&mut rx, "terminal.idle", 3_000, |v| v["terminalId"] == "t3")
                .await
                .expect("a NonQuitSubmit after the quit intent must clear the marker");
        assert_eq!(idle["reason"], "grace");
    }

    /// Decision 3: exit while idle (no engagement) is silent — a human
    /// closing an idle pane is not an attention event.
    #[tokio::test(flavor = "multi_thread")]
    async fn spontaneous_exit_while_idle_stays_silent() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "a spontaneous exit while idle must stay silent"
        );
    }

    /// Decision 3 (audit A8): queue evidence does NOT suppress the death
    /// bell — a dead process never runs its queued submit.
    #[tokio::test(flavor = "multi_thread")]
    async fn queued_submit_does_not_suppress_the_death_bell() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-1".into()),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");

        // A submit queued while busy (would auto-run at the turn clear —
        // but the process dies first, so it never will).
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_000)
            .await
            .expect("queue evidence must not suppress the death bell");
        assert_eq!(idle["terminalId"], "t1");
    }

    /// Decision 3, claude tracker: same death bell for a claude-mode
    /// terminal driven busy via the claude input lane.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_spontaneous_exit_while_busy_rings() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "claude.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_000)
            .await
            .expect("terminal.idle death bell for a claude spontaneous exit while busy");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one terminal.idle for the death"
        );
    }

    /// Audit A6 red test: `/quit` typed into an IDLE codex pane. The Enter
    /// that executes the slash command is indistinguishable from a prompt
    /// submit in the input lane, so the tracker goes Idle→Pending — and the
    /// pty then exits. Input-only pending must NOT count as engagement:
    /// ringing here would bell the canonical human quit.
    #[tokio::test(flavor = "multi_thread")]
    async fn slash_command_quit_from_an_idle_pane_does_not_ring() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");

        // The lone-CR "/quit" Enter: the input lane promotes Idle→Pending.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "pending"
        })
        .await
        .expect("pending upsert");

        // The process exits on its own — exactly what /quit looks like.
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "a human /quit from an idle pane must never ring the death bell"
        );
    }

    /// Gemini/Kimi terminals stay status-inert (TERM-16): no activity frames.
    #[tokio::test(flavor = "multi_thread")]
    async fn gemini_and_kimi_are_status_inert() {
        let (hub, mut rx) = hub();
        for (i, mode) in ["gemini", "kimi"].iter().enumerate() {
            observer_send(
                &hub,
                ActivityEvent::Created {
                    terminal_id: format!("t{i}"),
                    mode: mode.to_string(),
                    resume_session_id: None,
                    at: now_ms(),
                },
            );
            observer_send(
                &hub,
                ActivityEvent::Input {
                    terminal_id: format!("t{i}"),
                    data: "\r".into(),
                    at: now_ms(),
                },
            );
            observer_send(
                &hub,
                ActivityEvent::Output {
                    terminal_id: format!("t{i}"),
                    data: "\u{07}".into(),
                    at: now_ms(),
                },
            );
        }
        // Nothing may be broadcast for status-inert modes.
        let frame = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await;
        assert!(frame.is_err(), "status-inert modes must broadcast nothing");
        let (claude, _) = hub.claude_list();
        let (codex, _) = hub.codex_list();
        let (amplifier, _) = hub.amplifier_list();
        assert!(claude.is_empty() && codex.is_empty() && amplifier.is_empty());
    }

    /// The amplifier events lane: association attach replays the young file
    /// (prompt:submit confirms busy), a later prompt:complete broadcasts
    /// idle + turn.complete + terminal.idle — all driven by inotify, with
    /// tail reads ONLY on attach/writes (zero polling).
    #[tokio::test(flavor = "multi_thread")]
    async fn amplifier_events_lane_drives_busy_complete_and_idle_via_inotify() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(
            &events_path,
            [
                amplifier_line("session:start"),
                amplifier_line("prompt:submit"),
            ]
            .concat(),
        )
        .unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        // PTY Enter: provisional busy.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("provisional busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t1");

        // Association resolves: lane attaches at Start and replays the
        // recorded prompt:submit (confirms busy — no public flap).
        hub.attach_amplifier_association("t1", "sess-1", &events_path);

        // Wait for the attach + initial drain to land (sessionId binds).
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 3_000, |v| {
            v["upsert"][0]["sessionId"] == "sess-1"
        })
        .await
        .expect("bind upsert");
        assert_eq!(bound["upsert"][0]["terminalId"], "t1");

        // DEFLAKE (f3wp refresh): the bind upsert can broadcast BEFORE the
        // attach's initial drain has incremented `tail_reads` (observed once
        // under workspace load, /tmp/f3wp-refresh/cargo-run5.log:
        // `reads_after_attach >= 1` failed on a one-shot read taken right
        // after the bind frame). Poll to the attach-read edge instead of
        // racing it -- the attach performs exactly one drain read with no
        // writes pending, so the settled counter is what the zero-polling
        // stability assertion below then holds against, unchanged.
        let attach_read_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while hub.stats().tail_reads.load(Ordering::SeqCst) < 1 {
            assert!(
                tokio::time::Instant::now() < attach_read_deadline,
                "attach never performed its initial tail read"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let reads_after_attach = hub.stats().tail_reads.load(Ordering::SeqCst);
        assert!(reads_after_attach >= 1);

        // Zero-polling: with no writes, NO further tail reads happen.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(
            hub.stats().tail_reads.load(Ordering::SeqCst),
            reads_after_attach,
            "no writes ⇒ no tail reads (inotify-driven, never polled)"
        );

        // The turn completes: append prompt:complete — inotify drives the read.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&events_path)
            .unwrap();
        f.write_all(amplifier_line("prompt:complete").as_bytes())
            .unwrap();
        f.flush().unwrap();
        drop(f);

        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 5_000)
            .await
            .expect("amplifier turn.complete");
        assert_eq!(complete["provider"], "amplifier");
        assert_eq!(complete["sessionId"], "sess-1");

        // Truly idle after the grace window (no further file activity).
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(idle["reason"], "grace");

        assert!(
            hub.stats().tail_reads.load(Ordering::SeqCst) > reads_after_attach,
            "the write must have driven a tail read"
        );
    }

    /// Provider-error turn (2026-08-10 stuck-busy fix): the CLI writes
    /// provider:error then orchestrator:complete and NEVER prompt:complete.
    /// The lane must still complete the turn — this is the only Rust test
    /// that exercises tailer prefilter + reducer + tracker together for the
    /// error path (a reducer-only fix is invisible here).
    #[tokio::test(flavor = "multi_thread")]
    async fn amplifier_events_lane_completes_error_turn_on_orchestrator_complete() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(
            &events_path,
            [
                amplifier_line("session:start"),
                amplifier_line("prompt:submit"),
            ]
            .concat(),
        )
        .unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 2_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("provisional busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t1");

        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        next_frame_matching(&mut rx, "amplifier.activity.updated", 3_000, |v| {
            v["upsert"][0]["sessionId"] == "sess-1"
        })
        .await
        .expect("bind upsert");

        // The turn dies on a provider error: append exactly what the real
        // CLI writes (provider:error is prefilter noise; orchestrator:complete
        // must end the turn).
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&events_path)
            .unwrap();
        f.write_all(
            [
                amplifier_line("provider:error"),
                amplifier_line("orchestrator:complete"),
            ]
            .concat()
            .as_bytes(),
        )
        .unwrap();
        f.flush().unwrap();
        drop(f);

        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 5_000)
            .await
            .expect("turn.complete driven by orchestrator:complete");
        assert_eq!(complete["provider"], "amplifier");
        assert_eq!(complete["sessionId"], "sess-1");
        assert_eq!(complete["completionSeq"], 1);
    }

    /// Steady-state zero-wake proof: idle tracked terminals arm NO timers and
    /// read NO files. (The 20-agents-idle scenario in miniature.)
    #[tokio::test(flavor = "multi_thread")]
    async fn idle_terminals_arm_no_timers_and_read_no_files() {
        let (hub, _rx) = hub();
        for i in 0..20 {
            observer_send(
                &hub,
                ActivityEvent::Created {
                    terminal_id: format!("t{i}"),
                    mode: if i % 2 == 0 { "claude" } else { "codex" }.into(),
                    resume_session_id: None,
                    at: now_ms(),
                },
            );
        }
        // Let the hub settle, then observe a quiet window.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let wakes_before = hub.stats().timer_wakes.load(Ordering::SeqCst);
        let reads_before = hub.stats().tail_reads.load(Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            hub.stats().timer_wakes.load(Ordering::SeqCst),
            wakes_before,
            "20 idle tracked terminals must cause zero timer wakes"
        );
        assert_eq!(
            hub.stats().tail_reads.load(Ordering::SeqCst),
            reads_before,
            "20 idle tracked terminals must cause zero file reads"
        );
        {
            let inner = hub.inner.lock().unwrap();
            assert_eq!(hub_next_deadline(&inner), None, "no deadline while idle");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn catchup_cap_attaches_at_eof_for_oversized_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        // > 4 MiB of pre-filter noise (skipped without parsing — no lifecycle
        // event prefix) followed by a lifecycle record that must NOT be
        // replayed once the cap downgrades the attach to Eof.
        let noise = format!("{{\"noise\":\"{}\"}}\n", "x".repeat(5 * 1024 * 1024));
        std::fs::write(
            &events_path,
            [noise, amplifier_line("prompt:submit")].concat(),
        )
        .unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);

        // The oversized backlog must NOT be replayed: no busy upsert appears.
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 1_500, |v| {
            v["upsert"]
                .as_array()
                .map(|u| u.iter().any(|r| r["phase"] == "busy"))
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_none(), "oversized backlog was replayed: {busy:?}");

        // The lane is LIVE at Eof: a freshly appended record drives busy.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes())
                .unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(
            busy.is_some(),
            "live append after Eof attach did not drive busy"
        );
    }

    #[test]
    fn effective_attach_at_caps_oversized_start_attach() {
        // Missing file (stat failed / not yet created) must NEVER count as
        // over-cap: keep Start and let the first inotify event drive the read.
        assert_eq!(effective_attach_at(AttachAt::Start, None), AttachAt::Start);
        // Exactly at the cap: strict `>` keeps Start (parity with the frozen
        // TS reference, amplifier-activity-integration.ts:318).
        assert_eq!(
            effective_attach_at(AttachAt::Start, Some(AMPLIFIER_CATCHUP_MAX_BYTES)),
            AttachAt::Start
        );
        // One byte over: downgrade to Eof.
        assert_eq!(
            effective_attach_at(AttachAt::Start, Some(AMPLIFIER_CATCHUP_MAX_BYTES + 1)),
            AttachAt::Eof
        );
        // Eof requests are untouched regardless of size.
        assert_eq!(
            effective_attach_at(AttachAt::Eof, Some(AMPLIFIER_CATCHUP_MAX_BYTES + 1)),
            AttachAt::Eof
        );
    }

    #[test]
    fn lane_retry_schedule_caps_and_repeats() {
        // #605: no permanent give-up — past the bounded schedule the lane
        // retries forever at the cap. The crash-semantics bell fires ONCE
        // when the schedule is first exceeded (see note_lane_failure).
        assert_eq!(lane_retry_delay_ms(1), 250);
        assert_eq!(lane_retry_delay_ms(2), 1000);
        assert_eq!(lane_retry_delay_ms(3), 3000);
        assert_eq!(lane_retry_delay_ms(4), AMPLIFIER_LANE_RETRY_CAP_MS);
        assert_eq!(lane_retry_delay_ms(99), AMPLIFIER_LANE_RETRY_CAP_MS);
    }

    #[test]
    fn lane_retry_deadline_feeds_hub_next_deadline() {
        let mut inner = HubInner::default();
        assert_eq!(hub_next_deadline(&inner), None);
        inner.lane_retries.insert(
            "t1".into(),
            LaneRetry {
                session_id: "sess-1".into(),
                events_path: PathBuf::from("/nonexistent/events.jsonl"),
                failures: 1,
                next_attempt_at: Some(12_345),
                bytes_at_degrade: None,
            },
        );
        assert_eq!(hub_next_deadline(&inner), Some(12_345));
        // An in-flight attempt (None) arms no timer — no polling, no busy loop.
        inner.lane_retries.get_mut("t1").unwrap().next_attempt_at = None;
        assert_eq!(hub_next_deadline(&inner), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn degraded_lane_reattaches_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        // Wait for the bind upsert: attach + initial drain are done.
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // The bind upsert is emitted BEFORE the initial drain runs, so wait
        // until the tailer has actually consumed the seed record — the
        // truncation below must land below a NON-ZERO offset to be a reset.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner
                    .lanes
                    .get("t1")
                    .map(|lane| lane.tailer.offset() > 0)
                    .unwrap_or(false)
                {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "initial drain never consumed the seed record"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // Rotation: truncate below the tailer's offset -> FileReset degrade.
        std::fs::write(&events_path, "").unwrap();

        // Bounded backoff: first re-attach fires 250 ms after the degrade.
        // 1.2 s is comfortably past it while far below the 1 s second delay
        // plus margin.
        tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
        {
            let inner = hub.inner.lock().unwrap();
            assert!(
                inner.lanes.contains_key("t1"),
                "lane was not re-attached after FileReset degrade"
            );
        }

        // The recovered lane is LIVE with fresh tailer + reducer state:
        // a new record drives a confirmed busy.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes())
                .unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "recovered lane did not drive busy");

        // An Ok read resets the bookkeeping — no timer leak.
        {
            let inner = hub.inner.lock().unwrap();
            assert!(
                inner.lane_retries.is_empty(),
                "retry state leaked after recovery"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn exhausted_lane_retries_ring_and_keep_retrying() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // #605: the escalation under test rings a BUSY pane — drive a
        // confirmed busy through the events tail BEFORE the failure
        // injection (append-after-attach pattern, see
        // degraded_lane_reattaches_and_recovers). Awaiting the busy upsert
        // orders the drain before the delete below.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes())
                .unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "prompt:submit did not drive busy");

        // Make the path unreadable: delete file AND parent dir so every
        // re-attach stat fails (ReadError on each attempt).
        std::fs::remove_file(&events_path).unwrap();
        std::fs::remove_dir_all(dir.path()).unwrap();

        // (a) The 4th consecutive failure EXCEEDS the bounded schedule
        // (250 + 1000 + 3000 ms) — crash semantics: the busy light clears
        // (idle upsert) and the attention boundary rings a terminal.idle
        // (reason grace) after the gate window. The degrades before it HOLD
        // busy (the confirmed-busy ForceRead is dropped at the Degraded
        // arm), so this is the first idle upsert after the busy above.
        let idle_upsert = next_frame_matching(&mut rx, "amplifier.activity.updated", 15_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(idle_upsert.is_some(), "exhaustion never cleared busy");
        let idle = next_frame_matching(&mut rx, "terminal.idle", 10_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("exhaustion never rang terminal.idle");
        assert_eq!(idle["reason"], "grace");

        // (b) No give-up: the retry entry survives the escalation with the
        // NEXT attempt scheduled at the cap — the timer stays armed.
        {
            let inner = hub.inner.lock().unwrap();
            let retry = inner
                .lane_retries
                .get("t1")
                .expect("retry entry must survive exhaustion");
            assert_eq!(
                retry.failures, 4,
                "the ring fires at the first past-schedule failure"
            );
            let next = retry
                .next_attempt_at
                .expect("a capped retry must stay scheduled");
            assert!(
                next <= now_ms() + AMPLIFIER_LANE_RETRY_CAP_MS,
                "next attempt must be within one cap interval"
            );
            assert_eq!(
                hub_next_deadline(&inner),
                Some(next),
                "the capped retry must keep the hub timer armed"
            );
        }

        // (c) No `amplifier_events_lane_dead` terminal state: restore the
        // events path and the next capped retry re-attaches (Eof); a live
        // append then drives a busy record again — full recovery.
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner.lanes.contains_key("t1") {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "capped retry never re-attached after the path returned"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes())
                .unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "recovered lane did not drive busy again");
    }

    /// #605: `permanent` (deterministic) failures escalate immediately but
    /// KEEP retrying — no give-up arm, no client-visible remove; a later
    /// fixed/replaced events file recovers the lane. In this setup the
    /// tracker is Idle throughout (a bad-schema record never drives busy —
    /// the schema gate degrades before the reducer's event match), so the
    /// immediate escalation's crash semantics no-op: no idle upsert and no
    /// bell here. The busy-pane ring is pinned by
    /// `exhausted_lane_retries_ring_and_keep_retrying`.
    #[tokio::test(flavor = "multi_thread")]
    async fn schema_mismatch_escalates_immediately_and_keeps_retrying() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, bad_schema_line("prompt:submit")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        let before = now_ms();
        // The Start-attach initial drain hits the schema gate immediately.
        hub.attach_amplifier_association("t1", "sess-1", &events_path);

        // (c) `permanent` controls only the immediate escalation, not the
        // delay — the ladder still walks from its first rung (250 ms).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let (failures, next_attempt_at) = loop {
            {
                let inner = hub.inner.lock().unwrap();
                if let Some(retry) = inner.lane_retries.get("t1") {
                    break (retry.failures, retry.next_attempt_at);
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "schema mismatch never scheduled a retry"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        assert_eq!(failures, 1);
        let next = next_attempt_at.expect("first retry must be scheduled");
        assert!(
            next >= before + 250 && next <= now_ms() + 250,
            "the first rung is 250 ms"
        );

        // (a) NO client-visible remove arrives (bounded negative wait).
        let removed = next_frame_matching(&mut rx, "amplifier.activity.updated", 1_000, |v| {
            v["remove"]
                .as_array()
                .map(|r| r.iter().any(|id| id == "t1"))
                .unwrap_or(false)
        })
        .await;
        assert!(
            removed.is_none(),
            "permanent failures must not remove the record (#605)"
        );

        // (b) The tracker record survives — a later fixed/replaced events
        // file can still recover this pane.
        let (records, _) = hub.amplifier_list();
        assert!(
            records.iter().any(|r| r.terminal_id == "t1"),
            "tracker record must survive a permanent lane failure"
        );
    }

    /// #605 gap-loss rule: records appended during a degrade gap are
    /// unverifiable (re-attach is `AttachAt::Eof`). Length grew while we
    /// were blind ⇒ ring-and-clear; length unchanged ⇒ the confirmed-busy
    /// record safely survives the re-attach.
    #[tokio::test(flavor = "multi_thread")]
    async fn degrade_gap_growth_rings_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // Drive a confirmed busy through the events tail. Awaiting the busy
        // upsert also proves the tailer consumed past offset 0, so the
        // truncation below is a real FileReset.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes())
                .unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "prompt:submit did not drive busy");

        // Degrade: truncate below the consumed offset → FileReset. The
        // confirmed busy HOLDS (no idle upsert); the retry entry captures
        // bytes_at_degrade = the truncated length (0).
        std::fs::write(&events_path, "").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner.lane_retries.contains_key("t1") {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "degrade never scheduled a retry"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // Records land while we are blind (the degraded lane's watcher is
        // gone): the file GROWS before the retry window. Content is never
        // read — re-attach is Eof — only the length delta matters.
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        // Ring-and-clear: the re-attach sees the growth, applies crash
        // semantics (idle upsert) and rings terminal.idle (reason grace).
        let idle_upsert = next_frame_matching(&mut rx, "amplifier.activity.updated", 10_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(idle_upsert.is_some(), "gap growth never cleared busy");
        let idle = next_frame_matching(&mut rx, "terminal.idle", 10_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("gap growth never rang terminal.idle");
        assert_eq!(idle["reason"], "grace");

        // The retry re-attached at Eof and its Ok drain cleared the
        // bookkeeping — recovery stays possible.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner.lanes.contains_key("t1") && inner.lane_retries.is_empty() {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "lane never recovered after the gap ring"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // Inverse: no growth during the gap ⇒ the busy record survives the
        // re-attach (nothing was missed — safe hold).
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes())
                .unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "second prompt:submit did not drive busy");
        std::fs::write(&events_path, "").unwrap();
        // Wait for the degrade (lane dropped), then for the re-attach.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if !inner.lanes.contains_key("t1") {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "second truncation never degraded the lane"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner.lanes.contains_key("t1") && inner.lane_retries.is_empty() {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "lane never re-attached after the no-growth degrade"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let (records, _) = hub.amplifier_list();
        let record = records
            .iter()
            .find(|r| r.terminal_id == "t1")
            .expect("record must survive");
        assert_eq!(
            record.phase,
            freshell_protocol::AmplifierPhase::Busy,
            "no-growth re-attach must hold the confirmed busy"
        );
        // And no ring: bounded negative wait for a death/idle bell.
        let ring =
            next_frame_matching(&mut rx, "terminal.idle", 1_000, |v| v["terminalId"] == "t1").await;
        assert!(ring.is_none(), "no-growth re-attach must not ring");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn exit_clears_pending_lane_retry() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // Persistent failure (file + dir gone) so the retry entry stays
        // pending long enough to observe (first delays: 250 ms, 1000 ms).
        std::fs::remove_file(&events_path).unwrap();
        std::fs::remove_dir_all(dir.path()).unwrap();

        // Wait until the degrade lands and a retry entry exists.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner.lane_retries.contains_key("t1") {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "degrade never scheduled a retry"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // Terminal exits while the retry is pending.
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: false,
            },
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let inner = hub.inner.lock().unwrap();
        assert!(inner.lanes.is_empty());
        assert!(
            inner.lane_retries.is_empty(),
            "exit must clear pending lane retries"
        );
        assert_eq!(hub_next_deadline(&inner), None, "timer leaked after exit");
    }

    /// G1 red test: the queued submit arrives BEFORE the BEL (claude
    /// in_flight >= 2). BEL #1 completes turn 1 while the tracker still
    /// reports Busy (busy->busy emits no Changed frame — claude.rs
    /// stacked_submits_need_matching_bels), so the boundary is the ONLY
    /// effect. The gate must not arm; no terminal.idle may fire mid-turn.
    /// The existing queued_prompt_suppresses_terminal_idle test sends its
    /// second submit AFTER the BEL — this is the untested ordering.
    #[tokio::test(flavor = "multi_thread")]
    async fn stacked_submits_before_the_bel_suppress_terminal_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // The second submit is typed BEFORE any BEL: in_flight == 2.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // BEL #1: turn 1 completes, turn 2 still running.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_000)
                .await
                .is_none(),
            "terminal.idle must not fire while the queued turn is still running"
        );
    }

    /// G2: draining the stacked queue emits exactly ONE terminal.idle with
    /// reason queue-empty (evidence recorded at the mid-queue boundary).
    #[tokio::test(flavor = "multi_thread")]
    async fn draining_stacked_submits_emits_one_queue_empty_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        for _ in 0..2 {
            observer_send(
                &hub,
                ActivityEvent::Input {
                    terminal_id: "t1".into(),
                    data: "\r".into(),
                    at: now_ms(),
                },
            );
        }
        for _ in 0..2 {
            observer_send(
                &hub,
                ActivityEvent::Output {
                    terminal_id: "t1".into(),
                    data: "\u{07}".into(),
                    at: now_ms(),
                },
            );
        }
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle after the queue drains");
        assert_eq!(idle["reason"], "queue-empty");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one emission per busy->truly-idle transition"
        );
    }

    /// Codex PTY-ONLY lane: REGRESSION GUARD (deviation note 3). Without a
    /// rollout-reconcile lane attached, the tracker never surfaces a Busy
    /// phase (PTY output without a BEL emits no effects, and the queued
    /// re-arm at the turn clear stays Pending and is publicly SILENT --
    /// pending->pending is suppressed by has_public_change; pinned by the
    /// codex.rs tracker tests). So NO queue evidence can accrue from the
    /// PTY lane alone: the drain arms the gate normally and emits exactly
    /// one idle with reason 'grace'.
    ///
    /// With the rollout lane attached (the codex-status-completeness work),
    /// CodexPhase::Busy IS reachable and the busy->pending re-arm counts as
    /// queue evidence -- the hub-level proof is
    /// codex_rollout_busy_rearm_drains_to_a_single_queue_empty_idle below;
    /// the gate side is pinned by
    /// idle::tests::codex_busy_to_pending_rearm_counts_as_queue_evidence.
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_queued_rearm_drains_to_a_single_grace_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        // Turn 1 submitted -> Pending.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // Streaming output is publicly INERT for codex (refreshes
        // last_observed_at only; no phase promotion, no effects).
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "working on it...".into(),
                at: now_ms(),
            },
        );
        // Queued submit while Pending (goes into the tracker's submit queue;
        // publicly silent).
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // BEL #1: turn clear consumes the queued submit -> stays Pending;
        // pending->pending is suppressed, so NO public Changed and NO
        // completion (no queue evidence can reach the gate).
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        // BEL #2: queue empty -> Idle + completion -> the gate arms.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle after the codex queue drains");
        assert_eq!(
            idle["reason"], "grace",
            "codex queue evidence is unreachable from the PTY lane alone (deviation note 3)"
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one emission for the codex drain"
        );
    }

    /// SEMANTIC CHANGE (attention-bell plan 2026-08-01): failed turns now ring.
    /// PROXY-lane queued-then-failed -- the hub-level mirror of the tracker
    /// test `failed_with_queued_submit_behaves_exactly_like_completed_with_queued_submit`
    /// (freshell-activity codex.rs): a submit queued while turn 1 is busy
    /// auto-submits as turn 2 when turn 1 FAILS; turn 2's start lands inside
    /// turn 1's grace window and cancels the pending emission (the queued
    /// submit suppresses the immediate ring), so only the final drain rings:
    /// exactly ONE terminal.idle with reason 'grace' (the proxy lane never
    /// re-arms busy->pending, so no queue evidence accrues). BOTH completions
    /// are 'failed': with the old record predicate (failed = silent claim) no
    /// completion is ever minted and NO terminal.idle arrives at all.
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_failed_turn_rings_and_queued_failed_drains_to_a_single_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-1".into()),
                at: now_ms(),
            },
        );
        // Initial idle upsert (session bound at create).
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");

        // Turn 1 starts on the proxy lane -> Busy.
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("turn-1 busy upsert");

        // Queue a submit while busy (goes into the tracker's submit queue).
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "do the next thing\r".into(),
                at: now_ms(),
            },
        );

        // Turn 1 FAILS. The flipped predicate records a completion and arms
        // the grace window (the old predicate claimed silently: nothing in
        // this test would ever ring).
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), Some("failed"), true);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("turn-1 failed clear upsert");

        // Distinct-ms guard: proxy turn keys are last_proxy_started_at
        // stamped with now_ms() on the hub task; a same-millisecond second
        // start would collide with the per-turn dedupe
        // (last_emitted_turn_key) and swallow turn 2's completion.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // The queued message auto-submits as turn 2 INSIDE turn 1's grace
        // window: the busy re-entry cancels the pending emission -- the
        // queued submit suppresses turn 1's immediate ring.
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-2"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("turn-2 busy upsert");

        // Turn 2 also FAILS -> the queue has drained: one completion, the
        // gate re-arms, and the lapsed grace window emits exactly one idle.
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-2"), Some("failed"), true);
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle after the queued-failed sequence drains");
        assert_eq!(
            idle["reason"], "grace",
            "no busy->pending re-arm on the proxy lane => no queue evidence => grace"
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "turn-1's suppressed window must not produce a second idle"
        );
    }

    /// Plain failed turn (no queue): failed status now records a completion
    /// and the gate arms, emitting exactly one terminal.idle.
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_failed_turn_emits_terminal_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-1".into()),
                at: crate::terminal::now_ms(),
            },
        );
        // Initial idle upsert (session bound at create).
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t"
        })
        .await
        .expect("initial idle upsert");

        // Exercise: proxy turn lane with failed status.
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), None, false); // started
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), Some("failed"), true); // failed

        // Assert: busy→idle transition via activity update.
        let busy = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await
        .expect("busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t");

        // Assert: at least one codex.activity.updated showing idle phase (from failed).
        let idle_upsert = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t" && r["phase"] == "idle")
                })
                .unwrap_or(false)
        })
        .await
        .expect("idle upsert");
        assert_eq!(idle_upsert["upsert"][0]["terminalId"], "t");

        // Assert: exactly ONE terminal.idle frame (failed now records a completion).
        let _idle = next_frame_of_type(&mut rx, "terminal.idle", 3_000)
            .await
            .expect("terminal.idle on failed turn");

        // Assert: no second terminal.idle frame.
        let no_second = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_of_type(&mut rx, "terminal.idle", 3_000),
        )
        .await;
        assert!(
            no_second.is_err(),
            "must emit exactly one terminal.idle, not a duplicate"
        );
    }

    /// INTERACTION (idle-gate x codex-status-completeness): with the rollout
    /// lane attached, CodexPhase::Busy is reachable, so the busy->pending
    /// re-arm at a reconciled turn clear DOES accrue queue evidence -- the
    /// eventual drain must emit exactly one terminal.idle with reason
    /// 'queue-empty' (not 'grace'), the reconciled clear must stamp exactly
    /// one completion, and the swallowed PTY BEL echo must not double-chime.
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_rollout_busy_rearm_drains_to_a_single_queue_empty_idle() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout shows an unresolved turn -> reconcile seeds Busy.
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("seeded busy upsert");

        // Queued submit while Busy (PTY lane): goes into the submit queue.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );

        // Turn 1 completes on disk -> inotify -> drain: the queued submit is
        // consumed at the clear (busy->pending re-arm = queue evidence), the
        // mid-queue chime is SUPPRESSED (record_completion_if_idle stamps
        // only when the resulting phase is Idle), and the next PTY BEL echo
        // is armed to be swallowed.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_complete", now + 1_000)).expect("write");
        }
        next_frame_matching(&mut rx, "codex.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "pending"
        })
        .await
        .expect("busy->pending re-arm upsert after the reconciled clear");
        assert!(
            next_frame_of_type(&mut rx, "terminal.turn.complete", 1_000)
                .await
                .is_none(),
            "no mid-queue chime: the re-arm clear must not stamp a completion"
        );

        // Late PTY BEL echo of the reconciled clear: swallowed one-shot (no
        // transition, no completion -- the no-double-chime half).
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        // Queued turn 2 ends via a real PTY BEL: queue empty -> Idle +
        // completion #2 -> the gate arms.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "terminal.turn.complete", 5_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("one completion for the queued turn 2 drain");

        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle after the codex queue drains");
        assert_eq!(idle["terminalId"], "t1");
        assert_eq!(
            idle["reason"], "queue-empty",
            "busy->pending re-arm via the rollout lane must count as queue evidence"
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one idle emission for the combined drain"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bind_codex_session_broadcasts_identity_and_stamps_completions() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: crate::terminal::now_ms(),
            },
        );
        // Initial idle upsert (no sessionId -- the G3 gap state).
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");

        // Bind: a fresh terminal's adopted candidate identity arrives.
        hub.bind_codex_session("t1", "thread-1");
        let bound = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["sessionId"] == "thread-1"
        })
        .await
        .expect("bind upsert carries sessionId");
        assert_eq!(bound["upsert"][0]["terminalId"], "t1");

        // Payoff: a subsequent turn's completion carries the session id.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: crate::terminal::now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: crate::terminal::now_ms(),
            },
        );
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("turn complete");
        assert_eq!(complete["sessionId"], "thread-1");
        assert_eq!(complete["provider"], "codex");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_turn_events_reach_the_codex_tracker_and_emit_turn_complete() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t".into(),
                mode: "codex".into(),
                // kata codex-turn-thread-scope: the proxy lane is thread-
                // scoped, so this test binds the thread at create (the
                // resume path); unbound terminals now ignore proxy turns.
                resume_session_id: Some("thread-1".into()),
                at: crate::terminal::now_ms(),
            },
        );
        // Initial idle upsert (session bound at create).
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t"
        })
        .await
        .expect("initial idle upsert");

        // Exercise: proxy turn lane.
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), None, false); // started
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), Some("completed"), true); // completed
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), Some("completed"), true); // duplicate echo — must not double

        // Assert: busy→idle transition via activity update.
        let busy = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await
        .expect("busy upsert");
        assert_eq!(busy["upsert"][0]["terminalId"], "t");

        // Assert: at least one codex.activity.updated showing idle phase (from completed).
        let idle = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t" && r["phase"] == "idle")
                })
                .unwrap_or(false)
        })
        .await
        .expect("idle upsert");
        assert_eq!(idle["upsert"][0]["terminalId"], "t");

        // Assert: exactly ONE terminal.turn.complete frame.
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "t"
        })
        .await
        .expect("turn complete");
        assert_eq!(complete["provider"], "codex");

        // Assert: no second terminal.turn.complete frame (duplicate echo must not double).
        let no_second = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "t"
            }),
        )
        .await;
        assert!(
            no_second.is_err(),
            "must emit exactly one turn.complete, not a duplicate"
        );
    }

    /// Write a rollout line and return the (dir-guard, path).
    fn codex_rollout_fixture(lines: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout-2026-07-25T08-00-00-sess-1.jsonl");
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write rollout");
        (dir, path)
    }

    fn codex_event_line(payload_type: &str, at_ms: i64) -> String {
        format!(
            r#"{{"timestamp":{at_ms},"type":"event_msg","payload":{{"type":"{payload_type}"}}}}"#
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn codex_rollout_lane_seeds_busy_then_clears_via_inotify() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout shows an unresolved turn (restored mid-turn).
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);

        // Resume-busy seeding: initial drain promotes to busy.
        let busy = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("seeded busy upsert");
        assert_eq!(busy["upsert"][0]["sessionId"], "sess-1");

        // The turn completes on disk -> inotify -> drain -> idle + completion.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_complete", now + 1_000)).expect("write");
        }
        let idle = next_frame_matching(&mut rx, "codex.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("idle upsert after task_complete");
        assert_eq!(idle["upsert"][0]["terminalId"], "t1");
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 5_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("turn complete from the reconcile lane");
        assert_eq!(complete["sessionId"], "sess-1");
        assert_eq!(complete["provider"], "codex");
    }

    /// KATA namg: a missed inotify event must not silence
    /// terminal.turn.complete forever. Deterministic simulation of the miss:
    /// unwatch the lane's inotify watch BEFORE the task_complete append (the
    /// append then emits no fs event -- exactly the shape of a kernel queue
    /// overflow dropping the last append of a turn), and assert the
    /// busy-deadman force-read (shrunk to test scale) still delivers the
    /// completion -- exactly once, with exactly one idle chime after it
    /// (idle-gate interaction pin: a ForceRead-triggered late completion
    /// must not double-chime and must carry the correct idle reason).
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_missed_fs_event_self_heals_via_deadman_force_read() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout shows an unresolved turn: the lane seeds busy on attach.
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("seeded busy upsert");

        // Simulate the missed event + shrink the deadman to test scale.
        {
            use notify::Watcher;
            let mut inner = hub.inner.lock().unwrap();
            inner.codex.set_busy_deadman_ms(500);
            let lane = inner.codex_lanes.get_mut("t1").expect("lane installed");
            lane._watcher.unwatch(&rollout).expect("unwatch");
        }

        // The turn completes on disk -- but with the watch dropped, NO
        // CodexFsChange will ever arrive for this append.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_complete", now + 1_000)).expect("write");
        }

        // Barrier: the hub loop recomputes its one-shot deadline only when
        // it processes an event, and it is currently parked on the deadline
        // computed BEFORE the shrink. Any event re-arms it.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t2".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: crate::terminal::now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t2"
        })
        .await
        .expect("barrier upsert for t2");

        // RED today: without the expire_due force-read drain this NEVER
        // arrives (the missed append is re-read by nothing).
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 10_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("turn complete delivered by the deadman force-read");
        assert_eq!(complete["provider"], "codex");
        assert_eq!(complete["sessionId"], "sess-1");

        // Exactly one chime.
        assert!(
            next_frame_matching(&mut rx, "terminal.turn.complete", 1_000, |v| {
                v["terminalId"] == "t1"
            })
            .await
            .is_none(),
            "the self-healed completion must not double-chime"
        );

        // Idle-gate interaction: one idle, correct reason (no queued
        // submits in this flow -> grace).
        let idle =
            next_frame_matching(&mut rx, "terminal.idle", 5_000, |v| v["terminalId"] == "t1")
                .await
                .expect("terminal.idle after the self-healed completion");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_matching(&mut rx, "terminal.idle", 1_000, |v| {
                v["terminalId"] == "t1"
            })
            .await
            .is_none(),
            "exactly one idle emission"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn codex_lane_is_torn_down_on_exit() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        let (_guard, rollout) = codex_rollout_fixture(&[codex_event_line("task_started", now)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: crate::terminal::now_ms(),
                spontaneous: false,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["remove"][0] == "t1"
        })
        .await
        .expect("remove on exit");
        let lanes = hub.inner.lock().unwrap().codex_lanes.len();
        assert_eq!(lanes, 0, "exit drops the lane (and its inotify watcher)");
    }

    /// The resume-path locator runs on a blocking thread; a terminal that
    /// exits inside that window has its Exit processed BEFORE the deferred
    /// CodexAttach lands. The attach must not install a lane for the exited
    /// terminal: nothing would ever remove it (leaked inotify watcher).
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_attach_after_exit_installs_no_zombie_lane() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now,
                spontaneous: false,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["remove"][0] == "t1"
        })
        .await
        .expect("remove on exit");

        // The deferred attach arrives after the exit was processed.
        let (_guard, rollout) = codex_rollout_fixture(&[codex_event_line("task_started", now)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);

        // Registry events and CodexAttach share the single hub channel, so a
        // later Created's frame proves the attach was already processed.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t2".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t2"
        })
        .await
        .expect("barrier upsert for t2");

        let lanes = hub.inner.lock().unwrap().codex_lanes.len();
        assert_eq!(lanes, 0, "attach after exit must not install a zombie lane");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resume_created_codex_terminal_attaches_the_rollout_lane_via_locator() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        let rollout_for_locator = rollout.clone();
        hub.set_codex_rollout_locator(Arc::new(move |session_id: &str| {
            (session_id == "sess-1").then(|| rollout_for_locator.clone())
        }));

        // A restored codex terminal is a normal create carrying the resume id.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );

        // The lane attaches and the initial drain seeds busy: the restored
        // mid-turn terminal is blue, not lying idle/green (the G9 headline).
        let busy = next_frame_matching(&mut rx, "codex.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("resume-busy seeding via the locator-attached lane");
        assert_eq!(busy["upsert"][0]["sessionId"], "sess-1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn foreign_thread_proxy_completion_does_not_ring() {
        // Regression pin for spike scenario D at the hub seam: a sub-agent
        // child thread's turn/completed mid-parent-turn must not emit
        // terminal.turn.complete (and therefore can never arm the IdleGate).
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-parent".into()),
                at: crate::terminal::now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t"
        })
        .await
        .expect("initial upsert");

        hub.note_codex_proxy_turn("t", "thread-parent", Some("turn-parent"), None, false);
        // Sub-agent child thread completes while the parent turn runs.
        hub.note_codex_proxy_turn(
            "t",
            "thread-child",
            Some("turn-child"),
            Some("completed"),
            true,
        );

        let premature = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "t"
            }),
        )
        .await;
        assert!(
            premature.is_err(),
            "a sub-agent thread completion must not ring"
        );

        // The parent's real completion still rings.
        hub.note_codex_proxy_turn(
            "t",
            "thread-parent",
            Some("turn-parent"),
            Some("completed"),
            true,
        );
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "t"
        })
        .await
        .expect("parent turn complete");
        assert_eq!(complete["provider"], "codex");
        assert_eq!(complete["sessionId"], "thread-parent");
    }

    // ---- Approval pauses (attention bell, Task 7) ----

    /// Shared setup: a codex terminal bound to thread-1, driven to CONFIRMED
    /// busy via the proxy turn lane.
    async fn busy_codex_terminal(
        hub: &ActivityHub,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
    ) {
        observer_send(
            hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-1".into()),
                at: now_ms(),
            },
        );
        next_frame_matching(rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), None, false);
        next_frame_matching(rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");
    }

    /// An approval request pauses the turn: the pane flips to the EXISTING
    /// not-busy phase, the gate arms, and exactly ONE terminal.idle rings
    /// after the 2s grace — never a second.
    #[tokio::test(flavor = "multi_thread")]
    async fn approval_request_rings_once_after_grace() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;

        hub.note_codex_approval("t1", Some("thread-1"), "41", true);
        let paused = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("approval pause maps to the existing not-busy phase");
        assert_eq!(paused["upsert"][0]["terminalId"], "t1");

        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle for the approval pause");
        assert_eq!(idle["terminalId"], "t1");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one terminal.idle per approval pause"
        );
    }

    /// A SENT request answered quickly stays silent: the resolve restores
    /// Busy within the grace, cancelling the pending bell.
    #[tokio::test(flavor = "multi_thread")]
    async fn approval_answered_within_grace_stays_silent() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;

        hub.note_codex_approval("t1", Some("thread-1"), "41", true);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("pause upsert");
        // Answered immediately (resolves carry no threadId on the wire).
        hub.note_codex_approval("t1", None, "41", false);
        let resumed = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("resolve restores busy");
        assert_eq!(resumed["upsert"][0]["terminalId"], "t1");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_500)
                .await
                .is_none(),
            "an approval answered within the grace must stay silent"
        );
    }

    /// Queued input does NOT suppress approval bells — the pane is still
    /// blocked on the human.
    #[tokio::test(flavor = "multi_thread")]
    async fn queued_input_does_not_suppress_the_approval_bell() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;

        // Submit-shaped input while Busy: queued behind the running turn.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "queued message\r".into(),
                at: now_ms(),
            },
        );
        hub.note_codex_approval("t1", Some("thread-1"), "41", true);
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("queued input must not suppress the approval bell");
        assert_eq!(idle["terminalId"], "t1");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "still exactly one terminal.idle"
        );
    }

    /// Audit A9: a rollout reconcile whose newest event is the turn's own
    /// task_started lands MID-PAUSE — it must not flip the pane Busy (which
    /// would cancel the armed approval bell at the gate).
    #[tokio::test(flavor = "multi_thread")]
    async fn reconcile_tick_during_a_pending_approval_does_not_cancel_the_armed_bell() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout lane attached with no unresolved turn yet.
        let (_guard, rollout) = codex_rollout_fixture(&[]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        // Proxy lane drives the confirmed busy.
        hub.note_codex_proxy_turn("t1", "sess-1", Some("turn-1"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");

        hub.note_codex_approval("t1", Some("sess-1"), "41", true);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("pause upsert");

        // BEFORE the 2s grace elapses: the turn's own task_started reaches
        // the rollout fold via inotify.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_started", now_ms())).expect("write");
        }
        // No Busy-phase upsert may be emitted mid-pause.
        assert!(
            next_frame_matching(&mut rx, "codex.activity.updated", 1_000, |v| {
                v["upsert"][0]["phase"] == "busy"
            })
            .await
            .is_none(),
            "a mid-pause reconcile promotion must not flip the pane busy"
        );
        // The armed approval bell still rings after the grace.
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("the reconcile tick must not cancel the armed approval bell");
        assert_eq!(idle["terminalId"], "t1");

        // The resolve restores Busy (deferred promotion).
        hub.note_codex_approval("t1", None, "41", false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("resolve restores busy after the deferred promotion");
    }

    /// One bell per episode: an approval pause rings once; the turn then
    /// completes MID-PAUSE (the approval is never resolved) and the codex
    /// TUI's turn-complete BEL echoes on the PTY. Neither the mid-pause
    /// turn/completed (Idle-arm silent claim) nor the BEL echo (armed
    /// swallow) may mint a second terminal.idle.
    #[tokio::test(flavor = "multi_thread")]
    async fn mid_pause_turn_end_and_bel_echo_ring_exactly_once_per_episode() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout lane attached; proxy lane drives the confirmed busy.
        let (_guard, rollout) = codex_rollout_fixture(&[]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        hub.note_codex_proxy_turn("t1", "sess-1", Some("turn-1"), None, false);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy upsert");

        hub.note_codex_approval("t1", Some("sess-1"), "41", true);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("pause upsert");

        // The turn's own task_started folds MID-PAUSE (audit A9): the
        // accepted anchor lands without flipping busy.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_started", now_ms())).expect("write");
        }
        assert!(
            next_frame_matching(&mut rx, "codex.activity.updated", 1_000, |v| {
                v["upsert"][0]["phase"] == "busy"
            })
            .await
            .is_none(),
            "the mid-pause fold must not flip the pane busy"
        );

        // The ONE bell of the episode: the armed approval boundary.
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("the approval bell rings once");
        assert_eq!(idle["terminalId"], "t1");

        // The turn ends while the approval is still pending, then the TUI's
        // turn-complete BEL echoes on the PTY.
        hub.note_codex_proxy_turn("t1", "sess-1", Some("turn-1"), Some("completed"), true);
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_500)
                .await
                .is_none(),
            "exactly ONE terminal.idle for the whole episode -- the mid-pause \
             turn end and its BEL echo must not re-ring"
        );
    }

    /// Decision 3 / audit A10: a pane blocked on an approval whose process
    /// dies spontaneously rings — even AFTER the armed deadline already rang
    /// (pending_approvals counts as death-bell engagement).
    #[tokio::test(flavor = "multi_thread")]
    async fn spontaneous_exit_during_a_pending_approval_rings() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;

        hub.note_codex_approval("t1", Some("thread-1"), "41", true);
        // Let the grace elapse: the approval bell rings (deadline now spent,
        // phase not busy).
        let first = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("approval bell");
        assert_eq!(first["terminalId"], "t1");

        // The process dies while still blocked on the approval.
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let second = next_frame_of_type(&mut rx, "terminal.idle", 3_000)
            .await
            .expect("death bell: pending approvals count as engagement");
        assert_eq!(second["terminalId"], "t1");
    }

    // ---- Stop-start silence (Stage 2: LB-37) ----

    /// A requested stop drops a grace window that was already armed: no
    /// `terminal.idle` after the grace, and the stop's own non-spontaneous
    /// exit at Gone emits nothing either.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stop_request_drops_an_armed_grace_window() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), Some("completed"), true);
        next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("the turn completed (and armed the grace window) before the stop");

        hub.note_stop_requested("t1");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_000)
                .await
                .is_none(),
            "a stop request drops the armed grace window"
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: false,
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 500)
                .await
                .is_none(),
            "the stop's exit at Gone rings nothing"
        );
    }

    /// After a stop request, neither a completed turn nor an approval pause
    /// produces a `terminal.turn.complete` or a `terminal.idle`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_boundary_after_a_stop_request_never_arms() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;

        hub.note_stop_requested("t1");
        hub.note_codex_proxy_turn("t1", "thread-1", Some("turn-1"), Some("completed"), true);
        hub.note_codex_approval("t1", Some("thread-1"), "41", true);
        assert!(
            next_frame_matching(&mut rx, "terminal.turn.complete", 1_000, |v| {
                v["terminalId"] == "t1"
            })
            .await
            .is_none(),
            "no turn.complete for a stopping terminal"
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_000)
                .await
                .is_none(),
            "no boundary arms the grace window of a stopping terminal"
        );
    }

    /// The crash path is untouched: an engaged terminal that dies on its own
    /// without any stop request still rings the death bell.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_crash_without_a_stop_request_still_rings() {
        let (hub, mut rx) = hub();
        busy_codex_terminal(&hub, &mut rx).await;
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_000)
            .await
            .expect("an engaged terminal's crash rings the death bell");
        assert_eq!(idle["terminalId"], "t1");
    }

    // ---- OpenCode lane (attention bell, Task 8) ----

    /// Shared setup: an opencode terminal created with a resume identity
    /// ("ses-root"), a dummy generation-1 lanes-map entry, and a gen-1 busy
    /// edge for the known root — CONFIRMED busy (`KnownBusy`).
    async fn busy_opencode_terminal(
        hub: &ActivityHub,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
    ) {
        observer_send(
            hub,
            ActivityEvent::Created {
                terminal_id: "t-oc".into(),
                mode: "opencode".into(),
                resume_session_id: Some("ses-root".into()),
                at: 1_000,
            },
        );
        hub.register_opencode_lane_for_tests("t-oc", 1); // dummy lanes-map entry: generation 1 passes ingress
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-root".into(),
                status: OpencodeStatus::Busy,
            },
        );
        let frame = next_frame_matching(rx, "opencode.activity.updated", 1_500, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await;
        assert!(frame.is_some(), "expected the busy upsert");
    }

    /// Assert that NOTHING attention-relevant (`terminal.turn.complete` or
    /// `terminal.idle`) is broadcast within `timeout_ms`. Unlike two
    /// sequential `next_frame_of_type(..).is_none()` waits, a single pass
    /// cannot mask one frame type by consuming it while waiting for the
    /// other.
    async fn assert_no_attention_frames(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        timeout_ms: u64,
    ) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value =
                        serde_json::from_str(&frame).expect("frame json");
                    assert!(
                        value["type"] != "terminal.turn.complete"
                            && value["type"] != "terminal.idle",
                        "expected attention silence, got {frame}"
                    );
                }
                _ => return,
            }
        }
    }

    /// D7: the owned root's idle edge ends the turn — remove frame, then
    /// terminal.turn.complete{provider:"opencode"}, then exactly ONE
    /// terminal.idle{reason:"grace"} after the 2s grace. The deprecated
    /// `session.idle` twin landing second mints nothing (structural dedupe,
    /// D2: the first edge lands the machine in Quiet).
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_completed_turn_rings_once_after_grace() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 1_500)
            .await
            .expect("turn complete for the owned root's idle edge");
        assert_eq!(complete["provider"], "opencode");
        assert_eq!(complete["terminalId"], "t-oc");
        assert_eq!(complete["sessionId"], "ses-root");

        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("exactly one terminal.idle after the grace");
        assert_eq!(idle["terminalId"], "t-oc");
        assert_eq!(idle["reason"], "grace");

        // The deprecated twin idle edge lands second: nothing further.
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        assert_no_attention_frames(&mut rx, 1_500).await;
    }

    /// D1: a human abort (`MessageAbortedError` on the owned root's own
    /// turn) clears busy silently — no completion, no bell, even after the
    /// grace would have elapsed, and the double idle edge stays silent too.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_abort_stays_silent() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionError {
                session_id: "ses-root".into(),
                error_name: "MessageAbortedError".into(),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        // 3_500ms covers the 2s grace: a wrongly armed bell would have rung.
        assert_no_attention_frames(&mut rx, 3_500).await;
    }

    /// D1: failed turns ring like completed turns — a non-abort error is a
    /// no-op and the following idle edge completes the turn. A trailing
    /// error on the quiet state mints nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_failed_turn_rings() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionError {
                session_id: "ses-root".into(),
                error_name: "UnknownError".into(),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 1_500)
            .await
            .expect("a failed turn still completes");
        assert_eq!(complete["provider"], "opencode");
        assert_eq!(complete["terminalId"], "t-oc");

        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("one terminal.idle for the failed turn");
        assert_eq!(idle["terminalId"], "t-oc");
        assert_eq!(idle["reason"], "grace");

        // Trailing error after the idle edge: quiet state, nothing minted.
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionError {
                session_id: "ses-root".into(),
                error_name: "UnknownError".into(),
            },
        );
        assert_no_attention_frames(&mut rx, 1_500).await;
    }

    /// D3: (a) an unanswered permission ask demotes the record and rings
    /// exactly once after the grace; (b) an ask answered within the grace
    /// restores busy and stays silent.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_permission_pause_rings_once_and_reply_within_grace_is_silent() {
        // (a) unanswered ask: one bell after the grace, never a second.
        let (hub_a, mut rx_a) = hub();
        busy_opencode_terminal(&hub_a, &mut rx_a).await;
        hub_a.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-root".into(),
                permission_id: "perm-1".into(),
            },
        );
        let removed = next_frame_matching(&mut rx_a, "opencode.activity.updated", 1_500, |v| {
            v["remove"][0] == "t-oc"
        })
        .await;
        assert!(removed.is_some(), "the pause demotes the busy record (D7)");
        let idle = next_frame_of_type(&mut rx_a, "terminal.idle", 3_500)
            .await
            .expect("the unanswered ask rings after the grace");
        assert_eq!(idle["terminalId"], "t-oc");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_of_type(&mut rx_a, "terminal.idle", 1_500)
                .await
                .is_none(),
            "exactly one bell per pause"
        );

        // (b) ask answered within the grace: busy restored, total silence.
        let (hub_b, mut rx_b) = hub();
        busy_opencode_terminal(&hub_b, &mut rx_b).await;
        hub_b.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-root".into(),
                permission_id: "perm-1".into(),
            },
        );
        hub_b.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionReplied {
                permission_id: "perm-1".into(),
            },
        );
        let resumed = next_frame_matching(&mut rx_b, "opencode.activity.updated", 1_500, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await;
        assert!(resumed.is_some(), "the reply restores the busy record");
        assert!(
            next_frame_of_type(&mut rx_b, "terminal.idle", 3_500)
                .await
                .is_none(),
            "an ask answered within the grace must stay silent"
        );
    }

    /// D3: children CAN ask — the permission event is stamped with the
    /// CHILD session id while the parent turn blocks on it, so the asker
    /// root-resolves onto the owned root and the pause rings.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_child_permission_asked_arms_via_root_resolution() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionCreated {
                session_id: "ses-child".into(),
                parent_id: Some("ses-root".into()),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-child".into(),
                permission_id: "perm-1".into(),
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("the child's ask root-resolves and pauses the root (D3)");
        assert_eq!(idle["terminalId"], "t-oc");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "exactly one bell for the child's ask"
        );
    }

    /// D3 first-turn arming (#609: the busy edge binds directly, KnownBusy):
    /// a first-turn ask (no resume identity) rings. The turn then ends
    /// mid-pause — the completion is swallowed at the idle edge (the pause
    /// was the episode's bell), and a trailing locator/plugin bind stays
    /// silent too.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_first_turn_permission_pause_rings() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t-oc".into(),
                mode: "opencode".into(),
                resume_session_id: None,
                at: 1_000,
            },
        );
        hub.register_opencode_lane_for_tests("t-oc", 1);
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-new".into(),
                status: OpencodeStatus::Busy,
            },
        );
        let busy = next_frame_matching(&mut rx, "opencode.activity.updated", 1_500, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await;
        assert!(busy.is_some(), "candidate busy upsert");

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-new".into(),
                permission_id: "perm-1".into(),
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("candidate arming (D3): first-turn asks must ring");
        assert_eq!(idle["terminalId"], "t-oc");

        // Turn end mid-pause, then the identity proof: the deferred
        // completion is swallowed — NO terminal.turn.complete.
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-new".into(),
            },
        );
        hub.bind_opencode_session("t-oc", "ses-new");
        assert_no_attention_frames(&mut rx, 1_500).await;
    }

    /// #609 inversion (deliberate, not a regression): a restore-created
    /// opencode terminal WITHOUT resume identity goes busy for `ses-x` on
    /// its OWN per-pane lane — identity confirms by construction
    /// (KnownBusy), so the idle edge mints the completion IMMEDIATELY:
    /// terminal.turn.complete{provider:"opencode"} then exactly ONE
    /// terminal.idle{reason:"grace"}. No bind_opencode_session step — the
    /// D3 deferred-completion contract no longer applies to lane busy
    /// edges (`bind_opencode_session` remains for the locator/plugin
    /// producers, covered by `bind_session`'s tracker tests).
    #[tokio::test(flavor = "multi_thread")]
    async fn restore_created_opencode_terminal_completes_first_turn_directly() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t-oc".into(),
                mode: "opencode".into(),
                resume_session_id: None,
                at: 1_000,
            },
        );
        hub.register_opencode_lane_for_tests("t-oc", 1);
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-x".into(),
                status: OpencodeStatus::Busy,
            },
        );
        let busy = next_frame_matching(&mut rx, "opencode.activity.updated", 1_500, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await;
        assert!(busy.is_some(), "first-turn busy upsert (KnownBusy, #609)");

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-x".into(),
            },
        );
        // First-turn end: the completion mints immediately (#609).
        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 1_500)
            .await
            .expect("the first turn's idle edge completes directly (#609)");
        assert_eq!(complete["terminalId"], "t-oc");
        assert_eq!(complete["provider"], "opencode");
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("one grace idle after the completion");
        assert_eq!(idle["terminalId"], "t-oc");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "exactly one terminal.idle for the completion"
        );
    }

    /// D1 + D3: an abort landing mid-pause force-emits the cancel — the
    /// armed pause window dies with it, total silence even after the grace.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_mid_pause_abort_is_fully_silent() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-root".into(),
                permission_id: "perm-1".into(),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionError {
                session_id: "ses-root".into(),
                error_name: "MessageAbortedError".into(),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        // 3_500ms covers the grace: the armed pause bell must be cancelled.
        assert_no_attention_frames(&mut rx, 3_500).await;
    }

    /// D4: spontaneous death while KnownBusy rings IMMEDIATELY (no grace —
    /// a dead process emits nothing further, so nothing could cancel it).
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_spontaneous_death_while_busy_rings_immediately() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t-oc".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        // Well inside the 2s grace window: proves the immediate path.
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 1_500)
            .await
            .expect("immediate death bell for a spontaneous exit while busy");
        assert_eq!(idle["terminalId"], "t-oc");
        assert_eq!(idle["reason"], "grace");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "exactly one terminal.idle for the death"
        );
    }

    /// #609: an opencode pane's FIRST turn is death-eligible — a busy
    /// root on the pane's own lane confirms identity by construction.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_first_turn_spontaneous_exit_rings() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "opencode".into(),
                resume_session_id: None,
                at: 1_000,
            },
        );
        hub.register_opencode_lane_for_tests("t1", 1);
        hub.note_opencode_lane_event(
            "t1",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-x".into(),
                status: OpencodeStatus::Busy,
            },
        );
        let busy = next_frame_matching(&mut rx, "opencode.activity.updated", 1_500, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await;
        assert!(busy.is_some(), "first-turn busy upsert (KnownBusy, #609)");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle =
            next_frame_matching(&mut rx, "terminal.idle", 1_500, |v| v["terminalId"] == "t1")
                .await
                .expect("first-turn death rings — identity confirmed by construction (#609)");
        assert_eq!(idle["reason"], "grace");
    }

    /// #609 inverse guard: two busy roots still demote to Ambiguous, and
    /// Ambiguous ownership never death-rings — D4's remaining gate on the
    /// lane path stays pinned.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_ambiguous_exit_stays_silent() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "opencode".into(),
                resume_session_id: None,
                at: 1_000,
            },
        );
        hub.register_opencode_lane_for_tests("t1", 1);
        hub.note_opencode_lane_event(
            "t1",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-a".into(),
                status: OpencodeStatus::Busy,
            },
        );
        hub.note_opencode_lane_event(
            "t1",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-b".into(),
                status: OpencodeStatus::Busy,
            },
        );
        // The second busy root demotes the record to session-less
        // (Ambiguous): wait for it so the Exit cannot race the demotion.
        let demoted = next_frame_matching(&mut rx, "opencode.activity.updated", 1_500, |v| {
            v["upsert"][0]["phase"] == "busy" && v["upsert"][0]["sessionId"].is_null()
        })
        .await;
        assert!(
            demoted.is_some(),
            "ambiguous demotes to a session-less record"
        );

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 300)
                .await
                .is_none(),
            "an ambiguous death must stay silent (D4)"
        );
    }

    /// An idle quiet pane is silent on spontaneous exit; a
    /// freshell-initiated kill (spontaneous=false) is silent even mid-turn.
    /// (#609: the former candidate death-silence sections are superseded on
    /// the lane path — `opencode_first_turn_spontaneous_exit_rings` pins the
    /// inverted behavior; Ambiguous death-silence stays pinned by
    /// `opencode_ambiguous_exit_stays_silent`.)
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_death_while_idle_is_silent_and_freshell_kill_is_silent() {
        // (c) quiet idle pane: a spontaneous exit is not an attention event.
        let (hub_c, mut rx_c) = hub();
        observer_send(
            &hub_c,
            ActivityEvent::Created {
                terminal_id: "t-oc".into(),
                mode: "opencode".into(),
                resume_session_id: Some("ses-root".into()),
                at: 1_000,
            },
        );
        observer_send(
            &hub_c,
            ActivityEvent::Exit {
                terminal_id: "t-oc".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        assert!(
            next_frame_of_type(&mut rx_c, "terminal.idle", 1_500)
                .await
                .is_none(),
            "a spontaneous exit while idle must stay silent"
        );

        // (d) freshell-initiated kill mid-turn: silent.
        let (hub_d, mut rx_d) = hub();
        busy_opencode_terminal(&hub_d, &mut rx_d).await;
        observer_send(
            &hub_d,
            ActivityEvent::Exit {
                terminal_id: "t-oc".into(),
                at: now_ms(),
                spontaneous: false,
            },
        );
        assert!(
            next_frame_of_type(&mut rx_d, "terminal.idle", 1_500)
                .await
                .is_none(),
            "a requested exit must never ring the death bell"
        );
    }

    /// D4: a pane blocked on a permission whose process dies spontaneously
    /// rings immediately — pending permissions count as engagement.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_death_during_pause_rings() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-root".into(),
                permission_id: "perm-1".into(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t-oc".into(),
                at: now_ms(),
                spontaneous: true,
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 1_500)
            .await
            .expect("death during a pending permission pause must ring (D4)");
        assert_eq!(idle["terminalId"], "t-oc");
        // Exactly one: the exit teardown also cancels the armed pause window.
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_500)
                .await
                .is_none(),
            "exactly one bell for the death"
        );
    }

    /// D5: a child's idle mid-parent-turn is suppressed — the busy record
    /// survives and only the parent's own idle edge ends the turn.
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_child_idle_mid_parent_turn_does_not_ring() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await;

        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionCreated {
                session_id: "ses-child".into(),
                parent_id: Some("ses-root".into()),
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-child".into(),
                status: OpencodeStatus::Busy,
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-child".into(),
            },
        );
        // 3_500ms covers the grace: a wrongly armed bell would have rung.
        assert_no_attention_frames(&mut rx, 3_500).await;
        // The busy record survives the child's idle.
        let (records, _) = hub.opencode_list();
        assert_eq!(records.len(), 1, "the parent's busy record must survive");
        assert_eq!(records[0].terminal_id, "t-oc");

        // The parent's own idle edge ends the turn: one completion, one bell.
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 1_500)
            .await
            .expect("the parent's own idle edge completes the turn");
        assert_eq!(complete["provider"], "opencode");
        assert_eq!(complete["terminalId"], "t-oc");
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("one bell for the parent's turn end");
        assert_eq!(idle["terminalId"], "t-oc");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_500)
                .await
                .is_none(),
            "exactly one bell"
        );
    }

    /// A6: a respawn re-registers the lane under a NEW generation — events
    /// still stamped with the replaced generation are dropped WHOLE at
    /// ingress (tokio `abort()` never retracts already-enqueued events);
    /// current-generation events flow normally.
    #[tokio::test(flavor = "multi_thread")]
    async fn respawn_drops_stale_lane_events() {
        let (hub, mut rx) = hub();
        busy_opencode_terminal(&hub, &mut rx).await; // generation 1 registered + gen-1 busy accepted

        // The respawn's attach REPLACES the map entry under generation 2.
        hub.register_opencode_lane_for_tests("t-oc", 2);

        // Stragglers from the replaced lane: a busy for a DIFFERENT session
        // (would demote to Ambiguous + emit frames if processed) and the
        // turn's idle edge (would mint turn.complete + the bell).
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: "ses-stale".into(),
                status: OpencodeStatus::Busy,
            },
        );
        hub.note_opencode_lane_event(
            "t-oc",
            1,
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses-root".into(),
            },
        );
        // NO upsert, NO terminal.turn.complete, NO terminal.idle — nothing
        // at all may be broadcast (3_500ms covers the would-be grace bell).
        let frame = tokio::time::timeout(std::time::Duration::from_millis(3_500), rx.recv()).await;
        assert!(
            frame.is_err(),
            "stale-generation lane events must be dropped whole, got {frame:?}"
        );

        // A gen-2 snapshot flows normally: no busy roots -> the still-busy
        // turn completes and rings.
        hub.note_opencode_lane_event(
            "t-oc",
            2,
            1,
            1,
            OpencodeLaneEvent::Snapshot { statuses: vec![] },
        );
        let complete = next_frame_of_type(&mut rx, "terminal.turn.complete", 1_500)
            .await
            .expect("current-generation events flow normally");
        assert_eq!(complete["provider"], "opencode");
        assert_eq!(complete["terminalId"], "t-oc");
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 3_500)
            .await
            .expect("the completed turn rings after the grace");
        assert_eq!(idle["terminalId"], "t-oc");
    }

    /// Task 9: `OpencodeAttach` spawns the SSE lane under a hub-issued
    /// generation, a re-attach REPLACES it (generation bumps, still exactly
    /// one lane), and Exit tears the registry entry down (post-exit
    /// stragglers fail the generation match).
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_attach_replaces_the_lane_and_exit_tears_it_down() {
        use crate::opencode_lane::{
            ConnectedOpencodeStream, OpencodeEventStream, OpencodeLaneDeps, OpencodeLaneHttp,
        };

        /// A health endpoint that never answers: the spawned lane parks in
        /// its health-wait, so the test observes pure registry bookkeeping.
        struct PendingHttp;
        impl OpencodeLaneHttp for PendingHttp {
            fn get_json<'a>(
                &'a self,
                _url: &'a str,
            ) -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>>
            {
                Box::pin(async {
                    std::future::pending::<()>().await;
                    unreachable!()
                })
            }
        }
        struct NeverConnects;
        impl OpencodeEventStream for NeverConnects {
            fn connect<'a>(
                &'a self,
                _url: &'a str,
            ) -> futures::future::BoxFuture<'a, Result<Box<dyn ConnectedOpencodeStream>, String>>
            {
                Box::pin(async {
                    std::future::pending::<()>().await;
                    unreachable!()
                })
            }
        }

        async fn wait_until(pred: impl Fn() -> bool, what: &str) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(2_000);
            while !pred() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "timed out waiting for: {what}"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        let (hub, _rx) = hub();
        hub.set_opencode_lane_deps(Arc::new(OpencodeLaneDeps {
            http: Arc::new(PendingHttp),
            events: Arc::new(NeverConnects),
            native_title_observer: None,
        }));
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t-oc".into(),
                mode: "opencode".into(),
                resume_session_id: None,
                at: 1_000,
            },
        );

        hub.attach_opencode_serve("t-oc", "127.0.0.1", 4096);
        {
            let hub = hub.clone();
            wait_until(
                move || hub.opencode_lane_generation("t-oc") == Some(1),
                "first attach registers generation 1",
            )
            .await;
        }
        assert_eq!(hub.opencode_lane_count(), 1);

        // Re-attach REPLACES the lane (respawn re-allocates a NEW port):
        // generation bumps, still exactly one lane.
        hub.attach_opencode_serve("t-oc", "127.0.0.1", 4097);
        {
            let hub = hub.clone();
            wait_until(
                move || hub.opencode_lane_generation("t-oc") == Some(2),
                "second attach bumps to generation 2",
            )
            .await;
        }
        assert_eq!(hub.opencode_lane_count(), 1);

        // Exit tears the lane down: the map removal also makes post-exit
        // stragglers fail the generation match.
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t-oc".into(),
                at: 2_000,
                spontaneous: false,
            },
        );
        {
            let hub = hub.clone();
            wait_until(
                move || hub.opencode_lane_count() == 0,
                "exit removes the lane entry",
            )
            .await;
        }
        assert_eq!(hub.opencode_lane_generation("t-oc"), None);
    }

    // ---- #603: deadman verify serviced through the REAL lane ----

    /// Minimal lane fakes for the hub-level verify-cycle tests (the
    /// `opencode_lane.rs` harness is module-private): an HTTP fake with a
    /// shared call log + injected responder, and an event stream that acks
    /// the connect and then parks forever (the cycle stays open).
    type VerifyHttpResponder =
        Box<dyn Fn(&str) -> Result<(u16, serde_json::Value), String> + Send + Sync>;

    struct VerifyLaneHttp {
        log: Arc<Mutex<Vec<String>>>,
        respond: VerifyHttpResponder,
    }

    impl crate::opencode_lane::OpencodeLaneHttp for VerifyLaneHttp {
        fn get_json<'a>(
            &'a self,
            url: &'a str,
        ) -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>> {
            Box::pin(async move {
                self.log
                    .lock()
                    .expect("call log")
                    .push(format!("GET {url}"));
                (self.respond)(url)
            })
        }
    }

    struct ParkedStream;
    impl crate::opencode_lane::OpencodeEventStream for ParkedStream {
        fn connect<'a>(
            &'a self,
            _url: &'a str,
        ) -> futures::future::BoxFuture<
            'a,
            Result<Box<dyn crate::opencode_lane::ConnectedOpencodeStream>, String>,
        > {
            Box::pin(async {
                Ok(Box::new(ParkedConnection)
                    as Box<dyn crate::opencode_lane::ConnectedOpencodeStream>)
            })
        }
    }

    struct ParkedConnection;
    impl crate::opencode_lane::ConnectedOpencodeStream for ParkedConnection {
        fn drive(
            self: Box<Self>,
            events_tx: tokio::sync::mpsc::UnboundedSender<freshell_opencode::ParsedServeEvent>,
        ) -> futures::future::BoxFuture<'static, Result<(), String>> {
            Box::pin(async move {
                // Keep the sender alive while parked: a dropped sender
                // reads as a clean stream end and would close the cycle.
                let _keep_pump_open = events_tx;
                std::future::pending::<()>().await;
                unreachable!()
            })
        }
    }

    /// Shared setup for the verify-cycle tests: install the fake deps,
    /// shrink the deadman BEFORE driving any busy event (ORDERING IS
    /// LOAD-BEARING: the hub scheduler recomputes its one-shot deadline
    /// only when a HubEvent arrives or the armed timer fires, and the
    /// lock-and-set hook does neither — shrinking after the busy edge
    /// leaves the production 120s deadline armed), then create + attach
    /// and wait for the connect snapshot's busy upsert.
    async fn verified_busy_opencode_terminal(
        hub: &ActivityHub,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        http: VerifyLaneHttp,
    ) {
        hub.set_opencode_lane_deps(Arc::new(crate::opencode_lane::OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(ParkedStream),
            native_title_observer: None,
        }));
        hub.set_opencode_busy_deadman_for_tests(500);
        observer_send(
            hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "opencode".into(),
                resume_session_id: Some("ses-1".into()),
                at: now_ms(),
            },
        );
        hub.attach_opencode_serve("t1", "127.0.0.1", 1);
        // The real lane's connect snapshot lights the busy record.
        next_frame_matching(rx, "opencode.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy" && v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("busy upsert from the connect snapshot");
    }

    /// #603 end-to-end: deadman fires ⇒ exactly one verification GET ⇒ the
    /// busy record STAYS on the wire (no removal frame, no idle).
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_deadman_verify_keeps_busy_on_the_wire() {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let http = VerifyLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((
                        200,
                        serde_json::json!({"healthy": true, "version": "1.18.14"}),
                    ));
                }
                if url.ends_with("/session/status") {
                    // Connect snapshot AND every verify: still busy.
                    return Ok((200, serde_json::json!({"ses-1": {"type": "busy"}})));
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, serde_json::json!({"id": "ses-1"})));
                }
                Ok((404, serde_json::json!({})))
            }),
        };
        let (hub, mut rx) = hub();
        verified_busy_opencode_terminal(&hub, &mut rx, http).await;

        // Let the shrunk deadman (500ms) fire at least once.
        tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;

        // (a) the deadman verified through the lane: the connect snapshot
        //     plus at least one verification GET.
        let status_gets = log
            .lock()
            .expect("call log")
            .iter()
            .filter(|c| c.ends_with("/session/status"))
            .count();
        assert!(
            status_gets >= 2,
            "expected the connect snapshot plus >=1 verification GET, got {status_gets}"
        );

        // (b) the busy record never left the wire: no removal frame, no
        //     terminal.idle — a single pass over everything broadcast in
        //     the interval, so neither frame type can mask the other.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(200);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value =
                        serde_json::from_str(&frame).expect("frame json");
                    assert!(
                        !(value["type"] == "opencode.activity.updated"
                            && value["remove"]
                                .as_array()
                                .is_some_and(|r| r.iter().any(|t| t == "t1"))),
                        "the verified-busy record was dropped: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.idle",
                        "idle rang during a verified-busy turn: {frame}"
                    );
                }
                _ => break,
            }
        }
    }

    /// #603 end-to-end sibling: the deadman's verify probe FAILS ⇒ crash
    /// semantics — the busy record is removed AND the attention bell rings
    /// (terminal.idle, reason grace).
    #[tokio::test(flavor = "multi_thread")]
    async fn opencode_deadman_verify_failure_rings() {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let status_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let status_calls_in_responder = status_calls.clone();
        let http = VerifyLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((
                        200,
                        serde_json::json!({"healthy": true, "version": "1.18.14"}),
                    ));
                }
                if url.ends_with("/session/status") {
                    let n =
                        status_calls_in_responder.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if n == 0 {
                        // Connect snapshot: busy.
                        return Ok((200, serde_json::json!({"ses-1": {"type": "busy"}})));
                    }
                    // Every verify probe: the serve is dead.
                    return Err("connection refused".to_string());
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, serde_json::json!({"id": "ses-1"})));
                }
                Ok((404, serde_json::json!({})))
            }),
        };
        let (hub, mut rx) = hub();
        verified_busy_opencode_terminal(&hub, &mut rx, http).await;

        // Deadman fires → verify → the probe fails → SnapshotFailed →
        // crash semantics: the removal frame lands (boundary is LAST in
        // the effect batch, so the remove is on the wire first)...
        next_frame_matching(&mut rx, "opencode.activity.updated", 5_000, |v| {
            v["remove"]
                .as_array()
                .is_some_and(|r| r.iter().any(|t| t == "t1"))
        })
        .await
        .expect("crash semantics remove the busy record");

        // ...and the attention bell rings after the grace.
        let idle =
            next_frame_matching(&mut rx, "terminal.idle", 5_000, |v| v["terminalId"] == "t1")
                .await
                .expect("verify-probe failure rings the attention bell");
        assert_eq!(idle["reason"], "grace");
    }

    // ---- #606: claude deadman verified against the JSONL truth source ----

    /// Fake truth source for the claude deadman + submit-grace tests: a
    /// settable `TurnProbe` plus a log of every probed session id (the
    /// rebind test asserts the probe follows the NEW session). Defaults
    /// keep the deadman tests on the legacy confirmed-busy input flavor:
    /// `transcript_len → None`, `probe_submit → SubmitProbe::Unavailable`.
    /// The #611 tests script both and read the `submit_probed` log.
    struct FakeClaudeTruth {
        probe: Mutex<crate::claude_truth::TurnProbe>,
        probed: Mutex<Vec<String>>,
        transcript_len: Mutex<Option<u64>>,
        submit_probe: Mutex<crate::claude_truth::SubmitProbe>,
        /// (session_id, from_offset) of every probe_submit call.
        submit_probed: Mutex<Vec<(String, u64)>>,
    }

    impl FakeClaudeTruth {
        fn new(probe: crate::claude_truth::TurnProbe) -> Self {
            Self {
                probe: Mutex::new(probe),
                probed: Mutex::new(Vec::new()),
                transcript_len: Mutex::new(None),
                submit_probe: Mutex::new(crate::claude_truth::SubmitProbe::Unavailable),
                submit_probed: Mutex::new(Vec::new()),
            }
        }
    }

    impl crate::claude_truth::ClaudeTruth for FakeClaudeTruth {
        fn probe_turn_state(&self, session_id: &str) -> crate::claude_truth::TurnProbe {
            self.probed
                .lock()
                .expect("probed log")
                .push(session_id.to_string());
            *self.probe.lock().expect("fake probe")
        }

        fn transcript_len(&self, _session_id: &str) -> Option<u64> {
            *self.transcript_len.lock().expect("fake transcript len")
        }

        fn probe_submit(
            &self,
            session_id: &str,
            from_offset: u64,
        ) -> crate::claude_truth::SubmitProbe {
            self.submit_probed
                .lock()
                .expect("submit probed log")
                .push((session_id.to_string(), from_offset));
            *self.submit_probe.lock().expect("fake submit probe")
        }
    }

    /// Shared setup: install the fake truth, shrink the deadman BEFORE
    /// driving any busy event (ordering is load-bearing — see
    /// `verified_busy_opencode_terminal`), create the claude pane bound
    /// to `session`, submit, and wait for the busy upsert.
    async fn verified_busy_claude_terminal(
        hub: &ActivityHub,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        fake: Arc<FakeClaudeTruth>,
        session: &str,
    ) {
        hub.set_claude_truth(fake);
        hub.set_claude_busy_deadman_for_tests(300);
        observer_send(
            hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: Some(session.to_string()),
                at: now_ms(),
            },
        );
        observer_send(
            hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(rx, "claude.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy" && v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("busy upsert from the submit");
    }

    /// #606 end-to-end: deadman → JSONL probe; InFlight keeps busy on the
    /// wire; Ended emits idle + terminal.turn.complete; Unavailable rings
    /// the attention boundary.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_deadman_probes_the_jsonl_truth_source() {
        let (hub, mut rx) = hub();
        let fake = Arc::new(FakeClaudeTruth::new(
            crate::claude_truth::TurnProbe::InFlight,
        ));
        verified_busy_claude_terminal(&hub, &mut rx, fake.clone(), "S").await;

        // InFlight: the deadman (300ms) fires at least once in this window;
        // the record must stay busy — no idle upsert, no terminal.idle.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(700);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value =
                        serde_json::from_str(&frame).expect("frame json");
                    assert!(
                        !(value["type"] == "claude.activity.updated"
                            && value["upsert"].as_array().is_some_and(|u| {
                                u.iter()
                                    .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
                            })),
                        "verified-busy record demoted to idle: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.idle",
                        "idle rang during a verified-busy turn: {frame}"
                    );
                }
                _ => break,
            }
        }
        assert!(
            fake.probed
                .lock()
                .expect("probed log")
                .iter()
                .any(|s| s == "S"),
            "the deadman verified against the bound session's JSONL"
        );

        // Flip the truth to Ended: the NEXT verify mints the completion the
        // old silent deadman swallowed.
        *fake.probe.lock().expect("fake probe") = crate::claude_truth::TurnProbe::Ended;
        next_frame_matching(&mut rx, "terminal.turn.complete", 5_000, |v| {
            v["provider"] == "claude" && v["terminalId"] == "t1"
        })
        .await
        .expect("verified end mints the completion bell");
    }

    /// #606 sibling: no reachable truth (probe Unavailable) = crash
    /// semantics — busy clears AND the attention bell rings
    /// (terminal.idle, reason grace).
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_deadman_unavailable_truth_rings_attention() {
        let (hub, mut rx) = hub();
        let fake = Arc::new(FakeClaudeTruth::new(
            crate::claude_truth::TurnProbe::Unavailable,
        ));
        verified_busy_claude_terminal(&hub, &mut rx, fake, "S").await;

        // Deadman fires → probe Unavailable → crash semantics: the Idle
        // upsert lands first (boundary is LAST in the effect batch)...
        next_frame_matching(&mut rx, "claude.activity.updated", 5_000, |v| {
            v["upsert"].as_array().is_some_and(|u| {
                u.iter()
                    .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
            })
        })
        .await
        .expect("crash semantics clear the busy record");

        // ...and the attention bell rings after the grace.
        let idle =
            next_frame_matching(&mut rx, "terminal.idle", 6_000, |v| v["terminalId"] == "t1")
                .await
                .expect("unavailable truth rings the attention bell");
        assert_eq!(idle["reason"], "grace");
    }

    /// #606/#611 (A4): an in-TUI /resume or /clear rebinds the pane to a
    /// NEW session id; the tracker must follow or every later probe
    /// reads the OLD session's JSONL. Red until bind_claude_session
    /// exists and is wired.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_rebind_reaches_the_tracker_and_probes_the_new_session() {
        let (hub, mut rx) = hub();
        let fake = Arc::new(FakeClaudeTruth::new(
            crate::claude_truth::TurnProbe::InFlight,
        ));
        verified_busy_claude_terminal(&hub, &mut rx, fake.clone(), "S1").await;

        hub.bind_claude_session("t1", "S2");
        assert_eq!(
            hub.claude_session_id_for_tests("t1"),
            Some("S2".to_string()),
            "the rebind reached the tracker"
        );

        // Sleep past the deadman: the probe after rebind targets the NEW
        // session's JSONL, never the stale one.
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        let probed = fake.probed.lock().expect("probed log").clone();
        assert!(
            probed.iter().any(|s| s == "S2"),
            "expected a probe against the rebound session, got {probed:?}"
        );
        assert_ne!(
            probed.last().map(String::as_str),
            Some("S1"),
            "the LAST probe still targets the stale session: {probed:?}"
        );
    }

    /// #611 end-to-end: a bare Enter goes provisional; the confirm probe
    /// says NoTurnStarted; the pane silently reverts to idle well before
    /// the 120s deadman — and no bell rings.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_bare_enter_reverts_via_submit_probe() {
        let (hub, mut rx) = hub();
        let fake = Arc::new(FakeClaudeTruth::new(
            crate::claude_truth::TurnProbe::InFlight,
        ));
        *fake.transcript_len.lock().expect("fake transcript len") = Some(100);
        *fake.submit_probe.lock().expect("fake submit probe") =
            crate::claude_truth::SubmitProbe::NoTurnStarted;
        // Deadman stays at its production 120s: the ONLY ForceRead in this
        // window is the 2s submit-grace lapse.
        hub.set_claude_truth(fake.clone());
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: Some("S".to_string()),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "claude.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy" && v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("provisional busy upsert from the submit");

        // Within ~3s (grace lapse at 2s → confirm probe → NoTurnStarted):
        // the idle upsert lands, and NO bell frame precedes it.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(3_500);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "no silent revert within the grace window"
            );
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value =
                        serde_json::from_str(&frame).expect("frame json");
                    assert!(
                        value["type"] != "terminal.turn.complete",
                        "a phantom Enter must not mint a completion: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.idle",
                        "a phantom Enter must not ring the attention bell: {frame}"
                    );
                    if value["type"] == "claude.activity.updated"
                        && value["upsert"].as_array().is_some_and(|u| {
                            u.iter()
                                .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
                        })
                    {
                        break;
                    }
                }
                _ => panic!("frame stream ended before the silent revert"),
            }
        }
        // The probe consumed the SESSION-SCOPED stash from submit time.
        assert_eq!(
            fake.submit_probed
                .lock()
                .expect("submit probed log")
                .clone(),
            vec![("S".to_string(), 100)],
            "one confirm probe against the stashed (session, offset)"
        );
    }

    /// #611 + A7 session-scoping: a rebind between the stash and the
    /// confirm probe makes the stash foreign — the probe must NOT read
    /// the new session's file with the old offset (Unavailable instead),
    /// and the #606 deadman verify remains the backstop (reachable
    /// because the Unavailable resolution cleared the grace deadline and
    /// with it `is_awaiting_submit_confirm`).
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_rebind_between_stash_and_probe_is_unavailable() {
        let (hub, mut rx) = hub();
        let fake = Arc::new(FakeClaudeTruth::new(
            crate::claude_truth::TurnProbe::InFlight,
        ));
        *fake.transcript_len.lock().expect("fake transcript len") = Some(100);
        *fake.submit_probe.lock().expect("fake submit probe") =
            crate::claude_truth::SubmitProbe::Confirmed;
        // Helper shrinks the deadman to 300ms: the deadman ForceRead
        // arrives BEFORE the 2s grace lapse and routes to the confirm
        // flavor while the pane awaits confirmation.
        verified_busy_claude_terminal(&hub, &mut rx, fake.clone(), "S").await;

        // Rebind BEFORE any probe fires: the stash ("S", 100) is now
        // foreign to the bound session.
        hub.bind_claude_session("t1", "S2");

        // Across the grace window: the pane stays provisionally busy —
        // no idle upsert, no bell, no completion.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(2_500);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value =
                        serde_json::from_str(&frame).expect("frame json");
                    assert!(
                        !(value["type"] == "claude.activity.updated"
                            && value["upsert"].as_array().is_some_and(|u| {
                                u.iter()
                                    .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
                            })),
                        "a mismatched stash must keep provisional busy: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.idle",
                        "a mismatched stash must not ring a bell: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.turn.complete",
                        "a mismatched stash must not mint a completion: {frame}"
                    );
                }
                _ => break,
            }
        }
        assert!(
            fake.submit_probed
                .lock()
                .expect("submit probed log")
                .is_empty(),
            "session mismatch ⇒ probe_submit never reads a foreign file"
        );
        // The #606 deadman path remains armed: once the Unavailable
        // resolution cleared the grace, the deadman ForceRead routes to
        // the turn-state verify flavor against the NEW session.
        let probed = fake.probed.lock().expect("probed log").clone();
        assert!(
            probed.iter().any(|s| s == "S2"),
            "the deadman turn-state verify fires against the rebound \
             session, got {probed:?}"
        );
    }

    /// #611 double-Enter: the stash must keep the FIRST submit's offset.
    /// Enter #1 starts a REAL turn and claude appends the prompt record
    /// (len 100 → 150) before Enter #2 lands within the grace window.
    /// Re-stashing at 150 would re-baseline past the live turn's
    /// evidence — the confirm probe would see nothing appended past 150
    /// (the first assistant record routinely takes >2s), silently revert
    /// a live turn, and the eventual Stop-BEL would find in_flight == 0:
    /// a lost bell. The probe must consume (S, 100).
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_double_enter_keeps_the_first_submit_offset() {
        let (hub, mut rx) = hub();
        let fake = Arc::new(FakeClaudeTruth::new(
            crate::claude_truth::TurnProbe::InFlight,
        ));
        *fake.transcript_len.lock().expect("fake transcript len") = Some(100);
        *fake.submit_probe.lock().expect("fake submit probe") =
            crate::claude_truth::SubmitProbe::Confirmed;
        // Production 120s deadman: the ONLY ForceRead in this window is
        // the submit-grace lapse.
        hub.set_claude_truth(fake.clone());
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: Some("S".to_string()),
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "claude.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy" && v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("provisional busy upsert from Enter #1");

        // The real turn's prompt record lands: the transcript grows past
        // the first baseline BEFORE the second Enter.
        *fake.transcript_len.lock().expect("fake transcript len") = Some(150);
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );

        // Across the (re-armed) grace window up to past the confirm probe:
        // the live turn must NOT be reverted and nothing may ring.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(2_800);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value =
                        serde_json::from_str(&frame).expect("frame json");
                    assert!(
                        !(value["type"] == "claude.activity.updated"
                            && value["upsert"].as_array().is_some_and(|u| {
                                u.iter()
                                    .any(|r| r["terminalId"] == "t1" && r["phase"] == "idle")
                            })),
                        "double-Enter silently reverted a LIVE turn: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.idle",
                        "double-Enter rang a bell during a live turn: {frame}"
                    );
                    assert!(
                        value["type"] != "terminal.turn.complete",
                        "no completion before the Stop-BEL: {frame}"
                    );
                }
                _ => break,
            }
        }
        // The pin: the confirm probe consumed the FIRST Enter's baseline,
        // not Enter #2's re-baseline past the live turn's evidence.
        assert_eq!(
            fake.submit_probed
                .lock()
                .expect("submit probed log")
                .clone(),
            vec![("S".to_string(), 100)],
            "the confirm probe must consume the FIRST submit offset"
        );
        // The confirmed turn still mints its bell on the Stop-BEL.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["provider"] == "claude" && v["terminalId"] == "t1"
        })
        .await
        .expect("the confirmed turn completes with its bell");
    }
}

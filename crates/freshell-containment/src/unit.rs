//! One coding-agent pane = one unit. `AgentUnit::stop` is the ONLY stop
//! sequence:
//!
//! request → persist Stopping → soft signal → kill the whole unit →
//! confirm Gone → publish → sweep.
//!
//! Lifecycle STATE (Running / Stopping / Gone) lives in the owner registry
//! (`freshell-ownership`); a unit only runs and joins its in-flight stop and
//! keeps its persisted record (`record.rs`), where persisted Stopping lives.
//! Nothing is signalled before Stopping is saved, Gone means the screen, the
//! main process and every pinned root are confirmed dead (before a placed
//! agent's main is adopted: every member) and no member holds a
//! conversation lock, and leftovers are swept (and survivors logged) after
//! Gone. Waiting is event-driven throughout (`ProcWatch`, watch channels,
//! timers armed for a deadline); nothing polls.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use crate::backend::{Capability, MemberList, UnitBackend, UnitObserver};
use crate::events::{self, UnitLogKeys};
use crate::proc_watch::{ProcWatch, Sig};
use crate::process::{self, ProcIdentity};
use crate::record::{RecordStore, UnitRecord, UnitRecordState};
use crate::{locks, testing, BoxFuture, UnitId};

/// A Force stop's maximum grace for the main process after SIGINT.
pub const FORCE_GRACE: Duration = Duration::from_secs(1);
/// Gone not confirmed this long after the whole-unit kill (the last signal
/// of the sequence) logs ERROR `unit.stop.unconfirmed` and keeps waiting.
pub const UNCONFIRMED_AFTER: Duration = Duration::from_secs(5);
/// How long the post-Gone sweep waits for the unit to empty.
pub const POST_GONE_EMPTY_WAIT: Duration = Duration::from_secs(2);
/// A member still unplaced this long after its spawn is a typed start
/// failure (callers confirm placement once, at the latest at this deadline).
pub const PLACEMENT_DEADLINE: Duration = Duration::from_secs(2);

/// Who a unit is, for its record and its log lines.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitLabel {
    pub provider: String,
    pub session_id: Option<String>,
    pub terminal_id: Option<String>,
    pub mode: String,
    pub create_request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberRole {
    Screen,
    Agent,
}

/// How to start a member: an optional wrapper command placed in front of
/// the program, and environment entries to add.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement {
    pub wrapper: Option<Vec<String>>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    Force,
    Graceful { grace: Duration },
}

impl StopMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Force => "force",
            Self::Graceful { .. } => "graceful",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    ShiftX,
    KillCommand,
    Respawn,
    Cleanup,
    Handoff,
    StuckRestart,
    StartCancelled,
    AgentExited {
        exit_code: Option<i64>,
    },
    /// A member exited, or was still unplaced at `PLACEMENT_DEADLINE`,
    /// before its placement was confirmed: a typed start failure.
    PlacementFailed {
        exit_code: Option<i64>,
    },
    BootFinish,
    ServerShutdown,
}

impl StopReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ShiftX => "shift-x",
            Self::KillCommand => "kill-command",
            Self::Respawn => "respawn",
            Self::Cleanup => "cleanup",
            Self::Handoff => "handoff",
            Self::StuckRestart => "stuck-restart",
            Self::StartCancelled => "start-cancelled",
            Self::AgentExited { .. } => "agent-exited",
            Self::PlacementFailed { .. } => "placement-failed",
            Self::BootFinish => "boot-finish",
            Self::ServerShutdown => "server-shutdown",
        }
    }

    /// A user's kill (Shift-X or a kill command).
    fn is_user_kill(&self) -> bool {
        matches!(self, Self::ShiftX | Self::KillCommand)
    }

    /// A stop whose reason a joining user kill replaces: re-creating callers
    /// (auto-resume after an agent exit, a respawn, a stuck restart) read
    /// `StopReport::reason` and must not re-create what a user killed.
    fn yields_to_user_kill(&self) -> bool {
        matches!(
            self,
            Self::Respawn
                | Self::StuckRestart
                | Self::Handoff
                | Self::Cleanup
                | Self::AgentExited { .. }
        )
    }
}

/// Runs at Gone, before the report reaches any waiter.
pub type GoneCallback = Box<dyn FnOnce(StopReport) -> BoxFuture<'static, ()> + Send>;

pub struct StopRequest {
    pub mode: StopMode,
    pub reason: StopReason,
    pub initiator: String,
    pub operation_id: Option<String>,
    pub on_gone: Option<GoneCallback>,
    /// The soft interrupt used when the main cannot be signalled (Windows:
    /// Ctrl+C into the unit's PTY screen).
    pub soft_interrupt: Option<Box<dyn FnOnce() + Send>>,
}

impl StopRequest {
    pub fn new(mode: StopMode, reason: StopReason, initiator: impl Into<String>) -> Self {
        Self {
            mode,
            reason,
            initiator: initiator.into(),
            operation_id: None,
            on_gone: None,
            soft_interrupt: None,
        }
    }

    pub fn operation(mut self, id: impl Into<String>) -> Self {
        self.operation_id = Some(id.into());
        self
    }

    pub fn on_gone(mut self, cb: GoneCallback) -> Self {
        self.on_gone = Some(cb);
        self
    }

    pub fn soft_interrupt(mut self, f: Box<dyn FnOnce() + Send>) -> Self {
        self.soft_interrupt = Some(f);
        self
    }
}

/// What a stop did, published at Gone. `reason` is the strongest intent
/// after joins; `mode` is `"force"` when the stop started as, or was joined
/// by, a Force request; `lock_released` means no unit member holds any of the
/// unit's lock files. Survivors are reported by the post-Gone sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopReport {
    pub unit_id: UnitId,
    pub reason: String,
    pub mode: &'static str,
    pub duration_ms: u64,
    pub escalated: bool,
    pub lock_released: bool,
}

/// A waiter's view of one stop. Clones share the stop.
#[derive(Clone)]
pub struct StopHandle {
    gone: watch::Receiver<Option<StopReport>>,
    swept: watch::Receiver<Option<Vec<ProcIdentity>>>,
}

impl StopHandle {
    /// Resolves at Gone, after `on_gone` ran. Never panics: a stop that
    /// cannot finish (the unconfirmed case) leaves it pending.
    pub async fn wait(&self) -> StopReport {
        let mut rx = self.gone.clone();
        if let Ok(report) = rx.wait_for(Option::is_some).await {
            if let Some(report) = report.as_ref() {
                return report.clone();
            }
        }
        // The sender lives in the unit, so this is reached only when the
        // unit itself is gone without a report: never Gone.
        std::future::pending().await
    }

    pub async fn wait_for(&self, limit: Duration) -> Option<StopReport> {
        tokio::time::timeout(limit, self.wait()).await.ok()
    }

    pub fn try_report(&self) -> Option<StopReport> {
        self.gone.borrow().clone()
    }

    /// Resolves after the post-Gone sweep with the members still running
    /// (empty when none; each was logged).
    pub async fn wait_swept(&self) -> Vec<ProcIdentity> {
        let mut rx = self.swept.clone();
        if let Ok(swept) = rx.wait_for(Option::is_some).await {
            if let Some(survivors) = swept.as_ref() {
                return survivors.clone();
            }
        }
        std::future::pending().await
    }
}

#[derive(Clone)]
pub struct AgentUnit {
    inner: Arc<Inner>,
}

struct Inner {
    id: UnitId,
    backend: Arc<dyn UnitBackend>,
    capability: Capability,
    store: Arc<RecordStore>,
    label: Mutex<UnitLabel>,
    members: Mutex<Members>,
    lock_paths: Mutex<Vec<PathBuf>>,
    seq: AtomicU32,
    /// The current record; `None` once it is deleted at Gone (no later write
    /// recreates it). Record writes are serialized under this mutex.
    record: Mutex<Option<UnitRecord>>,
    stop: Mutex<Option<Arc<StopState>>>,
}

#[derive(Default)]
struct Members {
    screen: Option<ProcWatch>,
    main: Option<ProcWatch>,
    roots: Vec<ProcWatch>,
    /// A stop has begun: no new members are placed.
    stopping: bool,
    /// Stopping is saved: a member pinned from now on is killed at once.
    saved: bool,
    /// An agent member was placed: until a main is adopted, the agent main
    /// process is a member nobody pinned (see `confirm_gone`).
    agent_placed: bool,
}

/// The single in-flight stop of a unit.
struct StopState {
    /// Kept alive here, so a closed channel is never mistaken for Gone.
    gone_tx: watch::Sender<Option<StopReport>>,
    swept_tx: watch::Sender<Option<Vec<ProcIdentity>>>,
    handle: StopHandle,
    requested: Instant,
    requested_ms: u64,
    /// Counts Force requests that joined; the soft phase and a failed
    /// persist wait on it.
    force_joins: watch::Sender<u64>,
    /// The withheld-environment count was logged for this stop (once).
    withheld_logged: AtomicBool,
    m: Mutex<StopMut>,
}

struct StopMut {
    mode: StopMode,
    /// Started as, or joined by, a Force request.
    forced: bool,
    reason: StopReason,
    operation_id: Option<String>,
    on_gone: Option<GoneCallback>,
    soft_interrupt: Option<Box<dyn FnOnce() + Send>>,
}

enum AttemptEnd {
    Gone,
    /// `on_gone` panicked: final, no report.
    OnGonePanicked,
}

/// Locks ignoring poisoning: a panicking caller callback must never make
/// every later stop or waiter panic too.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn identity_of(watch: &ProcWatch) -> (u32, u64) {
    (watch.pid(), watch.identity().start)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> io::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(io::Error::other)
}

impl AgentUnit {
    pub(crate) fn new(
        id: UnitId,
        backend: Arc<dyn UnitBackend>,
        capability: Capability,
        store: Arc<RecordStore>,
        label: UnitLabel,
        record: Option<UnitRecord>,
    ) -> Self {
        let inner = Arc::new(Inner {
            id,
            backend,
            capability,
            store,
            label: Mutex::new(label),
            members: Mutex::new(Members::default()),
            lock_paths: Mutex::new(Vec::new()),
            seq: AtomicU32::new(0),
            record: Mutex::new(record),
            stop: Mutex::new(None),
        });
        inner
            .backend
            .set_observer(Arc::new(RecordRoots(Arc::downgrade(&inner))));
        Self { inner }
    }

    pub fn id(&self) -> &UnitId {
        &self.inner.id
    }

    pub fn label(&self) -> UnitLabel {
        lock(&self.inner.label).clone()
    }

    /// Replaces the label and rewrites the record's terminal and
    /// create-request ids; a session id is added to the conversation keys.
    pub fn set_label(&self, label: UnitLabel) {
        *lock(&self.inner.label) = label.clone();
        self.update_record(|r| {
            r.terminal_id = label.terminal_id.clone();
            r.create_request_id = label.create_request_id.clone();
            if let Some(session) = &label.session_id {
                let key = (label.provider.clone(), session.clone());
                if !r.conversation_keys.contains(&key) {
                    r.conversation_keys.push(key);
                }
            }
        });
    }

    pub fn capability(&self) -> Capability {
        self.inner.capability.clone()
    }

    /// How to start the next member. Refused once a stop has begun.
    pub fn placement(&self, role: MemberRole) -> io::Result<Placement> {
        {
            let mut m = lock(&self.inner.members);
            if m.stopping {
                return Err(io::Error::other(format!(
                    "unit {} is stopping",
                    self.inner.id
                )));
            }
            m.agent_placed |= role == MemberRole::Agent;
        }
        let seq = self.inner.seq.fetch_add(1, Ordering::SeqCst);
        self.inner.backend.placement(role, seq)
    }

    /// A command for `program args` placed in this unit (wrapper and tag).
    pub fn tokio_command(
        &self,
        program: &str,
        args: &[String],
        role: MemberRole,
    ) -> io::Result<tokio::process::Command> {
        let placement = self.placement(role)?;
        let mut cmd = match placement.wrapper.as_deref() {
            Some([wrapper, wrapper_args @ ..]) => {
                let mut c = tokio::process::Command::new(wrapper);
                c.args(wrapper_args).arg(program).args(args);
                c
            }
            _ => {
                let mut c = tokio::process::Command::new(program);
                c.args(args);
                c
            }
        };
        for (k, v) in &placement.env {
            cmd.env(k, v);
        }
        Ok(cmd)
    }

    pub fn set_screen(&self, watch: ProcWatch) {
        let (previous, other, kill_now) = {
            let mut m = lock(&self.inner.members);
            let previous = m.screen.replace(watch.clone());
            (previous, m.main.clone(), m.saved)
        };
        self.pinned(&watch, previous, other, kill_now);
    }

    pub fn set_main(&self, watch: ProcWatch) {
        let (previous, other, kill_now) = {
            let mut m = lock(&self.inner.members);
            let previous = m.main.replace(watch.clone());
            (previous, m.screen.clone(), m.saved)
        };
        self.pinned(&watch, previous, other, kill_now);
    }

    pub fn add_root(&self, watch: ProcWatch) {
        let kill_now = {
            let mut m = lock(&self.inner.members);
            m.roots.push(watch.clone());
            m.saved
        };
        self.pinned(&watch, None, None, kill_now);
    }

    /// Record upkeep for a newly pinned member, and the kill of a member
    /// pinned after Stopping was saved (one pinned while the Stopping write
    /// is still outstanding is killed by the sequence's kill step instead).
    fn pinned(
        &self,
        watch: &ProcWatch,
        previous: Option<ProcWatch>,
        other_role: Option<ProcWatch>,
        kill_now: bool,
    ) {
        if kill_now {
            let _ = watch.signal(Sig::Kill);
        }
        watch.watch_lock_paths(&lock(&self.inner.lock_paths));
        let new = identity_of(watch);
        self.inner.backend.root_pinned(new.0, new.1);
        let dropped = previous
            .map(|w| identity_of(&w))
            .filter(|old| *old != new && other_role.as_ref().map(identity_of) != Some(*old));
        // The backend may have recorded it already (the macOS fork tracker
        // records every root it follows): then nothing is left to write.
        let recorded = lock(&self.inner.record).as_ref().is_some_and(|r| {
            r.roots.contains(&new) && dropped.is_none_or(|old| !r.roots.contains(&old))
        });
        if recorded {
            return;
        }
        self.update_record(|r| {
            if let Some(old) = dropped {
                r.roots.retain(|root| *root != old);
            }
            if !r.roots.contains(&new) {
                r.roots.push(new);
            }
        });
    }

    pub fn screen(&self) -> Option<ProcWatch> {
        lock(&self.inner.members).screen.clone()
    }

    pub fn main(&self) -> Option<ProcWatch> {
        lock(&self.inner.members).main.clone()
    }

    pub fn main_is_screen(&self) -> bool {
        let m = lock(&self.inner.members);
        matches!((&m.main, &m.screen), (Some(main), Some(screen)) if main.identity() == screen.identity())
    }

    /// The unit's conversation lock files, checked before Gone. Every
    /// pinned watch gets them too (on macOS a watch opened while its
    /// process was already exiting waits for their unlock).
    pub fn set_lock_paths(&self, paths: Vec<PathBuf>) {
        for watch in self.pinned_watches() {
            watch.watch_lock_paths(&paths);
        }
        *lock(&self.inner.lock_paths) = paths;
    }

    /// One-shot: `Ok` when `pid` is placed in this unit (Stage 2: LB-16,
    /// LB-27). Callers run it once at the start's settle point; an error is
    /// a typed start failure (`events::placement_failed`).
    pub fn confirm_placement(&self, pid: u32) -> io::Result<()> {
        self.inner
            .backend
            .confirm_placement(pid, &self.live_roots())
    }

    /// Adds one conversation key to the record (nothing is written when it
    /// is already there).
    pub fn note_conversation(&self, provider: &str, session_id: &str) {
        let key = (provider.to_string(), session_id.to_string());
        let present = lock(&self.inner.record)
            .as_ref()
            .is_some_and(|r| r.conversation_keys.contains(&key));
        if !present {
            self.update_record(|r| {
                if !r.conversation_keys.contains(&key) {
                    r.conversation_keys.push(key.clone());
                }
            });
        }
    }

    /// The live, non-spared members right now. One-shot reads (on the tag
    /// backend a scan of every process), so async callers run it on a
    /// blocking task.
    pub fn members(&self) -> io::Result<Vec<ProcIdentity>> {
        let list = self.member_list()?;
        self.note_withheld(&self.log_keys(self.stop_operation()), list.withheld);
        Ok(list.members)
    }

    /// One reading of the members, nothing logged (the stop's own scans run
    /// on blocking threads and report the withheld count back).
    fn member_list(&self) -> io::Result<MemberList> {
        self.inner.backend.members(&self.live_roots())
    }

    /// The members plus every `extra` process they do not include.
    fn members_and(&self, extra: Vec<ProcIdentity>) -> Vec<ProcIdentity> {
        let mut members = self.member_list().unwrap_or_default().members;
        for process in extra {
            if !members.iter().any(|m| m.pid == process.pid) {
                members.push(process);
            }
        }
        members
    }

    /// Logs the same-uid processes a member scan could not read, with the
    /// unit's keys: once per stop while one is in flight, else per call.
    fn note_withheld(&self, keys: &UnitLogKeys, withheld: u64) {
        if withheld == 0 {
            return;
        }
        let stop = lock(&self.inner.stop).clone();
        if stop.is_some_and(|stop| stop.withheld_logged.swap(true, Ordering::SeqCst)) {
            return;
        }
        events::environ_withheld(keys, withheld);
    }

    /// The backend's "unit is empty" event (see `testing::unit_empty_wait`).
    pub(crate) fn empty_wait(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
        self.inner.backend.wait_empty()
    }

    pub fn stop_in_flight(&self) -> Option<StopHandle> {
        lock(&self.inner.stop).as_ref().map(|s| s.handle.clone())
    }

    /// The owner operation of the unit's stop (in flight, or finished), if
    /// it named one. A later stop joins that stop and drops its own
    /// operation, so whatever a joiner releases belongs to this operation.
    pub fn stop_operation(&self) -> Option<String> {
        lock(&self.inner.stop)
            .as_ref()
            .and_then(|s| s.operation_id())
    }

    /// Pins recorded roots by (pid, start) without rewriting the record; a
    /// root that cannot be pinned is never signalled (Stage 2: LB-02), and
    /// neither is one in Codex's daemon family (a record written before the
    /// family was kept out of the roots can name one): it is logged as
    /// spared and never pinned.
    pub(crate) fn pin_recorded_roots(&self, roots: &[(u32, u64)]) {
        for (pid, start) in roots {
            // Told to the backend even when it has exited (it then ignores
            // it); the macOS fork tracker refuses the daemon family itself.
            self.inner.backend.root_pinned(*pid, *start);
            match ProcWatch::open_expecting(*pid, *start) {
                Ok(watch) if process::in_codex_daemon_family(*pid) => {
                    events::spared(&self.log_keys(None), &[watch.identity().clone()]);
                }
                Ok(watch) => {
                    watch.watch_lock_paths(&lock(&self.inner.lock_paths));
                    lock(&self.inner.members).roots.push(watch);
                }
                Err(err) => {
                    events::root_not_pinned(&self.log_keys(None), *pid, *start, &err.to_string())
                }
            }
        }
    }

    /// Installs a legacy unit's freshly written record and its pinned roots
    /// (`Containment::adopt_legacy`).
    pub(crate) fn adopt_record(&self, record: UnitRecord, roots: Vec<ProcWatch>) {
        *lock(&self.inner.record) = Some(record);
        for root in &roots {
            let (pid, start) = identity_of(root);
            self.inner.backend.root_pinned(pid, start);
        }
        lock(&self.inner.members).roots.extend(roots);
    }

    /// Starts the stop, or joins the one in flight (single-flight). Must be
    /// called inside a tokio runtime.
    ///
    /// A Force join makes the report's mode `"force"` and skips what is left
    /// of the soft signal's grace (all of it when it arrives before the
    /// signal, including the join that retried a failed Stopping write).
    /// A Shift-X or kill-command join on a respawn,
    /// stuck-restart, handoff, cleanup or agent-exit stop takes over its
    /// reason. A
    /// joiner's own callbacks and operation id are dropped: it awaits the
    /// returned handle.
    pub fn stop(&self, req: StopRequest) -> StopHandle {
        let mut slot = lock(&self.inner.stop);
        if let Some(state) = slot.as_ref().cloned() {
            drop(slot);
            self.join(&state, req);
            return state.handle.clone();
        }
        let state = Arc::new(StopState::new(&req));
        let StopRequest {
            mode,
            reason,
            initiator,
            operation_id,
            on_gone,
            soft_interrupt,
        } = req;
        {
            let mut m = lock(&state.m);
            m.on_gone = on_gone;
            m.soft_interrupt = soft_interrupt;
        }
        *slot = Some(state.clone());
        lock(&self.inner.members).stopping = true;
        drop(slot);
        events::stop_requested(
            &self.log_keys(operation_id),
            reason.as_str(),
            mode.as_str(),
            &initiator,
        );
        tokio::spawn(self.clone().supervise(state.clone()));
        state.handle.clone()
    }

    fn join(&self, state: &Arc<StopState>, req: StopRequest) {
        let (replaced, operation_id) = {
            let mut m = lock(&state.m);
            if req.mode == StopMode::Force {
                m.forced = true;
            }
            let replace = req.reason.is_user_kill() && m.reason.yields_to_user_kill();
            if replace {
                m.reason = req.reason.clone();
            }
            (replace, m.operation_id.clone())
        };
        let keys = self.log_keys(operation_id);
        events::stop_joined(
            &keys,
            req.reason.as_str(),
            req.mode.as_str(),
            &req.initiator,
            replaced,
        );
        if req.mode == StopMode::Force {
            state.force_joins.send_modify(|n| *n += 1);
        }
        if replaced {
            let unit = self.clone();
            let reason = req.reason.as_str();
            tokio::spawn(async move {
                let rewritten = blocking(move || unit.rewrite_stopping_reason(reason)).await;
                if let Err(err) = rewritten.and_then(|r| r) {
                    events::persist_failed(&keys, &err.to_string());
                }
            });
        }
    }

    async fn supervise(self, state: Arc<StopState>) {
        for attempt in 1..=2u32 {
            let final_attempt = attempt == 2;
            if final_attempt {
                lock(&state.m).forced = true;
            }
            let run = tokio::spawn(self.clone().attempt(state.clone(), attempt));
            let keys = self.log_keys(state.operation_id());
            match run.await {
                Ok(Ok(AttemptEnd::Gone)) => {
                    let survivors = self.sweep(&keys).await;
                    state.swept_tx.send_replace(Some(survivors));
                    return;
                }
                Ok(Ok(AttemptEnd::OnGonePanicked)) => {
                    events::stop_panicked(&keys, attempt, true);
                    return;
                }
                Ok(Err(err)) => {
                    events::stop_failed(&keys, attempt, final_attempt, &err.to_string())
                }
                Err(join) if join.is_panic() => {
                    events::stop_panicked(&keys, attempt, final_attempt)
                }
                // Cancelled by runtime shutdown: the record stays Stopping
                // and the next boot finishes the unit.
                Err(_) => return,
            }
        }
        // Both attempts failed: no report is ever published; the record stays
        // Stopping, the unit keeps refusing members, the next boot finishes it.
    }

    /// One run of the sequence (attempt 2 runs in Force mode).
    async fn attempt(self, state: Arc<StopState>, attempt: u32) -> io::Result<AttemptEnd> {
        let mode = if attempt == 1 {
            lock(&state.m).mode
        } else {
            StopMode::Force
        };
        let keys = self.log_keys(state.operation_id());
        self.persist(&state, &keys).await;
        let snapshot = if self.inner.capability.full {
            Vec::new()
        } else {
            self.snapshot(&keys).await?
        };
        let escalated = self.soft_phase(&state, mode, &keys).await;
        let spared = self.kill_unit(&keys, &snapshot).await;
        let lock_released = self
            .confirm_gone(&state, &keys, Instant::now(), &snapshot, &spared)
            .await?;
        self.publish_gone(&state, &keys, escalated, lock_released)
            .await
    }

    /// Step a: save Stopping before any signal. A failed write waits, with
    /// nothing signalled, for the next Force request, which retries it once
    /// (and, like every Force join, then cuts the soft grace short).
    async fn persist(&self, state: &Arc<StopState>, keys: &UnitLogKeys) {
        let mut joins = state.force_joins.subscribe();
        let unconfirmed_at = tokio::time::Instant::from_std(state.requested) + UNCONFIRMED_AFTER;
        let mut logged = false;
        loop {
            let seen = *joins.borrow_and_update();
            let (unit, st) = (self.clone(), state.clone());
            let write = blocking(move || unit.write_stopping(&st));
            tokio::pin!(write);
            let written = loop {
                tokio::select! {
                    biased;
                    written = &mut write => break written.and_then(|w| w),
                    _ = tokio::time::sleep_until(unconfirmed_at), if !logged => {
                        logged = true;
                        events::unconfirmed(keys, state.elapsed_ms(), "stopping record");
                    }
                }
            };
            match written {
                Ok(()) => {
                    lock(&self.inner.members).saved = true;
                    return;
                }
                Err(err) => events::persist_failed(keys, &err.to_string()),
            }
            loop {
                tokio::select! {
                    biased;
                    closed = async { joins.wait_for(|n| *n > seen).await.is_err() } => {
                        if closed {
                            std::future::pending::<()>().await;
                        }
                        break;
                    }
                    _ = tokio::time::sleep_until(unconfirmed_at), if !logged => {
                        logged = true;
                        events::unconfirmed(keys, state.elapsed_ms(), "stopping record");
                    }
                }
            }
        }
    }

    /// Writes Stopping (the stop's current reason) unless the record already
    /// says Stopping (a boot finish of a stop a restart interrupted).
    fn write_stopping(&self, state: &StopState) -> io::Result<()> {
        if let Some(delay) = testing::persist_delay() {
            std::thread::sleep(delay);
        }
        let mut slot = lock(&self.inner.record);
        let Some(current) = slot.as_mut() else {
            return Ok(());
        };
        if matches!(current.state, UnitRecordState::Stopping { .. }) {
            return Ok(());
        }
        let (reason, operation_id) = {
            let m = lock(&state.m);
            (m.reason.as_str().to_string(), m.operation_id.clone())
        };
        let mut next = current.clone();
        next.state = UnitRecordState::Stopping {
            reason,
            operation_id,
            since_ms: state.requested_ms,
        };
        self.inner.store.write(&next)?;
        *current = next;
        Ok(())
    }

    /// A user kill took over the stop's reason: rewrite the saved Stopping
    /// (before it is saved, step a writes the current reason itself).
    fn rewrite_stopping_reason(&self, reason: &str) -> io::Result<()> {
        let mut slot = lock(&self.inner.record);
        let Some(current) = slot.as_mut() else {
            return Ok(());
        };
        let UnitRecordState::Stopping {
            reason: saved,
            operation_id,
            since_ms,
        } = &current.state
        else {
            return Ok(());
        };
        if saved == reason {
            return Ok(());
        }
        let mut next = current.clone();
        next.state = UnitRecordState::Stopping {
            reason: reason.to_string(),
            operation_id: operation_id.clone(),
            since_ms: *since_ms,
        };
        self.inner.store.write(&next)?;
        *current = next;
        Ok(())
    }

    /// Step b (non-full backends): pin every current member before the soft
    /// signal, so one that loses both its tag and its parent link during the
    /// grace is still killed (Stage 2: LB-44).
    async fn snapshot(&self, keys: &UnitLogKeys) -> io::Result<Vec<ProcWatch>> {
        let unit = self.clone();
        let (watches, withheld) = blocking(move || {
            let list = unit.member_list().unwrap_or_default();
            let watches: Vec<ProcWatch> = list
                .members
                .into_iter()
                .filter_map(|p| ProcWatch::open_expecting(p.pid, p.start).ok())
                .collect();
            (watches, list.withheld)
        })
        .await?;
        self.note_withheld(keys, withheld);
        Ok(watches)
    }

    /// Step c: the soft signal and its grace. Returns whether the stop
    /// escalated: a Graceful grace ran out, or a Force join cut a grace short
    /// or arrived before it began (Shift-X on a Stopping unit escalates
    /// straight to force).
    async fn soft_phase(&self, state: &StopState, mode: StopMode, keys: &UnitLogKeys) -> bool {
        let mut joins = state.force_joins.subscribe();
        let (signal, signal_name, grace) = match mode {
            StopMode::Force => (Sig::Interrupt, "SIGINT", FORCE_GRACE),
            StopMode::Graceful { grace } => (Sig::Terminate, "SIGTERM", grace),
        };
        let graceful = matches!(mode, StopMode::Graceful { .. });
        let Some(target) = self.send_soft(state, signal, keys) else {
            return false;
        };
        let escalated = tokio::select! {
            biased;
            // `Ok`: the target exited. `Err`: its exit cannot be watched
            // (for example EMFILE). Either way the grace ends here and the
            // whole-unit kill follows at once, which is safe; confirm_gone
            // then meets the same watch error and reports it
            // (`unit.stop.failed`), and attempt 2 retries in Force.
            _ = target.exited() => false,
            _ = joins.wait_for(|n| *n > 0) => true,
            _ = tokio::time::sleep(grace) => graceful,
        };
        if escalated && graceful {
            events::escalated(keys, signal_name, "SIGKILL", state.elapsed_ms());
        }
        escalated
    }

    /// Sends the soft signal to the main, else runs the stop's soft
    /// interrupt, else logs `none`. Returns the process to wait for.
    fn send_soft(&self, state: &StopState, signal: Sig, keys: &UnitLogKeys) -> Option<ProcWatch> {
        let (main, screen) = {
            let m = lock(&self.inner.members);
            (
                m.main.clone().filter(|w| !w.has_exited()),
                m.screen.clone().filter(|w| !w.has_exited()),
            )
        };
        if let Some(main) = &main {
            if main.signal(signal).is_ok() {
                let name = match signal {
                    Sig::Interrupt => "SIGINT",
                    Sig::Terminate => "SIGTERM",
                    Sig::Kill => "SIGKILL",
                };
                events::signal_sent(keys, name, "main", Some(main.pid()));
                return Some(main.clone());
            }
        }
        let soft = lock(&state.m).soft_interrupt.take();
        if let Some(soft) = soft {
            soft();
            events::signal_sent(
                keys,
                "ctrl-c",
                "screen",
                screen.as_ref().map(ProcWatch::pid),
            );
            return main.or(screen);
        }
        events::signal_sent(keys, "none", "main", main.as_ref().map(ProcWatch::pid));
        None
    }

    /// Step d: kill the whole unit (sparing the daemon family), then every
    /// pinned process directly, so a unit whose container does not exist yet
    /// is still stopped. The last signal of the sequence. Returns the spared.
    async fn kill_unit(&self, keys: &UnitLogKeys, snapshot: &[ProcWatch]) -> Vec<ProcIdentity> {
        let (spared, whole_unit_killed) = self.kill_whole_unit(keys, snapshot).await;
        events::spared(keys, &spared);
        if whole_unit_killed {
            events::signal_sent(keys, "SIGKILL", "unit", None);
        }
        spared
    }

    /// The backend's whole-unit kill over every live pinned process (plus
    /// `extra`), then SIGKILL through each non-spared pinned watch. Returns
    /// the spared processes (the backend's, plus any pinned process whose
    /// own argv is Codex's daemon family, never signalled even when the
    /// whole-unit kill failed) and whether the whole-unit kill ran (a
    /// failure is logged; the pinned processes are still killed).
    async fn kill_whole_unit(
        &self,
        keys: &UnitLogKeys,
        extra: &[ProcWatch],
    ) -> (Vec<ProcIdentity>, bool) {
        let mut pinned = self.pinned_watches();
        pinned.extend(extra.iter().cloned());
        let roots = live_identities(&pinned);
        let (mut spared, whole_unit_killed) = match self.inner.backend.clone().kill_all(roots).await
        {
            Ok(summary) => {
                self.note_withheld(keys, summary.withheld);
                if let Some(detail) = &summary.not_frozen {
                    events::freeze_timeout(keys, detail);
                }
                (summary.spared, true)
            }
            Err(err) => {
                events::kill_all_failed(keys, &err.to_string());
                (Vec::new(), false)
            }
        };
        for watch in &pinned {
            if is_spared(watch, &spared) {
                continue;
            }
            // Judged by its own argv, as the backends' per-process kills
            // judge each process: a root pinned from a record written
            // before the daemon family was kept out of the roots.
            if own_argv_is_daemon_family(watch.pid()) {
                spared.push(watch.identity().clone());
                continue;
            }
            let _ = watch.signal(Sig::Kill);
        }
        (spared, whole_unit_killed)
    }

    /// Step e: wait (event-driven) for the main, the screen and every
    /// non-spared pinned root to exit, then make sure no member holds a
    /// conversation lock. Logs ERROR `unit.stop.unconfirmed` once when this
    /// takes longer than `UNCONFIRMED_AFTER` after the kill, and keeps waiting.
    ///
    /// Before its main is adopted, a unit that placed an agent has its agent
    /// main process among members nobody pinned (Codex adopts the native
    /// app-server behind its launcher only once it listens), so Gone then
    /// also waits for every member to exit (`members_exited`). Once a main
    /// is adopted, the rest of the unit is the post-Gone sweep's.
    async fn confirm_gone(
        &self,
        state: &StopState,
        keys: &UnitLogKeys,
        killed_at: Instant,
        snapshot: &[ProcWatch],
        spared: &[ProcIdentity],
    ) -> io::Result<bool> {
        let awaiting_main = {
            let m = lock(&self.inner.members);
            m.agent_placed && m.main.is_none()
        };
        let confirm = async {
            loop {
                let pinned: Vec<ProcWatch> = self
                    .pinned_watches()
                    .into_iter()
                    .filter(|w| !is_spared(w, spared))
                    .collect();
                for watch in &pinned {
                    watch.exited().await?;
                }
                // A member pinned meanwhile was killed when it was pinned;
                // wait for it too.
                if self
                    .pinned_watches()
                    .iter()
                    .all(|w| w.has_exited() || is_spared(w, spared))
                {
                    break;
                }
            }
            if awaiting_main {
                self.members_exited(spared).await?;
            }
            if let Some(delay) = testing::gone_delay() {
                tokio::time::sleep(delay).await;
            }
            self.check_locks(snapshot).await
        };
        tokio::pin!(confirm);
        let unconfirmed_at = tokio::time::Instant::from_std(killed_at) + UNCONFIRMED_AFTER;
        let waiting_on = if awaiting_main {
            "unit members or lock"
        } else {
            "screen, main or lock"
        };
        tokio::select! {
            biased;
            confirmed = &mut confirm => confirmed,
            _ = tokio::time::sleep_until(unconfirmed_at) => {
                events::unconfirmed(keys, state.elapsed_ms(), waiting_on);
                confirm.await
            }
        }
    }

    /// Waits (event-driven) until every member has exited: the backend's
    /// "unit is empty" event, unless the kill spared a process (which keeps
    /// the container populated) or the backend has none (the tag backends);
    /// then the exit of every member one read lists (spared processes are
    /// never members). An error means the unit could not be watched, never
    /// that it is empty.
    async fn members_exited(&self, spared: &[ProcIdentity]) -> io::Result<()> {
        if spared.is_empty() {
            if let Some(empty) = self.inner.backend.wait_empty() {
                return empty.await;
            }
        }
        let unit = self.clone();
        let listed = blocking(move || unit.member_list()).await??.members;
        for member in listed {
            match ProcWatch::open_expecting(member.pid, member.start) {
                Ok(watch) => watch.exited().await?,
                // Exited (and reaped) since the read.
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }

    /// The lock check runs after the whole-unit kill (a lock is released at
    /// the main's exit only when no other live process shares its open file
    /// description): every member still holding a lock path is killed
    /// through a pinned watch, then the holders are checked once more. A
    /// holder whose own argv is Codex's daemon family (a snapshot member
    /// that exec'd into it after the snapshot) is neither signalled nor
    /// waited for, so its lock still counts as held.
    #[cfg(not(target_os = "macos"))]
    async fn check_locks(&self, snapshot: &[ProcWatch]) -> io::Result<bool> {
        let paths = lock(&self.inner.lock_paths).clone();
        if paths.is_empty() {
            return Ok(true);
        }
        let first = self.member_lock_holders(&paths, snapshot).await?;
        if first.is_empty() {
            return Ok(true);
        }
        for holder in first {
            if let Ok(watch) = ProcWatch::open_expecting(holder.pid, holder.start) {
                if own_argv_is_daemon_family(watch.pid()) {
                    continue;
                }
                let _ = watch.signal(Sig::Kill);
                watch.exited().await?;
            }
        }
        Ok(self.member_lock_holders(&paths, snapshot).await?.is_empty())
    }

    /// The unit members (and live snapshot members) holding any of `paths`.
    #[cfg(not(target_os = "macos"))]
    async fn member_lock_holders(
        &self,
        paths: &[PathBuf],
        snapshot: &[ProcWatch],
    ) -> io::Result<Vec<ProcIdentity>> {
        let unit = self.clone();
        let paths = paths.to_vec();
        let snapshot = live_identity_list(snapshot);
        blocking(move || {
            let members = unit.members_and(snapshot);
            let pids: Vec<u32> = members.iter().map(|m| m.pid).collect();
            let holders = locks::lock_holders_among(&paths, &pids);
            members
                .into_iter()
                .filter(|m| holders.iter().any(|h| h.pid == m.pid))
                .collect()
        })
        .await
    }

    /// macOS: a process that has begun exiting no longer shows its
    /// descriptors, though they (and its lock) may still be open. So a
    /// member lock holder is confirmed released through an exit watch
    /// registered before its exit (the pinned roots and the snapshot taken
    /// before the soft signal; Codex's holder is normally its native main,
    /// a pinned root), awaited also for such members whose descriptors can
    /// no longer be read. An unreadable member with no such watch gets one
    /// now, which proves its exit only from the zombie or reaped state
    /// (never while it may still hold the lock), and is awaited too. A
    /// holder found after the kill with no such watch is killed, and its
    /// lock file's unlock (`NOTE_FUNLOCK`, registered before the scan that
    /// found it) is awaited. Then the holders are checked once more. A
    /// holder or member whose own argv is Codex's daemon family (a snapshot
    /// member that exec'd into it after the snapshot) is neither signalled
    /// nor waited for, so its lock still counts as held.
    #[cfg(target_os = "macos")]
    async fn check_locks(&self, snapshot: &[ProcWatch]) -> io::Result<bool> {
        let paths = lock(&self.inner.lock_paths).clone();
        if paths.is_empty() {
            return Ok(true);
        }
        let unlocks = {
            let paths = paths.clone();
            blocking(move || locks::UnlockEvents::watch(&paths)).await??
        };
        let mut watched = self.pinned_watches();
        watched.extend(snapshot.iter().cloned());
        let watch_of = |who: &ProcIdentity| {
            watched
                .iter()
                .find(|w| identity_of(w) == (who.pid, who.start))
                .cloned()
        };
        let scan = self.member_lock_scan(&paths, snapshot).await?;
        let mut awaited: Vec<ProcWatch> = Vec::new();
        let mut pending: Vec<PathBuf> = Vec::new();
        for (who, path) in &scan.holders {
            match watch_of(who) {
                Some(watch) => awaited.push(watch),
                None => {
                    // Pinned only to deliver the kill: its exit proves
                    // nothing here, the unlock does.
                    if let Ok(watch) = ProcWatch::open_expecting(who.pid, who.start) {
                        if own_argv_is_daemon_family(watch.pid()) {
                            continue;
                        }
                        let _ = watch.signal(Sig::Kill);
                    }
                    // A file created after the watch began has no unlock
                    // event to wait for; the final scan decides for it.
                    if unlocks.watches(path) && !pending.contains(path) {
                        pending.push(path.clone());
                    }
                }
            }
        }
        for who in &scan.unreadable {
            match watch_of(who) {
                Some(watch) => awaited.push(watch),
                None => match ProcWatch::open_expecting(who.pid, who.start) {
                    Ok(watch) => awaited.push(watch),
                    // Reaped (or its pid names a later process): its
                    // descriptors are closed.
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err),
                },
            }
        }
        {
            let (awaited, paths) = (awaited.clone(), paths.clone());
            blocking(move || {
                for watch in &awaited {
                    watch.watch_lock_paths(&paths);
                }
            })
            .await?;
        }
        for watch in &awaited {
            if own_argv_is_daemon_family(watch.pid()) {
                continue;
            }
            let _ = watch.signal(Sig::Kill);
            watch.exited().await?;
        }
        while !pending.is_empty() {
            let unlocked = unlocks.next().await?;
            pending.retain(|path| !unlocked.contains(path));
        }
        Ok(self
            .member_lock_scan(&paths, snapshot)
            .await?
            .holders
            .is_empty())
    }

    /// macOS: one descriptor scan of the unit members (and live snapshot
    /// members) for `paths`.
    #[cfg(target_os = "macos")]
    async fn member_lock_scan(
        &self,
        paths: &[PathBuf],
        snapshot: &[ProcWatch],
    ) -> io::Result<MemberLockScan> {
        let unit = self.clone();
        let paths = paths.to_vec();
        let snapshot = live_identity_list(snapshot);
        blocking(move || {
            let members = unit.members_and(snapshot);
            let pids: Vec<u32> = members.iter().map(|m| m.pid).collect();
            let scan = locks::scan_among(&paths, &pids);
            let member = |pid: u32| members.iter().find(|m| m.pid == pid).cloned();
            MemberLockScan {
                holders: scan
                    .holders
                    .into_iter()
                    .filter_map(|h| member(h.pid).map(|m| (m, h.path)))
                    .collect(),
                unreadable: scan.unreadable.into_iter().filter_map(member).collect(),
            }
        })
        .await
    }

    /// Step f: Gone. The report, `on_gone`, the record's deletion, then the
    /// report to every waiter.
    async fn publish_gone(
        &self,
        state: &StopState,
        keys: &UnitLogKeys,
        escalated: bool,
        lock_released: bool,
    ) -> io::Result<AttemptEnd> {
        let (reason, forced) = {
            let m = lock(&state.m);
            (m.reason.as_str().to_string(), m.forced)
        };
        let report = StopReport {
            unit_id: self.inner.id.clone(),
            reason,
            mode: if forced { "force" } else { "graceful" },
            duration_ms: state.elapsed_ms(),
            escalated,
            lock_released,
        };
        events::gone(
            keys,
            &report.reason,
            report.duration_ms,
            lock_released,
            escalated,
        );
        let on_gone = lock(&state.m).on_gone.take();
        if let Some(on_gone) = on_gone {
            let for_callback = report.clone();
            match tokio::spawn(async move { on_gone(for_callback).await }).await {
                Ok(()) => {}
                Err(err) if err.is_panic() => return Ok(AttemptEnd::OnGonePanicked),
                Err(err) => return Err(io::Error::other(err)),
            }
        }
        let unit = self.clone();
        if let Err(err) = blocking(move || unit.delete_record()).await.and_then(|r| r) {
            events::record_write_failed(keys, "remove", &err.to_string());
        }
        state.gone_tx.send_replace(Some(report));
        Ok(AttemptEnd::Gone)
    }

    fn delete_record(&self) -> io::Result<()> {
        let mut slot = lock(&self.inner.record);
        if slot.is_none() {
            return Ok(());
        }
        self.inner.store.remove(&self.inner.id)?;
        *slot = None;
        Ok(())
    }

    /// After Gone: kill anything that appeared since, wait (event-driven,
    /// bounded by `POST_GONE_EMPTY_WAIT`) for the unit to empty, log the
    /// survivors, release the unit's container.
    async fn sweep(&self, keys: &UnitLogKeys) -> Vec<ProcIdentity> {
        self.kill_whole_unit(keys, &[]).await;
        let (emptied, survivors) = match self.inner.backend.wait_empty() {
            Some(empty) => {
                let emptied = match tokio::time::timeout(POST_GONE_EMPTY_WAIT, empty).await {
                    Ok(Ok(())) => true,
                    // Never "empty": the container is kept, since a spared
                    // process may still run in it.
                    Ok(Err(err)) => {
                        events::release_failed(
                            keys,
                            &format!("cannot watch the unit for emptiness, so it is kept: {err}"),
                        );
                        false
                    }
                    Err(_) => false,
                };
                let unit = self.clone();
                let survivors = blocking(move || unit.member_list().unwrap_or_default().members)
                    .await
                    .unwrap_or_default();
                (emptied, survivors)
            }
            None => {
                // No emptiness event: wait for the exit of whatever is
                // still a member, under the same bound.
                let unit = self.clone();
                let left: Vec<ProcWatch> = blocking(move || {
                    unit.member_list()
                        .unwrap_or_default()
                        .members
                        .into_iter()
                        .filter_map(|p| ProcWatch::open_expecting(p.pid, p.start).ok())
                        .collect()
                })
                .await
                .unwrap_or_default();
                let deadline = tokio::time::Instant::now() + POST_GONE_EMPTY_WAIT;
                for watch in &left {
                    let _ = tokio::time::timeout_at(deadline, watch.exited()).await;
                }
                let survivors: Vec<ProcIdentity> = left
                    .iter()
                    .filter(|w| !w.has_exited())
                    .map(|w| w.identity().clone())
                    .collect();
                (survivors.is_empty(), survivors)
            }
        };
        events::descendants_survived(keys, &survivors);
        // Releasing can run a deadline-bounded command (systemd).
        let backend = self.inner.backend.clone();
        if let Err(err) = blocking(move || backend.remove(emptied))
            .await
            .and_then(|r| r)
        {
            events::release_failed(keys, &err.to_string());
        }
        survivors
    }

    /// The screen, the main and every extra root.
    fn pinned_watches(&self) -> Vec<ProcWatch> {
        let m = lock(&self.inner.members);
        m.screen
            .iter()
            .chain(m.main.iter())
            .chain(m.roots.iter())
            .cloned()
            .collect()
    }

    /// The live pinned processes as `(pid, start time)`: the roots a
    /// backend admits only while each pid still names that incarnation.
    fn live_roots(&self) -> Vec<(u32, u64)> {
        live_identities(&self.pinned_watches())
    }

    /// Applies `change` to the record and writes it. A failed write is
    /// logged and does not fail the caller; the in-memory record keeps the
    /// change, so the next successful write carries it.
    fn update_record(&self, change: impl FnOnce(&mut UnitRecord)) {
        let mut slot = lock(&self.inner.record);
        let Some(current) = slot.as_mut() else {
            return;
        };
        change(current);
        if let Err(err) = self.inner.store.write(current) {
            drop(slot);
            events::record_write_failed(&self.log_keys(None), "update", &err.to_string());
        }
    }

    pub(crate) fn log_keys(&self, operation_id: Option<String>) -> UnitLogKeys {
        let label = self.label();
        UnitLogKeys {
            unit_id: self.inner.id.as_str().to_string(),
            provider: label.provider,
            session_id: label.session_id,
            terminal_id: label.terminal_id,
            operation_id,
        }
    }
}

/// The unit's side of [`UnitObserver`]: members a backend reports are kept
/// as roots in the unit record. It holds the unit weakly, so a backend never
/// keeps its unit alive.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
struct RecordRoots(Weak<Inner>);

impl UnitObserver for RecordRoots {
    fn record_root(&self, pid: u32, start: u64) {
        self.roots_changed(&[(pid, start)], &[]);
    }

    fn forget_root(&self, pid: u32) {
        self.roots_changed(&[], &[pid]);
    }

    /// One record write for the whole batch (none when it changes nothing).
    fn roots_changed(&self, added: &[(u32, u64)], removed: &[u32]) {
        let Some(inner) = self.0.upgrade() else {
            return;
        };
        let unit = AgentUnit { inner };
        let changes = lock(&unit.inner.record).as_ref().is_some_and(|r| {
            r.roots.iter().any(|(pid, _)| removed.contains(pid))
                || added.iter().any(|root| !r.roots.contains(root))
        });
        if changes {
            unit.update_record(|r| {
                r.roots.retain(|(pid, _)| !removed.contains(pid));
                for root in added {
                    if !r.roots.contains(root) {
                        r.roots.push(*root);
                    }
                }
            });
        }
    }
}

/// The identities of the not-yet-exited `watches`.
fn live_identity_list(watches: &[ProcWatch]) -> Vec<ProcIdentity> {
    watches
        .iter()
        .filter(|w| !w.has_exited())
        .map(|w| w.identity().clone())
        .collect()
}

/// macOS: what one member descriptor scan found: the holders with the lock
/// file each holds, and the members whose descriptors could not be read
/// although they still run (they have begun exiting).
#[cfg(target_os = "macos")]
struct MemberLockScan {
    holders: Vec<(ProcIdentity, PathBuf)>,
    unreadable: Vec<ProcIdentity>,
}

/// The not-yet-exited `watches` as sorted, distinct `(pid, start time)`.
fn live_identities(watches: &[ProcWatch]) -> Vec<(u32, u64)> {
    let mut roots: Vec<(u32, u64)> = watches
        .iter()
        .filter(|w| !w.has_exited())
        .map(identity_of)
        .collect();
    roots.sort_unstable();
    roots.dedup();
    roots
}

/// Whether `pid`'s own argv is Codex's daemon family right now
/// (`process::is_codex_daemon_family`): the unit's own kills (the pinned
/// processes after the whole-unit kill, the Gone lock check) never signal
/// such a process. Checked right before each signal, on a pinned watch.
fn own_argv_is_daemon_family(pid: u32) -> bool {
    process::argv(pid).is_ok_and(|argv| process::is_codex_daemon_family(&argv))
}

fn is_spared(watch: &ProcWatch, spared: &[ProcIdentity]) -> bool {
    spared
        .iter()
        .any(|s| s.pid == watch.pid() && s.start == watch.identity().start)
}

impl StopState {
    fn new(req: &StopRequest) -> Self {
        let (gone_tx, gone_rx) = watch::channel(None);
        let (swept_tx, swept_rx) = watch::channel(None);
        Self {
            gone_tx,
            swept_tx,
            handle: StopHandle {
                gone: gone_rx,
                swept: swept_rx,
            },
            requested: Instant::now(),
            requested_ms: now_ms(),
            force_joins: watch::channel(0).0,
            withheld_logged: AtomicBool::new(false),
            m: Mutex::new(StopMut {
                mode: req.mode,
                forced: req.mode == StopMode::Force,
                reason: req.reason.clone(),
                operation_id: req.operation_id.clone(),
                on_gone: None,
                soft_interrupt: None,
            }),
        }
    }

    fn operation_id(&self) -> Option<String> {
        lock(&self.m).operation_id.clone()
    }

    fn elapsed_ms(&self) -> u64 {
        self.requested.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{BackendKind, KillSummary, MemberList};
    use crate::log_capture::{capture, CapturedEvent, FieldValue};

    /// A unit with no processes: the stop has nothing to signal or wait for.
    struct NoProcesses;

    impl UnitBackend for NoProcesses {
        fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
            Ok(Placement::default())
        }
        fn kill_all(
            self: Arc<Self>,
            _roots: Vec<(u32, u64)>,
        ) -> BoxFuture<'static, io::Result<KillSummary>> {
            Box::pin(async { Ok(KillSummary::default()) })
        }
        fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
            Ok(MemberList::default())
        }
        fn confirm_placement(&self, _pid: u32, _roots: &[(u32, u64)]) -> io::Result<()> {
            Ok(())
        }
        fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
            None
        }
        fn remove(&self, _emptied: bool) -> io::Result<()> {
            Ok(())
        }
    }

    /// A tag backend's report of unreadable environments, with no processes:
    /// each scan says 2 environments were withheld, each kill says 3.
    struct Withholding;

    impl UnitBackend for Withholding {
        fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
            NoProcesses.placement(role, seq)
        }
        fn kill_all(
            self: Arc<Self>,
            _roots: Vec<(u32, u64)>,
        ) -> BoxFuture<'static, io::Result<KillSummary>> {
            Box::pin(async {
                Ok(KillSummary {
                    withheld: 3,
                    ..Default::default()
                })
            })
        }
        fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
            Ok(MemberList {
                members: Vec::new(),
                withheld: 2,
            })
        }
        fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
            NoProcesses.confirm_placement(pid, roots)
        }
        fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
            None
        }
        fn remove(&self, emptied: bool) -> io::Result<()> {
            NoProcesses.remove(emptied)
        }
    }

    fn unit_on(backend: Arc<dyn UnitBackend>) -> AgentUnit {
        AgentUnit::new(
            UnitId::mint(),
            backend,
            Capability {
                kind: BackendKind::LinuxTag,
                full: false,
                reason: None,
            },
            Arc::new(RecordStore::open(std::path::Path::new(""))),
            UnitLabel {
                provider: "codex".into(),
                session_id: Some("s-1".into()),
                terminal_id: Some("t-1".into()),
                mode: "codex".into(),
                create_request_id: None,
            },
            None,
        )
    }

    /// A backend that keeps the observer its unit gives it.
    #[derive(Default)]
    struct Observed(Mutex<Option<Arc<dyn crate::backend::UnitObserver>>>);

    impl UnitBackend for Observed {
        fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
            NoProcesses.placement(role, seq)
        }
        fn kill_all(
            self: Arc<Self>,
            _roots: Vec<(u32, u64)>,
        ) -> BoxFuture<'static, io::Result<KillSummary>> {
            Box::pin(async { Ok(KillSummary::default()) })
        }
        fn members(&self, roots: &[(u32, u64)]) -> io::Result<MemberList> {
            NoProcesses.members(roots)
        }
        fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
            NoProcesses.confirm_placement(pid, roots)
        }
        fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
            None
        }
        fn remove(&self, emptied: bool) -> io::Result<()> {
            NoProcesses.remove(emptied)
        }
        fn set_observer(&self, observer: Arc<dyn crate::backend::UnitObserver>) {
            *lock(&self.0) = Some(observer);
        }
    }

    /// A backend that can no longer rely on its container to end its members
    /// (Windows kill-on-close cleared) has each one recorded as a root in the
    /// unit record, and dropped again when it exits.
    #[test]
    fn members_a_backend_reports_are_recorded_and_forgotten_as_roots() {
        let backend = Arc::new(Observed::default());
        let id = UnitId::mint();
        let record = UnitRecord {
            unit_id: id.clone(),
            provider: "codex".into(),
            mode: "codex".into(),
            terminal_id: Some("t-1".into()),
            create_request_id: None,
            conversation_keys: Vec::new(),
            roots: vec![(10, 100)],
            state: UnitRecordState::Running,
            legacy_tag: None,
        };
        let unit = AgentUnit::new(
            id,
            backend.clone(),
            Capability {
                kind: BackendKind::WindowsJob,
                full: true,
                reason: None,
            },
            Arc::new(RecordStore::open(std::path::Path::new(""))),
            UnitLabel::default(),
            Some(record),
        );
        let observer = lock(&backend.0)
            .clone()
            .expect("the unit gave its backend an observer");
        let roots = || lock(&unit.inner.record).as_ref().unwrap().roots.clone();
        observer.record_root(42, 7);
        observer.record_root(42, 7);
        observer.record_root(43, 8);
        assert_eq!(roots(), [(10, 100), (42, 7), (43, 8)]);
        observer.forget_root(42);
        assert_eq!(roots(), [(10, 100), (43, 8)]);
        // The observer never keeps the unit alive.
        drop(unit);
        observer.record_root(44, 9);
    }

    /// Every event `f` emits on this thread, `f` running on a current-thread
    /// runtime (so the stop task runs on this thread too).
    fn capture_on_runtime(f: impl std::future::Future<Output = ()>) -> Vec<CapturedEvent> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        capture(|| runtime.block_on(f))
    }

    fn named<'a>(events: &'a [CapturedEvent], name: &str) -> Vec<&'a CapturedEvent> {
        events.iter().filter(|e| e.str("event") == name).collect()
    }

    fn assert_unit_keys(event: &CapturedEvent, unit: &AgentUnit, operation_id: &str) {
        assert_eq!(event.str("unit_id"), unit.id().as_str(), "{event:?}");
        assert_eq!(event.str("provider"), "codex", "{event:?}");
        assert_eq!(event.str("session_id"), "s-1", "{event:?}");
        assert_eq!(event.str("terminal_id"), "t-1", "{event:?}");
        assert_eq!(event.str("operation_id"), operation_id, "{event:?}");
    }

    #[test]
    fn every_joining_stop_request_is_logged_with_its_own_reason_mode_and_initiator() {
        let unit = unit_on(Arc::new(NoProcesses));
        let events = capture_on_runtime(async {
            let handle = unit.stop(
                StopRequest::new(
                    StopMode::Graceful {
                        grace: Duration::from_secs(30),
                    },
                    StopReason::Cleanup,
                    "idle-cleanup",
                )
                .operation("op-1"),
            );
            // Both join before the stop task first runs.
            unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws"));
            unit.stop(StopRequest::new(
                StopMode::Force,
                StopReason::Respawn,
                "mcp",
            ));
            handle.wait().await;
        });
        let requested = named(&events, "unit.stop.requested");
        let got: Vec<(&str, &str, &str, &FieldValue, &FieldValue)> = requested
            .iter()
            .map(|e| {
                (
                    e.str("reason"),
                    e.str("mode"),
                    e.str("initiator"),
                    &e.fields["joined"],
                    &e.fields["replaced_reason"],
                )
            })
            .collect();
        let (yes, no) = (&FieldValue::Bool(true), &FieldValue::Bool(false));
        assert_eq!(
            got,
            [
                ("cleanup", "graceful", "idle-cleanup", no, no),
                ("shift-x", "force", "ws", yes, yes),
                ("respawn", "force", "mcp", yes, no),
            ]
        );
        for event in requested {
            assert_eq!(event.level, tracing::Level::INFO);
            assert_unit_keys(event, &unit, "op-1");
        }
    }

    /// A user kill that joins an agent-exit stop takes over its reason: the
    /// pane was killed, so callers that re-create after an agent exit (the
    /// crash event at Gone) must not re-create it (R6).
    #[test]
    fn a_user_kill_joining_an_agent_exit_stop_takes_over_its_reason() {
        let unit = unit_on(Arc::new(NoProcesses));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let report = runtime.block_on(async {
            let handle = unit.stop(StopRequest::new(
                StopMode::Force,
                StopReason::AgentExited { exit_code: Some(3) },
                "unit-screen-exit",
            ));
            unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws"));
            handle.wait().await
        });
        assert_eq!(report.reason, "shift-x");
    }

    #[test]
    fn the_withheld_environment_count_is_logged_with_every_key_of_the_unit() {
        let unit = unit_on(Arc::new(Withholding));
        let events = capture_on_runtime(async {
            unit.members().unwrap();
            unit.members().unwrap();
            let handle = unit.stop(
                StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws").operation("op-1"),
            );
            // The snapshot's scan reports 2 and every kill reports 3; the
            // stop logs once, the first count it met.
            handle.wait_swept().await;
        });
        let withheld = named(&events, "unit.members.environ_withheld");
        let got: Vec<(u64, &str)> = withheld
            .iter()
            .map(|e| (e.u64("count"), e.str("operation_id")))
            .collect();
        assert_eq!(got, [(2, ""), (2, ""), (2, "op-1")]);
        for event in withheld {
            assert_eq!(event.level, tracing::Level::INFO);
            assert_unit_keys(event, &unit, event.str("operation_id"));
        }
    }

    /// A unit with a Running record (no roots yet) on `backend`, and the
    /// store its record writes go to.
    fn unit_with_record(backend: Arc<dyn UnitBackend>) -> (AgentUnit, Arc<RecordStore>) {
        let id = UnitId::mint();
        let store = Arc::new(RecordStore::open(std::path::Path::new("")));
        let record = UnitRecord {
            unit_id: id.clone(),
            provider: "codex".into(),
            mode: "codex".into(),
            terminal_id: Some("t-1".into()),
            create_request_id: None,
            conversation_keys: Vec::new(),
            roots: Vec::new(),
            state: UnitRecordState::Running,
            legacy_tag: None,
        };
        let unit = AgentUnit::new(
            id,
            backend,
            Capability {
                kind: BackendKind::LinuxTag,
                full: false,
                reason: None,
            },
            store.clone(),
            UnitLabel::default(),
            Some(record),
        );
        (unit, store)
    }

    fn recorded_roots(unit: &AgentUnit) -> Vec<(u32, u64)> {
        lock(&unit.inner.record).as_ref().unwrap().roots.clone()
    }

    /// The fork tracker reports each batch of its events at once: the unit
    /// applies a whole batch with one record write, and a batch that changes
    /// nothing with none.
    #[test]
    fn a_batch_of_root_changes_is_one_record_write() {
        let backend = Arc::new(Observed::default());
        let (unit, store) = unit_with_record(backend.clone());
        let observer = lock(&backend.0).clone().unwrap();
        observer.record_root(10, 100);
        observer.record_root(11, 110);
        let before = store.writes();
        observer.roots_changed(&[(42, 7), (43, 8)], &[10]);
        assert_eq!(store.writes() - before, 1, "one batch, one write");
        assert_eq!(recorded_roots(&unit), [(11, 110), (42, 7), (43, 8)]);
        observer.roots_changed(&[(42, 7)], &[99]);
        assert_eq!(store.writes() - before, 1, "a batch that changes nothing");
    }

    /// A process of the test, killed through its pin and reaped on drop.
    #[cfg(unix)]
    struct Spawned {
        child: std::process::Child,
        watch: ProcWatch,
    }

    #[cfg(unix)]
    impl Spawned {
        /// `perl` sleeping 600 s with `extra` arguments (perl ignores them,
        /// so `app-server --managed-daemon` shapes a Codex daemon-family
        /// process). Returns once perl runs: `spawn` returns before the
        /// child's exec has finished, and until then its
        /// `/proc/<pid>/cmdline` reads this test's own argv, then nothing.
        fn perl_sleep(extra: &[&str]) -> Self {
            use std::io::{BufRead, BufReader};
            let mut child = std::process::Command::new("perl")
                .args(["-e", r#"$| = 1; print "running\n"; sleep 600"#])
                .args(extra)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            // Our own unreaped child: its pid names it.
            let watch = ProcWatch::open(child.id()).unwrap();
            let out = child.stdout.take().unwrap();
            let spawned = Self { child, watch };
            let mut line = String::new();
            BufReader::new(out).read_line(&mut line).unwrap();
            assert_eq!(line, "running\n", "perl did not start");
            spawned
        }

        /// `perl` holding an exclusive `flock` on `path` until it is killed,
        /// with `extra` arguments (ignored, as in `perl_sleep`). Returns once
        /// the lock is held.
        fn perl_lock(path: &std::path::Path, extra: &[&str]) -> Self {
            use std::io::{BufRead, BufReader};
            const HOLD: &str = r#"use Fcntl qw(:flock);
open(my $f, ">>", $ARGV[0]) or die "open: $!";
flock($f, LOCK_EX) or die "flock: $!";
$| = 1;
print "locked\n";
sleep 600;"#;
            let mut child = std::process::Command::new("perl")
                .args(["-e", HOLD])
                .arg(path)
                .args(extra)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            // Our own unreaped child: its pid names it.
            let watch = ProcWatch::open(child.id()).unwrap();
            let out = child.stdout.take().unwrap();
            let spawned = Self { child, watch };
            let mut line = String::new();
            BufReader::new(out).read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "locked", "the holder took its lock");
            spawned
        }

        fn identity(&self) -> (u32, u64) {
            identity_of(&self.watch)
        }

        /// Still running as the same process (a SIGKILL would have ended
        /// it).
        fn untouched(&self) -> bool {
            !self.watch.has_exited()
                && process::start_time(self.watch.pid()).ok() == Some(self.identity().1)
        }
    }

    #[cfg(unix)]
    impl Drop for Spawned {
        fn drop(&mut self) {
            let _ = self.watch.signal(Sig::Kill);
            let _ = self.child.wait();
        }
    }

    /// A backend that records every root it is told about (as the macOS
    /// fork tracker records each root it follows).
    #[cfg(unix)]
    #[derive(Default)]
    struct RecordsPinnedRoots(Observed);

    #[cfg(unix)]
    impl UnitBackend for RecordsPinnedRoots {
        fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
            self.0.placement(role, seq)
        }
        fn kill_all(
            self: Arc<Self>,
            _roots: Vec<(u32, u64)>,
        ) -> BoxFuture<'static, io::Result<KillSummary>> {
            Box::pin(async { Ok(KillSummary::default()) })
        }
        fn members(&self, roots: &[(u32, u64)]) -> io::Result<MemberList> {
            self.0.members(roots)
        }
        fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
            self.0.confirm_placement(pid, roots)
        }
        fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
            None
        }
        fn remove(&self, emptied: bool) -> io::Result<()> {
            self.0.remove(emptied)
        }
        fn set_observer(&self, observer: Arc<dyn crate::backend::UnitObserver>) {
            self.0.set_observer(observer);
        }
        fn root_pinned(&self, pid: u32, start: u64) {
            if let Some(observer) = lock(&(self.0).0).clone() {
                observer.record_root(pid, start);
            }
        }
    }

    /// Pinning a root writes the record once: also when the backend has
    /// already recorded it (the macOS fork tracker records every root it
    /// follows), where the unit has nothing left to write.
    #[cfg(unix)]
    #[test]
    fn pinning_a_root_writes_the_record_once() {
        let backends: [(&str, Arc<dyn UnitBackend>); 2] = [
            ("records nothing", Arc::new(NoProcesses)),
            ("records its roots", Arc::new(RecordsPinnedRoots::default())),
        ];
        for (name, backend) in backends {
            let (unit, store) = unit_with_record(backend);
            let root = Spawned::perl_sleep(&[]);
            let before = store.writes();
            unit.add_root(root.watch.clone());
            assert_eq!(store.writes() - before, 1, "{name}");
            assert_eq!(recorded_roots(&unit), [root.identity()], "{name}");
        }
    }

    /// A whole-unit kill that fails (as when a member cannot be pinned):
    /// the unit then kills its pinned processes itself.
    #[cfg(unix)]
    struct KillFails;

    #[cfg(unix)]
    impl UnitBackend for KillFails {
        fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
            NoProcesses.placement(role, seq)
        }
        fn kill_all(
            self: Arc<Self>,
            _roots: Vec<(u32, u64)>,
        ) -> BoxFuture<'static, io::Result<KillSummary>> {
            Box::pin(async { Err(io::Error::other("injected whole-unit kill failure")) })
        }
        fn members(&self, roots: &[(u32, u64)]) -> io::Result<MemberList> {
            NoProcesses.members(roots)
        }
        fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
            NoProcesses.confirm_placement(pid, roots)
        }
        fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
            None
        }
        fn remove(&self, emptied: bool) -> io::Result<()> {
            NoProcesses.remove(emptied)
        }
    }

    /// The user's rule (never signal Codex's managed daemon) on the boot
    /// path: a record written before the daemon family was kept out of the
    /// roots can name one. Finishing that unit pins and kills its other
    /// roots, also when the whole-unit kill fails, and never signals (or
    /// waits for) the daemon-family root.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_recorded_daemon_family_root_is_never_signalled_when_the_whole_unit_kill_fails() {
        let daemon = Spawned::perl_sleep(&["app-server", "--managed-daemon"]);
        let plain = Spawned::perl_sleep(&[]);
        let (unit, _store) = unit_with_record(Arc::new(KillFails));
        let events = capture(|| unit.pin_recorded_roots(&[daemon.identity(), plain.identity()]));
        let spared: Vec<u64> = named(&events, "unit.stop.spared")
            .iter()
            .map(|e| e.u64("pid"))
            .collect();
        assert_eq!(
            spared,
            [u64::from(daemon.identity().0)],
            "the boot pin leaves the daemon-family root out, and says so"
        );
        tokio::time::timeout(
            Duration::from_secs(10),
            unit.stop(StopRequest::new(
                StopMode::Force,
                StopReason::BootFinish,
                "boot",
            ))
            .wait_swept(),
        )
        .await
        .expect("Gone, without waiting for the daemon-family root");
        tokio::time::timeout(Duration::from_secs(5), plain.watch.exited())
            .await
            .expect("the plain root was killed")
            .unwrap();
        assert!(daemon.untouched(), "the daemon-family root was signalled");
    }

    /// The same rule where the unit kills its pinned processes itself: a
    /// pinned process whose own argv is the daemon family is spared, not
    /// killed and not waited for, when the whole-unit kill fails.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_pinned_daemon_family_process_is_never_signalled_when_the_whole_unit_kill_fails() {
        let daemon = Spawned::perl_sleep(&["app-server", "--managed-daemon"]);
        let plain = Spawned::perl_sleep(&[]);
        let (unit, _store) = unit_with_record(Arc::new(KillFails));
        unit.add_root(daemon.watch.clone());
        unit.add_root(plain.watch.clone());
        tokio::time::timeout(
            Duration::from_secs(10),
            unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws"))
                .wait_swept(),
        )
        .await
        .expect("Gone, without waiting for the daemon-family process");
        tokio::time::timeout(Duration::from_secs(5), plain.watch.exited())
            .await
            .expect("the plain root was killed")
            .unwrap();
        assert!(
            daemon.untouched(),
            "the daemon-family process was signalled"
        );
    }

    /// The same rule in the Gone lock check, whose holders include the
    /// live members of the pre-signal snapshot: a snapshot member whose own
    /// argv is the daemon family by the time of the check (one that exec'd
    /// into it after the snapshot) is neither signalled nor waited for,
    /// although it holds a unit lock file, and that lock then counts as
    /// still held. A plain snapshot member holding the other lock file is
    /// still killed.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_lock_check_never_signals_a_daemon_family_holder() {
        let dir = tempfile::tempdir().unwrap();
        let daemon_lock = dir.path().join("daemon.lock");
        let plain_lock = dir.path().join("plain.lock");
        let daemon = Spawned::perl_lock(&daemon_lock, &["app-server", "--managed-daemon"]);
        let plain = Spawned::perl_lock(&plain_lock, &[]);
        let unit = unit_on(Arc::new(NoProcesses));
        unit.set_lock_paths(vec![daemon_lock, plain_lock]);
        let snapshot = [daemon.watch.clone(), plain.watch.clone()];
        let released = tokio::time::timeout(Duration::from_secs(10), unit.check_locks(&snapshot))
            .await
            .expect("the check ended without waiting for the daemon-family holder")
            .unwrap();
        assert!(
            daemon.untouched(),
            "the lock check signalled the daemon-family holder"
        );
        assert!(plain.watch.has_exited(), "the plain holder was killed");
        assert!(
            !released,
            "the daemon-family holder still holds its lock file"
        );
    }

    /// A unit whose members the whole-unit kill reached but which are still
    /// exiting: its members are the `listed` processes still running, its
    /// kill signals none of them (the test ends each when it chooses) and
    /// reports `spared` as spared, and its "unit is empty" event, when it
    /// has one, fires only once the test sends `true`.
    #[cfg(unix)]
    struct Exiting {
        listed: Vec<ProcWatch>,
        spared: Vec<ProcIdentity>,
        empty: Option<watch::Sender<bool>>,
    }

    #[cfg(unix)]
    impl UnitBackend for Exiting {
        fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
            NoProcesses.placement(role, seq)
        }
        fn kill_all(
            self: Arc<Self>,
            _roots: Vec<(u32, u64)>,
        ) -> BoxFuture<'static, io::Result<KillSummary>> {
            let spared = self.spared.clone();
            Box::pin(async move {
                Ok(KillSummary {
                    spared,
                    ..Default::default()
                })
            })
        }
        fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
            Ok(MemberList {
                members: live_identity_list(&self.listed),
                withheld: 0,
            })
        }
        fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
            NoProcesses.confirm_placement(pid, roots)
        }
        fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
            let mut emptied = self.empty.as_ref()?.subscribe();
            Some(Box::pin(async move {
                emptied
                    .wait_for(|empty| *empty)
                    .await
                    .map(|_| ())
                    .map_err(io::Error::other)
            }))
        }
        fn remove(&self, emptied: bool) -> io::Result<()> {
            NoProcesses.remove(emptied)
        }
    }

    /// `unit_on` with kernel-tracked membership: its stop takes no
    /// pre-signal member snapshot, so it never pins (and kills) a member
    /// the backend lists.
    #[cfg(unix)]
    fn unit_on_full(backend: Arc<dyn UnitBackend>) -> AgentUnit {
        AgentUnit::new(
            UnitId::mint(),
            backend,
            Capability {
                kind: BackendKind::SystemdScope,
                full: true,
                reason: None,
            },
            Arc::new(RecordStore::open(std::path::Path::new(""))),
            UnitLabel::default(),
            None,
        )
    }

    /// The stop a kill of a pane that is still starting sends.
    #[cfg(unix)]
    fn start_cancelled() -> StopRequest {
        StopRequest::new(StopMode::Force, StopReason::StartCancelled, "ws")
    }

    /// A unit stopped before its main is adopted (Codex adopts the native
    /// app-server behind its launcher only once it listens) has its agent
    /// main process among members nobody pinned: Gone waits for the unit to
    /// be empty (here the backend's emptiness event), not only for the
    /// pinned launcher. Unconfirmed after 5 s, it logs the ERROR and stays
    /// Stopping, never Gone.
    #[cfg(unix)]
    #[test]
    fn a_stop_before_the_main_is_adopted_is_gone_only_once_the_unit_is_empty() {
        let (empty, _) = watch::channel(false);
        let (unit, _store) = unit_with_record(Arc::new(Exiting {
            listed: Vec::new(),
            spared: Vec::new(),
            empty: Some(empty.clone()),
        }));
        let launcher = Spawned::perl_sleep(&[]);
        let mut report = None;
        let events = capture_on_runtime(async {
            unit.placement(MemberRole::Agent).unwrap();
            unit.add_root(launcher.watch.clone());
            let handle = unit.stop(start_cancelled());
            tokio::time::timeout(Duration::from_secs(10), launcher.watch.exited())
                .await
                .expect("the pinned launcher was killed")
                .unwrap();
            assert!(
                handle
                    .wait_for(UNCONFIRMED_AFTER + Duration::from_millis(500))
                    .await
                    .is_none(),
                "Gone before the unit was empty"
            );
            assert!(
                matches!(
                    lock(&unit.inner.record).as_ref().map(|r| &r.state),
                    Some(UnitRecordState::Stopping { .. })
                ),
                "an unconfirmed stop keeps its record Stopping"
            );
            empty.send_replace(true);
            report = handle.wait_for(Duration::from_secs(5)).await;
        });
        assert!(report.is_some(), "Gone once the unit is empty");
        let unconfirmed = named(&events, "unit.stop.unconfirmed");
        assert_eq!(unconfirmed.len(), 1, "{events:?}");
        assert_eq!(unconfirmed[0].level, tracing::Level::ERROR);
        assert_eq!(unconfirmed[0].str("waiting_on"), "unit members or lock");
    }

    /// Once the main is adopted, Gone's rule is unchanged: it waits for the
    /// screen, the main and the pinned roots, never for the unit to empty
    /// (what else is left is the post-Gone sweep's).
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn once_the_main_is_adopted_gone_does_not_wait_for_the_unit_to_empty() {
        let (empty, _) = watch::channel(false);
        let unit = unit_on(Arc::new(Exiting {
            listed: Vec::new(),
            spared: Vec::new(),
            empty: Some(empty.clone()),
        }));
        let launcher = Spawned::perl_sleep(&[]);
        let native = Spawned::perl_sleep(&[]);
        unit.placement(MemberRole::Agent).unwrap();
        unit.add_root(launcher.watch.clone());
        unit.set_main(native.watch.clone());
        let handle = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws"));
        assert!(
            handle.wait_for(Duration::from_secs(5)).await.is_some(),
            "Gone waited for the unit to empty although its main was adopted"
        );
        drop(empty);
    }

    /// Without an emptiness event (the tag backends), Gone before the main
    /// is adopted waits for the exit of every member one read after the
    /// kill lists: here the unpinned native a launcher started.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_an_emptiness_event_a_stop_before_the_main_is_adopted_waits_for_every_member() {
        let launcher = Spawned::perl_sleep(&[]);
        let native = Spawned::perl_sleep(&[]);
        let unit = unit_on_full(Arc::new(Exiting {
            listed: vec![native.watch.clone()],
            spared: Vec::new(),
            empty: None,
        }));
        unit.placement(MemberRole::Agent).unwrap();
        unit.add_root(launcher.watch.clone());
        let handle = unit.stop(start_cancelled());
        tokio::time::timeout(Duration::from_secs(10), launcher.watch.exited())
            .await
            .expect("the pinned launcher was killed")
            .unwrap();
        assert!(
            handle.wait_for(Duration::from_millis(300)).await.is_none(),
            "Gone while a member still ran"
        );
        native.watch.signal(Sig::Kill).unwrap();
        assert!(
            handle.wait_for(Duration::from_secs(5)).await.is_some(),
            "Gone once every member exited"
        );
    }

    /// A kill that spared a process (Codex's daemon family) leaves the
    /// container populated, so its emptiness event never comes: Gone before
    /// the main is adopted then waits for the members one read lists (the
    /// spared are never members), never for the spared process.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_that_spared_a_process_waits_for_the_members_not_for_the_unit_to_empty() {
        let (empty, _) = watch::channel(false);
        let daemon = Spawned::perl_sleep(&["app-server", "--managed-daemon"]);
        let launcher = Spawned::perl_sleep(&[]);
        let native = Spawned::perl_sleep(&[]);
        let unit = unit_on_full(Arc::new(Exiting {
            listed: vec![native.watch.clone()],
            spared: vec![daemon.watch.identity().clone()],
            empty: Some(empty.clone()),
        }));
        unit.placement(MemberRole::Agent).unwrap();
        unit.add_root(launcher.watch.clone());
        let handle = unit.stop(start_cancelled());
        tokio::time::timeout(Duration::from_secs(10), launcher.watch.exited())
            .await
            .expect("the pinned launcher was killed")
            .unwrap();
        assert!(
            handle.wait_for(Duration::from_millis(300)).await.is_none(),
            "Gone while a member still ran"
        );
        native.watch.signal(Sig::Kill).unwrap();
        assert!(
            handle.wait_for(Duration::from_secs(5)).await.is_some(),
            "Gone waited for an emptiness event the spared process holds back"
        );
        assert!(daemon.untouched(), "the spared process was signalled");
        drop(empty);
    }

    /// macOS: the Gone lock check, on a backend whose members are exactly
    /// the listed processes (while each still runs as listed), so a member
    /// can lack any exit watch of the unit's.
    #[cfg(target_os = "macos")]
    mod macos {
        use super::*;
        use std::io::{BufRead, BufReader, Read};
        use std::os::fd::{FromRawFd, OwnedFd};
        use std::os::unix::process::CommandExt;
        use std::process::{Child, Command, Stdio};

        use crate::process;

        struct Listed(Vec<ProcIdentity>);

        impl UnitBackend for Listed {
            fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
                NoProcesses.placement(role, seq)
            }
            fn kill_all(
                self: Arc<Self>,
                _roots: Vec<(u32, u64)>,
            ) -> BoxFuture<'static, io::Result<KillSummary>> {
                Box::pin(async { Ok(KillSummary::default()) })
            }
            fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
                Ok(MemberList {
                    members: self
                        .0
                        .iter()
                        .filter(|p| {
                            process::is_running(p.pid)
                                && process::start_time(p.pid).ok() == Some(p.start)
                        })
                        .cloned()
                        .collect(),
                    withheld: 0,
                })
            }
            fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
                NoProcesses.confirm_placement(pid, roots)
            }
            fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
                None
            }
            fn remove(&self, emptied: bool) -> io::Result<()> {
                NoProcesses.remove(emptied)
            }
        }

        /// Kills its process through the pin when dropped.
        struct KillOnDrop(ProcWatch);

        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = self.0.signal(Sig::Kill);
            }
        }

        /// The test's own child, killed (if still running) and reaped on
        /// drop: an unreaped child's pid always names it.
        struct Reaped(Child);

        impl Drop for Reaped {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        /// A lock holder the member scan finds with no exit watch the unit
        /// registered before the kill (a member the snapshot missed) is
        /// killed, and the check then waits for its lock file's unlock
        /// event. Here the lock outlives the holder, because a process
        /// outside the unit shares its open file, so the check ends only
        /// once that one lets go.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn a_holder_with_no_exit_watch_is_killed_and_its_unlock_awaited() {
            const SHARED_LOCK: &str = r#"use Fcntl qw(:flock);
open(my $f, ">>", $ARGV[0]) or die "open: $!";
flock($f, LOCK_EX) or die "flock: $!";
my $sharer = fork() // die "fork: $!";
if ($sharer == 0) { close(STDOUT); sleep 600; exit 0; }
$| = 1;
print "locked $sharer\n";
close(STDOUT);
sleep 600;"#;
            let dir = tempfile::tempdir().unwrap();
            let lock = dir.path().join("t.lock");
            let mut child = Command::new("perl")
                .args(["-e", SHARED_LOCK, lock.to_str().unwrap()])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let out = child.stdout.take().unwrap();
            let holder = Reaped(child);
            let mut line = String::new();
            BufReader::new(out).read_line(&mut line).unwrap();
            let sharer: u32 = line
                .trim()
                .strip_prefix("locked ")
                .unwrap_or_else(|| panic!("the holder took the lock: {line:?}"))
                .parse()
                .unwrap();
            // The sharer is pinned while its parent, the holder, sleeps.
            let sharer_pin = KillOnDrop(ProcWatch::open(sharer).unwrap());
            let holder_pin = ProcWatch::open(holder.0.id()).unwrap();
            let unit = unit_on(Arc::new(Listed(vec![holder_pin.identity().clone()])));
            unit.set_lock_paths(vec![lock.clone()]);
            let check = tokio::spawn({
                let unit = unit.clone();
                async move { unit.check_locks(&[]).await }
            });
            tokio::time::timeout(Duration::from_secs(5), holder_pin.exited())
                .await
                .expect("the check killed the holder")
                .unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(
                !check.is_finished(),
                "the check ended while the lock was still held (through the sharer)"
            );
            sharer_pin.0.signal(Sig::Kill).unwrap();
            let released = tokio::time::timeout(Duration::from_secs(10), check)
                .await
                .expect("the unlock ended the check")
                .unwrap()
                .unwrap();
            assert!(released, "the lock is released");
        }

        /// A member the descriptor scan reports unreadable (its answer for a
        /// process that has begun exiting, given here for a live process of
        /// the test, so the case does not hang on how long a real exit
        /// takes) and that has no exit watch of the unit's: the check opens
        /// a watch, kills the member through it and waits for its exit
        /// before it says the lock is released.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn an_unreadable_member_with_no_exit_watch_is_killed_and_awaited() {
            let dir = tempfile::tempdir().unwrap();
            let lock = dir.path().join("t.lock");
            std::fs::write(&lock, b"").unwrap();
            let member = Reaped(
                Command::new("perl")
                    .args(["-e", "sleep 600"])
                    .spawn()
                    .unwrap(),
            );
            // Our own unreaped child: its pid names it.
            let pin = ProcWatch::open(member.0.id()).unwrap();
            let _reported = crate::locks::test_unreadable::report(pin.pid());
            let unit = unit_on(Arc::new(Listed(vec![pin.identity().clone()])));
            unit.set_lock_paths(vec![lock]);
            let check = tokio::spawn({
                let unit = unit.clone();
                let pin = pin.clone();
                async move {
                    let released = unit.check_locks(&[]).await;
                    (released, pin.has_exited())
                }
            });
            let (released, proven) = tokio::time::timeout(Duration::from_secs(10), check)
                .await
                .expect("the check ended")
                .unwrap();
            assert!(released.unwrap(), "the lock is released");
            assert!(
                proven,
                "the check ended while the unreadable member still ran"
            );
        }

        /// A process in the middle of its exit: a session leader whose
        /// terminal output nobody reads, killed while its write is blocked.
        /// On both hosted runners it stays exiting (descriptors closed, no
        /// exit event yet, not a zombie, invisible to a lookup that skips
        /// exiting processes) for about a second after the kill, then
        /// finishes (diagnosis run 38032748496); the test acts inside that
        /// window. Closing the terminal's master side lets the exit finish,
        /// should a kernel make it wait longer.
        struct ExitingLeader {
            /// Reaped when the fixture is dropped, after the master closed.
            _child: Reaped,
            master: Option<OwnedFd>,
            pin: ProcWatch,
        }

        impl ExitingLeader {
            fn start() -> Self {
                let (mut master, mut slave) = (-1, -1);
                // SAFETY: out-pointers to two ints; no name, termios or size.
                let rc = unsafe {
                    libc::openpty(
                        &mut master,
                        &mut slave,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                assert_eq!(rc, 0, "openpty: {}", io::Error::last_os_error());
                // SAFETY: the fresh descriptors openpty returned, owned here.
                let (master, slave) =
                    unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
                let mut cmd = Command::new("perl");
                cmd.args(["-e", "$| = 1; print STDOUT 'x' x 4194304; sleep 600"])
                    .stdin(Stdio::from(slave.try_clone().unwrap()))
                    .stdout(Stdio::from(slave))
                    .stderr(Stdio::null());
                // SAFETY: only async-signal-safe calls between fork and exec.
                unsafe {
                    cmd.pre_exec(|| {
                        if libc::setsid() < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        if libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0) < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
                let child = Reaped(cmd.spawn().unwrap());
                let pin = ProcWatch::open(child.0.id()).unwrap();
                // Built first, so a failure below closes the master before
                // the child is reaped.
                let fixture = Self {
                    _child: child,
                    master: Some(master),
                    pin,
                };
                // It writes (the first byte arrives), then fills the
                // terminal's output queue and blocks.
                let mut first = [0u8; 1];
                let master = fixture.master.as_ref().unwrap();
                std::fs::File::from(master.try_clone().unwrap())
                    .read_exact(&mut first)
                    .unwrap();
                std::thread::sleep(Duration::from_millis(500));
                fixture.pin.signal(Sig::Kill).unwrap();
                let pid = fixture.pin.pid();
                let exiting = || {
                    !fixture.pin.has_exited()
                        && crate::darwin::fds(pid).is_err()
                        && crate::darwin::bsdinfo(pid).is_ok_and(|i| !crate::darwin::is_zombie(&i))
                };
                let deadline = Instant::now() + Duration::from_millis(400);
                while !exiting() {
                    assert!(
                        Instant::now() < deadline,
                        "fixture: the killed session leader was never seen exiting"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
                fixture
            }

            /// Closes the terminal's master side: the exit can finish.
            fn release(&mut self) {
                self.master.take();
            }
        }

        /// The master closes first, so the child's exit can complete before
        /// it is reaped (field drop).
        impl Drop for ExitingLeader {
            fn drop(&mut self) {
                self.master.take();
                let _ = self.pin.signal(Sig::Kill);
            }
        }

        /// A member that has begun exiting shows no descriptors, so the scan
        /// cannot tell whether it still holds a lock. With no exit watch of
        /// the unit's registered before its exit, the check opens one now
        /// (such a watch proves the exit only from the zombie or reaped
        /// state) and waits for it: when the check says the lock is
        /// released, the member's exit is proven (its own exit event, on a
        /// watch the test opened before the kill, has arrived).
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn an_exiting_member_with_no_exit_watch_is_awaited_before_the_lock_counts_as_released(
        ) {
            let dir = tempfile::tempdir().unwrap();
            let lock = dir.path().join("t.lock");
            std::fs::write(&lock, b"").unwrap();
            let mut exiting = ExitingLeader::start();
            let unit = unit_on(Arc::new(Listed(vec![exiting.pin.identity().clone()])));
            unit.set_lock_paths(vec![lock]);
            let mut check = tokio::spawn({
                let unit = unit.clone();
                let pin = exiting.pin.clone();
                async move {
                    let released = unit.check_locks(&[]).await;
                    (released, pin.has_exited())
                }
            });
            let outcome = match tokio::time::timeout(Duration::from_secs(2), &mut check).await {
                Ok(done) => done,
                Err(_) => {
                    exiting.release();
                    tokio::time::timeout(Duration::from_secs(15), check)
                        .await
                        .expect("the member's exit was proven")
                }
            };
            let (released, proven) = outcome.unwrap();
            assert!(released.unwrap(), "the lock is released");
            assert!(proven, "the check ended while the member was still exiting");
        }
    }
}

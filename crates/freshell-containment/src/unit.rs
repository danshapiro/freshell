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
//! main process and every pinned root are confirmed dead and no member holds
//! a conversation lock, and leftovers are swept (and survivors logged) after
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
use crate::process::ProcIdentity;
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
    /// read `StopReport::reason` and must not re-create what a user killed.
    fn yields_to_user_kill(&self) -> bool {
        matches!(
            self,
            Self::Respawn | Self::StuckRestart | Self::Handoff | Self::Cleanup
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
        if lock(&self.inner.members).stopping {
            return Err(io::Error::other(format!(
                "unit {} is stopping",
                self.inner.id
            )));
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

    /// The owner operation of the stop in flight, if any.
    fn stop_operation(&self) -> Option<String> {
        lock(&self.inner.stop)
            .as_ref()
            .and_then(|s| s.operation_id())
    }

    /// Pins recorded roots by (pid, start) without rewriting the record; a
    /// root that cannot be pinned is never signalled (Stage 2: LB-02).
    pub(crate) fn pin_recorded_roots(&self, roots: &[(u32, u64)]) {
        for (pid, start) in roots {
            // Told to the backend even when it has exited (it then ignores
            // it).
            self.inner.backend.root_pinned(*pid, *start);
            match ProcWatch::open_expecting(*pid, *start) {
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
    /// stuck-restart, handoff or cleanup stop takes over its reason. A
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
        let spared = self.kill_whole_unit(keys, snapshot).await;
        if let Some(spared) = &spared {
            events::spared(keys, spared);
            events::signal_sent(keys, "SIGKILL", "unit", None);
        }
        spared.unwrap_or_default()
    }

    /// The backend's whole-unit kill over every live pinned process (plus
    /// `extra`), then SIGKILL through each non-spared pinned watch. Returns
    /// the spared processes, or `None` when the whole-unit kill failed
    /// (logged; the pinned processes are still killed).
    async fn kill_whole_unit(
        &self,
        keys: &UnitLogKeys,
        extra: &[ProcWatch],
    ) -> Option<Vec<ProcIdentity>> {
        let mut pinned = self.pinned_watches();
        pinned.extend(extra.iter().cloned());
        let roots = live_identities(&pinned);
        let spared = match self.inner.backend.clone().kill_all(roots).await {
            Ok(summary) => {
                self.note_withheld(keys, summary.withheld);
                if let Some(detail) = &summary.not_frozen {
                    events::freeze_timeout(keys, detail);
                }
                Some(summary.spared)
            }
            Err(err) => {
                events::kill_all_failed(keys, &err.to_string());
                None
            }
        };
        let none = Vec::new();
        let skip = spared.as_ref().unwrap_or(&none);
        for watch in pinned.iter().filter(|w| !is_spared(w, skip)) {
            let _ = watch.signal(Sig::Kill);
        }
        spared
    }

    /// Step e: wait (event-driven) for the main, the screen and every
    /// non-spared pinned root to exit, then make sure no member holds a
    /// conversation lock. Logs ERROR `unit.stop.unconfirmed` once when this
    /// takes longer than `UNCONFIRMED_AFTER` after the kill, and keeps waiting.
    async fn confirm_gone(
        &self,
        state: &StopState,
        keys: &UnitLogKeys,
        killed_at: Instant,
        snapshot: &[ProcWatch],
        spared: &[ProcIdentity],
    ) -> io::Result<bool> {
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
            if let Some(delay) = testing::gone_delay() {
                tokio::time::sleep(delay).await;
            }
            self.check_locks(snapshot).await
        };
        tokio::pin!(confirm);
        let unconfirmed_at = tokio::time::Instant::from_std(killed_at) + UNCONFIRMED_AFTER;
        tokio::select! {
            biased;
            confirmed = &mut confirm => confirmed,
            _ = tokio::time::sleep_until(unconfirmed_at) => {
                events::unconfirmed(keys, state.elapsed_ms(), "screen, main or lock");
                confirm.await
            }
        }
    }

    /// The lock check runs after the whole-unit kill (a lock is released at
    /// the main's exit only when no other live process shares its open file
    /// description): every member still holding a lock path is killed
    /// through a pinned watch, then the holders are checked once more.
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
    /// descriptors, though they (and its lock) may still be open, and a
    /// watch opened on it then proves nothing until it is a zombie. So a
    /// member lock holder is confirmed released only through an exit watch
    /// registered before its exit (the pinned roots and the snapshot taken
    /// before the soft signal; Codex's holder is normally its native main,
    /// a pinned root), awaited also for such members whose descriptors can
    /// no longer be read. A holder found after the kill with no such watch
    /// is killed, and its lock file's unlock (`NOTE_FUNLOCK`, registered
    /// before the scan that found it) is awaited. Then the holders are
    /// checked once more.
    #[cfg(target_os = "macos")]
    async fn check_locks(&self, snapshot: &[ProcWatch]) -> io::Result<bool> {
        let paths = lock(&self.inner.lock_paths).clone();
        if paths.is_empty() {
            return Ok(true);
        }
        let unlocks = locks::UnlockEvents::watch(&paths)?;
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
        awaited.extend(scan.unreadable.iter().filter_map(watch_of));
        for watch in &awaited {
            watch.watch_lock_paths(&paths);
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
        let Some(inner) = self.0.upgrade() else {
            return;
        };
        let unit = AgentUnit { inner };
        let present = lock(&unit.inner.record)
            .as_ref()
            .is_none_or(|r| r.roots.contains(&(pid, start)));
        if !present {
            unit.update_record(|r| {
                if !r.roots.contains(&(pid, start)) {
                    r.roots.push((pid, start));
                }
            });
        }
    }

    fn forget_root(&self, pid: u32) {
        let Some(inner) = self.0.upgrade() else {
            return;
        };
        let unit = AgentUnit { inner };
        let present = lock(&unit.inner.record)
            .as_ref()
            .is_some_and(|r| r.roots.iter().any(|(p, _)| *p == pid));
        if present {
            unit.update_record(|r| r.roots.retain(|(p, _)| *p != pid));
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
}

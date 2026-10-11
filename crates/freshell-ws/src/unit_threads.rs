//! Every thread a Codex pane's app-server holds is held by the pane's unit
//! (Stage 2: LB-38, LB-25, LB-29, LB-51).
//!
//! What Codex 0.162 announces on the TUI's proxied connection (V9):
//! - a fork, and another client's `thread/start`: `thread/started`;
//! - a helper-agent spawn and a cold resume: NO `thread/started`; the first
//!   `thread/status/changed` for an unseen id is the announcement, and the
//!   parent's `collabAgentToolCall` names a helper (`receiverThreadIds`);
//! - an unload: `thread/closed`, or a lone `notLoaded` status (a helper its
//!   parent closed);
//! - the TUI's per-turn title threads are ephemeral: they have no lock file
//!   and are never held.
//!
//! Threads loaded before any of that was seen (the earlier conversations of
//! a reattached app-server), or that no event announced, are found by one
//! read of the lock files the unit's members hold: after a create adopts
//! its launch ([`reconcile_loaded`]), and right before a stop signals
//! anything ([`reconcile_before_stop`], under [`STOP_READ_DEADLINE`]).
//!
//! A held thread other than the pane's main conversation is an `Extra` hold
//! of the pane's unit in the owner registry (a stop moves it to Stopping and
//! Gone releases it), a conversation key of the unit record (a restart that
//! finishes the stop restores it as Stopping) and a held thread of the
//! sidecar record (any held thread claims the sidecar at boot). Only a new
//! id, a drop, or an ephemeral id that was held touches those; status
//! traffic for a known thread is one map lookup and an in-memory update (a
//! thread whose hold was refused tries the hold again), so the serial proxy
//! router never writes a file per event. Sidecar record writes run in order
//! on one task per terminal, never on the router.
//!
//! The unit's lock paths, which the Gone lock check reads, are kept here for
//! every Codex pane on every OS ([`refresh_lock_paths`]): the writer lock of
//! the pane's main conversation and of every thread its table knows, under
//! the Codex home the app-server reported.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use freshell_codex::launch_lifecycle::CodexTerminalLaunchManager;
use freshell_containment::UnitEntry;
use freshell_ownership::{HoldKind, HoldOutcome, OwnerIdentity, OwnershipState, RuntimeOwnerKind};
use tokio::sync::mpsc;

use crate::WsState;

const CODEX: &str = "codex";
/// The status type Codex reports for an unloaded thread.
const NOT_LOADED: &str = "notLoaded";
/// The status type of a thread running a turn.
const ACTIVE: &str = "active";
/// How many of a terminal's most recent ephemeral thread ids are kept: the
/// TUI starts a title thread every turn, and each is announced and finished
/// within its own short turn, so older ones are forgotten instead of kept
/// for the pane's whole life.
const EPHEMERAL_REMEMBERED: usize = 64;

/// How long a stop waits, before its first signal, for the read of the
/// threads the app-server holds ([`reconcile_before_stop`]). The read takes
/// milliseconds; it can block only on a Codex home that does not answer (a
/// hung network mount), and then the stop goes on without it.
pub const STOP_READ_DEADLINE: Duration = Duration::from_secs(1);

/// Per terminal: every thread its app-server is known to hold, with the
/// status type last seen, plus its recent ephemeral thread ids. One mutex,
/// never held across an await or a file write.
#[derive(Debug, Default)]
pub struct ThreadTables {
    terminals: Mutex<HashMap<String, TerminalThreads>>,
}

#[derive(Debug, Default)]
struct TerminalThreads {
    threads: HashMap<String, KnownThread>,
    ephemeral: RecentIds,
    /// The terminal's sidecar record writer (see [`write_record`]).
    record_writer: Option<mpsc::UnboundedSender<RecordOp>>,
}

#[derive(Debug, Default)]
struct KnownThread {
    /// The `thread/status/changed` type last seen.
    status: Option<String>,
    hold: Hold,
}

/// What the pane's unit holds of a known thread.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Hold {
    /// Nothing as an extra thread: the pane's main conversation, or a
    /// thread whose extra hold [`release_for_main`] gave up.
    #[default]
    None,
    /// An extra thread of the unit: its registry hold, unit record key and
    /// sidecar record entry are this table's to release.
    OnUnit,
    /// Its extra hold was refused (another pane holds it, or its key was in
    /// a transition): the next announcement of the thread, or the read
    /// before a stop, tries again.
    Refused,
}

/// The most recent ids, the oldest forgotten first (at most
/// [`EPHEMERAL_REMEMBERED`]).
#[derive(Debug, Default)]
struct RecentIds(VecDeque<String>);

impl RecentIds {
    fn contains(&self, id: &str) -> bool {
        self.0.iter().any(|known| known == id)
    }

    fn insert(&mut self, id: &str) {
        if self.contains(id) {
            return;
        }
        if self.0.len() == EPHEMERAL_REMEMBERED {
            self.0.pop_front();
        }
        self.0.push_back(id.to_string());
    }

    fn remove(&mut self, id: &str) {
        self.0.retain(|known| known != id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// A sidecar record change, applied in order by the terminal's writer.
#[derive(Debug)]
enum RecordOp {
    Note(Vec<String>),
    Forget(String),
}

impl ThreadTables {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, TerminalThreads>> {
        self.terminals.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Runs `f` on the terminal's table, creating it on the terminal's first
/// thread event, but only for a terminal that runs in a unit (`None`
/// otherwise).
fn with_table<R>(
    state: &WsState,
    terminal_id: &str,
    f: impl FnOnce(&mut TerminalThreads) -> R,
) -> Option<R> {
    let tables = &state.units.threads;
    {
        let mut terminals = tables.lock();
        if let Some(table) = terminals.get_mut(terminal_id) {
            return Some(f(table));
        }
    }
    state.units.by_terminal(terminal_id)?;
    Some(f(tables.lock().entry(terminal_id.to_string()).or_default()))
}

/// Runs `f` on the terminal's table if it has one.
fn with_existing_table<R>(
    state: &WsState,
    terminal_id: &str,
    f: impl FnOnce(&mut TerminalThreads) -> R,
) -> Option<R> {
    state.units.threads.lock().get_mut(terminal_id).map(f)
}

/// The unit's log keys for a thread line of `terminal_id`.
macro_rules! thread_event {
    ($level:ident, $entry:expr, $terminal_id:expr, $event:literal, $($rest:tt)*) => {{
        let entry: &UnitEntry = $entry;
        tracing::$level!(target: "freshell_unit",
            event = $event,
            unit_id = %entry.unit.id(),
            provider = %entry.provider,
            session_id = %entry.unit.label().session_id.unwrap_or_default(),
            terminal_id = %$terminal_id,
            operation_id = %entry.unit.stop_operation().unwrap_or_default(),
            $($rest)*)
    }};
}

/// The terminal's app-server holds `thread_id`. A no-op for an id already
/// known for the terminal (unless its extra hold was refused, which is
/// tried again) or known ephemeral. Otherwise the id is recorded and,
/// unless it is the terminal's main conversation, held by the pane's unit
/// as an extra thread (`hold_extra`), added to the unit record's
/// conversation keys and to the sidecar record (written off the caller).
pub fn note_thread(state: &WsState, terminal_id: &str, thread_id: &str) {
    note_with_status(state, terminal_id, thread_id, None);
}

fn note_with_status(
    state: &WsState,
    terminal_id: &str,
    thread_id: &str,
    status: Option<&str>,
) -> Hold {
    if thread_id.is_empty() {
        return Hold::None;
    }
    enum Seen {
        Ignored,
        New,
        Retry,
    }
    let seen = with_table(state, terminal_id, |table| {
        if table.ephemeral.contains(thread_id) {
            return Seen::Ignored;
        }
        match table.threads.get(thread_id) {
            Some(known) if known.hold == Hold::Refused => Seen::Retry,
            Some(_) => Seen::Ignored,
            None => {
                table.threads.insert(
                    thread_id.to_string(),
                    KnownThread {
                        status: status.map(str::to_string),
                        hold: Hold::None,
                    },
                );
                Seen::New
            }
        }
    });
    let attempt = match seen {
        Some(Seen::New) => {
            refresh_lock_paths(state, terminal_id);
            Attempt::First
        }
        Some(Seen::Retry) => Attempt::Retry,
        Some(Seen::Ignored) | None => return Hold::None,
    };
    let entry = if is_main(state, terminal_id, thread_id) {
        None
    } else {
        state.units.by_terminal(terminal_id)
    };
    let hold = match &entry {
        Some(entry) => hold_as_extra(state, entry, terminal_id, thread_id, attempt),
        // The pane's main conversation, or a unit no longer in the
        // directory: nothing to hold as an extra thread.
        None => Hold::None,
    };
    let recorded = with_existing_table(state, terminal_id, |table| {
        table
            .threads
            .get_mut(thread_id)
            .map(|known| known.hold = hold)
            .is_some()
    });
    match (entry, hold) {
        (Some(entry), Hold::OnUnit) if recorded == Some(true) => {
            entry.unit.note_conversation(CODEX, thread_id);
            write_record(
                state,
                terminal_id,
                RecordOp::Note(vec![thread_id.to_string()]),
            );
            Hold::OnUnit
        }
        // Dropped meanwhile (an unload racing the hold): the hold goes too.
        (Some(entry), Hold::OnUnit) => {
            release_from_unit(state, &entry, terminal_id, thread_id);
            Hold::None
        }
        _ if recorded == Some(true) => hold,
        _ => Hold::None,
    }
}

/// Whether a hold is the thread's first attempt or a retry of a refused one
/// (whose refusal was already logged at WARN).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attempt {
    First,
    Retry,
}

/// Whether `thread_id` is the terminal's main conversation.
fn is_main(state: &WsState, terminal_id: &str, thread_id: &str) -> bool {
    state
        .identity
        .session_ref_for(terminal_id)
        .is_some_and(|main| main.provider == CODEX && main.session_id == thread_id)
}

/// Holds `thread_id` for the unit as an extra thread: `OnUnit` when the
/// unit holds it as an extra now (newly, or already), `None` when it is the
/// unit's own main conversation, `Refused` otherwise (WARN for a conflict
/// with another pane on the first attempt, DEBUG on a retry).
fn hold_as_extra(
    state: &WsState,
    entry: &UnitEntry,
    terminal_id: &str,
    thread_id: &str,
    attempt: Attempt,
) -> Hold {
    let Some(ownership) = state.ownership.as_ref() else {
        // No owner registry (tests, bare servers): the records still list it.
        return Hold::OnUnit;
    };
    let owner = OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(terminal_id.to_string()),
        unit_id: Some(entry.unit.id().as_str().to_string()),
        hold: HoldKind::Extra,
        ..Default::default()
    };
    match ownership.hold_extra(CODEX, thread_id, owner, "codex-thread", now_ms()) {
        HoldOutcome::Held { .. } => Hold::OnUnit,
        // The unit's own key: an extra hold already, unless it is the
        // unit's main conversation (its identity was not bound yet).
        HoldOutcome::AlreadyHeld => match ownership.observe(CODEX, thread_id).state {
            OwnershipState::Live { ref owner, .. } if owner.hold == HoldKind::Main => Hold::None,
            _ => Hold::OnUnit,
        },
        HoldOutcome::HeldByOther { owner } => {
            let holder_terminal_id = owner.terminal_id.as_deref().unwrap_or("");
            let holder_unit_id = owner.unit_id.as_deref().unwrap_or("");
            match attempt {
                Attempt::First => thread_event!(warn, entry, terminal_id, "unit.thread_conflict",
                    thread_id = %thread_id,
                    holder_terminal_id = %holder_terminal_id,
                    holder_unit_id = %holder_unit_id,
                    "the pane's app-server holds a thread another pane holds Live; it is not held for this pane"),
                Attempt::Retry => thread_event!(debug, entry, terminal_id, "unit.thread_conflict",
                    thread_id = %thread_id,
                    holder_terminal_id = %holder_terminal_id,
                    holder_unit_id = %holder_unit_id,
                    "another pane still holds the thread Live; it is still not held for this pane"),
            }
            Hold::Refused
        }
        HoldOutcome::Skipped { state: key_state } => {
            thread_event!(debug, entry, terminal_id, "unit.thread_hold_skipped",
                thread_id = %thread_id,
                key_state = %ownership_state_name(&key_state),
                "the thread is not held for the pane (its unit is stopping or gone, or the key is in another transition)");
            Hold::Refused
        }
    }
}

fn ownership_state_name(state: &OwnershipState) -> &'static str {
    match state {
        OwnershipState::Vacant => "vacant",
        OwnershipState::Starting { .. } => "starting",
        OwnershipState::Live { .. } => "live",
        OwnershipState::Stopping { .. } => "stopping",
        OwnershipState::Handoff { .. } => "handoff",
        OwnershipState::Fenced { .. } => "fenced",
        OwnershipState::Aliased { .. } => "aliased",
    }
}

/// The terminal's app-server no longer holds `thread_id` (Codex unloaded
/// it). It leaves the unit's lock paths; a known extra thread's hold is
/// released, its unit record key removed and the sidecar record forgets it.
pub fn drop_thread(state: &WsState, terminal_id: &str, thread_id: &str) {
    let removed = with_existing_table(state, terminal_id, |table| table.threads.remove(thread_id));
    forget_known(state, terminal_id, thread_id, removed.flatten());
}

/// After `known` (the table's entry for `thread_id`, if there was one) left
/// the table: the lock paths follow, and an extra hold leaves the unit.
fn forget_known(state: &WsState, terminal_id: &str, thread_id: &str, known: Option<KnownThread>) {
    let Some(known) = known else {
        return;
    };
    refresh_lock_paths(state, terminal_id);
    if known.hold == Hold::OnUnit {
        if let Some(entry) = state.units.by_terminal(terminal_id) {
            release_from_unit(state, &entry, terminal_id, thread_id);
        }
    }
}

fn release_from_unit(state: &WsState, entry: &UnitEntry, terminal_id: &str, thread_id: &str) {
    if let Some(ownership) = state.ownership.as_ref() {
        ownership.release_extra(CODEX, thread_id, entry.unit.id().as_str());
    }
    entry.unit.forget_conversation(CODEX, thread_id);
    write_record(state, terminal_id, RecordOp::Forget(thread_id.to_string()));
}

/// `thread_id` is one of the terminal's ephemeral threads (the TUI's title
/// threads: no lock file, never held). Dropped if it was held.
pub fn note_ephemeral(state: &WsState, terminal_id: &str, thread_id: &str) {
    let removed = with_table(state, terminal_id, |table| {
        table.ephemeral.insert(thread_id);
        table.threads.remove(thread_id)
    });
    forget_known(state, terminal_id, thread_id, removed.flatten());
}

/// A `thread/status/changed` of `thread_id` with status type `status`: the
/// first status other than `notLoaded` for an unseen non-ephemeral id
/// announces it (helper spawns and cold resumes send nothing else), as does
/// any status for a thread whose extra hold was refused (it is tried again);
/// `notLoaded` drops it; any other status, `systemError` included (the
/// thread is still loaded and holds its lock), only updates the stored type.
pub fn observe_status(state: &WsState, terminal_id: &str, thread_id: &str, status: &str) {
    enum Seen {
        Ephemeral,
        Known { refused: bool },
        New,
    }
    let seen = with_table(state, terminal_id, |table| {
        if table.ephemeral.contains(thread_id) {
            Seen::Ephemeral
        } else if let Some(known) = table.threads.get_mut(thread_id) {
            known.status = Some(status.to_string());
            Seen::Known {
                refused: known.hold == Hold::Refused,
            }
        } else {
            Seen::New
        }
    });
    match seen {
        Some(Seen::Known { .. }) if status == NOT_LOADED => {
            drop_thread(state, terminal_id, thread_id)
        }
        Some(Seen::Known { refused: true }) | Some(Seen::New) if status != NOT_LOADED => {
            note_with_status(state, terminal_id, thread_id, Some(status));
        }
        _ => {}
    }
}

/// Whether any non-ephemeral thread the terminal's app-server holds last
/// reported status `active` (a turn is running somewhere in the pane).
pub fn turn_running(state: &WsState, terminal_id: &str) -> bool {
    with_existing_table(state, terminal_id, |table| {
        table
            .threads
            .values()
            .any(|known| known.status.as_deref() == Some(ACTIVE))
    })
    .unwrap_or(false)
}

/// Points the Codex pane unit's lock paths, which the Gone lock check
/// reads, at the writer lock of every thread its app-server holds: the
/// conversation the unit was started for, the pane's main conversation, and
/// every thread the terminal's table knows. They are under the Codex home
/// the app-server reported (Stage 2: LB-29), never the server's own, on
/// every OS. A terminal with no unit or no adopted launch is left as it is
/// (a unit a boot finishes keeps the paths its records gave it); one whose
/// app-server reported no absolute home keeps its paths and logs WARN
/// `unit.lock_paths.unknown_home`.
pub(crate) fn refresh_lock_paths(state: &WsState, terminal_id: &str) {
    let Some(entry) = state.units.by_terminal(terminal_id) else {
        return;
    };
    if entry.provider != CODEX {
        return;
    }
    let Some(ready) = CodexTerminalLaunchManager::global().sidecar_ready(terminal_id) else {
        return;
    };
    let mut ids = BTreeSet::new();
    let label = entry.unit.label();
    if label.provider == CODEX {
        ids.extend(label.session_id);
    }
    if let Some(main) = state
        .identity
        .session_ref_for(terminal_id)
        .filter(|main| main.provider == CODEX)
    {
        ids.insert(main.session_id);
    }
    with_existing_table(state, terminal_id, |table| {
        ids.extend(table.threads.keys().cloned());
    });
    match thread_lock_paths(ready.codex_home.as_deref(), &ids) {
        Some(paths) => entry.unit.set_lock_paths(paths),
        None => thread_event!(warn, &entry, terminal_id, "unit.lock_paths.unknown_home",
            "the app-server reported no absolute Codex home: the lock files of the threads it holds are not known, so Gone cannot check them"),
    }
}

/// The writer lock of each of `ids` under `codex_home`; `None` unless the
/// home is absolute.
fn thread_lock_paths<'a>(
    codex_home: Option<&str>,
    ids: impl IntoIterator<Item = &'a String>,
) -> Option<Vec<PathBuf>> {
    let home = Path::new(codex_home?);
    home.is_absolute().then(|| {
        ids.into_iter()
            .map(|id| freshell_containment::codex_thread_lock_path(home, id))
            .collect()
    })
}

/// ONE instant read, no app-server round trip (Stage 2: LB-51): which
/// `<codex_home>/thread-writer-locks/<id>.lock` files the unit's members
/// hold (fd attribution; dot-files such as `.coordination.lock` skipped),
/// with `codex_home` the home the app-server reported, never the server's
/// own (Stage 2: LB-29). [`note_thread`] runs for each, and the unit's lock
/// paths are refreshed. Ephemeral threads have no lock file, so they never
/// appear. A terminal whose launch is not adopted yet holds nothing known.
/// Blocking: async callers run it on a blocking thread.
pub fn reconcile_loaded(state: &WsState, terminal_id: &str) {
    refresh_lock_paths(state, terminal_id);
    if let Some(read) = LockRead::prepare(state, terminal_id) {
        let outcome = read.run();
        read.apply(state, outcome);
    }
}

/// [`reconcile_loaded`] for a stop, right before its first signal (Stage 2:
/// LB-51): the read runs on its own thread and is waited for at most
/// [`STOP_READ_DEADLINE`]. A read that does not finish in time (a Codex
/// home on a hung network mount) means the threads could not be checked,
/// never that none is held: WARN `unit.threads.unchecked`, and the stop
/// goes on; the read is left to finish on its own and its result is
/// dropped. A unit's stop runs this once (a stop joining one in flight
/// skips it), so a hung home holds up at most one read per stopped pane.
pub(crate) fn reconcile_before_stop(state: &WsState, terminal_id: &str) {
    refresh_lock_paths(state, terminal_id);
    let Some(read) = LockRead::prepare(state, terminal_id) else {
        return;
    };
    let (answer, outcome) = std::sync::mpsc::channel();
    let reading = read.clone();
    let started = std::thread::Builder::new()
        .name("unit-thread-read".into())
        .spawn(move || {
            let _ = answer.send(reading.run());
        });
    let unchecked = match started {
        Err(error) => error.to_string(),
        Ok(_) => match outcome.recv_timeout(STOP_READ_DEADLINE) {
            Ok(outcome) => return read.apply(state, outcome),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => "deadline".to_string(),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => "the read failed".to_string(),
        },
    };
    thread_event!(warn, &read.entry, terminal_id, "unit.threads.unchecked",
        reason = %unchecked,
        deadline_ms = STOP_READ_DEADLINE.as_millis() as u64,
        "the threads the app-server holds could not be checked before the stop's first signal; the stop goes on, and a thread no event announced is not held for the pane");
}

/// One read of the lock files a unit's members hold under the Codex home
/// its app-server reported.
#[derive(Clone)]
struct LockRead {
    entry: UnitEntry,
    terminal_id: String,
    lock_dir: PathBuf,
}

/// What a [`LockRead`] found.
enum ReadOutcome {
    /// The threads whose lock file a member holds.
    Held(Vec<String>),
    /// The lock directory could not be listed.
    DirectoryUnread(std::io::Error),
    /// The unit's members could not be read.
    MembersUnread(std::io::Error),
}

impl LockRead {
    /// `None` when there is nothing to read: no unit, no adopted launch, or
    /// no absolute reported home ([`refresh_lock_paths`] logs that).
    fn prepare(state: &WsState, terminal_id: &str) -> Option<Self> {
        let entry = state.units.by_terminal(terminal_id)?;
        let ready = CodexTerminalLaunchManager::global().sidecar_ready(terminal_id)?;
        let home = PathBuf::from(ready.codex_home?);
        home.is_absolute().then(|| LockRead {
            entry,
            terminal_id: terminal_id.to_string(),
            lock_dir: home.join("thread-writer-locks"),
        })
    }

    /// The read itself (blocking: a directory listing, a member scan, fd
    /// lock reads).
    fn run(&self) -> ReadOutcome {
        if let Some(delay) = freshell_containment::testing::thread_scan_delay() {
            std::thread::sleep(delay);
        }
        let paths: Vec<PathBuf> = match std::fs::read_dir(&self.lock_dir) {
            Ok(entries) => entries
                .flatten()
                .map(|lock_file| lock_file.path())
                .filter(|path| {
                    path.extension().is_some_and(|ext| ext == "lock")
                        && path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| !name.starts_with('.'))
                })
                .collect(),
            // No lock file was ever written: nothing is held.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return ReadOutcome::DirectoryUnread(error),
        };
        if paths.is_empty() {
            return ReadOutcome::Held(Vec::new());
        }
        let pids: Vec<u32> = match self.entry.unit.members() {
            Ok(members) => members.iter().map(|member| member.pid).collect(),
            Err(error) => return ReadOutcome::MembersUnread(error),
        };
        ReadOutcome::Held(
            freshell_containment::lock_holders_among(&paths, &pids)
                .into_iter()
                .filter_map(|holder| {
                    holder
                        .path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .map(str::to_string)
                })
                .collect(),
        )
    }

    /// Notes each thread found held; logs what could not be read.
    fn apply(&self, state: &WsState, outcome: ReadOutcome) {
        let terminal_id = self.terminal_id.as_str();
        match outcome {
            ReadOutcome::Held(thread_ids) => {
                for thread_id in thread_ids {
                    note_thread(state, terminal_id, &thread_id);
                }
            }
            ReadOutcome::DirectoryUnread(error) => {
                thread_event!(warn, &self.entry, terminal_id, "unit.threads.unread",
                    error = %error,
                    "the Codex thread lock directory could not be read: threads no event announced are not held for the pane")
            }
            ReadOutcome::MembersUnread(error) => {
                thread_event!(warn, &self.entry, terminal_id, "unit.threads.unread",
                    error = %error,
                    "the unit's members could not be read: threads no event announced are not held for the pane")
            }
        }
    }
}

/// `thread_id` is about to become the terminal's main conversation (an
/// adoption or a fork rebind claims it, with nothing awaited between this
/// and the claim): an extra hold of it is released first, so the claim
/// commits it as the pane's main conversation (a claim on a key the pane
/// already holds would only adopt it, leaving it an extra hold, and a
/// rebind would then release the original instead of aliasing it). Returns
/// whether a hold was released; [`restore_extra`] puts it back when the
/// claim is refused.
pub(crate) fn release_for_main(state: &WsState, terminal_id: &str, thread_id: &str) -> bool {
    let released = with_existing_table(state, terminal_id, |table| {
        table
            .threads
            .get_mut(thread_id)
            .is_some_and(|known| std::mem::replace(&mut known.hold, Hold::None) == Hold::OnUnit)
    })
    .unwrap_or(false);
    if !released {
        return false;
    }
    if let (Some(ownership), Some(entry)) = (
        state.ownership.as_ref(),
        state.units.by_terminal(terminal_id),
    ) {
        ownership.release_extra(CODEX, thread_id, entry.unit.id().as_str());
    }
    true
}

/// A claim [`release_for_main`] prepared was refused: the thread, which the
/// app-server still holds, is held as an extra thread again. When that is
/// refused too (another pane, or another transition, took the key in the
/// meantime) the thread is not left unheld for good: WARN
/// `unit.thread_restore_refused`, and its next announcement, or the read
/// before a stop, tries again.
pub(crate) fn restore_extra(state: &WsState, terminal_id: &str, thread_id: &str) {
    with_existing_table(state, terminal_id, |table| table.threads.remove(thread_id));
    if note_with_status(state, terminal_id, thread_id, None) != Hold::Refused {
        return;
    }
    if let Some(entry) = state.units.by_terminal(terminal_id) {
        thread_event!(warn, &entry, terminal_id, "unit.thread_restore_refused",
            thread_id = %thread_id,
            "a thread the pane's app-server holds could not be held again after a refused claim; its next announcement or the read before a stop tries again");
    }
}

/// A fork rebind moved the terminal's main conversation from `old` to
/// `new`. The app-server holds both: the sidecar record and the lock paths
/// list both, `new` is the pane's main conversation, and `old` (Aliased to
/// `new` in the owner registry, still loaded and locked) leaves the unit
/// like any extra thread when Codex unloads it.
pub(crate) fn note_rebind(state: &WsState, terminal_id: &str, old: &str, new: &str) {
    let tracked = with_table(state, terminal_id, |table| {
        table.threads.entry(new.to_string()).or_default().hold = Hold::None;
        if old != new {
            table.ephemeral.remove(old);
            table.threads.entry(old.to_string()).or_default().hold = Hold::OnUnit;
        }
    });
    if tracked.is_some() {
        refresh_lock_paths(state, terminal_id);
        write_record(
            state,
            terminal_id,
            RecordOp::Note(vec![old.to_string(), new.to_string()]),
        );
    }
}

/// Drops the terminal's table at Gone (its sidecar record writer ends once
/// it has applied what was queued).
pub fn forget_terminal(state: &WsState, terminal_id: &str) {
    state.units.threads.lock().remove(terminal_id);
}

/// Queues a sidecar record change on the terminal's writer: one task per
/// terminal applies its changes in order (a helper noted and then dropped
/// is never re-added), off the proxy router, which never awaits a record
/// write.
fn write_record(state: &WsState, terminal_id: &str, op: RecordOp) {
    let writer = with_table(state, terminal_id, |table| {
        if table
            .record_writer
            .as_ref()
            .is_none_or(mpsc::UnboundedSender::is_closed)
        {
            let Ok(runtime) = tokio::runtime::Handle::try_current() else {
                return None;
            };
            let (tx, rx) = mpsc::unbounded_channel();
            runtime.spawn(apply_record_ops(terminal_id.to_string(), rx));
            table.record_writer = Some(tx);
        }
        table.record_writer.clone()
    })
    .flatten();
    if let Some(writer) = writer {
        let _ = writer.send(op);
        return;
    }
    match state.units.by_terminal(terminal_id) {
        Some(entry) => thread_event!(
            warn,
            &entry,
            terminal_id,
            "unit.threads.record_unwritten",
            "a held-thread change of the sidecar record was not written (no runtime)"
        ),
        None => tracing::warn!(target: "freshell_unit",
            event = "unit.threads.record_unwritten",
            terminal_id = %terminal_id,
            "a held-thread change of the sidecar record was not written (no unit)"),
    }
}

async fn apply_record_ops(terminal_id: String, mut ops: mpsc::UnboundedReceiver<RecordOp>) {
    let manager = CodexTerminalLaunchManager::global();
    while let Some(op) = ops.recv().await {
        match op {
            RecordOp::Note(ids) => manager.note_held_threads(&terminal_id, ids).await,
            RecordOp::Forget(id) => manager.forget_held_thread(&terminal_id, &id).await,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Test support: registers a process-free Codex unit (records in memory)
/// for `terminal_id` in `state`'s directory; the containment it came from
/// reads its record back.
#[cfg(test)]
pub(crate) fn register_test_unit(
    state: &WsState,
    terminal_id: &str,
) -> freshell_containment::Containment {
    let containment =
        freshell_containment::Containment::tag_backend(freshell_containment::SelectOptions {
            shim: None,
            state_root: PathBuf::new(),
        });
    let unit = containment
        .create_unit(
            freshell_containment::UnitId::mint(),
            freshell_containment::UnitLabel {
                provider: CODEX.into(),
                mode: CODEX.into(),
                terminal_id: Some(terminal_id.into()),
                ..Default::default()
            },
        )
        .expect("unit");
    state.units.register(UnitEntry {
        unit,
        provider: CODEX.into(),
        mode: CODEX.into(),
        create_request_id: None,
        terminal_id: Some(terminal_id.into()),
    });
    containment
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use freshell_containment::Containment;
    use freshell_ownership::RuntimeOwnershipRegistry;

    use super::*;

    const TERMINAL: &str = "term-threads";

    /// A state with an owner registry whose terminal [`TERMINAL`] runs in a
    /// process-free unit (records in memory).
    fn state_with_unit() -> (WsState, Containment) {
        let mut state = crate::test_ws_state();
        state.ownership = Some(Arc::new(RuntimeOwnershipRegistry::new()));
        let containment = register_test_unit(&state, TERMINAL);
        (state, containment)
    }

    fn held_as_extra(state: &WsState, thread_id: &str) -> bool {
        matches!(
            state.ownership.as_ref().unwrap().observe(CODEX, thread_id).state,
            OwnershipState::Live { ref owner, .. }
                if owner.hold == HoldKind::Extra && owner.terminal_id.as_deref() == Some(TERMINAL)
        )
    }

    fn vacant(state: &WsState, thread_id: &str) -> bool {
        state
            .ownership
            .as_ref()
            .unwrap()
            .observe(CODEX, thread_id)
            .state
            == OwnershipState::Vacant
    }

    fn recorded_conversation(containment: &Containment, thread_id: &str) -> bool {
        containment.recorded_units().unwrap()[0]
            .conversation_keys
            .contains(&(CODEX.to_string(), thread_id.to_string()))
    }

    #[tokio::test]
    async fn an_unseen_threads_first_status_holds_it_for_the_unit() {
        let (state, containment) = state_with_unit();
        observe_status(&state, TERMINAL, "t-help", "idle");
        assert!(held_as_extra(&state, "t-help"));
        assert!(recorded_conversation(&containment, "t-help"));
        assert!(!turn_running(&state, TERMINAL));
        observe_status(&state, TERMINAL, "t-help", "active");
        assert!(turn_running(&state, TERMINAL), "a helper runs a turn");
    }

    #[tokio::test]
    async fn a_system_error_keeps_a_held_thread_held() {
        let (state, containment) = state_with_unit();
        observe_status(&state, TERMINAL, "t-help", "idle");
        observe_status(&state, TERMINAL, "t-help", "systemError");
        assert!(
            held_as_extra(&state, "t-help"),
            "still loaded, still locked"
        );
        assert!(recorded_conversation(&containment, "t-help"));
    }

    #[tokio::test]
    async fn not_loaded_drops_a_held_thread() {
        let (state, containment) = state_with_unit();
        // A lone notLoaded for an unseen thread holds nothing.
        observe_status(&state, TERMINAL, "t-gone", "notLoaded");
        assert!(vacant(&state, "t-gone"));
        observe_status(&state, TERMINAL, "t-help", "idle");
        observe_status(&state, TERMINAL, "t-help", "notLoaded");
        assert!(vacant(&state, "t-help"));
        assert!(!recorded_conversation(&containment, "t-help"));
    }

    #[tokio::test]
    async fn a_thread_later_marked_ephemeral_is_dropped_and_never_held_again() {
        let (state, containment) = state_with_unit();
        observe_status(&state, TERMINAL, "t-title", "active");
        assert!(held_as_extra(&state, "t-title"));
        note_ephemeral(&state, TERMINAL, "t-title");
        assert!(vacant(&state, "t-title"));
        assert!(!recorded_conversation(&containment, "t-title"));
        observe_status(&state, TERMINAL, "t-title", "idle");
        note_thread(&state, TERMINAL, "t-title");
        assert!(
            vacant(&state, "t-title"),
            "an ephemeral thread is never held"
        );
    }

    #[tokio::test]
    async fn the_main_conversation_is_tracked_but_never_an_extra_hold() {
        let (state, containment) = state_with_unit();
        state
            .identity
            .upsert(TERMINAL, Some(CODEX), Some("t-main"), None, 0);
        observe_status(&state, TERMINAL, "t-main", "active");
        assert!(
            vacant(&state, "t-main"),
            "the pane's own claim holds its main conversation"
        );
        assert!(!recorded_conversation(&containment, "t-main"));
        assert!(
            turn_running(&state, TERMINAL),
            "the main conversation's turn counts"
        );
    }

    #[tokio::test]
    async fn a_terminal_outside_any_unit_keeps_no_table() {
        let (state, _containment) = state_with_unit();
        observe_status(&state, "term-elsewhere", "t-help", "idle");
        note_ephemeral(&state, "term-elsewhere", "t-title");
        assert!(vacant(&state, "t-help"));
        assert!(state.units.threads.lock().get("term-elsewhere").is_none());
    }

    #[tokio::test]
    async fn forgetting_the_terminal_drops_its_table() {
        let (state, _containment) = state_with_unit();
        observe_status(&state, TERMINAL, "t-help", "active");
        forget_terminal(&state, TERMINAL);
        assert!(!turn_running(&state, TERMINAL));
    }

    /// Task 14 review N2: the TUI starts a title thread every turn; a pane
    /// remembers only the most recent ones, and the latest is still never
    /// held.
    #[tokio::test]
    async fn a_pane_remembers_a_bounded_number_of_title_threads() {
        let (state, _containment) = state_with_unit();
        let turns = EPHEMERAL_REMEMBERED + 40;
        for turn in 0..turns {
            note_ephemeral(&state, TERMINAL, &format!("t-title-{turn}"));
        }
        let remembered = state
            .units
            .threads
            .lock()
            .get(TERMINAL)
            .map(|table| table.ephemeral.len())
            .expect("the terminal's table");
        assert_eq!(remembered, EPHEMERAL_REMEMBERED);
        let latest = format!("t-title-{}", turns - 1);
        observe_status(&state, TERMINAL, &latest, "active");
        assert!(
            vacant(&state, &latest),
            "the latest title thread is never held"
        );
    }

    /// Task 14 review M2: a claim that was to make an extra thread the
    /// pane's conversation is refused, and meanwhile another pane holds the
    /// thread, so it cannot be held again at once. It is not left unheld for
    /// good: once the other pane lets it go, the thread's next announcement
    /// holds it for this pane.
    #[tokio::test]
    async fn a_thread_whose_restore_was_refused_is_held_at_its_next_announcement() {
        let (state, _containment) = state_with_unit();
        let ownership = state.ownership.clone().expect("an owner registry");
        observe_status(&state, TERMINAL, "t-x", "idle");
        assert!(held_as_extra(&state, "t-x"));
        assert!(release_for_main(&state, TERMINAL, "t-x"));
        let other = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("term-other".into()),
            unit_id: Some("unit-other".into()),
            hold: HoldKind::Extra,
            ..Default::default()
        };
        assert!(matches!(
            ownership.hold_extra(CODEX, "t-x", other, "test", now_ms()),
            HoldOutcome::Held { .. }
        ));
        restore_extra(&state, TERMINAL, "t-x");
        assert!(!held_as_extra(&state, "t-x"), "the other pane holds it");

        ownership.release_extra(CODEX, "t-x", "unit-other");
        observe_status(&state, TERMINAL, "t-x", "active");
        assert!(
            held_as_extra(&state, "t-x"),
            "the next announcement holds it for this pane"
        );
    }

    /// Task 14 review N3: a held-thread change of the sidecar record that
    /// cannot be written (no runtime on the calling thread) is logged with
    /// the unit's keys.
    #[tokio::test]
    async fn an_unwritten_record_change_names_the_unit() {
        let logs = crate::invariants::capture::capture();
        let (state, _containment) = state_with_unit();
        let unit_id = state
            .units
            .by_terminal(TERMINAL)
            .expect("the unit")
            .unit
            .id()
            .as_str()
            .to_string();
        std::thread::scope(|scope| {
            scope
                .spawn(|| observe_status(&state, TERMINAL, "t-help", "idle"))
                .join()
                .expect("noted off the runtime");
        });
        let line = logs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|line| {
                line.fields.get("event").map(String::as_str)
                    == Some("unit.threads.record_unwritten")
                    && line.fields.get("unit_id") == Some(&unit_id)
            })
            .cloned();
        let line = line.expect("WARN unit.threads.record_unwritten names the unit");
        assert_eq!(line.fields.get("provider").map(String::as_str), Some(CODEX));
        assert_eq!(
            line.fields.get("terminal_id").map(String::as_str),
            Some(TERMINAL)
        );
    }

    /// The Gone lock check's paths come only from an absolute Codex home the
    /// app-server reported (Stage 2: LB-29).
    #[test]
    fn lock_paths_need_an_absolute_reported_home() {
        let ids = ["t-a".to_string(), "t-b".to_string()];
        assert_eq!(thread_lock_paths(None, &ids), None);
        assert_eq!(thread_lock_paths(Some("relative/home"), &ids), None);
        assert_eq!(
            thread_lock_paths(Some("/codex-a"), &ids),
            Some(vec![
                PathBuf::from("/codex-a/thread-writer-locks/t-a.lock"),
                PathBuf::from("/codex-a/thread-writer-locks/t-b.lock"),
            ])
        );
    }
}

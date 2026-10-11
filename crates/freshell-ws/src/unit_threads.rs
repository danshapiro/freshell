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
//! a reattached app-server) are found by one read of the lock files the
//! unit's members hold ([`reconcile_loaded`]), after a create adopts its
//! launch and right before a stop signals anything.
//!
//! A held thread other than the pane's main conversation is an `Extra` hold
//! of the pane's unit in the owner registry (a stop moves it to Stopping and
//! Gone releases it), a conversation key of the unit record (a restart that
//! finishes the stop restores it as Stopping) and a held thread of the
//! sidecar record (any held thread claims the sidecar at boot, and its lock
//! paths feed the Gone lock check). Only a new id, a drop, or an ephemeral
//! id that was held touches those; status traffic for a known thread is one
//! map lookup and an in-memory update, so the serial proxy router never
//! writes a file per event. Sidecar record writes run in order on one task
//! per terminal, never on the router.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

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

/// Per terminal: every thread its app-server is known to hold, with the
/// status type last seen, plus its ephemeral thread ids. One mutex, never
/// held across an await or a file write.
#[derive(Debug, Default)]
pub struct ThreadTables {
    terminals: Mutex<HashMap<String, TerminalThreads>>,
}

#[derive(Debug, Default)]
struct TerminalThreads {
    threads: HashMap<String, KnownThread>,
    ephemeral: HashSet<String>,
    /// The terminal's sidecar record writer (see [`write_record`]).
    record_writer: Option<mpsc::UnboundedSender<RecordOp>>,
}

#[derive(Debug, Default)]
struct KnownThread {
    /// The `thread/status/changed` type last seen.
    status: Option<String>,
    /// Held by the unit as an extra thread: its registry hold, unit record
    /// key and sidecar record entry are this table's to release.
    on_unit: bool,
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
/// known for the terminal or known ephemeral. Otherwise the id is recorded
/// and, unless it is the terminal's main conversation, held by the pane's
/// unit as an extra thread (`hold_extra`), added to the unit record's
/// conversation keys and to the sidecar record (written off the caller).
pub fn note_thread(state: &WsState, terminal_id: &str, thread_id: &str) {
    note_with_status(state, terminal_id, thread_id, None);
}

fn note_with_status(state: &WsState, terminal_id: &str, thread_id: &str, status: Option<&str>) {
    if thread_id.is_empty() {
        return;
    }
    let first = with_table(state, terminal_id, |table| {
        if table.ephemeral.contains(thread_id) || table.threads.contains_key(thread_id) {
            return false;
        }
        table.threads.insert(
            thread_id.to_string(),
            KnownThread {
                status: status.map(str::to_string),
                on_unit: false,
            },
        );
        true
    });
    if first != Some(true) || is_main(state, terminal_id, thread_id) {
        return;
    }
    let Some(entry) = state.units.by_terminal(terminal_id) else {
        return;
    };
    if !hold_as_extra(state, &entry, terminal_id, thread_id) {
        return;
    }
    let held = with_existing_table(state, terminal_id, |table| {
        table
            .threads
            .get_mut(thread_id)
            .map(|known| known.on_unit = true)
            .is_some()
    });
    if held != Some(true) {
        // Dropped meanwhile (an unload racing the hold): the hold goes too.
        release_from_unit(state, &entry, terminal_id, thread_id);
        return;
    }
    entry.unit.note_conversation(CODEX, thread_id);
    write_record(
        state,
        terminal_id,
        RecordOp::Note(vec![thread_id.to_string()]),
    );
}

/// Whether `thread_id` is the terminal's main conversation.
fn is_main(state: &WsState, terminal_id: &str, thread_id: &str) -> bool {
    state
        .identity
        .session_ref_for(terminal_id)
        .is_some_and(|main| main.provider == CODEX && main.session_id == thread_id)
}

/// Holds `thread_id` for the unit as an extra thread. True when the unit
/// holds it as an extra now (newly, or already).
fn hold_as_extra(state: &WsState, entry: &UnitEntry, terminal_id: &str, thread_id: &str) -> bool {
    let Some(ownership) = state.ownership.as_ref() else {
        // No owner registry (tests, bare servers): the records still list it.
        return true;
    };
    let owner = OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(terminal_id.to_string()),
        unit_id: Some(entry.unit.id().as_str().to_string()),
        hold: HoldKind::Extra,
        ..Default::default()
    };
    match ownership.hold_extra(CODEX, thread_id, owner, "codex-thread", now_ms()) {
        HoldOutcome::Held { .. } => true,
        // The unit's own key: an extra hold already, unless it is the
        // unit's main conversation (its identity was not bound yet).
        HoldOutcome::AlreadyHeld => !matches!(
            ownership.observe(CODEX, thread_id).state,
            OwnershipState::Live { ref owner, .. } if owner.hold == HoldKind::Main
        ),
        HoldOutcome::HeldByOther { owner } => {
            thread_event!(warn, entry, terminal_id, "unit.thread_conflict",
                thread_id = %thread_id,
                holder_terminal_id = %owner.terminal_id.as_deref().unwrap_or(""),
                holder_unit_id = %owner.unit_id.as_deref().unwrap_or(""),
                "the pane's app-server holds a thread another pane holds Live; it is not held for this pane");
            false
        }
        HoldOutcome::Skipped { state: key_state } => {
            thread_event!(debug, entry, terminal_id, "unit.thread_hold_skipped",
                thread_id = %thread_id,
                key_state = %ownership_state_name(&key_state),
                "the thread is not held for the pane (its unit is stopping or gone, or the key is in another transition)");
            false
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
/// it). A known extra thread's hold is released, its unit record key
/// removed and the sidecar record forgets it.
pub fn drop_thread(state: &WsState, terminal_id: &str, thread_id: &str) {
    let removed = with_existing_table(state, terminal_id, |table| table.threads.remove(thread_id));
    if let Some(Some(KnownThread { on_unit: true, .. })) = removed {
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
        table.ephemeral.insert(thread_id.to_string());
        table.threads.remove(thread_id)
    });
    if let Some(Some(KnownThread { on_unit: true, .. })) = removed {
        if let Some(entry) = state.units.by_terminal(terminal_id) {
            release_from_unit(state, &entry, terminal_id, thread_id);
        }
    }
}

/// A `thread/status/changed` of `thread_id` with status type `status`: the
/// first status other than `notLoaded` for an unseen non-ephemeral id
/// announces it (helper spawns and cold resumes send nothing else);
/// `notLoaded` drops it; any other status, `systemError` included (the
/// thread is still loaded and holds its lock), only updates the stored type.
pub fn observe_status(state: &WsState, terminal_id: &str, thread_id: &str, status: &str) {
    enum Seen {
        Ephemeral,
        Known,
        New,
    }
    let seen = with_table(state, terminal_id, |table| {
        if table.ephemeral.contains(thread_id) {
            Seen::Ephemeral
        } else if let Some(known) = table.threads.get_mut(thread_id) {
            known.status = Some(status.to_string());
            Seen::Known
        } else {
            Seen::New
        }
    });
    match seen {
        Some(Seen::Known) if status == NOT_LOADED => drop_thread(state, terminal_id, thread_id),
        Some(Seen::New) if status != NOT_LOADED => {
            note_with_status(state, terminal_id, thread_id, Some(status))
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

/// ONE instant read, no app-server round trip (Stage 2: LB-51): which
/// `<codex_home>/thread-writer-locks/<id>.lock` files the unit's members
/// hold (fd attribution; dot-files such as `.coordination.lock` skipped),
/// with `codex_home` the home the app-server reported, never the server's
/// own (Stage 2: LB-29). [`note_thread`] runs for each. Ephemeral threads
/// have no lock file, so they never appear. A terminal whose launch is not
/// adopted yet holds nothing known; one whose app-server reported no home
/// logs WARN `unit.lock_paths.unknown_home`.
pub fn reconcile_loaded(state: &WsState, terminal_id: &str) {
    let Some(entry) = state.units.by_terminal(terminal_id) else {
        return;
    };
    let Some(ready) = CodexTerminalLaunchManager::global().sidecar_ready(terminal_id) else {
        return;
    };
    let Some(codex_home) = ready
        .codex_home
        .filter(|home| Path::new(home).is_absolute())
    else {
        thread_event!(warn, &entry, terminal_id, "unit.lock_paths.unknown_home",
            "the app-server reported no Codex home: the threads it holds cannot be read from their lock files");
        return;
    };
    let lock_dir = Path::new(&codex_home).join("thread-writer-locks");
    let paths: Vec<PathBuf> = match std::fs::read_dir(&lock_dir) {
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            thread_event!(warn, &entry, terminal_id, "unit.threads.unread",
                error = %error,
                "the Codex thread lock directory could not be read: threads no event announced are not held for the pane");
            return;
        }
    };
    if paths.is_empty() {
        return;
    }
    let pids: Vec<u32> = match entry.unit.members() {
        Ok(members) => members.iter().map(|member| member.pid).collect(),
        Err(error) => {
            thread_event!(warn, &entry, terminal_id, "unit.threads.unread",
                error = %error,
                "the unit's members could not be read: threads no event announced are not held for the pane");
            return;
        }
    };
    for holder in freshell_containment::lock_holders_among(&paths, &pids) {
        if let Some(thread_id) = holder.path.file_stem().and_then(|stem| stem.to_str()) {
            note_thread(state, terminal_id, thread_id);
        }
    }
}

/// `thread_id` is about to become the terminal's main conversation (an
/// adoption or a fork rebind claims it): an extra hold of it is released
/// first, so the claim commits it as the pane's main conversation (a claim
/// on a key the pane already holds would only adopt it, leaving it an extra
/// hold, and a rebind would then release the original instead of aliasing
/// it). Returns whether a hold was released; [`restore_extra`] puts it back
/// when the claim is refused.
pub(crate) fn release_for_main(state: &WsState, terminal_id: &str, thread_id: &str) -> bool {
    let released = with_existing_table(state, terminal_id, |table| {
        table
            .threads
            .get_mut(thread_id)
            .is_some_and(|known| std::mem::replace(&mut known.on_unit, false))
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
/// app-server still holds, is held as an extra thread again.
pub(crate) fn restore_extra(state: &WsState, terminal_id: &str, thread_id: &str) {
    with_existing_table(state, terminal_id, |table| table.threads.remove(thread_id));
    note_thread(state, terminal_id, thread_id);
}

/// A fork rebind moved the terminal's main conversation from `old` to
/// `new`. The app-server holds both: the sidecar record lists both, `new`
/// is the pane's main conversation, and `old` (Aliased to `new` in the
/// owner registry, still loaded and locked) leaves the unit like any extra
/// thread when Codex unloads it.
pub(crate) fn note_rebind(state: &WsState, terminal_id: &str, old: &str, new: &str) {
    let tracked = with_table(state, terminal_id, |table| {
        table.threads.entry(new.to_string()).or_default().on_unit = false;
        if old != new {
            table.ephemeral.remove(old);
            table.threads.entry(old.to_string()).or_default().on_unit = true;
        }
    });
    if tracked.is_some() {
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
    match writer {
        Some(writer) => {
            let _ = writer.send(op);
        }
        None => tracing::warn!(target: "freshell_unit",
            event = "unit.threads.record_unwritten",
            terminal_id = %terminal_id,
            "a held-thread change of the sidecar record was not written (no unit, or no runtime)"),
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use freshell_containment::{Containment, SelectOptions, UnitId, UnitLabel};
    use freshell_ownership::RuntimeOwnershipRegistry;

    use super::*;

    const TERMINAL: &str = "term-threads";

    /// A state with an owner registry whose terminal [`TERMINAL`] runs in a
    /// process-free unit (records in memory).
    fn state_with_unit() -> (WsState, Containment) {
        let mut state = crate::test_ws_state();
        state.ownership = Some(Arc::new(RuntimeOwnershipRegistry::new()));
        let containment = Containment::tag_backend(SelectOptions {
            shim: None,
            state_root: PathBuf::new(),
        });
        let unit = containment
            .create_unit(
                UnitId::mint(),
                UnitLabel {
                    provider: CODEX.into(),
                    mode: CODEX.into(),
                    terminal_id: Some(TERMINAL.into()),
                    ..Default::default()
                },
            )
            .expect("unit");
        state.units.register(UnitEntry {
            unit,
            provider: CODEX.into(),
            mode: CODEX.into(),
            create_request_id: None,
            terminal_id: Some(TERMINAL.into()),
        });
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
}

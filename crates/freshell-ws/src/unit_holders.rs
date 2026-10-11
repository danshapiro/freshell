//! Who holds a conversation (Task 16; Stage 2: LB-28, LB-29, LB-46).
//!
//! A Codex reopen whose new app-server finds the conversation's writer lock
//! held ([`freshell_codex::launch_lifecycle::CodexLaunchError::ThreadHeld`])
//! is answered here: a holder that is a member of a live pane's unit is that
//! pane (the reopen answers its terminal, as Decision 1's extra-thread
//! reopen does); any other holder is a program outside Freshell, named to
//! the user by pid and process name (never its command line) with an ERROR
//! log. Membership decides, never an environment tag: an inherited or copied
//! tag proves nothing.
//!
//! [`log_writer_conflict`] logs, at ERROR, every writer conflict Codex
//! reports by itself (the TUI's "open in another app"), naming the holder one
//! lock lookup finds under the terminal's own Codex home; a holder it cannot
//! see is "held by a process outside Freshell's view", never "released".

use freshell_containment::events::{self, UnitLogKeys};
use freshell_containment::LockHolder;
use freshell_protocol::client_messages::TerminalCreate;

use crate::create_gate::CreateOutput;
use crate::WsState;

/// Where a conversation's writer lock holder belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HolderClass {
    /// A member of a live pane's unit: that pane's terminal.
    Unit { terminal_id: String },
    /// A process outside every Freshell pane, by pid and process name.
    Outside { pid: u32, name: String },
}

/// `Unit` when the holder is a member of a registered unit that has a
/// terminal (`UnitDirectory::entry_with_member`), otherwise `Outside`.
/// Blocking (a member read can scan every process): async callers run it
/// on a blocking thread.
pub fn classify_holder(state: &WsState, holder: &LockHolder) -> HolderClass {
    match state
        .units
        .entry_with_member(holder.pid)
        .and_then(|entry| entry.terminal_id)
    {
        Some(terminal_id) => HolderClass::Unit { terminal_id },
        None => HolderClass::Outside {
            pid: holder.pid,
            name: holder.name.clone(),
        },
    }
}

/// [`classify_holder`] on a blocking thread (a failed one is `Outside`:
/// the holder is still named, never hidden).
async fn classify_holder_off_loop(state: &WsState, holder: &LockHolder) -> HolderClass {
    let outside = HolderClass::Outside {
        pid: holder.pid,
        name: holder.name.clone(),
    };
    let (state, holder) = (state.clone(), holder.clone());
    tokio::task::spawn_blocking(move || classify_holder(&state, &holder))
        .await
        .unwrap_or(outside)
}

/// The log keys of a conflict about `thread_id`: the unit of `terminal_id`
/// when it has one, else just the conversation.
fn conflict_keys(state: &WsState, terminal_id: Option<&str>, thread_id: &str) -> UnitLogKeys {
    match terminal_id.and_then(|tid| state.units.by_terminal(tid)) {
        Some(entry) => crate::unit_lifecycle::unit_keys(&entry.unit, None),
        None => UnitLogKeys {
            provider: "codex".to_string(),
            session_id: Some(thread_id.to_string()),
            terminal_id: terminal_id.map(str::to_string),
            ..UnitLogKeys::default()
        },
    }
}

/// Classifies the holder of the conversation `thread_id` a reopen wants and
/// logs it: a pane's unit member at INFO `unit.reopen.holder` (`request_id`:
/// the reopen's create, empty when none), a program outside Freshell at
/// ERROR `unit.writer_conflict` (`source: preflight`) by pid and process
/// name.
async fn classify_and_log(
    state: &WsState,
    thread_id: &str,
    holder: &LockHolder,
    request_id: &str,
) -> HolderClass {
    let class = classify_holder_off_loop(state, holder).await;
    match &class {
        HolderClass::Unit { terminal_id } => {
            tracing::info!(target: "freshell_unit",
                event = "unit.reopen.holder",
                unit_id = %state.units.by_terminal(terminal_id)
                    .map(|entry| entry.unit.id().to_string())
                    .unwrap_or_default(),
                provider = "codex",
                session_id = %thread_id,
                terminal_id = %terminal_id,
                operation_id = "",
                request_id = %request_id,
                holder_pid = holder.pid,
                "a reopen of a conversation another pane's app-server holds answers that pane");
        }
        HolderClass::Outside { pid, name } => events::writer_conflict(
            &conflict_keys(state, None, thread_id),
            thread_id,
            Some((*pid, name)),
            "preflight",
            "",
        ),
    }
    class
}

/// Answers a create whose Codex conversation `thread_id` is held by
/// `holder`: a pane's unit member answers that pane's terminal (nothing is
/// spawned, released or killed); a program outside Freshell is refused with
/// `CONVERSATION_HELD_ELSEWHERE` naming it by pid and process name, and the
/// conflict is logged at ERROR. Returns whether the answer was sent.
pub(crate) async fn answer_thread_held(
    state: &WsState,
    out: &mut CreateOutput<'_>,
    create: &TerminalCreate,
    thread_id: &str,
    holder: &LockHolder,
) -> bool {
    match classify_and_log(state, thread_id, holder, &create.request_id).await {
        HolderClass::Unit { terminal_id } => {
            crate::terminal::reply_reattach_to_existing(
                state,
                out,
                create,
                &terminal_id,
                None,
                None,
            )
            .await
        }
        HolderClass::Outside { pid, name } => {
            crate::terminal::send_create_error_holder(out, &create.request_id, pid, &name).await
        }
    }
}

/// The refusal of a respawn (auto-resume; no client to answer) whose
/// conversation `thread_id` is held by `holder`: nothing starts, and the
/// holder is named (a pane by its terminal, a program outside Freshell by
/// pid and process name) and logged as for a reopen.
pub(crate) async fn respawn_refusal(
    state: &WsState,
    thread_id: &str,
    holder: &LockHolder,
) -> String {
    match classify_and_log(state, thread_id, holder, "").await {
        HolderClass::Unit { terminal_id } => {
            format!("codex conversation {thread_id} is already open in terminal {terminal_id}")
        }
        HolderClass::Outside { pid, name } => {
            freshell_protocol::conversation_held_elsewhere_message(pid, &name)
        }
    }
}

/// Logs, at ERROR, a writer conflict Codex reported by itself for
/// `thread_id` in the app-server of `terminal_id` (`source`: who saw it),
/// naming the holder one bounded lock lookup finds under that terminal's own
/// Codex home (recorded from the proxied `initialize`, never the server's
/// ambient home). A holder it cannot see is "held by a process outside
/// Freshell's view", never "released"
/// ([`freshell_containment::report_writer_conflict`]).
pub async fn log_writer_conflict(
    state: &WsState,
    terminal_id: Option<&str>,
    thread_id: &str,
    source: &str,
) {
    let home = terminal_id.and_then(|tid| state.identity.codex_home_of(tid));
    freshell_containment::report_writer_conflict(
        &conflict_keys(state, terminal_id, thread_id),
        home.as_deref().map(std::path::Path::new),
        thread_id,
        source,
    )
    .await;
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// The `unit.writer_conflict` events about `thread_id` (the capture is
    /// shared by every test in this binary).
    fn conflicts_about(thread_id: &str) -> Vec<crate::invariants::capture::CapturedEvent> {
        crate::invariants::capture::capture()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|e| {
                e.target == "freshell_unit"
                    && e.fields.get("event").map(String::as_str) == Some("unit.writer_conflict")
                    && e.fields.get("thread_id").map(String::as_str) == Some(thread_id)
            })
            .cloned()
            .collect()
    }

    /// A conflict whose lock nobody this server can see holds (or whose
    /// Codex home is unknown) is still an ERROR, never "released".
    #[tokio::test]
    async fn a_conflict_with_no_visible_holder_is_still_an_error_never_released() {
        let _ = crate::invariants::capture::capture();
        let state = crate::test_ws_state();
        let home = tempfile::tempdir().expect("a Codex home");
        let lock = freshell_containment::codex_thread_lock_path(home.path(), "t-free-lock");
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        std::fs::write(&lock, "").unwrap();
        state
            .identity
            .record_codex_home("term-free", &home.path().display().to_string());

        log_writer_conflict(&state, Some("term-free"), "t-free-lock", "proxy").await;
        log_writer_conflict(&state, Some("term-no-home"), "t-no-home", "proxy").await;

        for (thread, detail) in [
            (
                "t-free-lock",
                freshell_containment::locks::CONFLICT_NO_VISIBLE_HOLDER,
            ),
            (
                "t-no-home",
                freshell_containment::locks::CONFLICT_NO_KNOWN_HOME,
            ),
        ] {
            let events = conflicts_about(thread);
            assert_eq!(events.len(), 1, "{thread}: {events:?}");
            let event = &events[0];
            assert_eq!(event.level, "ERROR", "{event:?}");
            assert_eq!(event.fields["holder_visible"], "false", "{event:?}");
            assert_eq!(event.fields["holder_pid"], "0", "{event:?}");
            assert_eq!(
                event.fields["reason"], "held by a process outside Freshell's view",
                "{event:?}"
            );
            assert_eq!(event.fields["detail"], detail, "{event:?}");
            assert_eq!(event.fields["source"], "proxy", "{event:?}");
        }
    }
}

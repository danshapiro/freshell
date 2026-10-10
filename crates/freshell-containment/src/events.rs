//! The `freshell_unit` JSONL event family (target `freshell_unit`). Every
//! event carries the same key set; absent values are empty strings, numbers
//! are numbers (never `?`-formatted Options). Other processes are named by
//! process name and pid (plus start time for survivors), never by argv.
use crate::process::ProcIdentity;

/// The keys every unit event carries: the unit, its provider, and the
/// conversation, terminal and owner operation when they exist.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitLogKeys {
    pub unit_id: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub terminal_id: Option<String>,
    pub operation_id: Option<String>,
}

macro_rules! keyed {
    ($lvl:ident, $k:expr, $event:literal, $($rest:tt)*) => {
        tracing::$lvl!(target: "freshell_unit",
            event = $event,
            unit_id = %$k.unit_id,
            provider = %$k.provider,
            session_id = %$k.session_id.as_deref().unwrap_or(""),
            terminal_id = %$k.terminal_id.as_deref().unwrap_or(""),
            operation_id = %$k.operation_id.as_deref().unwrap_or(""),
            $($rest)*)
    };
}

/// A stop was requested (`mode`: graceful or force): the request that
/// started the unit's stop (`joined: false`).
pub fn stop_requested(k: &UnitLogKeys, reason: &str, mode: &str, initiator: &str) {
    keyed!(info, k, "unit.stop.requested", reason = %reason, mode = %mode, initiator = %initiator,
        joined = false, replaced_reason = false, "unit stop requested");
}

/// A stop request that joined the stop already in flight (`joined: true`),
/// with the joiner's own reason, mode and initiator; `replaced_reason` says
/// whether it took over the stop's reason (a user kill joining a weaker stop).
pub fn stop_joined(
    k: &UnitLogKeys,
    reason: &str,
    mode: &str,
    initiator: &str,
    replaced_reason: bool,
) {
    keyed!(info, k, "unit.stop.requested", reason = %reason, mode = %mode, initiator = %initiator,
        joined = true, replaced_reason, "unit stop request joined the stop in flight");
}

/// A signal was sent to one member (`pid` 0 when the target has no single pid).
pub fn signal_sent(k: &UnitLogKeys, signal: &str, target: &str, pid: Option<u32>) {
    keyed!(info, k, "unit.stop.signal_sent", signal = %signal, target = %target, pid = pid.unwrap_or(0),
        "unit stop signal sent");
}

/// Gone: the screen and the main process are confirmed dead and the
/// conversation lock is released.
pub fn gone(k: &UnitLogKeys, reason: &str, duration_ms: u64, lock_released: bool, escalated: bool) {
    keyed!(info, k, "unit.stop.gone", reason = %reason, duration_ms, lock_released, escalated,
        "unit gone");
}

/// A graceful stop escalated (for example SIGINT to SIGKILL).
pub fn escalated(k: &UnitLogKeys, from: &str, to: &str, after_ms: u64) {
    keyed!(warn, k, "unit.stop.escalated", from = %from, to = %to, after_ms,
        "unit stop escalated");
}

/// Gone was not confirmed in time; the unit stays Stopping.
pub fn unconfirmed(k: &UnitLogKeys, after_ms: u64, waiting_on: &str) {
    keyed!(error, k, "unit.stop.unconfirmed", after_ms, waiting_on = %waiting_on,
        "unit stop not confirmed");
}

/// Descendants still alive after the post-Gone sweep: one WARN per survivor
/// with plain `pid`, `start` and `name` values (never argv), and nothing when
/// there are none.
pub fn descendants_survived(k: &UnitLogKeys, survivors: &[ProcIdentity]) {
    let count = survivors.len() as u64;
    for survivor in survivors {
        keyed!(warn, k, "unit.descendants.survived", count, pid = survivor.pid, start = survivor.start,
            name = %survivor.name, "unit descendant survived the sweep");
    }
}

/// An entry point waited before starting (for the old unit's Gone).
pub fn start_waited(k: &UnitLogKeys, entry_point: &str, wait_ms: u64) {
    keyed!(info, k, "unit.start.waited", entry_point = %entry_point, wait_ms,
        "unit start waited");
}

/// Codex refused a writer ("already has an active writer" / "open in another
/// app"); `holder_name` is the holder's process name, never its command line.
pub fn writer_conflict(
    k: &UnitLogKeys,
    thread_id: &str,
    holder_pid: Option<u32>,
    holder_name: Option<&str>,
    source: &str,
) {
    keyed!(error, k, "unit.writer_conflict", thread_id = %thread_id, holder_pid = holder_pid.unwrap_or(0),
        holder_name = %holder_name.unwrap_or(""), source = %source, "conversation writer conflict");
}

/// The listener on the allocated port is not owned by a member of this unit,
/// so that start attempt fails and is retried; `launcher_pid` is the spawned
/// pid, for diagnosis only (never a fallback main).
pub fn main_discovery_failed(k: &UnitLogKeys, port: u16, launcher_pid: u32) {
    keyed!(
        warn,
        k,
        "unit.main_discovery_failed",
        port,
        launcher_pid,
        "unit main process not found on its port"
    );
}

/// A process the kill spared because it belongs to Codex's own daemon family
/// (judged by its own argv, plus its descendants): one INFO per process, by
/// name, pid and start time, never argv.
pub fn spared(k: &UnitLogKeys, spared: &[ProcIdentity]) {
    for process in spared {
        keyed!(info, k, "unit.stop.spared", pid = process.pid, start = process.start,
            name = %process.name, "unit stop spared a Codex daemon process");
    }
}

/// Stopping could not be saved to the unit record (`error`: the OS error
/// text). Nothing is signalled until it is.
pub fn persist_failed(k: &UnitLogKeys, error: &str) {
    keyed!(error, k, "unit.stop.persist_failed", error = %error,
        "unit stop could not save Stopping");
}

/// An attempt of the stop sequence panicked.
pub fn stop_panicked(k: &UnitLogKeys, attempt: u32, final_attempt: bool) {
    keyed!(
        error,
        k,
        "unit.stop.panicked",
        attempt,
        final_attempt,
        "unit stop attempt panicked"
    );
}

/// An attempt of the stop sequence failed with an OS error.
pub fn stop_failed(k: &UnitLogKeys, attempt: u32, final_attempt: bool, error: &str) {
    keyed!(error, k, "unit.stop.failed", attempt, final_attempt, error = %error,
        "unit stop attempt failed");
}

/// The whole-unit kill could not confirm the unit's cgroup frozen first
/// (`detail`: no frozen event within the deadline, or the error of the
/// freeze write or of its watch); the kill went ahead without relying on the
/// freeze.
pub fn freeze_timeout(k: &UnitLogKeys, detail: &str) {
    keyed!(warn, k, "unit.stop.freeze_timeout", detail = %detail,
        "unit kill went ahead without a frozen cgroup");
}

/// The whole-unit kill failed (the pinned roots are still killed directly).
pub fn kill_all_failed(k: &UnitLogKeys, error: &str) {
    keyed!(error, k, "unit.stop.kill_all_failed", error = %error,
        "unit kill failed");
}

/// A member exited, or was still unplaced at the deadline, before its
/// placement was confirmed: a typed start failure. `exit_code` is -1 while
/// the process is still alive.
pub fn placement_failed(
    k: &UnitLogKeys,
    role: &str,
    pid: u32,
    exit_code: Option<i64>,
    reason: &str,
) {
    keyed!(error, k, "unit.placement_failed", role = %role, pid, exit_code = exit_code.unwrap_or(-1),
        reason = %reason, "unit member placement failed");
}

/// The unit record could not be written (`op`: create, update, stopping or
/// remove).
pub fn record_write_failed(k: &UnitLogKeys, op: &str, error: &str) {
    keyed!(error, k, "unit.record.write_failed", op = %op, error = %error,
        "unit record write failed");
}

/// A recorded root could not be pinned (gone, or alive with another start
/// time), so it is never signalled.
pub fn root_not_pinned(k: &UnitLogKeys, pid: u32, recorded_start: u64, reason: &str) {
    keyed!(warn, k, "unit.root.not_pinned", pid, recorded_start, reason = %reason,
        "recorded unit root not pinned");
}

/// Releasing the unit's OS container after the sweep failed, or was skipped
/// because the unit could not be watched for emptiness (the container is
/// then kept).
pub fn release_failed(k: &UnitLogKeys, error: &str) {
    keyed!(warn, k, "unit.release_failed", error = %error, "unit release failed");
}

/// Same-uid processes whose environment could not be read while looking for
/// the unit's tag (they can still be members as a root's descendants). The
/// backend reports the count; the unit logs it with its keys.
pub fn environ_withheld(k: &UnitLogKeys, count: u64) {
    keyed!(
        info,
        k,
        "unit.members.environ_withheld",
        count,
        "unit member scan could not read some environments"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_capture::{capture, FieldValue};

    fn keys() -> UnitLogKeys {
        UnitLogKeys {
            unit_id: "u0123456789abcdef0123456789abcdef".into(),
            provider: "codex".into(),
            session_id: Some("t-1".into()),
            terminal_id: None,
            operation_id: None,
        }
    }

    #[test]
    fn every_event_carries_the_unit_keys_as_plain_values() {
        let k = keys();
        let events = capture(|| {
            stop_requested(&k, "shift-x", "force", "ws");
            signal_sent(&k, "SIGINT", "main", None);
            gone(&k, "shift-x", 812, true, false);
            escalated(&k, "SIGINT", "SIGKILL", 1000);
            unconfirmed(&k, 5000, "main");
            start_waited(&k, "auto-resume", 40);
            writer_conflict(&k, "t-1", None, None, "resume");
            main_discovery_failed(&k, 41000, 4242);
        });
        let names: Vec<&str> = events.iter().map(|e| e.str("event")).collect();
        assert_eq!(
            names,
            [
                "unit.stop.requested",
                "unit.stop.signal_sent",
                "unit.stop.gone",
                "unit.stop.escalated",
                "unit.stop.unconfirmed",
                "unit.start.waited",
                "unit.writer_conflict",
                "unit.main_discovery_failed",
            ]
        );
        for event in &events {
            assert_eq!(event.target, "freshell_unit");
            assert_eq!(event.str("unit_id"), "u0123456789abcdef0123456789abcdef");
            assert_eq!(event.str("provider"), "codex");
            assert_eq!(event.str("session_id"), "t-1");
            // Absent keys are present as empty strings, never `None`.
            assert_eq!(event.str("terminal_id"), "");
            assert_eq!(event.str("operation_id"), "");
        }
        let levels: Vec<tracing::Level> = events.iter().map(|e| e.level).collect();
        use tracing::Level;
        assert_eq!(
            levels,
            [
                Level::INFO,
                Level::INFO,
                Level::INFO,
                Level::WARN,
                Level::ERROR,
                Level::INFO,
                Level::ERROR,
                Level::WARN
            ]
        );
        // Numbers are numbers; an absent pid is 0, an absent name is "".
        assert_eq!(events[1].u64("pid"), 0);
        assert_eq!(events[2].u64("duration_ms"), 812);
        assert_eq!(events[2].fields["lock_released"], FieldValue::Bool(true));
        assert_eq!(events[6].u64("holder_pid"), 0);
        assert_eq!(events[6].str("holder_name"), "");
        assert_eq!(events[7].u64("port"), 41000);
        assert_eq!(events[7].u64("launcher_pid"), 4242);
    }

    #[test]
    fn the_stop_sequence_events_carry_the_keys_and_plain_values() {
        let k = keys();
        let daemon = ProcIdentity {
            pid: 21,
            start: 2001,
            name: "codex".into(),
        };
        let events = capture(|| {
            spared(&k, std::slice::from_ref(&daemon));
            persist_failed(&k, "Not a directory (os error 20)");
            stop_panicked(&k, 1, false);
            stop_failed(&k, 2, true, "Too many open files (os error 24)");
            kill_all_failed(&k, "no such slice");
            placement_failed(&k, "screen", 77, None, "unplaced at deadline");
            placement_failed(&k, "agent", 78, Some(1), "exited before placement");
            record_write_failed(&k, "remove", "Permission denied (os error 13)");
            root_not_pinned(&k, 33, 3003, "different incarnation");
            release_failed(&k, "busy");
            environ_withheld(&k, 4);
        });
        use tracing::Level;
        let got: Vec<(Level, &str)> = events.iter().map(|e| (e.level, e.str("event"))).collect();
        assert_eq!(
            got,
            [
                (Level::INFO, "unit.stop.spared"),
                (Level::ERROR, "unit.stop.persist_failed"),
                (Level::ERROR, "unit.stop.panicked"),
                (Level::ERROR, "unit.stop.failed"),
                (Level::ERROR, "unit.stop.kill_all_failed"),
                (Level::ERROR, "unit.placement_failed"),
                (Level::ERROR, "unit.placement_failed"),
                (Level::ERROR, "unit.record.write_failed"),
                (Level::WARN, "unit.root.not_pinned"),
                (Level::WARN, "unit.release_failed"),
                (Level::INFO, "unit.members.environ_withheld"),
            ]
        );
        for event in &events {
            assert_eq!(event.target, "freshell_unit");
            assert_eq!(event.str("unit_id"), "u0123456789abcdef0123456789abcdef");
            assert_eq!(event.str("provider"), "codex");
            assert_eq!(event.str("terminal_id"), "");
        }
        assert_eq!(events[0].str("name"), "codex");
        assert_eq!(events[0].u64("pid"), 21);
        assert_eq!(events[0].u64("start"), 2001);
        assert!(!events[0].fields.contains_key("argv"));
        assert_eq!(events[2].u64("attempt"), 1);
        assert_eq!(events[3].fields["final_attempt"], FieldValue::Bool(true));
        // A live unplaced member logs exit code -1; an exited one its code.
        assert_eq!(events[5].fields["exit_code"], FieldValue::I64(-1));
        assert_eq!(events[6].fields["exit_code"], FieldValue::I64(1));
        assert_eq!(events[7].str("op"), "remove");
        assert_eq!(events[8].u64("recorded_start"), 3003);
        assert_eq!(events[10].u64("count"), 4);
    }

    #[test]
    fn descendants_survived_logs_one_plain_warn_per_survivor() {
        let k = keys();
        let survivors = [
            ProcIdentity {
                pid: 11,
                start: 1001,
                name: "node".into(),
            },
            ProcIdentity {
                pid: 12,
                start: 1002,
                name: "sleep".into(),
            },
        ];
        let events = capture(|| descendants_survived(&k, &survivors));
        assert_eq!(events.len(), 2);
        for (event, survivor) in events.iter().zip(&survivors) {
            assert_eq!(event.level, tracing::Level::WARN);
            assert_eq!(event.str("event"), "unit.descendants.survived");
            assert_eq!(event.u64("count"), 2);
            assert_eq!(event.u64("pid"), u64::from(survivor.pid));
            assert_eq!(event.u64("start"), survivor.start);
            assert_eq!(event.str("name"), survivor.name);
        }
        assert!(capture(|| descendants_survived(&k, &[])).is_empty());
    }
}

//! Env-gated fault injection for system tests (never active unless the
//! process runs with FRESHELL_TEST_HOOKS=1). One hook holds the Gone
//! CONFIRMATION (not the kill) so the unconfirmed path is testable end to
//! end; the other slows the write of the Stopping record, which every signal
//! waits for. Plus one read-only view for tests (the unit's emptiness wait)
//! and the cleanup of a test state root's systemd namespace slice.

/// The delay to hold Gone confirmation for, from
/// `FRESHELL_TEST_UNIT_GONE_DELAY_MS` (only with `FRESHELL_TEST_HOOKS=1`).
pub fn gone_delay() -> Option<std::time::Duration> {
    hook_delay("FRESHELL_TEST_UNIT_GONE_DELAY_MS")
}

/// The delay before the stop sequence writes Stopping to the unit record,
/// from `FRESHELL_TEST_UNIT_PERSIST_DELAY_MS` (only with
/// `FRESHELL_TEST_HOOKS=1`).
pub fn persist_delay() -> Option<std::time::Duration> {
    hook_delay("FRESHELL_TEST_UNIT_PERSIST_DELAY_MS")
}

/// Test support: the "unit is empty" wait the post-Gone sweep uses, when
/// the unit's backend has one (`None` otherwise). Read-only: it never
/// changes the unit.
pub fn unit_empty_wait(
    unit: &crate::AgentUnit,
) -> Option<crate::BoxFuture<'static, std::io::Result<()>>> {
    unit.empty_wait()
}

/// Test support: the systemd namespace slice of the containment over
/// `state_root` (`freshell-n<ns>.slice`, the parent of every unit slice it
/// creates), named by the backend's own rule.
#[cfg(target_os = "linux")]
pub fn namespace_slice(state_root: &std::path::Path) -> String {
    format!(
        "freshell-n{}.slice",
        crate::backend::systemd::namespace(state_root)
    )
}

/// Test support: stops the systemd namespace slice of a test's own state
/// root (with every unit slice still in it), within the backend's command
/// deadline, ignoring failures. A no-op where there is no systemd user
/// manager. Only for a state root the test created: it stops whatever runs
/// under that root's units.
pub fn stop_namespace_slice(state_root: &std::path::Path) {
    #[cfg(target_os = "linux")]
    {
        let mut stop = std::process::Command::new("systemctl");
        stop.args(["--user", "stop", &namespace_slice(state_root)]);
        let _ = crate::process::run_capture_with_deadline(
            &mut stop,
            crate::backend::systemd::COMMAND_DEADLINE,
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = state_root;
}

fn hook_delay(var: &str) -> Option<std::time::Duration> {
    parse_delay(
        std::env::var("FRESHELL_TEST_HOOKS").ok().as_deref(),
        std::env::var(var).ok().as_deref(),
    )
}

fn parse_delay(hooks: Option<&str>, delay_ms: Option<&str>) -> Option<std::time::Duration> {
    if hooks != Some("1") {
        return None;
    }
    delay_ms?
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
        .map(std::time::Duration::from_millis)
}

#[cfg(test)]
mod tests {
    use super::parse_delay;
    use std::time::Duration;

    #[test]
    fn a_hook_delay_is_active_only_behind_the_test_hooks_switch() {
        assert_eq!(
            parse_delay(Some("1"), Some(" 750 ")),
            Some(Duration::from_millis(750))
        );
        // Without the switch the delay is ignored, whatever its value.
        assert_eq!(parse_delay(None, Some("750")), None);
        assert_eq!(parse_delay(Some("true"), Some("750")), None);
        // A zero, missing or malformed delay means no delay.
        assert_eq!(parse_delay(Some("1"), Some("0")), None);
        assert_eq!(parse_delay(Some("1"), None), None);
        assert_eq!(parse_delay(Some("1"), Some("soon")), None);
    }
}

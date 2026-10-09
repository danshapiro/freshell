//! Env-gated fault injection for system tests (never active unless the
//! process runs with FRESHELL_TEST_HOOKS=1). One hook holds the Gone
//! CONFIRMATION (not the kill) so the unconfirmed path is testable end to
//! end; the other slows the write of the Stopping record, which every signal
//! waits for.

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

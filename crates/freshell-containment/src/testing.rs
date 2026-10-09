//! Env-gated fault injection for system tests (never active unless the
//! process runs with FRESHELL_TEST_HOOKS=1). Holds the Gone CONFIRMATION
//! (not the kill) so the unconfirmed path is testable end to end.

/// The delay to hold Gone confirmation for, from
/// `FRESHELL_TEST_UNIT_GONE_DELAY_MS` (only with `FRESHELL_TEST_HOOKS=1`).
pub fn gone_delay() -> Option<std::time::Duration> {
    parse_gone_delay(
        std::env::var("FRESHELL_TEST_HOOKS").ok().as_deref(),
        std::env::var("FRESHELL_TEST_UNIT_GONE_DELAY_MS")
            .ok()
            .as_deref(),
    )
}

fn parse_gone_delay(hooks: Option<&str>, delay_ms: Option<&str>) -> Option<std::time::Duration> {
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
    use super::parse_gone_delay;
    use std::time::Duration;

    #[test]
    fn the_gone_delay_is_active_only_behind_the_test_hooks_switch() {
        assert_eq!(
            parse_gone_delay(Some("1"), Some(" 750 ")),
            Some(Duration::from_millis(750))
        );
        // Without the switch the delay is ignored, whatever its value.
        assert_eq!(parse_gone_delay(None, Some("750")), None);
        assert_eq!(parse_gone_delay(Some("true"), Some("750")), None);
        // A zero, missing or malformed delay means no delay.
        assert_eq!(parse_gone_delay(Some("1"), Some("0")), None);
        assert_eq!(parse_gone_delay(Some("1"), None), None);
        assert_eq!(parse_gone_delay(Some("1"), Some("soon")), None);
    }
}

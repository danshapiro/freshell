//! Shared bounds for owned provider startup operations and their callers.
use std::time::Duration;

pub const PROVIDER_REFRESH_RUN: Duration = Duration::from_secs(25);
pub const PROVIDER_REFRESH_JOIN: Duration = Duration::from_secs(5);
pub const PROVIDER_REFRESH_CLEANUP_RUN: Duration = Duration::from_secs(4);
pub const PROVIDER_REFRESH_CLEANUP_KILL: Duration = Duration::from_secs(1);
pub const PROVIDER_REFRESH_RECOVERY_RUN: Duration = Duration::from_secs(30);
pub const PROVIDER_REFRESH_RECOVERY_KILL: Duration = Duration::from_secs(2);
pub const PROVIDER_METADATA_READ_RUN: Duration = Duration::from_secs(20);
pub const PROVIDER_METADATA_READ_CLEANUP: Duration = Duration::from_secs(5);
pub const HOSTED_CREATE_WAIT: Duration = Duration::from_secs(50);
pub const CLAUDE_SIDECAR_CREATE: Duration = Duration::from_secs(45);
pub const PROVIDER_ENDPOINT_WAIT: Duration = Duration::from_secs(2);
pub const NATIVE_OBSERVATION_RUN: Duration = Duration::from_secs(25);
pub const NATIVE_OBSERVATION_CLEANUP: Duration = Duration::from_secs(5);
pub const PREPARATION_CONTROL_ALLOWANCE: Duration = Duration::from_secs(35);

/// A failed refresh may signal its exact worker, join it, remove its disposable
/// stage, then recover the durable projection. Both cleanup commands are bounded.
pub fn provider_refresh_completion_budget() -> Duration {
    PROVIDER_REFRESH_RUN
        + PROVIDER_REFRESH_JOIN
        + (PROVIDER_REFRESH_CLEANUP_RUN + PROVIDER_REFRESH_CLEANUP_KILL) * 2
        + PROVIDER_REFRESH_RECOVERY_RUN
        + PROVIDER_REFRESH_RECOVERY_KILL
}

/// Candidate observation projects the current ordinary inputs before reading
/// their native selection. Retained candidates first reconstruct the frozen
/// prior selection, so each supported refresh needs its own operation budget.
pub fn claude_source_observation_budget(candidate: bool, retained: bool) -> Duration {
    let refreshes = match (candidate, retained) {
        (false, _) => 0,
        (true, false) => 1,
        (true, true) => 2,
    };
    NATIVE_OBSERVATION_RUN + PROVIDER_REFRESH_RUN * refreshes
}

/// Claude preparation reads the quiescent source and then the staged candidate.
/// Keep time for both complete reader operations in addition to controller work.
pub fn provider_preparation_budget(provider: Option<&str>) -> Duration {
    PREPARATION_CONTROL_ALLOWANCE
        + if matches!(provider, Some("claude" | "kilroy")) {
            claude_source_observation_budget(false, true)
                + claude_source_observation_budget(true, true)
                + NATIVE_OBSERVATION_CLEANUP * 2
        } else {
            Duration::ZERO
        }
}

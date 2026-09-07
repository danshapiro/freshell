use freshell_runtime_protocol::{RuntimeLimits, RuntimeProfile};

pub const DEFAULT_AGENT_LIMITS: RuntimeLimits = RuntimeLimits {
    cpu_milli: 2_000,
    memory_bytes: 4 * 1024 * 1024 * 1024,
    swap_bytes: 0,
    pids_max: 512,
};

pub const TEST_FIXTURE_LIMITS: RuntimeLimits = RuntimeLimits {
    cpu_milli: 500,
    memory_bytes: 256 * 1024 * 1024,
    swap_bytes: 0,
    pids_max: 64,
};

pub fn profile_limits(profile: RuntimeProfile) -> Option<RuntimeLimits> {
    match profile {
        RuntimeProfile::DefaultAgent => Some(DEFAULT_AGENT_LIMITS),
        RuntimeProfile::TestFixture => Some(TEST_FIXTURE_LIMITS),
        RuntimeProfile::Custom => None,
    }
}

pub fn verify_profile(profile: RuntimeProfile, requested: RuntimeLimits) -> Result<(), String> {
    requested.validate().map_err(|e| e.message)?;
    if let Some(expected) = profile_limits(profile) {
        if expected != requested {
            return Err(format!(
                "saved profile {profile:?} does not match its configured limits"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_defaults_match_phase2_contract() {
        assert_eq!(DEFAULT_AGENT_LIMITS.cpu_milli, 2000);
        assert_eq!(DEFAULT_AGENT_LIMITS.memory_bytes, 4_294_967_296);
        assert_eq!(TEST_FIXTURE_LIMITS.memory_bytes, 268_435_456);
        assert_eq!(TEST_FIXTURE_LIMITS.pids_max, 64);
    }
}

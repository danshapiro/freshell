//! Compile-time fenced routing policy for pending live-provider qualification.

use std::collections::BTreeSet;

pub const QUALIFICATION_PROVIDER_ENV: &str = "FRESHELL_MANAGED_PROVIDER_QUALIFICATION";
const PENDING_TERMINAL_PROVIDERS: &[&str] = &["claude", "codex", "amplifier"];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QualificationPolicy {
    selected: BTreeSet<String>,
}

impl QualificationPolicy {
    pub fn permits(&self, provider: &str) -> bool {
        self.selected.contains(provider)
    }
}

pub fn qualification_policy_from_value(value: Option<&str>) -> Result<QualificationPolicy, String> {
    let Some(value) = value else {
        return Ok(QualificationPolicy::default());
    };
    if value.is_empty() {
        return Err(format!(
            "{QUALIFICATION_PROVIDER_ENV} must name one or more comma-separated pending terminal providers"
        ));
    }
    let mut requested = BTreeSet::new();
    for provider in value.split(',') {
        if provider.is_empty()
            || provider.trim() != provider
            || !PENDING_TERMINAL_PROVIDERS.contains(&provider)
        {
            return Err(format!(
                "{QUALIFICATION_PROVIDER_ENV} contains unsupported provider {provider:?}; allowed values are {}",
                PENDING_TERMINAL_PROVIDERS.join(",")
            ));
        }
        if !requested.insert(provider.to_string()) {
            return Err(format!(
                "{QUALIFICATION_PROVIDER_ENV} contains duplicate provider {provider}"
            ));
        }
    }

    #[cfg(feature = "provider-qualification")]
    {
        Ok(QualificationPolicy {
            selected: requested,
        })
    }
    #[cfg(not(feature = "provider-qualification"))]
    {
        // Parse and diagnose malformed policy even in an ordinary build, but
        // never grant it any routing authority without the nondefault feature.
        let _ = requested;
        Ok(QualificationPolicy::default())
    }
}

pub fn process_qualification_policy() -> Result<QualificationPolicy, String> {
    qualification_policy_from_value(std::env::var(QUALIFICATION_PROVIDER_ENV).ok().as_deref())
}

pub fn qualification_managed_provider_enabled(provider: &str) -> bool {
    process_qualification_policy().is_ok_and(|policy| policy.permits(provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualification_selection_is_bounded_to_pending_terminal_providers() {
        for value in [
            "shell",
            "opencode",
            "freshclaude",
            "gemini",
            "claude,unknown",
            "claude,claude",
            "all",
            "",
        ] {
            assert!(
                qualification_policy_from_value(Some(value)).is_err(),
                "qualification allowlist unexpectedly accepted {value:?}"
            );
        }
    }

    #[cfg(feature = "provider-qualification")]
    #[test]
    fn qualification_build_routes_only_explicitly_selected_pending_providers() {
        let policy = qualification_policy_from_value(Some("claude,codex")).unwrap();
        assert!(policy.permits("claude"));
        assert!(policy.permits("codex"));
        assert!(!policy.permits("amplifier"));
        assert!(!policy.permits("opencode"));
        assert!(!policy.permits("shell"));
    }

    #[cfg(not(feature = "provider-qualification"))]
    #[test]
    fn ordinary_build_ignores_the_qualification_environment_switch() {
        let policy = qualification_policy_from_value(Some("claude,codex,amplifier")).unwrap();
        for provider in PENDING_TERMINAL_PROVIDERS {
            assert!(!policy.permits(provider));
        }
    }
}

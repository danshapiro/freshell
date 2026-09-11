//! Explicit installation enablement shared by production and live tests.
use std::collections::BTreeSet;

pub const MANAGED_PROVIDERS_ENV: &str = "FRESHELL_MANAGED_PROVIDERS";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedProviderPolicy {
    selected: Option<BTreeSet<String>>,
}

impl ManagedProviderPolicy {
    pub fn permits(&self, provider: &str) -> bool {
        let Some(adapter) = super::capability(provider) else {
            return false;
        };
        if adapter.recovery_paths.is_empty() {
            return false;
        }
        self.selected
            .as_ref()
            .map_or(adapter.managed_enabled, |selected| {
                selected.contains(provider)
            })
    }
}

pub fn managed_provider_policy_from_value(
    value: Option<&str>,
) -> Result<ManagedProviderPolicy, String> {
    let Some(value) = value else {
        return Ok(ManagedProviderPolicy::default());
    };
    let mut selected = BTreeSet::new();
    for provider in value.split(',') {
        if provider.is_empty()
            || provider.trim() != provider
            || !super::capability(provider)
                .is_some_and(|adapter| !adapter.recovery_paths.is_empty())
        {
            return Err(format!(
                "{MANAGED_PROVIDERS_ENV} names an unsupported managed adapter: {provider:?}"
            ));
        }
        if !selected.insert(provider.to_string()) {
            return Err(format!(
                "{MANAGED_PROVIDERS_ENV} repeats provider {provider}"
            ));
        }
    }
    Ok(ManagedProviderPolicy {
        selected: Some(selected),
    })
}

pub fn process_managed_provider_policy() -> Result<ManagedProviderPolicy, String> {
    managed_provider_policy_from_value(std::env::var(MANAGED_PROVIDERS_ENV).ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_provider_selection_uses_the_ordinary_build() {
        let policy =
            managed_provider_policy_from_value(Some("shell,claude,codex,opencode,amplifier"))
                .unwrap();
        for provider in ["shell", "claude", "codex", "opencode", "amplifier"] {
            assert!(policy.permits(provider));
        }
        assert!(!policy.permits("unknown"));
    }
    #[test]
    fn explicit_selection_is_exact_and_does_not_enable_other_providers() {
        let policy = managed_provider_policy_from_value(Some("claude")).unwrap();
        assert!(policy.permits("claude"));
        assert!(!policy.permits("opencode"));
    }
    #[test]
    fn malformed_or_unimplemented_selection_is_not_an_unmanaged_fallback() {
        for value in [
            "",
            "all",
            "claude,claude",
            "claude, codex",
            "gemini",
            "kimi",
            "freshclaude",
            "unknown",
        ] {
            assert!(
                managed_provider_policy_from_value(Some(value)).is_err(),
                "{value}"
            );
        }
    }
}

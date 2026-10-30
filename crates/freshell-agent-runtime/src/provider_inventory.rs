//! Build-time provider inventory shared by runtime policy and recovery.
//!
//! `docker/runtime/provider-versions.json` is the authoritative checked-in
//! inventory because the workload image and receipt validator already consume
//! it. Recovery must not carry a second hand-maintained version table.

use freshell_runtime_protocol::FreshProvider;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::LazyLock};

const PROVIDER_INVENTORY_JSON: &str =
    include_str!("../../../docker/runtime/provider-versions.json");

#[derive(Debug, Deserialize)]
struct Inventory {
    providers: BTreeMap<String, ProviderPin>,
}

#[derive(Debug, Deserialize)]
struct ProviderPin {
    version: String,
    #[serde(rename = "sdkNativeVersion")]
    sdk_native_version: Option<String>,
}

static INVENTORY: LazyLock<Inventory> = LazyLock::new(|| {
    serde_json::from_str(PROVIDER_INVENTORY_JSON)
        .expect("checked-in docker/runtime/provider-versions.json must be valid")
});

/// Exact provider version baked into the managed workload image.
pub fn pinned_provider_version(provider: &str) -> Option<String> {
    INVENTORY
        .providers
        .get(provider)
        .map(|pin| pin.version.clone())
}

fn fresh_version(inventory: &Inventory, provider: &FreshProvider) -> Option<String> {
    let pin = inventory.providers.get(provider.native_family())?;
    match provider {
        FreshProvider::Claude | FreshProvider::Kilroy => pin
            .sdk_native_version
            .as_ref()
            .filter(|version| !version.trim().is_empty())
            .cloned(),
        _ => Some(pin.version.clone()),
    }
}

/// Exact selected native child version for a managed fresh-agent mode.
pub fn pinned_fresh_provider_version(provider: &FreshProvider) -> Option<String> {
    fresh_version(&INVENTORY, provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed_inventory(sdk_pin: Option<&str>) -> Inventory {
        let mut claude = serde_json::json!({"version":"terminal-distinct"});
        if let Some(value) = sdk_pin {
            claude["sdkNativeVersion"] = serde_json::json!(value);
        }
        serde_json::from_value(serde_json::json!({"providers":{
            "claude":claude, "codex":{"version":"codex-selected"},
            "opencode":{"version":"opencode-selected"}
        }}))
        .unwrap()
    }

    #[test]
    fn fresh_claude_reader_selects_sdk_child_instead_of_terminal() {
        assert_eq!(
            fresh_version(
                &parsed_inventory(Some("sdk-selected")),
                &FreshProvider::Claude
            )
            .as_deref(),
            Some("sdk-selected")
        );
    }

    #[test]
    fn logical_kilroy_reader_selects_claude_sdk_child() {
        assert_eq!(
            fresh_version(
                &parsed_inventory(Some("sdk-selected")),
                &FreshProvider::Kilroy
            )
            .as_deref(),
            Some("sdk-selected")
        );
    }

    #[test]
    fn absent_or_empty_sdk_child_is_unknown_without_terminal_fallback() {
        for sdk_pin in [None, Some(""), Some("  ")] {
            let inventory = parsed_inventory(sdk_pin);
            for provider in [FreshProvider::Claude, FreshProvider::Kilroy] {
                assert_eq!(fresh_version(&inventory, &provider), None);
            }
            assert_eq!(
                fresh_version(&inventory, &FreshProvider::Codex).as_deref(),
                Some("codex-selected")
            );
            assert_eq!(
                fresh_version(&inventory, &FreshProvider::Opencode).as_deref(),
                Some("opencode-selected")
            );
            assert_eq!(inventory.providers["claude"].version, "terminal-distinct");
        }
    }

    #[test]
    fn missing_provider_is_unknown_and_wrong_sdk_pin_types_refuse() {
        let empty: Inventory = serde_json::from_str("{\"providers\":{}}").unwrap();
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            assert_eq!(fresh_version(&empty, &provider), None);
        }
        for wrong in [serde_json::json!(42), serde_json::json!(false)] {
            assert!(serde_json::from_value::<Inventory>(serde_json::json!({"providers":{"claude":{"version":"terminal-distinct","sdkNativeVersion":wrong}}})).is_err());
        }
    }

    #[test]
    fn checked_in_inventory_contains_every_managed_terminal_adapter() {
        for provider in ["claude", "codex", "opencode", "amplifier"] {
            assert!(
                pinned_provider_version(provider).is_some(),
                "missing checked-in version for {provider}"
            );
        }
    }
}

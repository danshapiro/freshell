//! Build-time provider inventory shared by runtime policy and recovery.
//!
//! `docker/runtime/provider-versions.json` is the authoritative checked-in
//! inventory because the workload image and receipt validator already consume
//! it. Recovery must not carry a second hand-maintained version table.

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

#[cfg(test)]
mod tests {
    use super::*;

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

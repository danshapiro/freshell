//! Ephemeral child environment for a single managed soul process.
//! The trusted session host installs values after reading OneCLI grants; only
//! provider subprocess commands receive them. Nothing enters the host's own
//! process environment or a serialized launch record.

use std::collections::BTreeMap;
use std::sync::OnceLock;

static CHILD_ENVIRONMENT: OnceLock<BTreeMap<String, String>> = OnceLock::new();

pub fn install(values: BTreeMap<String, String>) -> Result<(), String> {
    CHILD_ENVIRONMENT
        .set(values)
        .map_err(|_| "managed child environment already initialized".to_string())
}

pub fn snapshot() -> Option<&'static BTreeMap<String, String>> {
    CHILD_ENVIRONMENT.get()
}

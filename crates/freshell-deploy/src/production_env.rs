use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;

use crate::error::{DeployError, Result};

/// Capture the external environment needed by the long-lived server without
/// persisting secrets in a generation or deployment receipt.
///
/// `.env` supplies checkout configuration and the controller's process
/// environment wins, matching dotenv's ordinary precedence. Deployment
/// bindings and protocol controls are deliberately excluded; each launch
/// helper inserts those from verified generation/journal state.
pub(crate) fn production_environment(checkout: &Path) -> Result<BTreeMap<OsString, OsString>> {
    let mut environment = BTreeMap::new();
    let dotenv = checkout.join(".env");
    if dotenv.exists() {
        for entry in dotenvy::from_path_iter(&dotenv).map_err(|error| {
            DeployError::Activation(format!("cannot read {}: {error}", dotenv.display()))
        })? {
            let (key, value) = entry.map_err(|error| {
                DeployError::Activation(format!("cannot parse {}: {error}", dotenv.display()))
            })?;
            if !is_controller_owned(OsStr::new(&key)) {
                environment.insert(OsString::from(key), OsString::from(value));
            }
        }
    }
    for (key, value) in std::env::vars_os() {
        if !is_controller_owned(&key) {
            environment.insert(key, value);
        }
    }
    Ok(environment)
}

fn is_controller_owned(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        // A non-UTF-8 environment name cannot be a supported Freshell
        // configuration key. Do not propagate it across the trust boundary.
        return true;
    };
    key.starts_with("FRESHELL_DEPLOY_")
        || matches!(
            key,
            "AUTH_TOKEN"
                | "PORT"
                | "NODE_ENV"
                | "FRESHELL_BIND_HOST"
                | "FRESHELL_CLAUDE_NODE"
                | "FRESHELL_CLAUDE_SIDECAR"
                | "FRESHELL_CLIENT_DIR"
                | "FRESHELL_EXTENSIONS_DIR"
                | "FRESHELL_MCP_SERVER_ENTRY"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_bindings_are_filtered_but_external_configuration_is_retained() {
        assert!(is_controller_owned(OsStr::new(
            "FRESHELL_DEPLOY_ACTIVATION_FILE"
        )));
        assert!(is_controller_owned(OsStr::new("FRESHELL_CLIENT_DIR")));
        assert!(is_controller_owned(OsStr::new("PORT")));
        assert!(!is_controller_owned(OsStr::new("PATH")));
        assert!(!is_controller_owned(OsStr::new("ALLOWED_ORIGINS")));
        assert!(!is_controller_owned(OsStr::new("CODEX_HOME")));
        assert!(!is_controller_owned(OsStr::new("ANTHROPIC_API_KEY")));
    }
}

use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const AMPLIFIER_PROFILE: &str = "onecli-anthropic-haiku-low";
pub const AMPLIFIER_MODEL: &str = "claude-haiku-4-5-20251001";
pub const AMPLIFIER_REASONING_EFFORT: &str = "low";
pub const AMPLIFIER_PROGRAM: &str = "/usr/local/bin/freshell-amplifier-onecli";

pub fn amplifier_secret_references(
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Vec<ProviderSecretReference>, String> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Amplifier OneCLI bootstrap requires HOME".to_string())?;
    let approved_keys = home.join(".amplifier/keys.env");
    let configured_keys = std::env::var("FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| approved_keys.clone());
    let profile = std::env::var("FRESHELL_MANAGED_AMPLIFIER_PROFILE")
        .map_err(|_| format!("Amplifier qualification requires FRESHELL_MANAGED_AMPLIFIER_PROFILE={AMPLIFIER_PROFILE}"))?;
    let endpoint = std::env::var("FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENDPOINT")
        .map_err(|_| "Amplifier qualification requires an explicit non-secret FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENDPOINT".to_string())?;
    let raw_oauth = std::env::var("FRESHELL_MANAGED_AMPLIFIER_OAUTH_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let fallback = home.join(".amplifier/openai-chatgpt-oauth.json");
            fallback.is_file().then_some(fallback)
        });
    validate_amplifier_bootstrap(
        &profile,
        model,
        effort,
        &endpoint,
        &configured_keys,
        &approved_keys,
        raw_oauth.as_deref(),
    )
}

fn validate_amplifier_bootstrap(
    profile: &str,
    model: Option<&str>,
    effort: Option<&str>,
    endpoint: &str,
    configured_keys: &Path,
    approved_keys: &Path,
    raw_oauth: Option<&Path>,
) -> Result<Vec<ProviderSecretReference>, String> {
    if profile != AMPLIFIER_PROFILE {
        return Err(format!(
            "unsupported Amplifier profile {profile:?}; qualification allows only {AMPLIFIER_PROFILE}"
        ));
    }
    if model != Some(AMPLIFIER_MODEL) || effort != Some(AMPLIFIER_REASONING_EFFORT) {
        return Err(format!(
            "Amplifier qualification requires model {AMPLIFIER_MODEL} with reasoning effort {AMPLIFIER_REASONING_EFFORT}"
        ));
    }
    let endpoint_tail = endpoint.strip_prefix("https://").unwrap_or_default();
    let authority = endpoint_tail.split('/').next().unwrap_or_default();
    if authority.is_empty()
        || authority.starts_with('.')
        || authority.ends_with('.')
        || !authority
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':'))
        || endpoint.chars().any(|ch| matches!(ch, '@' | '#' | '?'))
        || endpoint
            .chars()
            .any(|ch| !ch.is_ascii() || ch.is_whitespace() || ch.is_control())
    {
        return Err(
            "Amplifier OneCLI endpoint must be an explicit credential-free https URL".into(),
        );
    }
    if raw_oauth.is_some() {
        return Err("Amplifier OneCLI keys.env conflicts with raw OAuth bootstrap; remove the OAuth reference for qualification".into());
    }
    let approved = std::fs::canonicalize(approved_keys).map_err(|error| {
        format!(
            "approved Amplifier OneCLI keys file {} is missing: {error}",
            approved_keys.display()
        )
    })?;
    let configured = std::fs::canonicalize(configured_keys).map_err(|error| {
        format!(
            "Amplifier OneCLI keys reference {} is missing: {error}",
            configured_keys.display()
        )
    })?;
    if configured != approved {
        return Err(format!(
            "Amplifier OneCLI keys reference must resolve to the approved private file {}",
            approved.display()
        ));
    }
    let metadata = std::fs::metadata(&configured)
        .map_err(|error| format!("inspect Amplifier OneCLI keys reference: {error}"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("Amplifier OneCLI keys reference must be a private regular file (mode 0600 or stricter)".into());
    }
    Ok(vec![ProviderSecretReference {
        source_path: configured.to_string_lossy().into_owned(),
        profile: ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
        approved_endpoint: endpoint.to_string(),
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn private_file(root: &Path) -> PathBuf {
        let path = root.join("keys.env");
        fs::write(&path, "ANTHROPIC_API_KEY=placeholder-for-parser-test\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    #[test]
    fn accepts_only_the_approved_reference_and_low_cost_profile() {
        let root = tempfile::tempdir().unwrap();
        let keys = private_file(root.path());
        let refs = validate_amplifier_bootstrap(
            AMPLIFIER_PROFILE,
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            "https://onecli.example.invalid/v1",
            &keys,
            &keys,
            None,
        )
        .unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source_path, keys.to_string_lossy());
    }

    #[test]
    fn fails_closed_for_expensive_defaults_endpoint_credentials_or_raw_oauth() {
        let root = tempfile::tempdir().unwrap();
        let keys = private_file(root.path());
        for result in [
            validate_amplifier_bootstrap(
                AMPLIFIER_PROFILE,
                Some("claude-fable-5"),
                Some("high"),
                "https://onecli.example/v1",
                &keys,
                &keys,
                None,
            ),
            validate_amplifier_bootstrap(
                AMPLIFIER_PROFILE,
                Some(AMPLIFIER_MODEL),
                Some("max"),
                "https://onecli.example/v1",
                &keys,
                &keys,
                None,
            ),
            validate_amplifier_bootstrap(
                AMPLIFIER_PROFILE,
                Some(AMPLIFIER_MODEL),
                Some(AMPLIFIER_REASONING_EFFORT),
                "https://token@onecli.example/v1",
                &keys,
                &keys,
                None,
            ),
            validate_amplifier_bootstrap(
                AMPLIFIER_PROFILE,
                Some(AMPLIFIER_MODEL),
                Some(AMPLIFIER_REASONING_EFFORT),
                "https://onecli.example/v1?token=secret",
                &keys,
                &keys,
                None,
            ),
            validate_amplifier_bootstrap(
                AMPLIFIER_PROFILE,
                Some(AMPLIFIER_MODEL),
                Some(AMPLIFIER_REASONING_EFFORT),
                "https://onecli.example/v1",
                &keys,
                &keys,
                Some(Path::new("oauth.json")),
            ),
        ] {
            assert!(result.is_err());
        }
    }

    #[test]
    fn rejects_a_different_or_public_keys_file() {
        let root = tempfile::tempdir().unwrap();
        let approved = private_file(root.path());
        let other = root.path().join("other.env");
        fs::write(&other, "ANTHROPIC_API_KEY=nope\n").unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o644)).unwrap();
        let different = validate_amplifier_bootstrap(
            AMPLIFIER_PROFILE,
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            "https://onecli.example/v1",
            &other,
            &approved,
            None,
        );
        assert!(different.unwrap_err().contains("approved private file"));
    }
}

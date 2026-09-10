use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// This is the provider-effective model configured by the approved OneCLI
/// deployment, not a synthetic model selected purely for qualification.
pub const AMPLIFIER_MODEL: &str = "glm-5.3";
pub const AMPLIFIER_REASONING_EFFORT: &str = "provider-default";
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
    let raw_oauth = std::env::var("FRESHELL_MANAGED_AMPLIFIER_OAUTH_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let fallback = home.join(".amplifier/openai-chatgpt-oauth.json");
            fallback.is_file().then_some(fallback)
        });
    validate_amplifier_bootstrap(
        model,
        effort,
        &configured_keys,
        &approved_keys,
        raw_oauth.as_deref(),
    )
}

fn validate_amplifier_bootstrap(
    model: Option<&str>,
    effort: Option<&str>,
    configured_keys: &Path,
    approved_keys: &Path,
    raw_oauth: Option<&Path>,
) -> Result<Vec<ProviderSecretReference>, String> {
    if model != Some(AMPLIFIER_MODEL) || effort != Some(AMPLIFIER_REASONING_EFFORT) {
        return Err(format!(
            "Amplifier OneCLI requires model {AMPLIFIER_MODEL} with native provider-default reasoning"
        ));
    }
    if raw_oauth.is_some() {
        return Err("Amplifier OneCLI keys.env conflicts with raw OAuth bootstrap; remove the OAuth reference for qualification".into());
    }
    let approved_metadata = std::fs::symlink_metadata(approved_keys).map_err(|error| {
        format!(
            "approved Amplifier OneCLI keys file {} is missing: {error}",
            approved_keys.display()
        )
    })?;
    if !approved_metadata.is_file()
        || approved_metadata.file_type().is_symlink()
        || approved_metadata.permissions().mode() & 0o077 != 0
    {
        return Err(
            "approved Amplifier OneCLI keys file must be a private regular file (mode 0600 or stricter), not a symlink".into(),
        );
    }
    let approved = std::fs::canonicalize(approved_keys).map_err(|error| {
        format!(
            "approved Amplifier OneCLI keys file {} is unavailable: {error}",
            approved_keys.display()
        )
    })?;
    let configured_metadata = std::fs::symlink_metadata(configured_keys).map_err(|error| {
        format!(
            "Amplifier OneCLI keys reference {} is missing: {error}",
            configured_keys.display()
        )
    })?;
    if !configured_metadata.is_file() || configured_metadata.file_type().is_symlink() {
        return Err("Amplifier OneCLI keys reference must be a regular file, not a symlink".into());
    }
    let configured = std::fs::canonicalize(configured_keys).map_err(|error| {
        format!(
            "Amplifier OneCLI keys reference {} is unavailable: {error}",
            configured_keys.display()
        )
    })?;
    if configured != approved {
        return Err(format!(
            "Amplifier OneCLI keys reference must resolve to the approved private file {}",
            approved.display()
        ));
    }
    if configured_metadata.permissions().mode() & 0o077 != 0 {
        return Err(
            "Amplifier OneCLI keys reference must be private (mode 0600 or stricter)".into(),
        );
    }
    Ok(vec![ProviderSecretReference {
        source_path: configured.to_string_lossy().into_owned(),
        profile: ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn private_file(root: &Path) -> PathBuf {
        let path = root.join("keys.env");
        fs::write(&path, "LUNAROUTE_API_KEY=onecli-managed-by-proxy\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    #[test]
    fn accepts_only_the_approved_reference_and_actual_onecli_profile() {
        let root = tempfile::tempdir().unwrap();
        let keys = private_file(root.path());
        let refs = validate_amplifier_bootstrap(
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            &keys,
            &keys,
            None,
        )
        .unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source_path, keys.to_string_lossy());
        assert_eq!(
            refs[0].profile,
            ProviderSecretProfile::AmplifierOnecliLunarouteGlm53
        );
    }

    #[test]
    fn fails_closed_for_a_different_model_or_raw_oauth_without_inventing_endpoint_configuration() {
        let root = tempfile::tempdir().unwrap();
        let keys = private_file(root.path());
        for result in [
            validate_amplifier_bootstrap(
                Some("different-model"),
                Some(AMPLIFIER_REASONING_EFFORT),
                &keys,
                &keys,
                None,
            ),
            validate_amplifier_bootstrap(Some(AMPLIFIER_MODEL), Some("high"), &keys, &keys, None),
            validate_amplifier_bootstrap(
                Some(AMPLIFIER_MODEL),
                Some(AMPLIFIER_REASONING_EFFORT),
                &keys,
                &keys,
                Some(Path::new("oauth.json")),
            ),
        ] {
            assert!(result.is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_even_when_it_resolves_to_the_approved_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let approved = private_file(root.path());
        let linked = root.path().join("linked.env");
        symlink(&approved, &linked).unwrap();
        let error = validate_amplifier_bootstrap(
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            &linked,
            &approved,
            None,
        )
        .unwrap_err();
        assert!(error.contains("symlink"));
    }

    #[test]
    fn rejects_a_different_or_public_keys_file() {
        let root = tempfile::tempdir().unwrap();
        let approved = private_file(root.path());
        let other = root.path().join("other.env");
        fs::write(&other, "LUNAROUTE_API_KEY=other\n").unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o644)).unwrap();
        let different = validate_amplifier_bootstrap(
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            &other,
            &approved,
            None,
        );
        assert!(different.unwrap_err().contains("approved private file"));
    }
}

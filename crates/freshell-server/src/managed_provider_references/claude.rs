//! Finite original Claude source selection and ordinary first-volume authority.
use freshell_platform::provider_input_profiles::{MAX_SOURCE_EVENTS, MAX_SOURCE_EVENT_BYTES};
use freshell_runtime_protocol::*;
use std::path::Path;

pub(crate) struct ClaudePreparation<'a> {
    pub client: &'a freshell_runtime_client::RuntimeClient,
    pub soul: &'a SoulId,
    pub creation_seed: &'a str,
    pub reservation_provider: &'a str,
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub workspace: &'a Path,
    pub original: &'a (dyn Fn(&str) -> Option<String> + Sync),
    pub args: &'a [String],
    pub plugins: &'a [String],
    pub references: &'a [ProviderSecretReference],
}

pub(crate) async fn prepare_managed(
    request: ClaudePreparation<'_>,
) -> Result<ProviderLaunchContext, String> {
    if !matches!(request.reservation_provider, "claude" | "kilroy") {
        return Err("Claude source preparation requires its exact supported runtime flavor".into());
    }
    let mut plugin_dirs = Vec::new();
    let mut path_bytes = 0usize;
    let cli = request
        .args
        .windows(2)
        .filter(|pair| pair[0] == "--plugin-dir")
        .map(|pair| pair[1].as_str());
    for selected in cli.chain(request.plugins.iter().map(String::as_str)) {
        let path = Path::new(selected);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            request.cwd.join(path)
        };
        if plugin_dirs.contains(&path) {
            continue;
        }
        path_bytes = path_bytes
            .checked_add(path.as_os_str().len())
            .ok_or("Claude plugin source metadata overflow")?;
        if plugin_dirs.len() >= MAX_SOURCE_EVENTS || path_bytes > MAX_SOURCE_EVENT_BYTES {
            return Err("Claude plugin source event metadata profile exceeded".into());
        }
        plugin_dirs.push(path);
    }
    let manifest = freshell_platform::claude_inputs::ClaudeInputManifest {
        version: 1,
        original_home: request.home.into(),
        cwd: request.cwd.into(),
        workspace: request.workspace.into(),
        config_root: Some(selected_config_root(
            request.home,
            request.cwd,
            request.original,
        )?),
        setting_sources: request
            .args
            .windows(2)
            .rfind(|pair| pair[0] == "--setting-sources")
            .map(|pair| freshell_platform::claude_inputs::parse_setting_sources(&pair[1]))
            .transpose()
            .map_err(str::to_string)?
            .unwrap_or_else(freshell_platform::claude_inputs::default_setting_sources),
        plugin_dirs,
    };
    manifest.validate().map_err(str::to_string)?;
    let context = ProviderLaunchContext {
        preparation: ProviderPreparation::Claude {
            mcp_args: vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()],
        },
        config: vec![],
        mcp_capability: None,
        prepared_inputs: None,
    };
    let reservation = request
        .client
        .reserve_provider_inputs(
            request.soul.clone(),
            request.reservation_provider.into(),
            request.creation_seed.into(),
        )
        .await
        .map_err(|error| error.to_string())?;
    if reservation.provider != request.reservation_provider
        || &reservation.soul_id != request.soul
        || reservation.creation_seed_ref != request.creation_seed
    {
        return Err("Claude selected resource reservation does not match this creation".into());
    }
    crate::managed_mcp_capability::issue_prepared_provider_context(
        "claude",
        request.soul,
        request.home,
        &context,
        crate::managed_mcp_capability::OpencodeEphemeralInput {
            claude_manifest: Some(&manifest),
            cwd: Some(request.cwd),
            workspace: Some(request.workspace),
            secret_references: Some(request.references),
            initial_auth_reservation: Some(&reservation.reservation_id),
            ..Default::default()
        },
    )
}

fn selected_config_root(
    home: &Path,
    cwd: &Path,
    original: &dyn Fn(&str) -> Option<String>,
) -> Result<std::path::PathBuf, String> {
    use unicode_normalization::UnicodeNormalization;
    let selected = original("CLAUDE_CONFIG_DIR").map(Ok).unwrap_or_else(|| {
        home.join(".claude")
            .to_str()
            .map(str::to_owned)
            .ok_or("Claude original configuration directory is not UTF-8")
    })?;
    if selected.len() > 64 * 1024 || selected.chars().any(char::is_control) {
        return Err("Claude selected configuration directory profile is invalid".into());
    }
    let mut normalized = String::new();
    for character in selected.nfc() {
        if normalized.len() + character.len_utf8() > 64 * 1024 {
            return Err("Claude normalized configuration directory profile exceeded".into());
        }
        normalized.push(character);
    }
    let path = Path::new(&normalized);
    Ok(freshell_platform::opencode_config::lexical_path(
        &if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_provider_claude_config_root_keeps_native_cwd_empty_tilde_and_unicode_selection() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let selected = cwd.join("caf\u{e9}");
        for root in [
            &home.join(".claude"),
            &cwd,
            &selected,
            &cwd.join("~/literal"),
        ] {
            std::fs::create_dir_all(root).unwrap();
            std::fs::write(root.join("resource"), "native-selected-resource").unwrap();
        }
        for selector in [
            None,
            Some(""),
            Some("./caf\u{65}\u{301}"),
            Some("~/literal"),
        ] {
            let original = |_: &str| selector.map(str::to_string);
            let root = selected_config_root(&home, &cwd, &original).unwrap();
            assert_eq!(
                std::fs::read(root.join("resource")).unwrap(),
                b"native-selected-resource"
            );
            if selector == Some("") {
                assert_eq!(root, cwd);
            }
            if selector == Some("~/literal") {
                assert_eq!(root, cwd.join("~/literal"));
            }
        }
        let invalid = |_: &str| Some("bad\npath".into());
        assert!(selected_config_root(&home, &cwd, &invalid).is_err());
        let oversized = |_: &str| Some("a".repeat(64 * 1024 + 1));
        assert!(selected_config_root(&home, &cwd, &oversized).is_err());
    }
}

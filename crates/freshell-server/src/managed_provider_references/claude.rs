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

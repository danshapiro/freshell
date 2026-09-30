#![cfg(feature = "managed-runtime-v1")]

//! Ephemeral MCP grants for managed terminal incarnations.

use axum::{
    extract::State,
    http::{HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use freshell_runtime_protocol::{
    DesiredState, IncarnationId, LaunchState, McpCapabilityReference, ProviderConfigReference,
    ProviderConfigRoot, SoulId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CAPABILITY_PATH: &str = ".freshell/mcp-capability.json";
const GRANT_LIFETIME_SECS: u64 = 30 * 24 * 60 * 60;
const RENEWAL_WINDOW_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Copy, Default)]
pub(crate) struct OpencodeEphemeralInput<'a> {
    pub inline_config: Option<&'a str>,
    pub tui_config_path: Option<&'a str>,
    pub tui_source: Option<&'a ProviderConfigReference>,
    pub cwd: Option<&'a Path>,
    pub workspace: Option<&'a Path>,
}

#[derive(Clone)]
struct Grant {
    soul_id: SoulId,
    incarnation_id: Option<IncarnationId>,
    token: String,
    expires_at: u64,
    endpoint: String,
    path: PathBuf,
}

#[derive(Default)]
struct CapabilityStore {
    grants: Mutex<HashMap<String, Grant>>,
}

static STORE: OnceLock<CapabilityStore> = OnceLock::new();
static SETTINGS: OnceLock<CapabilitySettings> = OnceLock::new();

struct CapabilitySettings {
    directory: PathBuf,
    endpoint: String,
    callback_socket: PathBuf,
    control_secret: String,
}

fn store() -> &'static CapabilityStore {
    STORE.get_or_init(CapabilityStore::default)
}

fn capability_dir() -> Result<PathBuf, String> {
    SETTINGS
        .get()
        .map(|settings| settings.directory.clone())
        .ok_or("managed MCP controller is unconfigured".into())
}

fn endpoint() -> Result<String, String> {
    SETTINGS
        .get()
        .map(|settings| settings.endpoint.clone())
        .ok_or("managed MCP controller is unconfigured".into())
}

pub(crate) fn configure(
    bind_host: &str,
    port: u16,
    control_socket: &Path,
    control_secret_file: &Path,
) -> Result<(), String> {
    if bind_host != "0.0.0.0" || port == 0 {
        return Err("managed MCP requires a listener reachable from the soul".into());
    }
    let control_dir = control_socket
        .parent()
        .ok_or("managed runtime control socket has no directory")?;
    let control_secret = std::fs::read_to_string(control_secret_file)
        .map_err(|error| format!("managed runtime control secret: {error}"))?
        .trim()
        .to_string();
    if control_secret.len() < 16 {
        return Err("managed runtime control secret is too short".into());
    }
    let directory = std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| control_dir.join("mcp-capabilities"));
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    SETTINGS
        .set(CapabilitySettings {
            directory: std::fs::canonicalize(directory).map_err(|error| error.to_string())?,
            endpoint: format!("http://host.docker.internal:{port}"),
            callback_socket: control_dir.join("mcp.sock"),
            control_secret,
        })
        .map_err(|_| "managed MCP controller already configured".into())
}

pub(crate) async fn spawn_callback_server() -> Result<(), String> {
    let path = SETTINGS
        .get()
        .ok_or("managed MCP controller is unconfigured")?
        .callback_socket
        .clone();
    if path.exists() {
        if tokio::net::UnixStream::connect(&path).await.is_ok() {
            return Err("managed MCP callback socket is already active".into());
        }
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let listener = tokio::net::UnixListener::bind(&path).map_err(|error| error.to_string())?;
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let result = async {
                    (&mut socket)
                        .take(8192)
                        .read_to_end(&mut bytes)
                        .await
                        .map_err(|error| error.to_string())?;
                    let expected = &SETTINGS
                        .get()
                        .ok_or("managed MCP controller is unconfigured")?
                        .control_secret;
                    let home = std::env::var_os("HOME")
                        .map(PathBuf::from)
                        .ok_or("managed provider HOME is unavailable")?;
                    apply_callback(
                        &bytes,
                        expected,
                        store(),
                        &capability_dir()?,
                        &endpoint()?,
                        &home,
                    )
                }
                .await;
                match result {
                    Ok(response) => {
                        let _ = socket.write_all(&response).await;
                    }
                    Err(error) => {
                        let _ = socket.write_all(b"error").await;
                        tracing::warn!(error = %error, "managed_mcp.callback_failed");
                    }
                }
            });
        }
    });
    Ok(())
}

pub(crate) fn spawn_renewal_loop(client: freshell_runtime_client::RuntimeClient) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            match client.inventory().await {
                Ok(views) => {
                    let active = views
                        .into_iter()
                        .filter(|view| {
                            view.desired_state == DesiredState::Running
                                && view.launch_state == LaunchState::Running
                        })
                        .map(|view| (view.soul_id, view.incarnation_id))
                        .collect::<HashSet<_>>();
                    store().renew_active_at(now_secs(), &active);
                }
                Err(error) => {
                    tracing::warn!(error = %error, "managed_mcp.renewal_inventory_failed")
                }
            }
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityCallback {
    action: String,
    control_secret: String,
    soul_id: SoulId,
    incarnation_id: Option<IncarnationId>,
    grant_id: Option<String>,
    provider: Option<String>,
    tui_source: Option<ProviderConfigReference>,
    workspace: Option<PathBuf>,
}

fn apply_callback(
    bytes: &[u8],
    expected_control_secret: &str,
    store: &CapabilityStore,
    directory: &Path,
    endpoint: &str,
    home: &Path,
) -> Result<Vec<u8>, String> {
    let callback: CapabilityCallback =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if !freshell_api::check_auth(Some(&callback.control_secret), expected_control_secret) {
        return Err("managed runtime callback unauthorized".into());
    }
    match callback.action.as_str() {
        "issue" => {
            let provider = callback.provider.ok_or("missing managed MCP provider")?;
            let references = provider_source_references(&provider, home)?;
            let reference = store.issue_replacement(
                callback.soul_id,
                directory,
                endpoint.into(),
                Some((&provider, home, &references)),
                callback.tui_source.as_ref(),
                callback.workspace.as_deref(),
            )?;
            serde_json::to_vec(&reference).map_err(|error| error.to_string())
        }
        "activate" => {
            let grant_id = callback.grant_id.ok_or("missing managed MCP grant id")?;
            let incarnation_id = callback
                .incarnation_id
                .ok_or("missing managed MCP incarnation id")?;
            store.activate(
                &grant_id,
                callback.soul_id,
                incarnation_id,
                directory,
                endpoint,
            )?;
            Ok(b"ok".to_vec())
        }
        "revoke" => {
            let grant_id = callback.grant_id.ok_or("missing managed MCP grant id")?;
            store.revoke(&grant_id, directory)?;
            Ok(b"ok".to_vec())
        }
        _ => Err("unknown managed MCP callback action".into()),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn new_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn routed_host_ipv4() -> Option<String> {
    // A UDP connect chooses the web host's outward interface without sending
    // a packet. The supervisor may run without networking, so this address
    // travels with the non-secret capability reference for Docker rootless.
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:53").ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_loopback() && !address.is_unspecified()).then(|| address.to_string())
}

fn grant_path(directory: &Path, grant_id: &str) -> Result<PathBuf, String> {
    if !grant_id.starts_with("grant-")
        || grant_id.len() > 128
        || !grant_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid managed MCP grant id".into());
    }
    Ok(directory.join(format!("{grant_id}.json")))
}

fn provider_root_name(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok(".claude"),
        "codex" => Ok(".codex"),
        "opencode" => Ok(".config/opencode"),
        "amplifier" => Ok(".amplifier"),
        _ => Err("unapproved managed provider".into()),
    }
}

fn provider_source_references(
    provider: &str,
    home: &Path,
) -> Result<Vec<ProviderConfigReference>, String> {
    provider_root_name(provider)?;
    let context = crate::managed_provider_bootstrap::provider_launch_context_from_home(
        provider,
        Path::new("/"),
        home,
        None,
    )
    .ok_or("managed provider config selectors are unavailable")?;
    Ok(context.config)
}

pub(crate) fn approved_tui_source(
    raw_path: &str,
    cwd: &Path,
    workspace: &Path,
    home: &Path,
) -> Result<ProviderConfigReference, String> {
    let canonical_workspace = std::fs::canonicalize(workspace)
        .map_err(|_| "managed OpenCode workspace is unavailable")?;
    let canonical_cwd =
        std::fs::canonicalize(cwd).map_err(|_| "managed OpenCode cwd is unavailable")?;
    if !canonical_cwd.starts_with(&canonical_workspace) {
        return Err("managed OpenCode cwd escaped workspace".into());
    }
    let selected = Path::new(raw_path);
    let candidate = if selected.is_absolute() {
        selected.to_path_buf()
    } else {
        canonical_cwd.join(selected)
    };
    // Resolve the path the ordinary provider would open. Removing `..` first
    // changes its meaning when an earlier component is a symlink.
    let canonical_selected = std::fs::canonicalize(&candidate)
        .map_err(|_| "managed OpenCode TUI config is unavailable")?;
    if !canonical_selected.is_file() {
        return Err("managed OpenCode TUI config must be a file".into());
    }
    let provider_root = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("opencode");
    let canonical_provider_root = std::fs::canonicalize(&provider_root).ok();
    let (root, approved_root, selected_root) = if let Some(canonical_provider_root) =
        canonical_provider_root
            .as_ref()
            .filter(|root| canonical_selected.starts_with(root))
    {
        (
            ProviderConfigRoot::UserProvider,
            canonical_provider_root.as_path(),
            provider_root.as_path(),
        )
    } else if canonical_selected.starts_with(&canonical_workspace) {
        (
            ProviderConfigRoot::Workspace,
            canonical_workspace.as_path(),
            workspace,
        )
    } else {
        return Err("managed OpenCode TUI config escaped approved roots".into());
    };
    // Keep a clean root-relative symlink route so replacement follows the
    // same user selection. Paths containing `..` use their resolved target,
    // since durable references cannot safely encode parent components.
    let clean_relative = |path: &Path| {
        !path.as_os_str().is_empty()
            && path
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
    };
    let relative = candidate
        .strip_prefix(selected_root)
        .ok()
        .filter(|path| clean_relative(path))
        .or_else(|| {
            candidate
                .strip_prefix(approved_root)
                .ok()
                .filter(|path| clean_relative(path))
        })
        .unwrap_or_else(|| canonical_selected.strip_prefix(approved_root).unwrap());
    if !clean_relative(relative) {
        return Err("managed OpenCode TUI config escaped approved roots".into());
    }
    let format = if raw_path.to_ascii_lowercase().ends_with(".jsonc") {
        "jsonc"
    } else {
        "json"
    };
    Ok(ProviderConfigReference {
        root,
        relative_path: relative
            .to_str()
            .ok_or("managed OpenCode TUI path is invalid")?
            .replace(std::path::MAIN_SEPARATOR, "/"),
        provider_relative_path: format!(".freshell/opencode/user-tui.{format}"),
        format: format.into(),
    })
}

fn is_secret_component(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".credentials.json"
            | "auth.json"
            | "keys.env"
            | ".env"
            | "credentials"
            | "secrets"
            | "token.json"
    )
}

fn private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn copy_provider_source(
    root: &Path,
    source: &Path,
    destination: &Path,
    depth: usize,
    entries: &mut usize,
) -> Result<(), String> {
    if depth > 32 || *entries >= 4096 {
        return Err("managed provider config copy exceeds bounds".into());
    }
    *entries += 1;
    let Some(name) = source.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    if is_secret_component(name) {
        return Ok(());
    }
    let canonical = match std::fs::canonicalize(source) {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("managed provider config source: {error}")),
    };
    if !canonical.starts_with(root) {
        tracing::warn!("managed_mcp.provider_config_symlink_escape_skipped");
        return Ok(());
    }
    if canonical
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .components()
        .any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(is_secret_component)
        })
    {
        return Ok(());
    }
    let metadata = std::fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        private_directory(destination)?;
        for entry in std::fs::read_dir(&canonical).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_provider_source(
                root,
                &entry.path(),
                &destination.join(entry.file_name()),
                depth + 1,
                entries,
            )?;
        }
    } else if metadata.is_file() {
        if metadata.len() > 16 * 1024 * 1024 {
            return Err("managed provider config file exceeds bounds".into());
        }
        std::fs::copy(&canonical, destination).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn staged_provider_root_path(directory: &Path, grant_id: &str) -> Result<PathBuf, String> {
    grant_path(directory, grant_id)?;
    let control_dir = directory
        .parent()
        .ok_or("managed MCP capability directory has no parent")?;
    Ok(control_dir.join("provider-roots").join(grant_id))
}

fn recoverable_input_path(directory: &Path, soul_id: &SoulId) -> Result<PathBuf, String> {
    let control_dir = directory
        .parent()
        .ok_or("managed MCP capability directory has no parent")?;
    Ok(control_dir
        .join("provider-inputs")
        .join(format!("{:x}", Sha256::digest(soul_id.as_str().as_bytes()))))
}

fn retain_recoverable_inputs(
    directory: &Path,
    soul_id: &SoulId,
    grant_id: &str,
) -> Result<(), String> {
    let source = staged_provider_root_path(directory, grant_id)?.join("ephemeral");
    let source_is_durable = source.join("tui-source.json").is_file();
    let names = if source_is_durable {
        &["inline-config.json"][..]
    } else {
        &["inline-config.json", "tui-config.json", "tui-config.jsonc"][..]
    };
    if !names.iter().any(|name| source.join(name).is_file()) {
        return Ok(());
    }
    let destination = recoverable_input_path(directory, soul_id)?;
    if destination.is_dir() {
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or("managed provider inputs have no parent")?;
    private_directory(parent)?;
    let temporary = parent.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
    private_directory(&temporary)?;
    private_directory(&temporary.join("ephemeral"))?;
    let result = (|| {
        for &name in names {
            let path = source.join(name);
            if path.is_file() {
                copy_ephemeral_file(&path, &temporary.join("ephemeral").join(name))?;
            }
        }
        std::fs::rename(&temporary, &destination).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    } else {
        tracing::info!(
            soul_id = soul_id.as_str(),
            "managed_mcp.recoverable_inputs_retained"
        );
    }
    result
}

fn soul_wants_recovery(views: &[freshell_runtime_protocol::RuntimeView], soul_id: &SoulId) -> bool {
    views
        .iter()
        .any(|view| &view.soul_id == soul_id && view.desired_state == DesiredState::Running)
}

fn remove_recoverable_inputs(directory: &Path, soul_id: &SoulId) -> Result<(), String> {
    match std::fs::remove_dir_all(recoverable_input_path(directory, soul_id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn cleanup_unrecoverable_inputs(
    directory: &Path,
    views: &[freshell_runtime_protocol::RuntimeView],
) -> Result<(), String> {
    let parent = directory
        .parent()
        .ok_or("managed MCP capability directory has no parent")?
        .join("provider-inputs");
    if !parent.is_dir() {
        return Ok(());
    }
    let keep = views
        .iter()
        .filter(|view| view.desired_state == DesiredState::Running)
        .map(|view| recoverable_input_path(directory, &view.soul_id))
        .collect::<Result<HashSet<_>, _>>()?;
    for entry in std::fs::read_dir(&parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().is_dir() && !keep.contains(&entry.path()) {
            std::fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn cleanup_orphaned_provider_roots(directory: &Path) -> Result<(), String> {
    let staged_parent = directory
        .parent()
        .ok_or("managed MCP capability directory has no parent")?
        .join("provider-roots");
    if !staged_parent.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&staged_parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(grant_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(grant_file) = grant_path(directory, &grant_id) else {
            continue;
        };
        if !grant_file.exists() && entry.path().is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn stage_provider_root(
    directory: &Path,
    grant_id: &str,
    provider: &str,
    home: &Path,
    references: &[ProviderConfigReference],
    opencode_input: OpencodeEphemeralInput<'_>,
    prior_stage: Option<&Path>,
) -> Result<PathBuf, String> {
    let provider_dir = provider_root_name(provider)?;
    let staged = staged_provider_root_path(directory, grant_id)?;
    let parent = staged
        .parent()
        .ok_or("managed provider stage has no parent")?;
    private_directory(parent)?;
    let temporary = parent.join(format!("{grant_id}.tmp-{}", uuid::Uuid::new_v4()));
    private_directory(&temporary)?;
    let result = (|| {
        let (source, source_boundary) = if provider == "opencode" {
            let config_home = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"));
            (config_home.join("opencode"), config_home)
        } else {
            (home.join(provider_dir), home.to_path_buf())
        };
        let canonical_root = match std::fs::canonicalize(&source) {
            Ok(root) => {
                let canonical_boundary =
                    std::fs::canonicalize(&source_boundary).map_err(|error| error.to_string())?;
                if root.starts_with(&canonical_boundary) {
                    Some(root)
                } else {
                    return Err("managed provider root escaped its approved source root".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let mut entries = 0;
        for reference in references {
            if reference.root != ProviderConfigRoot::UserProvider
                || reference.relative_path.contains('/')
                || reference.relative_path.contains('\\')
                || reference.relative_path.is_empty()
                || reference.relative_path == "."
                || reference.relative_path == ".."
                || is_secret_component(&reference.relative_path)
                || reference.provider_relative_path
                    != format!("{provider_dir}/{}", reference.relative_path)
            {
                return Err("managed provider selector is unsafe".into());
            }
            let Some(root) = canonical_root.as_ref() else {
                return Err("referenced managed provider root is unavailable".into());
            };
            copy_provider_source(
                root,
                &source.join(&reference.relative_path),
                &temporary.join(&reference.relative_path),
                0,
                &mut entries,
            )?;
        }
        if provider == "opencode" {
            let ephemeral = temporary.join("ephemeral");
            private_directory(&ephemeral)?;
            if let Some(prior_stage) = prior_stage {
                for name in ["inline-config.json"] {
                    let source = prior_stage.join("ephemeral").join(name);
                    if source.is_file() {
                        copy_ephemeral_file(&source, &ephemeral.join(name))?;
                    }
                }
            } else {
                if let Some(raw) = opencode_input.inline_config {
                    if raw.len() > 64 * 1024
                        || freshell_platform::opencode_config::parse_jsonc_object(raw).is_none()
                    {
                        return Err("managed OpenCode inline config is invalid".into());
                    }
                    write_private_bytes(&ephemeral.join("inline-config.json"), raw.as_bytes())?;
                }
            }
            let selected_source = opencode_input.tui_source;
            let selected_source = if let Some(source) = selected_source {
                Some(source.clone())
            } else if let Some(raw_path) = opencode_input.tui_config_path {
                Some(approved_tui_source(
                    raw_path,
                    opencode_input
                        .cwd
                        .ok_or("managed OpenCode cwd is unavailable")?,
                    opencode_input
                        .workspace
                        .ok_or("managed OpenCode workspace is unavailable")?,
                    home,
                )?)
            } else {
                None
            };
            if let Some(reference) = selected_source.as_ref() {
                let workspace = opencode_input
                    .workspace
                    .ok_or("managed OpenCode workspace is unavailable")?;
                stage_tui_source(reference, workspace, home, &ephemeral)?;
                write_private_bytes(
                    &ephemeral.join("tui-source.json"),
                    &serde_json::to_vec(reference).map_err(|error| error.to_string())?,
                )?;
            } else if let Some(prior_stage) = prior_stage {
                // Existing launch rows from before typed source references keep
                // their previous staged selection until they are recreated.
                for name in ["tui-config.json", "tui-config.jsonc"] {
                    let source = prior_stage.join("ephemeral").join(name);
                    if source.is_file() {
                        copy_ephemeral_file(&source, &ephemeral.join(name))?;
                    }
                }
            }
        }
        std::fs::rename(&temporary, &staged).map_err(|error| error.to_string())?;
        Ok(staged.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
}

fn stage_tui_source(
    reference: &ProviderConfigReference,
    workspace: &Path,
    home: &Path,
    destination: &Path,
) -> Result<(), String> {
    if !matches!(
        reference.root,
        ProviderConfigRoot::Workspace | ProviderConfigRoot::UserProvider
    ) || !matches!(reference.format.as_str(), "json" | "jsonc")
        || reference.provider_relative_path
            != format!(".freshell/opencode/user-tui.{}", reference.format)
        || reference.relative_path.is_empty()
        || reference.relative_path.len() > 512
        || reference.relative_path.chars().any(char::is_control)
        || reference
            .relative_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || reference.relative_path.contains('\\')
    {
        return Err("managed OpenCode TUI source is unsafe".into());
    }
    let root = if reference.root == ProviderConfigRoot::Workspace {
        workspace.to_path_buf()
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("opencode")
    };
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|_| "managed OpenCode TUI source root is unavailable")?;
    let selected = std::fs::canonicalize(canonical_root.join(&reference.relative_path))
        .map_err(|_| "managed OpenCode TUI config is unavailable")?;
    if !selected.starts_with(&canonical_root) || !selected.is_file() {
        return Err("managed OpenCode TUI config escaped approved roots".into());
    }
    copy_ephemeral_file(
        &selected,
        &destination.join(format!("tui-config.{}", reference.format)),
    )
}

fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn copy_ephemeral_file(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("managed OpenCode config file is invalid".into());
    }
    let bytes = std::fs::read(source).map_err(|error| error.to_string())?;
    write_private_bytes(destination, &bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityFile<'a> {
    endpoint: &'a str,
    scope: &'a str,
    soul_id: &'a SoulId,
    incarnation_id: Option<&'a IncarnationId>,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCapabilityFile {
    endpoint: String,
    scope: String,
    soul_id: SoulId,
    incarnation_id: Option<IncarnationId>,
    expires_at: u64,
}

fn restored_grant_at(
    stored: StoredCapabilityFile,
    incarnation_id: IncarnationId,
    path: PathBuf,
    current_endpoint: &str,
    now: u64,
) -> Grant {
    let current = stored.endpoint == current_endpoint && !stored.scope.is_empty();
    Grant {
        soul_id: stored.soul_id,
        incarnation_id: Some(incarnation_id),
        token: if current { stored.scope } else { String::new() },
        expires_at: if current {
            stored
                .expires_at
                .max(now.saturating_add(GRANT_LIFETIME_SECS))
        } else {
            0
        },
        endpoint: stored.endpoint,
        path,
    }
}

fn restored_grant(
    stored: StoredCapabilityFile,
    incarnation_id: IncarnationId,
    path: PathBuf,
    current_endpoint: &str,
) -> Grant {
    restored_grant_at(stored, incarnation_id, path, current_endpoint, now_secs())
}

fn write_capability(path: &Path, grant: &Grant) -> Result<(), String> {
    let bytes = serde_json::to_vec(&CapabilityFile {
        endpoint: &grant.endpoint,
        scope: &grant.token,
        soul_id: &grant.soul_id,
        incarnation_id: grant.incarnation_id.as_ref(),
        expires_at: grant.expires_at,
    })
    .map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

impl CapabilityStore {
    fn renew_active_at(&self, now: u64, active: &HashSet<(SoulId, IncarnationId)>) {
        for grant in self.grants.lock().unwrap().values_mut() {
            if !grant.incarnation_id.as_ref().is_some_and(|incarnation| {
                active.contains(&(grant.soul_id.clone(), incarnation.clone()))
            }) || grant.token.is_empty()
                || grant.expires_at > now.saturating_add(RENEWAL_WINDOW_SECS)
            {
                continue;
            }
            let previous = grant.expires_at;
            grant.expires_at = now.saturating_add(GRANT_LIFETIME_SECS);
            if let Err(error) = write_capability(&grant.path, grant) {
                grant.expires_at = previous;
                tracing::warn!(error = %error, "managed_mcp.expiry_renewal_failed");
            }
        }
    }
    fn issue(
        &self,
        soul_id: SoulId,
        directory: &Path,
        endpoint: String,
        source: Option<(&str, &Path, &[ProviderConfigReference])>,
        opencode_input: OpencodeEphemeralInput<'_>,
        prior_stage: Option<&Path>,
    ) -> Result<McpCapabilityReference, String> {
        let grant_id = format!("grant-{}", uuid::Uuid::new_v4());
        let path = grant_path(directory, &grant_id)?;
        let staged_provider_root = source
            .map(|(provider, home, references)| {
                stage_provider_root(
                    directory,
                    &grant_id,
                    provider,
                    home,
                    references,
                    opencode_input,
                    prior_stage,
                )
            })
            .transpose()?;
        let grant = Grant {
            soul_id,
            incarnation_id: None,
            token: new_secret(),
            expires_at: now_secs() + GRANT_LIFETIME_SECS,
            endpoint: endpoint.clone(),
            path: path.clone(),
        };
        if let Err(error) = write_capability(&path, &grant) {
            if let Some(staged) = staged_provider_root {
                let _ = std::fs::remove_dir_all(staged);
            }
            return Err(error);
        }
        self.grants.lock().unwrap().insert(grant_id.clone(), grant);
        Ok(McpCapabilityReference {
            grant_id,
            endpoint,
            provider_relative_path: CAPABILITY_PATH.into(),
            host_gateway_address: routed_host_ipv4(),
        })
    }

    fn issue_replacement(
        &self,
        soul_id: SoulId,
        directory: &Path,
        endpoint: String,
        source: Option<(&str, &Path, &[ProviderConfigReference])>,
        tui_source: Option<&ProviderConfigReference>,
        workspace: Option<&Path>,
    ) -> Result<McpCapabilityReference, String> {
        let retained = recoverable_input_path(directory, &soul_id)?;
        let prior_stage = self
            .grants
            .lock()
            .unwrap()
            .iter()
            .find(|(_, grant)| grant.soul_id == soul_id)
            .map(|(grant_id, _)| staged_provider_root_path(directory, grant_id))
            .transpose()?
            .or_else(|| retained.is_dir().then_some(retained));
        let replacement = self.issue(
            soul_id.clone(),
            directory,
            endpoint,
            source,
            OpencodeEphemeralInput {
                tui_source,
                workspace,
                ..Default::default()
            },
            prior_stage.as_deref(),
        )?;
        let prior = self
            .grants
            .lock()
            .unwrap()
            .iter()
            .filter(|(grant_id, grant)| {
                **grant_id != replacement.grant_id && grant.soul_id == soul_id
            })
            .map(|(grant_id, _)| grant_id.clone())
            .collect::<Vec<_>>();
        for grant_id in prior {
            self.revoke(&grant_id, directory)?;
        }
        Ok(replacement)
    }

    fn activate(
        &self,
        grant_id: &str,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        directory: &Path,
        endpoint: &str,
    ) -> Result<(), String> {
        let path = grant_path(directory, grant_id)?;
        let mut grants = self.grants.lock().unwrap();
        if let Some(existing) = grants.get(grant_id) {
            if existing.soul_id != soul_id || existing.endpoint != endpoint {
                return Err("managed MCP grant identity mismatch".into());
            }
            if existing.incarnation_id.as_ref() == Some(&incarnation_id) {
                return Ok(());
            }
        }
        let grant = Grant {
            soul_id,
            incarnation_id: Some(incarnation_id),
            token: new_secret(),
            expires_at: now_secs() + GRANT_LIFETIME_SECS,
            endpoint: endpoint.into(),
            path: path.clone(),
        };
        write_capability(&path, &grant)?;
        grants.insert(grant_id.into(), grant);
        Ok(())
    }

    fn revoke(&self, grant_id: &str, directory: &Path) -> Result<(), String> {
        let path = grant_path(directory, grant_id)?;
        let staged = staged_provider_root_path(directory, grant_id)?;
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        match std::fs::remove_dir_all(staged) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }?;
        self.grants.lock().unwrap().remove(grant_id);
        Ok(())
    }

    fn authenticates(&self, token: &str) -> bool {
        self.grants.lock().unwrap().values().any(|grant| {
            freshell_api::check_scoped_auth(
                Some(token),
                &grant.token,
                grant.soul_id.as_str(),
                grant.incarnation_id.as_ref().map(IncarnationId::as_str),
                grant.expires_at,
                now_secs(),
            )
        })
    }
}

pub(crate) fn issue_mcp_capability(
    soul_id: &SoulId,
    provider: &str,
    opencode_input: OpencodeEphemeralInput<'_>,
) -> Result<McpCapabilityReference, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("managed provider HOME is unavailable")?;
    let references = provider_source_references(provider, &home)?;
    store().issue(
        soul_id.clone(),
        &capability_dir()?,
        endpoint()?,
        Some((provider, &home, &references)),
        opencode_input,
        None,
    )
}

/// A web-server restart restores only grants whose exact incarnation remains
/// live in the supervisor inventory. Recoverable souls retain their private
/// OpenCode inputs before stale scopes and incarnation stages are revoked.
pub(crate) async fn rehydrate_running_capabilities(
    client: &freshell_runtime_client::RuntimeClient,
) -> Result<(), String> {
    let views = client
        .inventory()
        .await
        .map_err(|error| error.to_string())?;
    let directory = capability_dir()?;
    for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let Some(grant_id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if path.extension().and_then(|extension| extension.to_str()) != Some("json")
            || grant_path(&capability_dir()?, &grant_id).is_err()
        {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .permissions()
                .mode()
                & 0o077
                != 0
            {
                continue;
            }
        }
        let Ok(file) = std::fs::read(&path) else {
            continue;
        };
        let Ok(stored) = serde_json::from_slice::<StoredCapabilityFile>(&file) else {
            continue;
        };
        let Some(incarnation_id) = stored.incarnation_id.clone() else {
            if soul_wants_recovery(&views, &stored.soul_id) {
                retain_recoverable_inputs(&directory, &stored.soul_id, &grant_id)?;
            }
            store().revoke(&grant_id, &directory)?;
            continue;
        };
        if !views.iter().any(|view| {
            view.soul_id == stored.soul_id
                && view.incarnation_id == incarnation_id
                && view.desired_state == DesiredState::Running
                && view.launch_state == LaunchState::Running
        }) {
            if soul_wants_recovery(&views, &stored.soul_id) {
                retain_recoverable_inputs(&directory, &stored.soul_id, &grant_id)?;
            }
            store().revoke(&grant_id, &directory)?;
            continue;
        }
        let grant = restored_grant(stored, incarnation_id, path, &endpoint()?);
        if !grant.token.is_empty() {
            write_capability(&grant.path, &grant)?;
        }
        store()
            .grants
            .lock()
            .unwrap()
            .insert(grant_id.clone(), grant);
    }
    cleanup_orphaned_provider_roots(&directory)?;
    cleanup_unrecoverable_inputs(&directory, &views)?;
    Ok(())
}

pub(crate) fn revoke_mcp_capability(grant_id: &str) -> Result<(), String> {
    store().revoke(grant_id, &capability_dir()?)
}

pub(crate) fn revoke_soul_capabilities(soul_id: &SoulId) -> Result<(), String> {
    let grant_ids = store()
        .grants
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, grant)| &grant.soul_id == soul_id)
        .map(|(grant_id, _)| grant_id.clone())
        .collect::<Vec<_>>();
    let directory = capability_dir()?;
    for grant_id in grant_ids {
        store().revoke(&grant_id, &directory)?;
    }
    remove_recoverable_inputs(&directory, soul_id)
}

/// Existing API handlers retain their ordinary auth gate; a validated managed
/// scope is translated only in request memory and never persisted.
pub(crate) async fn scoped_auth_middleware(
    State(web_token): State<Arc<String>>,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if request.uri().path().starts_with("/api/") {
        if let Some(scope) = request
            .headers()
            .get("x-auth-token")
            .and_then(|value| value.to_str().ok())
        {
            if store().authenticates(scope) {
                if let Ok(value) = HeaderValue::from_str(&web_token) {
                    request.headers_mut().insert("x-auth-token", value);
                }
            }
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_mcp_stages_only_approved_provider_config() {
        use freshell_runtime_protocol::{ProviderConfigReference, ProviderConfigRoot};
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let source = home.path().join(".claude");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::write(source.join("settings.json"), "current setting").unwrap();
        std::fs::write(source.join("plugins/plugin.txt"), "current plugin").unwrap();
        std::fs::write(source.join("plugins/auth.json"), "secret").unwrap();
        std::fs::write(source.join("auth.json"), "top-level secret").unwrap();
        let outside = home.path().join("outside.txt");
        std::fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink("plugin.txt", source.join("plugins/inside.txt")).unwrap();
        std::os::unix::fs::symlink("../auth.json", source.join("plugins/alias-secret.json"))
            .unwrap();
        std::os::unix::fs::symlink(&outside, source.join("plugins/outside.txt")).unwrap();
        let refs = ["settings.json", "plugins"].map(|name| ProviderConfigReference {
            root: ProviderConfigRoot::UserProvider,
            relative_path: name.into(),
            provider_relative_path: format!(".claude/{name}"),
            format: if name == "plugins" {
                "directory"
            } else {
                "json"
            }
            .into(),
        });
        let staged = stage_provider_root(
            &capabilities,
            "grant-test",
            "claude",
            home.path(),
            &refs,
            OpencodeEphemeralInput::default(),
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(staged.join("settings.json")).unwrap(),
            "current setting"
        );
        assert_eq!(
            std::fs::read_to_string(staged.join("plugins/inside.txt")).unwrap(),
            "current plugin"
        );
        assert!(!staged.join("plugins/auth.json").exists());
        assert!(!staged.join("plugins/alias-secret.json").exists());
        assert!(!staged.join("plugins/outside.txt").exists());
        let store = CapabilityStore::default();
        let reference = store
            .issue(
                SoulId::new(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("claude", home.path(), &refs)),
                OpencodeEphemeralInput::default(),
                None,
            )
            .unwrap();
        let issued_stage = staged_provider_root_path(&capabilities, &reference.grant_id).unwrap();
        assert!(issued_stage.join("settings.json").is_file());
        store.revoke(&reference.grant_id, &capabilities).unwrap();
        assert!(!issued_stage.exists());
        assert!(!grant_path(&capabilities, &reference.grant_id)
            .unwrap()
            .exists());
    }

    #[test]
    fn managed_mcp_restart_prunes_only_orphaned_provider_stages() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let active = staged_provider_root_path(&capabilities, "grant-active").unwrap();
        let orphan = staged_provider_root_path(&capabilities, "grant-orphan").unwrap();
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(
            grant_path(&capabilities, "grant-active").unwrap(),
            "running grant",
        )
        .unwrap();
        cleanup_orphaned_provider_roots(&capabilities).unwrap();
        assert!(active.is_dir());
        assert!(!orphan.exists());
    }

    #[test]
    fn managed_mcp_restart_indexes_old_endpoint_for_stop_without_reauthorizing_it() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let stage = staged_provider_root_path(&capabilities, "grant-old").unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        let grant_file = grant_path(&capabilities, "grant-old").unwrap();
        std::fs::write(&grant_file, "old grant file").unwrap();
        let stored = StoredCapabilityFile {
            endpoint: "http://host.docker.internal:3001".into(),
            scope: "old-scope".into(),
            soul_id: SoulId::new(),
            incarnation_id: None,
            expires_at: now_secs() + GRANT_LIFETIME_SECS,
        };
        let soul = stored.soul_id.clone();
        let store = CapabilityStore::default();
        store.grants.lock().unwrap().insert(
            "grant-old".into(),
            restored_grant(
                stored,
                IncarnationId::new(),
                grant_file.clone(),
                "http://host.docker.internal:4001",
            ),
        );
        assert!(!store.authenticates("old-scope"));
        let old = store
            .grants
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, grant)| grant.soul_id == soul)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in old {
            store.revoke(&id, &capabilities).unwrap();
        }
        assert!(!grant_file.exists());
        assert!(!stage.exists());
    }

    #[test]
    fn idle_grant_renews_without_calls_and_restart_rehydrates_expired_scope() {
        let dir = tempfile::tempdir().unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let incarnation = IncarnationId::new();
        let reference = store
            .issue(
                soul.clone(),
                dir.path(),
                "http://host.docker.internal:4000".into(),
                None,
                OpencodeEphemeralInput::default(),
                None,
            )
            .unwrap();
        store
            .activate(
                &reference.grant_id,
                soul.clone(),
                incarnation.clone(),
                dir.path(),
                &reference.endpoint,
            )
            .unwrap();
        let path = grant_path(dir.path(), &reference.grant_id).unwrap();
        let initial: StoredCapabilityFile =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let due = initial.expires_at - RENEWAL_WINDOW_SECS + 1;
        let active = HashSet::from([(soul.clone(), incarnation.clone())]);
        store.renew_active_at(due, &HashSet::new());
        let still_initial: StoredCapabilityFile =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(still_initial.expires_at, initial.expires_at);
        store.renew_active_at(due, &active);
        let renewed: StoredCapabilityFile =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(renewed.scope, initial.scope);
        assert!(renewed.expires_at > initial.expires_at);
        assert!(freshell_api::check_scoped_auth(
            Some(&renewed.scope),
            &renewed.scope,
            soul.as_str(),
            Some(incarnation.as_str()),
            renewed.expires_at,
            initial.expires_at + 1,
        ));
        let after_idle = restored_grant_at(
            StoredCapabilityFile {
                expires_at: initial.expires_at - 1,
                ..renewed
            },
            incarnation.clone(),
            path.clone(),
            &reference.endpoint,
            initial.expires_at + 1,
        );
        assert_eq!(after_idle.token, initial.scope);
        assert!(after_idle.expires_at > initial.expires_at + 1);
        assert!(!freshell_api::check_scoped_auth(
            Some(&initial.scope),
            &initial.scope,
            soul.as_str(),
            Some(incarnation.as_str()),
            initial.expires_at - 1,
            initial.expires_at + 1,
        ));
        assert!(freshell_api::check_scoped_auth(
            Some(&after_idle.token),
            &after_idle.token,
            soul.as_str(),
            Some(incarnation.as_str()),
            after_idle.expires_at,
            initial.expires_at + 1,
        ));
        write_capability(&path, &after_idle).unwrap();
        let reopened = CapabilityStore::default();
        reopened
            .grants
            .lock()
            .unwrap()
            .insert(reference.grant_id.clone(), after_idle);
        assert!(reopened.authenticates(&initial.scope));
        store.revoke(&reference.grant_id, dir.path()).unwrap();
        reopened.grants.lock().unwrap().remove(&reference.grant_id);
        assert!(!reopened.authenticates(&initial.scope));
    }

    #[test]
    fn opencode_private_stage_survives_reissue_without_durable_secret_bytes() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let tui = home.path().join("selected-tui.jsonc");
        std::fs::write(&tui, "{ // selected\n\"plugin\":[\"user-selected-tui\"]}").unwrap();
        let raw = "{ // user inline JSONC\n\"mcp\":{\"vendor\":{\"type\":\"local\",\"command\":[\"tool\",\"--token\",\"nested-secret-byte\",],},},}";
        let tui_source = approved_tui_source(
            "./selected-tui.jsonc",
            home.path(),
            home.path(),
            home.path(),
        )
        .unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let first = store
            .issue(
                soul.clone(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                OpencodeEphemeralInput {
                    inline_config: Some(raw),
                    tui_config_path: Some("./selected-tui.jsonc"),
                    tui_source: Some(&tui_source),
                    cwd: Some(home.path()),
                    workspace: Some(home.path()),
                },
                None,
            )
            .unwrap();
        let first_stage = staged_provider_root_path(&capabilities, &first.grant_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(first_stage.join("ephemeral/inline-config.json")).unwrap(),
            raw
        );
        assert_eq!(
            std::fs::read_to_string(first_stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            "{ // selected\n\"plugin\":[\"user-selected-tui\"]}"
        );
        std::fs::write(&tui, "{ // edited\n\"plugin\":[\"new-tui\"]}").unwrap();
        let second = store
            .issue_replacement(
                soul,
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                Some(&tui_source),
                Some(home.path()),
            )
            .unwrap();
        let second_stage = staged_provider_root_path(&capabilities, &second.grant_id).unwrap();
        assert!(!first_stage.exists());
        assert_eq!(
            std::fs::read_to_string(second_stage.join("ephemeral/inline-config.json")).unwrap(),
            raw
        );
        assert_eq!(
            std::fs::read_to_string(second_stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            "{ // edited\n\"plugin\":[\"new-tui\"]}"
        );
        assert!(!serde_json::to_string(&second)
            .unwrap()
            .contains("nested-secret-byte"));
    }

    #[test]
    fn opencode_private_inputs_survive_restarting_after_container_exits() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let tui = home.path().join("selected-tui.jsonc");
        std::fs::write(&tui, "{ // selected\n\"theme\":\"dark\" }").unwrap();
        let raw = r#"{"mcp":{"vendor":{"command":["tool","nested-secret-byte"]}}}"#;
        let tui_source = approved_tui_source(
            "./selected-tui.jsonc",
            home.path(),
            home.path(),
            home.path(),
        )
        .unwrap();
        let soul = SoulId::new();
        let running = CapabilityStore::default();
        let first = running
            .issue(
                soul.clone(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                OpencodeEphemeralInput {
                    inline_config: Some(raw),
                    tui_config_path: Some("./selected-tui.jsonc"),
                    tui_source: Some(&tui_source),
                    cwd: Some(home.path()),
                    workspace: Some(home.path()),
                },
                None,
            )
            .unwrap();
        // Startup has no in-memory grant for this stopped incarnation. Preserve
        // the private inputs before revoking its scope and stage.
        let restarted = CapabilityStore::default();
        retain_recoverable_inputs(&capabilities, &soul, &first.grant_id).unwrap();
        let retained = recoverable_input_path(&capabilities, &soul).unwrap();
        assert!(retained.join("ephemeral/inline-config.json").is_file());
        assert!(!retained.join("ephemeral/tui-config.jsonc").exists());
        std::fs::write(&tui, "{ // edited\n\"theme\":\"light\" }").unwrap();
        restarted.revoke(&first.grant_id, &capabilities).unwrap();
        let second = restarted
            .issue_replacement(
                soul.clone(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                Some(&tui_source),
                Some(home.path()),
            )
            .unwrap();
        let stage = staged_provider_root_path(&capabilities, &second.grant_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(stage.join("ephemeral/inline-config.json")).unwrap(),
            raw
        );
        assert_eq!(
            std::fs::read_to_string(stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            "{ // edited\n\"theme\":\"light\" }"
        );
        assert!(!grant_path(&capabilities, &first.grant_id).unwrap().exists());
        assert!(!staged_provider_root_path(&capabilities, &first.grant_id)
            .unwrap()
            .exists());
        remove_recoverable_inputs(&capabilities, &soul).unwrap();
        assert!(!recoverable_input_path(&capabilities, &soul)
            .unwrap()
            .exists());
    }

    #[test]
    fn opencode_relative_tui_selection_rejects_workspace_escape() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let allowed = workspace.path().join("allowed.json");
        std::fs::write(&allowed, "{\"theme\":\"allowed\"}").unwrap();
        std::fs::write(outside.path().join("tui.jsonc"), "{}").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("tui.jsonc"),
            workspace.path().join("link.jsonc"),
        )
        .unwrap();
        let store = CapabilityStore::default();
        let absolute = store
            .issue(
                SoulId::new(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", workspace.path(), &[])),
                OpencodeEphemeralInput {
                    tui_config_path: Some(allowed.to_str().unwrap()),
                    cwd: Some(workspace.path()),
                    workspace: Some(workspace.path()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(
                staged_provider_root_path(&capabilities, &absolute.grant_id)
                    .unwrap()
                    .join("ephemeral/tui-config.json")
            )
            .unwrap(),
            "{\"theme\":\"allowed\"}"
        );
        for selected in [
            "./link.jsonc",
            outside.path().join("tui.jsonc").to_str().unwrap(),
        ] {
            let result = store.issue(
                SoulId::new(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", workspace.path(), &[])),
                OpencodeEphemeralInput {
                    tui_config_path: Some(selected),
                    cwd: Some(workspace.path()),
                    workspace: Some(workspace.path()),
                    ..Default::default()
                },
                None,
            );
            assert!(result.unwrap_err().contains("escaped approved roots"));
        }
    }

    #[test]
    fn opencode_provider_home_tui_source_is_approved_and_reread_safely() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let provider_root = home.path().join(".config/opencode");
        std::fs::create_dir_all(&provider_root).unwrap();
        let tui = provider_root.join("tui.jsonc");
        std::fs::write(&tui, "{ // home\n\"theme\":\"dark\" }").unwrap();
        let source = approved_tui_source(
            tui.to_str().unwrap(),
            workspace.path(),
            workspace.path(),
            home.path(),
        )
        .unwrap();
        assert_eq!(source.root, ProviderConfigRoot::UserProvider);
        assert_eq!(source.relative_path, "tui.jsonc");
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let first = store
            .issue(
                soul.clone(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                OpencodeEphemeralInput {
                    tui_source: Some(&source),
                    workspace: Some(workspace.path()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let first_stage = staged_provider_root_path(&capabilities, &first.grant_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(first_stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            "{ // home\n\"theme\":\"dark\" }"
        );
        std::fs::write(&tui, "{ // home edited\n\"theme\":\"light\" }").unwrap();
        let second = store
            .issue_replacement(
                soul,
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                Some(&source),
                Some(workspace.path()),
            )
            .unwrap();
        let second_stage = staged_provider_root_path(&capabilities, &second.grant_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(second_stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            "{ // home edited\n\"theme\":\"light\" }"
        );
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("tui.jsonc"), "{}").unwrap();
        std::fs::remove_file(&tui).unwrap();
        std::os::unix::fs::symlink(outside.path().join("tui.jsonc"), &tui).unwrap();
        assert!(store
            .issue_replacement(
                SoulId::new(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                Some(&source),
                Some(workspace.path()),
            )
            .unwrap_err()
            .contains("escaped approved roots"));
    }

    #[test]
    fn opencode_symlinked_provider_home_tui_source_matches_ordinary_and_replacement() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config_home = home.path().join(".config");
        let first_root = config_home.join("opencode-first");
        let second_root = config_home.join("opencode-second");
        std::fs::create_dir_all(&first_root).unwrap();
        std::fs::create_dir_all(&second_root).unwrap();
        let provider_root = config_home.join("opencode");
        std::os::unix::fs::symlink(&first_root, &provider_root).unwrap();
        std::fs::write(first_root.join("tui.jsonc"), "{\"theme\":\"first\"}").unwrap();
        std::fs::write(second_root.join("tui.jsonc"), "{\"theme\":\"second\"}").unwrap();
        let selected = provider_root.join("tui.jsonc");
        let source = approved_tui_source(
            selected.to_str().unwrap(),
            workspace.path(),
            workspace.path(),
            home.path(),
        )
        .unwrap();
        assert_eq!(source.root, ProviderConfigRoot::UserProvider);
        assert_eq!(source.relative_path, "tui.jsonc");

        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let first = store
            .issue(
                soul.clone(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                OpencodeEphemeralInput {
                    tui_source: Some(&source),
                    workspace: Some(workspace.path()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let first_stage = staged_provider_root_path(&capabilities, &first.grant_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(first_stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            std::fs::read_to_string(&selected).unwrap()
        );

        std::fs::remove_file(&provider_root).unwrap();
        std::os::unix::fs::symlink(&second_root, &provider_root).unwrap();
        let second = store
            .issue_replacement(
                soul,
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", home.path(), &[])),
                Some(&source),
                Some(workspace.path()),
            )
            .unwrap();
        let second_stage = staged_provider_root_path(&capabilities, &second.grant_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(second_stage.join("ephemeral/tui-config.jsonc")).unwrap(),
            std::fs::read_to_string(&selected).unwrap()
        );
    }

    #[test]
    fn opencode_tui_source_rejects_symlink_then_parent_escape() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("branch")).unwrap();
        std::fs::write(
            workspace.path().join("safe.jsonc"),
            "{\"theme\":\"inside\"}",
        )
        .unwrap();
        std::fs::write(outside.path().join("safe.jsonc"), "{\"theme\":\"outside\"}").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("branch"),
            workspace.path().join("alias"),
        )
        .unwrap();

        let result = approved_tui_source(
            "alias/../safe.jsonc",
            workspace.path(),
            workspace.path(),
            home.path(),
        );
        assert!(result.unwrap_err().contains("escaped approved roots"));
    }

    #[test]
    fn managed_mcp_grant_is_private_scoped_rotated_and_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let soul = SoulId::new();
        let incarnation_one = IncarnationId::new();
        let incarnation_two = IncarnationId::new();
        let store = CapabilityStore::default();
        let reference = store
            .issue(
                soul.clone(),
                dir.path(),
                "http://host.docker.internal:4000".into(),
                None,
                OpencodeEphemeralInput::default(),
                None,
            )
            .unwrap();
        let path = grant_path(dir.path(), &reference.grant_id).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let first: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!store.authenticates(first["scope"].as_str().unwrap()));
        assert!(!serde_json::to_string(&reference)
            .unwrap()
            .contains(first["scope"].as_str().unwrap()));
        store
            .activate(
                &reference.grant_id,
                soul.clone(),
                incarnation_one,
                dir.path(),
                &reference.endpoint,
            )
            .unwrap();
        let active: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(store.authenticates(active["scope"].as_str().unwrap()));
        store
            .activate(
                &reference.grant_id,
                soul.clone(),
                incarnation_two,
                dir.path(),
                &reference.endpoint,
            )
            .unwrap();
        let replacement: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!store.authenticates(active["scope"].as_str().unwrap()));
        assert!(store.authenticates(replacement["scope"].as_str().unwrap()));
        store
            .grants
            .lock()
            .unwrap()
            .get_mut(&reference.grant_id)
            .unwrap()
            .expires_at = now_secs() + 1;
        assert!(store.authenticates(replacement["scope"].as_str().unwrap()));
        let active_incarnation = store
            .grants
            .lock()
            .unwrap()
            .get(&reference.grant_id)
            .unwrap()
            .incarnation_id
            .clone()
            .unwrap();
        store.renew_active_at(
            now_secs(),
            &HashSet::from([(soul.clone(), active_incarnation)]),
        );
        let renewed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(renewed["expiresAt"].as_u64().unwrap() > now_secs() + 7 * 24 * 60 * 60);
        store
            .grants
            .lock()
            .unwrap()
            .get_mut(&reference.grant_id)
            .unwrap()
            .expires_at = 0;
        assert!(!store.authenticates(replacement["scope"].as_str().unwrap()));
        store.revoke(&reference.grant_id, dir.path()).unwrap();
        assert!(!path.exists());
        assert!(!store.authenticates(replacement["scope"].as_str().unwrap()));
    }

    #[test]
    fn managed_mcp_callback_requires_control_secret_and_binds_exact_soul() {
        let dir = tempfile::tempdir().unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let other_soul = SoulId::new();
        let incarnation = IncarnationId::new();
        let reference = store
            .issue(
                soul.clone(),
                dir.path(),
                "http://host.docker.internal:4000".into(),
                None,
                OpencodeEphemeralInput::default(),
                None,
            )
            .unwrap();
        let callback = |secret: &str, soul: &SoulId| {
            serde_json::to_vec(&serde_json::json!({
                "action": "activate", "controlSecret": secret, "soulId": soul,
                "incarnationId": incarnation, "grantId": reference.grant_id,
            }))
            .unwrap()
        };
        assert!(apply_callback(
            &callback("wrong", &soul),
            "right",
            &store,
            dir.path(),
            &reference.endpoint,
            dir.path(),
        )
        .is_err());
        assert!(apply_callback(
            &callback("right", &other_soul),
            "right",
            &store,
            dir.path(),
            &reference.endpoint,
            dir.path(),
        )
        .is_err());
        apply_callback(
            &callback("right", &soul),
            "right",
            &store,
            dir.path(),
            &reference.endpoint,
            dir.path(),
        )
        .unwrap();
        let path = grant_path(dir.path(), &reference.grant_id).unwrap();
        let active: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(store.authenticates(active["scope"].as_str().unwrap()));
        let issue = serde_json::to_vec(&serde_json::json!({
            "action": "issue", "controlSecret": "right", "soulId": soul, "provider": "claude",
        }))
        .unwrap();
        let replacement: McpCapabilityReference = serde_json::from_slice(
            &apply_callback(
                &issue,
                "right",
                &store,
                dir.path(),
                "http://host.docker.internal:4001",
                dir.path(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_ne!(replacement.grant_id, reference.grant_id);
        assert_eq!(replacement.endpoint, "http://host.docker.internal:4001");
        assert!(!path.exists());
        assert!(!store.authenticates(active["scope"].as_str().unwrap()));
    }

    #[tokio::test]
    async fn managed_mcp_unix_callback_activates_before_provider_start() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let secret_file = dir.path().join("secret");
        let secret = "managed-control-secret-for-test";
        std::fs::write(&secret_file, secret).unwrap();
        configure("0.0.0.0", 4001, &socket, &secret_file).unwrap();
        spawn_callback_server().await.unwrap();
        let soul = SoulId::new();
        let incarnation = IncarnationId::new();
        let reference = store()
            .issue(
                soul.clone(),
                &capability_dir().unwrap(),
                endpoint().unwrap(),
                None,
                OpencodeEphemeralInput::default(),
                None,
            )
            .unwrap();
        let body = serde_json::to_vec(&serde_json::json!({
            "action": "activate", "controlSecret": secret, "soulId": soul,
            "incarnationId": incarnation, "grantId": reference.grant_id,
        }))
        .unwrap();
        let mut stream = tokio::net::UnixStream::connect(socket.with_file_name("mcp.sock"))
            .await
            .unwrap();
        stream.write_all(&body).await.unwrap();
        stream.shutdown().await.unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await.unwrap();
        assert_eq!(reply, b"ok");
        let path = grant_path(&capability_dir().unwrap(), &reference.grant_id).unwrap();
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(store().authenticates(file["scope"].as_str().unwrap()));
    }
}

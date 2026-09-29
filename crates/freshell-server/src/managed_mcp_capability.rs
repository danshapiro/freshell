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
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CAPABILITY_PATH: &str = ".freshell/mcp-capability.json";
const GRANT_LIFETIME_SECS: u64 = 30 * 24 * 60 * 60;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityCallback {
    action: String,
    control_secret: String,
    soul_id: SoulId,
    incarnation_id: Option<IncarnationId>,
    grant_id: Option<String>,
    provider: Option<String>,
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
        let source = home.join(provider_dir);
        let canonical_home = std::fs::canonicalize(home).map_err(|error| error.to_string())?;
        let canonical_root = match std::fs::canonicalize(&source) {
            Ok(root) if root.starts_with(&canonical_home) => Some(root),
            Ok(_) => return Err("managed provider root escaped HOME".into()),
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
        std::fs::rename(&temporary, &staged).map_err(|error| error.to_string())?;
        Ok(staged.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
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

fn restored_grant(
    stored: StoredCapabilityFile,
    incarnation_id: IncarnationId,
    path: PathBuf,
    current_endpoint: &str,
) -> Grant {
    let current = stored.endpoint == current_endpoint && stored.expires_at > now_secs();
    Grant {
        soul_id: stored.soul_id,
        incarnation_id: Some(incarnation_id),
        token: if current { stored.scope } else { String::new() },
        expires_at: if current { stored.expires_at } else { 0 },
        endpoint: stored.endpoint,
        path,
    }
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
    fn issue(
        &self,
        soul_id: SoulId,
        directory: &Path,
        endpoint: String,
        source: Option<(&str, &Path, &[ProviderConfigReference])>,
    ) -> Result<McpCapabilityReference, String> {
        let grant_id = format!("grant-{}", uuid::Uuid::new_v4());
        let path = grant_path(directory, &grant_id)?;
        let staged_provider_root = source
            .map(|(provider, home, references)| {
                stage_provider_root(directory, &grant_id, provider, home, references)
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
    ) -> Result<McpCapabilityReference, String> {
        let replacement = self.issue(soul_id.clone(), directory, endpoint, source)?;
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
        self.grants.lock().unwrap().values_mut().any(|grant| {
            if freshell_api::check_scoped_auth(
                Some(token),
                &grant.token,
                grant.soul_id.as_str(),
                grant.incarnation_id.as_ref().map(IncarnationId::as_str),
                grant.expires_at,
                now_secs(),
            ) {
                if grant.expires_at <= now_secs() + 7 * 24 * 60 * 60 {
                    let renewed = now_secs() + GRANT_LIFETIME_SECS;
                    let previous = grant.expires_at;
                    grant.expires_at = renewed;
                    if let Err(error) = write_capability(&grant.path, grant) {
                        grant.expires_at = previous;
                        tracing::warn!(error = %error, "managed_mcp.expiry_renewal_failed");
                    }
                }
                true
            } else {
                false
            }
        })
    }
}

pub(crate) fn issue_mcp_capability(
    soul_id: &SoulId,
    provider: &str,
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
    )
}

/// A web-server restart restores only grants whose exact incarnation remains
/// live in the supervisor inventory. The private file is the transient scope
/// source; no scope bytes enter the durable launch record.
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
            store().revoke(&grant_id, &directory)?;
            continue;
        };
        if !views.iter().any(|view| {
            view.soul_id == stored.soul_id
                && view.incarnation_id == incarnation_id
                && view.desired_state == DesiredState::Running
                && view.launch_state == LaunchState::Running
        }) {
            store().revoke(&grant_id, &directory)?;
            continue;
        }
        store().grants.lock().unwrap().insert(
            grant_id.clone(),
            restored_grant(stored, incarnation_id, path, &endpoint()?),
        );
    }
    cleanup_orphaned_provider_roots(&directory)?;
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
    if grant_ids.is_empty() {
        return Ok(());
    }
    let directory = capability_dir()?;
    for grant_id in grant_ids {
        store().revoke(&grant_id, &directory)?;
    }
    Ok(())
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
        let staged =
            stage_provider_root(&capabilities, "grant-test", "claude", home.path(), &refs).unwrap();
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

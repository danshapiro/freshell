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
mod amplifier_resources;
mod claude_memory;
mod claude_stage;
mod ordinary_stage;
mod source_stage;

#[derive(Clone, Copy, Default)]
pub(crate) struct OpencodeEphemeralInput<'a> {
    pub codex_manifest: Option<&'a freshell_platform::codex_inputs::CodexInputManifest>,
    pub claude_manifest: Option<&'a freshell_platform::claude_inputs::ClaudeInputManifest>,
    pub inline_config: Option<&'a str>,
    pub tui_config_path: Option<&'a str>,
    pub tui_source: Option<&'a ProviderConfigReference>,
    pub cwd: Option<&'a Path>,
    pub workspace: Option<&'a Path>,
    pub source_plan:
        Option<&'a [crate::managed_provider_references::sources::PlannedSourceOccurrence]>,
    pub resource_roots: Option<&'a [freshell_platform::opencode_recipe::DiscoveryRoot]>,
    pub initial_auth_reservation: Option<&'a str>,
    pub secret_references: Option<&'a [freshell_runtime_protocol::ProviderSecretReference]>,
    pub config_root: Option<&'a Path>,
    pub launch_context: Option<&'a freshell_runtime_protocol::ProviderLaunchContext>,
    pub frozen_inputs: Option<&'a [String]>,
    pub native_source_flags: Option<&'a [freshell_platform::opencode_recipe::NativeSourceFlag]>,
    pub rebind_enabled: Option<bool>,
    pub inline_edits: Option<&'a freshell_platform::opencode_config::OwnedConfigEdits>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum InputPreparationPhase {
    Pending,
    Bound,
    Committed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputPreparation {
    phase: InputPreparationPhase,
    prior_grant_ids: Vec<String>,
}

#[derive(Clone)]
struct Grant {
    soul_id: SoulId,
    incarnation_id: Option<IncarnationId>,
    token: String,
    expires_at: u64,
    endpoint: String,
    path: PathBuf,
    preparation: Option<InputPreparation>,
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
    control_socket: PathBuf,
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
            control_socket: control_socket.to_owned(),
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
                        .take((freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES + 1) as u64)
                        .read_to_end(&mut bytes)
                        .await
                        .map_err(|error| error.to_string())?;
                    if bytes.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
                        return Err("managed provider callback exceeds metadata limit".into());
                    }
                    let expected = &SETTINGS
                        .get()
                        .ok_or("managed MCP controller is unconfigured")?
                        .control_secret;
                    let home = std::env::var_os("HOME")
                        .map(PathBuf::from)
                        .ok_or("managed provider HOME is unavailable")?;
                    let client = freshell_runtime_client::RuntimeClient::new(
                        SETTINGS.get().unwrap().control_socket.clone(),
                        expected.clone(),
                    );
                    apply_prepared_callback(
                        &bytes,
                        expected,
                        store(),
                        &capability_dir()?,
                        &endpoint()?,
                        &home,
                        &client,
                    )
                    .await
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
    auth_lookup_authority: Option<String>,
    cwd: Option<PathBuf>,
    provider_secret_references: Option<Vec<freshell_runtime_protocol::ProviderSecretReference>>,
    prior_context: Option<freshell_runtime_protocol::ProviderLaunchContext>,
    #[serde(default)]
    provider_path_inputs: Option<freshell_runtime_protocol::ProviderPathInputs>,
}

async fn apply_prepared_callback(
    bytes: &[u8],
    expected: &str,
    store: &CapabilityStore,
    directory: &Path,
    endpoint: &str,
    home: &Path,
    client: &freshell_runtime_client::RuntimeClient,
) -> Result<Vec<u8>, String> {
    let callback: CapabilityCallback = serde_json::from_slice(bytes)
        .map_err(|_| "managed provider callback metadata is invalid")?;
    if !freshell_api::check_auth(Some(&callback.control_secret), expected) {
        return Err("managed runtime callback unauthorized".into());
    }
    if callback.action != "issue" {
        return apply_callback(bytes, expected, store, directory, endpoint, home);
    }
    let provider = callback
        .provider
        .as_deref()
        .ok_or("missing managed MCP provider")?;
    if let Some(reply) = store.pending_prepared_context(
        &callback.soul_id,
        directory,
        endpoint,
        provider,
        callback.prior_context.as_ref(),
    )? {
        return freshell_runtime_protocol::bounded_json_bytes(
            &reply,
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        )
        .map_err(|_| "replacement provider context exceeds control metadata profile".into());
    }
    if matches!(provider, "codex" | "claude") {
        let mut context = callback
            .prior_context
            .clone()
            .ok_or("complete replacement requires prior provider context")?;
        if context.prepared_inputs.is_none() {
            tracing::warn!(event="provider.inputs.preparation.blocked",stage="controller_callback",operation="select_original_sources",provider,
                soul_id=%callback.soul_id,reason="origin_unknown",
                "Original source origins are unrecorded; retained inputs were preserved");
            let name = if provider == "codex" {
                "Codex"
            } else {
                "Claude"
            };
            return Err(format!("original {name} source origins are unrecorded; retain the existing inputs and reprepare from their original source before dispatch"));
        }
        let bytes =
            read_prior_manifest_bytes(provider, store, directory, &callback.soul_id, &context)?;
        let codex_manifest: Option<freshell_platform::codex_inputs::CodexInputManifest> =
            if provider == "codex" {
                let manifest: freshell_platform::codex_inputs::CodexInputManifest =
                    serde_json::from_slice(&bytes)
                        .map_err(|_| "prior Codex source manifest metadata invalid")?;
                manifest.validate().map_err(str::to_string)?;
                Some(manifest)
            } else {
                None
            };
        let claude_manifest: Option<freshell_platform::claude_inputs::ClaudeInputManifest> =
            if provider == "claude" {
                let manifest: freshell_platform::claude_inputs::ClaudeInputManifest =
                    serde_json::from_slice(&bytes)
                        .map_err(|_| "prior Claude source manifest metadata invalid")?;
                manifest.validate().map_err(str::to_string)?;
                Some(manifest)
            } else {
                None
            };
        let (original_home, original_cwd, original_workspace) =
            match (&codex_manifest, &claude_manifest) {
                (Some(manifest), None) => (
                    &manifest.original_home,
                    &manifest.cwd,
                    callback.workspace.as_deref(),
                ),
                (None, Some(manifest)) => (
                    &manifest.original_home,
                    &manifest.cwd,
                    Some(manifest.workspace.as_path()),
                ),
                _ => return Err("replacement ordinary source manifest selection invalid".into()),
            };
        context.config.clear();
        let references = callback.provider_secret_references.unwrap_or_default();
        let capability = store.issue_replacement_with_inputs(
            callback.soul_id,
            directory,
            endpoint.into(),
            Some((provider, original_home, &context.config)),
            OpencodeEphemeralInput {
                launch_context: Some(&context),
                secret_references: Some(&references),
                cwd: Some(original_cwd),
                workspace: original_workspace,
                codex_manifest: codex_manifest.as_ref(),
                claude_manifest: claude_manifest.as_ref(),
                ..Default::default()
            },
        )?;
        let reply = freshell_runtime_protocol::PreparedProviderContext {
            provider_launch_context: read_prepared_context(directory, &capability)?,
            provider_secret_references: references,
        };
        reply
            .validate(provider)
            .map_err(|_| "replacement ordinary context metadata invalid")?;
        return freshell_runtime_protocol::bounded_json_bytes(
            &reply,
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        )
        .map_err(|_| "replacement ordinary context exceeds control metadata profile".into());
    }
    if provider != "opencode" {
        let references = provider_source_references(provider, home)?;
        let mut context = callback
            .prior_context
            .clone()
            .ok_or("complete replacement requires prior provider context")?;
        if context.prepared_inputs.is_some() {
            return Err(
                "selected provider prepared sources require complete replacement planning".into(),
            );
        }
        context.config = references.clone();
        let secret_references = callback.provider_secret_references.unwrap_or_default();
        let capability = store.issue_replacement_with_inputs(
            callback.soul_id,
            directory,
            endpoint.into(),
            Some((provider, home, &references)),
            OpencodeEphemeralInput {
                launch_context: Some(&context),
                secret_references: Some(&secret_references),
                tui_source: callback.tui_source.as_ref(),
                workspace: callback.workspace.as_deref(),
                ..Default::default()
            },
        )?;
        let context = read_prepared_context(directory, &capability)?;
        let reply = freshell_runtime_protocol::PreparedProviderContext {
            provider_launch_context: context,
            provider_secret_references: secret_references,
        };
        reply
            .validate(provider)
            .map_err(|_| "replacement provider context metadata invalid")?;
        return freshell_runtime_protocol::bounded_json_bytes(
            &reply,
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        )
        .map_err(|_| "replacement provider context exceeds control metadata profile".into());
    }
    let accepted_manifest = read_prior_source_manifest(
        store,
        directory,
        &callback.soul_id,
        callback.prior_context.as_ref(),
    )?;
    let home = accepted_manifest
        .as_ref()
        .map(|manifest| manifest.original_home.as_path())
        .unwrap_or(home);
    let workspace = callback
        .workspace
        .as_deref()
        .ok_or("missing provider workspace")?;
    let cwd = callback.cwd.as_deref().unwrap_or(workspace);
    let references = callback
        .provider_secret_references
        .unwrap_or_default()
        .into_iter()
        .filter(|reference| !reference.profile.is_configuration_file())
        .collect();
    let path_inputs = callback.provider_path_inputs.unwrap_or_default();
    let frozen_names = accepted_manifest
        .as_ref()
        .map(|manifest| manifest.frozen_inputs.as_slice())
        .unwrap_or(&[]);
    if path_inputs
        .iter()
        .any(|(name, _)| !frozen_names.iter().any(|approved| approved == name))
        || frozen_names
            .iter()
            .any(|name| path_inputs.get(name).is_none())
    {
        return Err("accepted request-only source inputs are unavailable or differ from their generation; reprepare before dispatch".into());
    }
    let original = |name: &str| {
        path_inputs
            .get(name)
            .map(str::to_owned)
            .or_else(|| std::env::var(name).ok())
    };
    let selected_sources=accepted_manifest.as_ref().map(|manifest|{
        manifest.sources.iter().enumerate().filter(|(_, source)| source.lane != freshell_platform::opencode_recipe::SourceLane::Inline).map(|(ordinal,source)|{
            let canonical=std::fs::canonicalize(&source.logical_path)
                .map_err(|_|format!("prior selected configuration source {ordinal} is unavailable; repair it before reissue"))?;
            Ok(crate::managed_provider_references::sources::SourceOccurrence {
                logical_path:source.logical_path.clone(),canonical_source:canonical,role:source.discovery_role,
                lane:match source.lane {freshell_platform::opencode_recipe::SourceLane::Main=>crate::managed_provider_references::sources::SourceLane::Main,
                    freshell_platform::opencode_recipe::SourceLane::Tui=>crate::managed_provider_references::sources::SourceLane::Tui,
                    freshell_platform::opencode_recipe::SourceLane::Inline=>crate::managed_provider_references::sources::SourceLane::Inline},
            })
        }).collect::<Result<Vec<_>,String>>()
    }).transpose()?;
    let inherited_inline = accepted_manifest
        .as_ref()
        .map(|manifest| {
            let mut sources = manifest.sources.iter().filter(|source| {
                source.lane == freshell_platform::opencode_recipe::SourceLane::Inline
            });
            let Some(source) = sources.next() else {
                return Ok(None);
            };
            if sources.next().is_some()
                || source.logical_path != Path::new("OPENCODE_CONFIG_CONTENT")
            {
                return Err("accepted inline source identity is invalid".to_string());
            }
            let context = callback
                .prior_context
                .as_ref()
                .ok_or("accepted inline source has no prior context")?;
            let root = staged_provider_root_path(
                directory,
                &context
                    .mcp_capability
                    .as_ref()
                    .ok_or("accepted inline source has no generation")?
                    .grant_id,
            )?;
            source_stage::read_source_view(&root, &source.unexpanded_relative_path).map(Some)
        })
        .transpose()?
        .flatten();
    let prepared = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
        crate::managed_provider_references::OpencodePreparation {
            client,
            soul: &callback.soul_id,
            creation_seed: "replacement",
            home,
            cwd,
            workspace,
            original: &original,
            references,
            auth_authority: Some(
                callback
                    .auth_lookup_authority
                    .as_deref()
                    .ok_or("replacement provider preparation requires attempt authority")?,
            ),
            selected_sources,
            accepted_global_root: accepted_manifest.as_ref().map(|manifest| manifest.global_config_root.clone().ok_or_else(|| "accepted global configuration root is unrecorded; retain prior inputs and reprepare before dispatch".to_string())).transpose()?,
            selected_resource_roots: accepted_manifest
                .as_ref()
                .map(|manifest| manifest.resource_roots.clone()),
            native_source_flags: accepted_manifest
                .as_ref()
                .map(|manifest| manifest.native_source_flags.clone()),
            rebind_enabled: accepted_manifest
                .as_ref()
                .map(|manifest| manifest.rebind_enabled),
            inherited_inline,
            inline_edits: accepted_manifest
                .as_ref()
                .map(|manifest| manifest.inline_edits.clone()),
        },
        |soul, home, context, input| {
            let input = OpencodeEphemeralInput {
                launch_context: Some(context),
                ..input
            };
            let capability = store.issue_replacement_with_inputs(
                soul.clone(),
                directory,
                endpoint.into(),
                Some(("opencode", home, &context.config)),
                input,
            )?;
            read_prepared_context(directory, &capability)
        },
    )
    .await?;
    let reply = freshell_runtime_protocol::PreparedProviderContext {
        provider_launch_context: prepared.context,
        provider_secret_references: prepared.references,
    };
    reply
        .validate(provider)
        .map_err(|_| "replacement provider context metadata invalid")?;
    freshell_runtime_protocol::bounded_json_bytes(
        &reply,
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
    )
    .map_err(|_| "replacement provider context exceeds control metadata profile".into())
}

fn read_prior_manifest_bytes(
    provider: &str,
    store: &CapabilityStore,
    directory: &Path,
    soul: &SoulId,
    context: &freshell_runtime_protocol::ProviderLaunchContext,
) -> Result<Vec<u8>, String> {
    context
        .validate(provider)
        .map_err(|_| "prior provider source context metadata invalid")?;
    let inputs = context
        .prepared_inputs
        .as_ref()
        .ok_or("prior prepared provider inputs unavailable")?;
    let capability = context
        .mcp_capability
        .as_ref()
        .ok_or("prior source context lacks generation authority")?;
    if !store
        .grants
        .lock()
        .unwrap()
        .get(&capability.grant_id)
        .is_some_and(|grant| grant.soul_id == *soul)
    {
        return Err("prior provider source context belongs to another owner".into());
    }
    let root = staged_provider_root_path(directory, &capability.grant_id)?;
    let path = root.join(&inputs.manifest.relative_path);
    if !std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        || std::fs::canonicalize(&path).map_err(|_| "prior source manifest unavailable")? != path
    {
        return Err("prior source manifest must be a physical private file".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "prior source manifest unavailable")?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "prior source manifest read failed")?;
    if bytes.len() > 64 * 1024 * 1024
        || format!("{:x}", sha2::Sha256::digest(&bytes)) != inputs.manifest.sha256
    {
        return Err("prior source manifest profile or identity changed".into());
    }
    Ok(bytes)
}

fn read_prior_source_manifest(
    store: &CapabilityStore,
    directory: &Path,
    soul: &SoulId,
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
) -> Result<Option<freshell_platform::opencode_recipe::SourceManifest>, String> {
    let Some(context) = context else {
        return Ok(None);
    };
    context
        .validate("opencode")
        .map_err(|_| "prior provider source context metadata invalid")?;
    let Some(inputs) = context.prepared_inputs.as_ref() else {
        return Ok(None);
    };
    let capability = context
        .mcp_capability
        .as_ref()
        .ok_or("prior source context lacks generation authority")?;
    let owned = store
        .grants
        .lock()
        .unwrap()
        .get(&capability.grant_id)
        .is_some_and(|grant| grant.soul_id == *soul);
    if !owned {
        return Err("prior provider source context belongs to another owner".into());
    }
    let root = staged_provider_root_path(directory, &capability.grant_id)?;
    let path = root.join(&inputs.manifest.relative_path);
    if !std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Err("prior source manifest must be a physical private file".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "prior source manifest unavailable")?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "prior source manifest read failed")?;
    if bytes.len() > 64 * 1024 * 1024
        || format!("{:x}", sha2::Sha256::digest(&bytes)) != inputs.manifest.sha256
    {
        return Err("prior source manifest profile or identity changed".into());
    }
    let manifest: freshell_platform::opencode_recipe::SourceManifest =
        serde_json::from_slice(&bytes).map_err(|_| "prior source manifest metadata invalid")?;
    if manifest.version != 1
        || manifest.sources.len() > 8192
        || manifest.files.len() > 128
        || manifest.frozen_inputs.len() > 128
        || !manifest.original_home.is_absolute()
        || !manifest.cwd.is_absolute()
    {
        return Err("prior source manifest origin profile invalid".into());
    }
    manifest.require_known_discovery_roles().map_err(|_| {
        "prior native discovery role is unrecorded; retain inputs and reprepare before dispatch"
            .to_string()
    })?;
    Ok(Some(manifest))
}

fn apply_callback(
    bytes: &[u8],
    expected_control_secret: &str,
    store: &CapabilityStore,
    directory: &Path,
    endpoint: &str,
    home: &Path,
) -> Result<Vec<u8>, String> {
    let callback: CapabilityCallback = serde_json::from_slice(bytes)
        .map_err(|_| "managed provider callback metadata is invalid")?;
    if !freshell_api::check_auth(Some(&callback.control_secret), expected_control_secret) {
        return Err("managed runtime callback unauthorized".into());
    }
    if callback.auth_lookup_authority.is_some() && callback.action != "issue" {
        return Err("native auth lookup authority belongs only to provider preparation".into());
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
        "commit" => {
            let grant_id = callback
                .grant_id
                .ok_or("missing provider input preparation id")?;
            let incarnation = callback
                .incarnation_id
                .ok_or("missing provider input preparation incarnation")?;
            store.commit_preparation(&grant_id, &callback.soul_id, &incarnation, directory)?;
            Ok(b"ok".to_vec())
        }
        "abort" => {
            let grant_id = callback
                .grant_id
                .ok_or("missing provider input preparation id")?;
            store.abort_preparation(&grant_id, &callback.soul_id, directory)?;
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
    )?
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

#[cfg(test)]
fn copy_provider_source(
    root: &Path,
    source: &Path,
    destination: &Path,
    _depth: usize,
    entries: &mut usize,
) -> Result<(), String> {
    use freshell_platform::provider_environment::{copy_environment, CopyLimits, CopySelection};
    let report = copy_environment(
        &[CopySelection {
            source: source.to_owned(),
            destination_relative: destination
                .file_name()
                .ok_or("destination has no name")?
                .into(),
        }],
        destination.parent().ok_or("destination has no parent")?,
        &provider_credential_sources(root),
        CopyLimits::default(),
    )
    .map_err(|error| error.to_string())?;
    *entries += report.entries;
    Ok(())
}

fn provider_credential_sources(root: &Path) -> Vec<PathBuf> {
    [
        ".credentials.json",
        "auth.json",
        "keys.env",
        ".env",
        "credentials",
        "secrets",
        "token.json",
    ]
    .into_iter()
    .filter_map(|name| std::fs::canonicalize(root.join(name)).ok())
    .collect()
}

#[cfg(unix)]
fn allow_controller_stage_read(path: &Path) -> Result<(), String> {
    use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "stage path contains NUL")?;
    // Rootless Docker maps its namespace group 0 to the controller's primary
    // group. Physical lchown never follows resource aliases.
    let gid = unsafe { libc::getegid() };
    if unsafe { libc::lchown(name.as_ptr(), libc::geteuid(), gid) } != 0 {
        return Err(format!(
            "normalize mapped group 0 for provider stage: {}",
            std::io::Error::last_os_error()
        ));
    }
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    let mode = if metadata.is_dir() {
        0o750
    } else if metadata.is_file() {
        freshell_platform::provider_environment::provider_read_stage_mode(
            metadata.permissions().mode(),
        )
    } else {
        return Err("provider stage contains unsupported inode".into());
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            allow_controller_stage_read(&entry.map_err(|error| error.to_string())?.path())?;
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn allow_controller_stage_read(_path: &Path) -> Result<(), String> {
    Err("managed provider stage requires rootless Unix ownership".into())
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

fn protected_preparation_ids(directory: &Path) -> Result<HashSet<String>, String> {
    use std::io::Read;
    let mut protected = HashSet::new();
    for entry in
        std::fs::read_dir(directory).map_err(|_| "provider preparation inventory unavailable")?
    {
        let path = entry
            .map_err(|_| "provider preparation entry unavailable")?
            .path();
        let Some(id) = path.file_stem().and_then(|id| id.to_str()) else {
            continue;
        };
        if path.extension().and_then(|extension| extension.to_str()) != Some("json")
            || grant_path(directory, id).is_err()
        {
            continue;
        }
        let mut bytes = Vec::new();
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        file.take(128 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "provider preparation metadata read failed")?;
        if bytes.len() > 128 * 1024 {
            return Err("provider preparation metadata profile limit exceeded".into());
        }
        let Ok(stored) = serde_json::from_slice::<StoredCapabilityFile>(&bytes) else {
            continue;
        };
        if let Some(preparation) = stored.preparation {
            if preparation.phase != InputPreparationPhase::Committed
                || !preparation.prior_grant_ids.is_empty()
            {
                protected.insert(id.to_string());
                for prior in preparation.prior_grant_ids {
                    grant_path(directory, &prior)?;
                    protected.insert(prior);
                }
            }
        }
    }
    Ok(protected)
}

fn cleanup_orphaned_provider_roots(directory: &Path) -> Result<(), String> {
    let staged_parent = directory
        .parent()
        .ok_or("managed MCP capability directory has no parent")?
        .join("provider-roots");
    if !staged_parent.is_dir() {
        return Ok(());
    }
    let protected = protected_preparation_ids(directory)?;
    for entry in std::fs::read_dir(&staged_parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(grant_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(grant_file) = grant_path(directory, &grant_id) else {
            continue;
        };
        if !grant_file.exists() && !protected.contains(&grant_id) && entry.path().is_dir() {
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
            let root = opencode_input
                .config_root
                .map(Path::to_path_buf)
                .unwrap_or_else(|| config_home.join("opencode"));
            let boundary = root
                .parent()
                .ok_or("managed config root parent unavailable")?
                .to_owned();
            (root, boundary)
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
        use freshell_platform::provider_environment::{
            copy_environment, CopyLimits, CopySelection,
        };
        let resource_root = temporary.join(".freshell/resources");
        private_directory(&resource_root)?;
        let mut selections = vec![CopySelection {
            source: resource_root,
            destination_relative: ".freshell/resources".into(),
        }];
        let mut excluded = provider_credential_sources(&source);
        for path in [
            ".claude/.credentials.json",
            ".codex/auth.json",
            ".local/share/opencode/auth.json",
            ".config/opencode/auth.json",
            ".amplifier/keys.env",
            ".amplifier/.env",
            // Native conversations/history/logs remain in their own stores;
            // an alias cannot turn them into selected package resources.
            ".claude/projects",
            ".claude/history.jsonl",
            ".claude/debug",
            ".codex/sessions",
            ".codex/archived_sessions",
            ".codex/history.jsonl",
            ".codex/log",
            ".amplifier/projects",
            ".local/share/opencode/storage",
            ".local/share/opencode/opencode.db",
            ".local/share/opencode/opencode.db-wal",
            ".local/share/opencode/opencode.db-shm",
        ] {
            if let Ok(canonical) = std::fs::canonicalize(home.join(path)) {
                excluded.push(canonical);
            }
        }
        let fallback_secrets;
        let secret_references = if let Some(references) = opencode_input.secret_references {
            references
        } else {
            fallback_secrets =
                crate::managed_provider_bootstrap::named_provider_onecli_references(provider)?;
            &fallback_secrets
        };
        excluded.extend(
            secret_references
                .iter()
                .map(|reference| PathBuf::from(&reference.source_path)),
        );
        if let Some(plan) = opencode_input.source_plan {
            let units = source_stage::resource_units(
                home,
                &source,
                opencode_input
                    .workspace
                    .or(opencode_input.cwd)
                    .unwrap_or(home),
                plan,
                opencode_input.resource_roots,
            )?;
            selections.extend(units.iter().map(|(source, mount)| CopySelection {
                source: source.clone(),
                destination_relative: mount.stage_relative_path.clone().into(),
            }));
            let descriptors = units
                .into_iter()
                .map(|(_, mount)| mount)
                .collect::<Vec<_>>();
            let metadata = freshell_runtime_protocol::bounded_json_bytes(
                &descriptors,
                freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
            )
            .map_err(|_| "prepared resource descriptor exceeds control profile")?;
            write_private_bytes(&temporary.join(".freshell/resource-mounts.json"), &metadata)?;
        }
        let ordinary_resources =
            if opencode_input.launch_context.is_some() && matches!(provider, "codex" | "claude") {
                Some(if provider == "claude" {
                    claude_stage::prepare(
                        home,
                        opencode_input.cwd.unwrap_or(home),
                        opencode_input
                            .workspace
                            .or(opencode_input.cwd)
                            .unwrap_or(home),
                        opencode_input.claude_manifest,
                        &excluded,
                    )?
                } else {
                    ordinary_stage::prepare(
                        home,
                        opencode_input.cwd.unwrap_or(home),
                        opencode_input.codex_manifest,
                    )?
                })
            } else {
                None
            };
        if let Some(resources) = &ordinary_resources {
            selections.extend(resources.selections.iter().cloned());
        }
        let amplifier_resources = if provider == "amplifier" {
            Some(amplifier_resources::prepare(
                home,
                opencode_input.cwd.unwrap_or(home),
                &excluded,
            )?)
        } else {
            None
        };
        if let Some(resources) = &amplifier_resources {
            selections.extend(resources.selections.iter().cloned());
        }
        for reference in references {
            if ordinary_resources.is_some() {
                continue;
            }
            if reference.root != ProviderConfigRoot::UserProvider {
                return Err("managed provider selector is unsafe".into());
            }
            if reference.relative_path == ".freshell/resources"
                && reference.provider_relative_path == ".freshell/resources"
            {
                continue;
            }
            if provider == "codex"
                && reference.relative_path == "freshell-discovered-agents"
                && reference.provider_relative_path == ".codex/skills/freshell-discovered-agents"
            {
                selections.push(CopySelection {
                    source: home.join(".agents/skills"),
                    destination_relative: reference.relative_path.clone().into(),
                });
                continue;
            }
            if reference.relative_path.contains(['/', '\\'])
                || reference.relative_path.is_empty()
                || reference.relative_path == "."
                || reference.relative_path == ".."
                || reference.provider_relative_path
                    != format!("{provider_dir}/{}", reference.relative_path)
            {
                return Err("managed provider selector is unsafe".into());
            }
            if canonical_root.is_none() {
                return Err("referenced managed provider root is unavailable".into());
            }
            selections.push(CopySelection {
                source: source.join(&reference.relative_path),
                destination_relative: reference.relative_path.clone().into(),
            });
        }
        if provider == "opencode" {
            let ephemeral = temporary.join("ephemeral");
            private_directory(&ephemeral)?;
            selections.push(CopySelection {
                source: ephemeral.clone(),
                destination_relative: "ephemeral".into(),
            });
            if let Some(prior_stage) = prior_stage {
                let source = prior_stage.join("ephemeral").join("inline-config.json");
                if source.is_file() {
                    copy_ephemeral_file(&source, &ephemeral.join("inline-config.json"))?;
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
        let started = std::time::Instant::now();
        tracing::info!(
            event = "provider.environment.copy.started",
            stage = "controller",
            provider,
            selections = selections.len()
        );
        let report=copy_environment(&selections,&temporary,&excluded,CopyLimits::default()).map_err(|error| {
            tracing::error!(event="provider.environment.copy.failed",stage="controller",provider,operation=error.operation,relative_path=%error.relative_path.display(),limit_kind=error.limit_kind,observed=error.observed,permitted=error.permitted,elapsed_ms=started.elapsed().as_millis() as u64,corrective_message=%error.corrective_message);
            error.to_string()
        })?;
        tracing::info!(
            event = "provider.environment.copy.completed",
            stage = "controller",
            provider,
            entries = report.entries,
            bytes = report.bytes,
            elapsed_ms = started.elapsed().as_millis() as u64
        );
        if let Some(resources) = amplifier_resources {
            if let Some(settings) = resources.rewritten_settings {
                replace_staged_private_bytes(
                    &temporary.join("settings.yaml"),
                    settings.as_bytes(),
                )?;
            }
            for (relative, template) in resources.rewritten_resources {
                replace_staged_private_bytes(&temporary.join(relative), template.as_bytes())?;
            }
        }
        if let Some(plan) = opencode_input.source_plan {
            source_stage::stage(
                &temporary,
                home,
                opencode_input.cwd.ok_or("source plan requires cwd")?,
                plan,
                opencode_input,
            )?;
        }
        if let Some(resources) = &ordinary_resources {
            let capability = McpCapabilityReference {
                grant_id: grant_id.into(),
                endpoint: "http://host.docker.internal:1".into(),
                provider_relative_path: CAPABILITY_PATH.into(),
                host_gateway_address: None,
            };
            let inputs = ordinary_stage::publish(
                &temporary,
                resources,
                &capability,
                opencode_input.initial_auth_reservation,
            )?;
            write_private_bytes(
                &temporary.join(".freshell/prepared-inputs.json"),
                &freshell_runtime_protocol::bounded_json_bytes(
                    &inputs,
                    freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
                )
                .map_err(|_| "ordinary prepared context exceeds control profile")?,
            )?;
        }
        allow_controller_stage_read(&temporary)?;
        std::fs::rename(&temporary, &staged).map_err(|error| error.to_string())?;
        Ok(staged.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
}

fn replace_staged_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "selected source was not copied into its owned stage")?;
    if !(metadata.is_file() || metadata.file_type().is_symlink()) {
        return Err("selected source stage destination is not a file".into());
    }
    let parent = path
        .parent()
        .ok_or("selected source stage parent unavailable")?;
    let temporary = parent.join(format!(".source-template-{}", uuid::Uuid::new_v4()));
    write_private_bytes(&temporary, bytes)?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
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
    use freshell_platform::provider_environment::{copy_environment, CopyLimits, CopySelection};
    let metadata = std::fs::metadata(source).map_err(|error| error.to_string())?;
    // Configuration-source views have their explicit 16 MiB profile; resource
    // copying retains the shared 128 MiB per-file policy, with no hidden cap.
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err(format!("selected OpenCode configuration source exceeds 16 MiB or is not a regular file; observed {} bytes",metadata.len()));
    }
    let report = copy_environment(
        &[CopySelection {
            source: source.to_owned(),
            destination_relative: destination
                .file_name()
                .ok_or("config destination has no name")?
                .into(),
        }],
        destination
            .parent()
            .ok_or("config destination has no parent")?,
        &[],
        CopyLimits::default(),
    )
    .map_err(|error| error.to_string())?;
    if report.bytes > 16 * 1024 * 1024 {
        return Err("OpenCode configuration source grew beyond its explicit 16 MiB profile; retry with a stable source".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityFile<'a> {
    endpoint: &'a str,
    scope: &'a str,
    soul_id: &'a SoulId,
    incarnation_id: Option<&'a IncarnationId>,
    expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    preparation: Option<&'a InputPreparation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCapabilityFile {
    endpoint: String,
    scope: String,
    soul_id: SoulId,
    incarnation_id: Option<IncarnationId>,
    expires_at: u64,
    #[serde(default)]
    preparation: Option<InputPreparation>,
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
        preparation: stored.preparation,
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
        preparation: grant.preparation.as_ref(),
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

fn publish_prepared_context_metadata(
    root: &Path,
    provider: &str,
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    references: Option<&[freshell_runtime_protocol::ProviderSecretReference]>,
) -> Result<(), String> {
    context
        .validate(provider)
        .map_err(|_| "complete provider context metadata invalid")?;
    let parent = root.join(".freshell");
    if !parent.exists() {
        private_directory(&parent)?;
    }
    if !std::fs::symlink_metadata(&parent)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return Err("complete provider metadata parent must be a physical directory".into());
    }
    let bytes = freshell_runtime_protocol::bounded_json_bytes(
        context,
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
    )
    .map_err(|_| "complete provider context exceeds metadata profile")?;
    let path = parent.join("prepared-context.json");
    write_private_bytes(&path, &bytes)?;
    allow_controller_stage_read(&path)?;
    if let Some(references) = references {
        let reply = freshell_runtime_protocol::PreparedProviderContext {
            provider_launch_context: context.clone(),
            provider_secret_references: references.to_vec(),
        };
        reply
            .validate(provider)
            .map_err(|_| "complete provider result metadata invalid")?;
        let bytes = freshell_runtime_protocol::bounded_json_bytes(
            &reply,
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        )
        .map_err(|_| "complete provider result exceeds metadata profile")?;
        let path = parent.join("prepared-result.json");
        write_private_bytes(&path, &bytes)?;
        allow_controller_stage_read(&path)?;
    }
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
        if let (Some(root), Some(plan)) = (&staged_provider_root, opencode_input.source_plan) {
            let reference = McpCapabilityReference {
                grant_id: grant_id.clone(),
                endpoint: endpoint.clone(),
                provider_relative_path: CAPABILITY_PATH.into(),
                host_gateway_address: routed_host_ipv4(),
            };
            let home = source
                .ok_or("prepared source requires original provider HOME")?
                .1;
            let prepared = source_stage::describe(
                root,
                home,
                plan,
                &soul_id,
                &reference,
                opencode_input.initial_auth_reservation,
                opencode_input.config_root,
                opencode_input
                    .workspace
                    .or(opencode_input.cwd)
                    .unwrap_or(home),
                opencode_input.secret_references.unwrap_or(&[]),
            )
            .and_then(|inputs| {
                if let Some(context) = opencode_input.launch_context {
                    let mut context = context.clone();
                    context.mcp_capability = Some(reference.clone());
                    context.config.retain(|selected| {
                        let destination = format!(
                            "/home/freshell/provider/{}",
                            selected.provider_relative_path
                        );
                        !inputs.config_binds.iter().any(|bind| {
                            bind.logical_destination == destination
                                || bind.effective_destination == destination
                        })
                    });
                    context.prepared_inputs = Some(inputs);
                    publish_prepared_context_metadata(
                        root,
                        "opencode",
                        &context,
                        opencode_input.secret_references,
                    )?;
                }
                Ok(())
            });
            if let Err(error) = prepared {
                let _ = std::fs::remove_dir_all(root);
                return Err(error);
            }
        }
        if opencode_input.source_plan.is_none() {
            if let (Some(root), Some(context), Some((provider, _, _))) =
                (&staged_provider_root, opencode_input.launch_context, source)
            {
                let mut context = context.clone();
                context.mcp_capability = Some(McpCapabilityReference {
                    grant_id: grant_id.clone(),
                    endpoint: endpoint.clone(),
                    provider_relative_path: CAPABILITY_PATH.into(),
                    host_gateway_address: routed_host_ipv4(),
                });
                if matches!(provider, "codex" | "claude") {
                    let bytes =
                        source_stage::read_source_view(root, ".freshell/prepared-inputs.json")?;
                    context.prepared_inputs = Some(
                        serde_json::from_str(&bytes)
                            .map_err(|_| "ordinary prepared inputs unavailable")?,
                    );
                    context.config.clear();
                }
                let result = publish_prepared_context_metadata(
                    root,
                    provider,
                    &context,
                    opencode_input.secret_references,
                );
                if let Err(error) = result {
                    let _ = std::fs::remove_dir_all(root);
                    return Err(error);
                }
            }
        }
        let grant = Grant {
            preparation: Some(InputPreparation {
                phase: InputPreparationPhase::Pending,
                prior_grant_ids: Vec::new(),
            }),
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

    fn pending_prepared_context(
        &self,
        soul: &SoulId,
        directory: &Path,
        endpoint: &str,
        provider: &str,
        prior: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    ) -> Result<Option<freshell_runtime_protocol::PreparedProviderContext>, String> {
        let candidate = {
            let grants = self.grants.lock().unwrap();
            grants
                .iter()
                .find(|(_, grant)| {
                    grant.soul_id == *soul
                        && grant.preparation.as_ref().is_some_and(|prepared| {
                            prepared.phase != InputPreparationPhase::Committed
                                && !prepared.prior_grant_ids.is_empty()
                        })
                })
                .map(|(id, grant)| {
                    (
                        id.clone(),
                        grant.endpoint.clone(),
                        grant.preparation.as_ref().unwrap().prior_grant_ids.clone(),
                    )
                })
        };
        let Some((id, pending_endpoint, prior_ids)) = candidate else {
            return Ok(None);
        };
        if pending_endpoint != endpoint
            || prior
                .and_then(|context| context.mcp_capability.as_ref())
                .is_some_and(|reference| !prior_ids.contains(&reference.grant_id))
        {
            return Err(
                "pending complete provider preparation requires exact ownership reconciliation"
                    .into(),
            );
        }
        let stage = staged_provider_root_path(directory, &id)?;
        let path = stage.join(".freshell/prepared-result.json");
        if !path.exists() {
            return Ok(None);
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| "pending prepared result unavailable")?
            .take((freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "pending prepared result read failed")?;
        if bytes.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
            return Err("pending prepared result exceeds metadata profile".into());
        }
        let result: freshell_runtime_protocol::PreparedProviderContext =
            serde_json::from_slice(&bytes)
                .map_err(|_| "pending prepared result metadata invalid")?;
        result
            .validate(provider)
            .map_err(|_| "pending prepared result metadata invalid")?;
        if result
            .provider_launch_context
            .mcp_capability
            .as_ref()
            .is_none_or(|capability| capability.grant_id != id || capability.endpoint != endpoint)
        {
            return Err("pending prepared result changed generation".into());
        }
        Ok(Some(result))
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
        self.issue_replacement_with_inputs(
            soul_id,
            directory,
            endpoint,
            source,
            OpencodeEphemeralInput {
                tui_source,
                workspace,
                ..Default::default()
            },
        )
    }

    fn issue_replacement_with_inputs(
        &self,
        soul_id: SoulId,
        directory: &Path,
        endpoint: String,
        source: Option<(&str, &Path, &[ProviderConfigReference])>,
        input: OpencodeEphemeralInput<'_>,
    ) -> Result<McpCapabilityReference, String> {
        if let Some((grant_id, grant)) = self.grants.lock().unwrap().iter().find(|(_, grant)| {
            grant.soul_id == soul_id
                && grant.preparation.as_ref().is_some_and(|p| {
                    p.phase != InputPreparationPhase::Committed && !p.prior_grant_ids.is_empty()
                })
        }) {
            if grant.endpoint != endpoint {
                return Err("pending provider input preparation requires reconciliation".into());
            }
            return Ok(McpCapabilityReference {
                grant_id: grant_id.clone(),
                endpoint,
                provider_relative_path: CAPABILITY_PATH.into(),
                host_gateway_address: routed_host_ipv4(),
            });
        }
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
            input,
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
        let result = (|| {
            let mut grants = self.grants.lock().unwrap();
            let pending = grants
                .get_mut(&replacement.grant_id)
                .ok_or("provider input preparation disappeared")?;
            pending.preparation = Some(InputPreparation {
                phase: InputPreparationPhase::Pending,
                prior_grant_ids: prior,
            });
            write_capability(&pending.path, pending)
        })();
        if let Err(error) = result {
            let _ = self.revoke(&replacement.grant_id, directory);
            return Err(error);
        }
        Ok(replacement)
    }

    fn commit_preparation(
        &self,
        grant_id: &str,
        soul_id: &SoulId,
        incarnation_id: &IncarnationId,
        directory: &Path,
    ) -> Result<(), String> {
        let (prior, changed) = {
            let mut grants = self.grants.lock().unwrap();
            let grant = grants
                .get_mut(grant_id)
                .ok_or("provider input preparation is unknown; reconcile delivery")?;
            if &grant.soul_id != soul_id || grant.incarnation_id.as_ref() != Some(incarnation_id) {
                return Err(
                    "provider input preparation commit has no matching accepted incarnation".into(),
                );
            }
            let Some(preparation) = grant.preparation.as_mut() else {
                return Ok(());
            };
            if preparation.phase == InputPreparationPhase::Pending {
                return Err("provider input preparation is not activated".into());
            }
            let changed = preparation.phase != InputPreparationPhase::Committed;
            preparation.phase = InputPreparationPhase::Committed;
            let prior = preparation.prior_grant_ids.clone();
            write_capability(&grant.path, grant)?;
            (prior, changed)
        };
        for prior_id in prior {
            self.revoke(&prior_id, directory)?;
        }
        let mut grants = self.grants.lock().unwrap();
        let grant = grants
            .get_mut(grant_id)
            .ok_or("committed provider preparation disappeared")?;
        if let Some(preparation) = grant.preparation.as_mut() {
            preparation.prior_grant_ids.clear();
        }
        write_capability(&grant.path, grant)?;
        if changed {
            tracing::info!(event="provider.inputs.preparation.committed",grant_id,
            soul_id=%soul_id,incarnation_id=%incarnation_id);
        }
        Ok(())
    }

    fn abort_preparation(
        &self,
        grant_id: &str,
        soul_id: &SoulId,
        directory: &Path,
    ) -> Result<(), String> {
        if let Some(grant) = self.grants.lock().unwrap().get(grant_id) {
            if &grant.soul_id != soul_id {
                return Err("provider input preparation belongs to another soul".into());
            }
            if grant
                .preparation
                .as_ref()
                .is_some_and(|p| p.phase == InputPreparationPhase::Committed)
            {
                return Err(
                    "provider input preparation is committed; reconcile before cleanup".into(),
                );
            }
        }
        self.revoke(grant_id, directory)?;
        tracing::info!(event="provider.inputs.preparation.aborted",grant_id,soul_id=%soul_id);
        Ok(())
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
        let mut preparation = grants
            .get(grant_id)
            .and_then(|grant| grant.preparation.clone());
        if let Some(preparation) = preparation.as_mut() {
            if preparation.phase != InputPreparationPhase::Committed {
                preparation.phase = InputPreparationPhase::Bound;
            }
        }
        let grant = Grant {
            preparation,
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

pub(crate) fn issue_prepared_opencode_context(
    soul: &SoulId,
    home: &Path,
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    input: OpencodeEphemeralInput<'_>,
) -> Result<freshell_runtime_protocol::ProviderLaunchContext, String> {
    issue_prepared_provider_context("opencode", soul, home, context, input)
}
pub(crate) fn issue_prepared_provider_context(
    provider: &str,
    soul: &SoulId,
    home: &Path,
    context: &freshell_runtime_protocol::ProviderLaunchContext,
    input: OpencodeEphemeralInput<'_>,
) -> Result<freshell_runtime_protocol::ProviderLaunchContext, String> {
    let input = OpencodeEphemeralInput {
        launch_context: Some(context),
        ..input
    };
    let directory = capability_dir()?;
    let capability = store().issue(
        soul.clone(),
        &directory,
        endpoint()?,
        Some((provider, home, &context.config)),
        input,
        None,
    )?;
    let result = read_prepared_context(&directory, &capability);
    if result.is_err() {
        let _ = store().revoke(&capability.grant_id, &directory);
    }
    result
}

fn read_prepared_context(
    directory: &Path,
    capability: &McpCapabilityReference,
) -> Result<freshell_runtime_protocol::ProviderLaunchContext, String> {
    let result = (|| {
        use std::io::Read;
        let stage = staged_provider_root_path(&directory, &capability.grant_id)?;
        let mut bytes = Vec::new();
        std::fs::File::open(stage.join(".freshell/prepared-context.json"))
            .map_err(|_| "complete prepared provider context unavailable")?
            .take((freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "complete prepared provider context read failed")?;
        if bytes.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
            return Err("complete prepared provider context exceeds metadata profile".into());
        }
        let context: freshell_runtime_protocol::ProviderLaunchContext =
            serde_json::from_slice(&bytes)
                .map_err(|_| "complete prepared provider context metadata invalid")?;
        if context.mcp_capability.as_ref() != Some(capability) {
            return Err("complete prepared context changed generation before publication".into());
        }
        Ok(context)
    })();
    result
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
    let protected = protected_preparation_ids(&directory)?;
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
        if protected.contains(&grant_id) {
            let current = stored.endpoint == endpoint()? && !stored.scope.is_empty();
            store().grants.lock().unwrap().insert(
                grant_id.clone(),
                Grant {
                    soul_id: stored.soul_id,
                    incarnation_id: stored.incarnation_id,
                    token: if current { stored.scope } else { String::new() },
                    expires_at: if current { stored.expires_at } else { 0 },
                    endpoint: stored.endpoint,
                    path,
                    preparation: stored.preparation,
                },
            );
            tracing::info!(
                event = "managed_mcp.preparation.retained",
                grant_id,
                "Retained uncertain provider input generation for supervisor reconciliation"
            );
            continue;
        }
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

    #[cfg(all(unix, feature = "managed-provider-qualification"))]
    #[test]
    fn managed_provider_amplifier_native_local_bundle_survives_transport() {
        use freshell_platform::provider_environment::{
            copy_environment, CopyLimits, CopySelection,
        };
        use sha2::{Digest, Sha256};
        for case in [
            "directory-markdown-precedence",
            "directory-bundle-includes",
            "bundle-includes",
            "bundle-object-includes",
            "bundle-relative-includes",
            "context-include",
            "context-include-leading-slash",
            "markdown-bundle",
            "markdown-absolute-context",
            "collection-alias",
            "merge-key",
            "relative-context",
            "absolute-context",
            "parent-context",
            "unicode-source",
            "scalar-alias",
            "home-document",
            "directory-source",
        ] {
            let root = executable_fixture_directory();
            let home = root.path().join("source-home");
            let bundle = if case == "home-document" {
                home.clone()
            } else {
                root.path().join(if case == "unicode-source" {
                    "资源 with spaces"
                } else {
                    "outside-bundle"
                })
            };
            std::fs::create_dir_all(home.join(".amplifier")).unwrap();
            std::fs::create_dir_all(&bundle).unwrap();
            let payload = b"synthetic-amplifier-context-nonce";
            let context = if case == "parent-context" {
                root.path().join("context.txt")
            } else {
                bundle.join("context.txt")
            };
            std::fs::write(&context, payload).unwrap();
            let context_reference =
                if matches!(case, "absolute-context" | "markdown-absolute-context") {
                    context.to_string_lossy().into_owned()
                } else if case == "parent-context" {
                    "../context.txt".into()
                } else {
                    "./context.txt".into()
                };
            let bundle_name =
                if case.starts_with("markdown-") || case == "directory-markdown-precedence" {
                    "bundle.md"
                } else {
                    "bundle.yaml"
                };
            let included = root.path().join("included-bundle");
            let header = if matches!(
                case,
                "directory-bundle-includes"
                    | "bundle-includes"
                    | "bundle-object-includes"
                    | "bundle-relative-includes"
            ) {
                std::fs::create_dir(&included).unwrap();
                std::fs::write(included.join("context.txt"), payload).unwrap();
                std::fs::write(included.join("bundle.yaml"),"bundle:\n  name: included-probe\n  version: 1.0.0\ncontext:\n  probe: ./context.txt\n").unwrap();
                let source = if case == "bundle-relative-includes" {
                    "./included-bundle/bundle.yaml".to_owned()
                } else {
                    format!("file://{}", included.join("bundle.yaml").display())
                };
                format!(
                    "bundle:\n  name: source-probe\n  version: 1.0.0\nincludes:\n  - {}{}\n",
                    if case == "bundle-object-includes" {
                        "bundle: "
                    } else {
                        ""
                    },
                    serde_json::to_string(&source).unwrap()
                )
            } else if case.starts_with("context-include") {
                format!("bundle:\n  name: source-probe\n  version: 1.0.0\ncontext:\n  include: [{}context.txt]\n",if case=="context-include-leading-slash" {"/"}else{""})
            } else {
                format!(
                    "bundle:\n  name: source-probe\n  version: 1.0.0\ncontext:\n  probe: {}\n",
                    serde_json::to_string(&context_reference).unwrap()
                )
            };
            let document =
                if case.starts_with("markdown-") || case == "directory-markdown-precedence" {
                    format!("---\n{header}---\n# Native retained instructions\nplain body source\n")
                } else {
                    header
                };
            std::fs::write(bundle.join(bundle_name), document).unwrap();
            if case == "directory-markdown-precedence" {
                std::fs::write(
                    bundle.join("bundle.yaml"),
                    "bundle: {name: wrong-native-entry}\ncontext: {probe: ./must-not-select}\n",
                )
                .unwrap();
            }
            let selected = if matches!(
                case,
                "directory-source" | "directory-bundle-includes" | "directory-markdown-precedence"
            ) {
                bundle.clone()
            } else {
                bundle.join(bundle_name)
            };
            let quoted = serde_json::to_string(&format!("file://{}", selected.display())).unwrap();
            let settings = if case == "scalar-alias" {
                format!("selected: &bundle_source {quoted}\nbundle:\n  active: *bundle_source\n")
            } else if case == "collection-alias" {
                format!("defaults: &bundle_map\n  active: {quoted}\nbundle: *bundle_map\nadjacent: *bundle_map\n")
            } else if case == "merge-key" {
                format!("defaults: &bundle_map\n  active: {quoted}\nbundle:\n  <<: *bundle_map\nadjacent: *bundle_map\n")
            } else {
                format!("# unchanged α comment\nbundle:\n  active: {quoted}\n")
            };
            std::fs::write(home.join(".amplifier/settings.yaml"), settings).unwrap();
            std::fs::write(bundle.join("private-unselected"), b"UNSELECTED_HOME_NONCE").unwrap();
            let references = provider_source_references("amplifier", &home).unwrap();
            let capabilities = root.path().join("capabilities");
            std::fs::create_dir(&capabilities).unwrap();
            let staged = stage_provider_root(
                &capabilities,
                "grant-native-amplifier",
                "amplifier",
                &home,
                &references,
                OpencodeEphemeralInput {
                    cwd: Some(root.path()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
            let selections = references
                .iter()
                .map(|reference| CopySelection {
                    source: staged.join(&reference.relative_path),
                    destination_relative: reference.provider_relative_path.clone().into(),
                })
                .collect::<Vec<_>>();
            let runtime_home = Path::new("/home/freshell/provider");
            copy_environment(&selections, runtime_home, &[], CopyLimits::default()).unwrap();
            if case == "home-document" {
                assert!(!runtime_home.join(".freshell/resources/amplifier-local-0/private-unselected").exists(),
            "selecting a standalone document in HOME must not transport unrelated home files");
            }
            std::fs::remove_dir_all(&bundle).unwrap();
            if matches!(
                case,
                "directory-bundle-includes"
                    | "bundle-includes"
                    | "bundle-object-includes"
                    | "bundle-relative-includes"
            ) {
                std::fs::remove_dir_all(&included).unwrap();
            }
            if case == "parent-context" {
                std::fs::remove_file(context).unwrap();
            }
            let consumer = root.path().join("native-amplifier-consumer.py");
            std::fs::write(&consumer,r#"import asyncio, hashlib, json, os, sys
from pathlib import Path
phase = 'native_settings_shape'
async def consume():
    global phase
    from amplifier_app_cli.lib.settings import AppSettings, SettingsPaths
    home = Path(os.environ['HOME'])
    settings = AppSettings(SettingsPaths(global_settings=home/'.amplifier/settings.yaml', project_settings=home/'absent-project.yaml', local_settings=home/'absent-local.yaml', session_settings=None))
    phase = 'native_settings_load'
    selected = settings.get_active_bundle()
    if not isinstance(selected, str) or not selected.startswith('file://'):
        raise TypeError('fixture requires one local bundle source')
    from amplifier_foundation import BundleRegistry, load_bundle
    phase = 'native_bundle_load'
    bundle = await load_bundle(selected, registry=BundleRegistry(strict=True))
    phase = 'native_context_resolution'
    bundle.resolve_pending_context()
    resource = Path(bundle.context.get('probe') or next(iter(bundle.context.values())))
    phase = 'native_context_read'
    data = resource.read_bytes()
    body_digest = None
    if selected.endswith('.md'):
        from amplifier_foundation.io import parse_frontmatter
        _, body = parse_frontmatter(Path(selected[len('file://'):]).read_text())
        body_digest = hashlib.sha256(body.encode()).hexdigest()
    adjacent = settings.get_merged_settings().get('adjacent', {}).get('active')
    print(json.dumps({'ok':True,'digest':hashlib.sha256(data).hexdigest(), 'bodyDigest':body_digest, 'adjacentDigest':hashlib.sha256(adjacent.encode()).hexdigest() if isinstance(adjacent,str) else None}))
try:
    asyncio.run(consume())
except Exception as error:
    print(json.dumps({'ok':False,'phase':phase,'errorClass':type(error).__name__}))
    sys.exit(73)
"#).unwrap();
            let output = std::process::Command::new("/opt/amplifier-src/.venv/bin/python")
                .arg("-B")
                .arg(&consumer)
                .env_clear()
                .env("HOME", runtime_home)
                .env("AMPLIFIER_HOME", runtime_home.join(".amplifier"))
                .env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .env("LANG", "C.UTF-8")
                .current_dir(root.path())
                .output()
                .expect("closed pinned native fixture must provide its image interpreter");
            let line = std::str::from_utf8(&output.stdout)
                .unwrap()
                .lines()
                .last()
                .unwrap_or("");
            let receipt: serde_json::Value = serde_json::from_str(line)
                .expect("native fixture emits only bounded classified receipt");
            assert!(
                output.status.success(),
                "transported native consumer failed: phase={} errorClass={}",
                receipt["phase"],
                receipt["errorClass"]
            );
            assert_eq!(receipt["digest"], format!("{:x}", Sha256::digest(payload)));
            if case.starts_with("markdown-") {
                assert_eq!(
                    receipt["bodyDigest"],
                    format!(
                        "{:x}",
                        Sha256::digest(b"# Native retained instructions\nplain body source\n")
                    ),
                    "native frontmatter parsing must retain the transported Markdown body"
                );
            }
            if matches!(case, "collection-alias" | "merge-key") {
                assert_eq!(receipt["adjacentDigest"],format!("{:x}",Sha256::digest(format!("file://{}",selected.display()).as_bytes())),
                "rewriting a recognized bundle source must retain the neighboring native alias value");
            }
            println!(
                "provider_source_consumer {}",
                serde_json::json!({"provider":"amplifier","case":case,"digest":receipt["digest"]})
            );
            // Each case consumes one physical synthetic HOME; remove only its
            // fixture projection before the next independent native consumer.
            for relative in [
                ".amplifier",
                ".freshell",
                "absent-project.yaml",
                "absent-local.yaml",
            ] {
                let path = runtime_home.join(relative);
                if path.is_dir() {
                    std::fs::remove_dir_all(path).unwrap();
                } else if path.exists() {
                    std::fs::remove_file(path).unwrap();
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_codex_linked_skills_and_discovery_form_a_resumable_graph() {
        use freshell_platform::provider_environment::{copy_environment, CopySelection};
        use std::{
            fs,
            os::unix::fs::{symlink, MetadataExt, PermissionsExt},
            process::Command,
        };
        let root = executable_fixture_directory();
        let original = root.path().join("original");
        let external = root.path().join("external-skills");
        let discovered = original.join(".agents/skills");
        for directory in [&external, &discovered] {
            fs::create_dir_all(directory.join("fixture/scripts")).unwrap();
            // Give this synthetic package its own native resolution boundary;
            // an executable tempdir under /workspace must not inherit the
            // repository's unrelated installed dependency tree.
            fs::write(
                directory.join("package.json"),
                r#"{"name":"synthetic-codex-skills","private":true,"type":"commonjs"}"#,
            )
            .unwrap();
            fs::write(directory.join("fixture/SKILL.md"), "fixture").unwrap();
            fs::write(directory.join("fixture/resource"), "resource-nonce\n").unwrap();
            let script = directory.join("fixture/scripts/run");
            fs::write(
                &script,
                "#!/bin/sh\ncat \"$(dirname \"$0\")/../resource\"\n",
            )
            .unwrap();
            fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::create_dir_all(original.join(".codex")).unwrap();
        symlink(&external, original.join(".codex/skills")).unwrap();
        let context = crate::managed_provider_bootstrap::provider_launch_context_from_home(
            "codex",
            root.path(),
            &original,
            None,
        )
        .unwrap()
        .unwrap();
        let controller = stage_provider_root(
            &root.path().join("control/capabilities"),
            "grant-codex-roundtrip",
            "codex",
            &original,
            &context.config,
            OpencodeEphemeralInput::default(),
            None,
        )
        .unwrap();
        let stage = root.path().join("host-stage");
        fs::create_dir(&stage).unwrap();
        let projection = stage.join("projection");
        let selections = context
            .config
            .iter()
            .map(|reference| CopySelection {
                source: controller.join(&reference.relative_path),
                destination_relative: reference.provider_relative_path.clone().into(),
            })
            .collect::<Vec<_>>();
        let report = copy_environment(&selections, &projection, &[], Default::default()).unwrap();
        assert!(fs::symlink_metadata(projection.join(".codex/skills"))
            .unwrap()
            .file_type()
            .is_symlink());
        let resources = [
            ".codex/skills/fixture/scripts/run",
            ".codex/skills/freshell-discovered-agents/fixture/scripts/run",
        ];
        for relative in resources {
            let output = Command::new(projection.join(relative)).output().unwrap();
            assert!(output.status.success(), "{output:?}");
            assert_eq!(output.stdout, b"resource-nonce\n");
        }
        // The ordinary controller test always exercises discovery, transport,
        // and resource execution. A focused integration invocation can also
        // supply the separately built production host to exercise publication.
        if let Some(binary) = std::env::var_os("FRESHELL_TEST_SESSION_HOST_BINARY") {
            let binary = PathBuf::from(binary);
            assert!(binary.is_absolute() && binary.is_file());
            fs::write(stage.join("provider.json"), r#""codex""#).unwrap();
            fs::write(
                stage.join("manifest.json"),
                serde_json::to_vec(
                    &context
                        .config
                        .iter()
                        .map(|reference| &reference.provider_relative_path)
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            )
            .unwrap();
            fs::write(
                projection.join(".freshell-config-projection.json"),
                serde_json::to_vec(
                    &report
                        .projected_paths
                        .iter()
                        .map(|path| path.to_str().unwrap())
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            )
            .unwrap();
            let home = root.path().join("provider-home");
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            let run = || {
                let output = Command::new(&binary)
                    .arg("refresh-provider-config")
                    .arg(&stage)
                    .arg(&home)
                    .output()
                    .unwrap();
                assert!(output.status.success(), "{output:?}");
                assert!(output.stdout.is_empty());
                for line in std::str::from_utf8(&output.stderr).unwrap().lines() {
                    let event: serde_json::Value = serde_json::from_str(line).unwrap();
                    assert_eq!(event["provider"], "codex");
                    assert_eq!(event["stage"], "provider_publication");
                    eprintln!("{line}");
                }
            };
            run();
            let sibling = home.join(".codex/skills/provider-sibling");
            fs::write(&sibling, "sibling-nonce").unwrap();
            let inode = fs::metadata(&sibling).unwrap().ino();
            for _ in 0..3 {
                run();
                for relative in resources {
                    let output = Command::new(home.join(relative)).output().unwrap();
                    assert!(output.status.success(), "{output:?}");
                    assert_eq!(output.stdout, b"resource-nonce\n");
                }
                assert_eq!(fs::metadata(&sibling).unwrap().ino(), inode);
                assert_eq!(fs::read(&sibling).unwrap(), b"sibling-nonce");
            }
            eprintln!("controller-host-codex-alias-roundtrip PASS initial-and-three-resumes executable-discovery preserved-sibling");
        }
    }

    #[cfg(unix)]
    fn executable_fixture_directory() -> tempfile::TempDir {
        match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(directory) => tempfile::tempdir_in(directory),
            None => tempfile::tempdir(),
        }
        .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_resource_script_and_dependency_execute() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let root = executable_fixture_directory();
        let source = root.path().join("source");
        std::fs::create_dir_all(source.join("scripts")).unwrap();
        std::fs::create_dir_all(source.join("node_modules/fixture-dependency")).unwrap();
        // Keep this transported package's module kind explicit when its
        // disposable fixture lives below the repository's ESM package.
        std::fs::write(source.join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
        std::fs::write(source.join("data"), "resource-nonce\n").unwrap();
        std::fs::write(
            source.join("scripts/run"),
            "#!/bin/sh\ncat \"$(dirname \"$0\")/../data\"\n",
        )
        .unwrap();
        std::fs::set_permissions(
            source.join("scripts/run"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::write(
            source.join("node_modules/fixture-dependency/package.json"),
            r#"{"main":"index.js"}"#,
        )
        .unwrap();
        std::fs::write(
            source.join("node_modules/fixture-dependency/auth.json"),
            r#"{"nonce":"dependency-nonce"}"#,
        )
        .unwrap();
        std::fs::write(
            source.join("node_modules/fixture-dependency/index.js"),
            "module.exports=require('./auth.json').nonce",
        )
        .unwrap();
        std::fs::write(
            source.join("plugin.js"),
            "console.log(require('fixture-dependency'))",
        )
        .unwrap();
        let stage = root.path().join("stage");
        let home = root.path().join("home");
        copy_provider_source(&source, &source, &stage, 0, &mut 0).unwrap();
        copy_provider_source(&stage, &stage, &home, 0, &mut 0).unwrap();
        let plugin = Command::new("node")
            .arg(home.join("plugin.js"))
            .output()
            .unwrap();
        assert!(plugin.status.success(), "dependency lookup: {plugin:?}");
        assert_eq!(plugin.stdout, b"dependency-nonce\n");
        let script = Command::new(home.join("scripts/run"))
            .output()
            .expect("two-stage executable must retain execute permission");
        assert!(script.status.success(), "{script:?}");
        assert_eq!(script.stdout, b"resource-nonce\n");
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_two_stage_script_retains_execute_permission() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let root = executable_fixture_directory();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("run"), "#!/bin/sh\nprintf resource-nonce\n").unwrap();
        std::fs::set_permissions(source.join("run"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let stage = root.path().join("stage");
        let home = root.path().join("home");
        copy_provider_source(&source, &source, &stage, 0, &mut 0).unwrap();
        copy_provider_source(&stage, &stage, &home, 0, &mut 0).unwrap();
        assert!(Command::new(home.join("run"))
            .output()
            .expect("two-stage script spawn")
            .status
            .success());
    }

    #[cfg(unix)]
    #[test]
    fn failed_selected_resource_copy_never_publishes_or_leaves_a_stage() {
        use freshell_runtime_protocol::{ProviderConfigReference, ProviderConfigRoot};
        use std::os::unix::{fs::symlink, net::UnixListener};
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let source = home.path().join(".claude");
        std::fs::create_dir(&source).unwrap();
        symlink("missing", source.join("dangling")).unwrap();
        let _socket = UnixListener::bind(source.join("socket")).unwrap();
        for name in ["missing", "dangling", "socket"] {
            let references = [ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: name.into(),
                provider_relative_path: format!(".claude/{name}"),
                format: "directory".into(),
            }];
            assert!(stage_provider_root(
                &capabilities,
                &format!("grant-{name}"),
                "claude",
                home.path(),
                &references,
                OpencodeEphemeralInput::default(),
                None
            )
            .is_err());
            assert!(
                !staged_provider_root_path(&capabilities, &format!("grant-{name}"))
                    .unwrap()
                    .exists()
            );
            assert_eq!(
                std::fs::read_dir(control.path().join("provider-roots"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_complete_stage_carries_project_resources_and_dependencies() {
        use freshell_runtime_protocol::{
            PreparedProviderInputs, ProviderLaunchContext, ProviderPreparation,
        };
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let skill = workspace.path().join(".claude/skills/probe");
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::create_dir_all(skill.join("node_modules/local-dependency")).unwrap();
        std::fs::write(
            home.path().join(".claude/settings.json"),
            r#"{"env":{"CLAUDE_SELECTED_NONCE":"settings-input"}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join("memory")).unwrap();
        std::fs::write(home.path().join(".claude/CLAUDE.md"), "global-memory-input\n@../first.md\n`@../missing-inline.md`\n```text\n@../missing-fenced.md\n```\n").unwrap();
        std::fs::write(home.path().join("first.md"), "@./memory/final.md\n").unwrap();
        std::fs::write(home.path().join("memory/final.md"), "imported-memory-input").unwrap();
        std::fs::write(skill.join("resource"), "adjacent-resource").unwrap();
        std::fs::write(
            skill.join("node_modules/local-dependency/index.js"),
            "module.exports='installed-dependency'",
        )
        .unwrap();
        std::fs::write(
            skill.join("probe.mjs"),
            r#"
import {readFileSync} from 'node:fs';
import dep from 'local-dependency';
process.stdout.write(readFileSync(new URL('./resource',import.meta.url),'utf8')+':'+dep);
"#,
        )
        .unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude { mcp_args: vec![] },
            mcp_capability: None,
            config: vec![],
            prepared_inputs: None,
        };
        let stage = stage_provider_root(
            &capabilities,
            "grant-claude-complete",
            "claude",
            home.path(),
            &[],
            OpencodeEphemeralInput {
                cwd: Some(workspace.path()),
                workspace: Some(workspace.path()),
                launch_context: Some(&context),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let inputs: PreparedProviderInputs = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/prepared-inputs.json"))
                .expect("complete Claude source context must be published"),
        )
        .unwrap();
        let mount = inputs
            .resource_mounts
            .iter()
            .find(|mount| {
                mount.logical_destination
                    == workspace.path().join(".claude/skills").to_str().unwrap()
            })
            .expect("project skills must be selected as a complete resource unit");
        let consumed = std::process::Command::new("node")
            .arg(
                stage
                    .join(&mount.stage_relative_path)
                    .join("probe/probe.mjs"),
            )
            .output()
            .unwrap();
        assert!(
            consumed.status.success(),
            "transported project skill must load its installed dependency"
        );
        assert_eq!(consumed.stdout, b"adjacent-resource:installed-dependency");
        let imported = inputs
            .resource_mounts
            .iter()
            .find(|mount| {
                mount.logical_destination == home.path().join("memory/final.md").to_str().unwrap()
            })
            .expect("recursive imports must retain their declaring Markdown origin");
        let imported = std::process::Command::new("node")
            .args([
                "-e",
                "process.stdout.write(require(\"node:fs\").readFileSync(process.argv[1]))",
            ])
            .arg(stage.join(&imported.stage_relative_path))
            .output()
            .unwrap();
        assert!(imported.status.success());
        assert_eq!(imported.stdout, b"imported-memory-input");
        assert!(
            inputs
                .resource_mounts
                .iter()
                .any(|mount| mount.logical_destination
                    == home.path().join(".claude/CLAUDE.md").to_str().unwrap()),
            "global memory remains selected"
        );
        assert!(
            inputs
                .config_binds
                .iter()
                .any(|bind| bind.logical_destination
                    == home.path().join(".claude/settings.json").to_str().unwrap()),
            "global settings retain declaring origin"
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_memory_private_alias_is_rejected_before_publication() {
        use freshell_runtime_protocol::{ProviderLaunchContext, ProviderPreparation};
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let capabilities = owned.path().join("capabilities");
        for path in [&home.join(".claude"), &workspace, &capabilities] {
            std::fs::create_dir_all(path).unwrap();
        }
        let private = home.join(".claude/.credentials.json");
        std::fs::write(&private, "synthetic-private-credential-nonce").unwrap();
        std::os::unix::fs::symlink(&private, home.join("ordinary.md")).unwrap();
        std::fs::write(home.join(".claude/CLAUDE.md"), "@../ordinary.md\n").unwrap();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude { mcp_args: vec![] },
            config: vec![],
            mcp_capability: None,
            prepared_inputs: None,
        };
        let error = stage_provider_root(
            &capabilities,
            "grant-claude-private-alias",
            "claude",
            &home,
            &[],
            OpencodeEphemeralInput {
                cwd: Some(&workspace),
                workspace: Some(&workspace),
                launch_context: Some(&context),
                secret_references: Some(&[]),
                ..Default::default()
            },
            None,
        )
        .expect_err("selected ordinary memory cannot expose a credential alias");
        assert!(error.contains("private") && error.contains("ordinary.md"));
        assert!(!error.contains("synthetic-private-credential-nonce"));
        assert_eq!(
            std::fs::read_to_string(private).unwrap(),
            "synthetic-private-credential-nonce"
        );
        assert!(
            !staged_provider_root_path(&capabilities, "grant-claude-private-alias")
                .unwrap()
                .exists()
        );
        assert_eq!(
            std::fs::read_dir(owned.path().join("provider-roots"))
                .unwrap()
                .count(),
            0,
            "failed selection must remove its temporary stage"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_state_aliases_are_excluded_without_filtering_dependency_basenames() {
        use freshell_runtime_protocol::{ProviderConfigReference, ProviderConfigRoot};
        use std::os::unix::fs::symlink;
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let home = tempfile::tempdir().unwrap();
        let plugins = home.path().join(".claude/plugins");
        let native = home.path().join(".claude/projects");
        std::fs::create_dir_all(&plugins).unwrap();
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(native.join("conversation.jsonl"), "native-history-nonce").unwrap();
        std::fs::write(plugins.join("history.jsonl"), "ordinary-resource-nonce").unwrap();
        symlink(
            native.join("conversation.jsonl"),
            plugins.join("native-alias"),
        )
        .unwrap();
        let refs = [ProviderConfigReference {
            root: ProviderConfigRoot::UserProvider,
            relative_path: "plugins".into(),
            provider_relative_path: ".claude/plugins".into(),
            format: "directory".into(),
        }];
        let stage = stage_provider_root(
            &capabilities,
            "grant-native-state",
            "claude",
            home.path(),
            &refs,
            Default::default(),
            None,
        )
        .unwrap();
        assert!(!stage.join("plugins/native-alias").exists());
        assert_eq!(
            std::fs::read(stage.join("plugins/history.jsonl")).unwrap(),
            b"ordinary-resource-nonce"
        );
        assert_eq!(
            std::fs::read(native.join("conversation.jsonl")).unwrap(),
            b"native-history-nonce"
        );
    }

    #[cfg(unix)]
    #[test]
    fn controller_stage_preserves_executables_and_ordinary_ephemeral_modes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join("stage");
        std::fs::create_dir(&stage).unwrap();
        let source = root.path().join("run");
        std::fs::write(&source, "#!/bin/sh\nprintf nonce").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o700)).unwrap();
        copy_ephemeral_file(&source, &stage.join("run")).unwrap();
        let target = root.path().join("outside");
        std::fs::write(&target, "sentinel").unwrap();
        symlink(&target, stage.join("alias")).unwrap();
        let before = std::fs::metadata(&target).unwrap().permissions().mode();
        allow_controller_stage_read(&stage).unwrap();
        assert_eq!(
            std::fs::metadata(stage.join("run"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o740
        );
        assert_eq!(
            std::fs::metadata(&source).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode(),
            before
        );
    }

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
        assert_eq!(
            std::fs::read_to_string(staged.join("plugins/auth.json")).unwrap(),
            "secret"
        );
        assert!(!staged.join("plugins/alias-secret.json").exists());
        assert_eq!(
            std::fs::read_to_string(staged.join("plugins/outside.txt")).unwrap(),
            "outside"
        );
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
            preparation: None,
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
                preparation: None,
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
    fn managed_mcp_lost_issue_response_reuses_one_pending_generation_and_keeps_prior() {
        let control = tempfile::tempdir().unwrap();
        let directory = control.path().join("mcp-capabilities");
        std::fs::create_dir(&directory).unwrap();
        let home = tempfile::tempdir().unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let first = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("codex", home.path(), &[])),
                Default::default(),
                None,
            )
            .unwrap();
        let callback = serde_json::to_vec(
            &serde_json::json!({"action":"issue","controlSecret":"fixture-control",
            "soulId":soul,"provider":"codex","workspace":home.path()}),
        )
        .unwrap();
        let lost = apply_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            home.path(),
        )
        .unwrap();
        let repeated = apply_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            home.path(),
        )
        .unwrap();
        let pending: McpCapabilityReference = serde_json::from_slice(&lost).unwrap();
        let retry: McpCapabilityReference = serde_json::from_slice(&repeated).unwrap();
        assert_eq!(pending.grant_id, retry.grant_id);
        assert!(staged_provider_root_path(&directory, &first.grant_id)
            .unwrap()
            .is_dir());
        assert_eq!(
            std::fs::read_dir(control.path().join("provider-roots"))
                .unwrap()
                .count(),
            2
        );
        assert!(store
            .abort_preparation(&pending.grant_id, &SoulId::new(), &directory)
            .is_err());
        assert!(staged_provider_root_path(&directory, &pending.grant_id)
            .unwrap()
            .is_dir());
    }

    #[test]
    fn managed_mcp_startup_orphan_cleanup_protects_uncertain_prior_and_pending_inputs() {
        let control = tempfile::tempdir().unwrap();
        let directory = control.path().join("mcp-capabilities");
        std::fs::create_dir(&directory).unwrap();
        let home = tempfile::tempdir().unwrap();
        let store = CapabilityStore::default();
        let pending = store
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("codex", home.path(), &[])),
                Default::default(),
                None,
            )
            .unwrap();
        let prior = staged_provider_root_path(&directory, "grant-prior-uncertain").unwrap();
        let orphan = staged_provider_root_path(&directory, "grant-confirmed-orphan").unwrap();
        std::fs::create_dir(&prior).unwrap();
        std::fs::create_dir(&orphan).unwrap();
        std::fs::write(prior.join("usable-resource"), "previous-projection-nonce").unwrap();
        {
            let mut grants = store.grants.lock().unwrap();
            let grant = grants.get_mut(&pending.grant_id).unwrap();
            grant.preparation.as_mut().unwrap().prior_grant_ids =
                vec!["grant-prior-uncertain".into()];
            write_capability(&grant.path, grant).unwrap();
        }
        cleanup_orphaned_provider_roots(&directory).unwrap();
        assert_eq!(
            std::fs::read_to_string(prior.join("usable-resource")).unwrap(),
            "previous-projection-nonce"
        );
        assert!(staged_provider_root_path(&directory, &pending.grant_id)
            .unwrap()
            .is_dir());
        assert!(!orphan.exists());
    }

    #[test]
    fn managed_mcp_generation_commit_and_abort_preserve_prior_until_accepted() {
        let control = tempfile::tempdir().unwrap();
        let dir = control.path().join("mcp-capabilities");
        std::fs::create_dir(&dir).unwrap();
        let home = tempfile::tempdir().unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let first = store
            .issue(
                soul.clone(),
                &dir,
                "http://host.docker.internal:4000".into(),
                Some(("codex", home.path(), &[])),
                Default::default(),
                None,
            )
            .unwrap();
        let second = store
            .issue_replacement(
                soul.clone(),
                &dir,
                "http://host.docker.internal:4000".into(),
                Some(("codex", home.path(), &[])),
                None,
                Some(home.path()),
            )
            .unwrap();
        let prior = staged_provider_root_path(&dir, &first.grant_id).unwrap();
        let pending = staged_provider_root_path(&dir, &second.grant_id).unwrap();
        assert!(prior.exists(), "prepare cannot retire prior inputs");
        let incarnation = IncarnationId::new();
        assert!(store
            .commit_preparation(&second.grant_id, &soul, &incarnation, &dir)
            .is_err());
        store
            .abort_preparation(&second.grant_id, &soul, &dir)
            .unwrap();
        store
            .abort_preparation(&second.grant_id, &soul, &dir)
            .unwrap();
        assert!(prior.exists());
        assert!(!pending.exists());
        let replacement = store
            .issue_replacement(
                soul.clone(),
                &dir,
                "http://host.docker.internal:4000".into(),
                Some(("codex", home.path(), &[])),
                None,
                Some(home.path()),
            )
            .unwrap();
        store
            .activate(
                &replacement.grant_id,
                soul.clone(),
                incarnation.clone(),
                &dir,
                &replacement.endpoint,
            )
            .unwrap();
        assert!(
            prior.exists(),
            "MCP activation is earlier than Host GrantAccepted"
        );
        store
            .commit_preparation(&replacement.grant_id, &soul, &incarnation, &dir)
            .unwrap();
        store
            .commit_preparation(&replacement.grant_id, &soul, &incarnation, &dir)
            .unwrap();
        assert!(!prior.exists());
        assert!(store
            .abort_preparation(&replacement.grant_id, &soul, &dir)
            .is_err());
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
                    source_plan: None,
                    ..Default::default()
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
        assert!(
            first_stage.exists(),
            "replacement preparation must retain prior usable inputs"
        );
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

    #[tokio::test]
    async fn managed_provider_replacement_keeps_accepted_original_home_origin() {
        use crate::managed_provider_references::sources::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("accepted-home");
        let later_home = owned.path().join("later-controller-home");
        let workspace = owned.path().join("workspace");
        let config = home.join(".config/opencode/opencode.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::create_dir_all(later_home.join(".config/opencode")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let raw = r#"{"agent":{"probe":{"prompt":"{file:rules}"}}}"#;
        std::fs::write(&config, raw).unwrap();
        let rules = config.parent().unwrap().join("rules");
        std::fs::write(&rules, "ACCEPTED_HOME_RESOURCE_NONCE").unwrap();
        let explicit = home.join("selected-explicit/custom.jsonc");
        std::fs::create_dir_all(explicit.parent().unwrap()).unwrap();
        let explicit_raw = r#"{"agent":{"extra":{"prompt":"{file:rules}"}}}"#;
        std::fs::write(&explicit, explicit_raw).unwrap();
        let explicit_rules = explicit.parent().unwrap().join("rules");
        std::fs::write(&explicit_rules, "EXPLICIT_ORIGIN_RESOURCE_NONCE").unwrap();
        let plan = plan_opencode_sources(
            vec![
                SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Main,
                    role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
                },
                SourceOccurrence {
                    logical_path: explicit.clone(),
                    canonical_source: explicit.clone(),
                    lane: SourceLane::Main,
                    role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
                },
            ],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let context = crate::managed_provider_bootstrap::provider_launch_context_from_home(
            "opencode", &workspace, &home, None,
        )
        .unwrap()
        .unwrap();
        let references = [rules.clone(), explicit_rules.clone()]
            .into_iter()
            .enumerate()
            .map(
                |(index, path)| freshell_runtime_protocol::ProviderSecretReference {
                    source_path: path.to_str().unwrap().into(),
                    profile:
                        freshell_runtime_protocol::ProviderSecretProfile::OpencodeConfigurationFile,
                    provider_relative_path: Some(format!(".freshell/references/{index}")),
                },
            )
            .collect::<Vec<_>>();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &context.config)),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    launch_context: Some(&context),
                    secret_references: Some(&references),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let accepted = read_prepared_context(&directory, &prior).unwrap();
        let prior_stage = staged_provider_root_path(&directory, &prior.grant_id).unwrap();
        let manifest_path = prior_stage.join(".freshell/input-manifest.json");
        let manifest_bytes = std::fs::read(&manifest_path).unwrap();
        let manifest_before: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
        let callback=serde_json::to_vec(&serde_json::json!({"action":"issue","controlSecret":"fixture-control","soulId":soul,
            "provider":"opencode","workspace":workspace,"cwd":workspace,"priorContext":accepted,"providerSecretReferences":references,
            "authLookupAuthority":"fixture-owned-attempt"})).unwrap();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let mut foreign: serde_json::Value = serde_json::from_slice(&callback).unwrap();
        foreign["soulId"] = serde_json::json!(SoulId::new());
        assert!(
            apply_prepared_callback(
                &serde_json::to_vec(&foreign).unwrap(),
                "fixture-control",
                &store,
                &directory,
                "http://host.docker.internal:4000",
                &later_home,
                &client
            )
            .await
            .is_err(),
            "another soul cannot select this private origin manifest"
        );
        let mut corrupted = manifest_before;
        corrupted["originalHome"] = serde_json::json!(later_home);
        std::fs::write(&manifest_path, serde_json::to_vec(&corrupted).unwrap()).unwrap();
        assert!(
            apply_prepared_callback(
                &callback,
                "fixture-control",
                &store,
                &directory,
                "http://host.docker.internal:4000",
                &later_home,
                &client
            )
            .await
            .is_err(),
            "origin metadata must retain its approved manifest identity"
        );
        std::fs::write(&manifest_path, &manifest_bytes).unwrap();
        let reply = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &later_home,
            &client,
        )
        .await
        .unwrap();
        let ready: freshell_runtime_protocol::PreparedProviderContext =
            serde_json::from_slice(&reply).unwrap();
        assert_eq!(ready.provider_secret_references.len(),2,"reissue must keep accepted original HOME and ordered explicit sources instead of rediscovering the controller environment");
        assert_eq!(
            ready.provider_secret_references[0].source_path,
            rules.to_str().unwrap()
        );
        assert_eq!(
            ready.provider_secret_references[1].source_path,
            explicit_rules.to_str().unwrap()
        );
        assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
        assert_eq!(std::fs::read_to_string(&explicit).unwrap(), explicit_raw);
        assert!(staged_provider_root_path(&directory, &prior.grant_id)
            .unwrap()
            .is_dir());
    }

    #[cfg(feature = "managed-provider-qualification")]
    #[tokio::test]
    async fn managed_provider_codex_native_typed_inputs_survive_transport() {
        use freshell_platform::provider_environment::{
            copy_environment, CopyLimits, CopySelection,
        };
        use freshell_runtime_protocol::{ProviderLaunchContext, ProviderPreparation};
        use sha2::{Digest, Sha256};
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let owned = executable_fixture_directory();
        let original = owned.path().join("original-home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(original.join(".codex/agents/nested")).unwrap();
        std::fs::create_dir_all(workspace.join(".codex/skills/probe/scripts")).unwrap();
        std::fs::create_dir(workspace.join(".git")).unwrap();
        let config = format!("model_instructions_file = 'user.md'\n[[skills.config]]\npath = 'absent-skill'\nenabled = false\n[projects.{}]\ntrust_level = 'trusted'\n[agents.reader]\nconfig_file = 'agents/nested/reader.toml'\n",serde_json::to_string(workspace.to_str().unwrap()).unwrap());
        std::fs::write(original.join(".codex/config.toml"), &config).unwrap();
        std::fs::write(original.join(".codex/user.md"), "user-instructions-nonce").unwrap();
        std::fs::write(
            original.join(".codex/agents/nested/reader.toml"),
            "model_instructions_file = 'role.md'\n",
        )
        .unwrap();
        std::fs::write(
            original.join(".codex/agents/nested/role.md"),
            "role-instructions-nonce",
        )
        .unwrap();
        std::fs::write(
            workspace.join(".codex/config.toml"),
            "model_instructions_file = 'project.md'\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join(".codex/project.md"),
            "project-instructions-nonce",
        )
        .unwrap();
        std::fs::write(workspace.join(".codex/skills/probe/SKILL.md"),"---\nname: transport-probe\ndescription: Synthetic executable resource fixture\n---\nRun scripts/run to read the adjacent complete resource.\n").unwrap();
        std::fs::write(
            workspace.join(".codex/skills/probe/resource.txt"),
            "skill-resource-nonce",
        )
        .unwrap();
        let script = workspace.join(".codex/skills/probe/scripts/run");
        std::fs::write(
            &script,
            "#!/bin/sh\ncat \"$(dirname \"$0\")/../resource.txt\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mcp = crate::managed_provider_bootstrap::managed_codex_mcp_args().unwrap();
        let context = ProviderLaunchContext {
            config: vec![],
            mcp_capability: None,
            prepared_inputs: None,
            preparation: ProviderPreparation::Codex {
                tui_args: mcp.clone(),
                sidecar_args: mcp,
            },
        };
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let grant = store
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("codex", &original, &[])),
                OpencodeEphemeralInput {
                    launch_context: Some(&context),
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let context = crate::fresh_agent_proxy::context_for_fresh_provider(Some(
            read_prepared_context(&directory, &grant).unwrap(),
        ))
        .unwrap();
        let inputs = context.prepared_inputs.as_ref().unwrap();
        let stage = staged_provider_root_path(&directory, &grant.grant_id).unwrap();
        let physical = Path::new("/home/freshell/provider");
        assert!(physical.is_dir());
        let selections = inputs
            .resource_mounts
            .iter()
            .map(|unit| CopySelection {
                source: stage.join(&unit.stage_relative_path),
                destination_relative: unit.provider_relative_path.clone().into(),
            })
            .collect::<Vec<_>>();
        copy_environment(&selections, physical, &[], CopyLimits::default()).unwrap();
        // The original fixture remains preserved byte-for-byte. Native reads
        // only descriptor projections at each accepted logical path.
        let archived = owned.path().join("archived-home");
        std::fs::rename(&original, &archived).unwrap();
        let archived_project = owned.path().join("archived-project-config");
        std::fs::rename(workspace.join(".codex"), &archived_project).unwrap();
        for bind in &inputs.config_binds {
            let destination = Path::new(&bind.effective_destination);
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(stage.join(&bind.source_relative_path), destination)
                .unwrap();
        }
        for unit in &inputs.resource_mounts {
            let destination = Path::new(&unit.effective_destination);
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(physical.join(&unit.provider_relative_path), destination)
                .unwrap();
        }
        let version = std::process::Command::new("/usr/local/bin/codex")
            .arg("--version")
            .output()
            .unwrap();
        assert!(version.status.success());
        assert_eq!(
            String::from_utf8(version.stdout).unwrap().trim(),
            "codex-cli 0.147.0"
        );
        let mut child = tokio::process::Command::new("/usr/local/bin/codex")
            .arg("app-server")
            .args(match &context.preparation {
                ProviderPreparation::Codex { sidecar_args, .. } => sidecar_args.clone(),
                _ => panic!("Codex context missing"),
            })
            .current_dir(&workspace)
            .env("HOME", physical)
            .env("CODEX_HOME", physical.join(".codex"))
            .env_remove("OPENAI_API_KEY")
            .env_remove("FRESHELL_CLAUDE_SDK_QUERY_MODULE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        async fn request(
            stdin: &mut tokio::process::ChildStdin,
            stdout: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
            id: u64,
            method: &str,
            params: serde_json::Value,
        ) -> serde_json::Value {
            stdin
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::json!({"id":id,"method":method,"params":params})
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(25), async {
                loop {
                    let line = stdout
                        .next_line()
                        .await
                        .unwrap()
                        .expect("native Codex app-server ended before response");
                    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if response.get("id").and_then(serde_json::Value::as_u64) == Some(id) {
                        assert!(
                            response.get("error").is_none(),
                            "native Codex request {method} failed"
                        );
                        return response["result"].clone();
                    }
                }
            })
            .await
            .expect("native Codex source consumer response deadline")
        }
        request(&mut stdin,&mut stdout,1,"initialize",serde_json::json!({"clientInfo":{"name":"freshell-fixture","version":"1"},"capabilities":{"experimentalApi":true}})).await;
        stdin
            .write_all(b"{\"method\":\"initialized\"}\n")
            .await
            .unwrap();
        let resolved = request(
            &mut stdin,
            &mut stdout,
            2,
            "config/read",
            serde_json::json!({"includeLayers":true,"cwd":workspace}),
        )
        .await;
        assert_eq!(
            resolved["config"]["model_instructions_file"].as_str(),
            Some(workspace.join(".codex/project.md").to_str().unwrap())
        );
        assert_eq!(
            resolved["config"]["mcp_servers"]["freshell"]["command"], "node",
            "actual native app-server must consume the retained fresh provider argv"
        );
        assert_eq!(
            resolved["config"]["mcp_servers"]["freshell"]["args"],
            serde_json::json!(["/opt/freshell-mcp/server.js"])
        );
        let skills = request(
            &mut stdin,
            &mut stdout,
            3,
            "skills/list",
            serde_json::json!({"cwds":[workspace],"forceReload":true}),
        )
        .await;
        let found = skills["data"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|data| data["skills"].as_array().unwrap())
            .any(|skill| skill["name"] == "transport-probe");
        assert!(
            found,
            "native Codex must discover the transported project skill"
        );
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        let resource =
            std::process::Command::new(workspace.join(".codex/skills/probe/scripts/run"))
                .output()
                .unwrap();
        assert!(resource.status.success());
        assert_eq!(resource.stdout, b"skill-resource-nonce");
        assert_eq!(
            std::fs::read_to_string(archived.join(".codex/config.toml")).unwrap(),
            config
        );
        for (case, bytes) in [
            (
                "native-config-read",
                b"project-instructions-nonce".as_slice(),
            ),
            ("native-skills-list", b"transport-probe".as_slice()),
            ("executable-resource", b"skill-resource-nonce".as_slice()),
            (
                "native-retained-mcp-args",
                b"node:/opt/freshell-mcp/server.js".as_slice(),
            ),
        ] {
            println!(
                "provider_source_consumer {}",
                serde_json::json!({"provider":"codex","case":case,"digest":format!("{:x}",Sha256::digest(bytes))})
            );
        }
    }

    #[test]
    fn managed_provider_codex_selected_inputs_reach_private_generation() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".codex/agents/nested")).unwrap();
        std::fs::create_dir_all(workspace.join(".codex/skills/fixture/scripts")).unwrap();
        std::fs::create_dir(workspace.join(".git")).unwrap();
        let raw = format!("model_instructions_file = 'instructions.md'\n[projects.{}]\ntrust_level = 'trusted'\n[agents.reader]\nconfig_file = 'agents/nested/reader.toml'\n", serde_json::to_string(workspace.to_str().unwrap()).unwrap());
        std::fs::write(home.join(".codex/config.toml"), &raw).unwrap();
        std::fs::write(home.join(".codex/instructions.md"), "home-input").unwrap();
        std::fs::write(
            home.join(".codex/agents/nested/reader.toml"),
            "model_instructions_file = 'instructions.md'\n",
        )
        .unwrap();
        std::fs::write(
            home.join(".codex/agents/nested/instructions.md"),
            "role-input",
        )
        .unwrap();
        std::fs::write(
            workspace.join(".codex/config.toml"),
            "model_instructions_file = 'instructions.md'\n",
        )
        .unwrap();
        std::fs::write(workspace.join(".codex/instructions.md"), "project-input").unwrap();
        std::fs::write(
            workspace.join(".codex/skills/fixture/SKILL.md"),
            "skill-resource",
        )
        .unwrap();
        let context = crate::managed_provider_bootstrap::provider_launch_context_from_home(
            "codex", &workspace, &home, None,
        )
        .unwrap()
        .unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let capability = store
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("codex", &home, &context.config)),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    launch_context: Some(&context),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let accepted = read_prepared_context(&directory, &capability).unwrap();
        let inputs = accepted
            .prepared_inputs
            .expect("Codex selected layers and typed resources must be accepted as one generation");
        let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
        for (logical, expected) in [
            (home.join(".codex/instructions.md"), "home-input"),
            (
                home.join(".codex/agents/nested/instructions.md"),
                "role-input",
            ),
            (workspace.join(".codex/instructions.md"), "project-input"),
        ] {
            let mount = inputs
                .resource_mounts
                .iter()
                .find(|mount| mount.logical_destination == logical.to_str().unwrap())
                .expect("ordinary selected resource must retain its original absolute alias");
            assert_eq!(
                std::fs::read_to_string(stage.join(&mount.stage_relative_path)).unwrap(),
                expected
            );
        }
        assert!(inputs
            .resource_mounts
            .iter()
            .any(|mount| mount.logical_destination
                == workspace.join(".codex/skills").to_str().unwrap()));
        assert!(inputs
            .config_binds
            .iter()
            .any(|bind| bind.logical_destination
                == workspace.join(".codex/config.toml").to_str().unwrap()));
        assert_eq!(
            std::fs::read_to_string(home.join(".codex/config.toml")).unwrap(),
            raw
        );
    }

    #[tokio::test]
    async fn managed_provider_legacy_codex_origin_unknown_blocks_and_retains_inputs() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("current-home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(
            home.join(".codex/config.toml"),
            "model_instructions_file='./current.md'\n",
        )
        .unwrap();
        std::fs::write(
            home.join(".codex/current.md"),
            b"must not substitute current HOME",
        )
        .unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let endpoint = "http://host.docker.internal:4000";
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                endpoint.into(),
                None,
                Default::default(),
                None,
            )
            .unwrap();
        let legacy_root = staged_provider_root_path(&directory, &prior.grant_id).unwrap();
        std::fs::create_dir_all(&legacy_root).unwrap();
        std::fs::write(
            legacy_root.join("retained-resource"),
            b"retained legacy resource",
        )
        .unwrap();
        let private_before =
            std::fs::read(grant_path(&directory, &prior.grant_id).unwrap()).unwrap();
        let context = freshell_runtime_protocol::ProviderLaunchContext {
            preparation: freshell_runtime_protocol::ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
            config: vec![],
            mcp_capability: Some(prior.clone()),
            prepared_inputs: None,
        };
        let callback=serde_json::to_vec(&serde_json::json!({"action":"issue","controlSecret":"fixture-control","soulId":soul,"provider":"codex","workspace":workspace,"cwd":workspace,"priorContext":context,"providerSecretReferences":[],"authLookupAuthority":"fixture-owned-attempt"})).unwrap();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let error = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            endpoint,
            &home,
            &client,
        )
        .await
        .err()
        .expect(
            "legacy metadata cannot grant current HOME authority for an unrecorded original source",
        );
        assert!(error.contains("original Codex source origins are unrecorded"));
        assert!(
            std::fs::read(grant_path(&directory, &prior.grant_id).unwrap()).unwrap()
                == private_before,
            "unknown origins must retain the original private capability unchanged"
        );
        assert_eq!(
            std::fs::read(legacy_root.join("retained-resource")).unwrap(),
            b"retained legacy resource"
        );
        assert_eq!(
            std::fs::read_dir(directory.parent().unwrap().join("provider-roots"))
                .unwrap()
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn managed_provider_claude_replacement_retains_original_sources_and_pending_replay() {
        use freshell_runtime_protocol::{
            PreparedProviderContext, ProviderLaunchContext, ProviderPreparation,
        };
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("original-home");
        let wrong = owned.path().join("current-home");
        let workspace = owned.path().join("workspace");
        for path in [
            &home.join(".claude/skills/probe"),
            &wrong.join(".claude"),
            &workspace,
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            home.join(".claude/settings.json"),
            r#"{"env":{"CLAUDE_SELECTED":"original"}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".claude/skills/probe/resource"),
            b"retained-original-resource",
        )
        .unwrap();
        std::fs::write(
            wrong.join(".claude/settings.json"),
            r#"{"env":{"CLAUDE_SELECTED":"wrong"}}"#,
        )
        .unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude { mcp_args: vec![] },
            mcp_capability: None,
            config: vec![],
            prepared_inputs: None,
        };
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("claude", &home, &context.config)),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    launch_context: Some(&context),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let context = read_prepared_context(&directory, &prior).unwrap();
        assert!(context.prepared_inputs.is_some());
        let callback=serde_json::to_vec(&serde_json::json!({"action":"issue","controlSecret":"fixture-control","soulId":soul,"provider":"claude","workspace":workspace,"cwd":workspace,"priorContext":context,"providerSecretReferences":[]})).unwrap();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let first = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &wrong,
            &client,
        )
        .await
        .expect("replacement must select recorded original Claude sources");
        std::fs::remove_file(home.join(".claude/settings.json")).unwrap();
        let repeated = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &wrong,
            &client,
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&first).unwrap(),
            serde_json::from_slice::<serde_json::Value>(&repeated).unwrap(),
            "pending generation replay must precede original rescanning"
        );
        let ready: PreparedProviderContext = serde_json::from_slice(&repeated).unwrap();
        let inputs = ready
            .provider_launch_context
            .prepared_inputs
            .as_ref()
            .unwrap();
        let mount = inputs
            .resource_mounts
            .iter()
            .find(|mount| mount.logical_destination == "/home/freshell/provider/.claude/skills")
            .unwrap();
        let stage = staged_provider_root_path(
            &directory,
            &ready
                .provider_launch_context
                .mcp_capability
                .as_ref()
                .unwrap()
                .grant_id,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(
                stage
                    .join(&mount.stage_relative_path)
                    .join("probe/resource")
            )
            .unwrap(),
            b"retained-original-resource"
        );
    }

    #[tokio::test]
    async fn managed_provider_replacement_complete_codex_metadata_replays_before_rescanning_roots()
    {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".codex/skills/owned")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "model = 'synthetic'\n").unwrap();
        std::fs::write(
            home.join(".codex/skills/owned/runner.sh"),
            "synthetic retained resource",
        )
        .unwrap();
        let mut context = crate::managed_provider_bootstrap::provider_launch_context_from_home(
            "codex", &workspace, &home, None,
        )
        .unwrap()
        .unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("codex", &home, &context.config)),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    launch_context: Some(&context),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        context = read_prepared_context(&directory, &prior).unwrap();
        assert!(context.prepared_inputs.is_some());
        let callback = serde_json::to_vec(
            &serde_json::json!({"action":"issue","controlSecret":"fixture-control","soulId":soul,
            "provider":"codex","workspace":workspace,"cwd":workspace,"priorContext":context,
            "providerSecretReferences":[],"authLookupAuthority":"fixture-owned-attempt"}),
        )
        .unwrap();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let first = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &home,
            &client,
        )
        .await
        .unwrap();
        std::fs::remove_file(home.join(".codex/config.toml")).unwrap();
        std::fs::write(home.join(".codex/new.config.toml"), "model = 'changed'\n").unwrap();
        let repeated = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &home,
            &client,
        )
        .await
        .unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&repeated).unwrap(),serde_json::from_slice::<serde_json::Value>(&first).unwrap(),
            "a complete pending context must retain its exact selected root metadata in every provider route");
        let ready: freshell_runtime_protocol::PreparedProviderContext =
            serde_json::from_slice(&repeated).unwrap();
        let resource = ready
            .provider_launch_context
            .prepared_inputs
            .as_ref()
            .unwrap()
            .resource_mounts
            .iter()
            .find(|mount| mount.logical_destination == "/home/freshell/provider/.codex/skills")
            .unwrap()
            .stage_relative_path
            .clone();
        let stage = staged_provider_root_path(
            &directory,
            &ready
                .provider_launch_context
                .mcp_capability
                .as_ref()
                .unwrap()
                .grant_id,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(stage.join(resource).join("owned/runner.sh")).unwrap(),
            "synthetic retained resource"
        );
        assert_eq!(
            std::fs::read_dir(owned.path().join("control/provider-roots"))
                .unwrap()
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn managed_provider_selected_tui_keeps_origin_and_applies_owned_edits_before_references()
    {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let config = workspace.join("selected-tui.jsonc");
        let raw = "{ // original comment\n\"theme\":\"{file:./theme.txt}\",\"plugin\":[],}";
        std::fs::write(&config, raw).unwrap();
        let theme = workspace.join("theme.txt");
        std::fs::write(&theme, "dark").unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        for disabled in [false, true] {
            let soul = SoulId::new();
            let prepared =
                crate::managed_provider_references::prepare_managed_opencode_with_publisher(
                    crate::managed_provider_references::OpencodePreparation {
                        client: &client,
                        soul: &soul,
                        creation_seed: "fixture-existing-soul",
                        home: &home,
                        cwd: &workspace,
                        workspace: &workspace,
                        original: &|name| match name {
                            "OPENCODE_TUI_CONFIG" => Some("selected-tui.jsonc".into()),
                            "FRESHELL_OPENCODE_REBIND" if disabled => Some("0".into()),
                            _ => None,
                        },
                        references: vec![],
                        auth_authority: Some("fixture-owned-attempt"),
                        selected_sources: None,
                        accepted_global_root: None,
                        selected_resource_roots: None,
                        native_source_flags: None,
                        rebind_enabled: None,
                        inherited_inline: None,
                        inline_edits: None,
                    },
                    |soul, home, context, input| {
                        let capability = store.issue(
                            soul.clone(),
                            &directory,
                            "http://host.docker.internal:4000".into(),
                            Some(("opencode", home, &context.config)),
                            OpencodeEphemeralInput {
                                launch_context: Some(context),
                                ..input
                            },
                            None,
                        )?;
                        read_prepared_context(&directory, &capability)
                    },
                )
                .await
                .expect("selected TUI must remain supported through the shared managed producer");
            let stage = staged_provider_root_path(
                &directory,
                &prepared.context.mcp_capability.as_ref().unwrap().grant_id,
            )
            .unwrap();
            let manifest: freshell_platform::opencode_recipe::SourceManifest =
                serde_json::from_slice(
                    &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                )
                .unwrap();
            assert_eq!(manifest.rebind_enabled, !disabled);
            assert_eq!(manifest.native_source_flags.len(), 1);
            assert_eq!(
                manifest.native_source_flags[0].kind.variable(),
                "OPENCODE_TUI_CONFIG"
            );
            let effective =
                std::fs::read_to_string(stage.join(&manifest.sources[0].unexpanded_relative_path))
                    .unwrap();
            let effective =
                freshell_platform::opencode_config::parse_jsonc_object(&effective).unwrap();
            assert_eq!(effective["theme"], "{file:./theme.txt}");
            assert_eq!(
            effective["plugin"],
            if disabled { serde_json::json!([]) } else { serde_json::json!([
                "file:///home/freshell/provider/.freshell/opencode/freshell-rebind-plugin.ts"
            ]) },
            "selected rebind normalization must precede the source view used by reference recipes"
        );
            assert_eq!(prepared.references[0].source_path, theme.to_str().unwrap());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
            let callback = serde_json::to_vec(&serde_json::json!({"action":"issue","controlSecret":"fixture-control","soulId":soul,
                "provider":"opencode","workspace":workspace,"cwd":workspace,"priorContext":prepared.context,
                "providerSecretReferences":prepared.references,"authLookupAuthority":"fixture-owned-attempt"})).unwrap();
            let reissued = apply_prepared_callback(
                &callback,
                "fixture-control",
                &store,
                &directory,
                "http://host.docker.internal:4000",
                &home,
                &client,
            )
            .await
            .unwrap();
            let reissued: PreparedProviderContext = serde_json::from_slice(&reissued).unwrap();
            let stage = staged_provider_root_path(
                &directory,
                &reissued
                    .provider_launch_context
                    .mcp_capability
                    .as_ref()
                    .unwrap()
                    .grant_id,
            )
            .unwrap();
            let retained: freshell_platform::opencode_recipe::SourceManifest =
                serde_json::from_slice(
                    &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                )
                .unwrap();
            assert_eq!(
                retained.rebind_enabled, !disabled,
                "reissue must preserve request-only owned edits with current control absent"
            );
            let retained = freshell_platform::opencode_config::parse_jsonc_object(
                &std::fs::read_to_string(stage.join(&retained.sources[0].unexpanded_relative_path))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(retained["plugin"], effective["plugin"]);
        }
    }

    #[tokio::test]
    async fn managed_provider_inline_source_uses_instance_origin_after_owned_mcp_edits() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let config = workspace.join("selected-tui.jsonc");
        let raw = r#"{"agent":{"probe":{"prompt":"{file:./theme.txt}"}}}"#;
        std::fs::write(&config, raw).unwrap();
        let theme = workspace.join("theme.txt");
        std::fs::write(&theme, "dark").unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        for fresh in [false, true] {
            let soul = SoulId::new();
            let prepared =
                crate::managed_provider_references::prepare_managed_opencode_with_publisher(
                    crate::managed_provider_references::OpencodePreparation {
                        client: &client,
                        soul: &soul,
                        creation_seed: "fixture-existing-soul",
                        home: &home,
                        cwd: &workspace,
                        workspace: &workspace,
                        original: &|name| (name == "OPENCODE_CONFIG_CONTENT").then(|| raw.into()),
                        references: vec![],
                        auth_authority: Some("fixture-owned-attempt"),
                        selected_sources: None,
                        accepted_global_root: None,
                        selected_resource_roots: None,
                        native_source_flags: None,
                        rebind_enabled: None,
                        inherited_inline: None,
                        inline_edits: Some(freshell_platform::opencode_config::OwnedConfigEdits {
                            disable_snapshots: fresh,
                            ..Default::default()
                        }),
                    },
                    |soul, home, context, input| {
                        let capability = store.issue(
                            soul.clone(),
                            &directory,
                            "http://host.docker.internal:4000".into(),
                            Some(("opencode", home, &context.config)),
                            OpencodeEphemeralInput {
                                launch_context: Some(context),
                                ..input
                            },
                            None,
                        )?;
                        read_prepared_context(&directory, &capability)
                    },
                )
                .await
                .expect("inline config must remain supported through the shared managed producer");
            let stage = staged_provider_root_path(
                &directory,
                &prepared.context.mcp_capability.as_ref().unwrap().grant_id,
            )
            .unwrap();
            let manifest: freshell_platform::opencode_recipe::SourceManifest =
                serde_json::from_slice(
                    &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                )
                .unwrap();
            assert!(manifest.native_source_flags.is_empty());
            let effective =
                std::fs::read_to_string(stage.join(&manifest.sources[0].unexpanded_relative_path))
                    .unwrap();
            let effective: serde_json::Value = serde_json::from_str(&effective).unwrap();
            assert_eq!(effective["agent"]["probe"]["prompt"], "{file:./theme.txt}");
            assert_eq!(
                effective["mcp"]["freshell"]["command"],
                serde_json::json!(["node", "/opt/freshell-mcp/server.js"])
            );
            assert_eq!(manifest.inline_edits.disable_snapshots, fresh);
            assert_eq!(
                effective["snapshot"],
                if fresh {
                    serde_json::json!(false)
                } else {
                    serde_json::Value::Null
                }
            );
            assert_eq!(prepared.references[0].source_path, theme.to_str().unwrap());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
            let callback = serde_json::to_vec(&serde_json::json!({"action":"issue","controlSecret":"fixture-control","soulId":soul,
            "provider":"opencode","workspace":workspace,"cwd":workspace,"priorContext":prepared.context,
            "providerSecretReferences":prepared.references,"authLookupAuthority":"fixture-owned-attempt"})).unwrap();
            let reissued = apply_prepared_callback(
                &callback,
                "fixture-control",
                &store,
                &directory,
                "http://host.docker.internal:4000",
                &home,
                &client,
            )
            .await
            .unwrap();
            let reissued: PreparedProviderContext = serde_json::from_slice(&reissued).unwrap();
            let stage = staged_provider_root_path(
                &directory,
                &reissued
                    .provider_launch_context
                    .mcp_capability
                    .as_ref()
                    .unwrap()
                    .grant_id,
            )
            .unwrap();
            let retained: freshell_platform::opencode_recipe::SourceManifest =
                serde_json::from_slice(
                    &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                )
                .unwrap();
            let retained = freshell_platform::opencode_config::parse_jsonc_object(
                &std::fs::read_to_string(stage.join(&retained.sources[0].unexpanded_relative_path))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(retained, effective, "request-only inline source and owned edits must survive reissue without current inline env");
        }
    }

    #[test]
    fn managed_provider_selected_config_root_stages_complete_writable_dependencies() {
        use crate::managed_provider_references::sources::*;
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let selected = workspace.join(".opencode");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(selected.join("plugins/probe/node_modules/dependency")).unwrap();
        let raw = r#"{"plugin":["./plugins/probe/index.js"]}"#;
        std::fs::write(selected.join("opencode.json"), raw).unwrap();
        std::fs::write(
            selected.join("plugins/probe/index.js"),
            "export default {};",
        )
        .unwrap();
        std::fs::write(
            selected.join("plugins/probe/node_modules/dependency/index.js"),
            "dependency-nonce",
        )
        .unwrap();
        let sources = discover_opencode(OpencodeDiscovery {
            home: &home,
            cwd: &workspace,
            worktree: &workspace,
            config_root: &home.join(".config/opencode"),
            env: &|_| None,
        })
        .unwrap();
        let plan = plan_opencode_sources(sources, &workspace, &home, &|_, _, _| None).unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let capability = store
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &[])),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    secret_references: Some(&[]),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
        let inputs: PreparedProviderInputs = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/prepared-inputs.json")).unwrap(),
        )
        .unwrap();
        let root = inputs
            .resource_mounts
            .iter()
            .find(|mount| mount.logical_destination == selected.to_str().unwrap())
            .expect("selected config directories require complete writable soul-backed roots");
        assert_eq!(root.kind, ProviderResourceKind::Directory);
        assert_eq!(
            std::fs::read_to_string(
                stage
                    .join(&root.stage_relative_path)
                    .join("plugins/probe/node_modules/dependency/index.js")
            )
            .unwrap(),
            "dependency-nonce"
        );
        assert_eq!(
            std::fs::read_to_string(selected.join("opencode.json")).unwrap(),
            raw
        );
    }

    #[tokio::test]
    async fn managed_provider_selected_directory_without_config_retains_discovery_resources() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let selected = owned.path().join("selected-config-directory");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(selected.join("skills/probe")).unwrap();
        std::fs::write(
            selected.join("skills/probe/SKILL.md"),
            "skill-resource-nonce",
        )
        .unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let prepared = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
            crate::managed_provider_references::OpencodePreparation {
                client: &client,
                soul: &soul,
                creation_seed: "existing-fixture",
                home: &home,
                cwd: &workspace,
                workspace: &workspace,
                original: &|name| {
                    (name == "OPENCODE_CONFIG_DIR").then(|| selected.to_str().unwrap().into())
                },
                references: vec![],
                auth_authority: Some("existing-owned-attempt"),
                selected_sources: None,
                accepted_global_root: None,
                selected_resource_roots: None,
                native_source_flags: None,
                rebind_enabled: None,
                inherited_inline: None,
                inline_edits: None,
            },
            |soul, home, context, input| {
                let capability = store.issue(
                    soul.clone(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", home, &context.config)),
                    OpencodeEphemeralInput {
                        launch_context: Some(context),
                        ..input
                    },
                    None,
                )?;
                read_prepared_context(&directory, &capability)
            },
        )
        .await
        .unwrap();
        let inputs = prepared.context.prepared_inputs.as_ref().unwrap();
        let unit = inputs
            .resource_mounts
            .iter()
            .find(|mount| mount.logical_destination == selected.to_str().unwrap())
            .expect(
                "explicit config directory resources remain selected even with no JSON config leaf",
            );
        let stage = staged_provider_root_path(&directory, &inputs.generation_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                stage
                    .join(&unit.stage_relative_path)
                    .join("skills/probe/SKILL.md")
            )
            .unwrap(),
            "skill-resource-nonce"
        );
        let manifest: freshell_platform::opencode_recipe::SourceManifest = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
        )
        .unwrap();
        assert!(
            manifest
                .native_source_flags
                .iter()
                .any(|flag| flag.kind.variable() == "OPENCODE_CONFIG_DIR"
                    && flag.runtime_destination == selected.to_str().unwrap()),
            "the native directory selection must activate the exact selected root"
        );
        std::fs::write(
            selected.join("skills/probe/SKILL.md"),
            "skill-resource-refreshed",
        )
        .unwrap();
        let callback = serde_json::to_vec(&serde_json::json!({
            "controlSecret":"fixture-control", "action":"issue", "provider":"opencode", "soulId":soul,
            "priorContext":prepared.context, "providerSecretReferences":[], "workspace":workspace,
            "cwd":workspace, "authLookupAuthority":"existing-owned-attempt",
        })).unwrap();
        let reissued: PreparedProviderContext = serde_json::from_slice(
            &apply_prepared_callback(
                &callback,
                "fixture-control",
                &store,
                &directory,
                "http://host.docker.internal:4000",
                &home,
                &client,
            )
            .await
            .unwrap(),
        )
        .unwrap();
        let next = reissued
            .provider_launch_context
            .prepared_inputs
            .as_ref()
            .unwrap();
        let next_unit = next
            .resource_mounts
            .iter()
            .find(|mount| mount.logical_destination == selected.to_str().unwrap())
            .unwrap();
        let next_stage = staged_provider_root_path(&directory, &next.generation_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                next_stage
                    .join(&next_unit.stage_relative_path)
                    .join("skills/probe/SKILL.md")
            )
            .unwrap(),
            "skill-resource-refreshed"
        );
        let next_manifest: freshell_platform::opencode_recipe::SourceManifest =
            serde_json::from_slice(
                &std::fs::read(next_stage.join(".freshell/input-manifest.json")).unwrap(),
            )
            .unwrap();
        assert!(next_manifest.native_source_flags.iter().any(|flag| flag.kind.variable() == "OPENCODE_CONFIG_DIR" && flag.runtime_destination == selected.to_str().unwrap()), "reissue must retain accepted directory selection when current controller env has no selector");
        assert!(
            stage.exists(),
            "pending replacement cannot retire the previous usable roots"
        );
    }

    #[tokio::test]
    async fn managed_provider_replacement_retains_accepted_global_root_without_current_xdg() {
        use freshell_runtime_protocol::*;
        for document in [false, true] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let workspace = owned.path().join("workspace");
            let xdg = owned.path().join("accepted-xdg");
            let global = xdg.join("opencode");
            std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::create_dir_all(global.join("plugins/probe")).unwrap();
            std::fs::write(
                global.join("plugins/probe/resource"),
                "accepted-global-resource",
            )
            .unwrap();
            if document {
                std::fs::write(
                    global.join("opencode.json"),
                    r#"{"plugin":["./plugins/probe/index.mjs"]}"#,
                )
                .unwrap();
            }
            std::fs::write(
                global.join("plugins/probe/index.mjs"),
                "export default async()=>({});",
            )
            .unwrap();
            let directory = owned.path().join("control/mcp-capabilities");
            std::fs::create_dir_all(&directory).unwrap();
            let store = CapabilityStore::default();
            let soul = SoulId::new();
            let client = freshell_runtime_client::RuntimeClient::new(
                owned.path().join("unused.sock"),
                "fixture-control",
            );
            let prepared =
                crate::managed_provider_references::prepare_managed_opencode_with_publisher(
                    crate::managed_provider_references::OpencodePreparation {
                        client: &client,
                        soul: &soul,
                        creation_seed: "existing-fixture",
                        home: &home,
                        cwd: &workspace,
                        workspace: &workspace,
                        original: &|name| {
                            (name == "XDG_CONFIG_HOME").then(|| xdg.to_str().unwrap().into())
                        },
                        references: vec![],
                        auth_authority: Some("existing-owned-attempt"),
                        selected_sources: None,
                        accepted_global_root: None,
                        selected_resource_roots: None,
                        native_source_flags: None,
                        rebind_enabled: None,
                        inherited_inline: None,
                        inline_edits: None,
                    },
                    |soul, home, context, input| {
                        let capability = store.issue(
                            soul.clone(),
                            &directory,
                            "http://host.docker.internal:4000".into(),
                            Some(("opencode", home, &context.config)),
                            OpencodeEphemeralInput {
                                launch_context: Some(context),
                                ..input
                            },
                            None,
                        )?;
                        read_prepared_context(&directory, &capability)
                    },
                )
                .await
                .unwrap();
            let prior = prepared.context.mcp_capability.as_ref().unwrap();
            let prior_stage = staged_provider_root_path(&directory, &prior.grant_id).unwrap();
            assert_eq!(
                std::fs::read_to_string(prior_stage.join("plugins/probe/resource")).unwrap(),
                "accepted-global-resource"
            );
            if document {
                use sha2::Digest;
                let manifest_path = prior_stage.join(".freshell/input-manifest.json");
                let current = std::fs::read(&manifest_path).unwrap();
                let mut legacy: serde_json::Value = serde_json::from_slice(&current).unwrap();
                for source in legacy["sources"].as_array_mut().unwrap() {
                    source.as_object_mut().unwrap().remove("discoveryRole");
                }
                let bytes = serde_json::to_vec(&legacy).unwrap();
                std::fs::write(&manifest_path, &bytes).unwrap();
                let mut legacy_context = prepared.context.clone();
                legacy_context
                    .prepared_inputs
                    .as_mut()
                    .unwrap()
                    .manifest
                    .sha256 = format!("{:x}", sha2::Sha256::digest(&bytes));
                let legacy_callback = serde_json::to_vec(&serde_json::json!({"controlSecret":"fixture-control", "action":"issue", "provider":"opencode", "soulId":soul,
                    "priorContext":legacy_context, "providerSecretReferences":[], "workspace":workspace, "cwd":workspace, "authLookupAuthority":"existing-owned-attempt"})).unwrap();
                let error = apply_prepared_callback(
                    &legacy_callback,
                    "fixture-control",
                    &store,
                    &directory,
                    "http://host.docker.internal:4000",
                    &home,
                    &client,
                )
                .await
                .err()
                .unwrap_or_default();
                assert!(error.contains("discovery role"), "missing role metadata is unknown evidence and must block before a replacement generation is prepared");
                assert!(prior_stage.is_dir());
                std::fs::write(&manifest_path, current).unwrap();
            }
            std::fs::write(
                global.join("plugins/probe/resource"),
                "refreshed-accepted-global-resource",
            )
            .unwrap();
            let callback = serde_json::to_vec(&serde_json::json!({"controlSecret":"fixture-control", "action":"issue", "provider":"opencode", "soulId":soul,
                "priorContext":prepared.context, "providerSecretReferences":[], "workspace":workspace, "cwd":workspace, "authLookupAuthority":"existing-owned-attempt"})).unwrap();
            let ready: PreparedProviderContext = serde_json::from_slice(
                &apply_prepared_callback(
                    &callback,
                    "fixture-control",
                    &store,
                    &directory,
                    "http://host.docker.internal:4000",
                    &home,
                    &client,
                )
                .await
                .unwrap(),
            )
            .unwrap();
            let next_stage = staged_provider_root_path(
                &directory,
                &ready
                    .provider_launch_context
                    .mcp_capability
                    .as_ref()
                    .unwrap()
                    .grant_id,
            )
            .unwrap();
            assert_eq!(std::fs::read_to_string(next_stage.join("plugins/probe/resource")).expect("reissue must refresh the accepted global resource graph independently of the current XDG env"), "refreshed-accepted-global-resource");
            assert!(
                prior_stage.is_dir(),
                "replacement preparation cannot retire prior usable inputs"
            );
            if document {
                let bind = &ready
                    .provider_launch_context
                    .prepared_inputs
                    .as_ref()
                    .unwrap()
                    .config_binds[0];
                assert_eq!(
                    bind.logical_destination,
                    "/home/freshell/provider/.config/opencode/opencode.json"
                );
            }
        }
    }

    #[test]
    fn managed_provider_shared_runtime_ca_reuses_the_selected_typed_file() {
        use crate::managed_provider_references::sources::*;
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let ca = home.join("synthetic-ca.pem");
        std::fs::write(&ca, "PRIVATE_SYNTHETIC_CA_PAYLOAD").unwrap();
        let runtime_ca = PathBuf::from("/home/freshell/provider/.config/onecli/gateway-ca.pem");
        let shared = workspace.join("shared.json");
        let raw = r#"{"agent":{"probe":{"prompt":"{file:{env:NODE_EXTRA_CA_CERTS}}"}}}"#;
        std::fs::write(&shared, raw).unwrap();
        let sources = [SourceLane::Main, SourceLane::Tui]
            .into_iter()
            .map(|lane| LoadedSourceOccurrence {
                requires_config_bind: false,
                source: SourceOccurrence {
                    logical_path: workspace.join(if lane == SourceLane::Main {
                        "opencode.json"
                    } else {
                        "tui.json"
                    }),
                    canonical_source: shared.clone(),
                    lane,
                    role: DiscoveryRole::Workspace,
                },
                view: std::sync::Arc::new(raw.into()),
            })
            .collect();
        let plan = plan_loaded_opencode_sources_relocated(
            sources,
            &workspace,
            &home,
            &|_, _, name| {
                (name == "NODE_EXTRA_CA_CERTS").then(|| runtime_ca.to_str().unwrap().into())
            },
            &std::collections::BTreeMap::from([(runtime_ca.clone(), ca.clone())]),
        )
        .unwrap();
        let references = [
            ProviderSecretReference {
                source_path: ca.to_str().unwrap().into(),
                profile: ProviderSecretProfile::OpencodeOnecliCaFile,
                provider_relative_path: None,
            },
            ProviderSecretReference {
                source_path: ca.to_str().unwrap().into(),
                profile: ProviderSecretProfile::OpencodeConfigurationFile,
                provider_relative_path: Some(".freshell/references/0".into()),
            },
        ];
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let capability = CapabilityStore::default()
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &[])),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    secret_references: Some(&references),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
        let inputs: PreparedProviderInputs = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/prepared-inputs.json")).unwrap(),
        )
        .unwrap();
        assert!(inputs.indexed_files.as_ref().unwrap().aliases.is_empty(),
            "the host's typed CA projection already owns this exact file; a readonly indexed alias must not cover its writable installation path");
        assert_eq!(inputs.manifest.source_count, 1);
        assert_eq!(std::fs::read_to_string(&shared).unwrap(), raw);
        assert_eq!(
            std::fs::read_to_string(&ca).unwrap(),
            "PRIVATE_SYNTHETIC_CA_PAYLOAD"
        );
        let different_ca = home.join("changed-ca.pem");
        std::fs::write(&different_ca, "PRIVATE_CHANGED_CA_PAYLOAD").unwrap();
        let mut changed = references.clone();
        changed[0].source_path = different_ca.to_str().unwrap().into();
        let error = CapabilityStore::default()
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &[])),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    secret_references: Some(&changed),
                    ..Default::default()
                },
                None,
            )
            .unwrap_err();
        assert!(error.contains("runtime CA alias conflicts"));
        assert!(!error.contains("PRIVATE_CHANGED_CA_PAYLOAD"));
        assert!(
            stage.join(".freshell/prepared-inputs.json").is_file(),
            "a changed typed source cannot retire the prior usable projection"
        );
    }

    #[tokio::test]
    async fn managed_provider_selected_tui_can_share_a_main_source_without_flattening_it() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let shared = workspace.join("shared.jsonc");
        let raw = "{\n // comment {file:./unselected-missing}\n\"agent\":{\"probe\":{\"prompt\":\"{file:./rules}\",\"description\":\"\\u007bfile:./literal\\u007d\"}},\"plugin\":[],}";
        std::fs::write(&shared, raw).unwrap();
        std::fs::write(workspace.join("rules"), "PRIVATE_SHARED_LANE_RULE").unwrap();
        std::os::unix::fs::symlink("shared.jsonc", workspace.join("opencode.jsonc")).unwrap();
        std::os::unix::fs::symlink("shared.jsonc", workspace.join("selected-tui.jsonc")).unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let prepared = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
            crate::managed_provider_references::OpencodePreparation {
                client: &client,
                soul: &soul,
                creation_seed: "existing-fixture",
                home: &home,
                cwd: &workspace,
                workspace: &workspace,
                original: &|name| {
                    (name == "OPENCODE_TUI_CONFIG").then(|| "selected-tui.jsonc".into())
                },
                references: vec![],
                auth_authority: Some("existing-owned-attempt"),
                selected_sources: None,
                accepted_global_root: None,
                selected_resource_roots: None,
                native_source_flags: None,
                rebind_enabled: None,
                inherited_inline: None,
                inline_edits: None,
            },
            |soul, home, context, input| {
                let capability = store.issue(
                    soul.clone(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", home, &context.config)),
                    OpencodeEphemeralInput {
                        launch_context: Some(context),
                        ..input
                    },
                    None,
                )?;
                read_prepared_context(&directory, &capability)
            },
        )
        .await
        .expect("one shared Main/TUI source retains a uniform original-form projection");
        let inputs = prepared.context.prepared_inputs.as_ref().unwrap();
        assert_eq!(inputs.config_binds.len(), 1);
        assert_eq!(
            Path::new(&inputs.config_binds[0].effective_destination),
            shared
        );
        let stage = staged_provider_root_path(&directory, &inputs.generation_id).unwrap();
        let template =
            std::fs::read_to_string(stage.join(&inputs.config_binds[0].source_relative_path))
                .unwrap();
        assert!(template.contains("// comment {file:./unselected-missing}"));
        assert!(template.contains("\\u007bfile:./literal\\u007d"));
        assert!(template.contains("{file:./rules}"));
        let config = freshell_platform::opencode_config::parse_jsonc_object(&template).unwrap();
        assert_eq!(
            config["plugin"],
            serde_json::json!(["file:///home/freshell/provider/.freshell/opencode"])
        );
        assert_eq!(inputs.indexed_files.as_ref().unwrap().aliases.len(), 1);
        assert_eq!(std::fs::read_to_string(shared).unwrap(), raw);
        assert!(
            std::fs::symlink_metadata(workspace.join("selected-tui.jsonc"))
                .unwrap()
                .is_symlink()
        );
    }

    #[test]
    fn managed_provider_shared_source_rewrites_only_home_and_absolute_file_tokens() {
        use crate::managed_provider_references::sources::*;
        use freshell_runtime_protocol::*;
        for native_home_in_auth in [false, true] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let workspace = owned.path().join("workspace");
            let left = workspace.join("left");
            let right = workspace.join("right");
            std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
            for directory in [&left, &right] {
                std::fs::create_dir_all(directory).unwrap();
                std::fs::write(
                    directory.join("relative"),
                    directory.file_name().unwrap().as_encoded_bytes(),
                )
                .unwrap();
            }
            let absolute = home.join("absolute-rule");
            let home_rule = home.join("home-rule");
            std::fs::write(&absolute, "absolute-private-rule").unwrap();
            std::fs::write(&home_rule, "home-private-rule").unwrap();
            let shared = workspace.join("shared.json");
            let raw = serde_json::to_string(&serde_json::json!({"instructions":["{file:./relative}",format!("{{file:{}}}",absolute.display()),"{file:~/home-rule}"],"agent":{"probe":{"prompt":"{env:AUTH}"}}})).unwrap();
            std::fs::write(&shared, &raw).unwrap();
            let sources = [&left, &right]
                .into_iter()
                .map(|directory| {
                    let logical = directory.join("opencode.json");
                    std::os::unix::fs::symlink("../shared.json", &logical).unwrap();
                    SourceOccurrence {
                        logical_path: logical,
                        canonical_source: shared.clone(),
                        lane: SourceLane::Main,
                        role: DiscoveryRole::Workspace,
                    }
                })
                .collect();
            let plan = plan_opencode_sources(sources, &workspace, &home, &|_, source, name| {
                (name == "AUTH").then(|| {
                    let file = if native_home_in_auth {
                        if source.parent() == Some(left.as_path()) {
                            "~/home-rule".to_string()
                        } else {
                            absolute.display().to_string()
                        }
                    } else {
                        "./relative".to_string()
                    };
                    format!("AUTH_PREFIX{{file:{file}}}_END")
                })
            })
            .unwrap();
            let directory = owned.path().join("control/mcp-capabilities");
            std::fs::create_dir_all(&directory).unwrap();
            let capability = CapabilityStore::default()
                .issue(
                    SoulId::new(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", &home, &[])),
                    OpencodeEphemeralInput {
                        cwd: Some(&workspace),
                        workspace: Some(&workspace),
                        source_plan: Some(&plan),
                        secret_references: Some(&[]),
                        ..Default::default()
                    },
                    None,
                )
                .unwrap();
            let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
            let inputs: PreparedProviderInputs = serde_json::from_slice(
                &std::fs::read(stage.join(".freshell/prepared-inputs.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                inputs.config_binds.len(),
                1,
                "one physical shared source must receive one uniform selective template"
            );
            assert_eq!(
                Path::new(&inputs.config_binds[0].effective_destination),
                shared
            );
            let template =
                std::fs::read_to_string(stage.join(&inputs.config_binds[0].source_relative_path))
                    .unwrap();
            assert!(
                template.contains("{file:./relative}"),
                "logical declaring parents must retain their distinct relative meanings"
            );
            assert!(
                template.contains("{env:AUTH}"),
                "native loader-specific auth must remain native, without flattening source values"
            );
            assert!(
            !template.contains("{file:~/") && !template.contains(absolute.to_str().unwrap()),
            "shared HOME and absolute file tokens must point directly to approved indexed payloads"
        );
            assert_eq!(
                inputs.indexed_files.as_ref().unwrap().aliases.len(),
                if native_home_in_auth { 4 } else { 2 },
                "relative and interpolated native file expressions retain their exact aliases"
            );
            if native_home_in_auth {
                for logical in [
                    PathBuf::from("/home/freshell/provider/home-rule"),
                    absolute.clone(),
                ] {
                    assert!(inputs.indexed_files.as_ref().unwrap().aliases.iter().any(|alias| Path::new(&alias.logical_destination) == logical && Path::new(&alias.effective_destination) == logical),
                    "native interpolated HOME/absolute aliases must mount at the actual runtime path, not the controller source path");
                }
            }
            assert_eq!(std::fs::read_to_string(&shared).unwrap(), raw);
            assert!(plan
                .iter()
                .all(|source| source.original_form && source.references.recipes.is_empty()));
        }
    }

    #[test]
    fn managed_provider_ancestor_root_has_its_own_native_mount_location() {
        use crate::managed_provider_references::sources::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let workspace = home.join("workspace");
        let root = workspace.join(".opencode");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&root, home.join(".opencode")).unwrap();
        let roots = vec![
            DiscoveryRoot {
                logical_path: root.clone(),
                role: DiscoveryRole::Workspace,
            },
            DiscoveryRoot {
                logical_path: home.join(".opencode"),
                role: DiscoveryRole::Workspace,
            },
            DiscoveryRoot {
                logical_path: home.join(".opencode"),
                role: DiscoveryRole::Home,
            },
        ];
        let units = source_stage::resource_units(
            home,
            &home.join(".config/opencode"),
            &workspace,
            &[],
            Some(&roots),
        )
        .unwrap();
        let ancestor = units
            .iter()
            .find(|(_, mount)| Path::new(&mount.logical_destination) == home.join(".opencode"))
            .unwrap();
        assert_eq!(Path::new(&ancestor.1.effective_destination), home.join(".opencode"),
            "ancestor discovery is outside the mounted workspace: its original logical symlink is absent in the container, so mount that exact logical root");
        let effective = units
            .iter()
            .map(|(_, mount)| &mount.effective_destination)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(effective.len(),3,"native HOME, workspace and outside ancestor discovery each need a mount without duplicate effective targets");
        assert!(units
            .iter()
            .all(|(_, mount)| mount.provider_relative_path == units[0].1.provider_relative_path));
    }

    #[test]
    fn managed_provider_home_workspace_discovery_keeps_project_origins() {
        use crate::managed_provider_references::sources::*;
        use freshell_runtime_protocol::*;
        for nested_workspace in [false, true] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let workspace = if nested_workspace {
                home.join("project")
            } else {
                home.clone()
            };
            let global = home.join(".config/opencode");
            std::fs::create_dir_all(&global).unwrap();
            std::fs::create_dir_all(workspace.join(".opencode/skills/probe")).unwrap();
            std::fs::write(
                workspace.join("opencode.json"),
                r#"{"agent":{"probe":{"description":"project-nonce"}}}"#,
            )
            .unwrap();
            std::fs::write(
                workspace.join(".opencode/opencode.json"),
                r#"{"agent":{"probe":{"prompt":"root-nonce"}}}"#,
            )
            .unwrap();
            std::fs::write(
                workspace.join(".opencode/skills/probe/SKILL.md"),
                "skill-nonce",
            )
            .unwrap();
            let discovery = OpencodeDiscovery {
                home: &home,
                cwd: &workspace,
                worktree: &workspace,
                config_root: &global,
                env: &|_| None,
            };
            let roots = select_opencode_resource_roots(&discovery).unwrap();
            let sources = discover_opencode(discovery).unwrap();
            let plan = plan_opencode_sources(sources, &workspace, &home, &|_, _, _| None).unwrap();
            let directory = owned.path().join("control/mcp-capabilities");
            std::fs::create_dir_all(&directory).unwrap();
            let capability = CapabilityStore::default()
                .issue(
                    SoulId::new(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", &home, &[])),
                    OpencodeEphemeralInput {
                        cwd: Some(&workspace),
                        workspace: Some(&workspace),
                        source_plan: Some(&plan),
                        resource_roots: Some(&roots),
                        secret_references: Some(&[]),
                        ..Default::default()
                    },
                    None,
                )
                .unwrap();
            let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
            let inputs: PreparedProviderInputs = serde_json::from_slice(
                &std::fs::read(stage.join(".freshell/prepared-inputs.json")).unwrap(),
            )
            .unwrap();
            assert!(inputs.config_binds.iter().any(|bind| Path::new(&bind.logical_destination) == workspace.join("opencode.json") && Path::new(&bind.effective_destination) == workspace.join("opencode.json")),
                "native project discovery beneath original HOME must consume the original workspace location");
            assert!(inputs.resource_mounts.iter().any(|root| Path::new(&root.logical_destination) == workspace.join(".opencode")),
                "native workspace discovery must retain its original root independently of physical provider HOME");
            if !nested_workspace {
                assert!(inputs.resource_mounts.iter().any(|root| root.logical_destination == "/home/freshell/provider/.opencode"),
                    "the same original HOME/workspace root also supplies provider-HOME discovery");
            }
            let manifest: freshell_platform::opencode_recipe::SourceManifest =
                serde_json::from_slice(
                    &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                )
                .unwrap();
            assert!(manifest
                .sources
                .iter()
                .any(|source| source.native_destination.as_deref()
                    == workspace.join("opencode.json").to_str()));
            assert_eq!(
                std::fs::read_to_string(workspace.join("opencode.json")).unwrap(),
                r#"{"agent":{"probe":{"description":"project-nonce"}}}"#
            );
        }
    }

    #[test]
    fn managed_provider_home_and_workspace_root_aliases_share_one_physical_unit() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let shared = owned.path().join("shared-root");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(shared.join("skills/probe")).unwrap();
        std::fs::write(shared.join("skills/probe/SKILL.md"), "shared-root-resource").unwrap();
        std::os::unix::fs::symlink(&shared, home.join(".opencode")).unwrap();
        std::os::unix::fs::symlink(&shared, workspace.join(".opencode")).unwrap();
        let roots = vec![
            freshell_platform::opencode_recipe::DiscoveryRoot {
                logical_path: home.join(".opencode"),
                role: freshell_platform::opencode_recipe::DiscoveryRole::Home,
            },
            freshell_platform::opencode_recipe::DiscoveryRoot {
                logical_path: workspace.join(".opencode"),
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            },
        ];
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let capability = store.issue(SoulId::new(), &directory, "http://host.docker.internal:4000".into(),
            Some(("opencode", &home, &[])), OpencodeEphemeralInput {
                cwd: Some(&workspace), workspace: Some(&workspace), source_plan: Some(&[]),
                resource_roots: Some(&roots), secret_references: Some(&[]), ..Default::default()
            }, None).expect("shared selected roots must keep both native discovery origins without competing physical copies");
        let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
        let inputs: PreparedProviderInputs = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/prepared-inputs.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(inputs.resource_mounts.len(), 2);
        assert_eq!(
            inputs.resource_mounts[0].stage_relative_path,
            inputs.resource_mounts[1].stage_relative_path
        );
        assert_eq!(
            inputs.resource_mounts[0].provider_relative_path,
            inputs.resource_mounts[1].provider_relative_path
        );
        assert!(std::fs::symlink_metadata(
            stage.join(&inputs.resource_mounts[0].stage_relative_path)
        )
        .unwrap()
        .is_dir());
        assert_eq!(
            inputs.resource_mounts[0].effective_destination,
            "/home/freshell/provider/.opencode"
        );
        assert_eq!(
            inputs.resource_mounts[1].effective_destination,
            shared.to_str().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(
                stage
                    .join(&inputs.resource_mounts[0].stage_relative_path)
                    .join("skills/probe/SKILL.md")
            )
            .unwrap(),
            "shared-root-resource"
        );
        assert_eq!(std::fs::read_link(home.join(".opencode")).unwrap(), shared);
    }

    #[tokio::test]
    async fn managed_provider_shared_home_root_private_references_mount_at_each_native_origin() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let shared = owned.path().join("shared-root");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        let raw = r#"{"agent":{"probe":{"prompt":"{file:./rules}"}}}"#;
        std::fs::write(shared.join("opencode.json"), raw).unwrap();
        std::fs::write(shared.join("rules"), "PRIVATE_SHARED_HOME_ROOT_NONCE").unwrap();
        std::os::unix::fs::symlink(&shared, home.join(".opencode")).unwrap();
        std::os::unix::fs::symlink(&shared, workspace.join(".opencode")).unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let prepared = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
            crate::managed_provider_references::OpencodePreparation {
                client: &client,
                soul: &soul,
                creation_seed: "existing-fixture",
                home: &home,
                cwd: &workspace,
                workspace: &workspace,
                original: &|_| None,
                references: vec![],
                auth_authority: Some("existing-owned-attempt"),
                selected_sources: None,
                accepted_global_root: None,
                selected_resource_roots: None,
                native_source_flags: None,
                rebind_enabled: None,
                inherited_inline: None,
                inline_edits: None,
            },
            |soul, home, context, input| {
                let capability = store.issue(
                    soul.clone(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", home, &context.config)),
                    OpencodeEphemeralInput {
                        launch_context: Some(context),
                        ..input
                    },
                    None,
                )?;
                read_prepared_context(&directory, &capability)
            },
        )
        .await
        .unwrap();
        let inputs = prepared.context.prepared_inputs.as_ref().unwrap();
        let files = inputs.indexed_files.as_ref().unwrap();
        let home_alias = files
            .aliases
            .iter()
            .find(|alias| alias.logical_destination == "/home/freshell/provider/.opencode/rules")
            .unwrap();
        assert_eq!(home_alias.effective_destination, "/home/freshell/provider/.opencode/rules", "private child mounts do not propagate between two volume aliases; HOME needs its own exact file mount");
        let workspace_alias = files
            .aliases
            .iter()
            .find(|alias| {
                alias.logical_destination == workspace.join(".opencode/rules").to_str().unwrap()
            })
            .unwrap();
        assert_eq!(
            workspace_alias.effective_destination,
            shared.join("rules").to_str().unwrap()
        );
        assert_eq!(home_alias.source_id, workspace_alias.source_id);
        let stage = staged_provider_root_path(&directory, &inputs.generation_id).unwrap();
        assert!(
            !stage
                .join(&inputs.resource_mounts[0].stage_relative_path)
                .join("rules")
                .exists(),
            "sensitive referenced bytes cannot enter ordinary resource units"
        );
        assert_eq!(
            std::fs::read_to_string(shared.join("opencode.json")).unwrap(),
            raw
        );
    }

    #[tokio::test]
    async fn managed_provider_shared_workspace_sources_keep_original_form_and_private_aliases() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let cwd = workspace.join("nested");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let raw = r#"{"agent":{"probe":{"prompt":"{file:./rules}"}}}"#;
        let shared = workspace.join("shared.json");
        std::fs::write(&shared, raw).unwrap();
        std::os::unix::fs::symlink("shared.json", workspace.join("opencode.json")).unwrap();
        std::os::unix::fs::symlink("../shared.json", cwd.join("opencode.json")).unwrap();
        std::fs::write(workspace.join("rules"), "PRIVATE_ROOT_ORIGIN").unwrap();
        std::fs::write(cwd.join("rules"), "PRIVATE_NESTED_ORIGIN").unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let prepared = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
            crate::managed_provider_references::OpencodePreparation {
                client: &client,
                soul: &soul,
                creation_seed: "fixture-existing-soul",
                home: &home,
                cwd: &cwd,
                workspace: &workspace,
                original: &|_| None,
                references: vec![],
                auth_authority: Some("fixture-owned-attempt"),
                selected_sources: None,
                accepted_global_root: None,
                selected_resource_roots: None,
                native_source_flags: None,
                rebind_enabled: None,
                inherited_inline: None,
                inline_edits: None,
            },
            |soul, home, context, input| {
                let capability = store.issue(
                    soul.clone(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", home, &context.config)),
                    OpencodeEphemeralInput {
                        launch_context: Some(context),
                        ..input
                    },
                    None,
                )?;
                read_prepared_context(&directory, &capability)
            },
        )
        .await
        .expect("representable shared source origins cannot be rejected or flattened");
        let inputs = prepared.context.prepared_inputs.as_ref().unwrap();
        assert!(
            inputs.config_binds.is_empty(),
            "two origin-dependent rewrites cannot bind over one shared source inode"
        );
        let aliases = &inputs.indexed_files.as_ref().unwrap().aliases;
        assert_eq!(aliases.len(), 2);
        assert_eq!(
            aliases
                .iter()
                .map(|alias| alias.logical_destination.as_str())
                .collect::<Vec<_>>(),
            [
                workspace.join("rules").to_str().unwrap(),
                cwd.join("rules").to_str().unwrap()
            ]
        );
        assert_ne!(aliases[0].source_id, aliases[1].source_id);
        let stage = staged_provider_root_path(
            &directory,
            &prepared.context.mcp_capability.as_ref().unwrap().grant_id,
        )
        .unwrap();
        let manifest: freshell_platform::opencode_recipe::SourceManifest = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.sources.len(), 2);
        for source in manifest.sources {
            assert!(source.original_form);
            assert_eq!(
                std::fs::read_to_string(stage.join(source.unexpanded_relative_path)).unwrap(),
                raw
            );
        }
        assert_eq!(std::fs::read_to_string(shared).unwrap(), raw);
        assert!(std::fs::symlink_metadata(workspace.join("opencode.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(cwd.join("opencode.json"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[tokio::test]
    async fn managed_provider_explicit_native_source_selection_survives_preparation() {
        use freshell_runtime_protocol::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let config = workspace.join("selected.json");
        let raw = r#"{"agent":{"probe":{"prompt":"{file:rules}"}}}"#;
        std::fs::write(&config, raw).unwrap();
        let rules = workspace.join("rules");
        std::fs::write(&rules, "EXPLICIT_SOURCE_SELECTION_NONCE").unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let prepared = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
            crate::managed_provider_references::OpencodePreparation {
                client: &client,
                soul: &soul,
                creation_seed: "fixture-existing-soul",
                home: &home,
                cwd: &workspace,
                workspace: &workspace,
                original: &|name| (name == "OPENCODE_CONFIG").then(|| "selected.json".into()),
                references: vec![],
                auth_authority: Some("fixture-owned-attempt"),
                selected_sources: None,
                accepted_global_root: None,
                selected_resource_roots: None,
                native_source_flags: None,
                rebind_enabled: None,
                inherited_inline: None,
                inline_edits: None,
            },
            |soul, home, context, input| {
                let capability = store.issue(
                    soul.clone(),
                    &directory,
                    "http://host.docker.internal:4000".into(),
                    Some(("opencode", home, &context.config)),
                    OpencodeEphemeralInput {
                        launch_context: Some(context),
                        ..input
                    },
                    None,
                )?;
                read_prepared_context(&directory, &capability)
            },
        )
        .await
        .unwrap();
        let capability = prepared.context.mcp_capability.as_ref().unwrap();
        let stage = staged_provider_root_path(&directory, &capability.grant_id).unwrap();
        let manifest: freshell_platform::opencode_recipe::SourceManifest = serde_json::from_slice(
            &std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest.native_source_flags.len(),
            1,
            "native explicit selection must be preserved beside its approved exact config bind"
        );
        assert_eq!(
            manifest.native_source_flags[0].kind.variable(),
            "OPENCODE_CONFIG"
        );
        assert_eq!(
            manifest.native_source_flags[0].runtime_destination,
            config.to_str().unwrap()
        );
        assert_eq!(prepared.references[0].source_path, rules.to_str().unwrap());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
        let callback = serde_json::to_vec(&serde_json::json!({"action":"issue", "controlSecret":"fixture-control", "soulId":soul,
            "provider":"opencode", "workspace":workspace, "cwd":workspace, "priorContext":prepared.context,
            "providerSecretReferences":prepared.references, "authLookupAuthority":"fixture-owned-attempt"})).unwrap();
        let reissued = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &home,
            &client,
        )
        .await
        .unwrap();
        let reissued: PreparedProviderContext = serde_json::from_slice(&reissued).unwrap();
        let replacement_stage = staged_provider_root_path(
            &directory,
            &reissued
                .provider_launch_context
                .mcp_capability
                .as_ref()
                .unwrap()
                .grant_id,
        )
        .unwrap();
        let replacement: freshell_platform::opencode_recipe::SourceManifest =
            serde_json::from_slice(
                &std::fs::read(replacement_stage.join(".freshell/input-manifest.json")).unwrap(),
            )
            .unwrap();
        assert_eq!(replacement.native_source_flags.len(), 1);
        assert_eq!(
            replacement.native_source_flags[0].runtime_destination,
            config.to_str().unwrap(),
            "request-only native controls must survive current controller env absence on reissue"
        );
        let missing = crate::managed_provider_references::prepare_managed_opencode_with_publisher(
            crate::managed_provider_references::OpencodePreparation {
                client: &client,
                soul: &SoulId::new(),
                creation_seed: "fixture-existing-soul",
                home: &home,
                cwd: &workspace,
                workspace: &workspace,
                original: &|name| (name == "OPENCODE_CONFIG").then(|| "missing.json".into()),
                references: vec![],
                auth_authority: Some("fixture-owned-attempt"),
                selected_sources: None,
                accepted_global_root: None,
                selected_resource_roots: None,
                native_source_flags: None,
                rebind_enabled: None,
                inherited_inline: None,
                inline_edits: None,
            },
            |_, _, _, _| panic!("missing selected native source must fail before publication"),
        )
        .await
        .err()
        .expect("a missing explicitly selected source cannot be omitted");
        assert!(missing.contains("OPENCODE_CONFIG"));
    }

    #[tokio::test]
    async fn managed_provider_replacement_preserves_request_only_path_inputs() {
        use crate::managed_provider_references::sources::*;
        use freshell_runtime_protocol::*;
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let root = home.join(".config/opencode");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let config = root.join("opencode.json");
        let raw = r#"{"agent":{"probe":{"prompt":"{file:{env:REQUEST_RULE_ROOT}/rules}"}}}"#;
        std::fs::write(&config, raw).unwrap();
        let rules = root.join("rules");
        let nonce = "PRIVATE_REQUEST_REISSUE_NONCE";
        std::fs::write(&rules, nonce).unwrap();
        let auth = owned.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config.clone(),
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, name| (name == "REQUEST_RULE_ROOT").then(|| root.to_str().unwrap().into()),
        )
        .unwrap();
        let references = vec![
            ProviderSecretReference {
                source_path: auth.to_str().unwrap().into(),
                profile: ProviderSecretProfile::OpencodeOnecliAuthFile,
                provider_relative_path: None,
            },
            ProviderSecretReference {
                source_path: rules.to_str().unwrap().into(),
                profile: ProviderSecretProfile::OpencodeConfigurationFile,
                provider_relative_path: Some(".freshell/references/0".into()),
            },
        ];
        let base = crate::managed_provider_bootstrap::provider_launch_context_from_home(
            "opencode", &workspace, &home, None,
        )
        .unwrap()
        .unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let frozen_names = vec!["REQUEST_RULE_ROOT".into()];
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &base.config)),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    launch_context: Some(&base),
                    secret_references: Some(&references),
                    frozen_inputs: Some(&frozen_names),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let accepted = read_prepared_context(&directory, &prior).unwrap();
        let inputs = ProviderPathInputs::new(std::collections::BTreeMap::from([(
            "REQUEST_RULE_ROOT".into(),
            root.to_str().unwrap().into(),
        )]))
        .unwrap();
        let callback = serde_json::to_vec(&serde_json::json!({"action":"issue", "controlSecret":"fixture-control", "soulId":soul,
            "provider":"opencode", "workspace":workspace, "cwd":workspace, "priorContext":accepted,
            "providerSecretReferences":references, "authLookupAuthority":"fixture-owned-attempt", "providerPathInputs":inputs})).unwrap();
        let control = owned.path().join("control.sock");
        let listener = tokio::net::UnixListener::bind(&control).unwrap();
        let expected_root = root.clone();
        let bound = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async move {
                for operation in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request: Envelope<AdminCommand> = read_frame(&mut socket).await.unwrap();
                    assert_eq!(request.auth.as_deref(), Some("fixture-control"));
                    let result = match (operation, request.body) {
                        (0, AdminCommand::Health) => AdminResult::Health {
                            control_epoch: 1,
                            installation_id: InstallationId::parse("installation-fixture").unwrap(),
                        },
                        (1, AdminCommand::BindProviderPathInputs(request)) => {
                            assert_eq!(
                                request.inputs.get("REQUEST_RULE_ROOT"),
                                expected_root.to_str()
                            );
                            AdminResult::ProviderPathInputsBound
                        }
                        _ => panic!("unexpected private replacement operation"),
                    };
                    write_frame(
                        &mut socket,
                        &AdminReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            })
            .await
            .unwrap();
        });
        let client = freshell_runtime_client::RuntimeClient::new(control, "fixture-control");
        let reply = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &home,
            &client,
        )
        .await;
        if reply.is_err() {
            bound.abort();
        }
        let reply = reply.expect("replacement must resolve the accepted request-only selection without current controller env");
        bound.await.unwrap();
        let reply: PreparedProviderContext = serde_json::from_slice(&reply).unwrap();
        let selected = reply
            .provider_secret_references
            .iter()
            .find(|reference| reference.profile.is_configuration_file())
            .unwrap();
        assert_eq!(
            std::fs::read(&selected.source_path).unwrap(),
            nonce.as_bytes()
        );
        assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
        let durable = bounded_json_bytes(&reply, MAX_CONTROL_FRAME_BYTES).unwrap();
        assert!(!durable
            .windows(nonce.len())
            .any(|bytes| bytes == nonce.as_bytes()));
        assert!(staged_provider_root_path(&directory, &prior.grant_id)
            .unwrap()
            .is_dir());
    }

    #[tokio::test]
    async fn managed_provider_replacement_callback_returns_complete_source_context() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let config = home.join(".config/opencode");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(
            config.join("opencode.json"),
            r#"{"agent":{"probe":{"prompt":"{file:rules}"}}}"#,
        )
        .unwrap();
        std::fs::write(config.join("rules"), "PRIVATE_REPLACEMENT_SOURCE_NONCE").unwrap();
        let directory = owned.path().join("control/mcp-capabilities");
        std::fs::create_dir_all(&directory).unwrap();
        let store = CapabilityStore::default();
        let soul = SoulId::new();
        let prior_references = provider_source_references("opencode", &home).unwrap();
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &prior_references)),
                Default::default(),
                None,
            )
            .unwrap();
        let callback = serde_json::to_vec(&serde_json::json!({
            "action":"issue", "controlSecret":"fixture-control", "soulId":soul,
            "provider":"opencode", "workspace":workspace,
            "authLookupAuthority":"fixture-owned-attempt", "providerSecretReferences":[]
        }))
        .unwrap();
        let client = freshell_runtime_client::RuntimeClient::new(
            owned.path().join("unused.sock"),
            "fixture-control",
        );
        let reply = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &home,
            &client,
        )
        .await
        .unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert!(reply["providerLaunchContext"]["preparedInputs"].is_object(),
            "replacement must deliver the complete prepared source context before registry/Docker publication");
        assert_eq!(
            reply["providerSecretReferences"].as_array().unwrap().len(),
            1
        );
        assert!(
            staged_provider_root_path(&directory, &prior.grant_id)
                .unwrap()
                .is_dir(),
            "an unaccepted replacement must preserve the prior projection"
        );
        assert!(!String::from_utf8(serde_json::to_vec(&reply).unwrap())
            .unwrap()
            .contains("PRIVATE_REPLACEMENT_SOURCE_NONCE"));
        // A lost metadata response retries the same pending generation. It
        // must not rescan changed originals and mix new references with it.
        std::fs::remove_file(config.join("opencode.json")).unwrap();
        let repeated = apply_prepared_callback(
            &callback,
            "fixture-control",
            &store,
            &directory,
            "http://host.docker.internal:4000",
            &home,
            &client,
        )
        .await
        .expect("a pending complete preparation must replay its accepted metadata");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&repeated).unwrap(),
            reply
        );
        assert_eq!(
            std::fs::read_dir(owned.path().join("control/provider-roots"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn managed_provider_source_preparation_publishes_complete_descriptor_before_capability() {
        use crate::managed_provider_references::sources::*;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let config_root = home.join(".config/opencode");
        std::fs::create_dir_all(&config_root).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let config = config_root.join("opencode.json");
        let raw = r#"{"instructions":["{file:rules}"]}"#;
        std::fs::write(&config, raw).unwrap();
        std::fs::write(config_root.join("rules"), "PRIVATE_REFERENCED_NONCE").unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config.clone(),
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let context = crate::managed_provider_bootstrap::provider_launch_context_from_home(
            "opencode", &workspace, &home, None,
        )
        .unwrap()
        .unwrap();
        let store = CapabilityStore::default();
        let capabilities = owned.path().join("capabilities");
        std::fs::create_dir(&capabilities).unwrap();
        let soul = SoulId::new();
        let capability = store
            .issue(
                soul.clone(),
                &capabilities,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &context.config)),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    launch_context: Some(&context),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let staged = staged_provider_root_path(&capabilities, &capability.grant_id).unwrap();
        let metadata = std::fs::read(staged.join(".freshell/prepared-inputs.json")).expect(
            "complete prepared input descriptor must exist when its capability is published",
        );
        let inputs: freshell_runtime_protocol::PreparedProviderInputs =
            serde_json::from_slice(&metadata).unwrap();
        inputs.validate(Some(&capability)).unwrap();
        let ready: freshell_runtime_protocol::ProviderLaunchContext = serde_json::from_slice(
            &std::fs::read(staged.join(".freshell/prepared-context.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(ready.prepared_inputs.as_ref(), Some(&inputs));
        assert_eq!(ready.mcp_capability.as_ref(), Some(&capability));
        assert!(!ready.config.iter().any(|selected|selected.provider_relative_path==".config/opencode/opencode.json"),"ordinary HOME copying must not overwrite the exact read-only prepared config mount");
        assert_eq!(inputs.manifest.source_count, 1);
        assert_eq!(inputs.config_binds.len(), 1);
        assert_eq!(
            inputs.config_binds[0].logical_destination,
            "/home/freshell/provider/.config/opencode/opencode.json"
        );
        assert_eq!(
            inputs.indexed_files.as_ref().unwrap().volume_name,
            freshell_runtime_protocol::indexed_provider_volume_name(&soul, &capability.grant_id)
        );
        assert!(!metadata
            .windows(b"PRIVATE_REFERENCED_NONCE".len())
            .any(|bytes| bytes == b"PRIVATE_REFERENCED_NONCE"));
        assert_eq!(std::fs::read_to_string(config).unwrap(), raw);
    }

    #[test]
    fn managed_provider_source_stage_retains_unexpanded_direct_origins() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let config = workspace.join("opencode.json");
        let direct = r#"{"instructions":["{file:rules}"],"model":"{env:MODEL}"}"#;
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&config, direct).unwrap();
        std::fs::write(workspace.join("rules"), "synthetic-private-selected-value").unwrap();
        use crate::managed_provider_references::sources::*;
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config.clone(),
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let staged = stage_provider_root(
            &owned.path().join("capabilities"),
            "grant-source-stage",
            "opencode",
            &home,
            &[],
            OpencodeEphemeralInput {
                cwd: Some(&workspace),
                workspace: Some(&workspace),
                source_plan: Some(&plan),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(staged.join(".freshell/input-manifest.json"))
                .expect("preparation must publish its source manifest before the capability"),
        )
        .unwrap();
        let source = &manifest["sources"][0];
        assert_eq!(source["logicalPath"], config.to_string_lossy().as_ref());
        assert_eq!(source["referencedVariables"], serde_json::json!(["MODEL"]), "host refresh must retain every finite source input, including variables that can introduce a later file token");
        let raw = std::fs::read_to_string(
            staged.join(source["unexpandedRelativePath"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(
            raw, direct,
            "direct recipes also need the original source for host selection revalidation"
        );
        let template =
            std::fs::read_to_string(staged.join(source["templateRelativePath"].as_str().unwrap()))
                .unwrap();
        assert!(template.contains("{env:MODEL}"));
        assert!(template.contains("{file:/home/freshell/provider/.freshell/references/0}"));
        assert!(
            !std::fs::read_to_string(staged.join(".freshell/input-manifest.json"))
                .unwrap()
                .contains("synthetic-private-selected-value")
        );
        assert_eq!(std::fs::read_to_string(&config).unwrap(), direct);
        std::fs::remove_file(config).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                staged.join(source["unexpandedRelativePath"].as_str().unwrap())
            )
            .unwrap(),
            direct
        );
    }

    #[test]
    fn managed_provider_source_stage_generated_view_replays_without_original_tree() {
        use crate::managed_provider_references::sources::*;
        use freshell_platform::opencode_recipe::{GeneratedFileRecipe, SourceManifest};
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let config = workspace.join("tui.json");
        let raw = r#"{"message":"{env:INTRO}"}"#;
        std::fs::write(&config, raw).unwrap();
        std::fs::write(workspace.join("rules"), "synthetic-file-value").unwrap();
        let lookup =
            |name: &str| (name == "INTRO").then(|| "synthetic-child-value{file:rules}".into());
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config.clone(),
                lane: SourceLane::Tui,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, name| lookup(name),
        )
        .unwrap();
        let store = CapabilityStore::default();
        let directory = owned.path().join("capabilities");
        std::fs::create_dir(&directory).unwrap();
        let grant = store
            .issue(
                SoulId::new(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &[])),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let staged = staged_provider_root_path(&directory, &grant.grant_id).unwrap();
        let metadata = std::fs::read(staged.join(".freshell/input-manifest.json")).unwrap();
        let manifest: SourceManifest = serde_json::from_slice(&metadata).unwrap();
        let view = &manifest.sources[0];
        assert!(view.lane == freshell_platform::opencode_recipe::SourceLane::Tui);
        let raw_view =
            std::fs::read_to_string(staged.join(&view.unexpanded_relative_path)).unwrap();
        assert_eq!(raw_view, raw);
        let template = std::fs::read_to_string(staged.join(&view.template_relative_path)).unwrap();
        assert!(!template.contains("synthetic-child-value"));
        assert!(!String::from_utf8(metadata)
            .unwrap()
            .contains("synthetic-child-value"));
        assert!(!serde_json::to_string(&grant)
            .unwrap()
            .contains("synthetic-child-value"));
        std::fs::remove_dir_all(&workspace).unwrap();
        let recipe = GeneratedFileRecipe {
            generated_name: view.generated_name.clone().unwrap(),
            unexpanded_source: raw_view,
            declaring_config: view.logical_path.clone(),
            cwd: manifest.cwd.clone(),
            original_home: manifest.original_home.clone(),
            occurrences: view.occurrences.clone(),
        };
        assert_eq!(
            freshell_platform::opencode_recipe::evaluate(&recipe, &lookup).unwrap(),
            r#"{"message":"synthetic-child-value{file:/home/freshell/provider/.freshell/references/0}"}"#
        );
        assert!(
            freshell_platform::opencode_recipe::evaluate(&recipe, &|name| (name == "INTRO")
                .then(|| "synthetic-child-value{file:other}".into()))
            .is_err()
        );
    }

    #[test]
    fn managed_provider_source_stage_failure_preserves_prior_capability_and_views() {
        use crate::managed_provider_references::sources::*;
        let owned = tempfile::tempdir().unwrap();
        let directory = owned.path().join("capabilities");
        let workspace = owned.path().join("workspace");
        let home = owned.path().join("home");
        for path in [&directory, &workspace, &home] {
            std::fs::create_dir(path).unwrap();
        }
        let config = workspace.join("opencode.json");
        std::fs::write(&config, r#"{"instructions":["{file:rules}"]}"#).unwrap();
        std::fs::write(workspace.join("rules"), "synthetic-selected-file").unwrap();
        let mut plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let soul = SoulId::new();
        let store = CapabilityStore::default();
        let prior = store
            .issue(
                soul.clone(),
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &[])),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let old_stage = staged_provider_root_path(&directory, &prior.grant_id).unwrap();
        let old_manifest = std::fs::read(old_stage.join(".freshell/input-manifest.json")).unwrap();
        plan[0].references.selections[0].runtime_destination =
            "/home/freshell/provider/.freshell/references/99".into();
        assert!(store
            .issue(
                soul,
                &directory,
                "http://host.docker.internal:4000".into(),
                Some(("opencode", &home, &[])),
                OpencodeEphemeralInput {
                    cwd: Some(&workspace),
                    workspace: Some(&workspace),
                    source_plan: Some(&plan),
                    ..Default::default()
                },
                None
            )
            .is_err());
        assert_eq!(
            std::fs::read(old_stage.join(".freshell/input-manifest.json")).unwrap(),
            old_manifest
        );
        assert!(grant_path(&directory, &prior.grant_id).unwrap().is_file());
        assert_eq!(store.grants.lock().unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(
            std::fs::read_dir(owned.path().join("provider-roots"))
                .unwrap()
                .count(),
            1,
            "failed preparation must remove only its fresh temporary stage"
        );
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
                    source_plan: None,
                    ..Default::default()
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
        assert!(
            path.exists(),
            "lost issue response must not retire prior grant"
        );
        assert!(store.authenticates(active["scope"].as_str().unwrap()));
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

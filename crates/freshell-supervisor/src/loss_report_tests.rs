use super::*;
use crate::{
    admission::AdmissionPolicy,
    registry::{BackendCreatedRecord, LaunchPreparation, NativeImportState, RecoveryContext},
    service::{Supervisor, SupervisorConfig},
};
use freshell_runtime_protocol::{
    AllocationState, DockerDaemonId, DurabilityState, FixtureKind, HostBootId, IncarnationId,
    LaunchNonce, NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
    RecoveryBlockReason, RuntimeLimits, RuntimeProfile, SoulId,
};
use rusqlite::{params, Connection};
use std::collections::BTreeSet;

// Private, provider-free historical setup. These records never qualify a
// current import, reader or provider launch; production obtains those later.
const TASK007_INPUT_ENV: &str = "FRESHELL_TASK007_STOPPED_FIXTURE_INPUT_FILE";
const TASK007_OUTPUT_ENV: &str = "FRESHELL_TASK007_STOPPED_FIXTURE_OUTPUT_DIR";
const TASK007_ROOT_ORDINALS: [usize; 9] = [0, 1, 2, 3, 4, 5, 6, 0, 1];

// Historical stopped-repair setup repeatedly fsyncs complete registry
// lifecycles. Serialize those setup phases. The owned baseline child reserves
// the parent slot before its unchanged watchdog starts; its fresh process has
// an independent slot. Actor races inside each prepared fixture stay concurrent.
static STOPPED_REPAIR_FIXTURE_SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007FixtureInput {
    schema_version: u32,
    fixture_id: String,
    run_id: String,
    candidate_sha: String,
    installation_id: freshell_runtime_protocol::InstallationId,
    owner_root: PathBuf,
    runtime_root: PathBuf,
    workspace_path: PathBuf,
    cwd: PathBuf,
    git_common_dir: Option<PathBuf>,
    image_ref: String,
    host_binary_path: PathBuf,
    host_binary_sha256: String,
    docker_daemon_id: DockerDaemonId,
    broker_socket_path: PathBuf,
    source: Task007FixtureSource,
    targets: [Task007FixtureTarget; 9],
    canonical_choices: [Task007FixtureChoice; 2],
    explicit_views: [Task007FixtureView; 4],
    unrelated: Task007UnrelatedInput,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007FixtureSource {
    root_session_ids: [String; 7],
    unrelated_session_id: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007FixtureTarget {
    soul_id: SoulId,
    provider_store_id: String,
    terminal_id: String,
    stream_id: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007FixtureChoice {
    root_ordinal: usize,
    target_ordinal: usize,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007FixtureView {
    target_ordinal: usize,
    view_id: freshell_runtime_protocol::ViewIntentId,
    owner_id: String,
    workspace_id: String,
    tab_id: String,
    pane_id: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007UnrelatedInput {
    target: Task007FixtureTarget,
    view_id: freshell_runtime_protocol::ViewIntentId,
    owner_id: String,
    workspace_id: String,
    tab_id: String,
    pane_id: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007FixtureOutput {
    schema_version: u32,
    evidence_kind: String,
    fixture_id: String,
    run_id: String,
    candidate_sha: String,
    installation_id: freshell_runtime_protocol::InstallationId,
    docker_daemon_id: DockerDaemonId,
    image_ref: String,
    host_binary_sha256: String,
    workspace_path: PathBuf,
    runtime_root: PathBuf,
    registry: Task007RegistryOutput,
    targets: [Task007TargetOutput; 9],
    canonical_choices: [Task007ChoiceOutput; 2],
    unrelated: Task007UnrelatedOutput,
    historical_control_epoch: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007RegistryOutput {
    file: String,
    schema_version: u32,
    sha256: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007TargetOutput {
    root_session_id: String,
    soul_id: SoulId,
    provider_store_id: String,
    incarnation_id: IncarnationId,
    launch_nonce: LaunchNonce,
    container_id: String,
    provider_volume_name: String,
    runtime_dir: PathBuf,
    host_binary_path: PathBuf,
    immutable_config_digest: String,
    incident_id: freshell_runtime_protocol::IncidentId,
    expected_intent_revision: u64,
    view_ids: Vec<freshell_runtime_protocol::ViewIntentId>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007ChoiceOutput {
    root_session_id: String,
    soul_id: SoulId,
    expected_intent_revision: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007UnrelatedOutput {
    soul_id: SoulId,
    incident_id: freshell_runtime_protocol::IncidentId,
    view_id: freshell_runtime_protocol::ViewIntentId,
    expected_intent_revision: u64,
    notice_ids: Vec<String>,
    outbox_event_ids: Vec<String>,
    exports: Vec<Task007ExportOutput>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007ExportOutput {
    file: String,
    sha256: String,
}

fn task007_fixture_paths(
    input: Option<std::ffi::OsString>,
    output: Option<std::ffi::OsString>,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    match (input, output) {
        (None, None) => Ok(None),
        (Some(input), Some(output)) if !input.is_empty() && !output.is_empty() => {
            Ok(Some((input.into(), output.into())))
        }
        _ => Err("both private Task7 fixture paths are required".into()),
    }
}

#[cfg(unix)]
async fn task007_publish_fixture(
    input_file: &std::path::Path,
    output_dir: &std::path::Path,
) -> Result<serde_json::Value, String> {
    use crate::backend::{CreateRuntimeSpec, DockerEngineBackend, RuntimeBackend};
    use freshell_runtime_protocol::{UpsertViewIntentRequest, ViewIntentKind, ViewIntentRequest};
    use std::os::unix::fs::PermissionsExt;
    let input: Task007FixtureInput =
        serde_json::from_slice(&fs::read(input_file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    task007_validate_input(&input, input_file, output_dir)?;
    let registry = Registry::open(output_dir, Some(input.installation_id.clone()))
        .map_err(|e| e.to_string())?;
    let historical_epoch = registry.control_epoch();
    let backend = DockerEngineBackend::new(&input.broker_socket_path);
    let mut targets = Vec::new();
    for (ordinal, target) in input.targets.iter().enumerate() {
        let native_root = &input.source.root_session_ids[TASK007_ROOT_ORDINALS[ordinal]];
        let terminal = task007_terminal(&input, target)?;
        let prepared = registry
            .prepare_launch(task007_launch(target, native_root, Some(terminal.clone())))
            .await
            .map_err(|e| e.to_string())?;
        let runtime_dir = input.runtime_root.join(prepared.incarnation_id.as_str());
        fs::create_dir(&runtime_dir).map_err(|e| e.to_string())?;
        fs::set_permissions(&runtime_dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let volume =
            crate::registry::stable_provider_volume_name(&input.installation_id, &target.soul_id);
        let create_spec = CreateRuntimeSpec {
            initial_input_reservation: None,
            prior_provider_owner: None,
            installation_id: input.installation_id.clone(),
            soul_id: target.soul_id.clone(),
            incarnation_id: prepared.incarnation_id.clone(),
            image_ref: input.image_ref.clone(),
            host_binary_path: input.host_binary_path.clone(),
            runtime_dir: runtime_dir.clone(),
            limits: task007_native_limits(),
            test_run_id: input.run_id.clone(),
            terminal: Some(terminal),
            fresh_agent: None,
            opencode_transfer_dir: None,
            provider_volume_name: volume.clone(),
        };
        let created = backend
            .create_stopped(&create_spec)
            .await
            .map_err(|e| e.to_string())?;
        if created.daemon_id != input.docker_daemon_id {
            return Err("private fixture Docker daemon changed".into());
        }
        let saved_digest =
            crate::backend::task007_schema_seven_digest(&create_spec).map_err(|e| e.to_string())?;
        registry
            .commit_created(
                prepared.incarnation_id.clone(),
                BackendCreatedRecord {
                    daemon_id: created.daemon_id,
                    container_id: created.container_id.clone(),
                    image_ref: input.image_ref.clone(),
                    runtime_dir: runtime_dir.clone(),
                    host_binary_path: input.host_binary_path.clone(),
                    immutable_config_digest: saved_digest.clone(),
                    launch_policy: None,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        let loss = task007_historical_loss(&registry, &prepared).await?;
        targets.push(serde_json::json!({
            "rootSessionId":native_root,"soulId":target.soul_id,"providerStoreId":target.provider_store_id,
            "incarnationId":prepared.incarnation_id,"launchNonce":prepared.launch_nonce,
            "containerId":created.container_id,"providerVolumeName":volume,"runtimeDir":runtime_dir,
            "hostBinaryPath":input.host_binary_path,"immutableConfigDigest":saved_digest,
            "incidentId":loss.incident_id,"expectedIntentRevision":loss.expected_intent_revision,"viewIds":[],
        }));
    }
    for view in &input.explicit_views {
        let target = &input.targets[view.target_ordinal];
        registry
            .upsert_view_intent(UpsertViewIntentRequest {
                soul_id: target.soul_id.clone(),
                view_id: Some(view.view_id.clone()),
                intent: ViewIntentRequest {
                    owner_id: view.owner_id.clone(),
                    workspace_id: view.workspace_id.clone(),
                    kind: ViewIntentKind::Explicit,
                    preferred_tab_id: Some(view.tab_id.clone()),
                    preferred_pane_id: Some(view.pane_id.clone()),
                    ..ViewIntentRequest::default()
                },
                expected_revision: None,
                expected_soul_intent_revision: targets[view.target_ordinal]
                    ["expectedIntentRevision"]
                    .as_u64()
                    .unwrap(),
                expected_control_epoch: None,
            })
            .await
            .map_err(|e| e.to_string())?;
        targets[view.target_ordinal]["viewIds"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!(view.view_id));
    }
    // The unrelated prior record is historical only: it owns no physical
    // enclosure. Reuse the established historical binding helper, then assign
    // its intended root before recording any fictional observation.
    let unrelated_prepared = registry
        .prepare_launch(task007_launch(
            &input.unrelated.target,
            &input.source.unrelated_session_id,
            None,
        ))
        .await
        .map_err(|e| e.to_string())?;
    registry
        .commit_created(
            unrelated_prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                daemon_id: input.docker_daemon_id.clone(),
                container_id: "0".repeat(64),
                image_ref: input.image_ref.clone(),
                runtime_dir: output_dir.join("historical-unrelated"),
                host_binary_path: input.host_binary_path.clone(),
                immutable_config_digest: format!("sha256:{}", "0".repeat(64)),
                launch_policy: None,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let unrelated = task007_historical_loss(&registry, &unrelated_prepared).await?;
    registry
        .upsert_view_intent(UpsertViewIntentRequest {
            soul_id: unrelated.soul_id.clone(),
            view_id: Some(input.unrelated.view_id.clone()),
            intent: ViewIntentRequest {
                owner_id: input.unrelated.owner_id.clone(),
                workspace_id: input.unrelated.workspace_id.clone(),
                kind: ViewIntentKind::Explicit,
                preferred_tab_id: Some(input.unrelated.tab_id.clone()),
                preferred_pane_id: Some(input.unrelated.pane_id.clone()),
                ..ViewIntentRequest::default()
            },
            expected_revision: None,
            expected_soul_intent_revision: unrelated.expected_intent_revision,
            expected_control_epoch: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    let exporter = IncidentExporter::new(output_dir.join("incidents"), "task007-fictional-secret");
    for pending in registry
        .pending_incident_exports(100)
        .await
        .map_err(|e| e.to_string())?
    {
        registry
            .export_and_ack_incident(pending, exporter.clone())
            .await
            .map_err(|e| e.to_string())?;
    }
    let lifecycle = targets.iter().map(|target|serde_json::json!({"severity":"info","event":"historical.fixture.loss","data":{"incidentId":target["incidentId"],"soulId":target["soulId"]}}))
        .chain(std::iter::once(serde_json::json!({"severity":"info","event":"historical.fixture.unrelated","data":{"incidentId":unrelated.incident_id,"soulId":unrelated.soul_id}})))
        .map(|value|format!("{value}\n")).collect::<String>();
    task007_sync_file(&output_dir.join("lifecycle.jsonl"), lifecycle.as_bytes())?;
    let canonical_choices = input.canonical_choices.iter().map(|choice|serde_json::json!({
        "rootSessionId":input.source.root_session_ids[choice.root_ordinal],
        "soulId":targets[choice.target_ordinal]["soulId"],"expectedIntentRevision":targets[choice.target_ordinal]["expectedIntentRevision"],
    })).collect::<Vec<_>>();
    // Close every registry handle before downgrading and checkpointing. The
    // completed schema-7 bytes are never reopened with Registry before install.
    let database_path = registry.database_path().to_path_buf();
    drop(registry);
    let connection = Connection::open(&database_path).map_err(|e| e.to_string())?;
    let unrelated_notice_ids = connection.prepare(
        "SELECT DISTINCT notice_id FROM runtime_notices,json_each(incident_ids_json) WHERE value=?1 ORDER BY notice_id",
    ).map_err(|e|e.to_string())?.query_map([unrelated.incident_id.as_str()],|row|row.get::<_,String>(0))
        .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let unrelated_outbox_ids = connection.prepare(
        "SELECT DISTINCT event_id FROM outbox,json_tree(payload) WHERE value=?1 ORDER BY event_id",
    ).map_err(|e|e.to_string())?.query_map([unrelated.incident_id.as_str()],|row|row.get::<_,String>(0))
        .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    task007_schema_seven(&connection).map_err(|e| e.to_string())?;
    let checkpoint: (u32, u32, u32) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;
    if checkpoint != (0, 0, 0) {
        return Err("private schema-7 snapshot has a busy or incomplete WAL checkpoint".into());
    }
    connection.close().map_err(|(_, e)| e.to_string())?;
    fs::set_permissions(&database_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    fs::File::open(&database_path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    let unrelated_exports = fs::read_dir(output_dir.join("incidents")).map_err(|e|e.to_string())?
        .map(|entry|entry.map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?
        .into_iter().filter(|entry|entry.file_name().to_string_lossy().starts_with(unrelated.incident_id.as_str()))
        .map(|entry|Ok(serde_json::json!({"file":format!("incidents/{}",entry.file_name().to_string_lossy()),"sha256":format!("{:x}",Sha256::digest(fs::read(entry.path()).map_err(|e|e.to_string())?))})))
        .collect::<Result<Vec<_>,String>>()?;
    let metadata = serde_json::json!({
        "schemaVersion":1,"evidenceKind":"historical-fixture-setup","fixtureId":input.fixture_id,"runId":input.run_id,"candidateSha":input.candidate_sha,
        "installationId":input.installation_id,"dockerDaemonId":input.docker_daemon_id,"imageRef":input.image_ref,"hostBinarySha256":input.host_binary_sha256,
        "workspacePath":input.workspace_path,"runtimeRoot":input.runtime_root,
        "registry":{"file":"runtime.sqlite3","schemaVersion":7,"sha256":format!("{:x}",Sha256::digest(fs::read(&database_path).map_err(|e|e.to_string())?))},
        "targets":targets,"canonicalChoices":canonical_choices,
        "unrelated":{"soulId":unrelated.soul_id,"incidentId":unrelated.incident_id,"viewId":input.unrelated.view_id,"expectedIntentRevision":unrelated.expected_intent_revision,"noticeIds":unrelated_notice_ids,"outboxEventIds":unrelated_outbox_ids,"exports":unrelated_exports},
        "historicalControlEpoch":historical_epoch,
    });
    let metadata: Task007FixtureOutput =
        serde_json::from_value(metadata).map_err(|e| e.to_string())?;
    task007_sync_file(
        &output_dir.join("metadata.json"),
        &serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
    )?;
    fs::File::open(output_dir)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    serde_json::to_value(metadata).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn task007_sync_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
fn task007_validate_input(
    input: &Task007FixtureInput,
    input_file: &std::path::Path,
    output_dir: &std::path::Path,
) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    let invalid = || "invalid private Task7 historical fixture input".to_string();
    for path in [
        &input.owner_root,
        &input.runtime_root,
        &input.workspace_path,
        &input.cwd,
        &input.host_binary_path,
        &input.broker_socket_path,
        input_file,
        output_dir,
    ] {
        if !path.is_absolute() || fs::canonicalize(path).map_err(|_| invalid())? != *path {
            return Err(invalid());
        }
    }
    if !input_file.starts_with(&input.owner_root)
        || !output_dir.starts_with(&input.owner_root)
        || output_dir == input.owner_root
        || !input.runtime_root.starts_with(&input.owner_root)
        || !input.cwd.starts_with(&input.workspace_path)
        || !input.host_binary_path.starts_with(&input.owner_root)
        || !input.broker_socket_path.starts_with(&input.owner_root)
    {
        return Err(invalid());
    }
    let input_metadata = fs::metadata(input_file).map_err(|_| invalid())?;
    let output_metadata = fs::metadata(output_dir).map_err(|_| invalid())?;
    let owner_metadata = fs::metadata(&input.owner_root).map_err(|_| invalid())?;
    if !input_metadata.is_file()
        || input_metadata.permissions().mode() & 0o777 != 0o600
        || !output_metadata.is_dir()
        || output_metadata.permissions().mode() & 0o777 != 0o700
        || !owner_metadata.is_dir()
        || owner_metadata.permissions().mode() & 0o777 != 0o700
        || owner_metadata.uid() != unsafe { libc::geteuid() }
        || input_metadata.uid() != unsafe { libc::geteuid() }
        || output_metadata.uid() != unsafe { libc::geteuid() }
        || fs::read_dir(output_dir)
            .map_err(|_| invalid())?
            .next()
            .is_some()
        || !fs::metadata(&input.broker_socket_path)
            .map_err(|_| invalid())?
            .file_type()
            .is_socket()
    {
        return Err(invalid());
    }
    if let Some(git) = &input.git_common_dir {
        if !git.is_absolute() || fs::canonicalize(git).map_err(|_| invalid())? != *git {
            return Err(invalid());
        }
    }
    let lower_hex = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if input.schema_version != 1
        || input.fixture_id.is_empty()
        || input.run_id.is_empty()
        || !lower_hex(&input.candidate_sha, 40)
        || !lower_hex(input.image_ref.strip_prefix("sha256:").unwrap_or(""), 64)
        || !lower_hex(&input.host_binary_sha256, 64)
        || input.host_binary_sha256
            != format!(
                "{:x}",
                Sha256::digest(fs::read(&input.host_binary_path).map_err(|_| invalid())?)
            )
    {
        return Err(invalid());
    }
    let roots = input
        .source
        .root_session_ids
        .iter()
        .collect::<BTreeSet<_>>();
    if roots.len() != 7
        || roots
            .iter()
            .any(|root| !root.starts_with("ses_") || root.len() <= 4)
        || roots.contains(&input.source.unrelated_session_id)
        || !input.source.unrelated_session_id.starts_with("ses_")
    {
        return Err(invalid());
    }
    for identifiers in [
        input
            .targets
            .iter()
            .map(|t| t.soul_id.as_str())
            .chain(std::iter::once(input.unrelated.target.soul_id.as_str()))
            .collect::<Vec<_>>(),
        input
            .targets
            .iter()
            .map(|t| t.provider_store_id.as_str())
            .chain(std::iter::once(
                input.unrelated.target.provider_store_id.as_str(),
            ))
            .collect(),
        input
            .targets
            .iter()
            .map(|t| t.terminal_id.as_str())
            .chain(std::iter::once(input.unrelated.target.terminal_id.as_str()))
            .collect(),
        input
            .targets
            .iter()
            .map(|t| t.stream_id.as_str())
            .chain(std::iter::once(input.unrelated.target.stream_id.as_str()))
            .collect(),
    ] {
        if identifiers.iter().any(|id| id.is_empty())
            || identifiers.iter().collect::<BTreeSet<_>>().len() != 10
        {
            return Err(invalid());
        }
    }
    if input
        .canonical_choices
        .iter()
        .map(|c| c.root_ordinal)
        .collect::<BTreeSet<_>>()
        != BTreeSet::from([0, 1])
        || input.canonical_choices.iter().any(|c| {
            c.target_ordinal >= 9 || TASK007_ROOT_ORDINALS[c.target_ordinal] != c.root_ordinal
        })
        || input
            .explicit_views
            .iter()
            .map(|v| v.target_ordinal)
            .collect::<BTreeSet<_>>()
            != BTreeSet::from([0, 1, 7, 8])
        || input
            .explicit_views
            .iter()
            .map(|v| v.view_id.as_str())
            .chain(std::iter::once(input.unrelated.view_id.as_str()))
            .collect::<BTreeSet<_>>()
            .len()
            != 5
        || input.explicit_views.iter().any(|v| {
            [&v.owner_id, &v.workspace_id, &v.tab_id, &v.pane_id]
                .iter()
                .any(|value| value.is_empty())
        })
    {
        return Err(invalid());
    }
    Ok(())
}

fn task007_terminal(
    input: &Task007FixtureInput,
    target: &Task007FixtureTarget,
) -> Result<freshell_runtime_protocol::TerminalLaunchSpec, String> {
    serde_json::from_value(serde_json::json!({"terminalId":target.terminal_id,"streamId":target.stream_id,"mode":"opencode","program":"opencode",
        "env":{"HOME":"/home/freshell/provider","XDG_DATA_HOME":"/home/freshell/provider/.local/share","XDG_CONFIG_HOME":"/home/freshell/provider/.config"},
        "cwd":input.cwd,"workspacePath":input.workspace_path,"gitCommonDir":input.git_common_dir,"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"task007-fictional"})).map_err(|e|e.to_string())
}

fn task007_launch(
    target: &Task007FixtureTarget,
    root: &str,
    terminal: Option<freshell_runtime_protocol::TerminalLaunchSpec>,
) -> LaunchPreparation {
    LaunchPreparation {
        soul_id: target.soul_id.clone(),
        provider: "opencode".into(),
        provider_store_id: target.provider_store_id.clone(),
        native_session_id: Some(root.into()),
        creation_seed_ref: "task007-historical-setup".into(),
        request_id: freshell_runtime_protocol::RequestId::new(),
        payload_digest: "task007-historical-setup".into(),
        requested_limits: task007_native_limits(),
        profile: RuntimeProfile::Custom,
        project_key: "task007-fictional".into(),
        fixture: None,
        terminal,
        fresh_agent: None,
        view_intent: None,
        admission: AdmissionPolicy::default(),
    }
}

fn task007_native_limits() -> RuntimeLimits {
    // These stopped historical enclosures later resume the pinned native TUI.
    // The small lifecycle-fixture budget OOM-kills OpenCode during startup.
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 1024 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 128,
    }
}

async fn task007_historical_loss(
    registry: &Registry,
    prepared: &crate::registry::PreparedLaunch,
) -> Result<freshell_runtime_protocol::LostSoulRepairTarget, String> {
    let grant = registry
        .commit_execution_grant(
            prepared.incarnation_id.clone(),
            HostBootId::new(),
            task007_native_limits(),
        )
        .await
        .map_err(|e| e.to_string())?;
    let context = registry
        .recovery_context(prepared.soul_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let launch = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: prepared.launch_nonce.to_string(),
            evidence_revision: context.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: context.native_session_id.clone(),
        })
        .await
        .map_err(|e| e.to_string())?;
    let context = registry
        .recovery_context(prepared.soul_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    registry
        .record_native_identity_observation(
            prepared.soul_id.clone(),
            NativeIdentityObservation {
                native_session_id: context.native_session_id.clone().unwrap(),
                incarnation_id: launch.incarnation_id,
                launch_nonce: launch.launch_nonce,
                evidence_revision: launch.evidence_revision,
                source: NativeIdentitySource::OpencodeTui,
                evidence_digest: "a".repeat(64),
            },
            context.write_fence(),
        )
        .await
        .map_err(|e| e.to_string())?;
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let connection = Connection::open(registry.database_path()).map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE souls SET allocation_state='verified_durable' WHERE soul_id=?1",
            [prepared.soul_id.as_str()],
        )
        .map_err(|e| e.to_string())?;
    drop(connection);
    let context = registry
        .recovery_context(prepared.soul_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    // Construct historical loss using the injected reader's actual private
    // database. The saved container launch is restored before publication;
    // its native paths are not host paths during this create-only fixture.
    let original_terminal = context.terminal.clone();
    let fixture_terminal = native_census_fixture_terminal(&context);
    let connection = Connection::open(registry.database_path()).map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                serde_json::to_string(&fixture_terminal).map_err(|e| e.to_string())?,
                prepared.incarnation_id.as_str()
            ],
        )
        .map_err(|e| e.to_string())?;
    drop(connection);
    let context = registry
        .recovery_context(prepared.soul_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let loss = registry
        .prepare_loss(decision_for(registry, &context).map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?;
    registry
        .finalize_loss_cleanup(
            loss.certificate.incident_id.clone(),
            freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
            cleanup(&loss),
        )
        .await
        .map_err(|e| e.to_string())?;
    let connection = Connection::open(registry.database_path()).map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                original_terminal
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|e| e.to_string())?,
                prepared.incarnation_id.as_str()
            ],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE incarnations SET grant_id=NULL WHERE incarnation_id=?1",
            [prepared.incarnation_id.as_str()],
        )
        .map_err(|e| e.to_string())?;
    Ok(freshell_runtime_protocol::LostSoulRepairTarget {
        soul_id: prepared.soul_id.clone(),
        incident_id: loss.certificate.incident_id,
        expected_intent_revision: loss.committed_intent_revision,
    })
}

fn task007_schema_seven(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", false)?;
    conn.execute_batch("DROP TRIGGER cancel_recovery_retry_on_intent;")?;
    for table in [
        "ordinary_stops",
        "recovery_retries",
        "stopped_repair_root_receipts",
        "stopped_repair_withdrawals",
        "stopped_repair_operations",
        "native_origin_owners",
    ] {
        conn.execute_batch(&format!("DROP TABLE {table};"))?;
    }
    for column in [
        "identity_revision",
        "native_import_revision",
        "native_import_state",
        "native_import_source_store_id",
        "native_import_root_session_id",
        "native_import_source_generation",
        "native_import_schema_fingerprint",
        "native_import_migration_fingerprint",
        "native_import_complete_inventory",
        "native_import_authority",
        "claude_fork_recipe",
    ] {
        conn.execute_batch(&format!("ALTER TABLE souls DROP COLUMN {column};"))?;
    }
    for column in [
        "captured_control_epoch",
        "captured_identity_revision",
        "captured_evidence_revision",
        "captured_native_import_revision",
        "captured_native_import_state",
        "captured_source_store_id",
        "captured_root_session_id",
        "captured_source_generation",
        "captured_source_schema_fingerprint",
        "captured_migration_fingerprint",
        "captured_native_import_complete",
        "captured_native_import_authority",
    ] {
        conn.execute_batch(&format!("ALTER TABLE loss_incidents DROP COLUMN {column};"))?;
    }
    for column in [
        "launch_policy",
        "native_identity_launch",
        "native_identity_observation",
    ] {
        conn.execute_batch(&format!("ALTER TABLE incarnations DROP COLUMN {column};"))?;
    }
    conn.execute(
        "UPDATE installation SET schema_version=7 WHERE singleton=1",
        [],
    )?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn task007_export_stopped_repair_fixture() {
    let paths = task007_fixture_paths(
        std::env::var_os(TASK007_INPUT_ENV),
        std::env::var_os(TASK007_OUTPUT_ENV),
    )
    .expect("private fixture environment must be supplied together");
    if let Some((input, output)) = paths {
        task007_publish_fixture(&input, &output)
            .await
            .expect("publish complete historical setup before the registry opens");
    }
}

#[test]
fn task007_private_fixture_environment_is_inert_or_complete() {
    assert!(task007_fixture_paths(None, None).unwrap().is_none());
    assert!(task007_fixture_paths(Some("input".into()), None).is_err());
    assert!(task007_fixture_paths(None, Some("output".into())).is_err());
    assert!(task007_fixture_paths(Some("".into()), Some("output".into())).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn task007_private_fixture_publishes_actual_create_only_schema_seven() {
    use crate::backend::{BackendError, BackendRuntimeState, DockerEngineBackend, RuntimeBackend};
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let owner_root = root.path().canonicalize().unwrap();
    let workspace = owner_root.join("workspace");
    let runtime_root = owner_root.join("runtimes");
    let output = owner_root.join("output");
    for directory in [&workspace, &runtime_root, &output] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let host = owner_root.join("host");
    fs::write(&host, b"never executed fixture host").unwrap();
    let socket = owner_root.join("broker.sock");
    let daemon_id = DockerDaemonId::new();
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let daemon = daemon_id.clone();
    let (shutdown, mut receiver) = tokio::sync::oneshot::channel();
    let broker = tokio::spawn(async move {
        let mut created = Vec::new();
        let mut requests = Vec::new();
        loop {
            let (mut stream, _) = tokio::select! {
                _ = &mut receiver => break,
                accepted = listener.accept() => accepted.unwrap(),
            };
            let mut raw = Vec::new();
            while !raw.ends_with(b"\r\n\r\n") {
                raw.push(stream.read_u8().await.unwrap());
            }
            let header = String::from_utf8(raw).unwrap();
            requests.push(header.lines().next().unwrap().to_owned());
            let length = header
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            let (status, response) = if header.starts_with("GET /v1.47/info ") {
                (
                    200,
                    serde_json::json!({"ID":daemon,"SecurityOptions":["name=rootless"]}),
                )
            } else if header.starts_with("GET /v1.47/containers/") {
                let container = header.lines().next().unwrap().split('/').nth(3).unwrap();
                let index = usize::from_str_radix(container, 16).unwrap() - 1;
                let body: &serde_json::Value = &created[index];
                let mounts = body["HostConfig"]["Binds"].as_array().unwrap().iter().map(|bind| {
                    let fields = bind.as_str().unwrap().split(':').collect::<Vec<_>>();
                    let key = if fields[1] == "/home/freshell/provider" {"Name"} else {"Source"};
                    serde_json::json!({key:fields[0],"Destination":fields[1],"RW":fields[2] == "rw"})
                }).collect::<Vec<_>>();
                (
                    200,
                    serde_json::json!({
                        "Id":container,"Image":body["Image"],
                        "State":{"Status":"created","Running":false,"Paused":false,"Restarting":false},
                        "Config":{"Labels":body["Labels"],"Env":body["Env"]},
                        "HostConfig":body["HostConfig"],"Mounts":mounts,
                    }),
                )
            } else {
                assert!(
                    header.starts_with("POST /v1.47/containers/create?"),
                    "producer may only create stopped enclosures: {header}"
                );
                created.push(serde_json::from_slice::<serde_json::Value>(&body).unwrap());
                (
                    201,
                    serde_json::json!({"Id":format!("{:064x}",created.len())}),
                )
            };
            let bytes = serde_json::to_vec(&response).unwrap();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.write_all(&bytes).await.unwrap();
            stream.shutdown().await.unwrap();
        }
        (created, requests)
    });
    let input = Task007FixtureInput {
        schema_version: 1,
        fixture_id: "task007-unit".into(),
        run_id: "task007-owned".into(),
        candidate_sha: "a".repeat(40),
        installation_id: freshell_runtime_protocol::InstallationId::new(),
        owner_root: owner_root.clone(),
        runtime_root,
        workspace_path: workspace.clone(),
        cwd: workspace,
        git_common_dir: None,
        image_ref: format!("sha256:{}", "b".repeat(64)),
        host_binary_path: host.clone(),
        host_binary_sha256: format!("{:x}", Sha256::digest(fs::read(host).unwrap())),
        docker_daemon_id: daemon_id,
        broker_socket_path: socket,
        source: Task007FixtureSource {
            root_session_ids: std::array::from_fn(|i| format!("ses_task007root{i}")),
            unrelated_session_id: "ses_task007unrelated".into(),
        },
        targets: std::array::from_fn(|i| Task007FixtureTarget {
            soul_id: SoulId::new(),
            provider_store_id: format!("task007-store-{i}"),
            terminal_id: format!("task007-terminal-{i}"),
            stream_id: format!("task007-stream-{i}"),
        }),
        canonical_choices: [
            Task007FixtureChoice {
                root_ordinal: 0,
                target_ordinal: 7,
            },
            Task007FixtureChoice {
                root_ordinal: 1,
                target_ordinal: 1,
            },
        ],
        explicit_views: std::array::from_fn(|i| Task007FixtureView {
            target_ordinal: [0, 1, 7, 8][i],
            view_id: freshell_runtime_protocol::ViewIntentId::new(),
            owner_id: "task007-view-owner".into(),
            workspace_id: "task007-workspace".into(),
            tab_id: format!("tab-{i}"),
            pane_id: format!("pane-{i}"),
        }),
        unrelated: Task007UnrelatedInput {
            target: Task007FixtureTarget {
                soul_id: SoulId::new(),
                provider_store_id: "task007-unrelated-store".into(),
                terminal_id: "task007-unrelated-term".into(),
                stream_id: "task007-unrelated-stream".into(),
            },
            view_id: freshell_runtime_protocol::ViewIntentId::new(),
            owner_id: "task007-unrelated-owner".into(),
            workspace_id: "task007-workspace".into(),
            tab_id: "unrelated-tab".into(),
            pane_id: "unrelated-pane".into(),
        },
    };
    let input_file = owner_root.join("input.json");
    fs::write(&input_file, serde_json::to_vec(&input).unwrap()).unwrap();
    fs::set_permissions(&input_file, fs::Permissions::from_mode(0o600)).unwrap();
    for fault in [
        "schema",
        "host-hash",
        "duplicate-root",
        "duplicate-soul",
        "foreign-owner",
        "wrong-choice",
        "unbalanced-views",
        "unknown-field",
    ] {
        let mut invalid = serde_json::to_value(&input).unwrap();
        match fault {
            "schema" => invalid["schemaVersion"] = serde_json::json!(2),
            "host-hash" => invalid["hostBinarySha256"] = serde_json::json!("0".repeat(64)),
            "duplicate-root" => {
                invalid["source"]["rootSessionIds"][1] =
                    invalid["source"]["rootSessionIds"][0].clone()
            }
            "duplicate-soul" => {
                invalid["targets"][1]["soulId"] = invalid["targets"][0]["soulId"].clone()
            }
            "foreign-owner" => invalid["ownerRoot"] = serde_json::json!("/"),
            "wrong-choice" => {
                invalid["canonicalChoices"][0]["targetOrdinal"] = serde_json::json!(2)
            }
            "unbalanced-views" => {
                invalid["explicitViews"][0]["targetOrdinal"] = serde_json::json!(2)
            }
            _ => invalid["launchNonce"] = serde_json::json!("owner-must-not-inject-nonce"),
        }
        // A filesystem root is canonical but is not a private owned run root.
        fs::write(&input_file, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            task007_publish_fixture(&input_file, &output).await.is_err(),
            "{fault}"
        );
        assert!(
            fs::read_dir(&output).unwrap().next().is_none(),
            "invalid input must not open a registry: {fault}"
        );
    }
    fs::write(&input_file, serde_json::to_vec(&input).unwrap()).unwrap();
    fs::set_permissions(&input_file, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(task007_publish_fixture(&input_file, &output).await.is_err());
    assert!(fs::read_dir(&output).unwrap().next().is_none());
    fs::set_permissions(&input_file, fs::Permissions::from_mode(0o600)).unwrap();
    let result = task007_publish_fixture(&input_file, &output).await;
    let metadata = result.expect("historical producer must create and checkpoint actual bindings");
    // Install a copy of the closed published snapshot. Migration and full
    // backend inspection must agree on every saved enclosure binding.
    let installed = owner_root.join("installed");
    fs::create_dir(&installed).unwrap();
    fs::copy(
        output.join("runtime.sqlite3"),
        installed.join("runtime.sqlite3"),
    )
    .unwrap();
    let migrated = Registry::open(&installed, Some(input.installation_id.clone())).unwrap();
    let backend = DockerEngineBackend::new(&input.broker_socket_path);
    let mut inspections = Vec::new();
    let mut emptiness = Vec::new();
    let mut altered = Vec::new();
    for target in metadata["targets"].as_array().unwrap() {
        let handle = migrated
            .owned_handle(serde_json::from_value(target["incarnationId"].clone()).unwrap())
            .await
            .unwrap();
        assert_eq!(handle.launch_policy(), None);
        assert_eq!(
            handle.immutable_config_digest(),
            target["immutableConfigDigest"].as_str().unwrap()
        );
        inspections.push(backend.inspect(&handle).await);
        emptiness.push(backend.verify_empty(&handle).await);
        let connection = Connection::open(migrated.database_path()).unwrap();
        let mut limits = handle.requested_limits();
        limits.cpu_milli += 1;
        connection
            .execute(
                "UPDATE incarnations SET requested_limits=?1 WHERE incarnation_id=?2",
                params![
                    serde_json::to_string(&limits).unwrap(),
                    handle.incarnation_id().as_str()
                ],
            )
            .unwrap();
        let changed = migrated
            .owned_handle(handle.incarnation_id().clone())
            .await
            .unwrap();
        altered.push(backend.inspect(&changed).await);
        connection
            .execute(
                "UPDATE incarnations SET requested_limits=?1 WHERE incarnation_id=?2",
                params![
                    serde_json::to_string(&handle.requested_limits()).unwrap(),
                    handle.incarnation_id().as_str()
                ],
            )
            .unwrap();
    }
    shutdown.send(()).unwrap();
    let (created, requests) = broker.await.unwrap();
    for (index, inspection) in inspections.into_iter().enumerate() {
        assert_eq!(
            inspection
                .unwrap_or_else(|error| panic!("schema-7 handle {index}: {error}"))
                .state,
            BackendRuntimeState::Created
        );
        assert!(
            emptiness[index].as_ref().is_ok_and(|empty| *empty),
            "handle {index}: {:?}",
            emptiness[index]
        );
        assert!(
            matches!(altered[index], Err(BackendError::OwnershipMismatch(_))),
            "altered handle {index}: {:?}",
            altered[index]
        );
    }
    assert!(
        requests.iter().all(|request| request.starts_with("GET ")
            || request.starts_with("POST /v1.47/containers/create?")),
        "fixture must never START/stop/kill a provider: {requests:?}"
    );
    assert_eq!(created.len(), 9);
    assert_eq!(metadata["evidenceKind"], "historical-fixture-setup");
    let targets = metadata["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 9);
    let published = Connection::open(output.join("runtime.sqlite3")).unwrap();
    for (index, target) in targets.iter().enumerate() {
        let (requested, effective): (String, String) = published
            .query_row(
                "SELECT requested_limits,effective_limits FROM incarnations WHERE incarnation_id=?1",
                [target["incarnationId"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let requested: RuntimeLimits = serde_json::from_str(&requested).unwrap();
        let effective: RuntimeLimits = serde_json::from_str(&effective).unwrap();
        let enforced = &created[index]["HostConfig"];
        assert_eq!(
            requested, effective,
            "historical grant must retain its budget"
        );
        assert_eq!(enforced["Memory"], requested.memory_bytes);
        assert_eq!(
            enforced["MemorySwap"],
            requested.memory_bytes + requested.swap_bytes
        );
        assert_eq!(enforced["PidsLimit"], requested.pids_max);
        assert_eq!(enforced["NanoCpus"], requested.cpu_milli * 1_000_000);
        // Publish the generated envelope so the offline native startup check
        // can enforce the same limits as these historical enclosures.
        println!(
            "{}",
            serde_json::json!({"severity":"info",
            "event":"task007.fixture_native_startup_envelope",
            "incarnationId":target["incarnationId"], "limits":requested})
        );
        assert_eq!(target["containerId"], format!("{:064x}", index + 1));
        assert_eq!(
            target["rootSessionId"],
            input.source.root_session_ids[TASK007_ROOT_ORDINALS[index]]
        );
        assert_eq!(
            created[index]["Labels"]["com.freshell.incarnation-id"],
            target["incarnationId"]
        );
        assert_eq!(
            created[index]["Labels"]["com.freshell.soul-id"],
            target["soulId"]
        );
        assert!(target["immutableConfigDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert_ne!(
            target["immutableConfigDigest"],
            format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&created[index]).unwrap())
            ),
            "Docker body hashes are not immutable config identities"
        );
    }
    drop(published);
    assert!(!metadata["unrelated"]["noticeIds"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!metadata["unrelated"]["outboxEventIds"]
        .as_array()
        .unwrap()
        .is_empty());
    let database = Connection::open(output.join("runtime.sqlite3")).unwrap();
    assert_eq!(
        database
            .query_row("SELECT schema_version FROM installation", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM pragma_table_info('souls') WHERE name='identity_revision'",
                [],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(database.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('native_origin_owners','stopped_repair_operations','recovery_retries','ordinary_stops')",[],|r|r.get::<_,u32>(0)).unwrap(),0);
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM writer_claims", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM incarnations WHERE grant_id IS NOT NULL",
                [],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(database.query_row("SELECT count(*) FROM incarnations WHERE launch_state IN ('prepared','created','starting','running','stopping')",[],|r|r.get::<_,u32>(0)).unwrap(),0);
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM loss_incidents WHERE cleanup_state!='closed'",
                [],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(database.query_row("SELECT count(*) FROM souls WHERE desired_state='stopped' AND recovery_state='lost'",[],|r|r.get::<_,u32>(0)).unwrap(),10);
    drop(database);
    assert_eq!(
        metadata["registry"]["sha256"],
        format!(
            "{:x}",
            Sha256::digest(fs::read(output.join("runtime.sqlite3")).unwrap())
        )
    );
    for root in &input.source.root_session_ids[..2] {
        let candidates = migrated
            .stopped_repair_owner_candidates(root.clone())
            .await
            .unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates
            .iter()
            .all(|candidate| candidate.explicit_view_count == 1));
    }
    assert!(
        task007_publish_fixture(&input_file, &output).await.is_err(),
        "refuse replacing a previously opened fixture"
    );
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007CrashFixture {
    input_file: PathBuf,
    registry_root: PathBuf,
    source_database_file: PathBuf,
    metadata_file: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task007CrashAttempt {
    fixture: Task007CrashFixture,
    operation_id: freshell_runtime_protocol::RequestId,
    request: freshell_runtime_protocol::RestoreLostSoulsRequest,
}

#[cfg(unix)]
fn task007_read_private_json<T: serde::de::DeserializeOwned>(file: &std::path::Path) -> T {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = fs::symlink_metadata(file).expect("owned private Task7 fixture file");
    assert!(metadata.is_file() && !metadata.file_type().is_symlink());
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    serde_json::from_slice(&fs::read(file).unwrap())
        .expect("complete typed private Task7 fixture JSON")
}

fn task007_sandbox_only() {
    assert_eq!(
        std::env::var("FRESHELL_SANDBOX_MODE").as_deref(),
        Ok("runtime-suite")
    );
    assert!(std::path::Path::new("/.dockerenv").exists());
}

#[cfg(unix)]
fn task007_crash_supervisor(fixture: &Task007CrashFixture) -> Supervisor {
    let input: Task007FixtureInput = task007_read_private_json(&fixture.input_file);
    assert!(fixture.registry_root.starts_with(&input.owner_root));
    assert!(fixture.source_database_file.starts_with(&input.owner_root));
    assert!(fixture.metadata_file.starts_with(&input.owner_root));
    let registry = Registry::open(&fixture.registry_root, Some(input.installation_id)).unwrap();
    Supervisor::new(
        registry,
        std::sync::Arc::new(crate::backend::DockerEngineBackend::new(
            input.broker_socket_path,
        )),
        SupervisorConfig {
            runtime_root: input.runtime_root,
            control_socket_path: input.owner_root.join("task007-parent-control.sock"),
            host_binary_path: input.host_binary_path,
            image_ref: input.image_ref,
            test_run_id: input.run_id,
            control_secret: "task007-fictional-secret".into(),
            lifecycle_log: fixture.registry_root.join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap()
}

#[cfg(unix)]
async fn task007_run_stopped_crash_parent(point: &str) {
    use freshell_runtime_protocol::{
        CanonicalOwnerChoice, PreflightLostSoulsRequest, RepairBatchSourceSelection, RequestId,
        RestoreLostSoulsRequest, SoulRepairStatus,
    };
    use freshell_sessions::opencode_transfer::HostOpenCodeInventory;
    use std::os::unix::process::ExitStatusExt;
    task007_sandbox_only();
    // Physical, asynchronously brokered fixture packaging belongs to Task8.
    // Missing setup fails explicitly; these tests never invent current worker
    // receipts, substitute a local HOME/UID, or count an inert helper as proof.
    let manifest = PathBuf::from(std::env::var_os("FRESHELL_TASK007_STOPPED_REPAIR_CRASH_FIXTURES")
        .expect("PhaseB must provide three fresh physical stopped fixtures before destructive execution"));
    let mut cases: std::collections::BTreeMap<String, Task007CrashFixture> =
        task007_read_private_json(&manifest);
    assert_eq!(cases.len(), 3, "exactly three fresh fixture contexts");
    assert_eq!(
        cases
            .values()
            .map(|fixture| &fixture.registry_root)
            .collect::<BTreeSet<_>>()
            .len(),
        3,
        "each destructive parent owns distinct durable bytes"
    );
    let fixture = cases
        .remove(point)
        .expect("fresh exact fixture for this actual boundary");
    let metadata: serde_json::Value = task007_read_private_json(&fixture.metadata_file);
    assert_eq!(metadata["evidenceKind"], "historical-fixture-setup");
    let input: Task007FixtureInput = task007_read_private_json(&fixture.input_file);
    let source_before = fs::read(&fixture.source_database_file).unwrap();
    let supervisor = task007_crash_supervisor(&fixture);
    let inventory = HostOpenCodeInventory::new(fixture.source_database_file.clone())
        .with_trusted_mount_for_selected_session(input.workspace_path.clone());
    let selection = RepairBatchSourceSelection {
        source_store_id: format!(
            "{:x}",
            Sha256::digest(
                fixture
                    .source_database_file
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
            )
        ),
        root_session_ids: input.source.root_session_ids.to_vec(),
    };
    let scope = supervisor
        .preflight_lost_souls_from_inventory(
            PreflightLostSoulsRequest {
                source: selection.clone(),
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
            },
            inventory.clone(),
        )
        .await
        .unwrap();
    let targets = scope
        .targets
        .iter()
        .map(|member| member.target.clone())
        .collect::<Vec<_>>();
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: selection,
        targets: targets.clone(),
        canonical_owners: input
            .canonical_choices
            .iter()
            .map(|choice| {
                let target = targets
                    .iter()
                    .find(|target| target.soul_id == input.targets[choice.target_ordinal].soul_id)
                    .unwrap();
                CanonicalOwnerChoice {
                    root_session_id: input.source.root_session_ids[choice.root_ordinal].clone(),
                    soul_id: target.soul_id.clone(),
                    expected_intent_revision: target.expected_intent_revision,
                }
            })
            .collect(),
        expected_control_epoch: Some(supervisor.registry.control_epoch()),
    };
    let operation_id = RequestId::new();
    supervisor
        .registry
        .prepare_stopped_repair_operation(operation_id.clone(), request.clone(), scope)
        .await
        .unwrap();
    let unrelated = metadata["unrelated"]["exports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|artifact| {
            let path = fixture
                .registry_root
                .join(artifact["file"].as_str().unwrap());
            let bytes = fs::read(&path).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                artifact["sha256"].as_str().unwrap()
            );
            (path, bytes)
        })
        .collect::<Vec<_>>();
    let marker = input.owner_root.join(format!("{point}.reached"));
    let attempt_file = input.owner_root.join(format!("{point}.attempt.json"));
    task007_sync_file(
        &attempt_file,
        &serde_json::to_vec(&Task007CrashAttempt {
            fixture,
            operation_id: operation_id.clone(),
            request: request.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    drop(supervisor);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "loss_report::tests::task007_stopped_repair_child",
            "--ignored",
            "--nocapture",
        ])
        .env(
            "FRESHELL_TASK007_STOPPED_REPAIR_CRASH_ATTEMPT",
            &attempt_file,
        )
        .env("FRESHELL_TASK007_STOPPED_REPAIR_CRASH_POINT", point)
        .env("FRESHELL_TASK007_STOPPED_REPAIR_CRASH_MARKER", &marker)
        .status()
        .unwrap();
    assert_eq!(
        status.signal(),
        Some(libc::SIGABRT),
        "must abort at the actual durable boundary: {status:?}"
    );
    assert_eq!(fs::read_to_string(&marker).unwrap(), point);
    for (path, bytes) in &unrelated {
        assert_eq!(
            fs::read(path).unwrap(),
            *bytes,
            "unrelated exports survive interruption"
        );
    }
    let attempt: Task007CrashAttempt = task007_read_private_json(&attempt_file);
    let resumed = task007_crash_supervisor(&attempt.fixture);
    let status: String = Connection::open(resumed.registry.database_path())
        .unwrap()
        .query_row(
            "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
            [operation_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        status,
        if point == "stopped_repair_after_import_publication" {
            "importing"
        } else {
            "withdraw_pending"
        }
    );
    let mut retry = request;
    retry.expected_control_epoch = Some(resumed.registry.control_epoch());
    let result = resumed
        .restore_lost_souls_with_inventory(operation_id.clone(), retry.clone(), async {
            Ok(inventory.clone())
        })
        .await
        .unwrap();
    assert_eq!(
        result.status,
        SoulRepairStatus::Complete,
        "operation {} root progress {:?}",
        operation_id,
        result
            .roots
            .iter()
            .map(|root| (
                &root.root_session_id,
                &root.import_status,
                &root.reason_code,
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(result.repaired_target_count, 9);
    assert_eq!(result.roots.len(), 7);
    assert_eq!(
        resumed
            .restore_lost_souls_with_inventory(operation_id.clone(), retry, async { Ok(inventory) })
            .await
            .unwrap(),
        result,
        "repeat the exact operation after durable completion"
    );
    let receipts = resumed
        .registry
        .stopped_repair_root_receipts(operation_id)
        .await
        .unwrap();
    assert_eq!(receipts.len(), 7);
    for receipt in &receipts {
        let context = resumed
            .registry
            .recovery_context(receipt.canonical_soul_id.clone())
            .await
            .unwrap();
        assert_eq!(
            context.desired_state,
            freshell_runtime_protocol::DesiredState::Stopped
        );
        assert_eq!(
            context.recovery_state,
            freshell_runtime_protocol::RecoveryState::DataRepairComplete
        );
        assert_eq!(
            context.native_session_id.as_deref(),
            Some(receipt.root_session_id.as_str())
        );
        assert_eq!(context.provider_store_id, receipt.destination_store_id);
        assert_eq!(
            context.opencode_adoption_baseline,
            Some(receipt.adoption_baseline.clone())
        );
        assert!(receipt.row_count > 0 && !receipt.structural_sha256.is_empty());
    }
    for target in &targets {
        assert!(resumed
            .registry
            .loss_certificate(target.incident_id.clone())
            .await
            .is_err());
        for suffix in ["open.json", "closed.json"] {
            assert!(!attempt
                .fixture
                .registry_root
                .join("incidents")
                .join(format!("{}.{suffix}", target.incident_id))
                .exists());
        }
    }
    for (path, bytes) in unrelated {
        assert_eq!(
            fs::read(path).unwrap(),
            bytes,
            "unrelated physical artifacts survive exact withdrawal"
        );
    }
    assert_eq!(
        fs::read(attempt.fixture.source_database_file).unwrap(),
        source_before,
        "source store is never imported into or mutated"
    );
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Docker runtime-suite only; needs fresh physical PhaseB stopped-import fixtures"]
async fn stopped_repair_crash_after_import_publication() {
    task007_run_stopped_crash_parent("stopped_repair_after_import_publication").await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Docker runtime-suite only; needs fresh physical PhaseB stopped-import fixtures"]
async fn stopped_repair_crash_after_repair_cas_before_withdrawal() {
    task007_run_stopped_crash_parent("stopped_repair_after_repair_cas_before_withdrawal").await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "Docker runtime-suite only; needs fresh physical PhaseB stopped-import fixtures"]
async fn stopped_repair_crash_during_withdrawal_before_ack() {
    task007_run_stopped_crash_parent("stopped_repair_during_withdrawal_before_ack").await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "owned subprocess helper for the three actual stopped-repair crash parents"]
async fn task007_stopped_repair_child() {
    task007_sandbox_only();
    let file = PathBuf::from(
        std::env::var_os("FRESHELL_TASK007_STOPPED_REPAIR_CRASH_ATTEMPT")
            .expect("owned parent attempt"),
    );
    let mut attempt: Task007CrashAttempt = task007_read_private_json(&file);
    let input: Task007FixtureInput = task007_read_private_json(&attempt.fixture.input_file);
    let supervisor = task007_crash_supervisor(&attempt.fixture);
    attempt.request.expected_control_epoch = Some(supervisor.registry.control_epoch());
    let inventory = freshell_sessions::opencode_transfer::HostOpenCodeInventory::new(
        attempt.fixture.source_database_file,
    )
    .with_trusted_mount_for_selected_session(input.workspace_path);
    let result = supervisor
        .restore_lost_souls_with_inventory(attempt.operation_id, attempt.request, async {
            Ok(inventory)
        })
        .await;
    panic!("actual named stopped-repair boundary was not reached: {result:?}");
}

fn request_only_absence_reference(context: &RecoveryContext) -> String {
    let fields = serde_json::to_vec(&(
        &context.provider,
        &context.provider_store_id,
        context.native_session_id.as_deref().unwrap(),
        context.evidence_revision,
    ))
    .unwrap();
    format!("nativeAbsenceCensus=sha256:{:x}", Sha256::digest(fields))
}

fn native_census_terminal(provider: &str) -> freshell_runtime_protocol::TerminalLaunchSpec {
    serde_json::from_value(serde_json::json!({
        "terminalId":"absent-store", "streamId":"absent-store", "mode":provider,
        "program":provider, "cwd":"/workspace", "workspacePath":"/workspace",
        "env":{"HOME":"/home/freshell/provider"}, "runAsUid":65534, "runAsGid":0,
        "cols":80, "rows":24, "projectKey":"test"
    }))
    .unwrap()
}

fn native_census_fixture_terminal(
    context: &RecoveryContext,
) -> freshell_runtime_protocol::TerminalLaunchSpec {
    let mut terminal = context
        .terminal
        .clone()
        .unwrap_or_else(|| native_census_terminal(&context.provider));
    // This injected reader uses its own complete synthetic store, independent
    // of paths belonging to the simulated container's provider environment.
    let database = context
        .prior_handle
        .runtime_dir()
        .join("loss-census")
        .join(context.soul_id.as_str())
        .join(".local/share/opencode/opencode.db");
    terminal
        .env
        .insert("OPENCODE_DB".into(), database.display().to_string());
    terminal
}

fn evidence(context: Option<&RecoveryContext>) -> Vec<RecoveryPathEvidence> {
    let native_evidence = context
        .and_then(|context| context.native_session_id.as_deref().map(|id| (context, id)))
        .map(|(context, native_id)| {
            let directory = context.prior_handle.runtime_dir().join("loss-census").join(context.soul_id.as_str());
            let database = directory.join(".local/share/opencode/opencode.db");
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            if !database.exists() {
                let connection = crate::registry::tests::native_inventory_fixture(&database);
                connection.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
                connection.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('unrelated-exact-root','slug','prj','/synthetic','synthetic','1.18.21',1,1)", []).unwrap();
            }
            let terminal = native_census_fixture_terminal(context);
            let spec = freshell_agent_runtime::build_resume_spec(
                freshell_agent_runtime::ResumeSpecInput {
                    provider: &context.provider,
                    provider_store_id: &context.provider_store_id,
                    native_session_id: native_id,
                    terminal: &terminal,
                    provider_version: freshell_agent_runtime::pinned_provider_version(&context.provider),
                    creation_seed_ref: context.creation_seed_ref.clone(),
                    checkpoint_revision: 0,
                    evidence_revision: context.evidence_revision,
                    never_dispatched: false,
                },
            )
            .unwrap();
            match freshell_agent_runtime::probe_provider_store(&directory, &spec) {
                freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
                negative_paths: _,
                    reason,
                    evidence,
                    store_state,
                } => RecoveryPathEvidence {
                    path: RecoveryPath::NativeResume,
                    verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                    reason_code: reason,
                    evidence_refs: evidence,
                    store_state,
                },
                other => panic!("expected complete exact-row absent census: {other:?}"),
            }
        })
        .unwrap_or_else(|| RecoveryPathEvidence {
            path: RecoveryPath::NativeResume,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "uninspected_fixture_negative".into(),
            evidence_refs: vec!["provider://missing".into()],
            store_state: EvidenceStoreState::Missing,
        });
    let (native_import_state, complete_inventory) = context
        .map(|context| {
            (
                context.native_import_state,
                context.native_import_complete_inventory,
            )
        })
        .unwrap_or((NativeImportState::NotApplicable, false));
    let native_import_evidence = match native_import_state {
        NativeImportState::Absent if complete_inventory => RecoveryPathEvidence {
            path: RecoveryPath::NativeImport,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "source_inventory_complete_absent".into(),
            evidence_refs: vec!["nativeImport=complete_absent".into()],
            store_state: EvidenceStoreState::Missing,
        },
        NativeImportState::NotApplicable => RecoveryPathEvidence {
            path: RecoveryPath::NativeImport,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "no_native_import_configured".into(),
            evidence_refs: vec!["nativeImport=not_applicable".into()],
            store_state: EvidenceStoreState::NotApplicable,
        },
        _ => RecoveryPathEvidence {
            path: RecoveryPath::NativeImport,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "source_inventory_unresolved".into(),
            evidence_refs: vec!["nativeImport=unresolved".into()],
            store_state: EvidenceStoreState::Unknown,
        },
    };
    vec![
        RecoveryPathEvidence {
            path: RecoveryPath::Reattach,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "runtime_absent".into(),
            evidence_refs: vec!["backend://missing".into()],
            store_state: EvidenceStoreState::NotApplicable,
        },
        native_evidence,
        RecoveryPathEvidence {
            path: RecoveryPath::CheckpointRestore,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "checkpoint_missing".into(),
            evidence_refs: vec!["checkpointRevision=0".into()],
            store_state: EvidenceStoreState::Missing,
        },
        RecoveryPathEvidence {
            path: RecoveryPath::PristineSeed,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "input_was_dispatched".into(),
            evidence_refs: vec!["commandJournal.dispatched>0".into()],
            store_state: EvidenceStoreState::NotApplicable,
        },
        native_import_evidence,
    ]
}

fn limits() -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    }
}

async fn prepared_context(root: &std::path::Path) -> (Registry, RecoveryContext) {
    let registry = Registry::open(root, None).unwrap();
    let context = prepared_context_in_registry(&registry, root).await;
    (registry, context)
}

async fn prepared_context_in_registry(
    registry: &Registry,
    root: &std::path::Path,
) -> RecoveryContext {
    prepared_provider_context(registry, root, "opencode", None).await
}

async fn prepared_provider_context(
    registry: &Registry,
    root: &std::path::Path,
    provider: &str,
    fixture: Option<freshell_runtime_protocol::FixtureKind>,
) -> RecoveryContext {
    let soul_id = SoulId::new();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul_id.clone(),
            provider: provider.into(),
            provider_store_id: soul_id.to_string(),
            native_session_id: Some("ses_test_exact".into()),
            creation_seed_ref: "seed-test".into(),
            request_id: freshell_runtime_protocol::RequestId::new(),
            payload_digest: "payload-test".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "test-project".into(),
            fixture,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                runtime_dir: root.join("runtime"),
                host_binary_path: root.join("runtime/host"),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
                launch_policy: None,
            },
        )
        .await
        .unwrap();
    let grant = registry
        .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
        .await
        .unwrap();
    if provider != "native-session-fixture" {
        let context = registry.recovery_context(soul_id.clone()).await.unwrap();
        let launch = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: grant.execution_generation,
                requested_native_session_id: context.native_session_id.clone(),
            })
            .await
            .unwrap();
        let context = registry.recovery_context(soul_id.clone()).await.unwrap();
        registry
            .record_native_identity_observation(
                soul_id.clone(),
                NativeIdentityObservation {
                    native_session_id: context.native_session_id.clone().unwrap(),
                    incarnation_id: launch.incarnation_id,
                    launch_nonce: launch.launch_nonce,
                    evidence_revision: launch.evidence_revision,
                    source: NativeIdentitySource::OpencodeTui,
                    evidence_digest: "a".repeat(64),
                },
                context.write_fence(),
            )
            .await
            .unwrap();
    }
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();
    let conn = Connection::open(root.join("runtime.sqlite3")).unwrap();
    conn.execute(
        "UPDATE souls SET allocation_state='verified_durable' WHERE soul_id=?1",
        params![soul_id.as_str()],
    )
    .unwrap();
    drop(conn);
    registry.recovery_context(soul_id).await.unwrap()
}

fn decision_for(
    registry: &Registry,
    context: &RecoveryContext,
) -> Result<LostDecision, LossDecisionError> {
    decision_with_paths(registry, context, evidence(Some(context)))
}

fn decision_with_paths(
    registry: &Registry,
    context: &RecoveryContext,
    path_evidence: Vec<RecoveryPathEvidence>,
) -> Result<LostDecision, LossDecisionError> {
    LostDecision::try_new(LossDecisionInput {
        installation_id: registry.installation_id(),
        context,
        cleanup_handle: &context.prior_handle,
        path_evidence,
        builds: LossBuildEvidence {
            web_commit: "d".repeat(40),
            supervisor_commit: "d".repeat(40),
            host_image_digest: format!("sha256:{}", "b".repeat(64)),
            provider_version: "test".into(),
            protocol_version: 1,
            registry_schema_version: crate::registry::SCHEMA_VERSION,
        },
        timeline: vec![IncidentTimelineEvent {
            seq: 1,
            at: "2026-09-09T00:00:00.000Z".into(),
            event: "loss.checked".into(),
            evidence_ref: Some("registry://exact".into()),
            exit_code: None,
            oom_killed: None,
        }],
        analysis: IncidentAnalysis {
            observed_cause: "all_paths_absent".into(),
            missing_invariant: "durable_provider_state".into(),
            hypotheses: vec!["state_deleted".into()],
            preventive_action: "retain_state".into(),
            regression_case: "loss_stale_finalize".into(),
        },
        created_at: Some("2026-09-09T00:00:00.000Z".into()),
    })
}

async fn prepared_collection_context(root: &std::path::Path) -> (Registry, RecoveryContext) {
    let (registry, context) = prepared_context(root).await;
    // Include the saved launch environment so the production collector can
    // compare the real reader's environment fingerprint to an exact spec.
    let terminal = native_census_fixture_terminal(&context);
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
        params![
            serde_json::to_string(&terminal).unwrap(),
            context.prior_handle.incarnation_id().as_str()
        ],
    )
    .unwrap();
    let context = registry.recovery_context(context.soul_id).await.unwrap();
    assert!(
        crate::resume_catalog::exact_resume_candidate(&context, None)
            .unwrap()
            .is_some()
    );
    (registry, context)
}

#[tokio::test]
async fn opencode_native_absence_cannot_infer_uninspected_checkpoint_absence() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_collection_context(dir.path()).await;
    let native = evidence(Some(&context)).remove(1);
    let probe = freshell_runtime_protocol::RecoveryProbe::DefinitivelyUnavailable {
        path: RecoveryPath::NativeResume,
        reason: native.reason_code.clone(),
        evidence: native.evidence_refs.clone(),
        store_state: native.store_state,
        negative_paths: vec![native],
    };
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry);
    assert!(matches!(
        supervisor
            .collect_loss_path_evidence(&context, &probe)
            .await,
        Err(freshell_runtime_protocol::RecoveryProbe::Blocked {
            path: RecoveryPath::CheckpointRestore,
            reason: freshell_runtime_protocol::RecoveryBlockReason::StoreUnreadable,
            ..
        })
    ));
}

#[tokio::test]
async fn collected_native_absence_can_commit_and_finalize_loss_without_transient_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let context = prepared_provider_context(
        &registry,
        dir.path(),
        "native-session-fixture",
        Some(freshell_runtime_protocol::FixtureKind::NativeSession),
    )
    .await;
    let input = freshell_runtime_protocol::RequestId::new();
    registry
        .begin_input(
            context.soul_id.clone(),
            input.clone(),
            b"dispatched fixture turn",
            None,
        )
        .await
        .unwrap();
    registry
        .mark_input_dispatching(context.soul_id.clone(), input)
        .await
        .unwrap();
    let context = registry.recovery_context(context.soul_id).await.unwrap();
    let spec = crate::resume_catalog::exact_resume_candidate(&context, None)
        .unwrap()
        .unwrap();
    let store = dir.path().join("physical-native-fixture");
    fs::create_dir(&store).unwrap();
    // This existing reader independently inspects the native state file and
    // checkpoint directory. OpenCode row absence alone cannot prove both.
    let freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
        mut negative_paths,
        ..
    } = freshell_agent_runtime::probe_provider_store(&store, &spec)
    else {
        panic!("complete fixture inspection must prove both missing stores");
    };
    let native = negative_paths
        .iter()
        .find(|row| row.path == RecoveryPath::NativeResume)
        .unwrap()
        .clone();
    let mut native_negative = native.clone();
    let original_census = native
        .evidence_refs
        .iter()
        .find(|reference| reference.starts_with("nativeAbsenceCensus=v2:"))
        .unwrap()
        .clone();
    let mut reader_evidence = native.evidence_refs;
    let reference = reader_evidence
        .iter_mut()
        .find(|reference| reference.starts_with("nativeAbsenceCensus=v2:"))
        .unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(reference.strip_prefix("nativeAbsenceCensus=v2:").unwrap()).unwrap();
    *reference = format!(
        "nativeAbsenceCensus=v2:{}",
        serde_json::to_string_pretty(&parsed).unwrap()
    );
    reader_evidence.extend([
        "private transcript body".into(),
        "Bearer private-credential".into(),
    ]);
    native_negative.evidence_refs = reader_evidence.clone();
    *negative_paths
        .iter_mut()
        .find(|row| row.path == RecoveryPath::NativeResume)
        .unwrap() = native_negative;
    let probe = freshell_runtime_protocol::RecoveryProbe::DefinitivelyUnavailable {
        negative_paths,
        path: RecoveryPath::NativeResume,
        reason: "private reader diagnostic".into(),
        evidence: reader_evidence,
        store_state: native.store_state,
    };
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    let paths = supervisor
        .collect_loss_path_evidence(&context, &probe)
        .await
        .unwrap();
    let decision = decision_with_paths(&registry, &context, paths)
        .expect("actual collector output must retain qualified native absence");
    let encoded = serde_json::to_string(decision.certificate()).unwrap();
    for private in [
        "private transcript body",
        "private-credential",
        "private reader diagnostic",
    ] {
        assert!(!encoded.contains(private));
    }
    let native = decision
        .certificate()
        .recovery_paths
        .iter()
        .find(|row| row.path == RecoveryPath::NativeResume)
        .unwrap();
    assert!(
        native.evidence_refs.contains(&original_census),
        "receipt is canonical typed JSON"
    );
    assert!(native
        .evidence_refs
        .iter()
        .any(|reference| reference.starts_with("transientEvidenceDigest=sha256:")));
    let prepared = registry.prepare_loss(decision).await.unwrap();
    registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap();
    let final_context = registry.recovery_context(context.soul_id).await.unwrap();
    assert_eq!(
        final_context.recovery_state,
        freshell_runtime_protocol::RecoveryState::Lost
    );
    let conn = Connection::open(registry.database_path()).unwrap();
    let state: String = conn
        .query_row(
            "SELECT cleanup_state FROM loss_incidents WHERE incident_id=?1",
            [prepared.certificate.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "closed");
}

#[tokio::test]
async fn collector_rejects_malformed_unqualified_and_stale_native_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_collection_context(dir.path()).await;
    let native = evidence(Some(&context)).remove(1);
    let reference = native
        .evidence_refs
        .iter()
        .find(|reference| reference.starts_with("nativeAbsenceCensus=v2:"))
        .unwrap();
    let census: serde_json::Value =
        serde_json::from_str(reference.strip_prefix("nativeAbsenceCensus=v2:").unwrap()).unwrap();
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    for fault in [
        "malformed",
        "duplicate",
        "private_field",
        "generation",
        "revision",
        "identity",
        "environment",
        "request_token",
    ] {
        let mut changed = census.clone();
        let refs = match fault {
            "malformed" => vec!["nativeAbsenceCensus=v2:{".into()],
            "duplicate" => vec![reference.clone(), reference.clone()],
            "request_token" => vec![request_only_absence_reference(&context)],
            _ => {
                match fault {
                    "private_field" => changed["transcriptBody"] = "private transcript body".into(),
                    "generation" => changed["generation"] = "0".repeat(64).into(),
                    "revision" => {
                        changed["evidenceRevision"] = (context.evidence_revision + 1).into()
                    }
                    "identity" => changed["nativeId"] = "another-native-root".into(),
                    "environment" => changed["environmentFingerprint"] = "0".repeat(64).into(),
                    _ => unreachable!(),
                }
                vec![format!(
                    "nativeAbsenceCensus=v2:{}",
                    serde_json::to_string(&changed).unwrap()
                )]
            }
        };
        let probe = freshell_runtime_protocol::RecoveryProbe::DefinitivelyUnavailable {
            negative_paths: Vec::new(),
            path: RecoveryPath::NativeResume,
            reason: "reader negative".into(),
            evidence: refs,
            store_state: native.store_state,
        };
        assert!(
            supervisor
                .collect_loss_path_evidence(&context, &probe)
                .await
                .is_err(),
            "{fault}"
        );
    }
    // Storage changes without a registry revision also invalidate the real
    // reader receipt before it can survive normalization or enter loss CAS.
    restore_native_history(&context);
    let stale_probe = freshell_runtime_protocol::RecoveryProbe::DefinitivelyUnavailable {
        negative_paths: Vec::new(),
        path: RecoveryPath::NativeResume,
        reason: native.reason_code,
        evidence: native.evidence_refs,
        store_state: native.store_state,
    };
    assert!(supervisor
        .collect_loss_path_evidence(&context, &stale_probe)
        .await
        .is_err());
    assert!(registry
        .unresolved_loss_incident_ids()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        registry
            .recovery_context(context.soul_id)
            .await
            .unwrap()
            .desired_state,
        DesiredState::Running
    );
}

async fn prepared_loss(root: &std::path::Path) -> (Registry, PreparedLoss) {
    let (registry, prepared_loss, _) = prepared_loss_with_decision(root).await;
    (registry, prepared_loss)
}

async fn prepared_loss_with_decision(
    root: &std::path::Path,
) -> (Registry, PreparedLoss, LostDecision) {
    let (registry, context) = prepared_context(root).await;
    let decision = decision_for(&registry, &context).unwrap();
    let prepared_loss = registry.prepare_loss(decision.clone()).await.unwrap();
    (registry, prepared_loss, decision)
}

fn cleanup(prepared: &PreparedLoss) -> LossCleanupReport {
    LossCleanupReport {
        owned_handle_ref: prepared.certificate.cleanup_target.owned_handle_ref.clone(),
        ownership_verified: true,
        graceful_attempt: "completed".into(),
        forced_attempt: "not_required".into(),
        verified_empty: true,
        verified_at: Some("2026-09-09T00:00:01.000Z".into()),
        foreign_objects_touched: 0,
    }
}

#[tokio::test]
async fn dispatched_missing_identity_cannot_certify_loss() {
    for (provider, mode) in [
        ("claude", "claude"),
        ("codex", "codex"),
        ("opencode", "opencode"),
        ("amplifier", "amplifier"),
        ("claude", "freshclaude"),
        ("claude", "kilroy"),
        ("codex", "freshcodex"),
        ("opencode", "freshopencode"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (registry, original) = prepared_context(dir.path()).await;
        let conn = Connection::open(registry.database_path()).unwrap();
        conn.execute(
            "UPDATE souls SET provider=?1,native_session_id=NULL WHERE soul_id=?2",
            params![provider, original.soul_id.as_str()],
        )
        .unwrap();
        let launch = if mode.starts_with("fresh") || mode == "kilroy" {
            serde_json::json!({"sessionId":"presentation", "provider":provider,
                "sessionType":mode, "runtimeVariant":mode, "providerStoreId":original.provider_store_id,
                "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534, "runAsGid":0})
        } else {
            serde_json::json!({"terminalId":"retained", "streamId":"retained", "mode":mode,
                "program":mode, "cwd":"/workspace", "workspacePath":"/workspace",
                "env":{"HOME":"/home/freshell/provider"}, "runAsUid":65534, "runAsGid":0,
                "cols":80, "rows":24, "projectKey":"test"})
        };
        let column = if mode.starts_with("fresh") || mode == "kilroy" {
            "fresh_agent_spec"
        } else {
            "terminal_spec"
        };
        conn.execute(
            &format!("UPDATE incarnations SET {column}=?1 WHERE incarnation_id=?2"),
            params![
                launch.to_string(),
                original.prior_handle.incarnation_id().as_str()
            ],
        )
        .unwrap();
        conn.execute("INSERT INTO input_commands (soul_id,request_id,payload_digest,protected_payload,incarnation_id,state,created_at,updated_at) VALUES (?1,'dispatched','test',X'00',?2,'completed',1,1)", params![original.soul_id.as_str(),original.prior_handle.incarnation_id().as_str()]).unwrap();
        let context = registry
            .recovery_context(original.soul_id.clone())
            .await
            .unwrap();
        assert!(!context.never_dispatched);
        let volume = context.prior_handle.provider_volume_name().to_string();
        let output = dir.path().join("retained-output");
        fs::write(&output, "existing output").unwrap();
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        for _ in 0..3 {
            let offline = crate::recovery::offline_probe(&context).unwrap();
            assert!(
                matches!(
                    offline,
                    freshell_runtime_protocol::RecoveryProbe::Blocked {
                        reason: RecoveryBlockReason::StoreUnreadable,
                        ..
                    }
                ),
                "{mode}: {offline:?}"
            );
            let online = supervisor
                .probe_recovery(context.soul_id.clone())
                .await
                .unwrap();
            assert!(
                matches!(
                    online,
                    freshell_runtime_protocol::RecoveryProbe::Blocked { .. }
                ),
                "{mode}: {online:?}"
            );
            assert!(supervisor
                .collect_loss_path_evidence(&context, &offline)
                .await
                .is_err());
        }
        assert!(
            decision_for(&registry, &context).is_err(),
            "{mode}: final certificate must independently refuse missing identity"
        );
        let result = supervisor
            .recover(freshell_runtime_protocol::RecoverRequest {
                soul_id: context.soul_id.clone(),
                trigger: freshell_runtime_protocol::RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(context.intent_revision),
                expected_control_epoch: None,
            })
            .await
            .unwrap();
        assert_eq!(
            result.outcome,
            freshell_runtime_protocol::RecoveryOutcome::Blocked
        );
        assert!(result.incident_id.is_none());
        let final_result = crate::recovery::tests::revalidate_previously_negative_loss(
            &supervisor,
            context.soul_id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            final_result.outcome,
            freshell_runtime_protocol::RecoveryOutcome::Blocked
        );
        assert!(final_result.incident_id.is_none());
        let attempt_summary = |conn: &Connection| -> (i64, i64) {
            conn.query_row(
                "SELECT COUNT(*),COUNT(CASE WHEN soul_id=?1 AND intent_revision=?2 AND verdict='blocked' AND finished_at IS NOT NULL THEN 1 END) FROM recovery_attempts",
                params![context.soul_id.as_str(), context.intent_revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(
            attempt_summary(&conn),
            (1, 1),
            "{mode}: initial probe reservation settled"
        );
        let settled_retry = registry
            .recovery_retry(context.soul_id.clone(), context.intent_revision)
            .await
            .unwrap();
        // Reopen the durable registry and exercise startup, observation and
        // the same intent again. Missing identity must stay blocked without
        // turning a restart into another attempt or a replacement.
        drop(conn);
        drop(supervisor);
        drop(registry);
        let registry = Registry::open(dir.path(), None).unwrap();
        let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
        supervisor.reconcile_startup().await.unwrap();
        supervisor.observe_once().await.unwrap();
        let repeated = supervisor
            .recover(freshell_runtime_protocol::RecoverRequest {
                soul_id: context.soul_id.clone(),
                trigger: freshell_runtime_protocol::RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(context.intent_revision),
                expected_control_epoch: Some(registry.control_epoch()),
            })
            .await
            .unwrap();
        assert_eq!(
            repeated.outcome,
            freshell_runtime_protocol::RecoveryOutcome::Blocked,
            "{mode}: missing identity stays blocked after restart"
        );
        assert!(repeated.incident_id.is_none());
        let conn = Connection::open(registry.database_path()).unwrap();
        let launch_state: String = conn
            .query_row(
                "SELECT launch_state FROM incarnations WHERE incarnation_id=?1",
                [context.prior_handle.incarnation_id().as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            launch_state, "running",
            "no loss tombstone or process cleanup"
        );
        let loss_incidents: i64 = conn
            .query_row("SELECT COUNT(*) FROM loss_incidents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(loss_incidents, 0, "{mode}: no certified loss");
        assert_eq!(
            attempt_summary(&conn),
            (1, 1),
            "{mode}: restart retains the settled initial probe"
        );
        assert_eq!(
            registry
                .recovery_retry(context.soul_id.clone(), context.intent_revision)
                .await
                .unwrap(),
            settled_retry,
            "{mode}: restart retains the same settled retry budget"
        );
        let replacements: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM incarnations WHERE prior_incarnation_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(replacements, 0, "{mode}: missing identity cannot replace");
        let pending_retries: i64 = conn
            .query_row("SELECT COUNT(*) FROM recovery_retries WHERE reserved_attempt_id IS NOT NULL OR next_due_at_ms IS NOT NULL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending_retries, 0, "{mode}: missing identity cannot retry");
        let loss_exports: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE event_kind LIKE 'loss_incident.%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(loss_exports, 0);
        assert_eq!(fs::read_to_string(output).unwrap(), "existing output");
        let final_context = registry.recovery_context(context.soul_id).await.unwrap();
        assert_eq!(final_context.prior_handle.provider_volume_name(), volume);
        assert_eq!(
            final_context.prior_handle.incarnation_id(),
            context.prior_handle.incarnation_id(),
            "{mode}: missing identity retains the same incarnation"
        );
        assert_eq!(final_context.intent_revision, context.intent_revision);
        assert_eq!(final_context.desired_state, DesiredState::Running);
        assert_eq!(
            final_context.recovery_state,
            freshell_runtime_protocol::RecoveryState::Blocked
        );
        assert!(final_context.native_session_id.is_none());
        assert!(final_context.recovery_attempt_id.is_none());
    }
}

#[tokio::test]
async fn loss_report_rejects_uninspected_native_negative_even_with_identity() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let mut rows = evidence(Some(&context));
    rows.iter_mut()
        .find(|row| row.path == RecoveryPath::NativeResume)
        .unwrap()
        .evidence_refs = vec![request_only_absence_reference(&context)];
    let mut input = LossDecisionInput {
        installation_id: registry.installation_id(),
        context: &context,
        cleanup_handle: &context.prior_handle,
        path_evidence: rows,
        builds: decision_for(&registry, &context)
            .unwrap()
            .certificate
            .builds,
        timeline: Vec::new(),
        analysis: IncidentAnalysis {
            observed_cause: "uninspected".into(),
            missing_invariant: "inspection".into(),
            hypotheses: Vec::new(),
            preventive_action: "inspect".into(),
            regression_case: "uninspected".into(),
        },
        created_at: None,
    };
    assert!(LostDecision::try_new(input.clone()).is_err());
    input.path_evidence = evidence(Some(&context));
    assert!(
        LostDecision::try_new(input).is_ok(),
        "qualified exact absence must remain certifiable"
    );
}

#[tokio::test]
async fn public_loss_constructor_rejects_hash_shaped_container_census() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let valid = decision_for(&registry, &context).unwrap();
    let mut paths = valid.certificate().recovery_paths.clone();
    let native = paths
        .iter_mut()
        .find(|row| row.path == RecoveryPath::NativeResume)
        .unwrap();
    let reference = native
        .evidence_refs
        .iter_mut()
        .find(|reference| reference.starts_with("nativeAbsenceCensus=v2:"))
        .unwrap();
    let mut census: serde_json::Value =
        serde_json::from_str(reference.strip_prefix("nativeAbsenceCensus=v2:").unwrap()).unwrap();
    census["inspectedHome"] = freshell_agent_runtime::PROVIDER_HOME.into();
    census["generation"] = "0".repeat(64).into();
    *reference = format!(
        "nativeAbsenceCensus=v2:{}",
        serde_json::to_string(&census).unwrap()
    );
    let input = LossDecisionInput {
        installation_id: registry.installation_id(),
        context: &context,
        cleanup_handle: &context.prior_handle,
        path_evidence: paths,
        builds: valid.certificate().builds.clone(),
        timeline: Vec::new(),
        analysis: valid.certificate().analysis.clone(),
        created_at: None,
    };
    assert!(
        LostDecision::try_new(input).is_err(),
        "a serialized hash shape without a current reader cannot certify container absence"
    );
}

#[tokio::test]
async fn historical_uninspected_loss_cannot_resume_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared, _) = prepared_loss_with_decision(dir.path()).await;
    let mut certificate = prepared.certificate.clone();
    certificate
        .recovery_paths
        .iter_mut()
        .find(|row| row.path == RecoveryPath::NativeResume)
        .unwrap()
        .evidence_refs = vec!["nativeResume=definitively_unavailable".into()];
    let encoded = serde_json::to_string(&certificate).unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE loss_incidents SET certificate_json=?1 WHERE incident_id=?2",
        params![encoded, certificate.incident_id.as_str()],
    )
    .unwrap();
    let retained = dir.path().join("retained-output");
    fs::write(&retained, "existing output").unwrap();
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    supervisor.reconcile_pending_loss_cleanup().await.unwrap();
    let (actual, state): (String, String) = conn
        .query_row(
            "SELECT certificate_json,cleanup_state FROM loss_incidents WHERE incident_id=?1",
            [certificate.incident_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(actual, encoded, "historical evidence remains immutable");
    assert_eq!(
        state, "cleanup_pending",
        "unsupported loss cannot continue destructive cleanup"
    );
    assert!(
        registry
            .finalize_loss_cleanup(
                certificate.incident_id.clone(),
                StopOutcome::VerifiedEmpty,
                cleanup(&prepared)
            )
            .await
            .is_err(),
        "final cleanup CAS must also refuse historical unsupported certification"
    );
    assert_eq!(fs::read_to_string(retained).unwrap(), "existing output");
    let events = fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap();
    assert!(events
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|event| event["event"] == "supervisor.loss.historical_certification_blocked"));
}

fn restore_native_history(context: &RecoveryContext) {
    let database = context
        .prior_handle
        .runtime_dir()
        .join("loss-census")
        .join(context.soul_id.as_str())
        .join(".local/share/opencode/opencode.db");
    Connection::open(database).unwrap().execute(
        "INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES (?1,'retained','prj','/synthetic','retained','1.18.21',1,1)",
        [context.native_session_id.as_deref().unwrap()],
    ).unwrap();
}

#[tokio::test]
async fn request_only_token_cannot_certify_present_or_unreadable_native_store() {
    for fault in ["present", "unreadable"] {
        let dir = tempfile::tempdir().unwrap();
        let (registry, context) = prepared_context(dir.path()).await;
        let valid = decision_for(&registry, &context).unwrap();
        let mut rows = valid.certificate().recovery_paths.clone();
        rows.iter_mut()
            .find(|row| row.path == RecoveryPath::NativeResume)
            .unwrap()
            .evidence_refs = vec![request_only_absence_reference(&context)];
        restore_native_history(&context);
        if fault == "unreadable" {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let path = context
                    .prior_handle
                    .runtime_dir()
                    .join("loss-census")
                    .join(context.soul_id.as_str())
                    .join(".local/share/opencode/opencode.db");
                fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
            }
        }
        let input = LossDecisionInput {
            installation_id: registry.installation_id(),
            context: &context,
            cleanup_handle: &context.prior_handle,
            path_evidence: rows,
            builds: valid.certificate().builds.clone(),
            timeline: Vec::new(),
            analysis: valid.certificate().analysis.clone(),
            created_at: None,
        };
        assert!(
            LostDecision::try_new(input).is_err(),
            "{fault}: request-computed tokens cannot prove absence"
        );
        assert!(registry
            .unresolved_loss_incident_ids()
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            registry
                .recovery_context(context.soul_id)
                .await
                .unwrap()
                .desired_state,
            DesiredState::Running
        );
    }
}

#[tokio::test]
async fn current_native_storage_generation_fences_initial_loss_cas() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let decision = decision_for(&registry, &context).unwrap();
    restore_native_history(&context);
    assert!(
        registry.prepare_loss(decision).await.is_err(),
        "native history arriving after capture must fence initial loss CAS"
    );
    assert!(registry
        .unresolved_loss_incident_ids()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        registry
            .recovery_context(context.soul_id)
            .await
            .unwrap()
            .desired_state,
        DesiredState::Running
    );
}

#[tokio::test]
async fn current_native_storage_generation_fences_pending_and_final_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared, _) = prepared_loss_with_decision(dir.path()).await;
    let context = registry
        .recovery_context(prepared.certificate.soul_id.clone())
        .await
        .unwrap();
    restore_native_history(&context);
    let retained = dir.path().join("retained-output");
    fs::write(&retained, "existing output").unwrap();
    let before = registry
        .loss_certificate(prepared.certificate.incident_id.clone())
        .await
        .unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    let claims_before: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1",
            [context.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        claims_before, 1,
        "the pending incident retains its exact native writer claim"
    );
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    supervisor.reconcile_pending_loss_cleanup().await.unwrap();
    assert_eq!(
        registry
            .loss_certificate(before.incident_id.clone())
            .await
            .unwrap(),
        before
    );
    assert!(
        registry
            .finalize_loss_cleanup(
                before.incident_id.clone(),
                StopOutcome::VerifiedEmpty,
                cleanup(&prepared)
            )
            .await
            .is_err(),
        "storage generation must be checked again at final cleanup CAS"
    );
    let conn = Connection::open(registry.database_path()).unwrap();
    let state: String = conn
        .query_row(
            "SELECT cleanup_state FROM loss_incidents WHERE incident_id=?1",
            [before.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cleanup_pending");
    let claims_after: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1",
            [context.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(claims_after, claims_before);
    assert_eq!(
        registry
            .recovery_context(context.soul_id)
            .await
            .unwrap()
            .prior_handle
            .provider_volume_name(),
        context.prior_handle.provider_volume_name()
    );
    assert_eq!(fs::read_to_string(retained).unwrap(), "existing output");
}

#[test]
fn unknown_or_unreadable_path_can_never_construct_loss() {
    let mut rows = evidence(None);
    rows[1].store_state = EvidenceStoreState::PresentUnreadable;
    assert!(matches!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
                RecoveryPath::NativeImport,
            ],
            &rows,
        ),
        Err(LossDecisionError::UnknownPathEvidence("native_resume"))
    ));
    rows[1].store_state = EvidenceStoreState::Unknown;
    assert!(validate_path_inventory(
        &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
            RecoveryPath::NativeImport,
        ],
        &rows,
    )
    .is_err());
}

#[test]
fn missing_or_duplicate_manifest_path_can_never_construct_loss() {
    let mut rows = evidence(None);
    rows.pop();
    assert_eq!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
                RecoveryPath::NativeImport,
            ],
            &rows,
        ),
        Err(LossDecisionError::IncompletePathInventory)
    );
    rows.push(rows[0].clone());
    assert_eq!(
        validate_path_inventory(
            &[
                RecoveryPath::Reattach,
                RecoveryPath::NativeResume,
                RecoveryPath::CheckpointRestore,
                RecoveryPath::PristineSeed,
                RecoveryPath::NativeImport,
            ],
            &rows,
        ),
        Err(LossDecisionError::IncompletePathInventory)
    );
}

#[tokio::test]
async fn allocated_or_materializing_souls_cannot_be_certified_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;

    for allocation_state in [AllocationState::Allocated, AllocationState::Materializing] {
        let mut candidate = context.clone();
        candidate.allocation_state = allocation_state;
        assert!(
            decision_for(&registry, &candidate).is_err(),
            "{allocation_state:?} soul must stay retryable instead of becoming Lost"
        );
    }
}

#[tokio::test]
async fn loss_commit_rejects_newer_materialization_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let decision = decision_for(&registry, &context).unwrap();

    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    conn.execute(
        "UPDATE souls SET allocation_state='materializing',evidence_revision=evidence_revision+1 WHERE soul_id=?1",
        params![context.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    assert!(registry.prepare_loss(decision).await.is_err());
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    let incidents: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loss_incidents WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        incidents, 0,
        "stale loss evidence must not commit a certificate"
    );
    let (desired, recovery): (String, String) = conn
        .query_row(
            "SELECT desired_state,recovery_state FROM souls WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired.as_str(), recovery.as_str()), ("running", "live"));
}

#[tokio::test]
async fn loss_commit_rejects_newer_native_import_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, context) = prepared_context(dir.path()).await;
    let decision = decision_for(&registry, &context).unwrap();

    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    conn.execute(
        "UPDATE souls SET native_import_state='pending',native_import_revision=native_import_revision+1,evidence_revision=evidence_revision+1 WHERE soul_id=?1",
        params![context.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    assert!(registry.prepare_loss(decision).await.is_err());
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    let incidents: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loss_incidents WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(incidents, 0, "stale import evidence cannot certify loss");
    let (desired, recovery): (String, String) = conn
        .query_row(
            "SELECT desired_state,recovery_state FROM souls WHERE soul_id=?1",
            params![context.soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((desired.as_str(), recovery.as_str()), ("running", "live"));
}

#[tokio::test]
async fn incomplete_or_unresolved_native_import_states_cannot_be_certified_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, mut context) = prepared_context(dir.path()).await;
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    for state in [
        NativeImportState::Pending,
        NativeImportState::Available,
        NativeImportState::Unresolved,
        NativeImportState::Unreadable,
        NativeImportState::Unsupported,
        NativeImportState::ExpiredStage,
        NativeImportState::Partial,
        NativeImportState::Completed,
        NativeImportState::LegacyUnknown,
    ] {
        conn.execute(
            "UPDATE souls SET native_import_state=?1,native_import_revision=native_import_revision+1 WHERE soul_id=?2",
            params![state.as_str(), context.soul_id.as_str()],
        )
        .unwrap();
        context = registry
            .recovery_context(context.soul_id.clone())
            .await
            .unwrap();
        assert!(
            decision_for(&registry, &context).is_err(),
            "{state:?} must remain retryable instead of being certified lost"
        );
    }
}

#[tokio::test]
async fn complete_absence_of_the_exact_native_import_source_can_be_certified_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, mut context) = prepared_context(dir.path()).await;
    let conn = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
    let source_path = dir.path().join("opencode.db");
    let _source = crate::registry::tests::native_inventory_fixture(&source_path);
    let store = format!(
        "{:x}",
        Sha256::digest(
            source_path
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_bytes()
        )
    );
    let inventory = freshell_sessions::opencode_transfer::HostOpenCodeInventory::new(source_path);
    let census = inventory
        .inspect_exact_origin(&store, "ses_test_exact")
        .unwrap();
    conn.execute(
        "UPDATE souls SET native_import_state='completed',native_import_source_store_id=?1,native_import_root_session_id='ses_test_exact',native_import_source_generation=?2,native_import_schema_fingerprint=?3,native_import_migration_fingerprint=?4 WHERE soul_id=?5",
        params![store, "e".repeat(64), census.schema_fingerprint(), census.migration_fingerprint(), context.soul_id.as_str()],
    ).unwrap();
    context = registry
        .recovery_context(context.soul_id.clone())
        .await
        .unwrap();
    context = registry
        .refresh_native_import_inventory(&context, Ok(inventory))
        .await
        .unwrap();
    assert_eq!(context.native_import_state, NativeImportState::Absent);
    assert!(context.native_import_complete_inventory);
    let decision = decision_for(&registry, &context).unwrap();
    assert!(registry.prepare_loss(decision).await.is_ok());
}

#[tokio::test]
async fn stale_intent_cannot_finalize_or_release_the_certified_writer() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared, original_decision) = prepared_loss_with_decision(dir.path()).await;
    let db = dir.path().join("runtime.sqlite3");
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE souls SET desired_state='running',intent_revision=intent_revision+1,recovery_state='live',loss_incident_id=NULL WHERE soul_id=?1",
        params![prepared.certificate.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);

    let replay_error = registry.prepare_loss(original_decision).await.unwrap_err();
    assert!(matches!(
        replay_error,
        RegistryError::StaleIntentRevision { .. }
    ));
    let error = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RegistryError::StaleIntentRevision { .. }));
    let conn = Connection::open(&db).unwrap();
    let state: String = conn
        .query_row(
            "SELECT cleanup_state FROM loss_incidents WHERE incident_id=?1",
            params![prepared.certificate.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let claims: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE incarnation_id=?1",
            params![prepared.handle.incarnation_id().as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "cleanup_pending");
    assert_eq!(claims, 1);
}

#[tokio::test]
async fn cleanup_result_must_match_exact_handle_and_zero_foreign_objects() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    let mut report = cleanup(&prepared);
    report.foreign_objects_touched = 1;
    let error = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            report,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, RegistryError::InvalidState(_)));
}

#[tokio::test]
async fn closed_incident_retry_uses_persisted_cleanup_notice_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    let first = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap();
    let mut conflicting_retry = cleanup(&prepared);
    conflicting_retry.graceful_attempt = "not_required".into();
    let retry = registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            StopOutcome::VerifiedEmpty,
            conflicting_retry,
        )
        .await
        .unwrap();
    assert_eq!(first.notice_id, retry.notice_id);
    assert_eq!(retry.kind, NoticeKind::CleanupSucceeded);
}

fn test_repair_scope(
    registry: &Registry,
    targets: &[freshell_runtime_protocol::LostSoulRepairTarget],
) -> freshell_runtime_protocol::RepairBatchScope {
    use freshell_runtime_protocol::{RepairBatchRoot, RepairBatchScope, RepairBatchTarget};
    use sha2::{Digest, Sha256};
    let conn = Connection::open(registry.database_path()).unwrap();
    let members = targets.iter().map(|target| {
        let (root_session_id, incident_revision, identity_revision, native_import_revision, evidence_revision): (String, u64, u64, u64, u64) = conn.query_row(
            "SELECT COALESCE(s.native_import_root_session_id,s.native_session_id),l.intent_revision,s.identity_revision,s.native_import_revision,s.evidence_revision FROM souls s JOIN loss_incidents l ON l.incident_id=s.loss_incident_id WHERE s.soul_id=?1",
            params![target.soul_id.as_str()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).unwrap();
        let provider_store_id=conn.query_row("SELECT provider_store_id FROM souls WHERE soul_id=?1",[target.soul_id.as_str()],|row|row.get(0)).unwrap();
        RepairBatchTarget { provider_store_id,target: target.clone(), root_session_id, incident_revision, identity_revision, native_import_revision, evidence_revision }
    }).collect::<Vec<_>>();
    let roots = members
        .iter()
        .map(|member| member.root_session_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|root| {
            let graph_digest = root
                .strip_prefix("ses_repair_root_")
                .map(|index| {
                    format!(
                        "{:x}",
                        Sha256::digest(format!("generation-{index}").as_bytes())
                    )
                })
                .unwrap_or_else(|| "b".repeat(64));
            let eligible_owners = members
                .iter()
                .filter(|member| member.root_session_id == root)
                .map(|member| member.target.soul_id.clone())
                .collect::<Vec<_>>();
            let canonical_soul_id = if eligible_owners.len() == 1 {
                Some(eligible_owners[0].clone())
            } else {
                None
            };
            RepairBatchRoot {
                eligible_owners,
                canonical_soul_id,
                root_session_id: root,
                graph_digest,
            }
        })
        .collect();
    let mut scope = RepairBatchScope {
        scope_id: String::new(),
        source_store_id: "a".repeat(64),
        source_fingerprint: "c".repeat(64),
        targets: members,
        roots,
    };
    scope.source_fingerprint = scope.source_descriptor_digest();
    scope.scope_id = scope.descriptor_digest();
    scope
}

#[tokio::test]
async fn stopped_repair_checks_every_exact_loss_revision_before_source_access() {
    use freshell_runtime_protocol::{
        LostSoulRepairTarget, RequestId, RestoreLostSoulsRequest, RuntimeErrorCode,
    };

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let mut targets = Vec::new();
    for _ in 0..8 {
        let context = prepared_context_in_registry(&registry, dir.path()).await;
        let decision = decision_for(&registry, &context).unwrap();
        let prepared = registry.prepare_loss(decision).await.unwrap();
        registry
            .finalize_loss_cleanup(
                prepared.certificate.incident_id.clone(),
                freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
                cleanup(&prepared),
            )
            .await
            .unwrap();
        targets.push(LostSoulRepairTarget {
            soul_id: prepared.certificate.soul_id,
            incident_id: prepared.certificate.incident_id,
            expected_intent_revision: prepared.committed_intent_revision,
        });
    }
    let scope = test_repair_scope(&registry, &targets);
    targets[4].expected_intent_revision += 1;
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    let result = supervisor
        .restore_lost_souls(
            RequestId::new(),
            RestoreLostSoulsRequest {
                scope_id: scope.scope_id.clone(),
                source: scope.source_selection(),
                targets,
                canonical_owners: Vec::new(),
                expected_control_epoch: Some(registry.control_epoch()),
            },
        )
        .await;

    assert_eq!(
        result.unwrap_err().code,
        RuntimeErrorCode::StaleIntentRevision
    );
}

#[tokio::test]
async fn stopped_repair_retry_after_withdrawal_cas_resumes_without_lost_row_validation() {
    use freshell_runtime_protocol::{LostSoulRepairTarget, RequestId, RestoreLostSoulsRequest};

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let mut targets = Vec::new();
    for _ in 0..8 {
        let context = prepared_context_in_registry(&registry, dir.path()).await;
        let decision = decision_for(&registry, &context).unwrap();
        let prepared = registry.prepare_loss(decision).await.unwrap();
        registry
            .finalize_loss_cleanup(
                prepared.certificate.incident_id.clone(),
                freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
                cleanup(&prepared),
            )
            .await
            .unwrap();
        targets.push(LostSoulRepairTarget {
            soul_id: prepared.certificate.soul_id,
            incident_id: prepared.certificate.incident_id,
            expected_intent_revision: prepared.committed_intent_revision,
        });
    }
    let conn = Connection::open(registry.database_path()).unwrap();
    for target in &targets {
        conn.execute("UPDATE souls SET native_import_state='legacy_unknown',native_import_authority='legacy_unknown' WHERE soul_id=?1", params![target.soul_id.as_str()]).unwrap();
        conn.execute("UPDATE loss_incidents SET captured_native_import_state='legacy_unknown',captured_native_import_authority='legacy_unknown',captured_native_import_complete=0 WHERE incident_id=?1", params![target.incident_id.as_str()]).unwrap();
    }
    drop(conn);
    let operation_id = RequestId::new();
    let scope = test_repair_scope(&registry, &targets);
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: scope.source_selection(),
        targets: targets.clone(),
        canonical_owners: Vec::new(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let prepared = registry
        .prepare_stopped_repair_operation(operation_id.clone(), request.clone(), scope.clone())
        .await
        .unwrap();
    assert_eq!(prepared.status, "importing");

    Connection::open(registry.database_path())
        .unwrap()
        .execute(
            "UPDATE stopped_repair_operations SET status='withdraw_pending' WHERE operation_id=?1",
            params![operation_id.to_string()],
        )
        .unwrap();
    for target in &targets {
        Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "DELETE FROM loss_incidents WHERE incident_id=?1 AND soul_id=?2",
                params![target.incident_id.as_str(), target.soul_id.as_str()],
            )
            .unwrap();
    }

    let resumed = registry
        .prepare_stopped_repair_operation(operation_id, request, scope)
        .await
        .unwrap();
    assert_eq!(resumed.status, "withdraw_pending");
}

#[tokio::test]
async fn restore_lost_souls_nine_first_cas() {
    use freshell_runtime_protocol::{
        opencode_target_build_receipt, opencode_transfer_bundle_digest, IncidentId,
        LostSoulRepairTarget, NoticeKind, OpenCodeAdoptionBaseline, OpenCodeTransferDescriptor,
        OpenCodeTransferFile, RequestId, RestoreLostSoulsRequest, SoulRepairStatus,
        UpsertViewIntentRequest, ViewIntentId, ViewIntentKind, ViewIntentRequest,
        OPENCODE_TRANSFER_DESTINATION_DB,
    };

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let schema_fingerprint = "a".repeat(64);
    let migration_fingerprint = "b".repeat(64);
    let mut targets = Vec::new();
    let mut contexts = Vec::new();

    for index in 0..9 {
        let context = prepared_context_in_registry(&registry, dir.path()).await;
        let prepared = registry
            .prepare_loss(decision_for(&registry, &context).unwrap())
            .await
            .unwrap();
        registry
            .finalize_loss_cleanup(
                prepared.certificate.incident_id.clone(),
                freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
                cleanup(&prepared),
            )
            .await
            .unwrap();

        let root_index = if index == 8 { 0 } else { index.min(6) };
        let root_session_id = format!("ses_repair_root_{root_index}");
        let terminal_spec = serde_json::json!({
            "terminalId": format!("term-repair-{index}"),
            "streamId": format!("stream-repair-{index}"),
            "mode": "opencode",
            "program": "opencode",
            "env": {
                "HOME": "/home/freshell/provider",
                "XDG_DATA_HOME": "/home/freshell/provider/.local/share",
                "XDG_CONFIG_HOME": "/home/freshell/provider/.config"
            },
            "cwd": "/workspace",
            "runAsUid": 65534,
            "runAsGid": 65534,
            "cols": 80,
            "rows": 24,
            "projectKey": "test-project",
            "workspacePath": "/workspace"
        })
        .to_string();
        let mut conn = Connection::open(registry.database_path()).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "UPDATE souls SET native_session_id=?1,native_import_state='legacy_unknown', \
             native_import_source_store_id=NULL,native_import_root_session_id=NULL, \
             native_import_source_generation=NULL,native_import_schema_fingerprint=NULL, \
             native_import_migration_fingerprint=NULL,native_import_complete_inventory=0, \
             native_import_authority='legacy_unknown' WHERE soul_id=?2",
            params![root_session_id, prepared.certificate.soul_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
            params![
                terminal_spec,
                context.prior_handle.incarnation_id().as_str()
            ],
        )
        .unwrap();
        tx.execute(
            "UPDATE loss_incidents SET captured_native_import_state='legacy_unknown', \
             captured_native_import_complete=0,captured_native_import_authority='legacy_unknown', \
             captured_source_store_id=NULL,captured_root_session_id=NULL,captured_source_generation=NULL, \
             captured_source_schema_fingerprint=NULL,captured_migration_fingerprint=NULL \
             WHERE incident_id=?1 AND soul_id=?2",
            params![
                prepared.certificate.incident_id.as_str(),
                prepared.certificate.soul_id.as_str(),
            ],
        )
        .unwrap();
        tx.commit().unwrap();

        targets.push(LostSoulRepairTarget {
            soul_id: prepared.certificate.soul_id,
            incident_id: prepared.certificate.incident_id,
            expected_intent_revision: prepared.committed_intent_revision,
        });
        contexts.push(
            registry
                .recovery_context(targets[index].soul_id.clone())
                .await
                .unwrap(),
        );
    }

    let owner_id = "repair-test-owner";
    let workspace_id = "test-project";
    for index in [0, 8, 6, 7] {
        registry
            .upsert_view_intent(UpsertViewIntentRequest {
                soul_id: targets[index].soul_id.clone(),
                view_id: None,
                intent: ViewIntentRequest {
                    owner_id: owner_id.into(),
                    workspace_id: workspace_id.into(),
                    kind: ViewIntentKind::AutomaticPrimary,
                    ..ViewIntentRequest::default()
                },
                expected_revision: None,
                expected_soul_intent_revision: targets[index].expected_intent_revision,
                expected_control_epoch: None,
            })
            .await
            .unwrap();
    }
    let explicit_duplicate_view = ViewIntentId::parse("view-repair-duplicate-explicit").unwrap();
    for index in [0, 8, 6] {
        registry
            .upsert_view_intent(UpsertViewIntentRequest {
                soul_id: targets[index].soul_id.clone(),
                view_id: Some(
                    ViewIntentId::parse(format!("view-repair-balanced-{index}")).unwrap(),
                ),
                intent: ViewIntentRequest {
                    owner_id: owner_id.into(),
                    workspace_id: workspace_id.into(),
                    kind: ViewIntentKind::Explicit,
                    preferred_tab_id: Some(format!("tab-explicit-{index}")),
                    preferred_pane_id: Some(format!("pane-explicit-{index}")),
                    ..ViewIntentRequest::default()
                },
                expected_revision: None,
                expected_soul_intent_revision: targets[index].expected_intent_revision,
                expected_control_epoch: None,
            })
            .await
            .unwrap();
    }
    registry
        .upsert_view_intent(UpsertViewIntentRequest {
            soul_id: targets[7].soul_id.clone(),
            view_id: Some(explicit_duplicate_view.clone()),
            intent: ViewIntentRequest {
                owner_id: owner_id.into(),
                workspace_id: workspace_id.into(),
                kind: ViewIntentKind::Explicit,
                preferred_tab_id: Some("tab-explicit-repair".into()),
                preferred_pane_id: Some("pane-explicit-repair".into()),
                ..ViewIntentRequest::default()
            },
            expected_revision: None,
            expected_soul_intent_revision: targets[7].expected_intent_revision,
            expected_control_epoch: None,
        })
        .await
        .unwrap();

    let operation_id = RequestId::new();
    let scope = test_repair_scope(&registry, &targets);
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: scope.source_selection(),
        targets: targets.clone(),
        canonical_owners: [0usize, 6]
            .into_iter()
            .map(|index| freshell_runtime_protocol::CanonicalOwnerChoice {
                root_session_id: format!("ses_repair_root_{index}"),
                soul_id: targets[index].soul_id.clone(),
                expected_intent_revision: targets[index].expected_intent_revision,
            })
            .collect(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let operation = registry
        .prepare_stopped_repair_operation(operation_id.clone(), request, scope)
        .await
        .unwrap();
    assert_eq!(operation.status, "importing");

    let mut roots = Vec::new();
    for root_index in 0..7 {
        let context = &contexts[root_index];
        let target = &targets[root_index];
        let root_session_id = format!("ses_repair_root_{root_index}");
        let source_store_id = "a".repeat(64);
        let source_generation = format!(
            "{:x}",
            Sha256::digest(format!("generation-{root_index}").as_bytes())
        );
        let transfer_id = format!("transfer-root-{root_index}");
        let target_image_ref = context.prior_handle.image_ref().to_owned();
        let target_build_receipt =
            opencode_target_build_receipt(&target_image_ref, "opencode-1.18.21");
        let payload_sha256 = format!("{:x}", Sha256::digest(b"x"));
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": root_session_id,
            "source_store_id": source_store_id,
            "source_schema_fingerprint": schema_fingerprint,
            "migration_journal_fingerprint": migration_fingerprint,
            "sqlite_version": "test",
            "row_count": 0,
            "rows": [],
            "assets": [],
            "payload_bytes": 1,
            "payload_sha256": payload_sha256,
            "generation": source_generation,
        })
        .to_string();
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: 1,
            sha256: payload_sha256,
        }];
        let mut descriptor = OpenCodeTransferDescriptor {
            transfer_id: transfer_id.clone(),
            provider: "opencode".into(),
            source_store_id: source_store_id.clone(),
            root_session_id: root_session_id.clone(),
            source_generation: source_generation.clone(),
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint: schema_fingerprint.clone(),
            migration_journal_fingerprint: migration_fingerprint.clone(),
            destination_store_id: context.provider_store_id.clone(),
            destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
            target_image_ref: target_image_ref.clone(),
            target_build_receipt: target_build_receipt.clone(),
            incarnation_id: context.prior_handle.incarnation_id().as_str().into(),
            manifest_json,
            files,
            total_bytes: 1,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        let adoption_baseline = OpenCodeAdoptionBaseline {
            manifest_sha256: format!("{:x}", Sha256::digest(descriptor.manifest_json.as_bytes())),
            descriptor: descriptor.clone(),
        };
        adoption_baseline.validate().unwrap();
        let execution_generation: u64 = Connection::open(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1",
                params![context.prior_handle.incarnation_id().as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let receipt = crate::registry::StoppedRepairRootReceipt {
            root_session_id,
            canonical_soul_id: target.soul_id.clone(),
            transfer_id,
            adoption_baseline,
            destination_store_id: context.provider_store_id.clone(),
            source_store_id,
            source_generation,
            bundle_sha256: descriptor.bundle_sha256,
            source_schema_fingerprint: schema_fingerprint.clone(),
            migration_journal_fingerprint: migration_fingerprint.clone(),
            target_image_ref,
            target_build_receipt,
            row_count: 0,
            asset_count: 0,
            structural_sha256: "c".repeat(64),
            provider_uid: context.terminal.as_ref().unwrap().run_as_uid,
            provider_gid: context.terminal.as_ref().unwrap().run_as_gid,
            reader_environment_sha256: "d".repeat(64),
            captured_identity_revision: context.identity_revision,
            captured_evidence_revision: context.evidence_revision,
            captured_intent_revision: target.expected_intent_revision,
            captured_native_import_revision: context.native_import_revision,
            captured_native_import_state: context.native_import_state.as_str().into(),
            captured_native_import_authority: context.native_import_authority.clone(),
            incarnation_id: context.prior_handle.incarnation_id().clone(),
            execution_generation,
        };
        registry
            .persist_stopped_repair_root_receipt(
                operation_id.clone(),
                target.clone(),
                context.clone(),
                receipt.clone(),
            )
            .await
            .unwrap();
        roots.push(receipt);
    }
    assert_eq!(
        registry
            .stopped_repair_root_receipts(operation_id.clone())
            .await
            .unwrap(),
        roots,
        "all seven exact receipt summaries must be durable before the CAS"
    );

    // Model the stale duplicate as the current owner of the shared native
    // origin so the CAS must transfer that exact ownership to target 6.
    Connection::open(registry.database_path())
        .unwrap()
        .execute(
            "INSERT INTO native_origin_owners(provider,source_store_id,native_root_session_id,owner_soul_id,source_generation,ownership_state,updated_at) \
             VALUES ('opencode',?1,?2,?3,?4,'owned',1)",
            params![
                roots[6].source_store_id,
                roots[6].root_session_id,
                targets[7].soul_id.as_str(),
                roots[6].source_generation,
            ],
        )
        .unwrap();

    // Keep a valid unrelated notice and outbox event beside the eight false
    // incidents. Their presence proves cleanup selects exact IDs and event
    // kinds rather than emptying the projection tables.
    {
        let mut conn = Connection::open(registry.database_path()).unwrap();
        let tx = conn.transaction().unwrap();
        crate::notice_outbox::enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            &[IncidentId::parse("incident-unrelated").unwrap()],
            0,
            1_800_000_000_000,
        )
        .unwrap();
        tx.execute(
            "INSERT INTO outbox(event_id,event_kind,payload,created_at,delivered_at) \
             VALUES ('unrelated-sentinel','unrelated.event','{}',?1,NULL)",
            params![1_800_000_000_000_i64],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    let incident_root = dir.path().join("incidents");
    std::fs::create_dir_all(&incident_root).unwrap();
    let lifecycle_log = dir.path().join("logs/lifecycle.jsonl");
    std::fs::create_dir_all(lifecycle_log.parent().unwrap()).unwrap();
    let mut false_lines = String::new();
    for target in &targets {
        let incident_id = target.incident_id.as_str();
        std::fs::write(
            incident_root.join(format!("{incident_id}.open.json")),
            serde_json::json!({"incidentId": incident_id}).to_string(),
        )
        .unwrap();
        std::fs::write(
            incident_root.join(format!("{incident_id}.closed.json")),
            serde_json::json!({"incidentId": incident_id}).to_string(),
        )
        .unwrap();
        false_lines.push_str(
            &serde_json::json!({"incidentId": incident_id, "event": "soul.loss.finalized"})
                .to_string(),
        );
        false_lines.push('\n');
    }
    let unrelated_line = "{\"incidentId\":\"incident-false-0-extra\",\"event\":\"keep\"}\n";
    std::fs::write(
        incident_root.join("incidents.jsonl"),
        format!("{false_lines}{unrelated_line}"),
    )
    .unwrap();
    std::fs::write(&lifecycle_log, format!("{false_lines}{unrelated_line}")).unwrap();
    let similar_export = incident_root.join("incident-false-0-extra.closed.json");
    std::fs::write(&similar_export, b"unrelated exact-id neighbor").unwrap();

    let result = registry
        .finalize_stopped_repair_batch(
            operation_id.clone(),
            targets.clone(),
            roots.clone(),
            incident_root.clone(),
            lifecycle_log.clone(),
        )
        .await
        .unwrap();

    assert_eq!(result.operation_id, operation_id);
    assert_eq!(result.status, SoulRepairStatus::Complete);
    assert_eq!(result.repaired_target_count, 9);
    assert_eq!(result.total_target_count, 9);
    assert_eq!(result.roots.len(), 7);
    assert!(result.roots.iter().all(|root| {
        root.canonical_soul_id.is_some()
            && root.import_status == freshell_runtime_protocol::RootRepairImportStatus::Complete
            && root.native_import_revision == Some(1)
    }));

    let conn = Connection::open(registry.database_path()).unwrap();
    for root_index in 0..7 {
        let canonical = &targets[root_index];
        let root_session_id = format!("ses_repair_root_{root_index}");
        let source_store_id = roots[root_index].source_store_id.clone();
        type RepairedSoulImportStateRow = (
            String,
            String,
            String,
            String,
            u64,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let (desired, recovery, import_state, authority, import_revision, stored_source, stored_root, loss_id): RepairedSoulImportStateRow = conn
            .query_row(
                "SELECT desired_state,recovery_state,native_import_state,native_import_authority, \
                 native_import_revision,native_import_source_store_id,native_import_root_session_id,loss_incident_id \
                 FROM souls WHERE soul_id=?1",
                params![canonical.soul_id.as_str()],
                |row| {
                    Ok((
                        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                        row.get(5)?, row.get(6)?, row.get(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(desired, "stopped");
        assert_eq!(recovery, "data_repair_complete");
        assert_eq!(import_state, "completed");
        assert_eq!(authority, "verified_import_receipt");
        assert_eq!(import_revision, 1);
        assert_eq!(stored_source.as_deref(), Some(source_store_id.as_str()));
        assert_eq!(stored_root.as_deref(), Some(root_session_id.as_str()));
        assert_eq!(loss_id, None);

        let origin: (Option<String>, String, String) = conn
            .query_row(
                "SELECT owner_soul_id,source_generation,ownership_state FROM native_origin_owners \
                 WHERE provider='opencode' AND source_store_id=?1 AND native_root_session_id=?2",
                params![source_store_id, root_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(origin.0.as_deref(), Some(canonical.soul_id.as_str()));
        assert_eq!(origin.1, roots[root_index].source_generation);
        assert_eq!(origin.2, "owned");

        let terminal_json: String = conn
            .query_row(
                "SELECT terminal_spec FROM incarnations WHERE incarnation_id=?1",
                params![contexts[root_index].prior_handle.incarnation_id().as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let terminal: serde_json::Value = serde_json::from_str(&terminal_json).unwrap();
        assert!(
            terminal.pointer("/opencodeTransfer").is_none(),
            "resume evidence must stay separate from the staged-transfer descriptor"
        );
    }

    let repaired_context = registry
        .recovery_context(targets[0].soul_id.clone())
        .await
        .unwrap();
    let persisted_baseline = repaired_context
        .opencode_adoption_baseline
        .clone()
        .expect("completed repair receipt supplies an exact resume baseline");
    assert!(repaired_context
        .terminal
        .as_ref()
        .is_some_and(|terminal| terminal.opencode_transfer.is_none()));
    let next_intent_revision = registry
        .start_stopped_data_repair(
            targets[0].soul_id.clone(),
            targets[0].expected_intent_revision,
        )
        .await
        .unwrap();
    let running_repaired_context = registry
        .recovery_context(targets[0].soul_id.clone())
        .await
        .unwrap();
    assert_eq!(
        running_repaired_context.intent_revision,
        next_intent_revision
    );
    let exact_candidate =
        crate::resume_catalog::exact_resume_candidate(&running_repaired_context, None);
    assert!(
        exact_candidate.is_ok(),
        "exact repaired resume candidate failed: {exact_candidate:?}"
    );
    // The authenticated-host path uses this candidate when the provider has
    // exited but the session host is still running; it must retain the
    // completed repair baseline before the host performs its current-store
    // check.
    let host_resume_spec = exact_candidate
        .unwrap()
        .expect("exact host resume candidate");
    assert_eq!(
        host_resume_spec.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        host_resume_spec
            .environment
            .get("OPENCODE_DB")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share/opencode/opencode.db")
    );
    // A legacy stored specification takes an early return in the base
    // candidate builder. The authenticated host must receive the repaired
    // evidence on this path too, even after the soul has left repair state.
    let mut stored_context = running_repaired_context.clone();
    stored_context.recovery_state = freshell_runtime_protocol::RecoveryState::Blocked;
    let mut legacy_spec = host_resume_spec.clone();
    legacy_spec.opencode_adoption_baseline = None;
    legacy_spec.environment.remove("OPENCODE_DB");
    stored_context.resume_spec = Some(legacy_spec);
    let stored_host_candidate = crate::resume_catalog::exact_resume_candidate(
        &stored_context,
        stored_context.native_session_id.as_deref(),
    )
    .unwrap()
    .expect("stored legacy host resume candidate");
    assert_eq!(
        stored_host_candidate.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        stored_host_candidate.environment.get("OPENCODE_DB"),
        host_resume_spec.environment.get("OPENCODE_DB")
    );

    let mut stale_spec = stored_host_candidate;
    let stale_baseline = &roots[1].adoption_baseline;
    assert_ne!(stale_baseline, &persisted_baseline);
    stale_baseline.validate().unwrap();
    stale_spec.opencode_adoption_baseline = Some(stale_baseline.clone());
    stored_context.resume_spec = Some(stale_spec);
    assert!(matches!(
        crate::resume_catalog::exact_resume_candidate(
            &stored_context,
            stored_context.native_session_id.as_deref(),
        ),
        Err(freshell_runtime_protocol::RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::WrongNativeIdentity,
            ..
        })
    ));
    let resume_probe = crate::recovery::offline_probe(&running_repaired_context).unwrap();
    let freshell_runtime_protocol::RecoveryProbe::ResumeReady { resume_spec, .. } = resume_probe
    else {
        panic!("repaired legacy soul should have an exact resume candidate: {resume_probe:?}");
    };
    assert_eq!(
        resume_spec.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        resume_spec
            .environment
            .get("OPENCODE_DB")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share/opencode/opencode.db")
    );
    assert_eq!(
        resume_spec
            .environment
            .get("XDG_DATA_HOME")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share")
    );

    let recovery_start = registry
        .begin_recovery_fenced(
            targets[0].soul_id.clone(),
            freshell_runtime_protocol::RecoveryTrigger::ManualRetry,
            freshell_runtime_protocol::RecoveryPath::NativeResume,
            running_repaired_context.write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_recovery_blocked(
            targets[0].soul_id.clone(),
            Some(recovery_start.attempt_id.clone()),
            RecoveryBlockReason::ProviderUnavailable,
            vec!["synthetic first resume reader failure".into()],
            recovery_start
                .context
                .write_fence_for_attempt(recovery_start.attempt_id.clone()),
        )
        .await
        .unwrap();
    let retrying_repaired_context = registry
        .recovery_context(targets[0].soul_id.clone())
        .await
        .unwrap();
    assert_eq!(
        retrying_repaired_context.recovery_state,
        freshell_runtime_protocol::RecoveryState::Blocked
    );
    let retry_probe = crate::recovery::offline_probe(&retrying_repaired_context).unwrap();
    let freshell_runtime_protocol::RecoveryProbe::ResumeReady {
        resume_spec: retry_spec,
        ..
    } = retry_probe
    else {
        panic!("repaired retry should preserve its adoption baseline: {retry_probe:?}");
    };
    assert_eq!(
        retry_spec.opencode_adoption_baseline,
        Some(persisted_baseline.clone())
    );
    assert_eq!(
        retry_spec
            .environment
            .get("OPENCODE_DB")
            .map(String::as_str),
        Some("/home/freshell/provider/.local/share/opencode/opencode.db")
    );

    let duplicate = &targets[7];
    let canonical_duplicate_root = &targets[6];
    let retired: (String, String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT desired_state,recovery_state,recovery_reason,loss_incident_id \
             FROM souls WHERE soul_id=?1",
            params![duplicate.soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        retired,
        (
            "stopped".into(),
            "stopped".into(),
            Some("RETIRED_DUPLICATE".into()),
            None
        )
    );
    let duplicate_authority: String = conn
        .query_row(
            "SELECT native_import_authority FROM souls WHERE soul_id=?1",
            params![duplicate.soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(duplicate_authority, "retired_duplicate");
    let second_duplicate:(String,String,Option<String>)=conn.query_row("SELECT recovery_state,native_import_authority,loss_incident_id FROM souls WHERE soul_id=?1",[targets[8].soul_id.as_str()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(
        second_duplicate,
        ("stopped".into(), "retired_duplicate".into(), None)
    );
    let rebound: String = conn
        .query_row(
            "SELECT soul_id FROM view_intents WHERE view_id='view-repair-balanced-8'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rebound,targets[0].soul_id.as_str(),"the second duplicate's explicit view survives on its deliberately selected canonical owner");
    assert_eq!(conn.query_row("SELECT count(*) FROM view_intents WHERE kind='automatic_primary' AND owner_id=?1 AND workspace_id=?2 AND soul_id IN (?3,?4)",params![owner_id,workspace_id,targets[0].soul_id.as_str(),targets[8].soul_id.as_str()],|row|row.get::<_,u64>(0)).unwrap(),1);

    let explicit_owner: (String, String, u64) = conn
        .query_row(
            "SELECT soul_id,owner_id,revision FROM view_intents WHERE view_id=?1",
            params![explicit_duplicate_view.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(explicit_owner.0, canonical_duplicate_root.soul_id.as_str());
    assert_eq!(explicit_owner.1, owner_id);
    assert!(explicit_owner.2 > 1);
    let automatic_views: Vec<String> = conn
        .prepare(
            "SELECT soul_id FROM view_intents WHERE owner_id=?1 AND workspace_id=?2 \
             AND kind='automatic_primary' AND soul_id IN (?3,?4) ORDER BY soul_id",
        )
        .unwrap()
        .query_map(
            params![
                owner_id,
                workspace_id,
                canonical_duplicate_root.soul_id.as_str(),
                duplicate.soul_id.as_str(),
            ],
            |row| row.get(0),
        )
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        automatic_views,
        vec![canonical_duplicate_root.soul_id.as_str().to_owned()],
        "the canonical automatic view remains and its duplicate collapses"
    );

    for target in &targets {
        let incident_count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM loss_incidents WHERE incident_id=?1 AND soul_id=?2",
                params![target.incident_id.as_str(), target.soul_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let tombstone_count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM stop_tombstones WHERE soul_id=?1 AND intent_revision=?2 \
                 AND actor='loss-certificate' AND reason=?3",
                params![
                    target.soul_id.as_str(),
                    target.expected_intent_revision,
                    format!("certified loss {}", target.incident_id),
                ],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(incident_count, 0);
        assert_eq!(tombstone_count, 0);
        for suffix in ["open", "final"] {
            let outbox_count: u64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE event_id=?1 AND event_kind=?2",
                    params![
                        format!("projection-loss-{suffix}-{}", target.incident_id),
                        if suffix == "open" {
                            "loss_incident.open"
                        } else {
                            "loss_incident.final"
                        },
                    ],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(outbox_count, 0);
        }
        assert!(!incident_root
            .join(format!("{}.open.json", target.incident_id))
            .exists());
        assert!(!incident_root
            .join(format!("{}.closed.json", target.incident_id))
            .exists());
    }

    let remaining_notice_incidents: Vec<String> = conn
        .prepare("SELECT incident_ids_json FROM runtime_notices")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let remaining_notice_ids = remaining_notice_incidents
        .iter()
        .flat_map(|encoded| serde_json::from_str::<Vec<String>>(encoded).unwrap())
        .collect::<BTreeSet<_>>();
    let false_incident_ids = targets
        .iter()
        .map(|target| target.incident_id.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    assert!(false_incident_ids.is_disjoint(&remaining_notice_ids));
    assert!(remaining_notice_ids.contains("incident-unrelated"));
    let projected_notice_payloads: Vec<String> = conn
        .prepare("SELECT payload FROM outbox WHERE event_kind='runtime.notice'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let projected_notice_ids = projected_notice_payloads
        .iter()
        .flat_map(|encoded| {
            serde_json::from_str::<serde_json::Value>(encoded)
                .unwrap()
                .get("incidentIds")
                .and_then(serde_json::Value::as_array)
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect::<BTreeSet<_>>();
    assert!(false_incident_ids.is_disjoint(&projected_notice_ids));
    assert!(projected_notice_ids.contains("incident-unrelated"));
    let unrelated_event_count: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE event_id='unrelated-sentinel' AND event_kind='unrelated.event'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unrelated_event_count, 1);
    let unrelated_notice_count: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outbox WHERE event_kind='runtime.notice' AND json_extract(payload,'$.incidentIds[0]')='incident-unrelated'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unrelated_notice_count, 1);

    assert_eq!(
        std::fs::read_to_string(incident_root.join("incidents.jsonl")).unwrap(),
        unrelated_line
    );
    assert_eq!(
        std::fs::read_to_string(&lifecycle_log).unwrap(),
        unrelated_line
    );
    assert_eq!(
        std::fs::read(&similar_export).unwrap(),
        b"unrelated exact-id neighbor"
    );
    let (status, marker_count): (String, u64) = conn
        .query_row(
            "SELECT o.status,(SELECT COUNT(*) FROM stopped_repair_withdrawals w WHERE w.operation_id=o.operation_id) \
             FROM stopped_repair_operations o WHERE o.operation_id=?1",
            params![operation_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "complete");
    assert_eq!(marker_count, 0);
}

#[tokio::test]
async fn stale_lifecycle_writer_does_not_recreate_withdrawn_incident_after_retraction() {
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap();
    Connection::open(registry.database_path())
        .unwrap()
        .execute(
            "DELETE FROM loss_incidents WHERE incident_id=?1",
            params![prepared.certificate.incident_id.as_str()],
        )
        .unwrap();

    let lifecycle = dir.path().join("lifecycle.jsonl");
    let written = crate::service::append_incident_event_if_current(
        &registry,
        &lifecycle,
        "supervisor.loss.finalized",
        serde_json::json!({
            "incidentId": prepared.certificate.incident_id,
            "soulId": prepared.certificate.soul_id,
        }),
        prepared.certificate.incident_id,
    )
    .await
    .unwrap();

    assert!(!written);
    assert!(!lifecycle.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_stale_exporter_and_rotator_preserve_exact_withdrawal() {
    #[cfg(unix)]
    if run_task007_owned_case_child(Task007OwnedCase::ConcurrentWithdrawal).await {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (registry, prepared) = prepared_loss(dir.path()).await;
    let incident = prepared.certificate.incident_id.clone();
    let queued = registry
        .pending_incident_exports(10)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.incident_id == incident)
        .unwrap();
    let incidents = dir.path().join("incidents");
    fs::create_dir_all(&incidents).unwrap();
    let lifecycle = dir.path().join("lifecycle.jsonl");
    // Prepare the retained history before any producer takes the shared
    // coordinator. A small real event must rotate it; serializing an oversized
    // live event under that coordinator would delay unrelated Stop operations.
    let unrelated = format!(
        "{}\n",
        serde_json::json!({
            "event": "unrelated",
            "incidentId": "incident-unrelated",
            "fictionalPadding": "x".repeat(10 * 1024 * 1024),
        })
    );
    let false_line = serde_json::json!({"incidentId":incident,"event":"false-loss"}).to_string();
    fs::write(&lifecycle, format!("{false_line}\n{unrelated}")).unwrap();
    let export = incidents.join(format!("{incident}.open.json"));
    fs::write(&export, &false_line).unwrap();
    let exporter = IncidentExporter::new(&incidents, "fixture-control-secret");
    let (held_tx, held_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let database = registry.database_path().to_path_buf();
    let queued_event_id = queued.event_id.clone();
    let retract_exporter = exporter.clone();
    let retract_lifecycle = lifecycle.clone();
    let retract_incident = incident.clone();
    let retraction = std::thread::spawn(move || {
        let waiting = std::time::Instant::now();
        let _coordinator = crate::loss_report::incident_file_coordinator();
        let acquired = std::time::Instant::now();
        held_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let producers_ready = std::time::Instant::now();
        let conn = Connection::open(database).unwrap();
        // Model the committed exact withdrawal while queued producers retain
        // their older snapshots; their production rechecks must reject them.
        conn.execute("DELETE FROM outbox WHERE event_id=?1", [&queued_event_id])
            .unwrap();
        conn.execute(
            "DELETE FROM loss_incidents WHERE incident_id=?1",
            [retract_incident.as_str()],
        )
        .unwrap();
        retract_exporter
            .retract_false_incidents_coordinated(
                &BTreeSet::from([retract_incident.to_string()]),
                &retract_lifecycle,
            )
            .unwrap();
        let completed = std::time::Instant::now();
        drop(_coordinator);
        eprintln!(
            "{}",
            serde_json::json!({"severity":"debug","event":"task007.withdrawal.coordinator_timing",
            "waitMs":acquired.duration_since(waiting).as_millis(),
            "producerWaitMs":producers_ready.duration_since(acquired).as_millis(),
            "retractionMs":completed.duration_since(producers_ready).as_millis(),
            "holdMs":completed.duration_since(acquired).as_millis()})
        );
    });
    held_rx.await.unwrap();
    let stale_registry = registry.clone();
    let stale_exporter = exporter.clone();
    let (export_ready_tx, export_ready_rx) = tokio::sync::oneshot::channel();
    let stale_export = tokio::spawn(async move {
        export_ready_tx.send(()).unwrap();
        stale_registry
            .export_and_ack_incident(queued, stale_exporter)
            .await
            .unwrap()
    });
    let writer_registry = registry.clone();
    let writer_lifecycle = lifecycle.clone();
    let writer_incident = incident.clone();
    let (writer_ready_tx, writer_ready_rx) = tokio::sync::oneshot::channel();
    let stale_writer = tokio::spawn(async move {
        writer_ready_tx.send(()).unwrap();
        crate::service::append_incident_event_if_current(
            &writer_registry,
            &writer_lifecycle,
            "stale.loss.finalized",
            serde_json::json!({"incidentId":writer_incident}),
            writer_incident,
        )
        .await
        .unwrap()
    });
    let rotate_lifecycle = lifecycle.clone();
    let (rotate_ready_tx, rotate_ready_rx) = tokio::sync::oneshot::channel();
    let rotator = tokio::task::spawn_blocking(move || {
        rotate_ready_tx.send(()).unwrap();
        crate::service::append_event(
            &rotate_lifecycle,
            "unrelated.rotation",
            serde_json::json!({"fixture":"rotation"}),
        );
    });
    export_ready_rx.await.unwrap();
    writer_ready_rx.await.unwrap();
    rotate_ready_rx.await.unwrap();
    release_tx.send(()).unwrap();
    retraction.join().unwrap();
    assert!(stale_export.await.unwrap().is_none());
    assert!(!stale_writer.await.unwrap());
    rotator.await.unwrap();
    assert!(!export.exists());
    let rotated = lifecycle.with_file_name("lifecycle.jsonl.1");
    assert!(fs::read_to_string(&rotated).unwrap() == unrelated);
    let current = fs::read_to_string(&lifecycle).unwrap();
    assert!(!current.contains(incident.as_str()));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(current.trim()).unwrap()["event"],
        "unrelated.rotation"
    );
    assert!(registry
        .pending_incident_exports(10)
        .await
        .unwrap()
        .iter()
        .all(|event| event.incident_id != incident));
}

#[test]
fn incident_export_redacts_and_never_evicts_open_reports() {
    let dir = tempfile::tempdir().unwrap();
    let exporter = IncidentExporter::new(dir.path(), "top-secret-native-id");
    let open = dir.path().join("incident-open.open.json");
    fs::write(&open, b"open").unwrap();
    let finalized_open = dir.path().join("incident-new.open.json");
    fs::write(&finalized_open, b"open").unwrap();
    let old = dir.path().join("incident-old.closed.json");
    fs::write(&old, vec![b'x'; 8]).unwrap();
    exporter
        .export_summary(
            &IncidentId::parse("incident-new").unwrap(),
            true,
            &serde_json::json!({
                "token": "top-secret-native-id",
                "safe": "retained"
            }),
        )
        .unwrap();
    assert!(open.exists());
    assert!(!finalized_open.exists());
    let content = fs::read_to_string(dir.path().join("incident-new.closed.json")).unwrap();
    assert!(!content.contains("top-secret-native-id"));
    assert!(content.contains("retained"));
}

#[test]
fn withdraw_false_incident_jsonl_matches_structured_ids_not_substrings() {
    let input = concat!(
        "{\"event\":\"soul.loss.finalized\",\"incidentId\":\"incident-target\",\"data\":{\"incidentId\":\"incident-target\"}}\n",
        "{\"incidentId\":\"incident-target-extra\",\"message\":\"incident-target\"}\n",
        "{\"incidentIds\":[\"incident-target\",\"incident-other\"],\"event\":\"notice\"}\n",
        "{\"event\":\"unrelated\",\"message\":\"mentions incident-target in prose\"}\n",
    );
    let targets = BTreeSet::from(["incident-target".to_string()]);

    let filtered = filter_incident_jsonl(input.as_bytes(), &targets).unwrap();

    assert_eq!(
        String::from_utf8(filtered).unwrap(),
        concat!(
            "{\"incidentId\":\"incident-target-extra\",\"message\":\"incident-target\"}\n",
            "{\"event\":\"unrelated\",\"message\":\"mentions incident-target in prose\"}\n",
        )
    );
}

#[test]
fn withdraw_false_incident_jsonl_blocks_unclassifiable_records() {
    let targets = BTreeSet::from(["incident-target".to_string()]);
    let input = b"{\"incidentId\":\"incident-target\"}\nnot-json\n";

    let error = filter_incident_jsonl(input, &targets).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("record 2"));
}

#[test]
fn withdraw_false_incidents_removes_exact_exports_and_rewrites_rotations() {
    let dir = tempfile::tempdir().unwrap();
    let incident_root = dir.path().join("incidents");
    let lifecycle = dir.path().join("lifecycle.jsonl");
    std::fs::create_dir_all(&incident_root).unwrap();
    let false_id = "incident-false-1";
    let similar_id = "incident-false-10";

    std::fs::write(
        incident_root.join("incidents.jsonl"),
        format!(
            "{{\"incidentId\":\"{false_id}\",\"event\":\"false\"}}\n{{\"incidentId\":\"{similar_id}\",\"event\":\"unrelated\"}}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        incident_root.join("incidents.jsonl.1"),
        format!(
            "{{\"incidentIds\":[\"{false_id}\",\"another\"],\"event\":\"mixed\"}}\n{{\"event\":\"body mentions {false_id}\"}}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        &lifecycle,
        format!("{{\"data\":{{\"incident_id\":\"{false_id}\"}}}}\n{{\"event\":\"keep\"}}\n"),
    )
    .unwrap();
    std::fs::write(
        incident_root.join(format!("{false_id}.open.json")),
        b"obsolete open export",
    )
    .unwrap();
    std::fs::write(
        incident_root.join(format!("{false_id}.closed.json")),
        b"obsolete closed export",
    )
    .unwrap();
    std::fs::write(
        incident_root.join(format!("{similar_id}.open.json")),
        b"unrelated export",
    )
    .unwrap();

    IncidentExporter::new(&incident_root, "test-secret")
        .retract_false_incidents_coordinated(&BTreeSet::from([false_id.to_string()]), &lifecycle)
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(incident_root.join("incidents.jsonl")).unwrap(),
        format!("{{\"incidentId\":\"{similar_id}\",\"event\":\"unrelated\"}}\n")
    );
    assert_eq!(
        std::fs::read_to_string(incident_root.join("incidents.jsonl.1")).unwrap(),
        format!("{{\"event\":\"body mentions {false_id}\"}}\n")
    );
    assert_eq!(
        std::fs::read_to_string(&lifecycle).unwrap(),
        "{\"event\":\"keep\"}\n"
    );
    assert!(!incident_root.join(format!("{false_id}.open.json")).exists());
    assert!(!incident_root
        .join(format!("{false_id}.closed.json"))
        .exists());
    assert!(incident_root
        .join(format!("{similar_id}.open.json"))
        .exists());
}

#[test]
fn withdraw_false_incidents_classifies_all_rotations_before_mutating() {
    let dir = tempfile::tempdir().unwrap();
    let incident_root = dir.path().join("incidents");
    let lifecycle = dir.path().join("lifecycle.jsonl");
    std::fs::create_dir_all(&incident_root).unwrap();
    let first = incident_root.join("incidents.jsonl");
    std::fs::write(&first, b"{\"incidentId\":\"incident-false-1\"}\n").unwrap();
    std::fs::write(incident_root.join("incidents.jsonl.1"), b"not-json\n").unwrap();

    let error = IncidentExporter::new(&incident_root, "test-secret")
        .retract_false_incidents_coordinated(
            &BTreeSet::from(["incident-false-1".to_string()]),
            &lifecycle,
        )
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(
        std::fs::read_to_string(first).unwrap(),
        "{\"incidentId\":\"incident-false-1\"}\n"
    );
}

#[test]
fn ownership_capability_types_remain_in_supervisor_crate() {
    let _ = std::any::TypeId::of::<OwnedRuntimeHandle>();
    let _ = std::any::TypeId::of::<RecoveryContext>();
    let _ = std::any::TypeId::of::<LaunchPreparation>();
    let _ = std::any::TypeId::of::<Supervisor>();
    let _ = std::any::TypeId::of::<SupervisorConfig>();
    let _ = std::any::TypeId::of::<AdmissionPolicy>();
    let _ = std::any::TypeId::of::<RuntimeLimits>();
    let _ = std::any::TypeId::of::<RuntimeProfile>();
    let _ = std::any::TypeId::of::<FixtureKind>();
    let _ = std::any::TypeId::of::<SoulId>();
    let _ = std::any::TypeId::of::<IncarnationId>();
    let _ = std::any::TypeId::of::<LaunchNonce>();
    let _ = std::any::TypeId::of::<DockerDaemonId>();
    let _ = std::any::TypeId::of::<AllocationState>();
    let _ = std::any::TypeId::of::<DurabilityState>();
    let _ = std::any::TypeId::of::<RecoveryBlockReason>();
}

async fn stopped_legacy_fixture_target(
    registry: &Registry,
    root: &std::path::Path,
    native_root: &str,
) -> freshell_runtime_protocol::LostSoulRepairTarget {
    let _setup = STOPPED_REPAIR_FIXTURE_SETUP.lock().await;
    let context = prepared_context_in_registry(registry, root).await;
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE souls SET native_session_id=?1 WHERE soul_id=?2",
        params![native_root, context.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);
    let context = registry.recovery_context(context.soul_id).await.unwrap();
    let prepared = registry
        .prepare_loss(decision_for(registry, &context).unwrap())
        .await
        .unwrap();
    registry
        .finalize_loss_cleanup(
            prepared.certificate.incident_id.clone(),
            freshell_runtime_protocol::StopOutcome::VerifiedEmpty,
            cleanup(&prepared),
        )
        .await
        .unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute("UPDATE souls SET native_import_state='legacy_unknown',native_import_authority='legacy_unknown',native_import_source_store_id=NULL,native_import_root_session_id=NULL,native_import_source_generation=NULL,native_import_schema_fingerprint=NULL,native_import_migration_fingerprint=NULL,native_import_complete_inventory=0 WHERE soul_id=?1",[prepared.certificate.soul_id.as_str()]).unwrap();
    conn.execute("UPDATE loss_incidents SET captured_native_import_state='legacy_unknown',captured_native_import_authority='legacy_unknown',captured_native_import_complete=0,captured_source_store_id=NULL,captured_root_session_id=NULL,captured_source_generation=NULL,captured_source_schema_fingerprint=NULL,captured_migration_fingerprint=NULL WHERE incident_id=?1",[prepared.certificate.incident_id.as_str()]).unwrap();
    freshell_runtime_protocol::LostSoulRepairTarget {
        soul_id: prepared.certificate.soul_id,
        incident_id: prepared.certificate.incident_id,
        expected_intent_revision: prepared.committed_intent_revision,
    }
}

#[tokio::test]
async fn durable_souls_stopped_scope_freezes_deliberate_owner_choices() {
    use freshell_runtime_protocol::{CanonicalOwnerChoice, RequestId, RestoreLostSoulsRequest};
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let mut targets = Vec::new();
    for _ in 0..2 {
        targets.push(
            stopped_legacy_fixture_target(&registry, dir.path(), "ses_fixture_root_alpha").await,
        );
    }
    let scope = test_repair_scope(&registry, &targets);
    let root = scope.roots[0].root_session_id.clone();
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: scope.source_selection(),
        targets: targets.clone(),
        canonical_owners: vec![CanonicalOwnerChoice {
            root_session_id: root.clone(),
            soul_id: targets[0].soul_id.clone(),
            expected_intent_revision: targets[0].expected_intent_revision,
        }],
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let operation = RequestId::new();
    registry
        .prepare_stopped_repair_operation(operation.clone(), request.clone(), scope.clone())
        .await
        .unwrap();
    let mut changed = request.clone();
    changed.canonical_owners[0].soul_id = targets[1].soul_id.clone();
    changed.canonical_owners[0].expected_intent_revision = targets[1].expected_intent_revision;
    assert!(
        registry
            .prepare_stopped_repair_operation(operation.clone(), changed, scope.clone())
            .await
            .is_err(),
        "a retry cannot select a different canonical managed store under the original operation"
    );
    let mut removed = request.clone();
    removed.canonical_owners.clear();
    assert!(
        registry
            .prepare_stopped_repair_operation(operation.clone(), removed, scope.clone())
            .await
            .is_err(),
        "durable deliberate selection cannot disappear on retry"
    );
    registry
        .prepare_stopped_repair_operation(operation.clone(), request.clone(), scope.clone())
        .await
        .unwrap();
    registry
        .upsert_view_intent(freshell_runtime_protocol::UpsertViewIntentRequest {
            soul_id: targets[1].soul_id.clone(),
            view_id: None,
            intent: freshell_runtime_protocol::ViewIntentRequest {
                owner_id: "fixture-owner-drift".into(),
                workspace_id: "test-project".into(),
                kind: freshell_runtime_protocol::ViewIntentKind::Explicit,
                ..Default::default()
            },
            expected_revision: None,
            expected_soul_intent_revision: targets[1].expected_intent_revision,
            expected_control_epoch: None,
        })
        .await
        .unwrap();
    assert!(registry.prepare_stopped_repair_operation(operation,request,scope).await.is_err(),"changed explicit owner evidence invalidates the frozen owner selection before receipts or retirement");
}

#[tokio::test]
async fn durable_souls_schema_seven_nine_rows_remain_unbound_until_verified_repair() {
    use freshell_runtime_protocol::{
        CanonicalOwnerChoice, RepairBatchSourceSelection, RequestId, RestoreLostSoulsRequest,
    };
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let names = [
        "ses_fixture_root_alpha",
        "ses_fixture_root_beta",
        "ses_fixture_root_gamma",
        "ses_fixture_root_delta",
        "ses_fixture_root_epsilon",
        "ses_fixture_root_zeta",
        "ses_fixture_root_eta",
    ];
    let mut targets = Vec::new();
    for index in 0..9 {
        let root = if index == 7 {
            names[0]
        } else if index == 8 {
            names[1]
        } else {
            names[index]
        };
        targets.push(stopped_legacy_fixture_target(&registry, dir.path(), root).await);
    }
    let database = registry.database_path().to_path_buf();
    drop(registry);
    let conn = Connection::open(&database).unwrap();
    task007_schema_seven(&conn).unwrap();
    assert_eq!(conn.query_row("SELECT count(*) FROM pragma_table_info('souls') WHERE name IN ('identity_revision','native_import_revision')",[],|row|row.get::<_,u64>(0)).unwrap(),0);
    assert_eq!(conn.query_row("SELECT count(*) FROM souls WHERE desired_state='stopped' AND recovery_state='lost' AND intent_revision=2",[],|row|row.get::<_,u64>(0)).unwrap(),9);
    assert_eq!(conn.query_row("SELECT count(*) FROM loss_incidents WHERE intent_revision=1 AND cleanup_state='closed'",[],|row|row.get::<_,u64>(0)).unwrap(),9);
    drop(conn);
    let registry = Registry::open(dir.path(), None)
        .expect("production opener migrates the actual absent-column/table shape");
    let source = RepairBatchSourceSelection {
        source_store_id: "a".repeat(64),
        root_session_ids: names.iter().map(|name| name.to_string()).collect(),
    };
    let members = registry.repair_scope_members(source.clone()).await.unwrap();
    assert_eq!(members.len(), 9);
    for target in &targets {
        let context = registry
            .recovery_context(target.soul_id.clone())
            .await
            .unwrap();
        assert_eq!(
            context.native_import_state,
            NativeImportState::LegacyUnknown
        );
        assert_eq!(context.native_import_authority, "legacy_unknown");
        assert!(!context.native_import_complete_inventory);
        assert!(context.native_import_source_store_id.is_none());
        assert!(context.native_import_source_generation.is_none());
        // This revision records the pre-existing identity string; it proves
        // neither provider observation nor source absence/import completion.
        assert_eq!(context.identity_revision, 1);
        assert_eq!(context.native_import_revision, 0);
    }
    let scope = test_repair_scope(&registry, &targets);
    assert_eq!(scope.roots.len(), 7);
    for root in names.iter().take(2) {
        let candidates = registry
            .stopped_repair_owner_candidates(root.to_string())
            .await
            .unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(
            matches!(crate::recovery::choose_canonical_root_owner(&candidates,&source.source_store_id,root,&scope.roots.iter().find(|selected|selected.root_session_id==*root).unwrap().graph_digest,None).unwrap(),crate::recovery::CanonicalRootOwnerSelection::ChoiceRequired(ref alternatives) if alternatives.len()==2)
        );
    }
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source,
        targets: targets.clone(),
        canonical_owners: [0usize, 1]
            .into_iter()
            .map(|index| CanonicalOwnerChoice {
                root_session_id: names[index].into(),
                soul_id: targets[index].soul_id.clone(),
                expected_intent_revision: 2,
            })
            .collect(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let operation = RequestId::new();
    registry
        .prepare_stopped_repair_operation(operation.clone(), request, scope)
        .await
        .unwrap();
    assert!(registry.finalize_stopped_repair_batch(operation,targets.clone(),Vec::new(),dir.path().join("incidents"),dir.path().join("lifecycle.jsonl")).await.is_err(),"legacy zero revisions cannot certify restoration without exact completed import/read receipts");
    let conn = Connection::open(registry.database_path()).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM loss_incidents", [], |row| row
            .get::<_, u64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM native_origin_owners", [], |row| row
            .get::<_, u64>(
            0
        ))
        .unwrap(),
        0
    );
}

async fn import_stopped_fixture_root(
    registry: &Registry,
    target: &freshell_runtime_protocol::LostSoulRepairTarget,
    database: &std::path::Path,
    workspace: &std::path::Path,
    fixture_root: &std::path::Path,
    root: &str,
    expected_generation: &str,
) -> crate::registry::StoppedRepairRootReceipt {
    use freshell_agent_runtime::opencode_transfer::{
        import_bundle_payload, verify_installed_store, InstalledStoreReaderContext,
    };
    use freshell_runtime_protocol::{
        opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeAdoptionBaseline,
        OpenCodeTransferDescriptor, OpenCodeTransferFile, OPENCODE_TRANSFER_DESTINATION_DB,
    };
    use sha2::{Digest, Sha256};
    let context = registry
        .recovery_context(target.soul_id.clone())
        .await
        .unwrap();
    let snapshot = freshell_sessions::opencode_transfer::export_exact_session(
        &freshell_sessions::opencode_transfer::HostOpenCodeInventory::new(database.to_path_buf())
            .with_trusted_mount_for_selected_session(workspace.to_path_buf()),
        root,
        freshell_sessions::opencode_transfer::ExportOptions::new(
            fixture_root.join("root-extractions"),
        ),
    )
    .unwrap();
    let manifest = snapshot.manifest();
    assert_eq!(manifest.generation, expected_generation);
    let image = context.prior_handle.image_ref().to_owned();
    let mut descriptor = OpenCodeTransferDescriptor {
        transfer_id: format!("fixture-import-{}", target.soul_id),
        provider: "opencode".into(),
        source_store_id: manifest.source_store_id.clone(),
        root_session_id: root.to_string(),
        source_generation: manifest.generation.clone(),
        provider_schema: manifest.provider_schema.clone(),
        source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
        destination_store_id: context.provider_store_id.clone(),
        destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
        target_image_ref: image.clone(),
        target_build_receipt: opencode_target_build_receipt(&image, "opencode-1.18.21"),
        incarnation_id: context.prior_handle.incarnation_id().to_string(),
        manifest_json: serde_json::to_string(manifest).unwrap(),
        files: vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: manifest.payload_bytes,
            sha256: manifest.payload_sha256.clone(),
        }],
        total_bytes: manifest.payload_bytes,
        bundle_sha256: String::new(),
    };
    descriptor.bundle_sha256 =
        opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
    let home = fixture_root.join(format!("provider-{}", target.soul_id));
    let data = home.join(".local/share");
    let config = home.join(".config");
    std::fs::create_dir_all(&config).unwrap();
    let destination = data.join("opencode/opencode.db");
    let imported = import_bundle_payload(
        &descriptor,
        snapshot.open_payload().unwrap(),
        &destination,
        workspace,
    )
    .unwrap();
    #[cfg(unix)]
    let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    #[cfg(not(unix))]
    let (uid, gid) = (0, 0);
    let readable = verify_installed_store(
        &descriptor,
        &InstalledStoreReaderContext {
            database_path: &destination,
            workspace_root: workspace,
            provider_uid: uid,
            provider_gid: gid,
            home: &home,
            xdg_data_home: &data,
            xdg_config_home: &config,
            cwd: workspace,
        },
    )
    .unwrap();
    assert_eq!(readable.structural_sha256, imported.structural_sha256);
    assert_eq!(imported.row_count, manifest.row_count as u64);
    assert!(imported.row_count > 0);
    let execution_generation: u64 = Connection::open(registry.database_path())
        .unwrap()
        .query_row(
            "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1",
            [context.prior_handle.incarnation_id().as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let receipt = crate::registry::StoppedRepairRootReceipt {
        root_session_id: root.to_string(),
        canonical_soul_id: target.soul_id.clone(),
        transfer_id: descriptor.transfer_id.clone(),
        adoption_baseline: OpenCodeAdoptionBaseline {
            descriptor: descriptor.clone(),
            manifest_sha256: format!("{:x}", Sha256::digest(descriptor.manifest_json.as_bytes())),
        },
        destination_store_id: context.provider_store_id.clone(),
        source_store_id: descriptor.source_store_id.clone(),
        source_generation: descriptor.source_generation.clone(),
        bundle_sha256: descriptor.bundle_sha256.clone(),
        source_schema_fingerprint: descriptor.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: descriptor.migration_journal_fingerprint.clone(),
        target_image_ref: descriptor.target_image_ref.clone(),
        target_build_receipt: descriptor.target_build_receipt.clone(),
        row_count: imported.row_count,
        asset_count: imported.asset_count,
        structural_sha256: imported.structural_sha256,
        provider_uid: context.terminal.as_ref().unwrap().run_as_uid,
        provider_gid: context.terminal.as_ref().unwrap().run_as_gid,
        reader_environment_sha256: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&readable).unwrap())
        ),
        captured_identity_revision: context.identity_revision,
        captured_evidence_revision: context.evidence_revision,
        captured_intent_revision: context.intent_revision,
        captured_native_import_revision: context.native_import_revision,
        captured_native_import_state: context.native_import_state.as_str().into(),
        captured_native_import_authority: context.native_import_authority.clone(),
        incarnation_id: context.prior_handle.incarnation_id().clone(),
        execution_generation,
    };
    receipt
}

#[cfg(unix)]
enum Task007OwnedCase {
    BaselineRetry,
    ConcurrentWithdrawal,
}

#[cfg(unix)]
async fn run_task007_owned_case_child(case: Task007OwnedCase) -> bool {
    use std::os::unix::fs::OpenOptionsExt;
    let needs_fixture_slot = matches!(&case, Task007OwnedCase::BaselineRetry);
    let (flag, name) = match case {
        Task007OwnedCase::BaselineRetry => (
            "FRESHELL_TASK007_BASELINE_RETRY_CHILD",
            "loss_report::tests::stopped_repair_resume_failure_retry_preserves_baseline",
        ),
        Task007OwnedCase::ConcurrentWithdrawal => (
            "FRESHELL_TASK007_WITHDRAWAL_CONCURRENCY_CHILD",
            "loss_report::tests::concurrent_stale_exporter_and_rotator_preserve_exact_withdrawal",
        ),
    };
    if std::env::var(flag).ok().as_deref() == Some("1") {
        return false;
    }
    let _setup = if needs_fixture_slot {
        let queued = std::time::Instant::now();
        let guard = STOPPED_REPAIR_FIXTURE_SETUP.lock().await;
        eprintln!(
            "{}",
            serde_json::json!({
                "severity":"debug", "event":"task007.owned_case_child.fixture_slot_acquired",
                "case":name, "queueWaitMs":queued.elapsed().as_millis(),
            })
        );
        Some(guard)
    } else {
        None
    };
    let home = tempfile::tempdir().unwrap();
    let stdout_path = home.path().join("stdout.log");
    let stderr_path = home.path().join("stderr.log");
    let private_output = |path: &std::path::Path| {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap()
    };
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture"])
        .env_clear()
        .env(flag, "1")
        .env("HOME", home.path())
        .env("XDG_DATA_HOME", home.path().join("data"))
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .stdout(private_output(&stdout_path))
        .stderr(private_output(&stderr_path))
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_secs(60);
    let mut limit = None;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        let output_exceeded = [&stdout_path, &stderr_path]
            .iter()
            .any(|path| fs::metadata(path).unwrap().len() > 2 * 1024 * 1024);
        let expired = std::time::Instant::now() >= deadline;
        if expired || output_exceeded {
            limit = Some((expired, output_exceeded));
            child.kill().unwrap();
            break child.wait().unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    let stdout_bytes = fs::metadata(&stdout_path).unwrap().len();
    let stderr_bytes = fs::metadata(&stderr_path).unwrap().len();
    if limit.is_some() || !status.success() || stdout_bytes.max(stderr_bytes) > 2 * 1024 * 1024 {
        use std::io::{Read, Seek, SeekFrom};
        let tail = |path: &std::path::Path| {
            let mut file = fs::File::open(path).unwrap();
            let start = file.metadata().unwrap().len().saturating_sub(16 * 1024);
            file.seek(SeekFrom::Start(start)).unwrap();
            let mut bytes = Vec::new();
            file.take(16 * 1024).read_to_end(&mut bytes).unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        // These are private synthetic fixture streams, never provider output.
        // Read them after reaping and before TempDir removes the diagnostics.
        let diagnostic = serde_json::json!({
            "severity":"error", "event":"task007.owned_case_child.failed",
            "case":name, "pid":child.id(), "elapsedMs":started.elapsed().as_millis(),
            "deadlineExceeded":limit.is_some_and(|(expired, _)| expired),
            "outputExceeded":stdout_bytes.max(stderr_bytes) > 2 * 1024 * 1024,
            "stdoutBytes":stdout_bytes, "stderrBytes":stderr_bytes,
            "status":status.to_string(), "stdoutTail":tail(&stdout_path), "stderrTail":tail(&stderr_path),
        });
        panic!("owned {name} child failed: {diagnostic}");
    }
    let stdout = fs::read_to_string(stdout_path).unwrap();
    let stderr = fs::read_to_string(stderr_path).unwrap();
    assert!(status.success(), "{stdout}\n{stderr}");
    assert_eq!(stdout.matches("test result:").count(), 1);
    assert!(
        stdout.contains("test result: ok. 1 passed; 0 failed; 0 ignored;"),
        "exact owned child must execute its one case: {stdout}\n{stderr}"
    );
    eprintln!(
        "{}",
        serde_json::json!({"severity":"debug", "event":"task007.owned_case_child.completed",
        "case":name, "pid":child.id(), "selected":1, "executed":1, "passed":1, "exitCode":status.code(), "elapsedMs":started.elapsed().as_millis()})
    );
    true
}

#[tokio::test]
async fn stopped_repair_resume_failure_retry_preserves_baseline() {
    #[cfg(unix)]
    if run_task007_owned_case_child(Task007OwnedCase::BaselineRetry).await {
        return;
    }
    Box::pin(stopped_repair_baseline_case(
        StoppedRepairBaselineCase::Retry,
    ))
    .await;
}

#[tokio::test]
async fn pending_stopped_repair_withdrawal_allows_startup_without_losing_baseline() {
    Box::pin(stopped_repair_baseline_case(
        StoppedRepairBaselineCase::PendingWithdrawal,
    ))
    .await;
}

#[tokio::test]
async fn stopped_repair_created_preflight_preserves_baseline() {
    Box::pin(stopped_repair_baseline_case(
        StoppedRepairBaselineCase::CreatedPreflight,
    ))
    .await;
}

#[tokio::test]
async fn baseline_only_resume_stop_cancels_late_readiness_preserving_imported_graph() {
    Box::pin(stopped_repair_baseline_case(
        StoppedRepairBaselineCase::StopCancellation,
    ))
    .await;
}

enum StoppedRepairBaselineCase {
    Retry,
    PendingWithdrawal,
    CreatedPreflight,
    StopCancellation,
}

fn stopped_repair_fixture_phase(root: &std::path::Path, phase: &str, ordinal: Option<usize>) {
    eprintln!(
        "{}",
        serde_json::json!({
            "severity":"debug", "event":"task007.baseline_fixture.phase",
            "pid":std::process::id(), "atMs":crate::registry::now_millis(),
            "fixtureRoot":root, "phase":phase, "ordinal":ordinal,
        })
    );
}

// Setup and unused scenarios must return before polling ordinary recovery.
// Keeping all four cases in one async body also keeps their debug poll
// temporaries on the active stack, even when the outer future is boxed.
struct StoppedRepairBaselineFixture {
    dir: tempfile::TempDir,
    registry: Registry,
    supervisor: Supervisor,
    workspace: std::path::PathBuf,
    database: std::path::PathBuf,
    source_bytes: Vec<u8>,
    names: Vec<String>,
    targets: Vec<freshell_runtime_protocol::LostSoulRepairTarget>,
    scope: freshell_runtime_protocol::RepairBatchScope,
    request: freshell_runtime_protocol::RestoreLostSoulsRequest,
    operation: freshell_runtime_protocol::RequestId,
    receipts: Vec<crate::registry::StoppedRepairRootReceipt>,
    stores: Vec<(std::path::PathBuf, Vec<u8>)>,
}

async fn stopped_repair_baseline_case(case: StoppedRepairBaselineCase) {
    let mut fixture = Box::pin(prepare_stopped_repair_baseline()).await;
    stopped_repair_fixture_phase(fixture.dir.path(), "setup.complete", None);
    Box::pin(import_stopped_repair_baseline(&mut fixture)).await;
    stopped_repair_fixture_phase(fixture.dir.path(), "imports.complete", None);
    if matches!(case, StoppedRepairBaselineCase::PendingWithdrawal) {
        fixture = Box::pin(pending_stopped_repair_baseline(fixture)).await;
    }
    stopped_repair_fixture_phase(fixture.dir.path(), "finalize.begin", None);
    Box::pin(finalize_stopped_repair_baseline(&fixture)).await;
    stopped_repair_fixture_phase(fixture.dir.path(), "finalize.complete", None);
    let soul = fixture.targets[0].soul_id.clone();
    if matches!(case, StoppedRepairBaselineCase::CreatedPreflight) {
        crate::recovery::tests::assert_created_repaired_preflight(
            &fixture.dir,
            &fixture.registry,
            &soul,
        )
        .await;
    }
    let cancelled = if matches!(case, StoppedRepairBaselineCase::StopCancellation) {
        Some(
            Box::pin(
                crate::recovery::automatic_retry_tests::assert_baseline_only_stop_cancellation(
                    &fixture.dir,
                    &fixture.registry,
                    &soul,
                ),
            )
            .await,
        )
    } else {
        Box::pin(retry_stopped_repair_baseline(&fixture)).await;
        None
    };
    stopped_repair_fixture_phase(fixture.dir.path(), "reopen.begin", None);
    Box::pin(reopen_stopped_repair_baseline(fixture, cancelled)).await;
}

async fn prepare_stopped_repair_baseline() -> StoppedRepairBaselineFixture {
    use freshell_runtime_protocol::{
        CanonicalOwnerChoice, PreflightLostSoulsRequest, RepairBatchSourceSelection, RequestId,
        RestoreLostSoulsRequest,
    };
    use freshell_sessions::opencode_transfer::{
        pinned_destination_migration_ids, pinned_destination_schema_sql, HostOpenCodeInventory,
    };
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    stopped_repair_fixture_phase(dir.path(), "setup.begin", None);
    let registry = Registry::open(dir.path(), None).unwrap();
    let workspace = dir.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let database = dir.path().join("source.sqlite");
    let source = Connection::open(&database).unwrap();
    source
        .execute_batch(pinned_destination_schema_sql())
        .unwrap();
    for migration in pinned_destination_migration_ids() {
        source
            .execute(
                "INSERT INTO migration(id,time_completed) VALUES (?1,1)",
                [migration],
            )
            .unwrap();
    }
    source.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('baseline-project',?1,1,1,'[]')", [workspace.to_string_lossy().as_ref()]).unwrap();
    source.execute("INSERT INTO project_directory(project_id,directory,time_created) VALUES ('baseline-project',?1,1)", [workspace.to_string_lossy().as_ref()]).unwrap();
    let names = (0..7)
        .map(|index| format!("ses_baseline_root_{index}"))
        .collect::<Vec<_>>();
    for root in &names {
        let child = format!("{root}_child");
        for (id, parent) in [
            (root.clone(), None),
            (child.clone(), Some(root.clone())),
            (format!("{root}_grandchild"), Some(child)),
        ] {
            source.execute("INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,'baseline-project',?2,'baseline',?3,'fictional saved graph','1.18.21',1,1)", params![id,parent,workspace.to_string_lossy().as_ref()]).unwrap();
            source.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES (?1,?2,1,1,?3)", params![format!("msg_{id}"),id,serde_json::json!({"role":"user","text":"fictional saved history"}).to_string()]).unwrap();
            source.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?1,?2,?3,1,1,?4)", params![format!("prt_{id}"),format!("msg_{id}"),id,serde_json::json!({"type":"text","text":"fictional saved part"}).to_string()]).unwrap();
        }
    }
    drop(source);
    let source_bytes = fs::read(&database).unwrap();
    let mut targets = Vec::new();
    #[cfg(unix)]
    let (provider_uid, provider_gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    #[cfg(not(unix))]
    let (provider_uid, provider_gid) = (0, 0);
    for index in 0..9 {
        stopped_repair_fixture_phase(dir.path(), "target.begin", Some(index));
        let target = stopped_legacy_fixture_target(&registry, dir.path(), &names[index % 7]).await;
        let terminal = serde_json::json!({"terminalId":format!("terminal-{}",target.soul_id),"streamId":format!("stream-{}",target.soul_id),"mode":"opencode","program":"opencode","env":{"HOME":"/home/freshell/provider","XDG_DATA_HOME":"/home/freshell/provider/.local/share","XDG_CONFIG_HOME":"/home/freshell/provider/.config"},"runAsUid":provider_uid,"runAsGid":provider_gid,"cols":80,"rows":24,"projectKey":"test-project","workspacePath":workspace,"cwd":workspace});
        Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "UPDATE incarnations SET terminal_spec=?1 WHERE soul_id=?2",
                params![terminal.to_string(), target.soul_id.as_str()],
            )
            .unwrap();
        targets.push(target);
        stopped_repair_fixture_phase(dir.path(), "target.complete", Some(index));
    }
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    stopped_repair_fixture_phase(dir.path(), "preflight.begin", None);
    let scope = supervisor
        .preflight_lost_souls_from_inventory(
            PreflightLostSoulsRequest {
                source: RepairBatchSourceSelection {
                    source_store_id: format!(
                        "{:x}",
                        Sha256::digest(
                            database
                                .canonicalize()
                                .unwrap()
                                .to_string_lossy()
                                .as_bytes()
                        )
                    ),
                    root_session_ids: names.clone(),
                },
                expected_control_epoch: Some(registry.control_epoch()),
            },
            HostOpenCodeInventory::new(database.clone())
                .with_trusted_mount_for_selected_session(workspace.clone()),
        )
        .await
        .unwrap();
    assert_eq!(scope.targets.len(), 9);
    assert_eq!(scope.roots.len(), 7);
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: scope.source_selection(),
        targets: targets.clone(),
        canonical_owners: (0..2)
            .map(|index| CanonicalOwnerChoice {
                root_session_id: names[index].clone(),
                soul_id: targets[index].soul_id.clone(),
                expected_intent_revision: targets[index].expected_intent_revision,
            })
            .collect(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let operation = RequestId::new();
    registry
        .prepare_stopped_repair_operation(operation.clone(), request.clone(), scope.clone())
        .await
        .unwrap();
    StoppedRepairBaselineFixture {
        dir,
        registry,
        supervisor,
        workspace,
        database,
        source_bytes,
        names,
        targets,
        scope,
        request,
        operation,
        receipts: Vec::new(),
        stores: Vec::new(),
    }
}

async fn import_stopped_repair_baseline(fixture: &mut StoppedRepairBaselineFixture) {
    // Actual export/import/reader receipts exercise baseline persistence here;
    // the authenticated Docker/helper/UI path is the stopped browser runbook.
    let StoppedRepairBaselineFixture {
        dir,
        registry,
        workspace,
        database,
        names,
        targets,
        scope,
        operation,
        receipts,
        stores,
        ..
    } = fixture;
    for index in 0..7 {
        stopped_repair_fixture_phase(dir.path(), "import.begin", Some(index));
        let receipt = import_stopped_fixture_root(
            registry,
            &targets[index],
            database,
            workspace,
            dir.path(),
            &names[index],
            &scope
                .roots
                .iter()
                .find(|root| root.root_session_id == names[index])
                .unwrap()
                .graph_digest,
        )
        .await;
        let store = dir.path().join(format!(
            "provider-{}/.local/share/opencode/opencode.db",
            targets[index].soul_id
        ));
        let conn = Connection::open(&store).unwrap();
        for table in ["session", "message", "part"] {
            assert_eq!(
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, u32>(0))
                    .unwrap(),
                3
            );
        }
        drop(conn);
        stores.push((store.clone(), fs::read(&store).unwrap()));
        let context = registry
            .recovery_context(targets[index].soul_id.clone())
            .await
            .unwrap();
        registry
            .persist_stopped_repair_root_receipt(
                operation.clone(),
                targets[index].clone(),
                context,
                receipt.clone(),
            )
            .await
            .unwrap();
        receipts.push(receipt);
        stopped_repair_fixture_phase(dir.path(), "import.complete", Some(index));
    }
}

async fn pending_stopped_repair_baseline(
    fixture: StoppedRepairBaselineFixture,
) -> StoppedRepairBaselineFixture {
    use freshell_runtime_protocol::{DesiredState, RestoreLostSoulsRequest, SoulRepairStatus};
    let StoppedRepairBaselineFixture {
        dir,
        mut registry,
        mut supervisor,
        workspace,
        database,
        source_bytes,
        names,
        targets,
        scope,
        request,
        operation,
        receipts,
        stores,
    } = fixture;
    let obstruction = dir.path().join("lifecycle.jsonl.1");
    fs::create_dir(&obstruction).unwrap();
    let unrelated = freshell_runtime_protocol::IncidentId::new();
    Connection::open(registry.database_path()).unwrap().execute(
        "INSERT INTO outbox(event_id,event_kind,payload,created_at) VALUES ('startup-unrelated','loss_incident.final',?1,1)",
        [serde_json::json!({"incidentId":unrelated,"cleanupState":"closed","event":"unrelated"}).to_string()],
    ).unwrap();
    let initial_pending = registry
        .finalize_stopped_repair_batch(
            operation.clone(),
            targets.clone(),
            receipts.clone(),
            dir.path().join("incidents"),
            dir.path().join("lifecycle.jsonl"),
        )
        .await;
    drop(supervisor);
    drop(registry);
    registry = Registry::open(dir.path(), None).unwrap();
    supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    // These are the actual calls before main binds the control socket.
    supervisor
        .reconcile_pending_loss_cleanup()
        .await
        .expect("pending withdrawal must leave startup and repair control available");
    assert_eq!(supervisor.reconcile_startup().await.unwrap().scanned, 0);
    let retry_request = RestoreLostSoulsRequest {
        expected_control_epoch: Some(registry.control_epoch()),
        ..request.clone()
    };
    for _ in 0..2 {
        let pending = Box::pin(supervisor.restore_lost_souls_with_inventory(
            operation.clone(),
            retry_request.clone(),
            async { panic!("post-CAS withdrawal must not inspect or reimport source inventory") },
        ))
        .await
        .unwrap();
        assert_eq!(pending.status, SoulRepairStatus::Pending);
        assert_eq!(
            &pending,
            initial_pending
                .as_ref()
                .expect("initial post-CAS obstruction must also return Pending")
        );
        assert_eq!(pending.operation_id, operation);
        assert_eq!(pending.scope_id, scope.scope_id);
        assert_eq!(
            (
                pending.repaired_target_count,
                pending.total_target_count,
                pending.roots.len()
            ),
            (9, 9, 7)
        );
    }
    let initial_pending = initial_pending.unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    let pending: (String, String) = conn.query_row(
        "SELECT o.status,w.status FROM stopped_repair_operations o JOIN stopped_repair_withdrawals w USING(operation_id) WHERE operation_id=?1",
        [operation.as_str()], |row| Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    assert_eq!(pending, ("withdraw_pending".into(), "files_pending".into()));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM recovery_attempts", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        0,
        "pending repair must not launch a recovery attempt"
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM writer_claims", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert!(
        supervisor.export_pending_incidents().await.is_err(),
        "destructive cleanup remains blocked"
    );
    for target in &targets {
        assert_eq!(
            registry
                .recovery_context(target.soul_id.clone())
                .await
                .unwrap()
                .desired_state,
            DesiredState::Stopped
        );
    }
    for (receipt, (store, bytes)) in receipts.iter().zip(&stores) {
        assert_eq!(
            registry
                .recovery_context(receipt.canonical_soul_id.clone())
                .await
                .unwrap()
                .opencode_adoption_baseline,
            Some(receipt.adoption_baseline.clone())
        );
        assert_eq!(fs::read(store).unwrap(), *bytes);
    }
    let unrelated_path = dir
        .path()
        .join("incidents")
        .join(format!("{unrelated}.closed.json"));
    let unrelated_bytes = fs::read(&unrelated_path).unwrap();
    let delivered: Option<i64> = conn
        .query_row(
            "SELECT delivered_at FROM outbox WHERE event_id='startup-unrelated'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(delivered.is_some());
    // A retryable file obstruction cannot conceal invalid request authority,
    // corrupt receipts, stale generations, or a failed registry read.
    let mut invalid_scope = retry_request.clone();
    invalid_scope.scope_id = "invalid-scope".into();
    assert!(Box::pin(supervisor.restore_lost_souls_with_inventory(
        operation.clone(),
        invalid_scope,
        async { panic!("invalid request must fail before source inventory") }
    ))
    .await
    .is_err());
    for (table, column, replacement) in [
        (
            "stopped_repair_withdrawals",
            "generation",
            "stale-generation",
        ),
        (
            "stopped_repair_root_receipts",
            "import_receipt_json",
            "{broken",
        ),
    ] {
        let saved: Vec<(i64, String)> = conn
            .prepare(&format!(
                "SELECT rowid,{column} FROM {table} WHERE operation_id=?1"
            ))
            .unwrap()
            .query_map([operation.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        conn.execute(
            &format!("UPDATE {table} SET {column}=?1 WHERE operation_id=?2"),
            params![replacement, operation.as_str()],
        )
        .unwrap();
        assert!(
            Box::pin(supervisor.restore_lost_souls_with_inventory(
                operation.clone(),
                retry_request.clone(),
                async { panic!("invalid persisted authority must fail before source inventory") }
            ))
            .await
            .is_err(),
            "{column} must remain a strict failure"
        );
        for (rowid, value) in saved {
            conn.execute(
                &format!("UPDATE {table} SET {column}=?1 WHERE rowid=?2"),
                params![value, rowid],
            )
            .unwrap();
        }
    }
    conn.execute(
        "ALTER TABLE stopped_repair_root_receipts RENAME TO unavailable_root_receipts",
        [],
    )
    .unwrap();
    assert!(Box::pin(supervisor.restore_lost_souls_with_inventory(
        operation.clone(),
        retry_request.clone(),
        async { panic!("failed registry read must fail before source inventory") }
    ))
    .await
    .is_err());
    conn.execute(
        "ALTER TABLE unavailable_root_receipts RENAME TO stopped_repair_root_receipts",
        [],
    )
    .unwrap();
    drop(conn);
    let true_context = prepared_context_in_registry(&registry, dir.path()).await;
    let true_loss = registry
        .prepare_loss(decision_for(&registry, &true_context).unwrap())
        .await
        .unwrap();
    let true_incident = true_loss.certificate.incident_id.clone();
    supervisor.reconcile_pending_loss_cleanup().await.unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT cleanup_state FROM loss_incidents WHERE incident_id=?1",
            [true_incident.as_str()],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "cleanup_pending",
        "pending withdrawal must gate actual certified loss cleanup"
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM writer_claims WHERE soul_id=?1",
            [true_context.soul_id.as_str()],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        1,
        "retain the unrelated certified writer until cleanup is allowed"
    );
    let true_certificate: String = conn
        .query_row(
            "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
            [true_incident.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    drop(conn);
    fs::remove_dir(&obstruction).unwrap();
    let first = Box::pin(supervisor.restore_lost_souls_with_inventory(
        operation.clone(),
        retry_request.clone(),
        async { panic!("finishing withdrawal must not reimport source inventory") },
    ))
    .await
    .unwrap();
    assert_eq!(first.status, SoulRepairStatus::Complete);
    assert_eq!(first.roots, initial_pending.roots);
    let again = Box::pin(supervisor.restore_lost_souls_with_inventory(
        operation.clone(),
        retry_request,
        async { panic!("completed retry must not inspect source inventory") },
    ))
    .await
    .unwrap();
    assert_eq!(first, again);
    supervisor.reconcile_pending_loss_cleanup().await.unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT cleanup_state FROM loss_incidents WHERE incident_id=?1",
            [true_incident.as_str()],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "closed"
    );
    assert_eq!(
        conn.query_row(
            "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
            [true_incident.as_str()],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        true_certificate
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM writer_claims", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    drop(conn);
    let first = registry
        .finalize_stopped_repair_batch(
            operation.clone(),
            targets.clone(),
            receipts.clone(),
            dir.path().join("incidents"),
            dir.path().join("lifecycle.jsonl"),
        )
        .await
        .unwrap();
    let again = registry
        .finalize_stopped_repair_batch(
            operation.clone(),
            targets.clone(),
            receipts.clone(),
            dir.path().join("incidents"),
            dir.path().join("lifecycle.jsonl"),
        )
        .await
        .unwrap();
    assert_eq!(first, again);
    assert_eq!(fs::read(unrelated_path).unwrap(), unrelated_bytes);
    let conn = Connection::open(registry.database_path()).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT status FROM stopped_repair_operations WHERE operation_id=?1",
            [operation.as_str()],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "complete"
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM stopped_repair_withdrawals WHERE operation_id=?1",
            [operation.as_str()],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    StoppedRepairBaselineFixture {
        dir,
        registry,
        supervisor,
        workspace,
        database,
        source_bytes,
        names,
        targets,
        scope,
        request,
        operation,
        receipts,
        stores,
    }
}

async fn finalize_stopped_repair_baseline(fixture: &StoppedRepairBaselineFixture) {
    use freshell_runtime_protocol::{DesiredState, RecoveryState};
    let StoppedRepairBaselineFixture {
        registry,
        dir,
        operation,
        targets,
        receipts,
        ..
    } = fixture;
    let result = registry
        .finalize_stopped_repair_batch(
            operation.clone(),
            targets.clone(),
            receipts.clone(),
            dir.path().join("incidents"),
            dir.path().join("lifecycle.jsonl"),
        )
        .await
        .unwrap();
    assert_eq!((result.repaired_target_count, result.roots.len()), (9, 7));
    let soul = targets[0].soul_id.clone();
    let baseline = receipts[0].adoption_baseline.clone();
    let repaired = registry.recovery_context(soul.clone()).await.unwrap();
    assert_eq!(repaired.desired_state, DesiredState::Stopped);
    assert_eq!(repaired.recovery_state, RecoveryState::DataRepairComplete);
    assert_eq!(repaired.opencode_adoption_baseline, Some(baseline.clone()));
}

async fn retry_stopped_repair_baseline(fixture: &StoppedRepairBaselineFixture) {
    use freshell_runtime_protocol::{
        RecoverRequest, RecoveryOutcome, RecoveryState, RecoveryTrigger,
    };
    let StoppedRepairBaselineFixture {
        registry,
        supervisor,
        targets,
        receipts,
        names,
        dir,
        ..
    } = fixture;
    let soul = targets[0].soul_id.clone();
    let baseline = receipts[0].adoption_baseline.clone();
    for ordinal in 0..2 {
        stopped_repair_fixture_phase(dir.path(), "retry.begin", Some(ordinal));
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let outcome = supervisor
            .recover(RecoverRequest {
                soul_id: soul.clone(),
                trigger: RecoveryTrigger::ManualRetry,
                expected_intent_revision: Some(context.intent_revision),
                expected_control_epoch: Some(registry.control_epoch()),
            })
            .await
            .unwrap();
        stopped_repair_fixture_phase(dir.path(), "retry.settled", Some(ordinal));
        assert_eq!(outcome.outcome, RecoveryOutcome::Blocked);
        let blocked = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(blocked.recovery_state, RecoveryState::Blocked);
        assert!(
            blocked.opencode_adoption_baseline.as_ref() == Some(&baseline),
            "saved import baseline must survive a blocked Resume and explicit Retry"
        );
        assert_eq!(blocked.provider_store_id, receipts[0].destination_store_id);
        assert_eq!(
            blocked.native_session_id.as_deref(),
            Some(names[0].as_str())
        );
        let candidate = crate::resume_catalog::exact_resume_candidate(&blocked, None)
            .unwrap()
            .unwrap();
        assert_eq!(candidate.opencode_adoption_baseline, Some(baseline.clone()));
        assert_eq!(
            candidate.environment["OPENCODE_DB"],
            "/home/freshell/provider/.local/share/opencode/opencode.db"
        );
    }
}

async fn reopen_stopped_repair_baseline(
    fixture: StoppedRepairBaselineFixture,
    cancelled: Option<RecoveryContext>,
) {
    use freshell_runtime_protocol::{DesiredState, RecoveryState};
    let StoppedRepairBaselineFixture {
        dir,
        registry,
        supervisor,
        database,
        source_bytes,
        targets,
        receipts,
        stores,
        ..
    } = fixture;
    let soul = targets[0].soul_id.clone();
    let baseline = receipts[0].adoption_baseline.clone();
    drop(supervisor);
    drop(registry);
    let reopened = Registry::open(dir.path(), None).unwrap();
    let reopened_context = reopened.recovery_context(soul).await.unwrap();
    assert_eq!(reopened_context.opencode_adoption_baseline, Some(baseline));
    if let Some(cancelled) = cancelled {
        let reopened_supervisor =
            crate::recovery::tests::missing_supervisor(&dir, reopened.clone());
        assert_eq!(
            reopened_supervisor
                .reconcile_startup()
                .await
                .unwrap()
                .scanned,
            0,
            "reopen cannot resume a cancelled repaired soul"
        );
        assert_eq!(reopened_context.desired_state, DesiredState::Stopped);
        assert_eq!(reopened_context.recovery_state, RecoveryState::Stopped);
        assert_eq!(reopened_context.intent_revision, cancelled.intent_revision);
        assert_eq!(
            reopened_context.native_session_id,
            cancelled.native_session_id
        );
        assert_eq!(
            reopened_context.provider_store_id,
            cancelled.provider_store_id
        );
        assert_eq!(
            reopened_context.native_import_revision,
            cancelled.native_import_revision
        );
        assert_eq!(
            reopened_context.native_import_source_generation,
            cancelled.native_import_source_generation
        );
        assert_eq!(
            reopened_context.prior_handle.incarnation_id(),
            cancelled.prior_handle.incarnation_id()
        );
        assert!(reopened.pending_stop_handles().await.unwrap().is_empty());
    }
    assert_eq!(fs::read(&database).unwrap(), source_bytes);
    for (store, bytes) in stores {
        assert_eq!(fs::read(store).unwrap(), bytes);
    }
}

#[tokio::test]
async fn durable_souls_server_resolved_scope_rejects_tenth_drift_before_writes() {
    use freshell_runtime_protocol::{
        CanonicalOwnerChoice, PreflightLostSoulsRequest, RepairBatchSourceSelection, RequestId,
        RestoreLostSoulsRequest,
    };
    use freshell_sessions::opencode_transfer::{
        pinned_destination_migration_ids, pinned_destination_schema_sql, HostOpenCodeInventory,
    };
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let names = [
        "ses_fixture_root_alpha",
        "ses_fixture_root_beta",
        "ses_fixture_root_gamma",
        "ses_fixture_root_delta",
        "ses_fixture_root_epsilon",
        "ses_fixture_root_zeta",
        "ses_fixture_root_eta",
    ];
    let database = dir.path().join("source.sqlite");
    let native = Connection::open(&database).unwrap();
    native
        .execute_batch(pinned_destination_schema_sql())
        .unwrap();
    for migration in pinned_destination_migration_ids() {
        native
            .execute(
                "INSERT INTO migration(id,time_completed) VALUES (?1,1)",
                [migration],
            )
            .unwrap();
    }
    native.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('fixture-project',?1,1,1,'[]')",[workspace.to_string_lossy().as_ref()]).unwrap();
    native.execute("INSERT INTO project_directory(project_id,directory,time_created) VALUES ('fixture-project',?1,1)",[workspace.to_string_lossy().as_ref()]).unwrap();
    for root in names {
        native.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,'fixture-project','fixture',?2,'synthetic scope','1.18.21',1,1)",params![root,workspace.to_string_lossy().as_ref()]).unwrap();
    }
    drop(native);
    let mut targets = Vec::new();
    for index in 0..9 {
        let root = if index == 7 {
            names[0]
        } else if index == 8 {
            names[1]
        } else {
            names[index]
        };
        targets.push(stopped_legacy_fixture_target(&registry, dir.path(), root).await);
    }
    let install_workspace = |target: &freshell_runtime_protocol::LostSoulRepairTarget| {
        let conn = Connection::open(registry.database_path()).unwrap();
        let raw: Option<String> = conn
            .query_row(
                "SELECT terminal_spec FROM incarnations WHERE soul_id=?1",
                [target.soul_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        let mut terminal=raw.map(|raw|serde_json::from_str::<serde_json::Value>(&raw).unwrap()).unwrap_or_else(||serde_json::json!({"terminalId":format!("terminal-{}",target.soul_id),"streamId":format!("stream-{}",target.soul_id),"mode":"opencode","program":"opencode","env":{},"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"test-project"}));
        terminal["workspacePath"] = serde_json::json!(workspace);
        terminal["cwd"] = serde_json::json!(workspace);
        #[cfg(unix)]
        {
            terminal["runAsUid"] = serde_json::json!(unsafe { libc::geteuid() });
            terminal["runAsGid"] = serde_json::json!(unsafe { libc::getegid() });
        }
        #[cfg(not(unix))]
        {
            terminal["runAsUid"] = serde_json::json!(0);
            terminal["runAsGid"] = serde_json::json!(0);
        }
        conn.execute(
            "UPDATE incarnations SET terminal_spec=?1 WHERE soul_id=?2",
            params![terminal.to_string(), target.soul_id.as_str()],
        )
        .unwrap();
    };
    for target in &targets {
        install_workspace(target);
    }
    let source = RepairBatchSourceSelection {
        source_store_id: format!(
            "{:x}",
            Sha256::digest(
                database
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
            )
        ),
        root_session_ids: names.iter().map(|root| root.to_string()).collect(),
    };
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    let inventory = HostOpenCodeInventory::new(database.clone())
        .with_trusted_mount_for_selected_session(workspace.clone());
    let source_before = std::fs::read(&database).unwrap();
    let unrelated =
        stopped_legacy_fixture_target(&registry, dir.path(), "ses_fixture_unrelated_root").await;
    let scope = supervisor
        .preflight_lost_souls_from_inventory(
            PreflightLostSoulsRequest {
                source: source.clone(),
                expected_control_epoch: Some(registry.control_epoch()),
            },
            inventory.clone(),
        )
        .await
        .expect("independently resolved nine-target preview from one consistent source capture");
    let source_events = std::fs::read_to_string(dir.path().join("lifecycle.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|event| event["event"] == "supervisor.stopped_repair.source_phase")
        .map(|event| event["data"].clone())
        .collect::<Vec<_>>();
    for phase in ["capture", "backup", "hash"] {
        assert_eq!(
            source_events
                .iter()
                .filter(|event| event["phase"] == phase && event["state"] == "completed")
                .count(),
            1,
            "one complete source capture must report {phase}"
        );
    }
    let exports = source_events
        .iter()
        .filter(|event| event["phase"] == "root_export" && event["state"] == "completed")
        .collect::<Vec<_>>();
    assert_eq!(
        exports.len(),
        14,
        "qualification and later per-root exports retain separate validation"
    );
    for root in names {
        for operation in ["capture", "export"] {
            assert_eq!(
                exports
                    .iter()
                    .filter(|event| event["rootSessionId"] == root
                        && event["sourceOperation"] == operation)
                    .count(),
                1
            );
        }
    }
    assert_eq!(scope.targets.len(), 9);
    assert_eq!(scope.roots.len(), 7);
    let old_request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: source.clone(),
        targets: targets.clone(),
        canonical_owners: [0usize, 1]
            .into_iter()
            .map(|index| CanonicalOwnerChoice {
                root_session_id: names[index].into(),
                soul_id: targets[index].soul_id.clone(),
                expected_intent_revision: 2,
            })
            .collect(),
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let conn = Connection::open(registry.database_path()).unwrap();
    let original_store: String = conn
        .query_row(
            "SELECT provider_store_id FROM souls WHERE soul_id=?1",
            [targets[2].soul_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute(
        "UPDATE souls SET provider_store_id='substituted-destination-store' WHERE soul_id=?1",
        [targets[2].soul_id.as_str()],
    )
    .unwrap();
    assert!(
        registry
            .prepare_stopped_repair_operation(RequestId::new(), old_request.clone(), scope.clone())
            .await
            .is_err(),
        "a changed destination store invalidates the inspected exact member before import writes"
    );
    conn.execute(
        "UPDATE souls SET provider_store_id=?1 WHERE soul_id=?2",
        params![original_store, targets[2].soul_id.as_str()],
    )
    .unwrap();
    drop(conn);
    let tenth = stopped_legacy_fixture_target(&registry, dir.path(), names[0]).await;
    install_workspace(&tenth);
    assert!(
        registry
            .prepare_stopped_repair_operation(RequestId::new(), old_request.clone(), scope.clone())
            .await
            .is_err(),
        "fresh eligible tenth target invalidates the old scope before operation or import writes"
    );
    let conn = Connection::open(registry.database_path()).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM stopped_repair_operations",
            [],
            |row| row.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    drop(conn);
    let fresh = supervisor
        .preflight_lost_souls_from_inventory(
            PreflightLostSoulsRequest {
                source,
                expected_control_epoch: Some(registry.control_epoch()),
            },
            inventory,
        )
        .await
        .unwrap();
    assert_eq!(fresh.targets.len(), 10);
    assert_eq!(fresh.roots.len(), 7);
    assert_ne!(fresh.scope_id, scope.scope_id);
    assert_eq!(fresh.source_fingerprint, scope.source_fingerprint);
    let mut current = old_request;
    current.scope_id = fresh.scope_id.clone();
    current.targets.push(tenth);
    let operation = RequestId::new();
    registry
        .prepare_stopped_repair_operation(operation.clone(), current.clone(), fresh.clone())
        .await
        .unwrap();
    let mut receipts = Vec::new();
    for (index, root) in names.iter().enumerate() {
        let receipt = import_stopped_fixture_root(
            &registry,
            &targets[index],
            &database,
            &workspace,
            dir.path(),
            root,
            &fresh
                .roots
                .iter()
                .find(|selected| selected.root_session_id == *root)
                .unwrap()
                .graph_digest,
        )
        .await;
        let context = registry
            .recovery_context(targets[index].soul_id.clone())
            .await
            .unwrap();
        registry
            .persist_stopped_repair_root_receipt(
                operation.clone(),
                targets[index].clone(),
                context,
                receipt.clone(),
            )
            .await
            .unwrap();
        receipts.push(receipt);
    }
    assert_eq!(
        receipts.len(),
        7,
        "each independently resolved root is imported and read exactly once"
    );
    // A concurrent preflight can retain its production observer while this
    // operation completes the exact receipt-fenced incident withdrawal.
    let lifecycle = dir.path().join("lifecycle.jsonl");
    let mut diagnostic_targets = Vec::new();
    for target in current.targets.iter().chain(std::iter::once(&unrelated)) {
        let context = registry
            .recovery_context(target.soul_id.clone())
            .await
            .unwrap();
        diagnostic_targets.push((
            context.native_session_id.clone().unwrap(),
            target.clone(),
            context,
        ));
    }
    let late_options = crate::recovery::tests::stopped_source_options_for_targets(
        dir.path().join("late-source-extractions"),
        lifecycle.clone(),
        &diagnostic_targets,
    );
    let unrelated_event =
        serde_json::json!({"incidentId": unrelated.incident_id, "sentinel": "retained"});
    crate::service::append_event(
        &lifecycle,
        "unrelated.source-observer",
        unrelated_event.clone(),
    );
    let result = registry
        .finalize_stopped_repair_batch(
            operation.clone(),
            current.targets.clone(),
            receipts.clone(),
            dir.path().join("incidents"),
            dir.path().join("lifecycle.jsonl"),
        )
        .await
        .unwrap();
    assert_eq!(result.total_target_count, 10);
    assert_eq!(result.repaired_target_count, 10);
    assert_eq!(result.roots.len(), 7);
    let before_late_progress = std::fs::read_to_string(&lifecycle).unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    for target in &current.targets {
        assert!(!before_late_progress.contains(target.incident_id.as_str()));
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM loss_incidents WHERE incident_id=?1",
                [target.incident_id.as_str()],
                |row| row.get::<_, u64>(0),
            )
            .unwrap(),
            0,
        );
    }
    drop(conn);
    let late_capture = freshell_sessions::opencode_transfer::capture_qualified_batch(
        &HostOpenCodeInventory::new(database.clone())
            .with_trusted_mount_for_selected_session(workspace.clone()),
        &[names[0].to_string()],
        late_options,
    )
    .unwrap();
    drop(late_capture);
    let after_late_progress = std::fs::read_to_string(&lifecycle).unwrap();
    for target in &current.targets {
        assert!(
            !after_late_progress.contains(target.incident_id.as_str()),
            "late source progress must not recreate withdrawn incident {}",
            target.incident_id,
        );
    }
    let late_events = after_late_progress[before_late_progress.len()..]
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(late_events
        .iter()
        .all(|event| event["event"] == "supervisor.stopped_repair.source_phase"));
    for phase in ["backup", "hash", "root_export"] {
        for state in ["progress", "completed"] {
            assert!(
                late_events.iter().any(|event| {
                    event["data"]["phase"] == phase
                        && event["data"]["state"] == state
                        && event["data"]["completedCount"].as_u64().unwrap() > 0
                        && event["data"]["elapsedMs"].is_u64()
                }),
                "late real {phase} {state} diagnostics remain useful"
            );
        }
    }
    let saved_object_event = &late_events
        .iter()
        .find(|event| {
            event["data"]["phase"] == "saved_objects" && event["data"]["state"] == "completed"
        })
        .unwrap()["data"];
    let reader_costs = saved_object_event["readerCosts"].as_object().unwrap();
    assert!(
        reader_costs.values().all(serde_json::Value::is_u64),
        "actual late reader diagnostics stay numeric and body-free after withdrawal"
    );
    assert_eq!(
        reader_costs["nativeQueries"], 0,
        "this actual root has no saved native objects"
    );
    assert_eq!(reader_costs["freshInspections"], 0);
    let capture_event = &late_events
        .iter()
        .find(|event| event["data"]["phase"] == "capture")
        .unwrap()["data"];
    assert_eq!(capture_event["sourceOperation"], "capture");
    let contexts = capture_event["targetContext"].as_array().unwrap();
    assert_eq!(contexts.len(), diagnostic_targets.len());
    for (root, target, context) in &diagnostic_targets {
        let retained = contexts
            .iter()
            .find(|value| value["soulId"] == target.soul_id.as_str())
            .unwrap();
        assert_eq!(retained["rootSessionId"], *root);
        assert_eq!(
            retained["incarnationId"],
            context.prior_handle.incarnation_id().as_str()
        );
        assert_eq!(retained["intentRevision"], target.expected_intent_revision);
        assert_eq!(retained["identityRevision"], context.identity_revision);
        assert_eq!(
            retained["nativeImportRevision"],
            context.native_import_revision
        );
        assert_eq!(retained["evidenceRevision"], context.evidence_revision);
    }
    let root_event = &late_events
        .iter()
        .find(|event| {
            event["data"]["phase"] == "root_export" && event["data"]["state"] == "completed"
        })
        .unwrap()["data"];
    assert_eq!(root_event["rootSessionId"], names[0]);
    assert_eq!(root_event["countUnit"], "roots");
    assert_eq!(root_event["completedCount"], 1);
    assert_eq!(root_event["totalCount"], 1);
    assert_eq!(root_event["targetContext"].as_array().unwrap().len(), 3);
    assert!(root_event["targetContext"]
        .as_array()
        .unwrap()
        .iter()
        .all(|context| context["rootSessionId"] == names[0]));
    assert!(after_late_progress.lines().any(|line| {
        let event: serde_json::Value = serde_json::from_str(line).unwrap();
        event["event"] == "unrelated.source-observer" && event["data"] == unrelated_event
    }));
    assert_eq!(
        registry
            .finalize_stopped_repair_batch(
                operation,
                current.targets,
                receipts,
                dir.path().join("incidents"),
                dir.path().join("lifecycle.jsonl")
            )
            .await
            .unwrap(),
        result
    );
    assert_eq!(std::fs::read(database).unwrap(), source_before);
    let retained = registry
        .recovery_context(unrelated.soul_id.clone())
        .await
        .unwrap();
    assert_eq!(
        retained.recovery_state,
        freshell_runtime_protocol::RecoveryState::Lost
    );
    assert_eq!(retained.intent_revision, unrelated.expected_intent_revision);
    assert_eq!(
        Connection::open(registry.database_path())
            .unwrap()
            .query_row(
                "SELECT loss_incident_id FROM souls WHERE soul_id=?1",
                [unrelated.soul_id.as_str()],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        unrelated.incident_id.as_str()
    );
}

async fn check_persisted_repair_source_failure(failure: &str) {
    use freshell_runtime_protocol::{
        PreflightLostSoulsRequest, RepairBatchSourceSelection, RequestId, RestoreLostSoulsRequest,
        RuntimeError, RuntimeErrorCode, SoulRepairStatus,
    };
    use freshell_sessions::opencode_transfer::{
        pinned_destination_migration_ids, pinned_destination_schema_sql, HostOpenCodeInventory,
    };
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let database = dir.path().join("source.sqlite");
    let source = Connection::open(&database).unwrap();
    source
        .execute_batch(pinned_destination_schema_sql())
        .unwrap();
    for migration in pinned_destination_migration_ids() {
        source
            .execute(
                "INSERT INTO migration(id,time_completed) VALUES (?1,1)",
                [migration],
            )
            .unwrap();
    }
    source.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('fixture-project',?1,1,1,'[]')", [workspace.to_string_lossy().as_ref()]).unwrap();
    source.execute("INSERT INTO project_directory(project_id,directory,time_created) VALUES ('fixture-project',?1,1)", [workspace.to_string_lossy().as_ref()]).unwrap();
    let root = "ses_fixture_source_failure";
    source.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,'fixture-project','fixture',?2,'synthetic source','1.18.21',1,1)", params![root,workspace.to_string_lossy().as_ref()]).unwrap();
    drop(source);
    let target = stopped_legacy_fixture_target(&registry, dir.path(), root).await;
    let conn = Connection::open(registry.database_path()).unwrap();
    let mut terminal = serde_json::json!({"terminalId":"terminal-source-failure","streamId":"stream-source-failure","mode":"opencode","program":"opencode","env":{},"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"test-project","workspacePath":workspace,"cwd":workspace});
    if failure == "import" {
        terminal["env"]["FRESHELL_TEST_STOPPED_DIAGNOSTIC"] = "1".into();
    }
    conn.execute(
        "UPDATE incarnations SET terminal_spec=?1 WHERE soul_id=?2",
        params![terminal.to_string(), target.soul_id.as_str()],
    )
    .unwrap();
    drop(conn);
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    let inventory = HostOpenCodeInventory::new(database.clone())
        .with_trusted_mount_for_selected_session(workspace.clone());
    let selection = RepairBatchSourceSelection {
        source_store_id: format!(
            "{:x}",
            Sha256::digest(
                database
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
            )
        ),
        root_session_ids: vec![root.into()],
    };
    let scope = supervisor
        .preflight_lost_souls_from_inventory(
            PreflightLostSoulsRequest {
                source: selection.clone(),
                expected_control_epoch: Some(registry.control_epoch()),
            },
            inventory.clone(),
        )
        .await
        .unwrap();
    let request = RestoreLostSoulsRequest {
        scope_id: scope.scope_id.clone(),
        source: selection,
        targets: vec![target.clone()],
        canonical_owners: vec![],
        expected_control_epoch: Some(registry.control_epoch()),
    };
    let operation = RequestId::new();
    registry
        .prepare_stopped_repair_operation(operation.clone(), request.clone(), scope.clone())
        .await
        .unwrap();
    let before = registry
        .recovery_context(target.soul_id.clone())
        .await
        .unwrap();
    let reason = match failure {
        "inventory" => "source_inventory_unreadable",
        "worker" => "source_inventory_worker_failed",
        "capture" => "source_not_exactly_resolvable",
        "import" => "provider_reader_or_import_failed",
        _ => "source_scope_changed_before_import",
    };
    let injected = match failure {
        "inventory" => {
            let not_directory = dir.path().join("unreadable-datahome");
            std::fs::write(&not_directory, b"private diagnostic fixture").unwrap();
            HostOpenCodeInventory::discover_in_data_home(&not_directory).map_err(|error| {
                RuntimeError::new(
                    RuntimeErrorCode::RecoveryBlocked,
                    format!("private diagnostic fixture: {error}"),
                )
            })
        }
        "worker" => Err(RuntimeError::new(
            RuntimeErrorCode::RecoveryBlocked,
            format!("stopped OpenCode repair is pending ({reason})"),
        )),
        "import" => Ok(inventory.clone()),
        "capture" => Ok(HostOpenCodeInventory::new(
            dir.path().join("missing.sqlite"),
        )),
        _ => {
            let source = Connection::open(&database).unwrap();
            source
                .execute(
                    "UPDATE session SET title='private changed transcript marker'",
                    [],
                )
                .unwrap();
            Ok(inventory)
        }
    };
    let source_before = std::fs::read(&database).unwrap();
    let incident_before: String = Connection::open(registry.database_path())
        .unwrap()
        .query_row(
            "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
            [target.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let result = supervisor
        .restore_lost_souls_with_inventory(operation.clone(), request, async { injected })
        .await
        .unwrap();
    assert_eq!(result.status, SoulRepairStatus::Pending, "{failure}");
    assert_eq!(result.roots.len(), 1);
    assert_eq!(
        result.roots[0].reason_code.as_deref(),
        Some(reason),
        "{failure}"
    );
    assert_eq!(result.repaired_target_count, 0);
    let after = registry
        .recovery_context(target.soul_id.clone())
        .await
        .unwrap();
    assert_eq!(after.desired_state, before.desired_state);
    assert_eq!(after.intent_revision, before.intent_revision);
    assert_eq!(after.identity_revision, before.identity_revision);
    assert_eq!(after.native_import_revision, before.native_import_revision);
    assert_eq!(
        after.native_import_authority,
        before.native_import_authority
    );
    assert!(registry
        .stopped_repair_root_receipts(operation.clone())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(std::fs::read(&database).unwrap(), source_before);
    let incident_after: String = Connection::open(registry.database_path())
        .unwrap()
        .query_row(
            "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
            [target.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(incident_after, incident_before);
    let log = std::fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap();
    if failure == "capture" {
        let diagnostic: Vec<serde_json::Value> = log
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|event: &serde_json::Value| {
                event["event"] == "supervisor.stopped_repair.source_transfer_failed"
            })
            .collect();
        assert_eq!(diagnostic.len(), 1);
        assert_eq!(diagnostic[0]["data"]["phase"], "capture");
        assert_eq!(diagnostic[0]["data"]["errorClass"], "blocked");
        assert_eq!(
            diagnostic[0]["data"]["producerReason"],
            "source database is unavailable"
        );
    }
    let events = log
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|event| {
            event["event"]
                == if failure == "import" {
                    "supervisor.stopped_repair.import_failed"
                } else {
                    "supervisor.stopped_repair.source_failed"
                }
        })
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 1, "{failure}");
    let event = &events[0]["data"];
    assert_eq!(event["severity"], "error");
    assert_eq!(event["reasonCode"], reason);
    assert_eq!(event["operationId"], operation.as_str());
    if failure != "import" {
        assert_eq!(event["scopeId"], scope.scope_id);
        assert_eq!(event["sourceStoreId"], scope.source_store_id);
        assert_eq!(event["sourceFingerprint"], scope.source_fingerprint);
        assert_eq!(event["soulId"], target.soul_id.as_str());
        assert_eq!(
            event["incarnationId"],
            before.prior_handle.incarnation_id().as_str()
        );
        assert_eq!(event["intentRevision"], target.expected_intent_revision);
        assert_eq!(event["incidentId"], target.incident_id.as_str());
        assert_eq!(
            event["incidentRevision"],
            scope.targets[0].incident_revision
        );
        assert_eq!(
            event["identityRevision"],
            scope.targets[0].identity_revision
        );
        assert_eq!(
            event["nativeImportRevision"],
            scope.targets[0].native_import_revision
        );
        assert_eq!(
            event["evidenceRevision"],
            scope.targets[0].evidence_revision
        );
        assert_eq!(event["rootSessionId"], root);
        assert_eq!(event["sourceGeneration"], scope.roots[0].graph_digest);
    } else {
        assert_eq!(event["rootSessionId"], root);
        assert_eq!(event["soulId"], target.soul_id.as_str());
        assert_eq!(event["intentRevision"], target.expected_intent_revision);
        assert_eq!(
            event["incarnationId"],
            before.prior_handle.incarnation_id().as_str()
        );
        assert!(event["executionGeneration"].as_u64().is_some());
        assert!(event["transferId"].as_str().is_some());
        assert_eq!(event["backendCategory"], "helper_nonzero_exit");
        assert_eq!(event["backendDiagnostic"]["helperExit"], 23);
        assert_eq!(event["backendDiagnostic"]["stage"], "reader");
        assert_eq!(event["backendDiagnostic"]["errno"], 13);
        assert_eq!(event["identityRevision"], before.identity_revision);
        assert_eq!(event["nativeImportRevision"], before.native_import_revision);
    }
    assert!(!log.contains("private changed transcript marker"));
    assert!(!log.contains("private diagnostic fixture"));
    assert!(!log.contains("synthetic-secret"));
}

#[tokio::test]
async fn durable_souls_persisted_repair_import_failure() {
    check_persisted_repair_source_failure("import").await;
}

#[tokio::test]
async fn durable_souls_persisted_repair_inventory_failure() {
    check_persisted_repair_source_failure("inventory").await;
}
#[tokio::test]
async fn durable_souls_persisted_repair_worker_failure() {
    check_persisted_repair_source_failure("worker").await;
}
#[tokio::test]
async fn durable_souls_persisted_repair_capture_failure() {
    check_persisted_repair_source_failure("capture").await;
}
#[tokio::test]
async fn durable_souls_persisted_repair_source_mismatch() {
    check_persisted_repair_source_failure("mismatch").await;
}

async fn check_preflight_source_failure_diagnostic(failure: &str, expected_reason: &str) {
    use freshell_runtime_protocol::{
        PreflightLostSoulsRequest, RepairBatchSourceSelection, RuntimeErrorCode,
    };
    use freshell_sessions::opencode_transfer::{
        pinned_destination_migration_ids, pinned_destination_schema_sql, HostOpenCodeInventory,
    };
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let database = dir.path().join("source.sqlite");
    let source = Connection::open(&database).unwrap();
    source
        .execute_batch(pinned_destination_schema_sql())
        .unwrap();
    for migration in pinned_destination_migration_ids() {
        source
            .execute(
                "INSERT INTO migration(id,time_completed) VALUES (?1,1)",
                [migration],
            )
            .unwrap();
    }
    let root = "ses_fixture_preflight_failure";
    source.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('fixture-project',?1,1,1,'[]')", [workspace.to_string_lossy().as_ref()]).unwrap();
    source.execute("INSERT INTO project_directory(project_id,directory,time_created) VALUES ('fixture-project',?1,1)", [workspace.to_string_lossy().as_ref()]).unwrap();
    source.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,'fixture-project','fixture',?2,'synthetic-secret','1.18.21',1,1)", params![root,workspace.to_string_lossy().as_ref()]).unwrap();
    match failure {
        "schema" => {
            source
                .execute_batch("CREATE TABLE \"synthetic-secret\" (id TEXT)")
                .unwrap();
        }
        "payload" => {
            source.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg-fixture',?1,1,1,?2)", params![root,"synthetic-secret malformed native body"]).unwrap();
        }
        _ => {}
    }
    drop(source);
    let target = stopped_legacy_fixture_target(&registry, dir.path(), root).await;
    let terminal = serde_json::json!({"terminalId":"terminal-preflight-failure","streamId":"stream-preflight-failure","mode":"opencode","program":"opencode","env":{"PRIVATE_CONFIG":"synthetic-secret"},"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"test-project","workspacePath":workspace,"cwd":workspace});
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE incarnations SET terminal_spec=?1 WHERE soul_id=?2",
        params![terminal.to_string(), target.soul_id.as_str()],
    )
    .unwrap();
    let before = registry
        .recovery_context(target.soul_id.clone())
        .await
        .unwrap();
    let incident_before: String = conn
        .query_row(
            "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
            [target.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let source_before = std::fs::read(&database).unwrap();
    let source_store_id = format!(
        "{:x}",
        Sha256::digest(
            database
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_bytes()
        )
    );
    let inventory = HostOpenCodeInventory::new(if failure == "missing" {
        dir.path().join("missing.sqlite")
    } else {
        database.clone()
    });
    let supervisor = crate::recovery::tests::missing_supervisor(&dir, registry.clone());
    let error = supervisor
        .preflight_lost_souls_from_inventory(
            PreflightLostSoulsRequest {
                source: RepairBatchSourceSelection {
                    source_store_id,
                    root_session_ids: vec![root.into()],
                },
                expected_control_epoch: Some(registry.control_epoch()),
            },
            inventory,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RecoveryBlocked);
    assert_eq!(
        error.message,
        "stopped OpenCode repair is pending (source_not_exactly_resolvable)"
    );
    let after = registry
        .recovery_context(target.soul_id.clone())
        .await
        .unwrap();
    assert_eq!(after.desired_state, before.desired_state);
    assert_eq!(after.recovery_state, before.recovery_state);
    assert_eq!(after.intent_revision, before.intent_revision);
    assert_eq!(after.identity_revision, before.identity_revision);
    assert_eq!(after.native_import_revision, before.native_import_revision);
    assert_eq!(
        after.native_import_authority,
        before.native_import_authority
    );
    let incident_after: String = conn
        .query_row(
            "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
            [target.incident_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(incident_after, incident_before);
    for table in ["stopped_repair_operations", "stopped_repair_root_receipts"] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
    assert_eq!(std::fs::read(&database).unwrap(), source_before);
    let log = std::fs::read_to_string(dir.path().join("lifecycle.jsonl")).unwrap_or_default();
    let phases = log
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|event| event["event"] == "supervisor.stopped_repair.source_phase")
        .map(|event| event["data"].clone())
        .collect::<Vec<_>>();
    assert!(phases
        .iter()
        .any(|event| event["phase"] == "capture" && event["state"] == "started"));
    let inner_phase = match failure {
        "missing" => "source_resolution",
        "schema" => "schema",
        _ => "saved_objects",
    };
    assert!(phases.iter().any(|event| event["phase"] == inner_phase
        && event["state"] == "failed"
        && event["severity"] == "error"
        && event["errorClass"] == "blocked"));
    assert!(phases
        .iter()
        .any(|event| event["phase"] == "capture" && event["state"] == "failed"));
    let events: Vec<serde_json::Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|event: &serde_json::Value| {
            event["event"] == "supervisor.stopped_repair.source_transfer_failed"
        })
        .collect();
    assert_eq!(
        events.len(),
        1,
        "actual {failure} refusal must diagnose its producer once"
    );
    let data = &events[0]["data"];
    assert_eq!(data["severity"], "error");
    assert_eq!(data["phase"], "capture");
    assert_eq!(data["errorClass"], "blocked");
    assert_eq!(data["producerReason"], expected_reason);
    if failure == "missing" {
        assert_eq!(
            data["errno"], 2,
            "retain the actual missing-source cause without printing arbitrary error details"
        );
    }
    assert_eq!(data["rootSessionIds"], serde_json::json!([root]));
    assert_eq!(
        data["declaredSourceDatabase"],
        if failure == "missing" {
            dir.path().join("missing.sqlite")
        } else {
            database
        }
        .to_string_lossy()
        .as_ref()
    );
    assert!(
        !log.contains("synthetic-secret"),
        "diagnostic must exclude native bodies, titles, config and unrecognized schema names"
    );
}

#[tokio::test]
async fn durable_souls_preflight_source_diagnostic_missing() {
    check_preflight_source_failure_diagnostic("missing", "source database is unavailable").await;
}

#[tokio::test]
async fn durable_souls_preflight_source_diagnostic_schema() {
    check_preflight_source_failure_diagnostic(
        "schema",
        "source schema contains an unrecognized table",
    )
    .await;
}

#[tokio::test]
async fn durable_souls_preflight_source_diagnostic_payload() {
    check_preflight_source_failure_diagnostic(
        "payload",
        "native message.data data is not valid JSON",
    )
    .await;
}

use super::*;
use std::time::Duration;

// Keep the helper output bounded below the history-specific control reply budget.
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPAIR_RECEIPT_BYTES: usize = 64 * 1024;
const OPENCODE_PROVIDER_HOME: &str = "/home/freshell/provider";

/// Body-free diagnostics for this helper only. Strings are selected from fixed
/// categories, never copied from Docker bodies, stderr, or error Display text.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRepairFailure {
    pub category: &'static str,
    pub wait_http_status: Option<u16>,
    pub helper_exit: Option<i64>,
    pub diagnostic_status: &'static str,
    pub log_bytes: Option<usize>,
    pub stderr_bytes: Option<usize>,
    pub stage: Option<&'static str>,
    pub error_class: Option<&'static str>,
    pub io_kind: Option<&'static str>,
    pub errno: Option<i32>,
    pub sqlite_code: Option<i32>,
    pub child_exit: Option<i32>,
    pub child_signal: Option<i32>,
}

impl StoppedRepairFailure {
    pub(crate) fn new(category: &'static str) -> Self {
        Self {
            category,
            wait_http_status: None,
            helper_exit: None,
            diagnostic_status: "unavailable",
            log_bytes: None,
            stderr_bytes: None,
            stage: None,
            error_class: None,
            io_kind: None,
            errno: None,
            sqlite_code: None,
            child_exit: None,
            child_signal: None,
        }
    }

    fn read_logs(&mut self, bytes: &[u8]) {
        self.log_bytes = Some(bytes.len());
        // stdout never participates in failure classification or receipt parsing.
        let mut cursor = 0;
        let mut stderr = Vec::new();
        while cursor < bytes.len() {
            let Some(header) = bytes.get(cursor..cursor.saturating_add(8)) else {
                self.diagnostic_status = "truncated";
                return;
            };
            if !matches!(header[0], 1 | 2) || header[1..4] != [0, 0, 0] {
                self.diagnostic_status = "malformed";
                return;
            }
            let length = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
            let Some(end) = cursor.checked_add(8).and_then(|n| n.checked_add(length)) else {
                self.diagnostic_status = "truncated";
                return;
            };
            let Some(payload) = bytes.get(cursor + 8..end) else {
                self.diagnostic_status = "truncated";
                return;
            };
            if header[0] == 2 {
                if stderr.len().saturating_add(length) > MAX_REPAIR_RECEIPT_BYTES {
                    self.diagnostic_status = "truncated";
                    return;
                }
                stderr.extend_from_slice(payload);
            }
            cursor = end;
        }
        self.stderr_bytes = Some(stderr.len());
        self.diagnostic_status = if stderr.is_empty() {
            "absent"
        } else {
            "unrecognized"
        };
        for record in String::from_utf8_lossy(&stderr)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        {
            if record["event"] != "session_host.opencode_repair.failed"
                || record["severity"] != "error"
            {
                continue;
            }
            self.stage = match record["stage"].as_str() {
                Some("stage_validation") => Some("stage_validation"),
                Some("identity_spawn") => Some("identity_spawn"),
                Some("input_stream") => Some("input_stream"),
                Some("import") => Some("import"),
                Some("reader") => Some("reader"),
                Some("receipt_validation") => Some("receipt_validation"),
                _ => continue,
            };
            self.error_class = match record["errorClass"].as_str() {
                Some("io") => Some("io"),
                Some("sqlite") => Some("sqlite"),
                Some("blocked") => Some("blocked"),
                Some("metadata") => Some("metadata"),
                Some("validation") => Some("validation"),
                Some("process") => Some("process"),
                _ => {
                    self.stage = None;
                    continue;
                }
            };
            self.io_kind = match record["ioKind"].as_str() {
                Some("PermissionDenied") => Some("PermissionDenied"),
                Some("NotFound") => Some("NotFound"),
                Some("AlreadyExists") => Some("AlreadyExists"),
                Some("InvalidData") => Some("InvalidData"),
                Some("InvalidInput") => Some("InvalidInput"),
                Some("StorageFull") => Some("StorageFull"),
                Some("BrokenPipe") => Some("BrokenPipe"),
                Some("UnexpectedEof") => Some("UnexpectedEof"),
                Some(_) => Some("Other"),
                None => None,
            };
            let number = |key: &str| record[key].as_i64().and_then(|n| i32::try_from(n).ok());
            self.errno = number("errno");
            self.sqlite_code = number("sqliteCode");
            self.child_exit = number("childExit");
            self.child_signal = number("childSignal");
            self.diagnostic_status = "available";
            break;
        }
    }
}

impl std::fmt::Display for StoppedRepairFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "category={} helper_exit={} stage={} class={} diagnostic={}",
            self.category,
            self.helper_exit
                .map(|exit| exit.to_string())
                .unwrap_or_else(|| "unknown".into()),
            self.stage.unwrap_or("unknown"),
            self.error_class.unwrap_or("unknown"),
            self.diagnostic_status
        )
    }
}

struct ReadonlyNativeReader {
    image_ref: String,
    uid: u32,
    gid: u32,
    args: Vec<String>,
    env: Vec<String>,
    cwd: Option<String>,
    extra_mounts: Vec<Value>,
    tmpfs: &'static str,
    tty: bool,
}

/// Existing-store helpers need the accepted workspace namespace, not a new
/// provider input publication. Their callers resolve these mounts for adoption.
fn readonly_workspace_mounts(mounts: &docker::TerminalMounts) -> Vec<Value> {
    let mut selected = vec![
        json!({"Type":"bind","Source":mounts.workspace,"Target":mounts.workspace,"ReadOnly":true}),
    ];
    if let Some(git) = &mounts.git_common_dir {
        if !git.starts_with(&mounts.workspace) {
            selected.push(json!({"Type":"bind","Source":git,"Target":git,"ReadOnly":true}));
        }
    }
    selected
}

fn stopped_repair_provider_env(terminal: &TerminalLaunchSpec) -> Vec<String> {
    let mut env = terminal.env.clone();
    env.insert("HOME".into(), OPENCODE_PROVIDER_HOME.into());
    env.insert(
        "XDG_DATA_HOME".into(),
        format!("{OPENCODE_PROVIDER_HOME}/.local/share"),
    );
    env.insert(
        "XDG_CONFIG_HOME".into(),
        format!("{OPENCODE_PROVIDER_HOME}/.config"),
    );
    env.insert(
        "OPENCODE_DB".into(),
        format!("{OPENCODE_PROVIDER_HOME}/.local/share/opencode/opencode.db"),
    );
    env.into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect()
}

fn decode_docker_stdout_frames(
    bytes: &[u8],
    max_output_bytes: usize,
) -> Result<Vec<u8>, BackendError> {
    decode_docker_log_frames(bytes, max_output_bytes, false)
}

fn decode_docker_log_frames(
    bytes: &[u8],
    max_output_bytes: usize,
    include_stderr: bool,
) -> Result<Vec<u8>, BackendError> {
    let malformed = |message: &str| BackendError::Malformed(message.into());
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let header_end = cursor
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| malformed("Docker repair helper log frame header is truncated"))?;
        let header = &bytes[cursor..header_end];
        if !(header[0] == 1 || (include_stderr && header[0] == 2)) || header[1..4] != [0, 0, 0] {
            return Err(malformed(
                "Docker repair helper emitted an unexpected log stream frame",
            ));
        }
        let frame_len =
            u32::from_be_bytes(header[4..8].try_into().expect("four-byte length")) as usize;
        let frame_end = header_end
            .checked_add(frame_len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| malformed("Docker repair helper log frame payload is truncated"))?;
        if output.len().saturating_add(frame_len) > max_output_bytes {
            return Err(malformed(
                "Docker repair helper output exceeds its configured bound",
            ));
        }
        output.extend_from_slice(&bytes[header_end..frame_end]);
        cursor = frame_end;
    }
    if output.is_empty() {
        return Err(malformed("Docker repair helper emitted no stdout receipt"));
    }
    Ok(output)
}

impl DockerEngineBackend {
    pub(super) async fn read_census_helper(
        &self,
        handle: &OwnedRuntimeHandle,
        spec: &freshell_runtime_protocol::ResumeSpec,
        reader_binary: &Path,
        image_ref: &str,
    ) -> Result<freshell_agent_runtime::ProviderStoreProbe, BackendError> {
        if spec.provider_session.provider_store_id != handle.provider_store_id()
            || spec.provider_home != OPENCODE_PROVIDER_HOME
            || image_ref.len() != 71
            || !image_ref.starts_with("sha256:")
        {
            return Err(BackendError::OwnershipMismatch(
                "native census request does not bind the owned store and current image".into(),
            ));
        }
        let (uid, gid) = handle
            .terminal()
            .map(|terminal| (terminal.run_as_uid, terminal.run_as_gid))
            .or_else(|| {
                handle
                    .fresh_agent()
                    .map(|agent| (agent.run_as_uid, agent.run_as_gid))
            })
            // Explicit fixtures already run as the host workload uid/gid.
            // Real providers always use the configured identity above.
            .or_else(|| handle.fixture().map(|_| (0, 0)))
            .ok_or_else(|| {
                BackendError::InvalidConfig("native census needs an exact provider workload".into())
            })?;
        // The native reader needs store selection only, never credentials or
        // provider argv. No private environment enters Docker's Cmd or logs.
        let mut reader_spec = spec.clone();
        reader_spec.environment.retain(|key, _| {
            matches!(
                key.as_str(),
                "HOME"
                    | "CLAUDE_CONFIG_DIR"
                    | "CODEX_HOME"
                    | "AMPLIFIER_HOME"
                    | "XDG_DATA_HOME"
                    | "OPENCODE_DB"
                    | "OPENCODE_DISABLE_CHANNEL_DB"
            )
        });
        reader_spec.resume_argv.clear();
        reader_spec.credential_references.clear();
        let roots = freshell_agent_runtime::native_store_paths(
            Path::new(OPENCODE_PROVIDER_HOME),
            &reader_spec,
        )
        .map_err(|_| {
            BackendError::Unavailable("selected native store cannot be resolved".into())
        })?;
        let needs_workspace = roots.iter().any(|root| {
            !freshell_platform::opencode_config::lexical_path(root)
                .starts_with(OPENCODE_PROVIDER_HOME)
        });
        let mut extra_mounts = Vec::new();
        if needs_workspace {
            let mounts = handle
                .terminal()
                .map(docker::terminal_mounts_for_adoption)
                .or_else(|| {
                    handle
                        .fresh_agent()
                        .map(docker::fresh_agent_mounts_for_adoption)
                })
                .ok_or_else(|| {
                    BackendError::Unavailable(
                        "selected native store has no owned workspace mounts".into(),
                    )
                })?
                .map_err(BackendError::InvalidConfig)?;
            for root in &roots {
                let root = freshell_platform::opencode_config::lexical_path(root);
                if !root.is_absolute()
                    || !(root.starts_with(OPENCODE_PROVIDER_HOME)
                        || root.starts_with(&mounts.workspace)
                        || mounts
                            .git_common_dir
                            .as_ref()
                            .is_some_and(|git| root.starts_with(git)))
                {
                    return Err(BackendError::Unavailable(
                        "selected native store is outside the owned reader mounts".into(),
                    ));
                }
            }
            extra_mounts = readonly_workspace_mounts(&mounts);
        }
        let output = self
            .readonly_native_helper(
                handle,
                reader_binary,
                ReadonlyNativeReader {
                    image_ref: image_ref.into(),
                    uid,
                    gid,
                    args: vec![
                        "provider-census-only".into(),
                        serde_json::to_string(&reader_spec)
                            .map_err(|error| BackendError::Malformed(error.to_string()))?,
                    ],
                    env: reader_spec
                        .environment
                        .iter()
                        .map(|(key, value)| format!("{key}={value}"))
                        .collect(),
                    cwd: None,
                    extra_mounts,
                    tmpfs: "rw,noexec,nosuid,nodev,size=16m",
                    tty: false,
                },
                Duration::from_secs(30),
            )
            .await?;
        serde_json::from_value(output).map_err(|error| BackendError::Malformed(error.to_string()))
    }
    pub(super) async fn repair_stopped_opencode_helper(
        &self,
        handle: &OwnedRuntimeHandle,
        descriptor: &OpenCodeTransferDescriptor,
        verified_stage_dir: &Path,
        budget: Duration,
    ) -> Result<StoppedOpenCodeRepairReceipts, BackendError> {
        let terminal = handle.terminal().ok_or_else(|| {
            BackendError::InvalidConfig("stopped OpenCode repair requires a terminal soul".into())
        })?;
        if terminal.mode != "opencode"
            || descriptor.provider != "opencode"
            || descriptor.destination_store_id != handle.provider_store_id()
            || descriptor.target_image_ref != handle.image_ref()
        {
            return Err(BackendError::OwnershipMismatch(
                "stopped OpenCode repair identity does not match the owned soul".into(),
            ));
        }
        let stage = canonical_dir(verified_stage_dir)?;
        if stage != verified_stage_dir {
            return Err(BackendError::OwnershipMismatch(
                "stopped OpenCode repair stage is not canonical".into(),
            ));
        }
        let mounts =
            docker::terminal_mounts_for_adoption(terminal).map_err(BackendError::InvalidConfig)?;
        let binary = canonical_regular_file(handle.host_binary_path())?;
        let name = format!("freshell-opencode-repair-{}", uuid::Uuid::new_v4());
        let mut create_attempted = false;
        let mut helper_id = None;
        let mut failure = StoppedRepairFailure::new("helper_operation_failed");
        // Keep the original successful-operation deadline. Failure diagnostics
        // use only its remaining time; cleanup retains its separate five-second cap.
        let deadline = tokio::time::Instant::now() + budget;
        let operation = async {
            if self.daemon_id().await? != *handle.daemon_id() {
                return Err(BackendError::OwnershipMismatch(
                    "stopped OpenCode repair daemon changed".into(),
                ));
            }
            let volume = self
                .request(
                    "GET",
                    &format!("{DOCKER_API}/volumes/{}", handle.provider_volume_name()),
                    None,
                )
                .await?;
            if volume.status != 200 {
                return Err(volume.as_error());
            }
            let volume: Value = serde_json::from_slice(&volume.body)
                .map_err(|error| BackendError::Malformed(error.to_string()))?;
            if volume["Name"].as_str() != Some(handle.provider_volume_name()) {
                return Err(BackendError::OwnershipMismatch(
                    "stopped OpenCode repair provider volume changed".into(),
                ));
            }
            let mut docker_mounts = vec![
                json!({"Type":"bind", "Source":binary, "Target":"/runtime/freshell-session-host", "ReadOnly":true}),
                json!({"Type":"volume", "Source":handle.provider_volume_name(), "Target":"/home/freshell/provider", "ReadOnly":false}),
                json!({"Type":"bind", "Source":stage, "Target":"/run/freshell-opencode-transfer", "ReadOnly":true}),
            ];
            docker_mounts.extend(readonly_workspace_mounts(&mounts));
            let env = stopped_repair_provider_env(terminal);
            let body = json!({
                "Image": handle.image_ref(),
                "User": "0:0",
                "WorkingDir": terminal.cwd.as_str(),
                "Tty": false,
                "Entrypoint": ["/runtime/freshell-session-host"],
                "Cmd": [
                    "opencode-stopped-repair-worker",
                    "--stage-dir", "/run/freshell-opencode-transfer",
                    "--workspace-root", terminal.workspace_path.as_str(),
                    "--expected-cwd", terminal.cwd.as_str(),
                    "--provider-uid", terminal.run_as_uid.to_string(),
                    "--provider-gid", terminal.run_as_gid.to_string(),
                ],
                "Env": env,
                "HostConfig": {
                    "NetworkMode": "none",
                    "ReadonlyRootfs": true,
                    "CapDrop": ["ALL"],
                    "CapAdd": ["SETUID", "SETGID"],
                    "SecurityOpt": ["no-new-privileges"],
                    "Memory": 256 * 1024 * 1024,
                    "MemorySwap": 256 * 1024 * 1024,
                    "NanoCpus": 500_000_000,
                    "PidsLimit": 32,
                    "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=16m"},
                    "Mounts": docker_mounts,
                }
            });
            create_attempted = true;
            let created = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/create?name={name}"),
                    Some(&body),
                    64 * 1024,
                )
                .await?;
            if created.status != 201 {
                return Err(created.as_error());
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|error| BackendError::Malformed(error.to_string()))?;
            let id = created["Id"].as_str().ok_or_else(|| {
                BackendError::Malformed("stopped OpenCode repair helper has no id".into())
            })?;
            helper_id = Some(id.to_owned());
            let started = self
                .request("POST", &format!("{DOCKER_API}/containers/{id}/start"), None)
                .await?;
            if started.status != 204 {
                return Err(started.as_error());
            }
            failure.category = "wait_transport_failed";
            let waited = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/{id}/wait?condition=not-running"),
                    None,
                    64 * 1024,
                )
                .await?;
            failure.wait_http_status = Some(waited.status);
            failure.category = "wait_http_failed";
            if waited.status != 200 {
                return Err(BackendError::Unavailable(
                    "stopped helper wait HTTP failed".into(),
                ));
            }
            failure.category = "wait_malformed";
            let waited: Value = serde_json::from_slice(&waited.body).map_err(|_| {
                BackendError::Malformed("stopped helper wait JSON is invalid".into())
            })?;
            failure.helper_exit = waited["StatusCode"].as_i64();
            failure.category = if waited.get("Error").is_some_and(|error| !error.is_null()) {
                "wait_engine_error"
            } else if failure.helper_exit.is_none() {
                "wait_exit_unknown"
            } else {
                "helper_nonzero_exit"
            };
            if failure.helper_exit != Some(0) || failure.category == "wait_engine_error" {
                return Err(BackendError::Unavailable(
                    "stopped helper did not succeed".into(),
                ));
            }
            failure.category = "receipt_failed";
            let logs = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/containers/{id}/logs?stdout=1&stderr=0"),
                    None,
                    MAX_REPAIR_RECEIPT_BYTES as u64,
                )
                .await?;
            if logs.status != 200 || logs.body.len() > MAX_REPAIR_RECEIPT_BYTES {
                return Err(if logs.status != 200 {
                    logs.as_error()
                } else {
                    BackendError::Malformed(
                        "stopped OpenCode repair receipt exceeds its bound".into(),
                    )
                });
            }
            let output = decode_docker_stdout_frames(&logs.body, MAX_REPAIR_RECEIPT_BYTES)?;
            serde_json::from_slice::<StoppedOpenCodeRepairReceipts>(&output)
                .map_err(|error| BackendError::Malformed(error.to_string()))
        };
        let mut result = match tokio::time::timeout_at(deadline, operation).await {
            Ok(result) => result,
            Err(_) => {
                failure.category = "helper_timeout";
                Err(BackendError::Unavailable(
                    "stopped OpenCode repair helper timed out".into(),
                ))
            }
        };
        if result.is_err() && create_attempted {
            let diagnostic_budget = deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .min(Duration::from_secs(5));
            if diagnostic_budget.is_zero() {
                failure.diagnostic_status = "budget_exhausted";
            } else if let Some(id) = helper_id {
                match tokio::time::timeout(
                    diagnostic_budget,
                    self.request_bounded(
                        "GET",
                        &format!("{DOCKER_API}/containers/{id}/logs?stdout=1&stderr=1"),
                        None,
                        MAX_REPAIR_RECEIPT_BYTES as u64,
                    ),
                )
                .await
                {
                    Ok(Ok(logs)) if logs.status == 200 => failure.read_logs(&logs.body),
                    Ok(Ok(_)) => failure.diagnostic_status = "http_failed",
                    Ok(Err(_)) => failure.diagnostic_status = "transport_or_bound_failed",
                    Err(_) => failure.diagnostic_status = "timeout",
                }
            }
            tracing::error!(soul_id=%handle.soul_id(), incarnation_id=%handle.incarnation_id(), helper=%name,
                source_store_id=%descriptor.source_store_id, destination_store_id=%descriptor.destination_store_id,
                root_session_id=%descriptor.root_session_id, source_generation=%descriptor.source_generation,
                transfer_id=%descriptor.transfer_id, diagnostic=%serde_json::to_string(&failure).expect("safe diagnostic JSON"),
                "runtime.stopped_opencode_repair_failed");
            result = Err(BackendError::StoppedRepair(Box::new(failure)));
        }
        if !create_attempted {
            return result;
        }
        let cleanup = tokio::time::timeout(
            Duration::from_secs(5),
            self.request(
                "DELETE",
                &format!("{DOCKER_API}/containers/{name}?force=1"),
                None,
            ),
        )
        .await;
        match cleanup {
            Ok(Ok(response)) if response.status == 204 || response.status == 404 => {}
            failed => {
                let (category, http_status) = match failed {
                    Ok(Ok(response)) => ("http_failed", Some(response.status)),
                    Ok(Err(_)) => ("transport_failed", None),
                    Err(_) => ("timeout", None),
                };
                tracing::warn!(soul_id=%handle.soul_id(), helper=%name, category, http_status,
                    "runtime.stopped_opencode_repair_cleanup_failed");
                if result.is_ok() {
                    return Err(BackendError::Unavailable(
                        "stopped OpenCode repair helper cleanup failed".into(),
                    ));
                }
            }
        }
        result
    }

    pub(super) async fn read_history_helper(
        &self,
        handle: &OwnedRuntimeHandle,
        provider: &str,
        native_id: &str,
        reader_binary: &Path,
        budget: Duration,
    ) -> Result<Value, BackendError> {
        let agent = handle.fresh_agent().ok_or_else(|| {
            BackendError::InvalidConfig("native history requires a fresh agent".into())
        })?;
        self.readonly_native_helper(
            handle,
            reader_binary,
            ReadonlyNativeReader {
                image_ref: handle.image_ref().into(),
                uid: agent.run_as_uid,
                gid: agent.run_as_gid,
                args: vec![
                    "native-history-only".into(),
                    "--provider".into(),
                    provider.into(),
                    "--session-id".into(),
                    native_id.into(),
                    "--provider-home".into(),
                    OPENCODE_PROVIDER_HOME.into(),
                ],
                env: vec![format!("HOME={OPENCODE_PROVIDER_HOME}")],
                cwd: None,
                extra_mounts: Vec::new(),
                tmpfs: "rw,noexec,nosuid,nodev,size=16m",
                tty: true,
            },
            budget,
        )
        .await
    }

    pub(super) async fn retained_store_helper(
        &self,
        handle: &OwnedRuntimeHandle,
        request: &freshell_runtime_protocol::RetainedStoreCompatibilityRequest,
        reader_binary: &Path,
    ) -> Result<freshell_runtime_protocol::RetainedStoreCompatibilityReceipt, BackendError> {
        if request.provider_store_id != handle.provider_store_id()
            || request.provider_home != OPENCODE_PROVIDER_HOME
            || request.image_ref.len() != 71
            || !request.image_ref.starts_with("sha256:")
        {
            return Err(BackendError::OwnershipMismatch(
                "retained-store request does not bind the selected volume and current image".into(),
            ));
        }
        let (uid, gid, workspace, cwd, mounts) = if let Some(terminal) = handle.terminal() {
            if terminal.mode != "opencode" {
                return Err(BackendError::InvalidConfig(
                    "retained-store helper requires OpenCode".into(),
                ));
            }
            (
                terminal.run_as_uid,
                terminal.run_as_gid,
                terminal.workspace_path.as_str(),
                terminal.cwd.as_str(),
                docker::terminal_mounts_for_adoption(terminal),
            )
        } else if let Some(agent) = handle.fresh_agent() {
            if agent.provider.as_str() != "opencode" {
                return Err(BackendError::InvalidConfig(
                    "retained-store helper requires OpenCode".into(),
                ));
            }
            (
                agent.run_as_uid,
                agent.run_as_gid,
                agent.workspace_path.as_str(),
                agent.cwd.as_str(),
                docker::fresh_agent_mounts_for_adoption(agent),
            )
        } else {
            return Err(BackendError::InvalidConfig(
                "retained-store helper requires an exact provider workload".into(),
            ));
        };
        if (request.provider_uid, request.provider_gid) != (uid, gid)
            || request.workspace_path != workspace
            || request.cwd != cwd
        {
            return Err(BackendError::OwnershipMismatch(
                "retained-store provider identity or workspace changed".into(),
            ));
        }
        let mounts = mounts.map_err(BackendError::InvalidConfig)?;
        let extra_mounts = readonly_workspace_mounts(&mounts);
        let output=self.readonly_native_helper(handle,reader_binary,ReadonlyNativeReader {
            image_ref:request.image_ref.clone(),uid,gid,
            args:vec!["retained-opencode-store-worker".into(),serde_json::to_string(request).map_err(|error|BackendError::Malformed(error.to_string()))?],
            env:vec![format!("HOME={OPENCODE_PROVIDER_HOME}"),format!("XDG_DATA_HOME={OPENCODE_PROVIDER_HOME}/.local/share"),format!("XDG_CONFIG_HOME={OPENCODE_PROVIDER_HOME}/.config"),format!("OPENCODE_DB={OPENCODE_PROVIDER_HOME}/.local/share/opencode/opencode.db")],
            cwd:Some(cwd.into()),extra_mounts,tmpfs:"rw,noexec,nosuid,nodev,size=64m",tty:false,
        },Duration::from_secs(30)).await?;
        let receipt: freshell_runtime_protocol::RetainedStoreCompatibilityReceipt =
            serde_json::from_value(output)
                .map_err(|error| BackendError::Malformed(error.to_string()))?;
        if &receipt.request != request
            || receipt.provider_version
                != freshell_agent_runtime::pinned_provider_version("opencode").unwrap_or_default()
            || receipt.row_count == 0
            || [
                &receipt.source_schema_fingerprint,
                &receipt.migration_journal_fingerprint,
                &receipt.generation,
            ]
            .iter()
            .any(|value| {
                value.len() != 64
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
        {
            return Err(BackendError::OwnershipMismatch(
                "retained-store compatibility receipt does not match the selected request".into(),
            ));
        }
        Ok(receipt)
    }

    async fn readonly_native_helper(
        &self,
        handle: &OwnedRuntimeHandle,
        reader_binary: &Path,
        reader: ReadonlyNativeReader,
        budget: Duration,
    ) -> Result<Value, BackendError> {
        let name = format!("freshell-history-{}", uuid::Uuid::new_v4());
        let mut create_attempted = false;
        let operation = async {
            if self.daemon_id().await? != *handle.daemon_id() {
                return Err(BackendError::OwnershipMismatch(
                    "native history daemon changed".into(),
                ));
            }
            let volume = self
                .request(
                    "GET",
                    &format!("{DOCKER_API}/volumes/{}", handle.provider_volume_name()),
                    None,
                )
                .await?;
            if volume.status != 200 {
                return Err(volume.as_error());
            }
            let volume: Value = serde_json::from_slice(&volume.body)
                .map_err(|e| BackendError::Malformed(e.to_string()))?;
            if volume["Name"].as_str() != Some(handle.provider_volume_name()) {
                return Err(BackendError::OwnershipMismatch(
                    "native history volume changed".into(),
                ));
            }
            let binary = canonical_regular_file(reader_binary)?;
            let mut mounts = vec![
                json!({"Type":"bind","Source":binary,"Target":"/runtime/freshell-session-host","ReadOnly":true}),
                json!({"Type":"volume","Source":handle.provider_volume_name(),"Target":OPENCODE_PROVIDER_HOME,"ReadOnly":true}),
            ];
            mounts.extend(reader.extra_mounts);
            let body = json!({
                "Image":reader.image_ref, "User":format!("{}:{}",reader.uid,reader.gid), "Tty":reader.tty,
                "WorkingDir":reader.cwd,
                "Entrypoint":["/runtime/freshell-session-host"],"Cmd":reader.args,"Env":reader.env,
                "HostConfig": {"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],
                    "SecurityOpt":["no-new-privileges"],"Memory":256*1024*1024,"MemorySwap":256*1024*1024,
                    "NanoCpus":500_000_000,"PidsLimit":32,"Tmpfs":{"/tmp":reader.tmpfs},"Mounts":mounts}
            });
            // The helper has no runtime labels, registry incarnation, execution grant or control mount.
            create_attempted = true;
            let created = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/create?name={name}"),
                    Some(&body),
                    64 * 1024,
                )
                .await?;
            if created.status != 201 {
                return Err(created.as_error());
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|e| BackendError::Malformed(e.to_string()))?;
            let id = created["Id"]
                .as_str()
                .ok_or_else(|| BackendError::Malformed("history helper has no id".into()))?;
            let started = self
                .request("POST", &format!("{DOCKER_API}/containers/{id}/start"), None)
                .await?;
            if started.status != 204 {
                return Err(started.as_error());
            }
            let waited = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/{id}/wait?condition=not-running"),
                    None,
                    64 * 1024,
                )
                .await?;
            if waited.status != 200 {
                return Err(waited.as_error());
            }
            let waited: Value = serde_json::from_slice(&waited.body)
                .map_err(|e| BackendError::Malformed(e.to_string()))?;
            if waited["StatusCode"].as_i64() != Some(0) {
                let logs = self
                    .request_bounded(
                        "GET",
                        &format!("{DOCKER_API}/containers/{id}/logs?stdout=1&stderr=1"),
                        None,
                        16 * 1024,
                    )
                    .await?;
                let error_output = if reader.tty {
                    logs.body
                } else {
                    decode_docker_log_frames(&logs.body, 16 * 1024, true).unwrap_or_default()
                };
                let cause = std::str::from_utf8(&error_output)
                    .ok()
                    .into_iter()
                    .flat_map(str::lines)
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .filter(|record| record["event"] == "session_host.fatal")
                    .find_map(|record| {
                        record
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| "saved native history could not be read".into());
                return Err(BackendError::Unavailable(cause));
            }
            let logs = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/containers/{id}/logs?stdout=1&stderr=0"),
                    None,
                    (MAX_SNAPSHOT_BYTES + 64 * 1024) as u64,
                )
                .await?;
            if logs.status != 200 {
                return Err(logs.as_error());
            }
            if logs.body.len() > MAX_SNAPSHOT_BYTES {
                return Err(BackendError::Unavailable(
                    "saved history exceeds snapshot read limit".into(),
                ));
            }
            let output = if reader.tty {
                logs.body
            } else {
                decode_docker_stdout_frames(&logs.body, MAX_SNAPSHOT_BYTES)?
            };
            serde_json::from_slice::<Value>(&output)
                .map_err(|e| BackendError::Malformed(e.to_string()))
        };
        let result = tokio::time::timeout(budget, operation)
            .await
            .unwrap_or_else(|_| {
                Err(BackendError::Unavailable(
                    "native history read timed out".into(),
                ))
            });
        // Unique owned name also covers a lost Docker create acknowledgment. Never touch the provider container.
        if !create_attempted {
            return result;
        }
        let cleanup = tokio::time::timeout(
            Duration::from_secs(5),
            self.request(
                "DELETE",
                &format!("{DOCKER_API}/containers/{name}?force=1"),
                None,
            ),
        )
        .await;
        match cleanup {
            Ok(Ok(response)) if response.status == 204 || response.status == 404 => {}
            _ => {
                tracing::warn!(soul_id=%handle.soul_id(), helper=%name, "runtime.native_history_cleanup_failed");
                return Err(BackendError::Unavailable(
                    "native history helper cleanup failed".into(),
                ));
            }
        }
        if let Err(error) = &result {
            tracing::warn!(soul_id=%handle.soul_id(), helper=%name, error=%error, "runtime.native_history_read_failed");
        } else {
            tracing::debug!(soul_id=%handle.soul_id(), helper=%name, "runtime.native_history_read");
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::LaunchNonce;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
    };

    fn docker_stdout_frame(payload: &[u8]) -> Vec<u8> {
        let mut framed = vec![1, 0, 0, 0];
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(payload);
        framed
    }

    fn isolated_deleted_input_case() -> bool {
        const CHILD: &str = "FRESHELL_DELETED_INPUT_HELPER_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            return false;
        }
        let thread = std::thread::current();
        let test_name = thread.name().expect("named test thread");
        let status = std::process::Command::new("/usr/bin/timeout")
            .args(["--kill-after=1s", "20s"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "isolated deleted-input helper case failed"
        );
        true
    }

    fn selected_input_context(
        root: &Path,
        workspace: &Path,
    ) -> freshell_runtime_protocol::ProviderLaunchContext {
        use std::os::unix::fs::PermissionsExt;
        let capabilities = root.join("mcp-capabilities");
        let stage = root.join("provider-roots/grant-helper-input");
        let selected = workspace.join(".opencode");
        std::fs::create_dir(&selected).unwrap();
        std::fs::write(selected.join("plugin.json"), b"{}").unwrap();
        std::fs::create_dir(&capabilities).unwrap();
        std::fs::create_dir_all(stage.join(".freshell/resource-units/project")).unwrap();
        let manifest = b"{\"sources\":[]}";
        std::fs::write(stage.join(".freshell/input-manifest.json"), manifest).unwrap();
        let grant = capabilities.join("grant-helper-input.json");
        std::fs::write(&grant, b"{}").unwrap();
        std::fs::set_permissions(grant, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::env::set_var("FRESHELL_RUNTIME_CAPABILITY_DIR", capabilities);
        std::env::set_var("HOME", workspace);
        std::env::remove_var("FRESHELL_SUPERVISOR_OPERATOR_HOME");
        serde_json::from_value(json!({
            "preparation":freshell_runtime_protocol::ProviderPreparation::Opencode {
                project_config:vec![], tui_config:None, tui_source:None, inline_config:false,
            },
            "config":[],
            "mcpCapability":{"grantId":"grant-helper-input","endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
            "preparedInputs":{
                "generationId":"grant-helper-input",
                "manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(manifest)),"sourceCount":0,"aliasCount":0,"recipeCount":0},
                "configBinds":[],"indexedFiles":null,
                "resourceMounts":[{"stageRelativePath":".freshell/resource-units/project","providerRelativePath":".freshell/provider-roots/project",
                    "logicalDestination":selected,"effectiveDestination":selected,"kind":"directory","writable":false,"referenceAliases":[],"retiredReferenceAliases":[]}]
            }
        })).unwrap()
    }

    #[tokio::test]
    async fn retained_store_helper_reads_terminal_after_selected_input_deletion() {
        check_history_helper("compatibility_deleted_terminal").await;
    }

    #[tokio::test]
    async fn retained_store_helper_reads_fresh_after_selected_input_deletion() {
        check_history_helper("compatibility_deleted_fresh").await;
    }

    #[tokio::test]
    async fn census_helper_reads_terminal_after_selected_input_deletion() {
        check_history_helper("census_workspace_deleted_terminal").await;
    }

    #[tokio::test]
    async fn census_helper_reads_fresh_after_selected_input_deletion() {
        check_history_helper("census_workspace_deleted_fresh").await;
    }

    #[tokio::test]
    async fn history_helper_reads_fresh_after_selected_input_deletion() {
        check_history_helper("history_deleted_fresh").await;
    }

    #[test]
    fn stopped_repair_decodes_bounded_docker_stdout_frames() {
        let mut frames = docker_stdout_frame(b"{\"imported\":");
        frames.extend(docker_stdout_frame(b"true}"));

        assert_eq!(
            decode_docker_stdout_frames(&frames, 32).unwrap(),
            br#"{"imported":true}"#
        );
        assert!(matches!(
            decode_docker_stdout_frames(&frames, 8),
            Err(BackendError::Malformed(_))
        ));
    }

    #[test]
    fn stopped_repair_rejects_non_stdout_and_truncated_docker_frames() {
        let mut stderr = docker_stdout_frame(b"not-stdout");
        stderr[0] = 2;
        assert!(matches!(
            decode_docker_stdout_frames(&stderr, 32),
            Err(BackendError::Malformed(_))
        ));
        assert!(matches!(
            decode_docker_stdout_frames(&[1, 0, 0], 32),
            Err(BackendError::Malformed(_))
        ));
        assert!(matches!(
            decode_docker_stdout_frames(&[1, 0, 0, 0, 0, 0, 0, 2, b'{'], 32),
            Err(BackendError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn history_helper_cleans_only_its_owned_container_on_success_error_and_timeout() {
        for mode in [
            "success",
            "compatibility_success",
            "compatibility_failure",
            "census_success",
            "census_workspace",
            "census_unmounted",
            "census_unreadable",
            "census_fixture",
            "failed_exit",
            "bad_output",
            "timeout",
            "failed_cleanup",
        ] {
            check_history_helper(mode).await;
        }
    }

    async fn check_history_helper(mode: &'static str) {
        let deleted_input = mode.contains("deleted");
        if deleted_input && isolated_deleted_input_case() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let socket = temp.path().join("docker.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let daemon = DockerDaemonId::new();
        let expected_daemon = daemon.clone();
        let binary = temp.path().join("reader");
        std::fs::write(&binary, "fixture binary").unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let mut agent: FreshAgentLaunchSpec = serde_json::from_value(json!({
                "sessionId":"presentation-alias","provider":"opencode","sessionType":"freshopencode",
                "runtimeVariant":"opencode","providerStoreId":"store","cwd":workspace,"workspacePath":workspace,
                "runAsUid":65534,"runAsGid":0,"nativeSessionId":"ses_saved"
            })).unwrap();
        let mut terminal: TerminalLaunchSpec = serde_json::from_value(json!({"terminalId":"census","streamId":"census","mode":"opencode","program":"opencode",
            "cwd":workspace,"workspacePath":workspace,"env":{"HOME":OPENCODE_PROVIDER_HOME,"API_KEY":"private-fixture-value"},
            "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"test"})).unwrap();
        if deleted_input {
            let context = selected_input_context(temp.path(), &workspace);
            agent.provider_launch_context = Some(context.clone());
            terminal.provider_launch_context = Some(context);
            let git = temp.path().join("git-common");
            std::fs::create_dir(&git).unwrap();
            agent.git_common_dir = Some(git.to_string_lossy().into());
            terminal.git_common_dir = agent.git_common_dir.clone();
            docker::terminal_mounts(&terminal)
                .expect("valid current terminal inputs before deletion");
            docker::fresh_agent_mounts(&agent).expect("valid current fresh inputs before deletion");
            std::fs::remove_dir_all(workspace.join(".opencode")).unwrap();
            assert!(docker::terminal_mounts(&terminal).is_err());
            assert!(docker::fresh_agent_mounts(&agent).is_err());
        }
        let handle = OwnedRuntimeHandle::from_registry(
            InstallationId::new(),
            SoulId::new(),
            "store".into(),
            IncarnationId::new(),
            LaunchNonce::new(),
            daemon,
            "provider-container-must-not-touch".into(),
            "sha256:fixture".into(),
            temp.path().into(),
            binary.clone(),
            "config".into(),
            RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 64 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            (mode == "census_fixture")
                .then_some(freshell_runtime_protocol::FixtureKind::NativeSession),
            mode.ends_with("_terminal").then_some(terminal.clone()),
            (mode != "census_fixture" && !mode.ends_with("_terminal")).then_some(agent),
            "owned-native-volume".into(),
        );
        let mut spec =
            freshell_agent_runtime::build_resume_spec(freshell_agent_runtime::ResumeSpecInput {
                provider: "opencode",
                provider_store_id: "store",
                native_session_id: "ses_saved",
                terminal: &terminal,
                provider_version: None,
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 1,
                never_dispatched: false,
            })
            .unwrap();
        if mode == "census_unreadable" {
            let database = temp.path().join(".local/share/opencode/opencode.db");
            std::fs::create_dir_all(database.parent().unwrap()).unwrap();
            std::fs::write(database, "incomplete native store").unwrap();
        }
        let provider_home = temp.path().join("provider");
        std::fs::create_dir_all(&provider_home).unwrap();
        if mode == "census_fixture" {
            spec.provider_session.provider = "native-session-fixture".into();
        }
        if mode.starts_with("census_") && mode != "census_fixture" {
            spec.environment
                .insert("OPENCODE_DISABLE_CHANNEL_DB".into(), "1".into());
            spec.provider_version = Some("1.18.21".into());
        }
        if mode.starts_with("census_workspace") || mode == "census_unmounted" {
            let selected = if mode.starts_with("census_workspace") {
                workspace.join("selected.db")
            } else {
                temp.path().join("unmounted/selected.db")
            };
            spec.environment
                .insert("OPENCODE_DB".into(), selected.display().to_string());
        }
        if mode == "census_unmounted" {
            let result = DockerEngineBackend::new(&socket)
                .read_native_census(
                    &handle,
                    &spec,
                    &binary,
                    &format!("sha256:{}", "b".repeat(64)),
                )
                .await;
            assert!(
                matches!(result, Err(BackendError::Unavailable(ref detail))
                    if detail == "selected native store is outside the owned reader mounts"),
                "{result:?}"
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(20), listener.accept())
                    .await
                    .is_err(),
                "an uncovered selected store must refuse before creating a helper"
            );
            return;
        }
        if matches!(mode, "census_success" | "census_workspace") || deleted_input {
            let path = if mode.starts_with("census_workspace") {
                workspace.join("selected.db")
            } else {
                temp.path().join(".local/share/opencode/opencode.db")
            };
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let db = rusqlite::Connection::open(path).unwrap();
            db.execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
                .unwrap();
            for migration in
                freshell_sessions::opencode_transfer::pinned_destination_migration_ids()
            {
                db.execute("INSERT INTO migration VALUES (?1,0)", [migration])
                    .unwrap();
            }
            if deleted_input {
                db.execute("INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project',?1,1,1,'{}')",[workspace.to_string_lossy().as_ref()]).unwrap();
                db.execute("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_saved','project','slug',?1,'saved session','1.18.21',1,1)",[workspace.to_string_lossy().as_ref()]).unwrap();
                db.execute("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('msg_saved','ses_saved',1,1,'{}')",[]).unwrap();
            }
        }
        let actual_probe = freshell_agent_runtime::probe_provider_store(
            if mode == "census_fixture" {
                &provider_home
            } else {
                temp.path()
            },
            &spec,
        );
        let actual_receipt = serde_json::to_string(&actual_probe).unwrap();
        let compatibility_evidence = if deleted_input && mode.starts_with("compatibility_") {
            use freshell_sessions::opencode_transfer::{
                export_exact_session, ExportOptions, HostOpenCodeInventory,
            };
            let source =
                HostOpenCodeInventory::new(temp.path().join(".local/share/opencode/opencode.db"))
                    .with_trusted_mount_for_selected_session(workspace.clone());
            let snapshot = export_exact_session(
                &source,
                "ses_saved",
                ExportOptions::new(temp.path().join("saved-export")),
            )
            .unwrap();
            let manifest = snapshot.manifest();
            json!({"sourceSchemaFingerprint":manifest.source_schema_fingerprint,"migrationJournalFingerprint":manifest.migration_journal_fingerprint,
                "generation":manifest.generation,"rowCount":manifest.row_count})
        } else {
            json!({"sourceSchemaFingerprint":"c".repeat(64),"migrationJournalFingerprint":"d".repeat(64),"generation":"e".repeat(64),"rowCount":3})
        };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let seen = captured.clone();
                let daemon = expected_daemon.clone();
                let actual_receipt = actual_receipt.clone();
                let compatibility_evidence = compatibility_evidence.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut byte = [0];
                    while !raw.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).await.unwrap();
                        raw.push(byte[0]);
                    }
                    let head = String::from_utf8(raw).unwrap();
                    let length: usize = head
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    let mut body = vec![0; length];
                    stream.read_exact(&mut body).await.unwrap();
                    let request = head.lines().next().unwrap().to_string();
                    seen.lock().unwrap().push((request.clone(), body));
                    let (status, body) = if request.contains("/info ") {
                        (200, json!({"ID":daemon}).to_string())
                    } else if request.contains("/volumes/") {
                        (200, json!({"Name":"owned-native-volume"}).to_string())
                    } else if request.contains("/create?") {
                        (201, json!({"Id":"owned-history-helper"}).to_string())
                    } else if request.contains("/start ") {
                        (204, String::new())
                    } else if request.contains("/wait?") {
                        if mode == "timeout" {
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                        (
                                200,
                                json!({"StatusCode": if matches!(mode, "failed_exit" | "compatibility_failure") {1} else {0}})
                                    .to_string(),
                            )
                    } else if request.contains("/logs?") {
                        (
                            200,
                            if mode == "bad_output" {
                                "invalid".into()
                            } else if matches!(mode, "failed_exit" | "compatibility_failure") {
                                json!({"event":"session_host.fatal","error":"saved native session not found"}).to_string()
                            } else {
                                if mode.starts_with("census_") {
                                    actual_receipt
                                } else if mode.starts_with("compatibility_") {
                                    let seen = seen.lock().unwrap();
                                    let create: Value = serde_json::from_slice(
                                        &seen
                                            .iter()
                                            .find(|(request, _)| request.contains("/create?"))
                                            .unwrap()
                                            .1,
                                    )
                                    .unwrap();
                                    let request: Value =
                                        serde_json::from_str(create["Cmd"][1].as_str().unwrap())
                                            .unwrap();
                                    let mut receipt = compatibility_evidence;
                                    receipt["request"] = request;
                                    receipt["providerVersion"] = json!("1.18.21");
                                    receipt.to_string()
                                } else {
                                    json!({"threadId":"ses_saved","provider":"opencode","turns":[]})
                                        .to_string()
                                }
                            },
                        )
                    } else if request.starts_with("DELETE ") {
                        (
                            if mode == "failed_cleanup" { 500 } else { 204 },
                            String::new(),
                        )
                    } else {
                        panic!("unexpected request {request}")
                    };
                    let body = if (mode.starts_with("compatibility_")
                        || mode.starts_with("census_"))
                        && request.contains("/logs?")
                    {
                        let mut frame = docker_stdout_frame(body.as_bytes());
                        if mode == "compatibility_failure" {
                            frame[0] = 2;
                        }
                        frame
                    } else {
                        body.into_bytes()
                    };
                    let header = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                });
            }
        });
        let backend = DockerEngineBackend::new(&socket);
        let result = if mode.starts_with("census_") {
            backend.read_native_census(&handle, &spec, &binary, &format!("sha256:{}", "b".repeat(64))).await.map(|probe| {
                    assert_eq!(probe, actual_probe);
                    if deleted_input {
                        assert!(matches!(probe, freshell_agent_runtime::ProviderStoreProbe::Ready { .. }),
                            "the selected saved native session must remain readable: {probe:?}");
                    }
                    assert_eq!(matches!(probe, freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable { .. }), matches!(mode, "census_success" | "census_workspace" | "census_fixture"));
                    serde_json::to_value(probe).unwrap()
                })
        } else if mode.starts_with("compatibility_") {
            let request = freshell_runtime_protocol::RetainedStoreCompatibilityRequest {
                provider_store_id: handle.provider_store_id().into(),
                native_session_id: "ses_saved".into(),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                provider_home: OPENCODE_PROVIDER_HOME.into(),
                workspace_path: workspace.to_string_lossy().into(),
                cwd: workspace.to_string_lossy().into(),
                provider_uid: 65534,
                provider_gid: 0,
            };
            if deleted_input {
                for mismatched in [
                    freshell_runtime_protocol::RetainedStoreCompatibilityRequest {
                        provider_store_id: "foreign-store".into(),
                        ..request.clone()
                    },
                    freshell_runtime_protocol::RetainedStoreCompatibilityRequest {
                        provider_uid: 1234,
                        ..request.clone()
                    },
                    freshell_runtime_protocol::RetainedStoreCompatibilityRequest {
                        cwd: temp.path().display().to_string(),
                        ..request.clone()
                    },
                ] {
                    assert!(
                        matches!(
                            backend
                                .qualify_retained_opencode(&handle, &mismatched, &binary)
                                .await,
                            Err(BackendError::OwnershipMismatch(_))
                        ),
                        "deleted input must not relax selected-store identity"
                    );
                }
                assert!(
                    seen.lock().unwrap().is_empty(),
                    "mismatched authority must refuse before Docker access"
                );
            }
            backend
                .qualify_retained_opencode(&handle, &request, &binary)
                .await
                .map(|receipt| serde_json::to_value(receipt).unwrap())
        } else {
            backend
                .read_history_helper(
                    &handle,
                    "opencode",
                    "ses_saved",
                    &binary,
                    if mode == "timeout" {
                        Duration::from_millis(250)
                    } else {
                        Duration::from_secs(5)
                    },
                )
                .await
        };
        assert_eq!(
            result.is_ok(),
            deleted_input
                || matches!(
                    mode,
                    "success"
                        | "compatibility_success"
                        | "census_success"
                        | "census_workspace"
                        | "census_unreadable"
                        | "census_fixture"
                ),
            "{mode}: {result:?}"
        );
        if matches!(mode, "failed_exit" | "compatibility_failure") {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("saved native session not found"));
        }
        {
            let seen = seen.lock().unwrap();
            assert!(seen
                .iter()
                .all(|(request, _)| !request.contains(handle.container_id())));
            let create: Value = serde_json::from_slice(
                &seen
                    .iter()
                    .find(|(request, _)| request.contains("/create?"))
                    .unwrap()
                    .1,
            )
            .unwrap();
            assert_eq!(
                create["User"],
                if mode == "census_fixture" {
                    "0:0"
                } else {
                    "65534:0"
                }
            );
            assert_eq!(
                create["Tty"],
                !(mode.starts_with("compatibility_") || mode.starts_with("census_"))
            );
            if mode.starts_with("census_") {
                assert_eq!(create["Cmd"][0], "provider-census-only");
                assert!(!create.to_string().contains("private-fixture-value"));
                assert_eq!(create["HostConfig"]["CapDrop"], json!(["ALL"]));
                assert_eq!(create["HostConfig"]["Mounts"][1]["ReadOnly"], true);
                let reader: freshell_runtime_protocol::ResumeSpec =
                    serde_json::from_str(create["Cmd"][1].as_str().unwrap()).unwrap();
                assert_eq!(reader.cwd, spec.cwd);
                if mode != "census_fixture" {
                    assert_eq!(
                        reader
                            .environment
                            .get("OPENCODE_DISABLE_CHANNEL_DB")
                            .map(String::as_str),
                        Some("1")
                    );
                }
                if mode.starts_with("census_workspace") {
                    let mount = &create["HostConfig"]["Mounts"][2];
                    assert_eq!(mount["Source"], workspace.to_string_lossy().as_ref());
                    assert_eq!(mount["Target"], workspace.to_string_lossy().as_ref());
                    assert_eq!(mount["ReadOnly"], true);
                    assert_eq!(
                        reader.environment.get("OPENCODE_DB"),
                        spec.environment.get("OPENCODE_DB")
                    );
                }
            }
            assert_eq!(create["HostConfig"]["NetworkMode"], "none");
            assert_eq!(
                create["HostConfig"]["Mounts"][1]["Source"],
                handle.provider_volume_name()
            );
            assert_eq!(
                create["HostConfig"]["Mounts"].as_array().unwrap().len(),
                if mode.starts_with("compatibility_") || mode.starts_with("census_workspace") {
                    if deleted_input {
                        4
                    } else {
                        3
                    }
                } else {
                    2
                }
            );
            if mode.starts_with("compatibility_") {
                assert_eq!(create["Image"], format!("sha256:{}", "b".repeat(64)));
                assert_eq!(create["Cmd"][0], "retained-opencode-store-worker");
                assert_ne!(create["Image"], handle.image_ref());
            }
            if deleted_input
                && (mode.starts_with("compatibility_") || mode.starts_with("census_workspace"))
            {
                let mounts = create["HostConfig"]["Mounts"].as_array().unwrap();
                for path in [&workspace, &temp.path().join("git-common")] {
                    assert!(mounts.iter().any(|mount| mount["Source"] == json!(path)
                        && mount["Target"] == json!(path)
                        && mount["ReadOnly"] == true));
                }
                assert!(
                    mounts
                        .iter()
                        .all(|mount| mount["Target"] != json!(workspace.join(".opencode"))),
                    "store readers mount only their required owned namespaces"
                );
            }
            assert!(create["HostConfig"]["Mounts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|mount| mount["ReadOnly"] == true));
            assert!(create.get("Labels").is_none());
            let deletes: Vec<_> = seen
                .iter()
                .filter(|(request, _)| request.starts_with("DELETE "))
                .collect();
            assert_eq!(deletes.len(), 1);
            assert!(deletes[0].0.contains("/containers/freshell-history-"));
        }
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn stopped_repair_uses_a_no_tty_identity_helper_with_only_uid_gid_capabilities() {
        check_stopped_repair_helper(None).await;
    }

    #[tokio::test]
    async fn stopped_repair_helper_reads_terminal_after_selected_input_deletion() {
        if isolated_deleted_input_case() {
            return;
        }
        check_stopped_repair_helper_with_inputs(None, true).await;
    }

    #[tokio::test]
    async fn stopped_repair_failed_helper_retains_diagnostics_before_cleanup() {
        for failure in [
            "exit",
            "malformed_wait",
            "unknown_exit",
            "wait_http",
            "engine_error",
            "logs_http",
            "oversize",
            "truncated",
            "unknown_output",
            "cleanup",
            "wait_timeout",
            "logs_timeout",
            "stdout_diagnostic",
            "malformed_logs",
        ] {
            check_stopped_repair_helper(Some(failure)).await;
        }
    }

    async fn check_stopped_repair_helper(failure: Option<&'static str>) {
        check_stopped_repair_helper_with_inputs(failure, false).await;
    }

    async fn check_stopped_repair_helper_with_inputs(
        failure: Option<&'static str>,
        deleted_input: bool,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let stage = temp.path().join("ready");
        std::fs::create_dir(&stage).unwrap();
        let socket = temp.path().join("docker.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let daemon = DockerDaemonId::new();
        let expected_daemon = daemon.clone();
        let binary = temp.path().join("freshell-session-host");
        std::fs::write(&binary, "fixture binary").unwrap();
        let mut terminal: TerminalLaunchSpec = serde_json::from_value(json!({
            "terminalId":"terminal-repair",
            "streamId":"stream-repair",
            "mode":"opencode",
            "program":"opencode",
            "cwd":workspace,
            "workspacePath":workspace,
            "runAsUid":65534,
            "runAsGid":0,
            "cols":80,
            "rows":24,
            "projectKey":"workspace",
            "env":{
                "HOME":"/home/freshell/provider",
                "XDG_DATA_HOME":"/home/freshell/provider/.local/share",
                "XDG_CONFIG_HOME":"/home/freshell/provider/.config"
            }
        }))
        .unwrap();
        if deleted_input {
            terminal.provider_launch_context =
                Some(selected_input_context(temp.path(), &workspace));
            let git = temp.path().join("git-common");
            std::fs::create_dir(&git).unwrap();
            terminal.git_common_dir = Some(git.display().to_string());
            docker::terminal_mounts(&terminal).expect("valid prepared inputs before deletion");
            std::fs::remove_dir_all(workspace.join(".opencode")).unwrap();
            assert!(
                docker::terminal_mounts(&terminal).is_err(),
                "new runtime still requires current inputs"
            );
        }
        let soul_id = SoulId::new();
        let handle = OwnedRuntimeHandle::from_registry(
            InstallationId::new(),
            soul_id.clone(),
            soul_id.to_string(),
            IncarnationId::new(),
            LaunchNonce::new(),
            daemon,
            "stopped-provider-container".into(),
            format!("sha256:{}", "a".repeat(64)),
            temp.path().into(),
            binary.clone(),
            "config".into(),
            RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 64 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            None,
            Some(terminal),
            None,
            "owned-provider-volume".into(),
        );
        let descriptor = OpenCodeTransferDescriptor {
            transfer_id: "repair-transfer".into(),
            provider: "opencode".into(),
            source_store_id: "b".repeat(64),
            root_session_id: "ses_repair".into(),
            source_generation: "c".repeat(64),
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint: "d".repeat(64),
            migration_journal_fingerprint: "e".repeat(64),
            destination_store_id: handle.provider_store_id().into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_image_ref: handle.image_ref().into(),
            target_build_receipt: "f".repeat(64),
            incarnation_id: handle.incarnation_id().to_string(),
            manifest_json: "{}".into(),
            files: Vec::new(),
            total_bytes: 0,
            bundle_sha256: "1".repeat(64),
        };
        let receipts = StoppedOpenCodeRepairReceipts {
            imported: freshell_agent_runtime::opencode_transfer::ImportReceipt {
                saved_snapshot_summary: Default::default(),
                version: 1,
                transfer_id: descriptor.transfer_id.clone(),
                destination_store_id: descriptor.destination_store_id.clone(),
                destination_database_path: descriptor.destination_database_path.clone(),
                root_session_id: descriptor.root_session_id.clone(),
                source_store_id: descriptor.source_store_id.clone(),
                source_generation: descriptor.source_generation.clone(),
                source_schema_fingerprint: descriptor.source_schema_fingerprint.clone(),
                migration_journal_fingerprint: descriptor.migration_journal_fingerprint.clone(),
                target_image_ref: descriptor.target_image_ref.clone(),
                target_build_receipt: descriptor.target_build_receipt.clone(),
                bundle_sha256: descriptor.bundle_sha256.clone(),
                row_count: 1,
                asset_count: 0,
                structural_sha256: "2".repeat(64),
            },
            readable: freshell_agent_runtime::opencode_transfer::InstalledStoreReadable {
                saved_snapshot_summary: Default::default(),
                version: 1,
                transfer_id: descriptor.transfer_id.clone(),
                destination_store_id: descriptor.destination_store_id.clone(),
                root_session_id: descriptor.root_session_id.clone(),
                source_generation: descriptor.source_generation.clone(),
                target_image_ref: descriptor.target_image_ref.clone(),
                target_build_receipt: descriptor.target_build_receipt.clone(),
                provider_uid: 65534,
                provider_gid: 0,
                home: "/home/freshell/provider".into(),
                xdg_data_home: "/home/freshell/provider/.local/share".into(),
                xdg_config_home: "/home/freshell/provider/.config".into(),
                opencode_db: "/home/freshell/provider/.local/share/opencode/opencode.db".into(),
                cwd: workspace.to_string_lossy().into_owned(),
                row_count: 1,
                asset_count: 0,
                structural_sha256: "2".repeat(64),
            },
        };
        let expected_receipts = serde_json::to_vec(&receipts).unwrap();
        let expected_receipt_len = expected_receipts.len();
        let expected_receipts_frame = if failure.is_some() {
            let mut stderr = docker_stdout_frame(br#"{"severity":"error","event":"session_host.opencode_repair.failed","stage":"import","errorClass":"io","ioKind":"PermissionDenied","errno":13}
private-body-secret-sentinel
"#);
            stderr[0] = 2;
            match failure {
                Some("stdout_diagnostic") => {
                    stderr[0] = 1;
                    stderr
                }
                Some("malformed_logs") => vec![3, 0, 0, 0, 0, 0, 0, 0],
                Some("oversize") => vec![0; MAX_REPAIR_RECEIPT_BYTES + 1],
                Some("truncated") => {
                    stderr.pop();
                    stderr
                }
                Some("unknown_output") => {
                    let mut output = docker_stdout_frame(br#"{"severity":"error","event":"session_host.fatal","error":"private-body-secret-sentinel"}
{"severity":"error","event":"session_host.opencode_repair.failed","stage":"private-body-secret-sentinel","errorClass":"io"}
"#);
                    output[0] = 2;
                    output
                }
                _ => stderr,
            }
        } else {
            docker_stdout_frame(&expected_receipts)
        };
        let seen = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
        let captured = Arc::clone(&seen);
        let server = tokio::spawn(async move {
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let seen = Arc::clone(&captured);
                let daemon = expected_daemon.clone();
                let body = expected_receipts_frame.clone();
                handlers.spawn(async move {
                    let mut raw = Vec::new();
                    let mut byte = [0];
                    while !raw.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).await.unwrap();
                        raw.push(byte[0]);
                    }
                    let head = String::from_utf8(raw).unwrap();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .unwrap_or("0")
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    let mut request_body = vec![0; length];
                    stream.read_exact(&mut request_body).await.unwrap();
                    let request = head.lines().next().unwrap().to_string();
                    seen.lock()
                        .unwrap()
                        .push((request.clone(), request_body.clone()));
                    let (status, response_body, content_type) = if request.contains("/info ") {
                        (
                            200,
                            json!({"ID":daemon}).to_string().into_bytes(),
                            "application/json",
                        )
                    } else if request.contains("/volumes/") {
                        (
                            200,
                            json!({"Name":"owned-provider-volume"})
                                .to_string()
                                .into_bytes(),
                            "application/json",
                        )
                    } else if request.contains("/create?") {
                        (
                            201,
                            json!({"Id":"repair-helper-container"})
                                .to_string()
                                .into_bytes(),
                            "application/json",
                        )
                    } else if request.contains("/start ") {
                        (204, Vec::new(), "application/json")
                    } else if request.contains("/wait?") {
                        if failure == Some("wait_timeout") { tokio::time::sleep(Duration::from_secs(1)).await; }
                        let body = match failure {
                            Some("malformed_wait") => b"invalid private-body-secret-sentinel".to_vec(),
                            Some("unknown_exit") => json!({"StatusCode":"private-body-secret-sentinel"}).to_string().into_bytes(),
                            Some("engine_error") => json!({"StatusCode":0,"Error":{"Message":"private-body-secret-sentinel"}}).to_string().into_bytes(),
                            _ => json!({"StatusCode":if failure.is_some() { 1 } else { 0 }}).to_string().into_bytes(),
                        };
                        (if failure == Some("wait_http") { 500 } else { 200 }, body, "application/json")
                    } else if request.contains("/logs?") {
                        if failure == Some("logs_timeout") { tokio::time::sleep(Duration::from_secs(1)).await; }
                        (if failure == Some("logs_http") { 500 } else { 200 }, body, "application/vnd.docker.raw-stream")
                    } else if request.starts_with("DELETE ") {
                        (if failure == Some("cleanup") { 500 } else { 204 }, Vec::new(), "application/json")
                    } else {
                        panic!("unexpected request {request}")
                    };
                    let response = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
                        response_body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                    stream.write_all(&response_body).await.unwrap();
                });
            }
        });
        let backend = DockerEngineBackend::new(&socket);
        let began = std::time::Instant::now();
        let result = backend
            .repair_stopped_opencode_helper(
                &handle,
                &descriptor,
                &stage,
                if matches!(failure, Some("wait_timeout" | "logs_timeout")) {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(5)
                },
            )
            .await;
        if matches!(failure, Some("wait_timeout" | "logs_timeout")) {
            assert!(
                began.elapsed() < Duration::from_secs(1),
                "failure diagnostics must stay bounded"
            );
        }
        if let Some(failure) = failure {
            let error = result.unwrap_err();
            let BackendError::StoppedRepair(detail) = &error else {
                panic!("expected typed stopped error: {error}");
            };
            let expected_category = match failure {
                "malformed_wait" => "wait_malformed",
                "unknown_exit" => "wait_exit_unknown",
                "wait_http" => "wait_http_failed",
                "engine_error" => "wait_engine_error",
                "wait_timeout" => "helper_timeout",
                _ => "helper_nonzero_exit",
            };
            assert_eq!(detail.category, expected_category, "{failure}");
            assert_eq!(
                detail.wait_http_status,
                if failure == "wait_timeout" {
                    None
                } else {
                    Some(if failure == "wait_http" { 500 } else { 200 })
                },
                "{failure}"
            );
            assert_eq!(
                detail.helper_exit,
                match failure {
                    "malformed_wait" | "unknown_exit" | "wait_http" | "wait_timeout" => None,
                    "engine_error" => Some(0),
                    _ => Some(1),
                },
                "{failure}"
            );
            let expected_diagnostic = match failure {
                "logs_http" => "http_failed",
                "oversize" => "transport_or_bound_failed",
                "truncated" => "truncated",
                "unknown_output" => "unrecognized",
                "logs_timeout" => "timeout",
                "wait_timeout" => "budget_exhausted",
                "stdout_diagnostic" => "absent",
                "malformed_logs" => "malformed",
                _ => "available",
            };
            assert_eq!(detail.diagnostic_status, expected_diagnostic, "{failure}");
            if expected_diagnostic == "available" {
                assert_eq!(detail.stage, Some("import"));
                assert_eq!(detail.error_class, Some("io"));
                assert_eq!(detail.errno, Some(13));
            } else {
                assert_eq!(detail.error_class, None);
            }
            let safe = serde_json::to_string(detail).unwrap();
            assert!(!safe.contains("private-body-secret-sentinel"));
            assert!(!error.to_string().contains("private-body-secret-sentinel"));
        } else {
            assert_eq!(result.unwrap(), receipts);
        }
        assert!(expected_receipt_len < MAX_REPAIR_RECEIPT_BYTES);
        {
            let seen = seen.lock().unwrap();
            let create = seen
                .iter()
                .find(|(request, _)| request.contains("/create?"))
                .unwrap();
            let create: Value = serde_json::from_slice(&create.1).unwrap();
            assert_eq!(create["User"], "0:0");
            assert_eq!(create["Tty"], false);
            assert_eq!(create["HostConfig"]["NetworkMode"], "none");
            assert_eq!(create["HostConfig"]["ReadonlyRootfs"], true);
            assert_eq!(create["HostConfig"]["CapDrop"], json!(["ALL"]));
            assert_eq!(create["HostConfig"]["CapAdd"], json!(["SETUID", "SETGID"]));
            assert_eq!(create["Cmd"][0], "opencode-stopped-repair-worker");
            assert!(create["Env"].as_array().unwrap().iter().any(|entry| {
                entry == "OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db"
            }));
            assert!(create.get("Labels").is_none());
            let mounts = create["HostConfig"]["Mounts"].as_array().unwrap();
            let provider = mounts
                .iter()
                .find(|mount| mount["Target"] == "/home/freshell/provider")
                .unwrap();
            assert_eq!(provider["Type"], "volume");
            assert_eq!(provider["Source"], handle.provider_volume_name());
            assert_eq!(provider["ReadOnly"], false);
            let staged = mounts
                .iter()
                .find(|mount| mount["Target"] == "/run/freshell-opencode-transfer")
                .unwrap();
            assert_eq!(staged["ReadOnly"], true);
            if deleted_input {
                for path in [&workspace, &temp.path().join("git-common")] {
                    assert!(mounts.iter().any(|mount| mount["Source"] == json!(path)
                        && mount["Target"] == json!(path)
                        && mount["ReadOnly"] == true));
                }
            }
            let delete = seen
                .iter()
                .find(|(request, _)| request.starts_with("DELETE "))
                .unwrap();
            assert!(delete.0.contains("/containers/freshell-opencode-repair-"));
            if failure == Some("wait_timeout") {
                assert!(
                    seen.iter().all(|(request, _)| !request.contains("/logs?")),
                    "an exhausted operation budget cannot admit another wait"
                );
            } else if failure.is_some() {
                let logs = seen
                    .iter()
                    .position(|(request, _)| request.contains("/logs?stdout=1&stderr=1"))
                    .expect("failed helper stderr must be read before cleanup");
                let delete = seen
                    .iter()
                    .position(|(request, _)| request.starts_with("DELETE "))
                    .unwrap();
                assert!(logs < delete);
            }
        }
        server.abort();
        let _ = server.await;
    }
}

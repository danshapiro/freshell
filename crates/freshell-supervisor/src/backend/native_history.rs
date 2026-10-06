use super::*;
use std::time::Duration;

// Keep the helper output bounded below the history-specific control reply budget.
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPAIR_RECEIPT_BYTES: usize = 64 * 1024;
const OPENCODE_PROVIDER_HOME: &str = "/home/freshell/provider";

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
    let malformed = |message: &str| BackendError::Malformed(message.into());
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let header_end = cursor
            .checked_add(8)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| malformed("Docker repair helper log frame header is truncated"))?;
        let header = &bytes[cursor..header_end];
        if header[0] != 1 || header[1..4] != [0, 0, 0] {
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
        let mounts = docker::terminal_mounts(terminal).map_err(BackendError::InvalidConfig)?;
        let binary = canonical_regular_file(handle.host_binary_path())?;
        let name = format!("freshell-opencode-repair-{}", uuid::Uuid::new_v4());
        let mut create_attempted = false;
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
                json!({"Type":"bind", "Source":mounts.workspace, "Target":mounts.workspace, "ReadOnly":true}),
            ];
            if let Some(git) = &mounts.git_common_dir {
                if !git.starts_with(&mounts.workspace) {
                    docker_mounts
                        .push(json!({"Type":"bind", "Source":git, "Target":git, "ReadOnly":true}));
                }
            }
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
                .map_err(|error| BackendError::Malformed(error.to_string()))?;
            if waited["StatusCode"].as_i64() != Some(0) {
                return Err(BackendError::Unavailable(
                    "stopped OpenCode import or provider-reader check failed".into(),
                ));
            }
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
        let result = tokio::time::timeout(budget, operation)
            .await
            .unwrap_or_else(|_| {
                Err(BackendError::Unavailable(
                    "stopped OpenCode repair helper timed out".into(),
                ))
            });
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
                tracing::warn!(soul_id=%handle.soul_id(), helper=%name, "runtime.stopped_opencode_repair_cleanup_failed");
                return Err(BackendError::Unavailable(
                    "stopped OpenCode repair helper cleanup failed".into(),
                ));
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
            let agent = handle.fresh_agent().ok_or_else(|| {
                BackendError::InvalidConfig("native history requires a fresh agent".into())
            })?;
            let binary = std::fs::canonicalize(reader_binary)
                .map_err(|e| BackendError::Unavailable(e.to_string()))?;
            let body = json!({
                "Image":handle.image_ref(), "User":format!("{}:{}",agent.run_as_uid,agent.run_as_gid), "Tty":true,
                "Entrypoint":["/runtime/freshell-session-host"],
                "Cmd":["native-history-only","--provider",provider,"--session-id",native_id,"--provider-home","/home/freshell/provider"],
                "Env":["HOME=/home/freshell/provider"],
                "HostConfig": {"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],
                    "SecurityOpt":["no-new-privileges"],"Memory":256*1024*1024,"MemorySwap":256*1024*1024,
                    "NanoCpus":500_000_000,"PidsLimit":32,"Tmpfs":{"/tmp":"rw,noexec,nosuid,nodev,size=16m"},
                    "Mounts":[{"Type":"bind","Source":binary,"Target":"/runtime/freshell-session-host","ReadOnly":true},
                        {"Type":"volume","Source":handle.provider_volume_name(),"Target":"/home/freshell/provider","ReadOnly":true}]}
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
                let cause = std::str::from_utf8(&logs.body)
                    .ok()
                    .into_iter()
                    .flat_map(str::lines)
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
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
            serde_json::from_slice::<Value>(&logs.body)
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
            "failed_exit",
            "bad_output",
            "timeout",
            "failed_cleanup",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let socket = temp.path().join("docker.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let daemon = DockerDaemonId::new();
            let expected_daemon = daemon.clone();
            let binary = temp.path().join("reader");
            std::fs::write(&binary, "fixture binary").unwrap();
            let agent: FreshAgentLaunchSpec = serde_json::from_value(json!({
                "sessionId":"presentation-alias","provider":"opencode","sessionType":"freshopencode",
                "runtimeVariant":"opencode","providerStoreId":"store","cwd":"/workspace","workspacePath":"/workspace",
                "runAsUid":65534,"runAsGid":0,"nativeSessionId":"ses_saved"
            })).unwrap();
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
                None,
                None,
                Some(agent),
                "owned-native-volume".into(),
            );
            let seen = Arc::new(Mutex::new(Vec::new()));
            let captured = seen.clone();
            let server = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let seen = captured.clone();
                    let daemon = expected_daemon.clone();
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
                                json!({"StatusCode": if mode == "failed_exit" {1} else {0}})
                                    .to_string(),
                            )
                        } else if request.contains("/logs?") {
                            (
                                200,
                                if mode == "bad_output" {
                                    "invalid".into()
                                } else if mode == "failed_exit" {
                                    json!({"event":"session_host.fatal","error":"saved native session not found"}).to_string()
                                } else {
                                    json!({"threadId":"ses_saved","provider":"opencode","turns":[]})
                                        .to_string()
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
                        let response = format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                    });
                }
            });
            let result = DockerEngineBackend::new(&socket)
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
                .await;
            assert_eq!(result.is_ok(), mode == "success", "{mode}: {result:?}");
            if mode == "failed_exit" {
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
                assert_eq!(create["User"], "65534:0");
                assert_eq!(create["HostConfig"]["NetworkMode"], "none");
                assert_eq!(create["HostConfig"]["Mounts"].as_array().unwrap().len(), 2);
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
    }

    #[tokio::test]
    async fn stopped_repair_uses_a_no_tty_identity_helper_with_only_uid_gid_capabilities() {
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
        let terminal: TerminalLaunchSpec = serde_json::from_value(json!({
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
        let expected_receipts_frame = docker_stdout_frame(&expected_receipts);
        let seen = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
        let captured = Arc::clone(&seen);
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let seen = Arc::clone(&captured);
                let daemon = expected_daemon.clone();
                let body = expected_receipts_frame.clone();
                tokio::spawn(async move {
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
                        (
                            200,
                            json!({"StatusCode":0}).to_string().into_bytes(),
                            "application/json",
                        )
                    } else if request.contains("/logs?") {
                        (200, body, "application/vnd.docker.raw-stream")
                    } else if request.starts_with("DELETE ") {
                        (204, Vec::new(), "application/json")
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
        let result = backend
            .repair_stopped_opencode_helper(&handle, &descriptor, &stage, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(result, receipts);
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
            assert_eq!(provider["ReadOnly"], false);
            let staged = mounts
                .iter()
                .find(|mount| mount["Target"] == "/run/freshell-opencode-transfer")
                .unwrap();
            assert_eq!(staged["ReadOnly"], true);
            let delete = seen
                .iter()
                .find(|(request, _)| request.starts_with("DELETE "))
                .unwrap();
            assert!(delete.0.contains("/containers/freshell-opencode-repair-"));
        }
        server.abort();
        let _ = server.await;
    }
}

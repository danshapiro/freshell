use super::*;
use std::time::Duration;

// Keep the helper output bounded below the history-specific control reply budget.
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

impl DockerEngineBackend {
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
}

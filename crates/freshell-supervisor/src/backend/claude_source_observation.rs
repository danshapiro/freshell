//! Fixed Claude reader in the owned provider namespace; metadata uses private
//! IPC. Helper cleanup never stops a provider workload or creates its HOME.
use super::*;
use freshell_platform::claude_inputs::observation::{
    ObservationReply, MAX_REPLY_BYTES, MAX_REQUEST_BYTES,
};
use freshell_runtime_protocol::ObserveClaudeSourcesRequest;
use std::time::Duration;
use tokio::net::UnixListener;

fn fail(reason: &'static str) -> BackendError {
    BackendError::Unavailable(reason.into())
}

fn owned_helper(actual: &Value, expected: &Value) -> bool {
    input_publisher::owned_helper(actual, expected)
        && actual["Config"]["WorkingDir"] == expected["WorkingDir"]
        && [
            "NetworkMode",
            "ReadonlyRootfs",
            "CapDrop",
            "SecurityOpt",
            "Memory",
            "MemorySwap",
            "NanoCpus",
            "PidsLimit",
            "Tmpfs",
        ]
        .iter()
        .all(|key| actual["HostConfig"][key] == expected["HostConfig"][key])
        && actual["HostConfig"]["CapAdd"]
            .as_array()
            .is_none_or(|caps| caps.is_empty())
}

async fn exchange(listener: &UnixListener, raw: &[u8]) -> Result<ObservationReply, BackendError> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|_| fail("Claude source exchange unavailable"))?;
    stream
        .write_u32(raw.len() as u32)
        .await
        .map_err(|_| fail("Claude source request unavailable"))?;
    stream
        .write_all(raw)
        .await
        .map_err(|_| fail("Claude source request incomplete"))?;
    let length = stream
        .read_u32()
        .await
        .map_err(|_| fail("Claude source reply unavailable"))? as usize;
    if length > MAX_REPLY_BYTES {
        return Err(fail("Claude source metadata reply exceeds profile"));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| fail("Claude source metadata allocation unavailable"))?;
    bytes.resize(length, 0);
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| fail("Claude source metadata reply incomplete"))?;
    let mut trailing = [0];
    if stream
        .read(&mut trailing)
        .await
        .map_err(|_| fail("Claude source reply completion unavailable"))?
        != 0
    {
        return Err(fail("Claude source helper emitted extra metadata"));
    }
    serde_json::from_slice(&bytes).map_err(|_| fail("Claude source metadata reply invalid"))
}

impl DockerEngineBackend {
    pub(super) async fn read_claude_source_helper(
        &self,
        owner: &ClaudeSourceOwner,
        request: &ObserveClaudeSourcesRequest,
        test_run_id: &str,
        budget: Duration,
    ) -> Result<ObservationReply, BackendError> {
        request
            .validate()
            .map_err(|_| fail("Claude source request invalid"))?;
        if request.candidate.is_some() {
            return Err(fail("Claude candidate source topology is not yet qualified; retain inputs and reprepare"));
        }
        let name = format!("freshell-claude-source-{}", uuid::Uuid::new_v4());
        let mut attempted = false;
        let mut expected = None::<Value>;
        let mut directory = None::<native_auth::ExchangeDirectory>;
        let operation = async {
            let (daemon, rootless) = self
                .daemon_info()
                .await
                .map_err(|_| fail("Claude source daemon unavailable"))?;
            if !rootless {
                return Err(fail(
                    "Claude source reader requires the qualified rootless daemon",
                ));
            }
            let (installation, soul, image, binary, retained) = match owner {
                ClaudeSourceOwner::Initial {
                    reservation,
                    observation,
                } => {
                    if reservation.provider != request.provider
                        || self.observe_initial_volume(reservation).await? != *observation
                    {
                        return Err(fail("Claude source creation absence changed"));
                    }
                    (
                        &reservation.installation_id,
                        &reservation.soul_id,
                        reservation.image_ref.as_str(),
                        reservation.binary.as_path(),
                        None,
                    )
                }
                ClaudeSourceOwner::Retained { handle } => {
                    let provider = handle
                        .terminal()
                        .map(|spec| spec.mode.as_str())
                        .or_else(|| handle.fresh_agent().map(|spec| spec.provider.as_str()));
                    let workspace = handle
                        .terminal()
                        .map(|spec| spec.workspace_path.as_str())
                        .or_else(|| {
                            handle
                                .fresh_agent()
                                .map(|spec| spec.workspace_path.as_str())
                        });
                    if provider != Some(request.provider.as_str())
                        || workspace != Some(request.workspace_path.as_str())
                        || handle.daemon_id() != &daemon
                        || !matches!(
                            self.inspect(handle).await?.state,
                            BackendRuntimeState::Created
                                | BackendRuntimeState::Exited
                                | BackendRuntimeState::Dead
                                | BackendRuntimeState::Missing
                        )
                    {
                        return Err(fail(
                            "Claude source requires its exact quiescent retained owner",
                        ));
                    }
                    let response = self
                        .request_bounded(
                            "GET",
                            &format!("{DOCKER_API}/volumes/{}", handle.provider_volume_name()),
                            None,
                            64 * 1024,
                        )
                        .await?;
                    let volume: Value = serde_json::from_slice(&response.body)
                        .map_err(|_| fail("Claude retained HOME metadata invalid"))?;
                    if response.status != 200
                        || volume["Name"] != handle.provider_volume_name()
                        || volume["Driver"] != "local"
                    {
                        return Err(fail("Claude retained HOME is unavailable; preserve native stores and repair the source"));
                    }
                    (
                        handle.installation_id(),
                        handle.soul_id(),
                        handle.image_ref(),
                        handle.host_binary_path(),
                        Some(handle.provider_volume_name()),
                    )
                }
            };
            if soul != &request.soul_id {
                return Err(fail("Claude source soul ownership changed"));
            }
            let binary = canonical_regular_file(binary)
                .map_err(|_| fail("Claude source reader artifact unavailable"))?;
            let digest = crate::registry::binary_digest(&binary)
                .map_err(|_| fail("Claude source reader artifact changed"))?;
            if let ClaudeSourceOwner::Initial { reservation, .. } = owner {
                if digest != reservation.binary_sha256 {
                    return Err(fail("Claude reserved reader artifact changed"));
                }
            }
            let workspace = canonical_dir(Path::new(&request.workspace_path))
                .map_err(|_| fail("Claude source workspace unavailable"))?;
            let cwd = canonical_dir(&request.observation_request.cwd)
                .map_err(|_| fail("Claude source native cwd unavailable"))?;
            if workspace != Path::new(&request.workspace_path)
                || cwd != request.observation_request.cwd
                || !cwd.starts_with(&workspace)
            {
                return Err(fail("Claude source workload topology changed"));
            }
            let common = request
                .git_common_dir
                .as_deref()
                .map(|path| {
                    let canonical = canonical_dir(Path::new(path))
                        .map_err(|_| fail("Claude source Git common directory unavailable"))?;
                    if canonical != Path::new(path) {
                        return Err(fail("Claude source Git common topology changed"));
                    }
                    Ok(canonical)
                })
                .transpose()?;
            directory = Some(native_auth::ExchangeDirectory::create_input()?);
            let directory = directory.as_ref().unwrap();
            let socket = directory.0.join("reply.sock");
            let listener = UnixListener::bind(&socket)
                .map_err(|_| fail("Claude source private exchange bind failed"))?;
            directory.mode(&socket, 0o660)?;
            let mut mounts = vec![
                json!({"Type":"bind","Source":binary,"Target":"/runtime/freshell-session-host","ReadOnly":true}),
                json!({"Type":"bind","Source":workspace,"Target":workspace,"ReadOnly":true}),
                json!({"Type":"bind","Source":directory.0,"Target":"/run/freshell-source-exchange","ReadOnly":true}),
            ];
            if let Some(common) = common.filter(|common| !common.starts_with(&workspace)) {
                mounts.push(json!({"Type":"bind","Source":common,"Target":common,"ReadOnly":true}));
            }
            let tmpfs = if let Some(volume) = retained {
                mounts.push(json!({"Type":"volume","Source":volume,"Target":"/home/freshell/provider","ReadOnly":true,"VolumeOptions":{"NoCopy":true}}));
                json!({})
            } else {
                json!({"/home/freshell/provider":"rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=0,mode=0700"})
            };
            let body = json!({
                "Image":image,"User":"65534:0","Tty":false,"WorkingDir":cwd,
                "Entrypoint":["/runtime/freshell-session-host"],"Cmd":["observe-claude-sources-private"],
                "Labels":{"com.freshell.installation-id":installation,"com.freshell.soul-id":soul,
                    "com.freshell.runtime-test-run-id":test_run_id,"com.freshell.source-request-id":request.observation_request.request_id,
                    "com.freshell.source-binary-sha256":digest},
                "Env":self.private_helper_environment(image,&["HOME=/home/freshell/provider"]).await?,
                "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
                    "Memory":256*1024*1024,"MemorySwap":256*1024*1024,"NanoCpus":500_000_000,"PidsLimit":32,
                    "LogConfig":{"Type":"none","Config":{}},"Tmpfs":tmpfs,"Mounts":mounts}
            });
            let raw = freshell_runtime_protocol::bounded_json_bytes(
                &request.observation_request,
                MAX_REQUEST_BYTES,
            )
            .map_err(|_| fail("Claude source request exceeds metadata profile"))?;
            expected = Some(body.clone());
            attempted = true;
            let created = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/create?name={name}"),
                    Some(&body),
                    64 * 1024,
                )
                .await
                .map_err(|_| fail("Claude source helper creation acknowledgement unavailable"))?;
            if created.status == 409 {
                attempted = false;
            }
            if created.status != 201 {
                return Err(fail("Claude source helper creation failed"));
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|_| fail("Claude source helper creation invalid"))?;
            let id = created["Id"]
                .as_str()
                .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| fail("Claude source helper identity unavailable"))?;
            let inspected = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/containers/{id}/json"),
                    None,
                    1024 * 1024,
                )
                .await?;
            let actual: Value = serde_json::from_slice(&inspected.body)
                .map_err(|_| fail("Claude source helper ownership invalid"))?;
            if inspected.status != 200
                || actual["Id"] != id
                || !owned_helper(&actual, &body)
                || actual["State"]["Running"] != false
            {
                return Err(fail(
                    "Claude source helper namespace/topology ownership changed",
                ));
            }
            let supervision = async {
                let started = self
                    .request_bounded(
                        "POST",
                        &format!("{DOCKER_API}/containers/{id}/start"),
                        None,
                        64 * 1024,
                    )
                    .await?;
                if started.status != 204 {
                    return Err(fail("Claude source helper start failed"));
                }
                let waited = self
                    .request_bounded(
                        "POST",
                        &format!("{DOCKER_API}/containers/{id}/wait?condition=not-running"),
                        None,
                        64 * 1024,
                    )
                    .await?;
                let value: Value = serde_json::from_slice(&waited.body)
                    .map_err(|_| fail("Claude source helper completion invalid"))?;
                if waited.status != 200 || value["StatusCode"] != 0 {
                    return Err(fail(
                        "Claude source helper did not return complete evidence",
                    ));
                }
                Ok::<_, BackendError>(())
            };
            let (reply, ()) = tokio::try_join!(exchange(&listener, &raw), supervision)?;
            reply
                .validate_for_request(
                    &request.observation_request,
                    &format!("{:x}", Sha256::digest(&raw)),
                )
                .map_err(|_| fail("Claude source reply selection binding changed"))?;
            if (
                reply.observation.uid,
                reply.observation.euid,
                reply.observation.gid,
                reply.observation.egid,
            ) != (65534, 65534, 0, 0)
            {
                return Err(fail("Claude source native reader identity changed"));
            }
            if self.daemon_id().await? != daemon
                || crate::registry::binary_digest(&binary)
                    .map_err(|_| fail("Claude source reader artifact unavailable"))?
                    != digest
            {
                return Err(fail("Claude source daemon or reader artifact changed"));
            }
            if let ClaudeSourceOwner::Initial {
                reservation,
                observation,
            } = owner
            {
                if self.observe_initial_volume(reservation).await? != *observation {
                    return Err(fail("Claude source initial HOME presence changed"));
                }
            }
            Ok(reply)
        };
        let result = tokio::time::timeout(budget, operation)
            .await
            .unwrap_or_else(|_| {
                Err(fail(
                    "Claude source helper timed out; retain inputs and reprepare",
                ))
            });
        if attempted {
            let cleanup = async {
                let inspection = self
                    .request_bounded(
                        "GET",
                        &format!("{DOCKER_API}/containers/{name}/json"),
                        None,
                        1024 * 1024,
                    )
                    .await?;
                if inspection.status == 404 {
                    return Ok(());
                }
                let actual: Value = serde_json::from_slice(&inspection.body)
                    .map_err(|_| fail("Claude source cleanup ownership invalid"))?;
                if inspection.status != 200
                    || !expected
                        .as_ref()
                        .is_some_and(|expected| owned_helper(&actual, expected))
                {
                    return Err(fail(
                        "Claude source cleanup ownership changed; no provider workload was stopped",
                    ));
                }
                let removed = self
                    .request_bounded(
                        "DELETE",
                        &format!("{DOCKER_API}/containers/{name}?force=1"),
                        None,
                        64 * 1024,
                    )
                    .await?;
                if !matches!(removed.status, 204 | 404) {
                    return Err(fail("Claude source helper cleanup failed"));
                }
                let absent = self
                    .request_bounded(
                        "GET",
                        &format!("{DOCKER_API}/containers/{name}/json"),
                        None,
                        64 * 1024,
                    )
                    .await?;
                if absent.status != 404 {
                    return Err(fail("Claude source helper cleanup not confirmed"));
                }
                Ok(())
            };
            tokio::time::timeout(Duration::from_secs(5), cleanup)
                .await
                .map_err(|_| fail("Claude source helper cleanup timed out"))??;
        }
        tracing::debug!(event="provider.inputs.native_source_helper.settled",soul_id=%request.soul_id,helper=%name,succeeded=result.is_ok(),
            "Claude source helper settled after owned cleanup");
        result
    }
}

#[cfg(test)]
#[path = "claude_source_observation_tests.rs"]
mod tests;

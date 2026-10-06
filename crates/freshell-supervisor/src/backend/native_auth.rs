//! Exact owned, quiescent soul auth lookup. Docker never carries reply values.
use super::*;
use std::time::Duration;
use tokio::net::UnixListener;

fn fail(cause: &'static str) -> BackendError {
    BackendError::Unavailable(cause.into())
}

pub(super) struct ExchangeDirectory(pub(super) PathBuf);
impl ExchangeDirectory {
    fn create() -> Result<Self, BackendError> {
        Self::create_owned("freshell-auth")
    }
    pub(super) fn create_input() -> Result<Self, BackendError> {
        Self::create_owned("freshell-inputs")
    }
    fn create_owned(prefix: &str) -> Result<Self, BackendError> {
        use std::os::unix::ffi::OsStrExt;
        // Deliberately short regardless of runtime_root length (Linux sun_path).
        let path = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        if path.join("reply.sock").as_os_str().as_bytes().len() > 107 {
            return Err(fail("native auth exchange path exceeds limit"));
        }
        std::fs::create_dir(&path).map_err(|_| fail("native auth exchange creation failed"))?;
        let owned = Self(path);
        owned.mode(&owned.0, 0o710)?;
        Ok(owned)
    }
    pub(super) fn mode(&self, path: &Path, mode: u32) -> Result<(), BackendError> {
        use std::os::unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        };
        let name = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| fail("native auth exchange path is invalid"))?;
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        // Rootless namespace group 0 is the controller's primary group.
        if unsafe { libc::lchown(name.as_ptr(), uid, gid) } != 0 {
            return Err(fail("native auth mapped group is unavailable"));
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|_| fail("native auth exchange permission failed"))?;
        let meta = std::fs::symlink_metadata(path)
            .map_err(|_| fail("native auth exchange verification failed"))?;
        if meta.uid() != uid || meta.gid() != gid || meta.mode() & 0o777 != mode {
            return Err(fail("native auth exchange ownership changed"));
        }
        Ok(())
    }
}
impl Drop for ExchangeDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.join("reply.sock"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

async fn exchange(
    listener: &UnixListener,
    keys: &[String],
) -> Result<BTreeMap<String, String>, BackendError> {
    use freshell_platform::native_auth_exchange::{validate_selected, MAX_AUTH_FRAME};
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|_| fail("native auth exchange accept failed"))?;
    let request = serde_json::to_vec(keys).map_err(|_| fail("native auth request invalid"))?;
    if request.len() > 32 * 1024 {
        return Err(fail("native auth request exceeds limit"));
    }
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .await
        .map_err(|_| fail("native auth request failed"))?;
    stream
        .write_all(&request)
        .await
        .map_err(|_| fail("native auth request failed"))?;
    let length = stream
        .read_u32()
        .await
        .map_err(|_| fail("native auth reply unavailable"))? as usize;
    if length > MAX_AUTH_FRAME {
        return Err(fail("native auth reply exceeds limit"));
    }
    let mut reply = vec![0; length];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|_| fail("native auth reply unavailable"))?;
    let values = serde_json::from_slice(&reply).map_err(|_| fail("native auth reply invalid"))?;
    validate_selected(keys, &values).map_err(fail)?;
    Ok(values)
}

impl DockerEngineBackend {
    pub(super) async fn ensure_reserved_initial_volume(
        &self,
        spec: &CreateRuntimeSpec,
        daemon: &DockerDaemonId,
        rootless: bool,
    ) -> Result<(), BackendError> {
        let Some(bound) = &spec.initial_input_reservation else {
            return Ok(());
        };
        let reservation = &bound.reservation;
        let freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
            daemon_id: observed,
        } = &bound.observation;
        if !rootless
            || observed != daemon
            || reservation.installation_id != spec.installation_id
            || reservation.soul_id != spec.soul_id
            || bound.incarnation_id != spec.incarnation_id
            || reservation.image_ref != spec.image_ref
            || reservation.binary != spec.host_binary_path
            || reservation.provider_volume_name != spec.provider_volume_name
            || spec.provider_volume_name
                != crate::registry::stable_provider_volume_name(
                    &spec.installation_id,
                    &spec.soul_id,
                )
        {
            return Err(fail(
                "initial auth reservation does not match the prepared runtime",
            ));
        }
        bound
            .verify_artifact()
            .map_err(|_| fail("initial auth reserved runtime artifact changed or unreadable"))?;
        let labels = json!({
            "com.freshell.installation-id":spec.installation_id.as_str(),
            "com.freshell.soul-id":spec.soul_id.as_str(),
            "freshell.input.reservation":reservation.id,
            "freshell.input.incarnation":spec.incarnation_id.as_str(),
            "freshell.input.intent":"1",
            "freshell.input.daemon":daemon.as_str(),
            "freshell.input.image":reservation.image_ref,
            "freshell.input.binary-sha256":reservation.binary_sha256
        });
        let path = format!("{DOCKER_API}/volumes/{}", spec.provider_volume_name);
        let response = self
            .request_bounded("GET", &path, None, 64 * 1024)
            .await
            .map_err(|_| fail("reserved initial volume observation failed"))?;
        if response.status == 404 {
            if self
                .daemon_id()
                .await
                .map_err(|_| fail("initial auth daemon revalidation failed"))?
                != *daemon
            {
                return Err(fail(
                    "initial auth source daemon changed before volume creation",
                ));
            }
            let created=self.request_bounded("POST",&format!("{DOCKER_API}/volumes/create"),Some(&json!({
                "Name":spec.provider_volume_name,"Driver":"local","Labels":labels
            })),64*1024).await.map_err(|_|fail("reserved initial volume create acknowledgement uncertain; retry the same bound launch"))?;
            if created.status != 201 {
                return Err(fail(
                    "reserved initial volume creation failed; retry the same bound launch",
                ));
            }
        } else if response.status != 200 {
            return Err(fail(
                "reserved initial volume observation did not prove absence or ownership",
            ));
        }
        // Docker volume-create is idempotent by name; its acknowledgement alone
        // cannot establish that a pre-existing object belongs to this receipt.
        let readback = self
            .request_bounded("GET", &path, None, 64 * 1024)
            .await
            .map_err(|_| fail("reserved initial volume ownership readback failed"))?;
        let value: Value = serde_json::from_slice(&readback.body)
            .map_err(|_| fail("reserved initial volume ownership response invalid"))?;
        if readback.status != 200
            || value["Name"] != spec.provider_volume_name
            || value["Driver"] != "local"
            || value["Labels"] != labels
            || !(value["Options"].is_null() || value["Options"] == json!({}))
        {
            return Err(fail(
                "reserved initial volume belongs to a different preparation",
            ));
        }
        if self
            .daemon_id()
            .await
            .map_err(|_| fail("initial auth daemon final observation failed"))?
            != *daemon
        {
            return Err(fail(
                "initial auth source daemon changed after volume creation",
            ));
        }
        Ok(())
    }
    pub(super) async fn observe_initial_volume(
        &self,
        reservation: &crate::registry::OwnedInputReservation,
    ) -> Result<freshell_runtime_protocol::InitialAuthVolumeObservation, BackendError> {
        let (daemon_id, rootless) = self
            .daemon_info()
            .await
            .map_err(|_| fail("initial auth daemon observation failed"))?;
        if !rootless {
            return Err(fail(
                "initial auth source requires the qualified rootless daemon",
            ));
        }
        if reservation.provider_volume_name
            != crate::registry::stable_provider_volume_name(
                &reservation.installation_id,
                &reservation.soul_id,
            )
        {
            return Err(fail("initial auth reservation volume identity changed"));
        }
        let response = self
            .request_bounded(
                "GET",
                &format!("{DOCKER_API}/volumes/{}", reservation.provider_volume_name),
                None,
                64 * 1024,
            )
            .await
            .map_err(|_| fail("initial auth reserved volume observation failed"))?;
        if response.status != 404 {
            return Err(fail("initial auth absence requires an actual reserved-volume 404; use an owned existing source"));
        }
        if self
            .daemon_id()
            .await
            .map_err(|_| fail("initial auth daemon revalidation failed"))?
            != daemon_id
        {
            return Err(fail("initial auth source daemon changed"));
        }
        Ok(freshell_runtime_protocol::InitialAuthVolumeObservation::Absent { daemon_id })
    }
    pub(super) async fn read_auth_helper(
        &self,
        handle: &OwnedRuntimeHandle,
        keys: &[String],
        binary: &Path,
        budget: Duration,
    ) -> Result<BTreeMap<String, String>, BackendError> {
        freshell_platform::native_auth_exchange::validate_keys(keys).map_err(fail)?;
        let provider = handle
            .terminal()
            .map(|spec| spec.mode.as_str())
            .or_else(|| handle.fresh_agent().map(|spec| spec.provider.as_str()));
        let identity = handle
            .terminal()
            .map(|spec| (spec.run_as_uid, spec.run_as_gid))
            .or_else(|| {
                handle
                    .fresh_agent()
                    .map(|spec| (spec.run_as_uid, spec.run_as_gid))
            });
        if provider != Some("opencode") || identity != Some((65534, 0)) {
            return Err(fail("native auth source is not an owned OpenCode provider"));
        }
        let name = format!("freshell-auth-{}", uuid::Uuid::new_v4());
        let mut create_attempted = false;
        let mut expected = None::<Value>;
        let mut directory = None::<ExchangeDirectory>;
        let operation = async {
            let inspection = self
                .inspect(handle)
                .await
                .map_err(|_| fail("native auth owned source inspection failed"))?;
            if !matches!(
                inspection.state,
                BackendRuntimeState::Created
                    | BackendRuntimeState::Exited
                    | BackendRuntimeState::Dead
                    | BackendRuntimeState::Missing
            ) {
                return Err(fail("native auth requires a quiescent owned soul"));
            }
            let volume = self
                .request(
                    "GET",
                    &format!("{DOCKER_API}/volumes/{}", handle.provider_volume_name()),
                    None,
                )
                .await
                .map_err(|_| fail("native auth volume inspection failed"))?;
            if volume.status != 200 {
                return Err(fail("native auth expected owned volume is unavailable"));
            }
            let volume: Value = serde_json::from_slice(&volume.body)
                .map_err(|_| fail("native auth volume inspection invalid"))?;
            if volume["Name"].as_str() != Some(handle.provider_volume_name()) {
                return Err(fail("native auth volume ownership changed"));
            }
            let binary = canonical_regular_file(binary)
                .map_err(|_| fail("native auth reader binary unavailable"))?;
            directory = Some(ExchangeDirectory::create()?);
            let directory = directory.as_ref().unwrap();
            let socket = directory.0.join("reply.sock");
            let listener = UnixListener::bind(&socket)
                .map_err(|_| fail("native auth exchange bind failed"))?;
            directory.mode(&socket, 0o660)?;
            let helper_env = self
                .private_helper_environment(handle.image_ref(), &["HOME=/home/freshell/provider"])
                .await?;
            let body = json!({
                "Image":handle.image_ref(),"User":"65534:0","Tty":false,
                "Entrypoint":["/runtime/freshell-session-host"],"Cmd":["native-auth-only"],"Env":helper_env,
                "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
                    "Memory":256*1024*1024,"MemorySwap":256*1024*1024,"NanoCpus":500_000_000,"PidsLimit":32,
                    "LogConfig":{"Type":"none","Config":{}},
                    "Mounts":[{"Type":"bind","Source":binary,"Target":"/runtime/freshell-session-host","ReadOnly":true},
                        {"Type":"volume","Source":handle.provider_volume_name(),"Target":"/home/freshell/provider","ReadOnly":true,"VolumeOptions":{"NoCopy":true}},
                        {"Type":"bind","Source":directory.0,"Target":"/run/freshell-auth-exchange","ReadOnly":true}]}
            });
            expected = Some(body.clone());
            create_attempted = true;
            let created = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/create?name={name}"),
                    Some(&body),
                    64 * 1024,
                )
                .await
                .map_err(|_| fail("native auth helper creation acknowledgement unavailable"))?;
            if created.status == 409 {
                create_attempted = false;
            }
            if created.status != 201 {
                return Err(fail("native auth helper creation failed"));
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|_| fail("native auth helper creation invalid"))?;
            let id = created["Id"]
                .as_str()
                .ok_or_else(|| fail("native auth helper identity unavailable"))?;
            let supervision = async {
                let started = self
                    .request("POST", &format!("{DOCKER_API}/containers/{id}/start"), None)
                    .await
                    .map_err(|_| fail("native auth helper start failed"))?;
                if started.status != 204 {
                    return Err(fail("native auth helper start failed"));
                }
                let waited = self
                    .request_bounded(
                        "POST",
                        &format!("{DOCKER_API}/containers/{id}/wait?condition=not-running"),
                        None,
                        64 * 1024,
                    )
                    .await
                    .map_err(|_| fail("native auth helper wait failed"))?;
                if waited.status != 200 {
                    return Err(fail("native auth helper wait failed"));
                }
                let waited: Value = serde_json::from_slice(&waited.body)
                    .map_err(|_| fail("native auth helper wait invalid"))?;
                if waited["StatusCode"].as_i64() != Some(0) {
                    return Err(fail("native auth helper failed"));
                }
                Ok(())
            };
            let (values, ()) = tokio::try_join!(exchange(&listener, keys), supervision)?;
            Ok(values)
        };
        let result = tokio::time::timeout(budget, operation)
            .await
            .unwrap_or_else(|_| Err(fail("native auth lookup timed out")));
        if create_attempted {
            let cleanup = async {
                let inspected = self
                    .request_bounded(
                        "GET",
                        &format!("{DOCKER_API}/containers/{name}/json"),
                        None,
                        1024 * 1024,
                    )
                    .await
                    .map_err(|_| fail("native auth cleanup inspection failed"))?;
                if inspected.status == 404 {
                    return Ok(());
                }
                if inspected.status != 200 {
                    return Err(fail("native auth cleanup inspection failed"));
                }
                let actual: Value = serde_json::from_slice(&inspected.body)
                    .map_err(|_| fail("native auth cleanup inspection invalid"))?;
                let expected = expected
                    .as_ref()
                    .ok_or_else(|| fail("native auth cleanup authority unavailable"))?;
                if !input_publisher::owned_helper(&actual, expected) {
                    return Err(fail("native auth cleanup ownership changed"));
                }
                let deleted = self
                    .request(
                        "DELETE",
                        &format!("{DOCKER_API}/containers/{name}?force=1"),
                        None,
                    )
                    .await
                    .map_err(|_| fail("native auth cleanup failed"))?;
                if deleted.status != 204 && deleted.status != 404 {
                    return Err(fail("native auth cleanup failed"));
                }
                Ok(())
            };
            tokio::time::timeout(Duration::from_secs(5), cleanup)
                .await
                .map_err(|_| fail("native auth cleanup timed out"))??;
        }
        tracing::debug!(soul_id=%handle.soul_id(),helper=%name,succeeded=result.is_ok(),"runtime.native_auth_lookup_settled");
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::LaunchNonce;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn provider_initial_absence_requires_rootless_same_daemon_exact_volume_404() {
        for mode in [
            "absent",
            "existing",
            "denied",
            "server_error",
            "nonrootless",
            "daemon_changed",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let binary = temp.path().join("synthetic-host");
            std::fs::write(&binary, b"synthetic artifact").unwrap();
            let registry =
                crate::registry::Registry::open(temp.path().join("registry"), None).unwrap();
            let reserved = registry
                .reserve_initial_inputs(
                    freshell_runtime_protocol::ReserveProviderInputsRequest {
                        expected_control_epoch: Some(registry.control_epoch()),
                        soul_id: SoulId::new(),
                        provider: "opencode".into(),
                        creation_seed_ref: "seed".into(),
                    },
                    format!("sha256:{}", "a".repeat(64)),
                    binary,
                )
                .await
                .unwrap();
            let daemon = DockerDaemonId::new();
            let changed = DockerDaemonId::new();
            let listener = UnixListener::bind(temp.path().join("docker.sock")).unwrap();
            let requests = Arc::new(Mutex::new(Vec::<String>::new()));
            let seen = requests.clone();
            let server = tokio::spawn(async move {
                let mut observations = 0;
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut raw = Vec::new();
                    let mut byte = [0];
                    while !raw.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).await.unwrap();
                        raw.push(byte[0]);
                    }
                    let head = String::from_utf8(raw).unwrap();
                    let request = head.lines().next().unwrap().to_owned();
                    seen.lock().unwrap().push(request.clone());
                    let (status, body) = if request.contains("/info ") {
                        observations += 1;
                        (
                            200,
                            json!({"ID":if mode=="daemon_changed" && observations>1 {&changed} else {&daemon},
                            "SecurityOptions":if mode=="nonrootless" {vec![]} else {vec!["name=rootless"]}}),
                        )
                    } else if request.starts_with("GET") && request.contains("/volumes/") {
                        (
                            match mode {
                                "existing" => 200,
                                "denied" => 403,
                                "server_error" => 500,
                                _ => 404,
                            },
                            json!({}),
                        )
                    } else {
                        (500, json!({}))
                    };
                    let body = body.to_string();
                    stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                }
            });
            let result = DockerEngineBackend::new(temp.path().join("docker.sock"))
                .observe_initial_volume(&reserved)
                .await;
            assert_eq!(result.is_ok(), mode == "absent", "{mode}");
            let seen = requests.lock().unwrap().clone();
            assert!(
                seen.iter().all(|r| r.starts_with("GET ")),
                "absence observation must not create a helper, volume or workload"
            );
            assert!(seen
                .iter()
                .filter(|r| r.contains("/volumes/"))
                .all(|r| r.contains(&format!("/volumes/{} ", reserved.provider_volume_name))));
            drop(seen);
            server.abort();
            let _ = server.await;
        }
    }

    #[tokio::test]
    async fn provider_initial_volume_is_labelled_once_and_reused_only_by_bound_launch() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("synthetic-host");
        std::fs::write(&binary, b"synthetic executable artifact").unwrap();
        let runtime = temp.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        let registry = crate::registry::Registry::open(temp.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let image = format!("sha256:{}", "a".repeat(64));
        let reserved = registry
            .reserve_initial_inputs(
                freshell_runtime_protocol::ReserveProviderInputsRequest {
                    expected_control_epoch: Some(registry.control_epoch()),
                    soul_id: soul.clone(),
                    provider: "opencode".into(),
                    creation_seed_ref: "seed".into(),
                },
                image.clone(),
                binary.clone(),
            )
            .await
            .unwrap();
        let daemon = DockerDaemonId::new();
        let binding = crate::registry::BoundInputReservation {
            reservation: reserved,
            incarnation_id: IncarnationId::new(),
            observation: freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
                daemon_id: daemon.clone(),
            },
        };
        let volume = Arc::new(Mutex::new(None::<Value>));
        let lose_create_ack = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let listener = UnixListener::bind(temp.path().join("docker.sock")).unwrap();
        let captured = volume.clone();
        let seen = requests.clone();
        let lose_ack = lose_create_ack.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
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
                    .unwrap()
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let request = head.lines().next().unwrap().to_string();
                seen.lock().unwrap().push(request.clone());
                let (status, reply) = if request.contains("/info ") {
                    (
                        200,
                        json!({"ID":daemon,"SecurityOptions":["name=rootless"]}),
                    )
                } else if request.starts_with("POST") && request.contains("/volumes/create ") {
                    let mut created: Value = serde_json::from_slice(&body).unwrap();
                    created["Driver"] = json!("local");
                    created["Options"] = json!({});
                    *captured.lock().unwrap() = Some(created.clone());
                    (
                        if lose_ack.swap(false, std::sync::atomic::Ordering::SeqCst) {
                            503
                        } else {
                            201
                        },
                        created,
                    )
                } else if request.starts_with("GET") && request.contains("/volumes/") {
                    match captured.lock().unwrap().clone() {
                        Some(value) => (200, value),
                        None => (404, json!({"message":"synthetic missing volume"})),
                    }
                } else if request.starts_with("POST") && request.contains("/containers/create?") {
                    (201, json!({"Id":"b".repeat(64)}))
                } else {
                    (500, json!({"message":"unexpected synthetic operation"}))
                };
                let reply = reply.to_string();
                stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).as_bytes()).await.unwrap();
            }
        });
        let backend = DockerEngineBackend::new(temp.path().join("docker.sock"));
        let spec = CreateRuntimeSpec {
            prior_provider_owner: None,
            initial_input_reservation: Some(binding.clone()),
            installation_id: registry.installation_id().clone(),
            soul_id: soul,
            incarnation_id: binding.incarnation_id.clone(),
            image_ref: image,
            host_binary_path: binary,
            runtime_dir: runtime,
            limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 64 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            test_run_id: "initial-volume".into(),
            terminal: None,
            fresh_agent: None,
            provider_volume_name: binding.reservation.provider_volume_name.clone(),
        };
        assert!(backend.create_stopped(&spec).await.is_err(),"uncertain volume-create acknowledgement keeps the exact reservation available for retry");
        assert!(!requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("/containers/create?")));
        backend.create_stopped(&spec).await.unwrap();
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.starts_with("POST") && r.contains("/volumes/create "))
                .count(),
            1,
            "physical provider volume must be explicitly owned before stopped workload creation"
        );
        backend.create_stopped(&spec).await.unwrap();
        assert_eq!(requests.lock().unwrap().iter().filter(|r|r.starts_with("POST") && r.contains("/volumes/create ")).count(),1,
            "lost workload-create acknowledgement must reuse the same exact labelled reservation volume");
        volume.lock().unwrap().as_mut().unwrap()["Labels"]["freshell.input.reservation"] =
            json!("foreign-reservation");
        assert!(
            backend.create_stopped(&spec).await.is_err(),
            "existing differently owned volume must not authorize initial absence"
        );
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.contains("/containers/create?"))
                .count(),
            2
        );
        std::fs::write(&spec.host_binary_path, b"changed synthetic artifact").unwrap();
        assert!(
            backend.create_stopped(&spec).await.is_err(),
            "changed helper artifact cannot consume the old reservation"
        );
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.contains("/containers/create?"))
                .count(),
            2
        );
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn native_auth_uses_private_ipc_and_cleans_only_verified_owned_helper() {
        for mode in [
            "success",
            "failed_exit",
            "timeout",
            "lost_create_ack",
            "cleanup_mismatch",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("owned-home");
            let auth = home.join(".local/share/opencode/auth.json");
            std::fs::create_dir_all(auth.parent().unwrap()).unwrap();
            std::fs::write(&auth, r#"{"selected":{"type":"wellknown","key":"FILE_PATH","token":"/synthetic/PRIVATE_AUTH_SENTINEL"}}"#).unwrap();
            let socket = temp.path().join("docker.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let daemon = DockerDaemonId::new();
            let binary = temp.path().join("reader");
            std::fs::write(&binary, "fixture executable").unwrap();
            let agent = serde_json::from_value(json!({
                "sessionId":"alias", "provider":"opencode", "sessionType":"freshopencode", "runtimeVariant":"opencode", "providerStoreId":"store",
                "cwd":"/workspace", "workspacePath":"/workspace", "runAsUid":65534, "runAsGid":0
            })).unwrap();
            let handle = OwnedRuntimeHandle::from_registry(
                InstallationId::new(),
                SoulId::new(),
                IncarnationId::new(),
                LaunchNonce::new(),
                daemon.clone(),
                "provider-container-must-not-stop".into(),
                "sha256:fixture".into(),
                temp.path().into(),
                binary.clone(),
                "digest".into(),
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
            let seen = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
            let captured = seen.clone();
            let created = Arc::new(Mutex::new(None::<Value>));
            let server = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (seen, created, daemon, home) = (
                        captured.clone(),
                        created.clone(),
                        daemon.clone(),
                        home.clone(),
                    );
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
                            .unwrap()
                            .trim()
                            .parse::<usize>()
                            .unwrap();
                        let mut body = vec![0; length];
                        stream.read_exact(&mut body).await.unwrap();
                        let request = head.lines().next().unwrap().to_string();
                        seen.lock().unwrap().push((request.clone(), body.clone()));
                        let (status, body) = if request.contains("/info ") {
                            (
                                200,
                                json!({"ID":daemon,"SecurityOptions":["name=rootless"]})
                                    .to_string(),
                            )
                        } else if request.contains("provider-container-must-not-stop/json") {
                            (404, String::new())
                        } else if request.contains("/images/") {
                            (200,json!({"Config":{"Env":["PATH=/image/path","INHERITED_TOKEN=PRIVATE_IMAGE_SENTINEL"]}}).to_string())
                        } else if request.contains("/volumes/") {
                            (200, json!({"Name":"owned-native-volume"}).to_string())
                        } else if request.contains("/create?") {
                            *created.lock().unwrap() = Some(serde_json::from_slice(&body).unwrap());
                            (
                                if mode == "lost_create_ack" { 503 } else { 201 },
                                json!({"Id":"owned-auth-helper"}).to_string(),
                            )
                        } else if request.contains("/start ") {
                            if mode != "timeout" {
                                let config = created.lock().unwrap().clone().unwrap();
                                let exchange = config["HostConfig"]["Mounts"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .find(|mount| mount["Target"] == "/run/freshell-auth-exchange")
                                    .unwrap()["Source"]
                                    .as_str()
                                    .unwrap()
                                    .to_owned();
                                std::thread::spawn(move || {
                                    let result = freshell_platform::native_auth_exchange::serve(
                                        &home,
                                        &Path::new(&exchange).join("reply.sock"),
                                    );
                                    if mode == "success" {
                                        assert_eq!(result, Ok(()));
                                    }
                                });
                            }
                            (204, String::new())
                        } else if request.contains("/wait?") {
                            if mode == "timeout" {
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                            (
                                200,
                                json!({"StatusCode":if mode == "failed_exit" {1} else {0}})
                                    .to_string(),
                            )
                        } else if request.contains("/json ") {
                            let config = created.lock().unwrap().clone().unwrap();
                            (200, json!({"Config":if mode == "cleanup_mismatch" {json!({"Cmd":["other"]})} else {config.clone()},"HostConfig":config["HostConfig"],"Name":"owned-auth-helper"}).to_string())
                        } else if request.starts_with("DELETE ") {
                            (204, String::new())
                        } else {
                            panic!("unexpected Docker operation {request}");
                        };
                        let reply = format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let _ = stream.write_all(reply.as_bytes()).await;
                    });
                }
            });
            let result = DockerEngineBackend::new(&socket)
                .read_auth_helper(
                    &handle,
                    &["FILE_PATH".into()],
                    &binary,
                    if mode == "timeout" {
                        Duration::from_millis(100)
                    } else {
                        Duration::from_secs(3)
                    },
                )
                .await;
            assert_eq!(
                result.is_ok(),
                mode == "success",
                "{mode}: {}",
                result
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .unwrap_or_default()
            );
            if mode == "success" {
                assert_eq!(
                    result.unwrap()["FILE_PATH"],
                    "/synthetic/PRIVATE_AUTH_SENTINEL"
                );
            }
            let records = seen.lock().unwrap().clone();
            let create = records
                .iter()
                .find(|(request, _)| request.contains("/create?"))
                .expect("helper must actually run");
            let body: Value = serde_json::from_slice(&create.1).unwrap();
            assert!(!String::from_utf8_lossy(&create.1).contains("PRIVATE_AUTH_SENTINEL"));
            assert_eq!(body["Cmd"], json!(["native-auth-only"]));
            assert_eq!(body["HostConfig"]["LogConfig"]["Type"], "none");
            assert_eq!(body["User"], "65534:0");
            assert!(body["Env"]
                .as_array()
                .unwrap()
                .contains(&json!("INHERITED_TOKEN=")));
            assert!(!String::from_utf8_lossy(&create.1).contains("PRIVATE_IMAGE_SENTINEL"));
            assert_eq!(body["HostConfig"]["Mounts"].as_array().unwrap().len(), 3);
            assert!(records
                .iter()
                .all(|(request, _)| !(request.contains("/logs")
                    || request.contains("/stop")
                    || request.starts_with("DELETE") && request.contains(handle.container_id()))));
            let deletes: Vec<_> = records
                .iter()
                .filter(|(request, _)| request.starts_with("DELETE "))
                .collect();
            assert_eq!(
                deletes.len(),
                if mode == "cleanup_mismatch" { 0 } else { 1 },
                "{mode}"
            );
            if let Some(delete) = deletes.first() {
                assert!(delete.0.contains("/containers/freshell-auth-"));
            }
            let exchange = PathBuf::from(
                body["HostConfig"]["Mounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|mount| mount["Target"] == "/run/freshell-auth-exchange")
                    .unwrap()["Source"]
                    .as_str()
                    .unwrap(),
            );
            assert!(!exchange.exists(), "private exchange cleanup failed");
            drop(records);
            server.abort();
            let _ = server.await;
        }
    }
}

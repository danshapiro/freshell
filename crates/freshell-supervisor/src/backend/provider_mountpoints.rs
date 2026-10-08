//! Fixed helper for descriptor-owned placeholders in the exact soul volume.
use super::*;
use freshell_platform::provider_mountpoints::Mountpoint;
use std::time::Duration;
use tokio::net::UnixListener;

fn fail(cause: &'static str) -> BackendError {
    BackendError::Unavailable(cause.into())
}

/// A target whose exact volume and daemon were checked by the owning caller.
/// This is the fixed mountpoint helper's input, never a workload launch spec.
pub(super) struct MountpointHelperTarget<'a> {
    pub image: &'a str,
    pub volume: &'a str,
    pub binary: &'a Path,
    pub daemon: &'a DockerDaemonId,
    pub labels: Value,
}

fn owned_mountpoint_helper(actual: &Value, expected: &Value) -> bool {
    input_publisher::owned_helper(actual, expected)
        && [
            "NetworkMode",
            "ReadonlyRootfs",
            "CapDrop",
            "CapAdd",
            "SecurityOpt",
            "Memory",
            "MemorySwap",
            "NanoCpus",
            "PidsLimit",
            "Tmpfs",
        ]
        .iter()
        .all(|field| actual["HostConfig"][field] == expected["HostConfig"][field])
}

fn selections(mounts: &docker::TerminalMounts) -> Result<Vec<Mountpoint>, BackendError> {
    let home = Path::new("/home/freshell/provider");
    let mut selected = BTreeMap::<String, bool>::new();
    let mut add = |path: &Path, directory: bool| -> Result<(), BackendError> {
        if let Ok(relative) = path.strip_prefix(home) {
            if relative.as_os_str().is_empty()
                || relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err(fail("provider mountpoint destination is invalid"));
            }
            let name = relative
                .to_str()
                .ok_or_else(|| fail("provider mountpoint is not UTF-8"))?;
            if selected
                .insert(name.into(), directory)
                .is_some_and(|prior| prior != directory)
            {
                return Err(fail("provider mountpoint kinds conflict"));
            }
        }
        Ok(())
    };
    for bind in &mounts.config_binds {
        add(Path::new(&bind.reference.effective_destination), false)?;
    }
    for root in &mounts.resource_mounts {
        let directory = root.kind == freshell_runtime_protocol::ProviderResourceKind::Directory;
        add(&home.join(&root.provider_relative_path), directory)?;
        add(Path::new(&root.effective_destination), directory)?;
        for leaf in mounts
            .config_binds
            .iter()
            .map(|bind| &bind.reference.effective_destination)
            .chain(mounts.indexed_files.iter().flat_map(|files| {
                files
                    .aliases
                    .iter()
                    .map(|alias| &alias.effective_destination)
            }))
        {
            if let Ok(relative) = Path::new(leaf).strip_prefix(&root.effective_destination) {
                add(
                    &home.join(&root.provider_relative_path).join(relative),
                    false,
                )?;
            }
        }
    }
    if let Some(files) = &mounts.indexed_files {
        for alias in &files.aliases {
            add(Path::new(&alias.effective_destination), false)?;
        }
    }
    Ok(selected
        .into_iter()
        .map(|(relative_path, directory)| Mountpoint {
            relative_path,
            directory,
        })
        .collect())
}

impl DockerEngineBackend {
    pub(super) async fn cleanup_provider_mountpoint_helper(
        &self,
        name: &str,
        body: &Value,
    ) -> Result<(), BackendError> {
        let inspected = self
            .request_bounded(
                "GET",
                &format!("{DOCKER_API}/containers/{name}/json"),
                None,
                1024 * 1024,
            )
            .await?;
        if inspected.status == 404 {
            return Ok(());
        }
        let actual: Value = serde_json::from_slice(&inspected.body)
            .map_err(|_| fail("provider mountpoint cleanup metadata invalid"))?;
        let id = actual["Id"]
            .as_str()
            .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| fail("provider mountpoint cleanup identity invalid"))?;
        if inspected.status != 200 || !owned_mountpoint_helper(&actual, body) {
            return Err(fail("provider mountpoint cleanup ownership changed"));
        }
        let removed = self
            .request_bounded(
                "DELETE",
                &format!("{DOCKER_API}/containers/{id}?force=1"),
                None,
                64 * 1024,
            )
            .await?;
        if !matches!(removed.status, 204 | 404) {
            return Err(fail("provider mountpoint helper cleanup failed"));
        }
        // An acknowledged delete does not release a candidate's mounts until
        // the exact inspected helper is confirmed absent.
        let absent = self
            .request_bounded(
                "GET",
                &format!("{DOCKER_API}/containers/{id}/json"),
                None,
                64 * 1024,
            )
            .await?;
        if absent.status != 404 {
            return Err(fail("provider mountpoint helper cleanup not confirmed"));
        }
        Ok(())
    }

    pub(super) async fn prepare_provider_mountpoints(
        &self,
        spec: &CreateRuntimeSpec,
        mounts: &docker::TerminalMounts,
        binary: &Path,
        daemon: &DockerDaemonId,
    ) -> Result<(), BackendError> {
        let selected = selections(mounts)?;
        if selected.is_empty() {
            return Ok(());
        }
        if spec.initial_input_reservation.is_none() {
            let prior = spec.prior_provider_owner.as_ref().ok_or_else(|| fail("provider mountpoints require a bound initial reservation or retained registry owner"))?;
            if prior.soul_id() != &spec.soul_id
                || prior.installation_id() != &spec.installation_id
                || prior.daemon_id() != daemon
                || prior.provider_volume_name() != spec.provider_volume_name
                || prior.image_ref() != spec.image_ref
            {
                return Err(fail("provider mountpoint retained ownership changed"));
            }
            if !matches!(
                self.inspect(prior).await?.state,
                BackendRuntimeState::Created
                    | BackendRuntimeState::Exited
                    | BackendRuntimeState::Dead
                    | BackendRuntimeState::Missing
            ) {
                return Err(fail(
                    "provider mountpoints require a quiescent retained owner",
                ));
            }
        }
        let volume = self
            .request_bounded(
                "GET",
                &format!("{DOCKER_API}/volumes/{}", spec.provider_volume_name),
                None,
                64 * 1024,
            )
            .await?;
        let value: Value = serde_json::from_slice(&volume.body)
            .map_err(|_| fail("provider mountpoint volume metadata invalid"))?;
        if volume.status != 200
            || value["Name"] != spec.provider_volume_name
            || value["Driver"] != "local"
            || !(value["Options"].is_null() || value["Options"] == json!({}))
        {
            return Err(fail("provider mountpoint owned local volume unavailable"));
        }
        if self.daemon_id().await? != *daemon {
            return Err(fail("provider mountpoint daemon changed"));
        }
        let mut owned = None;
        let target = MountpointHelperTarget {
            image: &spec.image_ref,
            volume: &spec.provider_volume_name,
            binary,
            daemon,
            labels: json!({"com.freshell.installation-id":spec.installation_id,"com.freshell.soul-id":spec.soul_id,"com.freshell.incarnation-id":spec.incarnation_id}),
        };
        self.run_provider_mountpoint_helper(
            target,
            selected,
            (Duration::from_secs(30), Duration::from_secs(5)),
            &mut owned,
        )
        .await
    }

    pub(super) async fn run_provider_mountpoint_helper(
        &self,
        target: MountpointHelperTarget<'_>,
        selected: Vec<Mountpoint>,
        budgets: (Duration, Duration),
        owned: &mut Option<(String, Value)>,
    ) -> Result<(), BackendError> {
        if owned.is_some() {
            return Err(fail(
                "provider mountpoint previous helper cleanup remains unconfirmed",
            ));
        }
        let deadline = tokio::time::Instant::now() + budgets.0;
        let request = freshell_runtime_protocol::bounded_json_bytes(&selected, 1024 * 1024)
            .map_err(|_| fail("provider mountpoint metadata profile exceeded"))?;
        let directory = native_auth::ExchangeDirectory::create_input()?;
        let socket = directory.0.join("reply.sock");
        let listener = UnixListener::bind(&socket)
            .map_err(|_| fail("provider mountpoint exchange bind failed"))?;
        directory.mode(&socket, 0o660)?;
        let name = format!("freshell-mountpoints-{}", uuid::Uuid::new_v4());
        let environment =
            tokio::time::timeout_at(deadline, self.private_helper_environment(target.image, &[]))
                .await
                .map_err(|_| fail("provider mountpoint image lookup timed out"))??;
        if tokio::time::Instant::now() >= deadline {
            return Err(fail(
                "provider mountpoint preparation timed out before create",
            ));
        }
        let body = json!({
            "Image":target.image,"User":"0:0","Tty":false,
            "Labels":target.labels,
            "Entrypoint":["/runtime/freshell-session-host"],"Cmd":["prepare-provider-mountpoints"],
            "Env":environment,
            "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"CapAdd":["CHOWN","SETGID","SETUID"],
                "SecurityOpt":["no-new-privileges"],"Memory":128*1024*1024,"MemorySwap":128*1024*1024,"NanoCpus":500_000_000,"PidsLimit":32,
                "LogConfig":{"Type":"none","Config":{}},
                "Mounts":[{"Type":"bind","Source":target.binary,"Target":"/runtime/freshell-session-host","ReadOnly":true},
                    {"Type":"volume","Source":target.volume,"Target":"/home/freshell/provider","ReadOnly":false,"VolumeOptions":{"NoCopy":true}},
                    {"Type":"bind","Source":directory.0,"Target":"/run/freshell-input-exchange","ReadOnly":true}]}
        });
        let mut attempted = false;
        let operation = async {
            attempted = true;
            *owned = Some((name.clone(), body.clone()));
            let created = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/create?name={name}"),
                    Some(&body),
                    64 * 1024,
                )
                .await?;
            if created.status == 409 {
                attempted = false;
                *owned = None;
            }
            if created.status != 201 {
                return Err(fail("provider mountpoint helper creation failed"));
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|_| fail("provider mountpoint helper identity unavailable"))?;
            let id = created["Id"]
                .as_str()
                .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or_else(|| fail("provider mountpoint helper identity invalid"))?;
            let inspected = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/containers/{id}/json"),
                    None,
                    1024 * 1024,
                )
                .await?;
            let actual: Value = serde_json::from_slice(&inspected.body)
                .map_err(|_| fail("provider mountpoint helper inspection invalid"))?;
            if inspected.status != 200
                || actual["Id"] != id
                || actual["State"]["Running"] != false
                || !owned_mountpoint_helper(&actual, &body)
            {
                return Err(fail(
                    "provider mountpoint helper namespace changed before start",
                ));
            }
            let started = self
                .request("POST", &format!("{DOCKER_API}/containers/{id}/start"), None)
                .await?;
            if started.status != 204 {
                return Err(fail("provider mountpoint helper start failed"));
            }
            let exchange = async {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .map_err(|_| fail("provider mountpoint exchange failed"))?;
                stream
                    .write_all(&(request.len() as u32).to_be_bytes())
                    .await
                    .map_err(|_| fail("provider mountpoint request failed"))?;
                stream
                    .write_all(&request)
                    .await
                    .map_err(|_| fail("provider mountpoint request incomplete"))?;
                let mut acknowledgement = [0; 2];
                stream
                    .read_exact(&mut acknowledgement)
                    .await
                    .map_err(|_| fail("provider mountpoint acknowledgement unavailable"))?;
                if &acknowledgement != b"ok" {
                    return Err(fail("provider mountpoint acknowledgement invalid"));
                }
                Ok(())
            };
            let wait = async {
                let response = self
                    .request_bounded(
                        "POST",
                        &format!("{DOCKER_API}/containers/{id}/wait?condition=not-running"),
                        None,
                        64 * 1024,
                    )
                    .await?;
                let value: Value = serde_json::from_slice(&response.body)
                    .map_err(|_| fail("provider mountpoint exit metadata invalid"))?;
                if response.status != 200 || value["StatusCode"] != 0 {
                    return Err(fail("provider mountpoint helper failed"));
                }
                Ok(())
            };
            tokio::try_join!(exchange, wait)?;
            if self.daemon_id().await? != *target.daemon {
                return Err(fail(
                    "provider mountpoint daemon changed before main create",
                ));
            }
            Ok(())
        };
        let result = tokio::time::timeout_at(deadline, operation)
            .await
            .unwrap_or_else(|_| Err(fail("provider mountpoint preparation timed out")));
        if attempted {
            tokio::time::timeout(
                budgets.1,
                self.cleanup_provider_mountpoint_helper(&name, &body),
            )
            .await
            .map_err(|_| fail("provider mountpoint cleanup timed out"))??;
            *owned = None;
        }
        tracing::debug!(
            event = "runtime.provider_mountpoints.settled",
            entries = selected.len(),
            succeeded = result.is_ok(),
            "Provider mountpoint preparation settled after owned cleanup"
        );
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{
        ProviderConfigBind, ProviderResourceKind, ProviderResourceMount,
    };

    #[tokio::test]
    async fn provider_mountpoint_candidate_target_joins_owned_preparation_and_cleanup() {
        use std::sync::{Arc, Mutex};
        use tokio::task::JoinSet;
        for mode in [
            "prepared",
            "empty",
            "lost-create-ack",
            "wrong-caps",
            "cleanup-still-present",
            "timeout",
            "cancel-private-exchange",
            "slow-image",
        ] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("scratch-home");
            std::fs::create_dir(&home).unwrap();
            let selected = if mode == "empty" {
                vec![]
            } else {
                vec![
                    Mountpoint {
                        relative_path: ".freshell/provider-roots/unit-0".into(),
                        directory: true,
                    },
                    Mountpoint {
                        relative_path: ".claude/settings.json".into(),
                        directory: false,
                    },
                ]
            };
            let daemon = DockerDaemonId::new();
            let binary = owned.path().join("host");
            std::fs::write(&binary, b"synthetic helper artifact").unwrap();
            let listener = UnixListener::bind(owned.path().join("docker.sock")).unwrap();
            let expected = Arc::new(Mutex::new(None::<Value>));
            let requests = Arc::new(Mutex::new(Vec::<String>::new()));
            let removed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (body, seen, deleted, fixture_home, fixture_daemon) = (
                expected.clone(),
                requests.clone(),
                removed.clone(),
                home.clone(),
                daemon.clone(),
            );
            let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(async move {
                let mut jobs = JoinSet::new();
                let private_jobs = Arc::new(Mutex::new(Vec::<tokio::task::JoinHandle<()>>::new()));
                loop {
                    tokio::select! {
                        _=&mut stopped=>break,
                        accepted=listener.accept()=>{
                            let (mut stream,_)=accepted.unwrap();
                            let (body,seen,deleted,home,daemon,private_jobs)=(body.clone(),seen.clone(),deleted.clone(),fixture_home.clone(),fixture_daemon.clone(),private_jobs.clone());
                            jobs.spawn(async move {
                                let mut header=Vec::new(); let mut byte=[0];
                                while !header.ends_with(b"\r\n\r\n") {stream.read_exact(&mut byte).await.unwrap();header.push(byte[0]);assert!(header.len()<=32*1024);}
                                let header=String::from_utf8(header).unwrap();
                                let line=header.lines().next().unwrap().to_string();
                                let length=header.lines().find_map(|line|line.strip_prefix("Content-Length: ")).unwrap().trim().parse::<usize>().unwrap();
                                assert!(length<=1024*1024);let mut raw=vec![0;length];stream.read_exact(&mut raw).await.unwrap();
                                seen.lock().unwrap().push(line.clone());
                                let (status,value)=if line.contains("/images/") {if mode=="slow-image" {tokio::time::sleep(Duration::from_secs(10)).await;} (200,json!({"Config":{"Env":["PATH=/usr/bin","ANTHROPIC_API_KEY=PRIVATE_UNUSED_IMAGE_CREDENTIAL"]}}))}
                                else if line.contains("/info ") {(200,json!({"ID":daemon,"SecurityOptions":["name=rootless"]}))}
                                else if line.contains("/containers/create?") { *body.lock().unwrap()=Some(serde_json::from_slice(&raw).unwrap());(if mode=="lost-create-ack" {503} else {201},json!({"Id":"c".repeat(64)}))}
                                else if line.starts_with("GET") && line.contains("/containers/") {
                                    if deleted.load(std::sync::atomic::Ordering::SeqCst) && mode!="cleanup-still-present" {(404,json!({}))}
                                    else {
                                        let mut expected=body.lock().unwrap().as_ref().unwrap().clone();
                                        if mode=="wrong-caps" {expected["HostConfig"]["CapAdd"]=json!(["SYS_ADMIN"]);}
                                        (200,json!({"Id":"c".repeat(64),"Config":expected,"HostConfig":expected["HostConfig"],"State":{"Running":false}}))
                                    }
                                }
                                else if line.contains("/start ") {
                                    let expected=body.lock().unwrap().as_ref().unwrap().clone();
                                    let exchange=expected["HostConfig"]["Mounts"].as_array().unwrap().iter().find(|mount|mount["Target"]=="/run/freshell-input-exchange").unwrap()["Source"].as_str().unwrap().to_owned();
                                    private_jobs.lock().unwrap().push(tokio::spawn(async move {
                                        let mut channel=UnixStream::connect(Path::new(&exchange).join("reply.sock")).await.unwrap();
                                        if matches!(mode,"timeout"|"cancel-private-exchange") {tokio::time::sleep(Duration::from_secs(10)).await;return;}
                                        let length=channel.read_u32().await.unwrap() as usize; assert!(length<=1024*1024);
                                        let mut raw=vec![0;length];channel.read_exact(&mut raw).await.unwrap();
                                        let selected:Vec<Mountpoint>=serde_json::from_slice(&raw).unwrap();
                                        for entry in selected {
                                            let path=home.join(entry.relative_path);std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                                            if entry.directory {std::fs::create_dir_all(path).unwrap();} else {std::fs::File::create(path).unwrap();}
                                        }
                                        channel.write_all(b"ok").await.unwrap();
                                    }));
                                    (204,json!({}))
                                }
                                else if line.contains("/wait?") {(200,json!({"StatusCode":0}))}
                                else if line.starts_with("DELETE") {deleted.store(true,std::sync::atomic::Ordering::SeqCst);(204,json!({}))}
                                else {(500,json!({}))};
                                let raw=value.to_string();let response=format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{raw}",raw.len());
                                let _=stream.write_all(response.as_bytes()).await;
                            });
                        },
                        result=jobs.join_next(),if !jobs.is_empty()=>{result.unwrap().unwrap();}
                    }
                }
                jobs.shutdown().await;
                let workers = std::mem::take(&mut *private_jobs.lock().unwrap());
                for worker in workers {
                    worker.abort();
                    if let Err(error) = worker.await {
                        assert!(error.is_cancelled());
                    }
                }
            });
            let backend = DockerEngineBackend::new(owned.path().join("docker.sock"));
            let mut helper = None;
            let outcome=tokio::time::timeout(if mode=="cancel-private-exchange" {Duration::from_millis(50)} else {Duration::from_secs(3)},backend.run_provider_mountpoint_helper(
                MountpointHelperTarget {image:"synthetic-image",volume:"owned-candidate-volume",binary:&binary,daemon:&daemon,labels:json!({"com.freshell.soul-id":"synthetic-owner","com.freshell.source-request-id":"synthetic-request"})},selected,(Duration::from_millis(250),Duration::from_millis(250)),&mut helper
            )).await;
            if mode == "cancel-private-exchange" {
                assert!(outcome.is_err());
                let (name, body) = helper
                    .as_ref()
                    .expect("canceled private exchange must retain exact helper ownership");
                tokio::time::timeout(
                    Duration::from_millis(250),
                    backend.cleanup_provider_mountpoint_helper(name, body),
                )
                .await
                .unwrap()
                .unwrap();
                helper = None;
            }
            let _ = stop.send(());
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
            if mode == "cancel-private-exchange" {
                assert!(helper.is_none());
                assert!(removed.load(std::sync::atomic::Ordering::SeqCst));
                continue;
            }
            let result = outcome
                .expect("preparation and cleanup must both be bounded, including image lookup");
            assert_eq!(
                result.is_ok(),
                matches!(mode, "prepared" | "empty"),
                "{mode}: candidate preparation must settle with exact owned absence: {result:?}"
            );
            if matches!(mode, "prepared" | "empty" | "lost-create-ack" | "timeout") {
                assert!(helper.is_none());
                assert!(removed.load(std::sync::atomic::Ordering::SeqCst));
            }
            if matches!(mode, "wrong-caps" | "cleanup-still-present") {
                assert!(
                    helper.is_some(),
                    "unconfirmed ownership or absence cannot clear cleanup tracking"
                );
            }
            if mode == "slow-image" {
                assert!(helper.is_none());
                assert!(!requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|line| line.contains("/containers/create?")));
                continue;
            }
            if mode == "prepared" {
                assert!(home.join(".freshell/provider-roots/unit-0").is_dir());
                assert!(home.join(".claude/settings.json").is_file());
            }
            if mode == "wrong-caps" {
                assert!(
                    !requests
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|line| line.contains("/start ") || line.starts_with("DELETE")),
                    "changed identity/caps cannot authorize helper start or deletion"
                );
            }
            let body = expected.lock().unwrap();
            let body = body
                .as_ref()
                .expect("even an empty candidate needs initial HOME preparation");
            assert_eq!(
                body["HostConfig"]["CapAdd"],
                json!(["CHOWN", "SETGID", "SETUID"])
            );
            assert_eq!(
                body["HostConfig"]["Mounts"][1]["Source"],
                "owned-candidate-volume"
            );
            assert!(!body.to_string().contains("PRIVATE_UNUSED_IMAGE_CREDENTIAL"));
        }
    }

    #[tokio::test]
    async fn provider_mountpoint_cleanup_requires_confirmed_absence_after_delete() {
        for mode in [
            "present-after-delete",
            "removed",
            "already-absent",
            "foreign",
            "lost-delete-ack",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let body = json!({"Image":"synthetic-image","User":"0:0","Tty":false,
                "Entrypoint":["/runtime/freshell-session-host"],"Cmd":["prepare-provider-mountpoints"],
                "Labels":{"com.freshell.soul-id":"synthetic-owner"},"Env":[],
                "HostConfig":{"Mounts":[],"LogConfig":{"Type":"none"}}});
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let requests = seen.clone();
            let expected = body.clone();
            let listener = tokio::net::UnixListener::bind(temp.path().join("docker.sock")).unwrap();
            let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(async move {
                let mut deleted = false;
                loop {
                    let accepted = tokio::select! {
                        _ = &mut stopped => break,
                        accepted = listener.accept() => accepted,
                    };
                    let (mut stream, _) = accepted.unwrap();
                    let mut header = Vec::new();
                    let mut byte = [0];
                    while !header.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).await.unwrap();
                        header.push(byte[0]);
                        assert!(header.len() <= 32 * 1024);
                    }
                    let header = String::from_utf8(header).unwrap();
                    let line = header.lines().next().unwrap().to_owned();
                    requests.lock().unwrap().push(line.clone());
                    let (status, value) = if line.starts_with("DELETE") {
                        deleted = true;
                        (if mode == "lost-delete-ack" { 503 } else { 204 }, json!({}))
                    } else if mode == "already-absent" || (deleted && mode == "removed") {
                        (404, json!({}))
                    } else {
                        let mut actual = expected.clone();
                        if mode == "foreign" {
                            actual["User"] = json!("foreign");
                        }
                        (
                            200,
                            json!({"Id":"a".repeat(64),"Config":actual,"HostConfig":actual["HostConfig"]}),
                        )
                    };
                    let raw = value.to_string();
                    stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{raw}", raw.len()).as_bytes()).await.unwrap();
                }
            });
            let backend = DockerEngineBackend::new(temp.path().join("docker.sock"));
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                backend.cleanup_provider_mountpoint_helper("freshell-mountpoints-synthetic", &body),
            )
            .await
            .unwrap();
            let _ = stop.send(());
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
            let requests = seen.lock().unwrap();
            assert_eq!(
                result.is_ok(),
                matches!(mode, "removed" | "already-absent"),
                "delete acknowledgement cannot prove cleanup for {mode}"
            );
            if mode == "removed" {
                assert_eq!(
                    requests.len(),
                    3,
                    "owned deletion must be followed by exact absence inspection"
                );
            }
            if matches!(mode, "foreign" | "already-absent") {
                assert!(
                    !requests.iter().any(|line| line.starts_with("DELETE")),
                    "cleanup must not delete foreign or already absent objects"
                );
            }
        }
    }

    #[test]
    fn provider_mountpoints_precreate_private_leaf_inside_external_selected_root() {
        let mounts = docker::TerminalMounts {
            workspace: "/synthetic/workspace".into(),
            git_common_dir: None,
            provider_bootstrap_files: vec![],
            provider_secret_files: vec![],
            indexed_secret_sources: BTreeMap::new(),
            provider_user_root: None,
            mcp_capability_file: None,
            input_manifest: None,
            indexed_files: None,
            config_binds: vec![docker::ResolvedProviderConfigBind {
                source: "/private/template".into(),
                reference: ProviderConfigBind {
                    source_relative_path: ".freshell/templates/source-0".into(),
                    logical_destination: "/synthetic/workspace/.opencode/opencode.json".into(),
                    effective_destination: "/synthetic/workspace/.opencode/opencode.json".into(),
                },
            }],
            resource_mounts: vec![ProviderResourceMount {
                stage_relative_path: ".freshell/resource-units/root-0".into(),
                provider_relative_path: ".freshell/provider-roots/root-0".into(),
                logical_destination: "/synthetic/workspace/.opencode".into(),
                effective_destination: "/synthetic/workspace/.opencode".into(),
                kind: ProviderResourceKind::Directory,
            }],
        };
        let selected = selections(&mounts).unwrap();
        assert!(selected.iter().any(|point| point.relative_path == ".freshell/provider-roots/root-0/opencode.json" && !point.directory),
            "exact private leaves must exist in the owned soul subpath before Docker mounts the external root");
    }
}

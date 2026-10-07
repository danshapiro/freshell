//! Fixed helper for descriptor-owned placeholders in the exact soul volume.
use super::*;
use freshell_platform::provider_mountpoints::Mountpoint;
use std::time::Duration;
use tokio::net::UnixListener;

fn fail(cause: &'static str) -> BackendError {
    BackendError::Unavailable(cause.into())
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
        let request = freshell_runtime_protocol::bounded_json_bytes(&selected, 1024 * 1024)
            .map_err(|_| fail("provider mountpoint metadata profile exceeded"))?;
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
        let directory = native_auth::ExchangeDirectory::create_input()?;
        let socket = directory.0.join("reply.sock");
        let listener = UnixListener::bind(&socket)
            .map_err(|_| fail("provider mountpoint exchange bind failed"))?;
        directory.mode(&socket, 0o660)?;
        let name = format!("freshell-mountpoints-{}", uuid::Uuid::new_v4());
        let body = json!({
            "Image":spec.image_ref,"User":"0:0","Tty":false,
            "Labels":{"com.freshell.installation-id":spec.installation_id,"com.freshell.soul-id":spec.soul_id,"com.freshell.incarnation-id":spec.incarnation_id},
            "Entrypoint":["/runtime/freshell-session-host"],"Cmd":["prepare-provider-mountpoints"],
            "Env":self.private_helper_environment(&spec.image_ref,&[]).await?,
            "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"CapAdd":["CHOWN","SETGID","SETUID"],
                "SecurityOpt":["no-new-privileges"],"Memory":128*1024*1024,"MemorySwap":128*1024*1024,"NanoCpus":500_000_000,"PidsLimit":32,
                "LogConfig":{"Type":"none","Config":{}},
                "Mounts":[{"Type":"bind","Source":binary,"Target":"/runtime/freshell-session-host","ReadOnly":true},
                    {"Type":"volume","Source":spec.provider_volume_name,"Target":"/home/freshell/provider","ReadOnly":false,"VolumeOptions":{"NoCopy":true}},
                    {"Type":"bind","Source":directory.0,"Target":"/run/freshell-input-exchange","ReadOnly":true}]}
        });
        let mut attempted = false;
        let operation = async {
            attempted = true;
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
            if self.daemon_id().await? != *daemon {
                return Err(fail(
                    "provider mountpoint daemon changed before main create",
                ));
            }
            Ok(())
        };
        let result = tokio::time::timeout(Duration::from_secs(30), operation)
            .await
            .unwrap_or_else(|_| Err(fail("provider mountpoint preparation timed out")));
        if attempted {
            let cleanup = async {
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
                if inspected.status != 200 || !input_publisher::owned_helper(&actual, &body) {
                    return Err(fail("provider mountpoint cleanup ownership changed"));
                }
                let removed = self
                    .request(
                        "DELETE",
                        &format!("{DOCKER_API}/containers/{id}?force=1"),
                        None,
                    )
                    .await?;
                if !matches!(removed.status, 204 | 404) {
                    return Err(fail("provider mountpoint helper cleanup failed"));
                }
                Ok(())
            };
            tokio::time::timeout(Duration::from_secs(5), cleanup)
                .await
                .map_err(|_| fail("provider mountpoint cleanup timed out"))??;
        }
        tracing::debug!(soul_id=%spec.soul_id,entries=selected.len(),succeeded=result.is_ok(),"runtime.provider_mountpoints_settled");
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{
        ProviderConfigBind, ProviderResourceKind, ProviderResourceMount,
    };

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

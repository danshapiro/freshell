//! Fixed helper for descriptor-owned placeholders in the exact soul volume.
use super::*;
use freshell_platform::provider_mountpoints::Mountpoint;
use std::time::Duration;
use tokio::net::UnixListener;

// Container creation and removal can take tens of seconds on rootless Docker.
// Keep their lifecycle allowance separate from the fixed helper's work budget.
const HELPER_CREATE_TIMEOUT: Duration = Duration::from_secs(60);
const HELPER_WORK_TIMEOUT: Duration = Duration::from_secs(30);
const HELPER_CLEANUP_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) type HelperOwners = std::sync::Mutex<BTreeMap<String, Option<HeldProviderPreparation>>>;

pub(super) type CreateReply = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<DockerResponse, BackendError>> + Send>,
>;

/// One exact owner spans scratch allocation, mountpoint setup, and the reader.
/// An occupied map entry without this value is an active move/Drop claim.
#[derive(Default)]
pub(super) struct HeldProviderPreparation {
    pub(super) mountpoint: Option<OwnedContainerCreate>,
    pub(super) candidate_scratch: Option<claude_source_observation::CandidateScratch>,
    pub(super) scratch_create: Option<CreateReply>,
    pub(super) reader: Option<claude_source_observation::HeldCandidateReader>,
}

pub(super) struct OwnedContainerCreate {
    name: String,
    body: Value,
    creation: HelperCreation,
    reconciling: bool,
    _directory: native_auth::ExchangeDirectory,
}

enum HelperCreation {
    Absent,
    Pending(CreateReply),
    Accepted,
    Rejected,
    Ambiguous,
}

enum HelperCleanup {
    Confirmed,
    CreationUnconfirmed,
}

impl OwnedContainerCreate {
    pub(super) fn new(
        socket: PathBuf,
        name: String,
        body: Value,
        directory: native_auth::ExchangeDirectory,
    ) -> Self {
        let creation = HelperCreation::Pending(creation_request(
            socket,
            format!("{DOCKER_API}/containers/create?name={name}"),
            body.clone(),
        ));
        Self {
            name,
            body,
            creation,
            reconciling: false,
            _directory: directory,
        }
    }

    pub(super) async fn creation_reply(&mut self) -> Result<DockerResponse, BackendError> {
        // Await in place: cancellation must not drop the response while Docker
        // is still creating this exact owned helper. Retrying only settles it.
        let HelperCreation::Pending(create) = &mut self.creation else {
            unreachable!("pending helper creation")
        };
        let reply = create.await;
        self.creation = match &reply {
            Ok(response) if response.status == 201 => HelperCreation::Accepted,
            Ok(response)
                if !self.reconciling
                    && matches!(response.status, 400 | 401 | 403 | 404 | 409 | 422) =>
            {
                HelperCreation::Rejected
            }
            _ => HelperCreation::Ambiguous,
        };
        reply
    }
}

pub(super) fn creation_request(socket: PathBuf, path: String, body: Value) -> CreateReply {
    // An independent transport avoids a reference cycle through the retained
    // preparation owners. This future dispatches CREATE only, never START.
    Box::pin(async move {
        DockerEngineBackend::new(socket)
            .request_bounded("POST", &path, Some(&body), 64 * 1024)
            .await
    })
}

pub(super) struct HelperClaim<'a> {
    owners: &'a HelperOwners,
    volume: String,
    pub(super) held: Option<HeldProviderPreparation>,
}

impl Drop for HelperClaim<'_> {
    fn drop(&mut self) {
        let mut owners = self
            .owners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(held) = self.held.take() {
            tracing::debug!(
                event = "runtime.provider_preparation.retained",
                volume = %self.volume,
                scratch_create_pending = held.scratch_create.is_some(),
                mountpoint_retained = held.mountpoint.is_some(),
                reader_retained = held.reader.is_some(),
                "Retaining exact provider preparation ownership until cleanup"
            );
            owners.insert(self.volume.clone(), Some(held));
        } else {
            owners.remove(&self.volume);
        }
    }
}

#[cfg(test)]
#[path = "provider_mountpoints_lifecycle_tests.rs"]
mod lifecycle_tests;

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
    pub candidate_scratch: Option<&'a claude_source_observation::CandidateScratch>,
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

pub(super) fn selections(mounts: &docker::TerminalMounts) -> Result<Vec<Mountpoint>, BackendError> {
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
    pub(super) fn claim_mountpoint_helper(
        &self,
        volume: &str,
    ) -> Result<HelperClaim<'_>, BackendError> {
        use std::collections::btree_map::Entry;
        let held = match self
            .mountpoint_helpers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(volume.to_owned())
        {
            Entry::Vacant(entry) => {
                entry.insert(None);
                None
            }
            Entry::Occupied(mut entry) => Some(entry.get_mut().take().ok_or_else(|| {
                fail("provider mountpoint helper operation is already in progress")
            })?),
        };
        Ok(HelperClaim {
            owners: &self.mountpoint_helpers,
            volume: volume.to_owned(),
            held,
        })
    }

    pub(super) async fn cleanup_retained_mountpoint_helper(
        &self,
        volume: &str,
    ) -> Result<(), BackendError> {
        self.cleanup_mountpoint_claim(&mut self.claim_mountpoint_helper(volume)?, true)
            .await
    }

    pub(super) async fn cleanup_previous_candidate_mountpoints(
        &self,
        soul: &SoulId,
    ) -> Result<(), BackendError> {
        let volumes = self
            .mountpoint_helpers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(_, held)| {
                held.as_ref()
                    .and_then(|held| held.candidate_scratch.as_ref())
                    .is_some_and(|scratch| scratch.belongs_to(soul))
            })
            .map(|(volume, _)| volume.clone())
            .collect::<Vec<_>>();
        for volume in volumes {
            self.cleanup_retained_mountpoint_helper(&volume).await?;
        }
        Ok(())
    }

    async fn cleanup_mountpoint_claim(
        &self,
        claim: &mut HelperClaim<'_>,
        retire_scratch: bool,
    ) -> Result<(), BackendError> {
        let Some(held) = claim.held.as_mut() else {
            return Ok(());
        };
        if let Some(create) = held.scratch_create.as_mut() {
            // Docker volume GET shares CREATE's per-volume lock. Keep the
            // original response alive across both observation and cleanup.
            let reply = create.await;
            held.scratch_create = None;
            if matches!(reply, Ok(response) if response.status == 409) {
                if let Some(scratch) = held.candidate_scratch.as_mut() {
                    scratch.creation_rejected();
                }
            }
        }
        if retire_scratch {
            if let Some(reader) = held.reader.as_mut() {
                self.cleanup_owned_container(
                    &mut reader.container,
                    claude_source_observation::owned_candidate_helper,
                )
                .await?;
                reader.cleanup_views()?;
                held.reader.take();
            }
        }
        if let Some(helper) = held.mountpoint.as_mut() {
            self.cleanup_owned_container(helper, owned_mountpoint_helper)
                .await?;
            held.mountpoint.take();
        }
        if retire_scratch {
            if let Some(scratch) = held.candidate_scratch.as_mut() {
                self.cleanup_claude_candidate_scratch(scratch).await?;
            }
            claim.held.take();
        } else if held.candidate_scratch.is_none() {
            claim.held.take();
        }
        // A candidate continues from successful mountpoint setup to its reader.
        // Keep the same exact scratch owner available between those phases.
        Ok(())
    }

    async fn cleanup_owned_container(
        &self,
        helper: &mut OwnedContainerCreate,
        qualifies: fn(&Value, &Value) -> bool,
    ) -> Result<(), BackendError> {
        if matches!(helper.creation, HelperCreation::Pending(_)) {
            let _ = helper.creation_reply().await;
        }
        if !matches!(
            helper.creation,
            HelperCreation::Absent | HelperCreation::Rejected
        ) {
            let outcome = self
                .cleanup_helper_container_body(
                    &helper.name,
                    &helper.body,
                    matches!(helper.creation, HelperCreation::Accepted),
                    qualifies,
                )
                .await?;
            if matches!(outcome, HelperCleanup::CreationUnconfirmed) {
                // Reconcile a lost transport using only its exact name/body.
                // A live original CREATE was settled above; a retry conflict
                // does not reject the original owner.
                helper.reconciling = true;
                helper.creation = HelperCreation::Pending(creation_request(
                    self.socket_path.clone(),
                    format!("{DOCKER_API}/containers/create?name={}", helper.name),
                    helper.body.clone(),
                ));
                let _ = helper.creation_reply().await;
                let outcome = self
                    .cleanup_helper_container_body(
                        &helper.name,
                        &helper.body,
                        matches!(helper.creation, HelperCreation::Accepted),
                        qualifies,
                    )
                    .await?;
                if matches!(outcome, HelperCleanup::CreationUnconfirmed) {
                    return Err(fail("provider helper creation remains unconfirmed"));
                }
            }
        }
        // Record confirmed absence before another cancellable cleanup request.
        // A later retry must not recreate an already retired helper or HOME.
        helper.creation = HelperCreation::Absent;
        Ok(())
    }

    async fn cleanup_helper_container_body(
        &self,
        name: &str,
        body: &Value,
        creation_acknowledged: bool,
        qualifies: fn(&Value, &Value) -> bool,
    ) -> Result<HelperCleanup, BackendError> {
        let inspected = self
            .request_bounded(
                "GET",
                &format!("{DOCKER_API}/containers/{name}/json"),
                None,
                1024 * 1024,
            )
            .await?;
        if inspected.status == 404 {
            return if creation_acknowledged {
                Ok(HelperCleanup::Confirmed)
            } else {
                Ok(HelperCleanup::CreationUnconfirmed)
            };
        }
        let actual: Value = serde_json::from_slice(&inspected.body)
            .map_err(|_| fail("provider helper cleanup metadata invalid"))?;
        let id = actual["Id"]
            .as_str()
            .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| fail("provider helper cleanup identity invalid"))?;
        if inspected.status != 200 || !qualifies(&actual, body) {
            return Err(fail("provider helper cleanup ownership changed"));
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
            return Err(fail("provider helper cleanup failed"));
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
            return Err(fail("provider helper cleanup not confirmed"));
        }
        Ok(HelperCleanup::Confirmed)
    }

    pub(super) async fn prepare_provider_mountpoints(
        &self,
        spec: &CreateRuntimeSpec,
        mounts: &docker::TerminalMounts,
        binary: &Path,
        daemon: &DockerDaemonId,
    ) -> Result<(), BackendError> {
        let selected = selections(mounts)?;
        if selected.is_empty() && spec.prior_provider_owner.is_none() {
            return tokio::time::timeout(
                HELPER_CLEANUP_TIMEOUT,
                self.cleanup_retained_mountpoint_helper(&spec.provider_volume_name),
            )
            .await
            .map_err(|_| fail("provider mountpoint previous creation or cleanup timed out"))?;
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
        let target = MountpointHelperTarget {
            image: &spec.image_ref,
            volume: &spec.provider_volume_name,
            binary,
            daemon,
            labels: json!({"com.freshell.installation-id":spec.installation_id,"com.freshell.soul-id":spec.soul_id,"com.freshell.incarnation-id":spec.incarnation_id}),
            candidate_scratch: None,
        };
        self.run_provider_mountpoint_helper(
            target,
            selected,
            (
                HELPER_CREATE_TIMEOUT + HELPER_WORK_TIMEOUT,
                HELPER_CLEANUP_TIMEOUT,
            ),
        )
        .await
    }

    pub(super) async fn run_provider_mountpoint_helper(
        &self,
        target: MountpointHelperTarget<'_>,
        selected: Vec<Mountpoint>,
        budgets: (Duration, Duration),
    ) -> Result<(), BackendError> {
        let mut claim = self.claim_mountpoint_helper(target.volume)?;
        let continuing_candidate = claim.held.as_ref().is_some_and(|held| {
            held.mountpoint.is_none()
                && held.reader.is_none()
                && held.scratch_create.is_none()
                && held
                    .candidate_scratch
                    .as_ref()
                    .zip(target.candidate_scratch)
                    .is_some_and(|(retained, current)| retained.same_owner(current))
        });
        if claim.held.is_some() && !continuing_candidate {
            tokio::time::timeout(budgets.1, self.cleanup_mountpoint_claim(&mut claim, true))
                .await
                .map_err(|_| {
                    fail("provider mountpoint previous creation or cleanup timed out")
                })??;
        }
        if claim.held.is_none() && target.candidate_scratch.is_some() {
            // Preserve the scratch owner even before image lookup can await.
            claim.held = Some(HeldProviderPreparation {
                candidate_scratch: target.candidate_scratch.cloned(),
                ..Default::default()
            });
        }
        let name = format!("freshell-mountpoints-{}", uuid::Uuid::new_v4());
        let deadline = tokio::time::Instant::now() + budgets.0;
        let request = freshell_runtime_protocol::bounded_json_bytes(&selected, 1024 * 1024)
            .map_err(|_| fail("provider mountpoint metadata profile exceeded"))?;
        let directory = native_auth::ExchangeDirectory::create_input()?;
        let socket = directory.0.join("reply.sock");
        let listener = UnixListener::bind(&socket)
            .map_err(|_| fail("provider mountpoint exchange bind failed"))?;
        directory.mode(&socket, 0o660)?;
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
        let held = claim
            .held
            .get_or_insert_with(HeldProviderPreparation::default);
        held.mountpoint = Some(OwnedContainerCreate::new(
            self.socket_path.clone(),
            name.clone(),
            body.clone(),
            directory,
        ));
        let mut phase = "create";
        let operation = async {
            let create_deadline = deadline.min(tokio::time::Instant::now() + HELPER_CREATE_TIMEOUT);
            let created = tokio::time::timeout_at(
                create_deadline,
                claim
                    .held
                    .as_mut()
                    .unwrap()
                    .mountpoint
                    .as_mut()
                    .unwrap()
                    .creation_reply(),
            )
            .await
            .map_err(|_| fail("provider mountpoint helper creation timed out"))??;
            if created.status != 201 {
                return Err(fail("provider mountpoint helper creation failed"));
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|_| fail("provider mountpoint helper identity unavailable"))?;
            let id = created["Id"]
                .as_str()
                .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or_else(|| fail("provider mountpoint helper identity invalid"))?;
            let work_deadline = deadline.min(tokio::time::Instant::now() + HELPER_WORK_TIMEOUT);
            let work = async {
                phase = "inspect";
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
                phase = "start";
                let started = self
                    .request("POST", &format!("{DOCKER_API}/containers/{id}/start"), None)
                    .await?;
                if started.status != 204 {
                    return Err(fail("provider mountpoint helper start failed"));
                }
                phase = "exchange";
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
                    match &acknowledgement {
                        b"ok" => Ok(()),
                        b"er" => {
                            let mut length = [0; 4];
                            stream.read_exact(&mut length).await.map_err(|_| {
                                fail("provider mountpoint failure reason unavailable")
                            })?;
                            let length = u32::from_be_bytes(length) as usize;
                            if length == 0 || length > 4096 {
                                return Err(fail(
                                    "provider mountpoint failure reason exceeds limit",
                                ));
                            }
                            let mut reason = vec![0; length];
                            stream.read_exact(&mut reason).await.map_err(|_| {
                                fail("provider mountpoint failure reason incomplete")
                            })?;
                            let reason = std::str::from_utf8(&reason)
                                .map_err(|_| fail("provider mountpoint failure reason invalid"))?;
                            Err(BackendError::Unavailable(format!(
                                "provider mountpoint preparation failed: {reason}"
                            )))
                        }
                        _ => Err(fail("provider mountpoint acknowledgement invalid")),
                    }
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
                let (exchange_result, wait_result) = tokio::join!(exchange, wait);
                exchange_result?;
                wait_result?;
                if self.daemon_id().await? != *target.daemon {
                    return Err(fail(
                        "provider mountpoint daemon changed before main create",
                    ));
                }
                Ok(())
            };
            tokio::time::timeout_at(work_deadline, work)
                .await
                .unwrap_or_else(|_| Err(fail("provider mountpoint helper work timed out")))
        };
        let result = tokio::time::timeout_at(deadline, operation)
            .await
            .unwrap_or_else(|_| Err(fail("provider mountpoint preparation timed out")));
        if let Err(error) = &result {
            tracing::warn!(
                event = "runtime.provider_mountpoints.failed",
                phase,
                helper = %name,
                operation_timeout_ms = budgets.0.as_millis() as u64,
                error = %error,
                "Provider mountpoint helper failed; reconciling owned creation and cleanup"
            );
        }
        tokio::time::timeout(budgets.1, self.cleanup_mountpoint_claim(&mut claim, false))
            .await
            .map_err(|_| fail("provider mountpoint creation or cleanup timed out"))??;
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
            "preparation-error",
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
                                        if mode=="preparation-error" {channel.write_all(b"er").await.unwrap();channel.write_u32(31).await.unwrap();channel.write_all(b"test preparation failure reason").await.unwrap();return;}
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
            let outcome=tokio::time::timeout(if mode=="cancel-private-exchange" {Duration::from_millis(50)} else {Duration::from_secs(3)},backend.run_provider_mountpoint_helper(
                MountpointHelperTarget {image:"synthetic-image",volume:"owned-candidate-volume",binary:&binary,daemon:&daemon,labels:json!({"com.freshell.soul-id":"synthetic-owner","com.freshell.source-request-id":"synthetic-request"}),candidate_scratch:None},selected,(Duration::from_millis(250),Duration::from_millis(250))
            )).await;
            if mode == "cancel-private-exchange" {
                assert!(outcome.is_err());
                assert!(
                    backend
                        .mountpoint_helpers
                        .lock()
                        .unwrap()
                        .contains_key("owned-candidate-volume"),
                    "canceled private exchange must retain exact helper ownership"
                );
                tokio::time::timeout(
                    Duration::from_millis(250),
                    backend.cleanup_retained_mountpoint_helper("owned-candidate-volume"),
                )
                .await
                .unwrap()
                .unwrap();
            }
            let _ = stop.send(());
            tokio::time::timeout(Duration::from_secs(2), server)
                .await
                .unwrap()
                .unwrap();
            if mode == "cancel-private-exchange" {
                assert!(backend.mountpoint_helpers.lock().unwrap().is_empty());
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
            if mode == "preparation-error" {
                assert!(
                    format!("{result:?}").contains("test preparation failure reason"),
                    "the helper's bounded failure reason must reach the caller: {result:?}"
                );
            }
            if matches!(
                mode,
                "prepared" | "empty" | "preparation-error" | "lost-create-ack" | "timeout"
            ) {
                assert!(backend.mountpoint_helpers.lock().unwrap().is_empty());
                assert!(removed.load(std::sync::atomic::Ordering::SeqCst));
            }
            if matches!(mode, "wrong-caps" | "cleanup-still-present") {
                assert!(
                    backend
                        .mountpoint_helpers
                        .lock()
                        .unwrap()
                        .contains_key("owned-candidate-volume"),
                    "unconfirmed ownership or absence cannot clear cleanup tracking"
                );
            }
            if mode == "slow-image" {
                assert!(backend.mountpoint_helpers.lock().unwrap().is_empty());
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
                backend.cleanup_helper_container_body(
                    "freshell-mountpoints-synthetic",
                    &body,
                    true,
                    owned_mountpoint_helper,
                ),
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
                writable: false,
                reference_aliases: vec![],
                retired_reference_aliases: vec![],
            }],
            operator_home: None,
        };
        let selected = selections(&mounts).unwrap();
        assert!(selected.iter().any(|point| point.relative_path == ".freshell/provider-roots/root-0/opencode.json" && !point.directory),
            "exact private leaves must exist in the owned soul subpath before Docker mounts the external root");
    }

    #[test]
    fn provider_mountpoints_include_nested_writable_file_mounts() {
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
            config_binds: vec![],
            resource_mounts: vec![
                ProviderResourceMount {
                    stage_relative_path: ".freshell/resource-units/root-directory".into(),
                    provider_relative_path: ".freshell/provider-roots/root-directory".into(),
                    logical_destination: "/home/freshell/provider/mcp".into(),
                    effective_destination: "/home/freshell/provider/mcp".into(),
                    kind: ProviderResourceKind::Directory,
                    writable: false,
                    reference_aliases: vec![],
                    retired_reference_aliases: vec![],
                },
                ProviderResourceMount {
                    stage_relative_path: ".freshell/resource-units/root-state/source".into(),
                    provider_relative_path: ".freshell/provider-roots/root-state/source".into(),
                    logical_destination: "/home/freshell/provider/mcp/state.json".into(),
                    effective_destination: "/home/freshell/provider/mcp/state.json".into(),
                    kind: ProviderResourceKind::File,
                    writable: true,
                    reference_aliases: vec![],
                    retired_reference_aliases: vec![],
                },
            ],
            operator_home: None,
        };

        let selected = selections(&mounts).unwrap();
        let has = |path: &str, directory| {
            selected
                .iter()
                .any(|point| point.relative_path == path && point.directory == directory)
        };
        assert!(has(".freshell/provider-roots/root-directory", true));
        assert!(has(".freshell/provider-roots/root-state/source", false));
        assert!(has("mcp", true));
        assert!(has("mcp/state.json", false));
    }
}

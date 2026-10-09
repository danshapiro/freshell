//! Fixed provider-UID indexed input publisher and its owned active mount lease.
use super::*;
use freshell_platform::provider_input_exchange::{
    Acknowledgement, Request, MAX_CHUNK_BYTES, MAX_FILE_BYTES, MAX_FRAME_BYTES, MAX_TOTAL_BYTES,
};
use std::time::Duration;
use tokio::net::UnixListener;

fn fail(cause: &'static str) -> BackendError {
    BackendError::Unavailable(cause.into())
}

pub(super) struct HeldPublisher {
    soul: String,
    incarnation: String,
    name: String,
    expected: Value,
    context: freshell_runtime_protocol::ProviderLaunchContext,
    references: Vec<freshell_runtime_protocol::ProviderSecretReference>,
    stream: UnixStream,
    _directory: native_auth::ExchangeDirectory,
}
struct PublicationClaim {
    claims: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
    soul: String,
}
impl Drop for PublicationClaim {
    fn drop(&mut self) {
        self.claims
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.soul);
    }
}

async fn acknowledgement(
    stream: &mut UnixStream,
    expected: Acknowledgement,
) -> Result<(), BackendError> {
    let length = stream
        .read_u32()
        .await
        .map_err(|_| fail("input publisher acknowledgement unavailable"))?
        as usize;
    if length >= MAX_FRAME_BYTES {
        return Err(fail("input publisher acknowledgement exceeds limit"));
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| fail("input publisher acknowledgement incomplete"))?;
    let actual: Acknowledgement = serde_json::from_slice(&bytes)
        .map_err(|_| fail("input publisher acknowledgement invalid"))?;
    if actual != expected {
        return Err(fail("input publisher acknowledgement phase changed"));
    }
    Ok(())
}
async fn request(
    stream: &mut UnixStream,
    value: &Request,
    expected: Acknowledgement,
) -> Result<(), BackendError> {
    let mut bytes = Vec::new();
    freshell_platform::provider_input_exchange::write_request(&mut bytes, value).map_err(fail)?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| fail("input publisher private request failed"))?;
    acknowledgement(stream, expected).await
}

fn labels(spec: &CreateRuntimeSpec, generation: &str) -> Value {
    json!({"com.freshell.managed-inputs":"true","com.freshell.installation-id":spec.installation_id,
        "com.freshell.soul-id":spec.soul_id,"com.freshell.incarnation-id":spec.incarnation_id,
        "com.freshell.input-generation":generation})
}

fn filter_query(value: Value) -> String {
    serde_json::to_vec(&value)
        .expect("finite Docker filter")
        .into_iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect()
}
fn helper_body(
    image: &str,
    ownership: &Value,
    binary: &Path,
    volume: &str,
    directory: &Path,
) -> Value {
    json!({
        "Image":image,"User":"65534:0","Tty":false,"Labels":ownership,
        "Entrypoint":["/runtime/freshell-session-host"],"Cmd":["publish-provider-inputs"],"Env":[],
        "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
            "Memory":128*1024*1024,"MemorySwap":128*1024*1024,"NanoCpus":500_000_000,"PidsLimit":32,
            "LogConfig":{"Type":"none","Config":{}},
            "Mounts":[{"Type":"bind","Source":binary,"Target":"/runtime/freshell-session-host","ReadOnly":true},
                {"Type":"volume","Source":volume,"Target":"/run/freshell-input-files","ReadOnly":false,"VolumeOptions":{"NoCopy":true}},
                {"Type":"bind","Source":directory,"Target":"/run/freshell-input-exchange","ReadOnly":true}]}
    })
}
fn volume_options() -> Value {
    json!({"type":"tmpfs","device":"tmpfs","o":prepared_inputs::INDEXED_VOLUME_OPTIONS})
}

fn environment(value: &Value) -> Option<BTreeMap<&str, &str>> {
    let mut result = BTreeMap::new();
    for entry in value.as_array()? {
        let (key, value) = entry.as_str()?.split_once('=')?;
        if result.insert(key, value).is_some() {
            return None;
        }
    }
    Some(result)
}

async fn open_approved_source(
    path: &Path,
    remaining: u64,
) -> Result<tokio::io::Take<tokio::fs::File>, BackendError> {
    if std::fs::canonicalize(path).map_err(|_| fail("approved input source unavailable"))? != path {
        return Err(fail("approved input source selection changed"));
    }
    let limit = MAX_FILE_BYTES.min(remaining);
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| fail("approved input source metadata failed"))?;
    if !metadata.is_file() {
        return Err(fail("approved input source is not regular"));
    }
    if metadata.len() > limit {
        return Err(fail("approved input source actual bytes exceed profile"));
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| fail("approved input source read failed"))?;
    let opened = file
        .metadata()
        .await
        .map_err(|_| fail("approved input source metadata failed"))?;
    if !opened.is_file() {
        return Err(fail("approved input source is not regular"));
    }
    if opened.len() > limit {
        return Err(fail("approved input source actual bytes exceed profile"));
    }
    Ok(file.take(limit + 1))
}

pub(super) fn owned_helper(actual: &Value, expected: &Value) -> bool {
    let mounts_match = actual["HostConfig"]["Mounts"]
        .as_array()
        .zip(expected["HostConfig"]["Mounts"].as_array())
        .is_some_and(|(actual, expected)| {
            actual.len() == expected.len()
                && actual.iter().zip(expected).all(|(actual, expected)| {
                    ["Type", "Source", "Target"]
                        .iter()
                        .all(|key| actual[key] == expected[key])
                        && mount_readonly(&actual["ReadOnly"])
                            == mount_readonly(&expected["ReadOnly"])
                        && actual["VolumeOptions"]["NoCopy"] == expected["VolumeOptions"]["NoCopy"]
                        && actual["VolumeOptions"]["Subpath"].as_str().unwrap_or("")
                            == expected["VolumeOptions"]["Subpath"].as_str().unwrap_or("")
                })
        });
    ["Image", "User", "Tty", "Entrypoint", "Cmd"]
        .iter()
        .all(|key| actual["Config"][key] == expected[key])
        && owned_labels(&actual["Config"]["Labels"], &expected["Labels"])
        && environment(&actual["Config"]["Env"])
            .is_some_and(|actual| Some(actual) == environment(&expected["Env"]))
        && mounts_match
        && actual["HostConfig"]["LogConfig"]["Type"] == "none"
}

pub(super) fn mount_readonly(value: &Value) -> Option<bool> {
    if value.is_null() {
        Some(false)
    } else {
        value.as_bool()
    }
}
fn owned_labels(actual: &Value, expected: &Value) -> bool {
    let expected = expected.as_object();
    let Some(actual) = actual.as_object() else {
        return actual.is_null() && expected.is_none_or(|labels| labels.is_empty());
    };
    expected.is_none_or(|labels| {
        labels
            .iter()
            .all(|(key, value)| actual.get(key) == Some(value))
    }) && actual
        .iter()
        .filter(|(key, _)| {
            key.starts_with("com.freshell.")
                || key.starts_with("freshell.")
                || key.as_str() == "project"
        })
        .all(|(key, value)| expected.and_then(|labels| labels.get(key)) == Some(value))
}

impl DockerEngineBackend {
    pub(super) async fn private_helper_environment(
        &self,
        image: &str,
        explicit: &[&str],
    ) -> Result<Vec<String>, BackendError> {
        let inspected = self
            .request_bounded(
                "GET",
                &format!("{DOCKER_API}/images/{image}/json"),
                None,
                MAX_FRAME_BYTES as u64,
            )
            .await
            .map_err(|_| fail("private helper image inspection unavailable"))?;
        if inspected.status != 200 {
            return Err(fail("private helper image inspection failed"));
        }
        let image: Value = serde_json::from_slice(&inspected.body)
            .map_err(|_| fail("private helper image metadata invalid"))?;
        let mut values = BTreeMap::<String, String>::new();
        if let Some(entries) = image["Config"]["Env"].as_array() {
            if entries.len() > 128 {
                return Err(fail("private helper image environment exceeds limit"));
            }
            for entry in entries {
                let (key, _) = entry
                    .as_str()
                    .and_then(|entry| entry.split_once('='))
                    .ok_or_else(|| fail("private helper image environment invalid"))?;
                if key.is_empty()
                    || key.len() > 128
                    || !key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                {
                    return Err(fail("private helper image environment name invalid"));
                }
                // Explicit empty overrides prevent Docker's image defaults
                // from introducing provider credentials into this helper.
                values.insert(key.to_owned(), String::new());
            }
        }
        for entry in explicit {
            let (key, value) = entry
                .split_once('=')
                .ok_or_else(|| fail("private helper environment invalid"))?;
            values.insert(key.to_owned(), value.to_owned());
        }
        Ok(values
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect())
    }
    async fn input_ownership_request(&self, path: &str) -> Result<DockerResponse, BackendError> {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.request_bounded("GET", path, None, 1024 * 1024),
        )
        .await
        .map_err(|_| fail("input ownership inspection timed out; preserve preparation"))?
    }
    async fn verify_no_input_workloads(
        &self,
        volume: &str,
        helper: Option<&str>,
    ) -> Result<(), BackendError> {
        let filters = filter_query(json!({"volume":[volume]}));
        let response = self
            .input_ownership_request(&format!(
                "{DOCKER_API}/containers/json?all=1&filters={filters}"
            ))
            .await
            .map_err(|_| fail("input generation users unavailable; preserve preparation"))?;
        if response.status != 200 {
            return Err(fail(
                "input generation users unavailable; preserve preparation",
            ));
        }
        let values: Value = serde_json::from_slice(&response.body)
            .map_err(|_| fail("input generation users invalid; preserve preparation"))?;
        let values = values
            .as_array()
            .ok_or_else(|| fail("input generation users invalid; preserve preparation"))?;
        for value in values {
            let id = value["Id"]
                .as_str()
                .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| {
                    fail("input generation user identity invalid; preserve preparation")
                })?;
            if Some(id) != helper {
                return Err(fail("input generation has an uncertain workload reference; preserve dispatched ownership"));
            }
        }
        Ok(())
    }
    async fn check_input_generation_capacity(
        &self,
        spec: &CreateRuntimeSpec,
        current: &str,
    ) -> Result<(), BackendError> {
        let filters = filter_query(
            json!({"label":["com.freshell.managed-inputs=true",format!("com.freshell.installation-id={}",spec.installation_id),format!("com.freshell.soul-id={}",spec.soul_id)]}),
        );
        let response = self
            .input_ownership_request(&format!("{DOCKER_API}/volumes?filters={filters}"))
            .await
            .map_err(|_| fail("input generation ownership inventory unavailable"))?;
        if response.status != 200 {
            return Err(fail("input generation ownership inventory unavailable"));
        }
        let value: Value = serde_json::from_slice(&response.body)
            .map_err(|_| fail("input generation ownership inventory invalid"))?;
        let empty = Vec::new();
        let volumes = if value["Volumes"].is_null() {
            &empty
        } else {
            value["Volumes"]
                .as_array()
                .ok_or_else(|| fail("input generation ownership inventory invalid"))?
        };
        let mut names = std::collections::BTreeSet::new();
        for volume in volumes {
            let generation = volume["Labels"]["com.freshell.input-generation"]
                .as_str()
                .filter(|v| {
                    v.len() <= 128
                        && v.starts_with("grant-")
                        && v.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
                .ok_or_else(|| fail("input generation inventory ownership changed"))?;
            let incarnation = volume["Labels"]["com.freshell.incarnation-id"]
                .as_str()
                .ok_or_else(|| fail("input generation inventory ownership changed"))?;
            IncarnationId::parse(incarnation.to_owned())
                .map_err(|_| fail("input generation inventory owner invalid"))?;
            let expected =
                freshell_runtime_protocol::indexed_provider_volume_name(&spec.soul_id, generation);
            let mut ownership = labels(spec, generation);
            ownership["com.freshell.incarnation-id"] = json!(incarnation);
            if volume["Name"] != expected
                || volume["Labels"] != ownership
                || volume["Driver"] != "local"
                || volume["Options"] != volume_options()
                || !names.insert(expected)
            {
                return Err(fail(
                    "input generation inventory ownership changed; preserve volumes",
                ));
            }
            if names.len() > 2 {
                return Err(fail("input generations exceed one active and one pending; reconcile exact ownership"));
            }
        }
        if names.len() == 2 && !names.contains(current) {
            return Err(fail(
                "one active and one pending input generation already exist; preserve and reconcile",
            ));
        }
        Ok(())
    }
    async fn inspect_cold_publisher(
        &self,
        volume: &str,
        ownership: &Value,
        image: &str,
        binary: &Path,
    ) -> Result<Option<(Value, String)>, BackendError> {
        let name = format!("{volume}-publisher");
        let response = self
            .input_ownership_request(&format!("{DOCKER_API}/containers/{name}/json"))
            .await
            .map_err(|_| fail("cold input publisher inspection unavailable"))?;
        if response.status == 404 {
            return Ok(None);
        }
        if response.status != 200 {
            return Err(fail("cold input publisher inspection unavailable"));
        }
        let actual: Value = serde_json::from_slice(&response.body)
            .map_err(|_| fail("cold input publisher metadata invalid"))?;
        let mounts = actual["HostConfig"]["Mounts"]
            .as_array()
            .ok_or_else(|| fail("cold input publisher mounts invalid"))?;
        let directory = mounts
            .iter()
            .find(|m| m["Target"] == "/run/freshell-input-exchange")
            .and_then(|m| m["Source"].as_str())
            .map(PathBuf::from)
            .ok_or_else(|| fail("cold input publisher exchange invalid"))?;
        let suffix = directory
            .file_name()
            .and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("freshell-inputs-"))
            .ok_or_else(|| fail("cold input publisher exchange ownership changed"))?;
        if directory.parent() != Some(std::env::temp_dir().as_path())
            || uuid::Uuid::parse_str(suffix)
                .ok()
                .is_none_or(|id| id.get_version_num() != 4 || id.to_string() != suffix)
        {
            return Err(fail("cold input publisher exchange ownership changed"));
        }
        let mut expected = helper_body(image, ownership, binary, volume, &directory);
        expected["Env"] = serde_json::to_value(
            tokio::time::timeout(
                Duration::from_secs(5),
                self.private_helper_environment(image, &[]),
            )
            .await
            .map_err(|_| fail("cold input publisher image inspection timed out"))??,
        )
        .map_err(|_| fail("cold input publisher environment invalid"))?;
        let host = &actual["HostConfig"];
        let id = actual["Id"]
            .as_str()
            .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| fail("cold input publisher identity invalid"))?;
        if actual["Name"] != format!("/{name}")
            || !owned_helper(&actual, &expected)
            || [
                "NetworkMode",
                "ReadonlyRootfs",
                "CapDrop",
                "SecurityOpt",
                "Memory",
                "MemorySwap",
                "NanoCpus",
                "PidsLimit",
            ]
            .iter()
            .any(|key| host[key] != expected["HostConfig"][key])
            || host["Privileged"].as_bool().unwrap_or(false)
            || !host["PidMode"].as_str().unwrap_or("").is_empty()
            || ["CapAdd", "Devices", "Binds", "VolumesFrom"]
                .iter()
                .any(|key| host[key].as_array().is_some_and(|v| !v.is_empty()))
        {
            return Err(fail(
                "cold input publisher fixed ownership changed; preserve helper",
            ));
        }
        Ok(Some((expected, id.to_owned())))
    }
    async fn cleanup_cold_publisher(
        &self,
        volume: &str,
        expected: &Value,
    ) -> Result<(), BackendError> {
        self.cleanup_input_helper(&format!("{volume}-publisher"), expected)
            .await?;
        // Only the exact private socket and its empty directory are retired.
        // Never recurse or remove a changed path inferred from Docker metadata.
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = PathBuf::from(
            expected["HostConfig"]["Mounts"][2]["Source"]
                .as_str()
                .ok_or_else(|| fail("cold input publisher exchange unavailable"))?,
        );
        if let Ok(meta) = std::fs::symlink_metadata(&directory) {
            let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
            if meta.is_dir()
                && !meta.file_type().is_symlink()
                && meta.uid() == uid
                && meta.gid() == gid
                && meta.permissions().mode() & 0o777 == 0o710
            {
                let socket = directory.join("reply.sock");
                if std::fs::symlink_metadata(&socket).is_ok_and(|m| {
                    m.uid() == uid
                        && m.gid() == gid
                        && m.permissions().mode() & 0o777 == 0o660
                        && std::os::unix::fs::FileTypeExt::is_socket(&m.file_type())
                }) {
                    let _ = std::fs::remove_file(socket);
                }
                let _ = std::fs::remove_dir(directory);
            } else {
                tracing::warn!("runtime.input_publication_cold_exchange_preserved");
            }
        }
        Ok(())
    }

    pub(super) async fn abort_indexed_publication(
        &self,
        spec: &CreateRuntimeSpec,
    ) -> Result<(), BackendError> {
        let context = spec
            .terminal
            .as_ref()
            .and_then(|spec| spec.provider_launch_context.as_ref())
            .or_else(|| {
                spec.fresh_agent
                    .as_ref()
                    .and_then(|spec| spec.provider_launch_context.as_ref())
            });
        let Some(inputs) = context.and_then(|context| context.prepared_inputs.as_ref()) else {
            return Ok(());
        };
        let Some(files) = &inputs.indexed_files else {
            return Ok(());
        };
        {
            let held = self
                .input_publishers
                .lock()
                .map_err(|_| fail("input publisher ownership unavailable"))?;
            if let Some(publisher) = held.get(&files.volume_name) {
                if publisher.soul != spec.soul_id.as_str()
                    || publisher.incarnation != spec.incarnation_id.as_str()
                    || publisher.context != *context.unwrap()
                {
                    return Err(fail("input publisher abort belongs to another preparation"));
                }
            }
        }
        let ownership = labels(spec, &inputs.generation_id);
        let cold = self
            .inspect_cold_publisher(
                &files.volume_name,
                &ownership,
                &spec.image_ref,
                &spec.host_binary_path,
            )
            .await?;
        self.verify_no_input_workloads(
            &files.volume_name,
            cold.as_ref().map(|(_, id)| id.as_str()),
        )
        .await?;
        self.release_indexed_publication(
            &spec.soul_id,
            &spec.incarnation_id,
            &inputs.generation_id,
            &ownership,
            &spec.image_ref,
            &spec.host_binary_path,
        )
        .await?;
        self.cleanup_input_volume(
            &files.volume_name,
            &labels(spec, &inputs.generation_id),
            &json!({"type":"tmpfs","device":"tmpfs","o":prepared_inputs::INDEXED_VOLUME_OPTIONS}),
        )
        .await
    }
    pub(super) async fn begin_indexed_publication(
        &self,
        spec: &CreateRuntimeSpec,
        mounts: &docker::TerminalMounts,
        binary: &Path,
    ) -> Result<(), BackendError> {
        let Some(files) = &mounts.indexed_files else {
            return Ok(());
        };
        let context = spec
            .terminal
            .as_ref()
            .and_then(|spec| spec.provider_launch_context.as_ref())
            .or_else(|| {
                spec.fresh_agent
                    .as_ref()
                    .and_then(|spec| spec.provider_launch_context.as_ref())
            })
            .ok_or_else(|| fail("input publisher context unavailable"))?;
        let inputs = context
            .prepared_inputs
            .as_ref()
            .ok_or_else(|| fail("input publisher preparation unavailable"))?;
        if files.volume_name
            != freshell_runtime_protocol::indexed_provider_volume_name(
                &spec.soul_id,
                &inputs.generation_id,
            )
        {
            return Err(fail("input publisher volume does not belong to generation"));
        }
        let references = spec
            .terminal
            .as_ref()
            .map(|spec| &spec.provider_secret_references)
            .or_else(|| {
                spec.fresh_agent
                    .as_ref()
                    .map(|spec| &spec.provider_secret_references)
            })
            .ok_or_else(|| fail("input publisher references unavailable"))?;
        inputs
            .validate_references(references)
            .map_err(|_| fail("input publisher source identity mismatch"))?;
        let sources = references
            .iter()
            .filter(|reference| reference.profile.is_configuration_file())
            .map(|reference| PathBuf::from(&reference.source_path))
            .collect::<Vec<_>>();
        let soul = spec.soul_id.to_string();
        {
            let held = self
                .input_publishers
                .lock()
                .map_err(|_| fail("input publisher ownership unavailable"))?;
            if let Some(publisher) = held.get(&files.volume_name) {
                if publisher.soul == soul
                    && publisher.incarnation == spec.incarnation_id.as_str()
                    && publisher.context == *context
                    && publisher.references == *references
                    && publisher.expected["Image"] == spec.image_ref
                    && publisher.expected["HostConfig"]["Mounts"][0]["Source"]
                        == binary.to_string_lossy().as_ref()
                {
                    let mut unexpected = [0];
                    if matches!(publisher.stream.try_read(&mut unexpected), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
                    {
                        return Ok(());
                    }
                    return Err(fail("pending input publisher lease is no longer available"));
                }
                return Err(fail("pending input publisher preparation changed"));
            }
            if held.values().any(|publisher| publisher.soul == soul) {
                return Err(fail(
                    "pending input publisher requires exact preparation reconciliation",
                ));
            }
        }
        {
            let mut claims = self
                .input_publication_claims
                .lock()
                .map_err(|_| fail("input publisher ownership unavailable"))?;
            if !claims.insert(soul.clone()) {
                return Err(fail("input publication already pending for soul"));
            }
        }
        let _claim = PublicationClaim {
            claims: self.input_publication_claims.clone(),
            soul: soul.clone(),
        };
        let directory = native_auth::ExchangeDirectory::create_input()?;
        let socket = directory.0.join("reply.sock");
        let listener = UnixListener::bind(&socket)
            .map_err(|_| fail("input publisher private exchange bind failed"))?;
        directory.mode(&socket, 0o660)?;
        let name = format!("{}-publisher", files.volume_name);
        let ownership = labels(spec, &inputs.generation_id);
        let mut body = helper_body(
            &spec.image_ref,
            &ownership,
            binary,
            &files.volume_name,
            &directory.0,
        );
        let options = volume_options();
        let mut volume_attempted = false;
        let mut helper_attempted = false;
        let operation = async {
            body["Env"] = serde_json::to_value(
                self.private_helper_environment(&spec.image_ref, &[])
                    .await?,
            )
            .map_err(|_| fail("private helper environment encoding failed"))?;
            let prior = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/volumes/{}", files.volume_name),
                    None,
                    1024 * 1024,
                )
                .await
                .map_err(|_| fail("input publisher expected-volume query failed"))?;
            self.check_input_generation_capacity(spec, &files.volume_name)
                .await?;
            if prior.status == 200 {
                let metadata: Value = serde_json::from_slice(&prior.body)
                    .map_err(|_| fail("input volume cold metadata invalid"))?;
                if metadata["Name"] != files.volume_name
                    || metadata["Driver"] != "local"
                    || metadata["Labels"] != ownership
                    || metadata["Options"] != options
                {
                    return Err(fail(
                        "input volume cold ownership changed; preserve preparation",
                    ));
                }
                let cold = self
                    .inspect_cold_publisher(&files.volume_name, &ownership, &spec.image_ref, binary)
                    .await?;
                self.verify_no_input_workloads(
                    &files.volume_name,
                    cold.as_ref().map(|(_, id)| id.as_str()),
                )
                .await?;
                if let Some((expected, _)) = cold {
                    self.cleanup_cold_publisher(&files.volume_name, &expected)
                        .await?;
                }
                self.cleanup_input_volume(&files.volume_name, &ownership, &options)
                    .await?;
                tracing::info!(soul_id=%spec.soul_id,generation_id=%inputs.generation_id,"runtime.input_publication_cold_repopulation");
            } else if prior.status != 404 {
                return Err(fail(
                    "input volume cold ownership unavailable; preserve preparation",
                ));
            }
            volume_attempted = true;
            let volume=self.request_bounded("POST",&format!("{DOCKER_API}/volumes/create"),Some(&json!({"Name":files.volume_name,"Driver":"local","Labels":ownership,"DriverOpts":options})),64*1024).await.map_err(|_|fail("input publisher volume creation acknowledgement unavailable"))?;
            if volume.status != 201 {
                return Err(fail("input publisher volume creation failed"));
            }
            let inspected = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/volumes/{}", files.volume_name),
                    None,
                    1024 * 1024,
                )
                .await
                .map_err(|_| fail("input publisher volume inspection failed"))?;
            let inspected: Value = serde_json::from_slice(&inspected.body)
                .map_err(|_| fail("input publisher volume inspection invalid"))?;
            if inspected["Name"] != files.volume_name
                || inspected["Driver"] != "local"
                || inspected["Options"] != options
                || inspected["Labels"] != ownership
            {
                return Err(fail(
                    "input publisher exact tmpfs volume ownership mismatch",
                ));
            }
            helper_attempted = true;
            let created = self
                .request_bounded(
                    "POST",
                    &format!("{DOCKER_API}/containers/create?name={name}"),
                    Some(&body),
                    64 * 1024,
                )
                .await
                .map_err(|_| fail("input publisher creation acknowledgement unavailable"))?;
            if created.status == 409 {
                helper_attempted = false;
            }
            if created.status != 201 {
                return Err(fail("input publisher creation failed"));
            }
            let created: Value = serde_json::from_slice(&created.body)
                .map_err(|_| fail("input publisher creation invalid"))?;
            let id = created["Id"]
                .as_str()
                .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or_else(|| fail("input publisher identity invalid"))?;
            let start = async {
                let started = self
                    .request_bounded(
                        "POST",
                        &format!("{DOCKER_API}/containers/{id}/start"),
                        None,
                        64 * 1024,
                    )
                    .await
                    .map_err(|_| fail("input publisher start acknowledgement unavailable"))?;
                if started.status != 204 {
                    return Err(fail("input publisher start failed"));
                }
                Ok::<(), BackendError>(())
            };
            let accept = async {
                listener
                    .accept()
                    .await
                    .map(|(stream, _)| stream)
                    .map_err(|_| fail("input publisher private exchange accept failed"))
            };
            let (mut stream, ()) = tokio::try_join!(accept, start)?;
            request(
                &mut stream,
                &Request::Begin {
                    source_ids: (0..sources.len() as u16).collect(),
                },
                Acknowledgement::Begun,
            )
            .await?;
            let mut total = 0u64;
            for (source_id, path) in sources.iter().enumerate() {
                let mut file =
                    open_approved_source(path, MAX_TOTAL_BYTES.saturating_sub(total)).await?;
                request(
                    &mut stream,
                    &Request::Open {
                        source_id: source_id as u16,
                    },
                    Acknowledgement::Opened,
                )
                .await?;
                let mut count = 0u64;
                let mut chunk = vec![0; MAX_CHUNK_BYTES];
                loop {
                    let read = file
                        .read(&mut chunk)
                        .await
                        .map_err(|_| fail("approved input source read failed"))?;
                    if read == 0 {
                        break;
                    }
                    count += read as u64;
                    total += read as u64;
                    if count > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
                        return Err(fail("approved input source actual bytes exceed profile"));
                    }
                    request(
                        &mut stream,
                        &Request::Chunk {
                            bytes: chunk[..read].to_vec(),
                        },
                        Acknowledgement::Written,
                    )
                    .await?;
                }
                request(&mut stream, &Request::Finish, Acknowledgement::Finished).await?;
            }
            request(&mut stream, &Request::Seal, Acknowledgement::Populated).await?;
            Ok::<UnixStream, BackendError>(stream)
        };
        let result = tokio::time::timeout(Duration::from_secs(20), operation)
            .await
            .unwrap_or_else(|_| Err(fail("input publication timed out")));
        match result {
            Ok(stream) => {
                self.input_publishers
                    .lock()
                    .map_err(|_| fail("input publisher ownership unavailable"))?
                    .insert(
                        files.volume_name.clone(),
                        HeldPublisher {
                            soul,
                            incarnation: spec.incarnation_id.to_string(),
                            name,
                            expected: body,
                            context: context.clone(),
                            references: references.clone(),
                            stream,
                            _directory: directory,
                        },
                    );
                tracing::info!(soul_id=%spec.soul_id,generation_id=%inputs.generation_id,source_count=sources.len(),"runtime.input_publication_ready");
                Ok(())
            }
            Err(error) => {
                if helper_attempted {
                    self.cleanup_input_helper(&name, &body).await?;
                }
                if volume_attempted {
                    self.cleanup_input_volume(&files.volume_name, &ownership, &options)
                        .await?;
                }
                Err(error)
            }
        }
    }

    async fn cleanup_input_helper(&self, name: &str, expected: &Value) -> Result<(), BackendError> {
        let cleanup = async {
            let inspected = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/containers/{name}/json"),
                    None,
                    1024 * 1024,
                )
                .await
                .map_err(|_| fail("input publisher cleanup inspection failed"))?;
            if inspected.status == 404 {
                return Ok(());
            }
            if inspected.status != 200 {
                return Err(fail("input publisher cleanup inspection failed"));
            }
            let actual: Value = serde_json::from_slice(&inspected.body)
                .map_err(|_| fail("input publisher cleanup inspection invalid"))?;
            if !owned_helper(&actual, expected) {
                return Err(fail("input publisher cleanup ownership changed"));
            }
            let deleted = self
                .request_bounded(
                    "DELETE",
                    &format!("{DOCKER_API}/containers/{name}?force=1"),
                    None,
                    64 * 1024,
                )
                .await
                .map_err(|_| fail("input publisher cleanup failed"))?;
            if !matches!(deleted.status, 204 | 404) {
                return Err(fail("input publisher cleanup failed"));
            }
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(5), cleanup)
            .await
            .map_err(|_| fail("input publisher cleanup timed out"))?
    }

    async fn cleanup_input_volume(
        &self,
        name: &str,
        ownership: &Value,
        options: &Value,
    ) -> Result<(), BackendError> {
        let cleanup = async {
            let inspected = self
                .request_bounded(
                    "GET",
                    &format!("{DOCKER_API}/volumes/{name}"),
                    None,
                    1024 * 1024,
                )
                .await
                .map_err(|_| fail("input volume cleanup inspection failed"))?;
            if inspected.status == 404 {
                return Ok(());
            }
            if inspected.status != 200 {
                return Err(fail("input volume cleanup inspection failed"));
            }
            let actual: Value = serde_json::from_slice(&inspected.body)
                .map_err(|_| fail("input volume cleanup inspection invalid"))?;
            if actual["Name"] != name
                || actual["Driver"] != "local"
                || actual["Labels"] != *ownership
                || actual["Options"] != *options
            {
                return Err(fail("input volume cleanup ownership changed"));
            }
            let deleted = self
                .request_bounded(
                    "DELETE",
                    &format!("{DOCKER_API}/volumes/{name}"),
                    None,
                    64 * 1024,
                )
                .await
                .map_err(|_| fail("input volume cleanup failed"))?;
            if !matches!(deleted.status, 204 | 404) {
                return Err(fail(
                    "input volume cleanup failed; preserve generation for reconciliation",
                ));
            }
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(5), cleanup)
            .await
            .map_err(|_| fail("input volume cleanup timed out"))?
    }

    pub(super) async fn retire_prior_indexed_inputs(
        &self,
        current: &OwnedRuntimeHandle,
        prior: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        fn context(
            handle: &OwnedRuntimeHandle,
        ) -> Option<&freshell_runtime_protocol::ProviderLaunchContext> {
            handle
                .terminal()
                .and_then(|v| v.provider_launch_context.as_ref())
                .or_else(|| {
                    handle
                        .fresh_agent()
                        .and_then(|v| v.provider_launch_context.as_ref())
                })
        }
        let Some(inputs) = context(prior).and_then(|v| v.prepared_inputs.as_ref()) else {
            return Ok(());
        };
        let Some(files) = inputs.indexed_files.as_ref() else {
            return Ok(());
        };
        let next = context(current)
            .and_then(|v| v.prepared_inputs.as_ref())
            .ok_or_else(|| fail("accepted current input generation unavailable; preserve prior"))?;
        if current.installation_id() != prior.installation_id()
            || current.soul_id() != prior.soul_id()
            || current.incarnation_id() == prior.incarnation_id()
        {
            return Err(fail(
                "prior input retirement owner changed; preserve generation",
            ));
        }
        if next.generation_id == inputs.generation_id {
            return Ok(());
        }
        if files.volume_name
            != freshell_runtime_protocol::indexed_provider_volume_name(
                prior.soul_id(),
                &inputs.generation_id,
            )
        {
            return Err(fail("prior input generation identity changed"));
        }
        let ownership = json!({"com.freshell.managed-inputs":"true","com.freshell.installation-id":prior.installation_id(),"com.freshell.soul-id":prior.soul_id(),"com.freshell.incarnation-id":prior.incarnation_id(),"com.freshell.input-generation":inputs.generation_id});
        let operation = async {
            let state = self.inspect(prior).await?.state;
            match state {
                BackendRuntimeState::Missing => {}
                BackendRuntimeState::Created
                | BackendRuntimeState::Exited
                | BackendRuntimeState::Dead => {
                    // Docker refuses removal if this exact proved object becomes
                    // running again. Retirement never forces a workload stop.
                    let removed = self
                        .request_bounded(
                            "DELETE",
                            &format!("{DOCKER_API}/containers/{}?force=0", prior.container_id()),
                            None,
                            64 * 1024,
                        )
                        .await?;
                    if !matches!(removed.status, 204 | 404) {
                        return Err(fail(
                            "prior input workload removal uncertain; preserve generation",
                        ));
                    }
                }
                _ => {
                    return Err(fail(
                        "prior input workload remains live or uncertain; preserve generation",
                    ))
                }
            }
            self.release_indexed_publication(
                prior.soul_id(),
                prior.incarnation_id(),
                &inputs.generation_id,
                &ownership,
                prior.image_ref(),
                prior.host_binary_path(),
            )
            .await?;
            self.verify_no_input_workloads(&files.volume_name, None)
                .await?;
            self.cleanup_input_volume(&files.volume_name, &ownership, &volume_options())
                .await?;
            tracing::info!(soul_id=%prior.soul_id(),prior_incarnation_id=%prior.incarnation_id(),generation_id=%inputs.generation_id,"runtime.input_publication_prior_retired");
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(20), operation)
            .await
            .map_err(|_| fail("prior input retirement timed out; preserve uncertain generation"))?
    }

    pub(super) async fn release_indexed_publication(
        &self,
        soul: &SoulId,
        incarnation: &IncarnationId,
        generation: &str,
        ownership: &Value,
        image: &str,
        binary: &Path,
    ) -> Result<(), BackendError> {
        let volume = freshell_runtime_protocol::indexed_provider_volume_name(soul, generation);
        let held = self
            .input_publishers
            .lock()
            .map_err(|_| fail("input publisher ownership unavailable"))?
            .remove(&volume);
        let Some(mut held) = held else {
            if let Some((expected, _)) = self
                .inspect_cold_publisher(&volume, ownership, image, binary)
                .await?
            {
                self.cleanup_cold_publisher(&volume, &expected).await?;
                tracing::info!(soul_id=%soul,generation_id=generation,"runtime.input_publication_cold_release");
            }
            return Ok(());
        };
        if held.soul != soul.as_str() || held.incarnation != incarnation.as_str() {
            self.input_publishers
                .lock()
                .map_err(|_| fail("input publisher ownership unavailable"))?
                .insert(volume, held);
            return Err(fail("input publisher release belongs to another attempt"));
        }
        let released = tokio::time::timeout(
            Duration::from_secs(5),
            request(
                &mut held.stream,
                &Request::Release,
                Acknowledgement::Released,
            ),
        )
        .await;
        let cleanup = self.cleanup_input_helper(&held.name, &held.expected).await;
        if cleanup.is_err() {
            self.input_publishers
                .lock()
                .map_err(|_| fail("input publisher ownership unavailable"))?
                .insert(volume, held);
        }
        cleanup?;
        if !matches!(released, Ok(Ok(()))) {
            tracing::warn!(soul_id=%soul,generation_id=generation,"runtime.input_publication_release_without_ack");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn provider_input_publisher_commit_without_indexed_descriptor_needs_no_daemon() {
        let owned = tempfile::tempdir().unwrap();
        let terminal: TerminalLaunchSpec = serde_json::from_value(json!({
            "terminalId":"terminal-nonindexed","streamId":"stream-nonindexed","mode":"codex","program":"codex",
            "cwd":"/fixture/workspace","workspacePath":"/fixture/workspace","runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"project-nonindexed",
            "providerLaunchContext":{
                "preparation":{"codex":{"tui_args":[],"sidecar_args":[]}},
                "mcpCapability":{"grantId":"grant-nonindexed","endpoint":"http://host.docker.internal:3344","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":"grant-nonindexed","manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":0,"aliasCount":0,"recipeCount":0}}
            }
        })).unwrap();
        terminal.validate().unwrap();
        let handle = crate::registry::OwnedRuntimeHandle::from_registry(
            InstallationId::parse("installation-nonindexed").unwrap(),
            SoulId::parse("soul-nonindexed").unwrap(),
            IncarnationId::parse("incarnation-nonindexed").unwrap(),
            freshell_runtime_protocol::LaunchNonce::new(),
            DockerDaemonId::parse("daemon-nonindexed").unwrap(),
            "c".repeat(64),
            format!("sha256:{}", "a".repeat(64)),
            owned.path().join("runtime"),
            owned.path().join("session-host"),
            "d".repeat(64),
            RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            None,
            Some(terminal),
            None,
            "freshell-provider-nonindexed".into(),
        );
        // There is intentionally no daemon/socket: ordinary prepared inputs
        // never created an indexed publisher, so their commit must be inert.
        let backend = DockerEngineBackend::new(owned.path().join("absent-daemon.sock"));
        let committed = backend.commit_prepared_inputs(&handle).await;
        drop(backend);
        assert!(
            committed.is_ok(),
            "nonindexed commit must not inspect or retire a publisher: {committed:?}"
        );
    }

    #[tokio::test]
    async fn provider_input_publisher_rechecks_actual_capacity_before_payload_read() {
        use std::os::unix::fs::MetadataExt;
        use std::time::{Duration, UNIX_EPOCH};

        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("approved-source");
        for (bytes, remaining) in [
            (MAX_FILE_BYTES + 1, MAX_TOTAL_BYTES),
            (MAX_FILE_BYTES, MAX_FILE_BYTES - 1),
        ] {
            let file = std::fs::File::create(&source).unwrap();
            file.set_len(bytes).unwrap();
            file.set_times(
                std::fs::FileTimes::new().set_accessed(UNIX_EPOCH + Duration::from_secs(1)),
            )
            .unwrap();
            drop(file);
            let result = open_approved_source(&source, remaining).await;
            let rejected = match result {
                Err(error) => {
                    assert!(error.to_string().contains("exceed"));
                    true
                }
                Ok(mut reader) => {
                    let mut byte = [0];
                    reader.read_exact(&mut byte).await.unwrap();
                    false
                }
            };
            assert!(
                rejected,
                "fresh oversized payload must be rejected before reading"
            );
            assert_eq!(std::fs::metadata(&source).unwrap().atime(), 1);
        }

        let file = std::fs::File::create(&source).unwrap();
        file.set_len(MAX_FILE_BYTES).unwrap();
        drop(file);
        let mut reader = open_approved_source(&source, MAX_FILE_BYTES).await.unwrap();
        let mut bytes = [0; MAX_CHUNK_BYTES];
        let mut observed = 0u64;
        loop {
            let count = reader.read(&mut bytes).await.unwrap();
            if count == 0 {
                break;
            }
            assert!(bytes[..count].iter().all(|byte| *byte == 0));
            observed += count as u64;
        }
        assert_eq!(observed, MAX_FILE_BYTES);

        std::fs::write(&source, []).unwrap();
        let mut reader = open_approved_source(&source, 0).await.unwrap();
        assert_eq!(reader.read(&mut [0]).await.unwrap(), 0);

        // Growth after acceptance remains bounded by the same one-byte
        // lookahead used by the publisher's streaming count checks.
        let mut reader = open_approved_source(&source, 1).await.unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(3)
            .unwrap();
        assert_eq!(reader.read(&mut bytes).await.unwrap(), 2);
        assert_eq!(reader.read(&mut bytes).await.unwrap(), 0);
    }

    #[test]
    fn provider_input_helper_accepts_docker_inherited_labels_and_omitted_false_without_losing_owner_fences(
    ) {
        let expected = json!({"Image":"sha256:fixture","User":"0:0","Tty":false,"Entrypoint":["/runtime/host"],"Cmd":["prepare-provider-mountpoints"],
            "Env":["PATH="],"Labels":{"com.freshell.soul-id":"soul-owned"},
            "HostConfig":{"LogConfig":{"Type":"none"},"Mounts":[{"Type":"volume","Source":"owned-provider","Target":"/home/freshell/provider","ReadOnly":false,"VolumeOptions":{"NoCopy":true}}]}});
        let mut actual = json!({"Config":expected,"HostConfig":expected["HostConfig"]});
        actual["Config"]["Labels"]["org.opencontainers.image.version"] = json!("24.04");
        actual["HostConfig"]["Mounts"][0]
            .as_object_mut()
            .unwrap()
            .remove("ReadOnly");
        assert!(owned_helper(&actual,&expected),"native Docker omitted defaults and inherited image labels preserve the exact helper owner");
        for field in ["owner", "source", "nocopy", "readonly", "extra-owner"] {
            let mut changed = actual.clone();
            match field {
                "owner" => changed["Config"]["Labels"]["com.freshell.soul-id"] = json!("foreign"),
                "source" => {
                    changed["HostConfig"]["Mounts"][0]["Source"] = json!("foreign-provider")
                }
                "nocopy" => {
                    changed["HostConfig"]["Mounts"][0]["VolumeOptions"]["NoCopy"] = json!(false)
                }
                "readonly" => changed["HostConfig"]["Mounts"][0]["ReadOnly"] = json!(true),
                _ => {
                    changed["Config"]["Labels"]["com.freshell.incarnation-id"] =
                        json!("foreign-attempt")
                }
            }
            assert!(!owned_helper(&changed, &expected), "{field}");
        }
    }
    use std::sync::{Arc, Mutex};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn provider_input_publisher_streams_only_private_ipc_and_pins_tmpfs_before_workload_creation(
    ) {
        publication_fixture(PublicationCase::WarmCommit).await;
    }

    #[tokio::test]
    async fn provider_input_publisher_abort_removes_only_the_pending_owned_generation() {
        publication_fixture(PublicationCase::WarmAbort).await;
    }

    #[tokio::test]
    async fn provider_input_publisher_cold_backend_repopulates_confirmed_undispatched_generation() {
        publication_fixture(PublicationCase::ColdRetry).await;
    }
    #[tokio::test]
    async fn provider_input_publisher_cold_abort_removes_exact_helper_and_volume() {
        publication_fixture(PublicationCase::ColdAbort).await;
    }
    #[tokio::test]
    async fn provider_input_publisher_cold_backend_preserves_uncertain_workload_reference() {
        publication_fixture(PublicationCase::ColdUncertain).await;
    }
    #[derive(Clone, Copy)]
    enum PublicationCase {
        WarmCommit,
        WarmAbort,
        ColdRetry,
        ColdAbort,
        ColdUncertain,
        ColdAcceptedRelease,
        ColdCapacity,
        ColdRetirement,
    }
    #[tokio::test]
    async fn provider_input_publisher_cold_accepted_release_preserves_workload_volume() {
        publication_fixture(PublicationCase::ColdAcceptedRelease).await;
    }
    #[tokio::test]
    async fn provider_input_publisher_cold_inventory_bounds_one_active_and_one_pending() {
        publication_fixture(PublicationCase::ColdCapacity).await;
    }
    #[tokio::test]
    async fn provider_input_publisher_cold_retirement_removes_only_the_prior_accepted_generation() {
        publication_fixture(PublicationCase::ColdRetirement).await;
    }
    async fn publication_fixture(case: PublicationCase) {
        let abort = matches!(
            case,
            PublicationCase::WarmAbort
                | PublicationCase::ColdAbort
                | PublicationCase::ColdUncertain
        );
        let cold = !matches!(
            case,
            PublicationCase::WarmCommit | PublicationCase::WarmAbort
        );
        let uncertain = matches!(case, PublicationCase::ColdUncertain);
        let accepted = matches!(case, PublicationCase::ColdAcceptedRelease);
        let capacity = matches!(case, PublicationCase::ColdCapacity);
        let retirement = matches!(case, PublicationCase::ColdRetirement);
        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("approved-source");
        std::fs::write(&source, b"PRIVATE_PUBLISHER_SENTINEL").unwrap();
        let binary = owned.path().join("session-host");
        std::fs::write(&binary, b"host").unwrap();
        let volume_root = owned.path().join("indexed-volume");
        std::fs::create_dir(&volume_root).unwrap();
        let soul = SoulId::parse("soul-input-publisher").unwrap();
        let generation = "grant-input-publisher";
        let volume_name =
            freshell_runtime_protocol::indexed_provider_volume_name(&soul, generation);
        let terminal:TerminalLaunchSpec=serde_json::from_value(json!({
            "terminalId":"terminal-input","streamId":"stream-input","mode":"opencode","program":"opencode",
            "cwd":"/fixture/workspace","workspacePath":"/fixture/workspace","runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"project-input",
            "providerSecretReferences":[{"sourcePath":source,"profile":"opencode_configuration_file","providerRelativePath":".freshell/references/0"}],
            "providerLaunchContext":{
                "preparation":{"opencode":{"project_config":[],"tui_config":null}},
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:3344","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":1,"aliasCount":1,"recipeCount":0},
                    "indexedFiles":{"volumeName":volume_name,"aliases":[{"sourceId":0,"logicalDestination":"/outside/selected","effectiveDestination":"/outside/selected"}]}}
            }
        })).unwrap();
        terminal.validate().unwrap();
        let spec = CreateRuntimeSpec {
            prior_provider_owner: None,
            initial_input_reservation: None,
            installation_id: InstallationId::parse("installation-input").unwrap(),
            soul_id: soul,
            incarnation_id: IncarnationId::parse("incarnation-input").unwrap(),
            image_ref: format!("sha256:{}", "a".repeat(64)),
            host_binary_path: binary.clone(),
            runtime_dir: owned.path().join("runtime"),
            limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            test_run_id: "input-publication-fixture".into(),
            terminal: Some(terminal),
            fresh_agent: None,
            provider_volume_name: "freshell-provider-owned-input".into(),
        };
        let mounts = docker::TerminalMounts {
            workspace: "/fixture/workspace".into(),
            git_common_dir: None,
            provider_bootstrap_files: vec![],
            provider_secret_files: vec![source.clone()],
            indexed_secret_sources: BTreeMap::from([(0, 0)]),
            provider_user_root: None,
            mcp_capability_file: None,
            input_manifest: None,
            config_binds: vec![],
            resource_mounts: vec![],
            indexed_files: spec
                .terminal
                .as_ref()
                .unwrap()
                .provider_launch_context
                .as_ref()
                .unwrap()
                .prepared_inputs
                .as_ref()
                .unwrap()
                .indexed_files
                .clone(),
        };
        let socket = owned.path().join("docker.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let captured = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
        let seen = captured.clone();
        let created = Arc::new(Mutex::new(None::<Value>));
        let volume = Arc::new(Mutex::new(None::<Value>));
        let helper = Arc::new(Mutex::new(
            None::<std::thread::JoinHandle<Result<(), &'static str>>>,
        ));
        let active_helper = helper.clone();
        let workload = Arc::new(Mutex::new(false));
        let workload_for_server = workload.clone();
        let over_capacity = Arc::new(Mutex::new(false));
        let over_capacity_for_server = over_capacity.clone();
        let private_root = volume_root.clone();
        let created_for_server = created.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (seen, created, volume, helper, private_root, workload, over_capacity) = (
                    seen.clone(),
                    created_for_server.clone(),
                    volume.clone(),
                    active_helper.clone(),
                    private_root.clone(),
                    workload_for_server.clone(),
                    over_capacity_for_server.clone(),
                );
                tokio::spawn(async move {
                    let mut header = Vec::new();
                    let mut byte = [0];
                    while !header.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).await.unwrap();
                        header.push(byte[0]);
                    }
                    let header = String::from_utf8(header).unwrap();
                    let length = header
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    let mut body = vec![0; length];
                    stream.read_exact(&mut body).await.unwrap();
                    let request = header.lines().next().unwrap().to_string();
                    seen.lock().unwrap().push((request.clone(), body.clone()));
                    let (status, reply) = if request.contains("/info ") {
                        (200,json!({"ID":"input-publisher-daemon","SecurityOptions":["name=rootless"]}).to_string())
                    } else if request.contains(&format!("/containers/{}/json ", "c".repeat(64))) {
                        (404, String::new())
                    } else if request.contains("/images/") {
                        (200,json!({"Config":{"Env":["PATH=/image/path","INHERITED_TOKEN=PRIVATE_IMAGE_SENTINEL"]}}).to_string())
                    } else if request.contains("/volumes?filters=") {
                        let mut values = volume.lock().unwrap().iter().cloned().collect::<Vec<_>>();
                        if *over_capacity.lock().unwrap() {
                            for generation in ["grant-extra-one", "grant-extra-two"] {
                                let mut extra = values[0].clone();
                                let soul = SoulId::parse(
                                    extra["Labels"]["com.freshell.soul-id"].as_str().unwrap(),
                                )
                                .unwrap();
                                extra["Name"] =
                                    json!(freshell_runtime_protocol::indexed_provider_volume_name(
                                        &soul, generation
                                    ));
                                extra["Labels"]["com.freshell.input-generation"] =
                                    json!(generation);
                                values.push(extra);
                            }
                        }
                        (200, json!({"Volumes":values}).to_string())
                    } else if request.contains("/containers/json?") {
                        let mut users = Vec::new();
                        if created.lock().unwrap().is_some() {
                            users.push(json!({"Id":"b".repeat(64)}));
                        }
                        if *workload.lock().unwrap() {
                            users.push(json!({"Id":"c".repeat(64)}));
                        }
                        (200, serde_json::to_string(&users).unwrap())
                    } else if request.contains("/volumes/create ") {
                        if private_root.join("files").exists() {
                            std::fs::remove_dir_all(private_root.join("files")).unwrap();
                        }
                        let mut value: Value = serde_json::from_slice(&body).unwrap();
                        value["Mountpoint"] = json!("/owned/daemon/volume");
                        value["Options"] = value["DriverOpts"].clone();
                        *volume.lock().unwrap() = Some(value.clone());
                        (201, value.to_string())
                    } else if request.starts_with("DELETE ") && request.contains("/volumes/") {
                        *volume.lock().unwrap() = None;
                        (204, String::new())
                    } else if request.contains("/volumes/") {
                        match volume.lock().unwrap().as_ref() {
                            Some(value) => (200, value.to_string()),
                            None => (404, String::new()),
                        }
                    } else if request.contains("/containers/create?") {
                        *created.lock().unwrap() = Some(serde_json::from_slice(&body).unwrap());
                        (201, json!({"Id":"b".repeat(64)}).to_string())
                    } else if request.contains("/start ") {
                        let config = created.lock().unwrap().clone().unwrap();
                        let directory = config["HostConfig"]["Mounts"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|mount| mount["Target"] == "/run/freshell-input-exchange")
                            .unwrap()["Source"]
                            .as_str()
                            .unwrap()
                            .to_owned();
                        *helper.lock().unwrap() = Some(std::thread::spawn(move || {
                            freshell_platform::provider_input_exchange::serve(
                                &private_root,
                                &Path::new(&directory).join("reply.sock"),
                            )
                        }));
                        (204, String::new())
                    } else if request.contains("/json ") {
                        match created.lock().unwrap().clone() {
                            Some(mut config) => {
                                config["HostConfig"]["Mounts"][0]["Consistency"] = json!("default");
                                (200,json!({"Id":"b".repeat(64),"Name":format!("/{}-publisher",config["HostConfig"]["Mounts"][1]["Source"].as_str().unwrap()),"Config":config,"HostConfig":config["HostConfig"],"State":{"Status":"running"}}).to_string())
                            }
                            None => (404, String::new()),
                        }
                    } else if request.starts_with("DELETE ") {
                        *created.lock().unwrap() = None;
                        (204, String::new())
                    } else {
                        panic!("unexpected owned Docker request {request}");
                    };
                    let response=format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let backend = DockerEngineBackend::new(&socket);
        backend
            .begin_indexed_publication(&spec, &mounts, &binary)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(volume_root.join("files/source-0")).unwrap(),
            b"PRIVATE_PUBLISHER_SENTINEL"
        );
        assert!(
            !helper.lock().unwrap().as_ref().unwrap().is_finished(),
            "publisher must pin completed tmpfs before workload creation"
        );
        if cold {
            let expected_helper = created.lock().unwrap().clone().unwrap();
            drop(backend);
            // The original controller disappears. Its helper sees EOF and is
            // joined before any fresh constructor attempts reconciliation.
            assert!(helper
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .join()
                .unwrap()
                .is_err());
            let fresh = DockerEngineBackend::new(&socket);
            *workload.lock().unwrap() = uncertain || accepted;
            *over_capacity.lock().unwrap() = capacity;
            std::fs::write(&source, b"FRESH_APPROVED_PUBLISHER_BYTES").unwrap();
            let result = if retirement {
                let make_handle = |candidate: &CreateRuntimeSpec| {
                    crate::registry::OwnedRuntimeHandle::from_registry(
                        candidate.installation_id.clone(),
                        candidate.soul_id.clone(),
                        candidate.incarnation_id.clone(),
                        freshell_runtime_protocol::LaunchNonce::new(),
                        DockerDaemonId::parse("input-publisher-daemon").unwrap(),
                        "c".repeat(64),
                        candidate.image_ref.clone(),
                        candidate.runtime_dir.clone(),
                        binary.clone(),
                        digest_expected(&ExpectedConfig::new(
                            candidate,
                            &binary,
                            &candidate.runtime_dir,
                        ))
                        .unwrap(),
                        candidate.limits,
                        None,
                        candidate.terminal.clone(),
                        None,
                        candidate.provider_volume_name.clone(),
                    )
                };
                let prior = make_handle(&spec);
                let mut next = spec.clone();
                next.incarnation_id = IncarnationId::parse("incarnation-current").unwrap();
                let context = next
                    .terminal
                    .as_mut()
                    .unwrap()
                    .provider_launch_context
                    .as_mut()
                    .unwrap();
                context.prepared_inputs.as_mut().unwrap().generation_id = "grant-current".into();
                context
                    .prepared_inputs
                    .as_mut()
                    .unwrap()
                    .indexed_files
                    .as_mut()
                    .unwrap()
                    .volume_name = freshell_runtime_protocol::indexed_provider_volume_name(
                    &spec.soul_id,
                    "grant-current",
                );
                fresh
                    .retire_prior_prepared_inputs(&make_handle(&next), &prior)
                    .await
            } else if accepted {
                fresh
                    .release_indexed_publication(
                        &spec.soul_id,
                        &spec.incarnation_id,
                        generation,
                        &labels(&spec, generation),
                        &spec.image_ref,
                        &binary,
                    )
                    .await
            } else if abort {
                fresh.abort_indexed_publication(&spec).await
            } else {
                fresh
                    .begin_indexed_publication(&spec, &mounts, &binary)
                    .await
            };
            let observed_deletes = captured
                .lock()
                .unwrap()
                .iter()
                .filter(|(request, _)| request.starts_with("DELETE "))
                .count();
            let progressed = result.is_ok()
                && if accepted {
                    observed_deletes == 1
                        && std::fs::read(volume_root.join("files/source-0")).unwrap()
                            == b"PRIVATE_PUBLISHER_SENTINEL"
                } else if abort || retirement {
                    observed_deletes == 2
                } else {
                    std::fs::read(volume_root.join("files/source-0"))
                        .is_ok_and(|bytes| bytes == b"FRESH_APPROVED_PUBLISHER_BYTES")
                };
            let preserved = (uncertain || capacity)
                && result.is_err()
                && observed_deletes == 0
                && std::fs::read(volume_root.join("files/source-0")).unwrap()
                    == b"PRIVATE_PUBLISHER_SENTINEL";
            *workload.lock().unwrap() = false;
            *over_capacity.lock().unwrap() = false;
            // Always settle exact fixture ownership before asserting RED.
            if !abort && progressed && !accepted {
                fresh.abort_indexed_publication(&spec).await.unwrap();
            } else {
                fresh
                    .cleanup_input_helper(&format!("{volume_name}-publisher"), &expected_helper)
                    .await
                    .unwrap();
                fresh.cleanup_input_volume(&volume_name,&labels(&spec,generation),&json!({"type":"tmpfs","device":"tmpfs","o":prepared_inputs::INDEXED_VOLUME_OPTIONS})).await.unwrap();
            }
            if let Some(thread) = helper.lock().unwrap().take() {
                assert!(thread.join().unwrap().is_ok());
            }
            drop(fresh);
            server.abort();
            let _ = server.await;
            assert!(if uncertain || capacity {preserved} else {progressed},"fresh backend must reconcile only exact undispatched ownership; result={result:?}, deletes={observed_deletes}");
            return;
        }
        // A lost workload-create acknowledgement retries the same frozen
        // preparation. It must reuse the pinned bytes, even after the source
        // disappears, rather than publish a second generation.
        std::fs::remove_file(&source).unwrap();
        let before_retry = captured.lock().unwrap().len();
        backend
            .begin_indexed_publication(&spec, &mounts, &binary)
            .await
            .unwrap();
        assert_eq!(captured.lock().unwrap().len(), before_retry);
        let mut changed = spec.clone();
        changed
            .terminal
            .as_mut()
            .unwrap()
            .provider_launch_context
            .as_mut()
            .unwrap()
            .prepared_inputs
            .as_mut()
            .unwrap()
            .manifest
            .sha256 = "b".repeat(64);
        assert!(backend
            .begin_indexed_publication(&changed, &mounts, &binary)
            .await
            .is_err());
        assert_eq!(captured.lock().unwrap().len(), before_retry);
        for (_, body) in captured.lock().unwrap().iter() {
            assert!(!String::from_utf8_lossy(body).contains("PRIVATE_PUBLISHER_SENTINEL"));
            assert!(!String::from_utf8_lossy(body).contains("PRIVATE_IMAGE_SENTINEL"));
        }
        assert!(created.lock().unwrap().as_ref().unwrap()["Env"]
            .as_array()
            .unwrap()
            .contains(&json!("INHERITED_TOKEN=")));
        if abort {
            backend.abort_indexed_publication(&spec).await.unwrap();
        } else {
            backend
                .release_indexed_publication(
                    &spec.soul_id,
                    &spec.incarnation_id,
                    generation,
                    &labels(&spec, generation),
                    &spec.image_ref,
                    &spec.host_binary_path,
                )
                .await
                .unwrap();
        }
        assert_eq!(
            captured
                .lock()
                .unwrap()
                .iter()
                .filter(
                    |(request, _)| request.starts_with("DELETE ") && request.contains("/volumes/")
                )
                .count(),
            usize::from(abort)
        );
        assert!(helper
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .join()
            .unwrap()
            .is_ok());
        drop(backend);
        server.abort();
        let _ = server.await;
    }
}

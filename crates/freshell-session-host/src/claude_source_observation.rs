//! One finite metadata request from an owned parent. No provider is dispatched;
//! request and reply bodies use private pipes, never command arguments or logs.
use freshell_platform::claude_inputs::observation::{
    observe, ObservationReply, ObservationRequest, MAX_REPLY_BYTES, MAX_REQUEST_BYTES,
};
use freshell_runtime_protocol::{RuntimeError, RuntimeErrorCode};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub(crate) async fn verify_final(
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    stage: &std::path::Path,
    cwd: &std::path::Path,
    home: &std::path::Path,
    uid: u32,
    gid: u32,
    runtime: freshell_platform::claude_inputs::NativeSourceRuntime,
) -> Result<(), RuntimeError> {
    use freshell_runtime_protocol::bounded_json_bytes;
    let Some((request, expected)) = crate::provider_input_preparation::final_claude_source_request(
        context, stage, cwd, home, runtime,
    )
    .map_err(|reason| final_source_error(RuntimeErrorCode::HostUnreachable, reason))?
    else {
        return Ok(());
    };
    if (expected.uid, expected.euid, expected.gid, expected.egid) != (uid, uid, gid, gid) {
        return Err(final_source_error(
            RuntimeErrorCode::ProviderInputsChanged,
            "Claude actual provider identity differs from accepted inputs",
        ));
    }
    let raw = bounded_json_bytes(&request, MAX_REQUEST_BYTES).map_err(|_| {
        final_source_error(
            RuntimeErrorCode::HostUnreachable,
            "Claude final source request exceeds its finite metadata profile",
        )
    })?;
    let request_sha256 = format!("{:x}", Sha256::digest(raw));
    let executable = std::env::current_exe().map_err(|_| {
        final_source_error(
            RuntimeErrorCode::HostUnreachable,
            "Claude final source reader artifact unavailable",
        )
    })?;
    let mut command = tokio::process::Command::new("/usr/bin/setpriv");
    command
        .args(crate::provider_identity_args(uid, gid))
        .arg(executable)
        .arg("observe-claude-sources")
        .current_dir(cwd)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let started = std::time::Instant::now();
    let mut child = command.spawn().map_err(|_| {
        final_source_error(
            RuntimeErrorCode::HostUnreachable,
            "Claude final source reader could not start",
        )
    })?;
    let reader_pid = child.id();
    tracing::info!(
        event = "provider.inputs.native_final.started",
        provider = "claude",
        stage = "session_host",
        reader_pid,
        uid,
        gid,
        "Observing final native provider source selection"
    );
    let result = verify_final_child(
        &mut child,
        &request,
        &request_sha256,
        &expected,
        std::time::Duration::from_secs(20),
        std::time::Duration::from_secs(5),
    )
    .await;
    match &result {
        Ok(()) => tracing::info!(
            event = "provider.inputs.native_final.completed",
            provider = "claude",
            stage = "session_host",
            reader_pid,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "Final native provider source selection agrees"
        ),
        Err(reason) => {
            tracing::warn!(event="provider.inputs.native_final.blocked",provider="claude",stage="session_host",
            reader_pid,elapsed_ms=started.elapsed().as_millis() as u64,code=?reason.code,cause=%reason.message,"Final native provider source selection unavailable or changed")
        }
    }
    result
}

fn final_source_error(code: RuntimeErrorCode, reason: impl Into<String>) -> RuntimeError {
    let reason = reason.into();
    RuntimeError::new(
        code,
        if reason.contains("retain inputs and reprepare") {
            reason
        } else {
            format!("{reason}; retain inputs and reprepare")
        },
    )
}

async fn read_final_child(
    child: &mut tokio::process::Child,
    request: &ObservationRequest,
    request_sha256: &str,
    exchange_timeout: std::time::Duration,
    cleanup_timeout: std::time::Duration,
) -> Result<ObservationReply, String> {
    use freshell_runtime_protocol::{read_frame_with_limit, write_frame_with_limit};
    use tokio::io::AsyncReadExt;
    let exchange = async {
        let mut input = child
            .stdin
            .take()
            .ok_or("Claude final source pipe unavailable")?;
        let mut output = child
            .stdout
            .take()
            .ok_or("Claude final source pipe unavailable")?;
        write_frame_with_limit(&mut input, request, MAX_REQUEST_BYTES)
            .await
            .map_err(|_| "Claude final source request incomplete")?;
        drop(input);
        let reply: ObservationReply = read_frame_with_limit(&mut output, MAX_REPLY_BYTES)
            .await
            .map_err(|_| {
                "Claude final source evidence unavailable or exceeds its finite profile"
            })?;
        let mut trailing = [0];
        if output
            .read(&mut trailing)
            .await
            .map_err(|_| "Claude final reader completion unavailable")?
            != 0
        {
            return Err("Claude final reader emitted extra evidence");
        }
        // A complete pipe reply is not process completion. Keep its owned
        // process join inside the exchange deadline so a reader that closes
        // stdout but remains alive enters the same bounded kill/wait cleanup.
        let status = child
            .wait()
            .await
            .map_err(|_| "Claude final source reader completion unavailable")?;
        Ok((reply, status))
    };
    let exchange = tokio::time::timeout(exchange_timeout, exchange).await;
    let completed = match exchange {
        Ok(result) => result.map_err(str::to_string),
        Err(_) => Err("Claude final source reader timed out".to_string()),
    };
    let (reply, status) = match completed {
        Ok(completed) => completed,
        Err(reason) => {
            let cleanup = async {
                child
                    .start_kill()
                    .map_err(|_| "Claude final source reader termination failed")?;
                child
                    .wait()
                    .await
                    .map_err(|_| "Claude final source reader join failed")
            };
            tokio::time::timeout(cleanup_timeout, cleanup)
                .await
                .map_err(|_| "Claude final source reader cleanup timed out")??;
            return Err(reason);
        }
    };
    if !status.success() {
        return Err("Claude final source reader failed without complete evidence".to_string());
    }
    reply.validate_for_request(request, request_sha256)?;
    Ok(reply)
}

async fn verify_final_child(
    child: &mut tokio::process::Child,
    request: &ObservationRequest,
    request_sha256: &str,
    expected: &freshell_platform::claude_inputs::observation::NativeObservation,
    exchange_timeout: std::time::Duration,
    cleanup_timeout: std::time::Duration,
) -> Result<(), RuntimeError> {
    // Transport, binding and cleanup failures provide no selection evidence.
    // Only two complete validated observations can establish a source change.
    let reply = read_final_child(
        child,
        request,
        request_sha256,
        exchange_timeout,
        cleanup_timeout,
    )
    .await
    .map_err(|reason| final_source_error(RuntimeErrorCode::HostUnreachable, reason))?;
    expected
        .validate()
        .map_err(|reason| final_source_error(RuntimeErrorCode::HostUnreachable, reason))?;
    expected
        .require_same_selection(&reply.observation)
        .map_err(|reason| final_source_error(RuntimeErrorCode::ProviderInputsChanged, reason))
}

pub(crate) fn serve_stdio() -> Result<(), String> {
    exchange(&mut std::io::stdin().lock(), &mut std::io::stdout().lock())
}

fn project_candidate(
    request: &freshell_runtime_protocol::ClaudeCandidateProjectionRequest,
    stage: &std::path::Path,
    home: &std::path::Path,
    identity: (u32, u32),
) -> Result<(), String> {
    let unavailable = |operation: &'static str| {
        tracing::warn!(
            event = "provider.inputs.candidate_projection.blocked",
            provider = "claude",
            stage = "candidate",
            operation,
            "Candidate ordinary projection unavailable"
        );
        format!("Claude candidate {operation} unavailable; retain inputs and reprepare")
    };
    request.validate().map_err(|_| unavailable("metadata"))?;
    let published = crate::provider_input_preparation::read_private(
        stage,
        ".freshell/claude-candidate-binding.json",
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
    )
    .map_err(|_| unavailable("publication"))?;
    let binding = request
        .source_request
        .candidate_binding
        .as_ref()
        .ok_or_else(|| unavailable("publication"))?;
    if format!("{:x}", Sha256::digest(&published)) != binding.publication_sha256 {
        return Err(unavailable("publication"));
    }
    crate::verify_initialized_provider_home(home, identity.0, identity.1)
        .map_err(|_| unavailable("initialized_home"))?;
    let source = &request.source_request;
    let Some((accepted, expected)) =
        crate::provider_input_preparation::final_claude_source_request(
            Some(&request.provider_launch_context),
            stage,
            &source.cwd,
            home,
            source.native_source_runtime,
        )
        .map_err(|_| unavailable("accepted_manifest"))?
    else {
        return Err(unavailable("accepted_manifest"));
    };
    if source.home != home
        || source.selector_manifest_sha256 != accepted.selector_manifest_sha256
        || source.plan_revision != accepted.plan_revision
        || source.setting_sources != accepted.setting_sources
        || (expected.uid, expected.euid, expected.gid, expected.egid)
            != (identity.0, identity.0, identity.1, identity.1)
        || std::fs::canonicalize(&request.workspace_path)
            .ok()
            .as_deref()
            != Some(std::path::Path::new(&request.workspace_path))
        || std::fs::canonicalize(&source.cwd).ok().as_ref() != Some(&source.cwd)
    {
        return Err(unavailable("selection_binding"));
    }
    // Reuse the workload's selected copier and stale-leaf transaction. This
    // never resolves secrets, probes a provider, or reads original HOME again.
    crate::refresh_provider_config_references(
        &request.provider_launch_context,
        "claude",
        std::path::Path::new(&request.workspace_path),
        stage,
        home,
        identity.0,
        identity.1,
    )
    .map_err(|_| unavailable("ordinary_refresh"))
}

fn read_candidate_request(
    input: &mut impl Read,
) -> Result<freshell_runtime_protocol::ClaudeCandidateProjectionRequest, String> {
    let mut header = [0; 4];
    input
        .read_exact(&mut header)
        .map_err(|_| "Claude candidate private request header unavailable")?;
    let length = u32::from_be_bytes(header) as usize;
    if length > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES {
        return Err("Claude candidate private request exceeds the metadata profile; retain inputs and reprepare".into());
    }
    let mut raw = Vec::new();
    raw.try_reserve_exact(length)
        .map_err(|_| "Claude candidate private request allocation unavailable")?;
    raw.resize(length, 0);
    input
        .read_exact(&mut raw)
        .map_err(|_| "Claude candidate private request incomplete")?;
    let request: freshell_runtime_protocol::ClaudeCandidateProjectionRequest =
        serde_json::from_slice(&raw).map_err(|_| "Claude candidate private request invalid")?;
    request
        .validate()
        .map_err(|_| "Claude candidate private request metadata unavailable")?;
    Ok(request)
}

pub(crate) fn serve_private() -> Result<(), String> {
    let mut input =
        std::os::unix::net::UnixStream::connect("/run/freshell-source-exchange/reply.sock")
            .map_err(|_| "Claude observation private exchange unavailable")?;
    let timeout = Some(std::time::Duration::from_secs(15));
    input
        .set_read_timeout(timeout)
        .map_err(|_| "Claude observation private timeout unavailable")?;
    input
        .set_write_timeout(timeout)
        .map_err(|_| "Claude observation private timeout unavailable")?;
    let mut output = input
        .try_clone()
        .map_err(|_| "Claude observation private exchange unavailable")?;
    exchange(&mut input, &mut output)
}

pub(crate) fn serve_candidate_private() -> Result<(), String> {
    use std::{
        os::unix::fs::{FileTypeExt, MetadataExt},
        path::Path,
    };
    let home = Path::new("/home/freshell/provider");
    let socket = Path::new("/run/freshell-source-exchange/reply.sock");
    let unavailable =
        || "Claude candidate private helper namespace mapping is unavailable".to_string();
    if unsafe { libc::getuid() } != 0
        || unsafe { libc::geteuid() } != 0
        || unsafe { libc::getgid() } != 0
        || unsafe { libc::getegid() } != 0
    {
        return Err(unavailable());
    }
    crate::verify_initialized_provider_home(home, 65534, 0).map_err(|_| unavailable())?;
    let directory =
        std::fs::symlink_metadata(socket.parent().unwrap()).map_err(|_| unavailable())?;
    let endpoint = std::fs::symlink_metadata(socket).map_err(|_| unavailable())?;
    if !directory.is_dir()
        || directory.uid() != 0
        || directory.gid() != 0
        || directory.mode() & 0o777 != 0o710
        || !endpoint.file_type().is_socket()
        || endpoint.uid() != 0
        || endpoint.gid() != 0
        || endpoint.mode() & 0o777 != 0o660
    {
        return Err(unavailable());
    }
    let mut stream = std::os::unix::net::UnixStream::connect(socket)
        .map_err(|_| "Claude candidate private exchange unavailable")?;
    let timeout = Some(std::time::Duration::from_secs(15));
    stream
        .set_read_timeout(timeout)
        .map_err(|_| "Claude candidate private timeout unavailable")?;
    stream
        .set_write_timeout(timeout)
        .map_err(|_| "Claude candidate private timeout unavailable")?;
    let request = read_candidate_request(&mut stream)?;
    if request.source_request.home != home
        || std::env::current_dir().ok().as_ref() != Some(&request.source_request.cwd)
        || std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .as_deref()
            != Some(home)
    {
        return Err(
            "Claude candidate actual launch selection unavailable; retain inputs and reprepare"
                .into(),
        );
    }
    let raw =
        freshell_runtime_protocol::bounded_json_bytes(&request.source_request, MAX_REQUEST_BYTES)
            .map_err(|_| "Claude candidate source request exceeds metadata profile")?;
    project_candidate(
        &request,
        Path::new("/run/freshell-candidate-inputs"),
        home,
        (65534, 0),
    )?;
    // Match the existing provider mountpoint helper's identity transition. The
    // source evidence below measures this process after the transition.
    if unsafe { libc::setgroups(0, std::ptr::null()) } != 0
        || unsafe { libc::setgid(0) } != 0
        || unsafe { libc::setuid(65534) } != 0
    {
        return Err("Claude candidate provider identity transition unavailable".into());
    }
    crate::verify_private_helper_namespace(home, socket).map_err(|_| unavailable())?;
    if request.source_request.native_source_runtime
        == freshell_platform::claude_inputs::NativeSourceRuntime::Terminal
    {
        crate::providers::run_provider_features_worker(&["claude-mcp".into()])
            .map_err(|_| "Claude candidate ordinary feature preparation unavailable")?;
    }
    let source = &request.source_request;
    let observation = observe(
        &source.cwd,
        home,
        source.native_source_runtime,
        &source.setting_sources,
    )?;
    write_reply(
        &ObservationReply {
            request_sha256: format!("{:x}", Sha256::digest(raw)),
            observation,
        },
        &mut stream,
    )
}

fn exchange(input: &mut impl Read, output: &mut impl Write) -> Result<(), String> {
    let mut length = [0; 4];
    input
        .read_exact(&mut length)
        .map_err(|_| "Claude observation request header unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_REQUEST_BYTES {
        return Err(
            "Claude observation request exceeds the metadata profile; retain inputs and reprepare"
                .into(),
        );
    }
    let mut raw = Vec::new();
    raw.try_reserve_exact(length)
        .map_err(|_| "Claude observation request allocation unavailable")?;
    raw.resize(length, 0);
    input
        .read_exact(&mut raw)
        .map_err(|_| "Claude observation request incomplete")?;
    let request: ObservationRequest = serde_json::from_slice(&raw)
        .map_err(|_| "Claude observation request is invalid; retain inputs and reprepare")?;
    request.validate()?;
    let cwd = std::env::current_dir().map_err(|_| {
        "Claude observation native launch cwd is unavailable; retain inputs and repair it"
    })?;
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or("Claude observation native HOME is unavailable; retain inputs and repair it")?;
    if cwd != request.cwd || home != request.home {
        return Err("Claude observation native launch cwd or HOME changed; retain inputs and reprepare before dispatch".into());
    }
    let observation = observe(
        &cwd,
        &home,
        request.native_source_runtime,
        &request.setting_sources,
    )?;
    let reply = ObservationReply {
        request_sha256: format!("{:x}", Sha256::digest(&raw)),
        observation,
    };
    write_reply(&reply, output)
}

fn write_reply(reply: &ObservationReply, output: &mut impl Write) -> Result<(), String> {
    let bytes =
        freshell_runtime_protocol::bounded_json_bytes(&reply, MAX_REPLY_BYTES).map_err(|_| {
            "Claude observation reply exceeds the metadata profile; retain inputs and reprepare"
        })?;
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| "Claude observation response header unavailable")?;
    output
        .write_all(&bytes)
        .map_err(|_| "Claude observation response incomplete")?;
    output
        .flush()
        .map_err(|_| "Claude observation response incomplete")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Error, ErrorKind};

    #[test]
    fn claude_candidate_projection_runs_selected_dependency_and_frozen_config_consumer() {
        use freshell_platform::claude_inputs::{
            AcceptedNativeSourcePlan, ClaudeInputManifest, ClaudeSettingSource, NativeSourceRuntime,
        };
        use freshell_runtime_protocol::{
            bounded_json_bytes, ClaudeCandidateProjectionRequest, ProviderLaunchContext,
        };
        use std::os::unix::fs::PermissionsExt;
        for runtime in [NativeSourceRuntime::Terminal, NativeSourceRuntime::Sdk] {
            let owned = tempfile::tempdir().unwrap();
            let workspace = owned.path().join("workspace");
            let original = owned.path().join("original");
            let stage = owned.path().join("stage");
            let home = owned.path().join("candidate-home");
            for path in [&workspace, &original, &stage, &home] {
                std::fs::create_dir(path).unwrap();
            }
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
            crate::verify_initialized_provider_home(&home, unsafe { libc::geteuid() }, unsafe { libc::getegid() }).expect("synthetic candidate HOME must match the existing initialized identity before testing projection");
            std::fs::create_dir_all(stage.join(".freshell")).unwrap();
            std::fs::create_dir_all(stage.join(".claude")).unwrap();
            std::fs::write(
                stage.join(".claude/settings.json"),
                r#"{"selected":"frozen-original"}"#,
            )
            .unwrap();
            std::fs::create_dir_all(home.join(".claude")).unwrap();
            let retained_auth = home.join(".claude/.credentials.json");
            std::fs::write(&retained_auth, b"PRIVATE_RETAINED_AUTH_SENTINEL").unwrap();
            std::fs::create_dir_all(home.join(".freshell/provider-roots/unit-0")).unwrap();
            let unit = stage.join(".freshell/resource-units/unit-0");
            std::fs::create_dir_all(unit.join("node_modules/selected-dependency")).unwrap();
            std::fs::write(
                unit.join("node_modules/selected-dependency/index.js"),
                "module.exports=value=>'dependency:'+value",
            )
            .unwrap();
            std::fs::write(unit.join("consumer.cjs"), r#"const fs=require('node:fs');const selected=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));console.log(require('selected-dependency')(selected.selected));"#).unwrap();
            let mut manifest: ClaudeInputManifest = serde_json::from_value(serde_json::json!({
                "version":1,"nativeSourceRuntime":runtime,"originalHome":original,
                "cwd":workspace,"workspace":workspace,"settingSources":["user"],"pluginDirs":[]
            }))
            .unwrap();
            let selector_sha256 = format!(
                "{:x}",
                Sha256::digest(
                    bounded_json_bytes(&manifest.original_selectors(), 64 * 1024 * 1024).unwrap()
                )
            );
            let observation =
                observe(&workspace, &home, runtime, &[ClaudeSettingSource::User]).unwrap();
            manifest.accepted_native_plan = Some(AcceptedNativeSourcePlan {
                selector_manifest_sha256: selector_sha256.clone(),
                plan_revision: 0,
                observation,
            });
            let raw = serde_json::to_vec(&manifest).unwrap();
            std::fs::write(stage.join(".freshell/input-manifest.json"), &raw).unwrap();
            let generation = format!("grant-{}", uuid::Uuid::new_v4());
            let reservation = uuid::Uuid::new_v4().to_string();
            let context: ProviderLaunchContext = serde_json::from_value(serde_json::json!({
                "preparation":{"claude":{"mcp_args":[]}},
                "config":[{"root":"user_provider","relativePath":".claude/settings.json","providerRelativePath":".claude/settings.json","format":"json"}],
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"initialAuthReservation":reservation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&raw)),"sourceCount":0,"aliasCount":0,"recipeCount":0},
                    "resourceMounts":[{"stageRelativePath":".freshell/resource-units/unit-0","providerRelativePath":".freshell/provider-roots/unit-0","logicalDestination":workspace.join("selected-plugin"),"effectiveDestination":workspace.join("selected-plugin"),"kind":"directory"}]}
            })).unwrap();
            let publication = freshell_runtime_protocol::ClaudeCandidatePublication {
                version: 1,
                soul_id: freshell_runtime_protocol::SoulId::new(),
                provider: "claude".into(),
                authority_sha256: "d".repeat(64),
                initial_reservation_id: Some(reservation),
                registry_attempt_id: None,
                intent_revision: 1,
                prior_generation_id: None,
                generation_id: generation.clone(),
                manifest_sha256: context
                    .prepared_inputs
                    .as_ref()
                    .unwrap()
                    .manifest
                    .sha256
                    .clone(),
                prepared_context_sha256: format!(
                    "{:x}",
                    Sha256::digest(
                        bounded_json_bytes(
                            &context,
                            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES
                        )
                        .unwrap()
                    )
                ),
                prepared_result_sha256: "e".repeat(64),
                selector_manifest_sha256: selector_sha256.clone(),
                plan_revision: 0,
                native_source_runtime: runtime,
                workspace_path: workspace.to_str().unwrap().into(),
                cwd: workspace.clone(),
                git_common_dir: None,
            };
            let publication_bytes = bounded_json_bytes(
                &publication,
                freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
            )
            .unwrap();
            std::fs::write(
                stage.join(".freshell/claude-candidate-binding.json"),
                &publication_bytes,
            )
            .unwrap();
            let request = ClaudeCandidateProjectionRequest {
                source_request: ObservationRequest {
                    version: 1,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    native_source_runtime: runtime,
                    cwd: workspace.clone(),
                    home: home.clone(),
                    setting_sources: vec![ClaudeSettingSource::User],
                    selector_manifest_sha256: selector_sha256,
                    plan_revision: 0,
                    candidate_binding: Some(
                        freshell_platform::claude_inputs::observation::CandidateBinding {
                            soul_id: publication.soul_id.as_str().into(),
                            generation_id: generation,
                            authority_sha256: publication.authority_sha256.clone(),
                            publication_sha256: format!("{:x}", Sha256::digest(&publication_bytes)),
                            manifest_sha256: publication.manifest_sha256.clone(),
                            prepared_result_sha256: publication.prepared_result_sha256.clone(),
                        },
                    ),
                },
                workspace_path: workspace.to_str().unwrap().into(),
                provider_launch_context: context,
                publication,
            };
            let mut raw_request = freshell_runtime_protocol::bounded_json_bytes(
                &request,
                freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
            )
            .unwrap();
            // Exercise the inclusive transport boundary with a valid request;
            // padding is insignificant JSON whitespace, not extra selection.
            raw_request.resize(freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES, b' ');
            let mut frame = Vec::from((raw_request.len() as u32).to_be_bytes());
            frame.extend(raw_request);
            let request = read_candidate_request(&mut Cursor::new(frame)).expect(
                "valid bounded private candidate frame must reach the actual projection consumer",
            );
            std::fs::remove_dir(&original).unwrap();
            for fault in [
                "selector",
                "revision",
                "runtime",
                "manifest",
                "indexed-source",
                "home",
                "publication-soul",
                "publication-generation",
                "publication-authority",
                "publication-result",
                "publication-stage",
                "publication-context",
                "publication-missing-binding",
            ] {
                let mut altered = request.clone();
                match fault {
                    "selector" => altered.source_request.selector_manifest_sha256 = "b".repeat(64),
                    "revision" => altered.source_request.plan_revision = 2,
                    "runtime" => {
                        altered.source_request.native_source_runtime =
                            if runtime == NativeSourceRuntime::Terminal {
                                NativeSourceRuntime::Sdk
                            } else {
                                NativeSourceRuntime::Terminal
                            }
                    }
                    "manifest" => {
                        altered
                            .provider_launch_context
                            .prepared_inputs
                            .as_mut()
                            .unwrap()
                            .manifest
                            .sha256 = "c".repeat(64)
                    }
                    "indexed-source" => {
                        altered
                            .provider_launch_context
                            .prepared_inputs
                            .as_mut()
                            .unwrap()
                            .manifest
                            .source_count = 1
                    }
                    "home" => altered.source_request.home = owned.path().join("foreign-home"),
                    "publication-soul" => {
                        altered.publication.soul_id = freshell_runtime_protocol::SoulId::new()
                    }
                    "publication-generation" => {
                        altered.publication.generation_id =
                            format!("grant-{}", uuid::Uuid::new_v4())
                    }
                    "publication-authority" => {
                        altered.publication.authority_sha256 = "f".repeat(64)
                    }
                    "publication-result" => {
                        altered.publication.prepared_result_sha256 = "f".repeat(64)
                    }
                    "publication-stage" => {
                        altered.publication.soul_id = freshell_runtime_protocol::SoulId::new();
                        let binding = altered.source_request.candidate_binding.as_mut().unwrap();
                        binding.soul_id = altered.publication.soul_id.as_str().into();
                        binding.publication_sha256 = format!(
                            "{:x}",
                            Sha256::digest(
                                bounded_json_bytes(
                                    &altered.publication,
                                    freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES
                                )
                                .unwrap()
                            )
                        );
                        altered.validate().expect(
                            "a coherent substituted envelope must reach independent stage readback",
                        );
                    }
                    "publication-context" => {
                        altered.provider_launch_context.config[0].provider_relative_path =
                            ".claude/another-selected-settings.json".into()
                    }
                    "publication-missing-binding" => {
                        altered.source_request.candidate_binding = None
                    }
                    _ => unreachable!(),
                }
                assert!(
                    project_candidate(&altered, &stage, &home, unsafe {
                        (libc::geteuid(), libc::getegid())
                    })
                    .is_err(),
                    "incomplete or mismatched candidate must block for {fault}"
                );
                assert!(
                    !home.join(".claude/settings.json").exists(),
                    "blocked candidate must not project settings for {fault}"
                );
                assert!(
                    !home
                        .join(".freshell/provider-roots/unit-0/consumer.cjs")
                        .exists(),
                    "blocked candidate must not project executable resources for {fault}"
                );
                assert!(
                    !home.join(crate::PROVIDER_PROJECTION_MANIFEST).exists(),
                    "blocked candidate must not commit a projection for {fault}"
                );
                assert_eq!(
                    std::fs::read(&retained_auth).unwrap(),
                    b"PRIVATE_RETAINED_AUTH_SENTINEL"
                );
            }
            project_candidate(&request, &stage, &home, unsafe {
                (libc::geteuid(), libc::getegid())
            })
            .unwrap();
            let output = std::process::Command::new("node")
                .arg(home.join(".freshell/provider-roots/unit-0/consumer.cjs"))
                .arg(home.join(".claude/settings.json"))
                .current_dir(&workspace)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "selected staged dependency/config consumer must execute"
            );
            assert_eq!(output.stdout, b"dependency:frozen-original\n");
            assert_eq!(
                std::fs::read(&retained_auth).unwrap(),
                b"PRIVATE_RETAINED_AUTH_SENTINEL"
            );
            assert_eq!(
                std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                raw
            );
            assert!(
                !original.exists(),
                "pure candidate projection must not rescan frozen original HOME"
            );
        }
    }

    struct ReaderCase {
        result: Result<(), RuntimeError>,
        joined_before_test_cleanup: bool,
        elapsed: std::time::Duration,
    }

    async fn reader_case(mode: &str) -> ReaderCase {
        use freshell_platform::claude_inputs::NativeSourceRuntime;
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("cwd");
        let home = root.path().join("home");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&home).unwrap();
        let request = ObservationRequest {
            version: 1,
            request_id: uuid::Uuid::new_v4().to_string(),
            native_source_runtime: NativeSourceRuntime::Terminal,
            cwd: cwd.clone(),
            home: home.clone(),
            setting_sources: vec![],
            selector_manifest_sha256: "a".repeat(64),
            plan_revision: 0,
            candidate_binding: None,
        };
        let raw =
            freshell_runtime_protocol::bounded_json_bytes(&request, MAX_REQUEST_BYTES).unwrap();
        let request_sha256 = format!("{:x}", Sha256::digest(raw));
        let mut reply = ObservationReply {
            request_sha256: request_sha256.clone(),
            observation: observe(&cwd, &home, NativeSourceRuntime::Terminal, &[]).unwrap(),
        };
        let expected = reply.observation.clone();
        if mode == "wrong-binding" {
            reply.request_sha256 = "b".repeat(64);
        } else if mode == "wrong-runtime" {
            reply.observation.native_source_runtime = NativeSourceRuntime::Sdk;
        } else if mode == "changed-selection" {
            let added = (0..u32::MAX)
                .find(|group| {
                    *group != expected.egid && !expected.supplementary_groups.contains(group)
                })
                .unwrap();
            reply.observation.supplementary_groups.push(added);
            reply.observation.supplementary_groups.sort_unstable();
        }
        let mut bytes = serde_json::to_vec(&reply).unwrap();
        if matches!(mode, "near-cap" | "oversized") {
            bytes.resize(MAX_REPLY_BYTES, b' ');
        } else if mode == "invalid" {
            bytes = b"PRIVATE_READER_BODY_SENTINEL".to_vec();
        }
        let body = root.path().join("reply.bin");
        std::fs::write(&body, bytes).unwrap();
        std::fs::set_permissions(&body, std::fs::Permissions::from_mode(0o600)).unwrap();
        let script = root.path().join("reader.cjs");
        std::fs::write(&script, r#"const fs=require('node:fs');
const mode=process.argv[2],body=fs.readFileSync(process.argv[3]);
process.stdin.on('data',()=>{}).on('end',()=>{
 const header=Buffer.alloc(4);header.writeUInt32BE(body.length+(mode==='oversized'||mode==='short-body'?1:0));
 if(mode==='stall'){setInterval(()=>{},10000);return;}
 if(mode==='oversized'){process.stdout.write(header);setInterval(()=>{},10000);return;}
 if(mode==='short-header'){process.stdout.write(header.subarray(0,2));return;}
 const frame=Buffer.concat([header,body]);
 if(mode==='eof-stall'){process.stdout.write(frame,()=>{fs.closeSync(1);setInterval(()=>{},10000)});return;}
 process.stdout.write(mode==='extra'?Buffer.concat([frame,Buffer.from([1])]):frame);
 if(mode==='nonzero')process.exitCode=6;
});
"#).unwrap();
        let mut child = tokio::process::Command::new("node")
            .arg(&script)
            .arg(mode)
            .arg(&body)
            .current_dir(&cwd)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", std::env::var_os("PATH").unwrap())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let result = verify_final_child(
            &mut child,
            &request,
            &request_sha256,
            &expected,
            std::time::Duration::from_secs(2),
            std::time::Duration::from_millis(200),
        )
        .await;
        let elapsed = started.elapsed();
        let joined_before_test_cleanup = child.id().is_none();
        // Join every owned fault child before any assertion can panic. This
        // fallback records a failed production join; it cannot make it pass.
        if !joined_before_test_cleanup {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                child.kill().await.unwrap();
                child.wait().await.unwrap();
            })
            .await
            .expect("test-owned reader cleanup must finish");
        }
        ReaderCase {
            result,
            joined_before_test_cleanup,
            elapsed,
        }
    }

    #[tokio::test]
    async fn claude_final_reader_real_pipe_bounds_binding_failures_and_joins() {
        for mode in [
            "valid",
            "near-cap",
            "oversized",
            "short-header",
            "short-body",
            "invalid",
            "extra",
            "nonzero",
            "wrong-binding",
            "wrong-runtime",
            "stall",
        ] {
            let case = reader_case(mode).await;
            assert!(
                case.joined_before_test_cleanup,
                "owned reader must already be joined for {mode}"
            );
            assert_eq!(
                case.result.is_ok(),
                matches!(mode, "valid" | "near-cap"),
                "actual reader result for {mode}"
            );
            assert!(
                case.elapsed < std::time::Duration::from_secs(3),
                "finite reader exchange for {mode}"
            );
            if let Err(error) = case.result {
                assert!(!error.message.contains("PRIVATE_READER_BODY_SENTINEL"));
            }
        }
    }

    #[tokio::test]
    async fn claude_final_reader_classifies_only_complete_proven_selection_changes() {
        for mode in [
            "valid",
            "changed-selection",
            "invalid",
            "wrong-binding",
            "wrong-runtime",
            "eof-stall",
        ] {
            let case = reader_case(mode).await;
            assert!(
                case.joined_before_test_cleanup,
                "actual private fault reader must be joined for {mode}"
            );
            if mode == "valid" {
                case.result.unwrap();
            } else {
                let error = case.result.unwrap_err();
                let expected = if mode == "changed-selection" {
                    RuntimeErrorCode::ProviderInputsChanged
                } else {
                    RuntimeErrorCode::HostUnreachable
                };
                assert_eq!(
                    error.code, expected,
                    "unavailable evidence cannot authorize source replan for {mode}"
                );
                assert!(!error.message.contains("PRIVATE_READER_BODY_SENTINEL"));
            }
        }
    }

    #[tokio::test]
    async fn claude_final_reader_complete_reply_without_process_exit_terminates_and_joins() {
        let case = reader_case("eof-stall").await;
        assert!(
            case.result.is_err(),
            "a reply alone cannot establish process completion"
        );
        assert!(
            case.joined_before_test_cleanup,
            "complete reply plus EOF must not leave the owned reader running after cleanup timeout"
        );
        assert!(case.elapsed < std::time::Duration::from_secs(3));
    }

    struct HeaderOnly {
        header: Cursor<[u8; 4]>,
        body_reads: usize,
    }
    impl Read for HeaderOnly {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if self.header.position() == 4 {
                self.body_reads += 1;
                return Err(Error::new(ErrorKind::Other, "body must remain unread"));
            }
            self.header.read(bytes)
        }
    }

    #[test]
    fn claude_candidate_rejects_oversized_header_before_reading_or_allocating_body() {
        for length in [
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES as u32 + 1,
            u32::MAX,
        ] {
            let mut input = HeaderOnly {
                header: Cursor::new(length.to_be_bytes()),
                body_reads: 0,
            };
            let error = read_candidate_request(&mut input).unwrap_err();
            assert!(error.contains("exceeds the metadata profile"));
            assert_eq!(input.body_reads, 0);
        }
    }

    #[test]
    fn claude_candidate_incomplete_or_invalid_frame_never_discloses_private_body() {
        let private = b"PRIVATE_CANDIDATE_BODY_SENTINEL";
        let mut incomplete = Vec::from((private.len() as u32 + 1).to_be_bytes());
        incomplete.extend(private);
        let mut invalid = Vec::from((private.len() as u32).to_be_bytes());
        invalid.extend(private);
        for (frame, expected) in [
            (vec![0, 0, 0], "header unavailable"),
            (incomplete, "request incomplete"),
            (invalid, "request invalid"),
        ] {
            let error = read_candidate_request(&mut Cursor::new(frame)).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(!error
                .as_bytes()
                .windows(private.len())
                .any(|window| window == private));
        }
    }

    #[test]
    fn claude_observation_rejects_oversized_header_before_reading_or_allocating_body() {
        for length in [MAX_REQUEST_BYTES as u32 + 1, u32::MAX] {
            let mut input = HeaderOnly {
                header: Cursor::new(length.to_be_bytes()),
                body_reads: 0,
            };
            let mut output = Vec::new();
            let error = exchange(&mut input, &mut output).unwrap_err();
            assert!(error.contains("exceeds the metadata profile"));
            assert_eq!(input.body_reads, 0);
            assert!(output.is_empty());
        }
    }

    #[test]
    fn claude_observation_incomplete_request_never_emits_partial_evidence_or_private_input() {
        let private = b"PRIVATE_INCOMPLETE_METADATA_SENTINEL";
        let mut input = Vec::from((private.len() as u32 + 1).to_be_bytes());
        input.extend(private);
        let mut output = Vec::new();
        let error = exchange(&mut Cursor::new(input), &mut output).unwrap_err();
        assert!(error.contains("request incomplete"));
        assert!(!error
            .as_bytes()
            .windows(private.len())
            .any(|window| window == private));
        assert!(output.is_empty());
    }
}

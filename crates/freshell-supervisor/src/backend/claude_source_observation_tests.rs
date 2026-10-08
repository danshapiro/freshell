use super::*;
use freshell_platform::claude_inputs::observation::{LocalDecision, NativeObservation};
use freshell_runtime_protocol::{
    ClaudeSourceAuthority, InitialAuthVolumeObservation, ReserveProviderInputsRequest,
};
use std::sync::{Arc, Mutex};
use tokio::{net::UnixListener, task::JoinSet};

#[test]
fn provider_claude_private_candidate_metadata_enforces_inclusive_limits() {
    use std::io::Write;
    for limit in [
        freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
        64 * 1024 * 1024,
    ] {
        let owned = tempfile::tempdir().unwrap();
        let file = owned.path().join("metadata");
        let mut writer = std::fs::File::create(&file).unwrap();
        let chunk = [b'x'; 64 * 1024];
        for _ in 0..limit / chunk.len() {
            writer.write_all(&chunk).unwrap();
        }
        writer.sync_all().unwrap();
        let bytes = read_candidate_metadata(owned.path(), "metadata", limit)
            .expect("existing inclusive metadata limit must remain usable");
        assert_eq!(bytes.len(), limit);
        assert!(bytes.iter().all(|byte| *byte == b'x'));
        drop(bytes);
        writer.write_all(b"x").unwrap();
        writer.sync_all().unwrap();
        assert!(
            read_candidate_metadata(owned.path(), "metadata", limit).is_err(),
            "one byte over cap must block before loading the body"
        );
        assert!(read_candidate_metadata(owned.path(), "../metadata", limit).is_err());
        std::fs::rename(&file, owned.path().join("physical")).unwrap();
        std::os::unix::fs::symlink(owned.path().join("physical"), &file).unwrap();
        assert!(
            read_candidate_metadata(owned.path(), "metadata", limit + 1).is_err(),
            "a link cannot become the qualified private metadata file"
        );
    }
}

#[tokio::test]
async fn provider_claude_physical_candidate_publication_gates_frozen_consumer() {
    use freshell_platform::claude_inputs::{
        AcceptedNativeSourcePlan, ClaudeInputManifest, ClaudeSettingSource, NativeSourceRuntime,
    };
    use freshell_runtime_protocol::{
        bounded_json_bytes, ClaudeCandidatePublication, PreparedProviderContext,
        ProviderLaunchContext, MAX_CONTROL_FRAME_BYTES,
    };
    for (flavor, runtime) in [
        ("claude", NativeSourceRuntime::Terminal),
        ("claude", NativeSourceRuntime::Sdk),
        ("kilroy", NativeSourceRuntime::Sdk),
    ] {
        for mode in [
            "valid",
            "missing-resource",
            "wrong-soul",
            "wrong-reservation",
            "wrong-owner",
            "changed-selectors",
            "wrong-plan-uid",
            "wrong-home",
            "wrong-cwd",
            "missing-plan",
            "changed-publication",
            "changed-result",
            "changed-context",
            "changed-manifest",
            "symlink-publication",
            "oversized-publication",
        ] {
            let owned = tempfile::tempdir().unwrap();
            let workspace = owned.path().join("workspace");
            let original = owned.path().join("original-home");
            let stage = owned.path().join("stage");
            std::fs::create_dir(&workspace).unwrap();
            std::fs::create_dir(&original).unwrap();
            std::fs::create_dir_all(stage.join(".freshell")).unwrap();
            let resource = stage.join(".freshell/resource-units/unit-0/probe");
            std::fs::create_dir_all(resource.join("node_modules/frozen-dependency")).unwrap();
            std::fs::write(
                resource.join("node_modules/frozen-dependency/index.js"),
                "module.exports='qualified-frozen-dependency'",
            )
            .unwrap();
            std::fs::write(
                resource.join("consumer.cjs"),
                "process.stdout.write(require('frozen-dependency'))",
            )
            .unwrap();
            let binary = owned.path().join("synthetic-host");
            std::fs::write(&binary, b"synthetic artifact").unwrap();
            let registry =
                crate::registry::Registry::open(owned.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let mut reservation = registry
                .reserve_initial_inputs(
                    ReserveProviderInputsRequest {
                        expected_control_epoch: Some(registry.control_epoch()),
                        soul_id: soul.clone(),
                        provider: flavor.into(),
                        creation_seed_ref: "synthetic-seed".into(),
                    },
                    format!("sha256:{}", "a".repeat(64)),
                    binary,
                )
                .await
                .unwrap();
            let mut manifest = ClaudeInputManifest {
                version: 1,
                native_source_runtime: Some(runtime),
                original_home: original.clone(),
                cwd: workspace.clone(),
                workspace: workspace.clone(),
                config_root: None,
                settings_file: None,
                settings_origin: None,
                inline_settings_sha256: None,
                setting_sources: vec![ClaudeSettingSource::User],
                plugin_dirs: vec![],
                accepted_native_plan: None,
            };
            let selector = format!(
                "{:x}",
                Sha256::digest(
                    bounded_json_bytes(&manifest.original_selectors(), 64 * 1024 * 1024).unwrap()
                )
            );
            let mut observation = NativeObservation {
                version: 1,
                native_source_runtime: runtime,
                setting_sources: manifest.setting_sources.clone(),
                uid: 65534,
                euid: 65534,
                gid: 0,
                egid: 0,
                supplementary_groups: vec![],
                cwd: workspace.clone(),
                home: Some("/home/freshell/provider".into()),
                roots: None,
                local_settings: vec![],
                local_decision: LocalDecision::Disabled,
                root_uid: None,
                git_uid: None,
                claude_uid: None,
            };
            if mode == "wrong-plan-uid" {
                observation.uid = 65535;
                observation.euid = 65535;
            }
            if mode == "wrong-home" {
                observation.home = Some(original.clone());
            }
            if mode == "wrong-cwd" {
                std::fs::create_dir(workspace.join("nested")).unwrap();
                observation.cwd = workspace.join("nested");
            }
            manifest.accepted_native_plan = Some(AcceptedNativeSourcePlan {
                selector_manifest_sha256: selector.clone(),
                plan_revision: 0,
                observation,
            });
            if mode == "changed-selectors" {
                manifest.original_home = owned.path().join("other-original-home");
            }
            if mode == "missing-plan" {
                manifest.accepted_native_plan = None;
            }
            manifest.validate().expect(
                "synthetic fixture must have valid native plan shape before physical qualification",
            );
            let manifest_bytes = bounded_json_bytes(&manifest, 64 * 1024 * 1024).unwrap();
            let generation = format!("grant-{}", uuid::Uuid::new_v4());
            let reservation_id = if mode == "wrong-reservation" {
                uuid::Uuid::new_v4().to_string()
            } else {
                reservation.id.clone()
            };
            let candidate_soul = if mode == "wrong-soul" {
                SoulId::new()
            } else {
                soul
            };
            let context:ProviderLaunchContext=serde_json::from_value(json!({
                "preparation":{"claude":{"mcp_args":[]}},"config":[],
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"initialAuthReservation":reservation_id,
                    "manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&manifest_bytes)),"sourceCount":0,"aliasCount":0,"recipeCount":0},
                    "resourceMounts":[{"stageRelativePath":".freshell/resource-units/unit-0","providerRelativePath":".freshell/provider-roots/unit-0","logicalDestination":"/home/freshell/provider/.claude/skills","effectiveDestination":"/home/freshell/provider/.claude/skills","kind":"directory"}]}
            })).unwrap();
            let ready = PreparedProviderContext {
                provider_launch_context: context.clone(),
                provider_secret_references: vec![],
            };
            let result_bytes = bounded_json_bytes(&ready, MAX_CONTROL_FRAME_BYTES).unwrap();
            let context_bytes = bounded_json_bytes(&context, MAX_CONTROL_FRAME_BYTES).unwrap();
            let authority = ClaudeSourceAuthority::InitialReservation {
                reservation_id: reservation_id.clone(),
            };
            let publication = ClaudeCandidatePublication {
                version: 1,
                soul_id: candidate_soul.clone(),
                provider: flavor.into(),
                authority_sha256: format!(
                    "{:x}",
                    Sha256::digest(
                        bounded_json_bytes(&authority, MAX_CONTROL_FRAME_BYTES).unwrap()
                    )
                ),
                initial_reservation_id: Some(reservation_id),
                registry_attempt_id: None,
                intent_revision: 1,
                prior_generation_id: None,
                generation_id: generation.clone(),
                manifest_sha256: format!("{:x}", Sha256::digest(&manifest_bytes)),
                prepared_context_sha256: format!("{:x}", Sha256::digest(&context_bytes)),
                prepared_result_sha256: format!("{:x}", Sha256::digest(&result_bytes)),
                selector_manifest_sha256: selector.clone(),
                plan_revision: 0,
                native_source_runtime: runtime,
                workspace_path: workspace.to_str().unwrap().into(),
                cwd: workspace.clone(),
                git_common_dir: None,
            };
            let publication_bytes =
                bounded_json_bytes(&publication, MAX_CONTROL_FRAME_BYTES).unwrap();
            let request:ObserveClaudeSourcesRequest=serde_json::from_value(json!({
                "expectedControlEpoch":registry.control_epoch(),"soulId":candidate_soul,"provider":flavor,"authority":authority,"workspacePath":workspace,"gitCommonDir":null,"candidate":ready,
                "observationRequest":{"version":1,"requestId":uuid::Uuid::new_v4().to_string(),"nativeSourceRuntime":runtime,"cwd":workspace,"home":"/home/freshell/provider","settingSources":["user"],"selectorManifestSha256":selector,"planRevision":0,
                    "candidateBinding":{"soulId":candidate_soul,"generationId":generation,"authoritySha256":publication.authority_sha256,"publicationSha256":format!("{:x}",Sha256::digest(&publication_bytes)),"manifestSha256":publication.manifest_sha256,"preparedResultSha256":publication.prepared_result_sha256}}
            })).unwrap();
            request.candidate_projection(publication).expect("coherent wire fixture must pass metadata shape checks before physical/owner qualification");
            std::fs::write(stage.join(".freshell/input-manifest.json"), manifest_bytes).unwrap();
            std::fs::write(stage.join(".freshell/prepared-context.json"), context_bytes).unwrap();
            std::fs::write(stage.join(".freshell/prepared-result.json"), result_bytes).unwrap();
            std::fs::write(
                stage.join(".freshell/claude-candidate-binding.json"),
                publication_bytes,
            )
            .unwrap();
            let private = b"PRIVATE_UNUSED_CAPABILITY_SENTINEL";
            std::fs::write(stage.join(".freshell/mcp-capability.json"), private).unwrap();
            std::fs::remove_dir(&original).unwrap();
            if mode == "missing-resource" {
                std::fs::remove_dir_all(stage.join(".freshell/resource-units/unit-0")).unwrap();
            }
            if mode == "wrong-owner" {
                reservation.id = uuid::Uuid::new_v4().to_string();
            }
            for (condition, file) in [
                ("changed-publication", "claude-candidate-binding.json"),
                ("changed-result", "prepared-result.json"),
                ("changed-context", "prepared-context.json"),
                ("changed-manifest", "input-manifest.json"),
            ] {
                if mode == condition {
                    std::fs::write(stage.join(".freshell").join(file), private).unwrap();
                }
            }
            if mode == "symlink-publication" {
                let path = stage.join(".freshell/claude-candidate-binding.json");
                std::fs::rename(&path, owned.path().join("escaped-publication")).unwrap();
                std::os::unix::fs::symlink(owned.path().join("escaped-publication"), path).unwrap();
            }
            if mode == "oversized-publication" {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(stage.join(".freshell/claude-candidate-binding.json"))
                    .unwrap()
                    .set_len(MAX_CONTROL_FRAME_BYTES as u64 + 1)
                    .unwrap();
            }
            let owner = ClaudeSourceOwner::Initial {
                reservation,
                observation: InitialAuthVolumeObservation::Absent {
                    daemon_id: DockerDaemonId::new(),
                },
            };
            let qualified = qualify_candidate_stage(&stage, &owner, &request);
            assert_eq!(qualified.is_ok(),mode=="valid","{flavor}/{runtime:?}/{mode}: physical issuer and current owner must qualify before consumer selection: {:?}",qualified.as_ref().err());
            if let Ok(projection) = qualified {
                let selected = &projection
                    .provider_launch_context
                    .prepared_inputs
                    .as_ref()
                    .unwrap()
                    .resource_mounts[0];
                let output = std::process::Command::new("node")
                    .arg(
                        stage
                            .join(&selected.stage_relative_path)
                            .join("probe/consumer.cjs"),
                    )
                    .env_clear()
                    .env("PATH", "/usr/local/bin:/usr/bin:/bin")
                    .current_dir(&workspace)
                    .output()
                    .unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, b"qualified-frozen-dependency");
            } else {
                assert!(!qualified
                    .unwrap_err()
                    .to_string()
                    .contains(std::str::from_utf8(private).unwrap()));
            }
            assert!(!original.exists());
            assert_eq!(
                std::fs::read(stage.join(".freshell/mcp-capability.json")).unwrap(),
                private
            );
        }
    }
}

#[tokio::test]
async fn provider_claude_source_helper_uses_private_bound_ipc_without_creating_stable_home() {
    for mode in [
        "success",
        "wrong_uid",
        "wrong_digest",
        "oversized_reply",
        "failed_exit",
        "lost_create_ack",
        "cleanup_mismatch",
        "timeout",
        "nonrootless",
        "existing_initial_home",
    ] {
        qualify_transport(mode).await;
    }
}

async fn qualify_transport(mode: &'static str) {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let private = "PRIVATE_CLAUDE_SOURCE_SETTINGS_SENTINEL";
    std::fs::create_dir(workspace.join(".claude")).unwrap();
    std::fs::write(workspace.join(".claude/settings.local.json"), private).unwrap();
    let binary = temp.path().join("synthetic-host");
    std::fs::write(&binary, b"synthetic helper artifact").unwrap();
    let registry = crate::registry::Registry::open(temp.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let image = format!("sha256:{}", "a".repeat(64));
    let reservation = registry
        .reserve_initial_inputs(
            ReserveProviderInputsRequest {
                expected_control_epoch: Some(registry.control_epoch()),
                soul_id: soul.clone(),
                provider: "claude".into(),
                creation_seed_ref: "synthetic-seed".into(),
            },
            image,
            binary,
        )
        .await
        .unwrap();
    let daemon = DockerDaemonId::new();
    let owner = ClaudeSourceOwner::Initial {
        reservation: reservation.clone(),
        observation: InitialAuthVolumeObservation::Absent {
            daemon_id: daemon.clone(),
        },
    };
    let request: ObserveClaudeSourcesRequest = serde_json::from_value(json!({
        "expectedControlEpoch":registry.control_epoch(), "soulId":soul, "provider":"claude",
        "authority":{"kind":"initial_reservation","reservationId":reservation.id},
        "workspacePath":workspace,"gitCommonDir":null,"candidate":null,
        "observationRequest":{"version":1,"requestId":uuid::Uuid::new_v4().to_string(),
            "nativeSourceRuntime":"terminal","cwd":workspace,"home":"/home/freshell/provider",
            "settingSources":["local"],"selectorManifestSha256":"b".repeat(64),"planRevision":0}
    }))
    .unwrap();
    assert!(matches!(
        request.authority,
        ClaudeSourceAuthority::InitialReservation { .. }
    ));
    let requests = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
    let helper_bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = UnixListener::bind(temp.path().join("docker.sock")).unwrap();
    let seen = requests.clone();
    let bodies = helper_bodies.clone();
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut jobs = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted.unwrap();
                    let (seen, bodies, daemon) = (seen.clone(), bodies.clone(), daemon.clone());
                    jobs.spawn(async move {
                        let mut header = Vec::new();
                        let mut byte = [0];
                        while !header.ends_with(b"\r\n\r\n") {
                            stream.read_exact(&mut byte).await.unwrap();
                            header.push(byte[0]);
                            assert!(header.len() <= 32 * 1024);
                        }
                        let header = String::from_utf8(header).unwrap();
                        let length = header.lines().find_map(|line|line.strip_prefix("Content-Length: "))
                            .unwrap().trim().parse::<usize>().unwrap();
                        assert!(length <= freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES);
                        let mut raw = vec![0; length];
                        stream.read_exact(&mut raw).await.unwrap();
                        let line = header.lines().next().unwrap().to_string();
                        seen.lock().unwrap().push((line.clone(), raw.clone()));
                        let (status, response) = if line.contains("/info ") {
                            (200, json!({"ID":daemon,"SecurityOptions":if mode=="nonrootless" {vec![]} else {vec!["name=rootless"]}}))
                        } else if line.starts_with("GET") && line.contains("/volumes/") {
                            (if mode=="existing_initial_home" {200} else {404}, json!({}))
                        } else if line.starts_with("GET") && line.contains("/images/") {
                            (200, json!({"Config":{"Env":["ANTHROPIC_API_KEY=PRIVATE_IMAGE_CREDENTIAL_SENTINEL","PATH=/usr/bin"]}}))
                        } else if line.starts_with("POST") && line.contains("/containers/create?") {
                            bodies.lock().unwrap().push(serde_json::from_slice(&raw).unwrap());
                            (if mode=="lost_create_ack" {503} else {201}, json!({"Id":"b".repeat(64)}))
                        } else if line.starts_with("GET") && line.contains("/containers/") && line.contains("/json ") {
                            match bodies.lock().unwrap().last().cloned() {
                                Some(mut body) => {
                                    if mode=="cleanup_mismatch" && line.contains("/freshell-claude-source-") {body["User"]=json!("foreign-identity");}
                                    (200, json!({"Id":"b".repeat(64),"Config":body,"HostConfig":body["HostConfig"],"State":{"Running":false}}))
                                },
                                None => (404, json!({})),
                            }
                        } else if line.starts_with("POST") && line.contains("/start ") {
                            let body = bodies.lock().unwrap().last().unwrap().clone();
                            let exchange = body["HostConfig"]["Mounts"].as_array().unwrap().iter()
                                .find(|mount|mount["Target"]=="/run/freshell-source-exchange").unwrap()["Source"].as_str().unwrap().to_string();
                            let mut channel = UnixStream::connect(Path::new(&exchange).join("reply.sock")).await.unwrap();
                            if mode=="timeout" {
                                tokio::time::sleep(Duration::from_secs(10)).await;
                                return;
                            }
                            let length = channel.read_u32().await.unwrap() as usize;
                            assert!(length <= freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES);
                            let mut raw = vec![0; length];
                            channel.read_exact(&mut raw).await.unwrap();
                            let request: freshell_platform::claude_inputs::observation::ObservationRequest = serde_json::from_slice(&raw).unwrap();
                            let mut reply = ObservationReply {
                                request_sha256: format!("{:x}", Sha256::digest(&raw)),
                                observation: NativeObservation {
                                    version:1,native_source_runtime:request.native_source_runtime,
                                    setting_sources:request.setting_sources,uid:65534,euid:65534,gid:0,egid:0,
                                    supplementary_groups:vec![],
                                    local_settings:vec![request.cwd.join(".claude/settings.local.json")],
                                    cwd:request.cwd,home:Some(request.home),roots:None,
                                    local_decision:LocalDecision::NoRoot,root_uid:None,git_uid:None,claude_uid:None,
                                },
                            };
                            if mode=="wrong_uid" {reply.observation.uid=65535;reply.observation.euid=65535;}
                            if mode=="wrong_digest" {reply.request_sha256="c".repeat(64);}
                            if mode=="oversized_reply" {
                                channel.write_u32(freshell_platform::claude_inputs::observation::MAX_REPLY_BYTES as u32+1).await.unwrap();
                                channel.shutdown().await.unwrap();
                                (204, json!({}))
                            } else {
                            let raw = serde_json::to_vec(&reply).unwrap();
                            channel.write_u32(raw.len() as u32).await.unwrap();
                            channel.write_all(&raw).await.unwrap();
                            channel.shutdown().await.unwrap();
                            (204, json!({}))
                            }
                        } else if line.starts_with("POST") && line.contains("/wait?") {
                            (200, json!({"StatusCode":if mode=="failed_exit" {1} else {0}}))
                        } else if line.starts_with("DELETE") && line.contains("/containers/") {
                            // Readback must prove the owned helper is gone.
                            bodies.lock().unwrap().clear();
                            (204, json!({}))
                        } else { (500, json!({})) };
                        let response = response.to_string();
                        stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
                    });
                }
                result = jobs.join_next(), if !jobs.is_empty() => { result.unwrap().unwrap(); }
            }
        }
        jobs.shutdown().await;
    });
    let backend = DockerEngineBackend::new(temp.path().join("docker.sock"));
    let result = backend
        .read_claude_source_helper(
            &owner,
            &request,
            "synthetic-source-run",
            Duration::from_millis(250),
        )
        .await;
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.is_ok(),
        mode == "success",
        "{mode}: unavailable, contradictory or unjoined evidence cannot be accepted"
    );
    if let Ok(reply) = result {
        let raw = freshell_runtime_protocol::bounded_json_bytes(
            &request.observation_request,
            freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES,
        )
        .unwrap();
        reply
            .validate_for_request(
                &request.observation_request,
                &format!("{:x}", Sha256::digest(&raw)),
            )
            .unwrap();
    }
    let seen = requests.lock().unwrap();
    assert!(seen
        .iter()
        .all(|(line, raw)| !line.contains("/volumes/create")
            && !line.contains("/logs?")
            && !raw
                .windows(private.len())
                .any(|bytes| bytes == private.as_bytes())
            && !raw
                .windows(b"PRIVATE_IMAGE_CREDENTIAL_SENTINEL".len())
                .any(|bytes| bytes == b"PRIVATE_IMAGE_CREDENTIAL_SENTINEL")));
    let create = seen
        .iter()
        .find(|(line, _)| line.contains("/containers/create?"));
    if matches!(mode, "nonrootless" | "existing_initial_home") {
        assert!(
            create.is_none(),
            "unqualified creation namespace must not create a helper or native workload"
        );
    } else {
        let created: Value = serde_json::from_slice(&create.unwrap().1).unwrap();
        assert_eq!(created["User"], "65534:0");
        assert_eq!(created["Cmd"], json!(["observe-claude-sources-private"]));
        assert_eq!(
            created["WorkingDir"],
            json!(request.observation_request.cwd)
        );
        assert_eq!(created["HostConfig"]["NetworkMode"], "none");
        assert_eq!(created["HostConfig"]["LogConfig"]["Type"], "none");
        assert_eq!(created["HostConfig"]["CapDrop"], json!(["ALL"]));
        assert_eq!(created["HostConfig"]["ReadonlyRootfs"], true);
        assert_eq!(created["HostConfig"]["PidsLimit"], 32);
        assert_eq!(created["HostConfig"]["Memory"], 256 * 1024 * 1024);
        assert_eq!(created["HostConfig"]["NanoCpus"], 500_000_000);
        assert!(created["HostConfig"]["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|mount| mount["Type"] == "bind" && mount["ReadOnly"] == true));
    }
    if mode == "cleanup_mismatch" {
        assert!(
            !seen.iter().any(|(line, _)| line.starts_with("DELETE")),
            "changed ownership cannot authorize deleting a helper"
        );
    } else {
        assert!(
            helper_bodies.lock().unwrap().is_empty(),
            "owned helper cleanup must complete before returning metadata/error"
        );
    }
    assert!(
        std::fs::read(workspace.join(".claude/settings.local.json")).unwrap() == private.as_bytes()
    );
}

use super::*;
use freshell_platform::claude_inputs::observation::{LocalDecision, NativeObservation};
use freshell_runtime_protocol::{
    ClaudeSourceAuthority, InitialAuthVolumeObservation, ReserveProviderInputsRequest,
};
use std::sync::{Arc, Mutex};
use tokio::{net::UnixListener, task::JoinSet};

#[tokio::test]
async fn provider_claude_candidate_scratch_owns_disk_backing_and_confirmed_cleanup() {
    for mode in [
        "success",
        "lost-ack",
        "existing",
        "conflict",
        "wrong-labels",
        "driver-options",
        "wrong-daemon",
        "still-present",
    ] {
        let owned = tempfile::tempdir().unwrap();
        let daemon = DockerDaemonId::new();
        let labels = json!({"com.freshell.soul-id":"synthetic-soul", "com.freshell.source-request-id":"synthetic-request"});
        let mut scratch = CandidateScratch {
            name: "freshell-claude-candidate-synthetic".into(),
            labels: labels.clone(),
            daemon: daemon.clone(),
            attempted: false,
        };
        let present = Arc::new(Mutex::new(mode == "existing"));
        let calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let listener = UnixListener::bind(owned.path().join("docker.sock")).unwrap();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let (state, seen) = (present.clone(), calls.clone());
        let server = tokio::spawn(async move {
            let mut jobs = JoinSet::new();
            loop {
                tokio::select! {
                    _=&mut stopped=>break,
                    accepted=listener.accept()=>{
                        let (mut stream,_)=accepted.unwrap();
                        let (state,seen,labels,daemon)=(state.clone(),seen.clone(),labels.clone(),daemon.clone());
                        jobs.spawn(async move {
                            let mut header=Vec::new();let mut byte=[0];
                            while !header.ends_with(b"\r\n\r\n") {stream.read_exact(&mut byte).await.unwrap();header.push(byte[0]);assert!(header.len()<=32*1024);}
                            let header=String::from_utf8(header).unwrap();let line=header.lines().next().unwrap().to_string();
                            let length=header.lines().find_map(|line|line.strip_prefix("Content-Length: ")).unwrap().trim().parse::<usize>().unwrap();
                            assert!(length<=64*1024);let mut raw=vec![0;length];stream.read_exact(&mut raw).await.unwrap();
                            let body=if raw.is_empty() {Value::Null} else {serde_json::from_slice(&raw).unwrap()};
                            seen.lock().unwrap().push((line.clone(),body.clone()));
                            let (status,value)=if line.contains("/info ") {(200,json!({"ID":if mode=="wrong-daemon" {DockerDaemonId::new()} else {daemon},"SecurityOptions":["name=rootless"]}))}
                            else if line.starts_with("POST") && line.contains("/volumes/create ") {
                                *state.lock().unwrap()=true;
                                (if mode=="lost-ack" {503} else if mode=="conflict" {409} else {201},json!({"Name":body["Name"]}))
                            } else if line.starts_with("GET") && line.contains("/volumes/") {
                                if *state.lock().unwrap() {(200,json!({"Name":"freshell-claude-candidate-synthetic","Driver":"local","Options":if mode=="driver-options" {json!({"type":"tmpfs","o":"size=64m"})} else {json!({})},"Labels":if mode=="wrong-labels" {json!({"foreign":"owner"})} else {labels}}))} else {(404,json!({}))}
                            } else if line.starts_with("DELETE") && line.contains("/volumes/") {if mode!="still-present" {*state.lock().unwrap()=false;}(204,json!({}))}
                            else {(500,json!({}))};
                            let response=value.to_string();stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
                        });
                    }
                    result=jobs.join_next(),if !jobs.is_empty()=>{result.unwrap().unwrap();}
                }
            }
            jobs.shutdown().await;
        });
        let backend = DockerEngineBackend::new(owned.path().join("docker.sock"));
        let created = tokio::time::timeout(
            Duration::from_secs(2),
            backend.create_claude_candidate_scratch(&mut scratch),
        )
        .await
        .unwrap();
        let cleaned = tokio::time::timeout(
            Duration::from_secs(2),
            backend.cleanup_claude_candidate_scratch(&mut scratch),
        )
        .await
        .unwrap();
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            created.is_ok(),
            matches!(mode, "success" | "still-present"),
            "{mode}: only absent, exact ordinary backing can be accepted: {created:?}"
        );
        assert_eq!(
            cleaned.is_ok(),
            matches!(
                mode,
                "success" | "lost-ack" | "existing" | "conflict" | "wrong-daemon"
            ),
            "{mode}: cleanup must prove exact absence or retain uncertain ownership: {cleaned:?}"
        );
        let seen = calls.lock().unwrap();
        let deletes = seen
            .iter()
            .filter(|(line, _)| line.starts_with("DELETE"))
            .count();
        assert_eq!(
            deletes,
            usize::from(matches!(mode, "success" | "lost-ack" | "still-present")),
            "{mode}: no foreign or unqualified volume removal"
        );
        if let Some((_, body)) = seen
            .iter()
            .find(|(line, _)| line.contains("/volumes/create "))
        {
            assert_eq!(body["Driver"], "local");
            assert!(
                body["DriverOpts"]
                    .as_object()
                    .is_none_or(|options| options.is_empty()),
                "ordinary resource profile cannot be lowered to secret tmpfs size"
            );
        }
        assert_eq!(
            scratch.attempted,
            matches!(mode, "wrong-labels" | "driver-options" | "still-present")
        );
    }
}

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
            "retained-current-workspace",
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
            let retained = mode == "retained-current-workspace";
            let prior_workspace = owned.path().join("original-workspace");
            std::fs::create_dir(&prior_workspace).unwrap();
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
                if retained {
                    "process.stdout.write(require('frozen-dependency')+':'+process.cwd())"
                } else {
                    "process.stdout.write(require('frozen-dependency'))"
                },
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
                cwd: if retained {
                    prior_workspace.clone()
                } else {
                    workspace.clone()
                },
                workspace: if retained {
                    prior_workspace.clone()
                } else {
                    workspace.clone()
                },
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
            let mut context:ProviderLaunchContext=serde_json::from_value(json!({
                "preparation":{"claude":{"mcp_args":[]}},"config":[],
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"initialAuthReservation":reservation_id,
                    "manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&manifest_bytes)),"sourceCount":0,"aliasCount":0,"recipeCount":0},
                    "resourceMounts":[{"stageRelativePath":".freshell/resource-units/unit-0","providerRelativePath":".freshell/provider-roots/unit-0","logicalDestination":"/home/freshell/provider/.claude/skills","effectiveDestination":"/home/freshell/provider/.claude/skills","kind":"directory"}]}
            })).unwrap();
            if retained {
                context
                    .prepared_inputs
                    .as_mut()
                    .unwrap()
                    .initial_auth_reservation = None;
            }
            let ready = PreparedProviderContext {
                provider_launch_context: context.clone(),
                provider_secret_references: vec![],
            };
            let result_bytes = bounded_json_bytes(&ready, MAX_CONTROL_FRAME_BYTES).unwrap();
            let context_bytes = bounded_json_bytes(&context, MAX_CONTROL_FRAME_BYTES).unwrap();
            let attempt = freshell_runtime_protocol::RecoveryAttemptId::new();
            let prior_generation = format!("grant-{}", uuid::Uuid::new_v4());
            let authority = if retained {
                ClaudeSourceAuthority::RecoveryAttempt {
                    attempt_id: uuid::Uuid::new_v4().to_string(),
                }
            } else {
                ClaudeSourceAuthority::InitialReservation {
                    reservation_id: reservation_id.clone(),
                }
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
                initial_reservation_id: if retained { None } else { Some(reservation_id) },
                registry_attempt_id: retained.then_some(attempt.clone()),
                intent_revision: if retained { 2 } else { 1 },
                prior_generation_id: retained.then_some(prior_generation.clone()),
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
            request.candidate_projection(publication.clone()).expect("coherent wire fixture must pass metadata shape checks before physical/owner qualification");
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
            let owner = if retained {
                use freshell_runtime_protocol::{IncarnationId, InstallationId, LaunchNonce};
                let ClaudeSourceOwner::Initial {
                    reservation,
                    observation: InitialAuthVolumeObservation::Absent { daemon_id },
                } = owner
                else {
                    unreachable!()
                };
                let mut prior_context = context.clone();
                prior_context.mcp_capability.as_mut().unwrap().grant_id = prior_generation.clone();
                prior_context
                    .prepared_inputs
                    .as_mut()
                    .unwrap()
                    .generation_id = prior_generation.clone();
                prior_context.validate("claude").unwrap();
                let (terminal, agent) = if runtime == NativeSourceRuntime::Terminal {
                    (Some(serde_json::from_value(json!({"terminalId":"retained-terminal","streamId":"retained-stream","mode":"claude","program":"claude","args":[],"env":{},"cwd":prior_workspace,"workspacePath":prior_workspace,"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"retained-project","providerLaunchContext":prior_context})).unwrap()),None)
                } else {
                    (None,Some(serde_json::from_value(json!({"sessionId":"retained-session","provider":flavor,"sessionType":if flavor=="kilroy" {"kilroy"} else {"freshclaude"},"runtimeVariant":"claude","providerStoreId":"retained-store","cwd":prior_workspace,"workspacePath":prior_workspace,"runAsUid":65534,"runAsGid":0,"providerLaunchContext":prior_context})).unwrap()))
                };
                ClaudeSourceOwner::Retained {
                    handle: OwnedRuntimeHandle::from_registry(
                        InstallationId::new(),
                        reservation.soul_id,
                        IncarnationId::new(),
                        LaunchNonce::new(),
                        daemon_id,
                        "retained-owned-container".into(),
                        reservation.image_ref,
                        owned.path().into(),
                        reservation.binary,
                        "retained-config-digest".into(),
                        freshell_runtime_protocol::RuntimeLimits {
                            cpu_milli: 500,
                            memory_bytes: 256 * 1024 * 1024,
                            swap_bytes: 0,
                            pids_max: 32,
                        },
                        None,
                        terminal,
                        agent,
                        "retained-owned-home".into(),
                    ),
                    recovery_source: Some(freshell_runtime_protocol::ClaudeRecoverySourceBinding {
                        provider: flavor.into(),
                        git_common_dir: None,
                        authority_sha256: publication.authority_sha256,
                        registry_attempt_id: attempt,
                        intent_revision: 2,
                        prior_generation_id: prior_generation,
                    }),
                }
            } else {
                owner
            };
            if retained {
                std::fs::remove_dir(&prior_workspace).unwrap();
            }
            let qualified = qualify_candidate_stage(&stage, &owner, &request);
            assert_eq!(qualified.is_ok(),mode=="valid" || retained,"{flavor}/{runtime:?}/{mode}: physical issuer and current owner must qualify before consumer selection: {:?}",qualified.as_ref().err());
            if let Ok(projection) = qualified {
                qualify_candidate_helper_transport(&owner, &request, &stage).await;
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
                if retained {
                    assert_eq!(
                        output.stdout,
                        format!("qualified-frozen-dependency:{}", workspace.display()).as_bytes()
                    );
                    assert!(!prior_workspace.exists());
                } else {
                    assert_eq!(output.stdout, b"qualified-frozen-dependency");
                }
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

#[tokio::test]
async fn provider_claude_retained_baseline_consumes_frozen_aliases_without_native_data() {
    for mode in [
        "retained-success",
        "retained-terminal-success",
        "retained-writable-report",
        "retained-wrong-bind-source",
        "retained-missing-report",
        "retained-duplicate-report",
        "retained-missing-template",
        "retained-changed-manifest",
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
    let retained = mode.starts_with("retained-");
    let stage = temp.path().join("prior-stage");
    let native_home = temp.path().join("native-home");
    let resource_relative = ".freshell/provider-roots/frozen-hook";
    let consumed = Arc::new(Mutex::new(None::<Vec<u8>>));
    let owner = if retained {
        use freshell_runtime_protocol::{IncarnationId, InstallationId, LaunchNonce};
        std::fs::create_dir(workspace.join(".claude/hooks")).unwrap();
        std::fs::write(
            workspace.join(".claude/hooks/unselected-decoy"),
            b"PRIVATE_UNSELECTED_WORKSPACE_HOOK_SENTINEL",
        )
        .unwrap();
        std::fs::create_dir_all(stage.join(".freshell/resource-units/frozen-hook")).unwrap();
        std::fs::create_dir_all(stage.join(".freshell/templates")).unwrap();
        std::fs::create_dir_all(native_home.join(".claude/projects")).unwrap();
        std::fs::write(
            native_home.join(".claude/projects/native-history.jsonl"),
            b"PRIVATE_NATIVE_HISTORY_SENTINEL",
        )
        .unwrap();
        std::fs::write(
            native_home.join(".claude/.credentials.json"),
            b"PRIVATE_NATIVE_CREDENTIAL_SENTINEL",
        )
        .unwrap();
        let manifest = b"{}";
        std::fs::write(stage.join(".freshell/input-manifest.json"), manifest).unwrap();
        std::fs::write(
            stage.join(".freshell/templates/frozen-settings"),
            r#"{"env":{"ORDINARY_MARKER":"frozen-config"}}"#,
        )
        .unwrap();
        for root in [
            native_home.join(resource_relative),
            stage.join(".freshell/resource-units/frozen-hook"),
        ] {
            std::fs::create_dir_all(root.join("node_modules/frozen-dependency")).unwrap();
            std::fs::write(root.join("resource"), b"frozen-resource").unwrap();
            std::fs::write(
                root.join("node_modules/frozen-dependency/index.js"),
                "module.exports='installed-dependency'",
            )
            .unwrap();
            std::fs::write(root.join("consume.cjs"), "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2])).env.ORDINARY_MARKER+':'+fs.readFileSync(__dirname+'/resource')+':'+require('frozen-dependency'));").unwrap();
        }
        let generation = format!("grant-{}", uuid::Uuid::new_v4());
        let context: freshell_runtime_protocol::ProviderLaunchContext = serde_json::from_value(json!({
            "preparation":{"claude":{"mcp_args":[]}}, "config":[],
            "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
            "preparedInputs":{"generationId":generation,
                "manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(manifest)),"sourceCount":0,"aliasCount":0,"recipeCount":0},
                "configBinds":[{"sourceRelativePath":".freshell/templates/frozen-settings","logicalDestination":workspace.join(".claude/settings.local.json"),"effectiveDestination":workspace.join(".claude/settings.local.json")}],
                "resourceMounts":[{"stageRelativePath":".freshell/resource-units/frozen-hook","providerRelativePath":resource_relative,"logicalDestination":workspace.join(".claude/hooks"),"effectiveDestination":workspace.join(".claude/hooks"),"kind":"directory"}]}
        })).unwrap();
        context.validate("claude").unwrap();
        if mode == "retained-missing-template" {
            std::fs::remove_file(stage.join(".freshell/templates/frozen-settings")).unwrap();
        } else if mode == "retained-changed-manifest" {
            std::fs::write(
                stage.join(".freshell/input-manifest.json"),
                b"changed ordinary manifest",
            )
            .unwrap();
        }
        let (terminal, agent) = if mode == "retained-terminal-success" {
            (Some(serde_json::from_value(json!({
                "terminalId":"synthetic-terminal", "streamId":"synthetic-stream", "mode":"claude", "program":"claude", "args":[], "env":{},
                "cwd":workspace,"workspacePath":workspace,"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"synthetic-project","providerLaunchContext":context
            })).unwrap()),None)
        } else {
            (None,Some(serde_json::from_value(json!({
            "sessionId":"synthetic-session", "provider":"claude", "sessionType":"freshclaude", "runtimeVariant":"claude", "providerStoreId":"synthetic-store",
            "cwd":workspace, "workspacePath":workspace, "runAsUid":65534, "runAsGid":0, "providerLaunchContext":context
        })).unwrap()))
        };
        ClaudeSourceOwner::Retained {
            handle: OwnedRuntimeHandle::from_registry(
                InstallationId::new(),
                reservation.soul_id.clone(),
                IncarnationId::new(),
                LaunchNonce::new(),
                daemon.clone(),
                "owned-native-container-must-not-stop".into(),
                reservation.image_ref.clone(),
                temp.path().into(),
                reservation.binary.clone(),
                "synthetic-owned-config-digest".into(),
                freshell_runtime_protocol::RuntimeLimits {
                    cpu_milli: 500,
                    memory_bytes: 256 * 1024 * 1024,
                    swap_bytes: 0,
                    pids_max: 32,
                },
                None,
                terminal,
                agent,
                "owned-retained-home".into(),
            ),
            recovery_source: None,
        }
    } else {
        owner
    };
    let request: ObserveClaudeSourcesRequest = serde_json::from_value(json!({
        "expectedControlEpoch":registry.control_epoch(), "soulId":soul, "provider":"claude",
        "authority":{"kind":"initial_reservation","reservationId":reservation.id},
        "workspacePath":workspace,"gitCommonDir":null,"candidate":null,
        "observationRequest":{"version":1,"requestId":uuid::Uuid::new_v4().to_string(),
            "nativeSourceRuntime":if retained && mode!="retained-terminal-success" {"sdk"} else {"terminal"},"cwd":workspace,"home":"/home/freshell/provider",
            "settingSources":["local"],"selectorManifestSha256":"b".repeat(64),"planRevision":0}
    }))
    .unwrap();
    let mut request = request;
    if retained {
        request.authority = ClaudeSourceAuthority::RecoveryAttempt {
            attempt_id: uuid::Uuid::new_v4().to_string(),
        };
    }
    assert!(matches!(
        request.authority,
        ClaudeSourceAuthority::InitialReservation { .. }
            | ClaudeSourceAuthority::RecoveryAttempt { .. }
    ));
    let requests = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
    let helper_bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = UnixListener::bind(temp.path().join("docker.sock")).unwrap();
    let seen = requests.clone();
    let bodies = helper_bodies.clone();
    let consumer = consumed.clone();
    let retained_root = native_home.clone();
    let settings_target = workspace.join(".claude/settings.local.json");
    let hooks_target = workspace.join(".claude/hooks");
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut jobs = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted.unwrap();
                    let (seen, bodies, daemon, consumer, retained_root, settings_target, hooks_target) = (seen.clone(), bodies.clone(), daemon.clone(), consumer.clone(), retained_root.clone(), settings_target.clone(), hooks_target.clone());
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
                            if retained { (200,json!({"Name":"owned-retained-home","Driver":"local","Options":{},"Mountpoint":retained_root})) }
                            else { (if mode=="existing_initial_home" {200} else {404}, json!({})) }
                        } else if line.starts_with("GET") && line.contains("/images/") {
                            (200, json!({"Config":{"Env":["ANTHROPIC_API_KEY=PRIVATE_IMAGE_CREDENTIAL_SENTINEL","PATH=/usr/bin"]}}))
                        } else if line.starts_with("POST") && line.contains("/containers/create?") {
                            bodies.lock().unwrap().push(serde_json::from_slice(&raw).unwrap());
                            (if mode=="lost_create_ack" {503} else {201}, json!({"Id":"b".repeat(64)}))
                        } else if line.starts_with("GET") && line.contains("/containers/") && line.contains("/json ") {
                            match bodies.lock().unwrap().last().cloned() {
                                Some(mut body) => {
                                    if mode=="cleanup_mismatch" && line.contains("/freshell-claude-source-") {body["User"]=json!("foreign-identity");}
                                    let mut reports=body["HostConfig"]["Mounts"].as_array().unwrap().iter().map(|mount| {
                                        json!({"Type":mount["Type"],"Destination":mount["Target"],"Source":if mount["Type"]=="volume" {json!(retained_root)} else {mount["Source"].clone()},"Name":if mount["Type"]=="volume" {mount["Source"].clone()} else {Value::Null},"RW":if mode=="retained-writable-report" && mount["Target"]==json!(hooks_target) {Some(true)} else {mount["ReadOnly"].as_bool().map(|ro|!ro)}})
                                    }).collect::<Vec<_>>();
                                    if mode=="retained-wrong-bind-source" {
                                        reports.iter_mut().find(|report|report["Destination"]==json!(settings_target)).unwrap()["Source"]=json!("/synthetic/foreign-config");
                                    } else if mode=="retained-missing-report" { reports.pop(); }
                                    else if mode=="retained-duplicate-report" { let report=reports.iter().find(|report|report["Destination"]==json!(hooks_target)).unwrap().clone();reports.pop();reports.push(report); }
                                    (200, json!({"Id":"b".repeat(64),"Config":body,"HostConfig":body["HostConfig"],"Mounts":reports,"State":{"Running":false}}))
                                },
                                None => (404, json!({})),
                            }
                        } else if line.starts_with("POST") && line.contains("/start ") {
                            let body = bodies.lock().unwrap().last().unwrap().clone();
                            if retained {
                                let mounts=body["HostConfig"]["Mounts"].as_array().unwrap();
                                let config=mounts.iter().find(|mount|mount["Target"]==json!(settings_target) && mount["Type"]=="bind" && mount["ReadOnly"]==true);
                                let resource=mounts.iter().find(|mount|mount["Target"]==json!(hooks_target) && mount["Type"]=="volume" && mount["Source"]=="owned-retained-home" && mount["ReadOnly"]==true);
                                if let (Some(config),Some(resource))=(config,resource) {
                                    let root=retained_root.join(resource["VolumeOptions"]["Subpath"].as_str().unwrap());
                                    let output=std::process::Command::new("node").arg(root.join("consume.cjs")).arg(config["Source"].as_str().unwrap()).output().unwrap();
                                    assert!(output.status.success(),"selected ordinary consumer failed");
                                    *consumer.lock().unwrap()=Some(output.stdout);
                                }
                            }
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
    let result = if retained {
        backend
            .read_claude_baseline_helper(
                &owner,
                &request,
                "synthetic-source-run",
                Duration::from_secs(3),
                Some(&stage),
            )
            .await
    } else {
        backend
            .read_claude_source_helper(
                &owner,
                &request,
                "synthetic-source-run",
                Duration::from_millis(250),
            )
            .await
    };
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.is_ok(),
        mode == "success" || matches!(mode, "retained-success" | "retained-terminal-success"),
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
    if matches!(
        mode,
        "nonrootless"
            | "existing_initial_home"
            | "retained-missing-template"
            | "retained-changed-manifest"
    ) {
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
            .all(
                |mount| (mount["Type"] == "bind" || (retained && mount["Type"] == "volume"))
                    && mount["ReadOnly"] == true
            ));
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
    if retained {
        if matches!(mode, "retained-success" | "retained-terminal-success") {
            assert_eq!(consumed.lock().unwrap().as_deref(),Some(b"frozen-config:frozen-resource:installed-dependency".as_slice()),"retained baseline must consume the prior frozen config/resource aliases, leaving the workspace decoy unselected");
        } else {
            assert!(
                consumed.lock().unwrap().is_none(),
                "incomplete retained topology must block before any consumer"
            );
            assert!(!seen
                .iter()
                .any(|(line, _)| line.starts_with("POST") && line.contains("/start ")));
        }
        assert_eq!(
            std::fs::read(workspace.join(".claude/hooks/unselected-decoy")).unwrap(),
            b"PRIVATE_UNSELECTED_WORKSPACE_HOOK_SENTINEL"
        );
        assert_eq!(
            std::fs::read(native_home.join(".claude/projects/native-history.jsonl")).unwrap(),
            b"PRIVATE_NATIVE_HISTORY_SENTINEL"
        );
        assert_eq!(
            std::fs::read(native_home.join(".claude/.credentials.json")).unwrap(),
            b"PRIVATE_NATIVE_CREDENTIAL_SENTINEL"
        );
        assert!(seen.iter().all(|(_, raw)| !raw
            .windows(b"PRIVATE_NATIVE_HISTORY_SENTINEL".len())
            .any(|bytes| bytes == b"PRIVATE_NATIVE_HISTORY_SENTINEL")
            && !raw
                .windows(b"PRIVATE_NATIVE_CREDENTIAL_SENTINEL".len())
                .any(|bytes| bytes == b"PRIVATE_NATIVE_CREDENTIAL_SENTINEL")));
    }
}

async fn qualify_candidate_helper_transport(
    owner: &ClaudeSourceOwner,
    request: &ObserveClaudeSourcesRequest,
    stage: &Path,
) {
    let mut modes = vec![
        "success",
        "docker-empty-tmpfs",
        "unexpected-tmpfs",
        "wrong-caps",
        "lost-projection-ack",
        "projection-timeout",
        "volume-still-present",
        "wrong-mount-report",
        "wrong-resource-subpath",
    ];
    if matches!(owner, ClaudeSourceOwner::Retained { .. }) {
        modes.extend([
            "writable-retained-home",
            "wrong-retained-volume",
            "changed-prior-context",
        ]);
    }
    for mode in modes {
        let owned = tempfile::tempdir().unwrap();
        let daemon = match owner {
            ClaudeSourceOwner::Initial {
                observation: InitialAuthVolumeObservation::Absent { daemon_id },
                ..
            } => daemon_id.clone(),
            ClaudeSourceOwner::Retained { handle, .. } => handle.daemon_id().clone(),
        };
        let retained_name = match owner {
            ClaudeSourceOwner::Retained { handle, .. } => {
                Some(handle.provider_volume_name().to_string())
            }
            _ => None,
        };
        let prior_stage = owned.path().join("prior-stage");
        if let ClaudeSourceOwner::Retained { handle, .. } = owner {
            use freshell_platform::provider_environment::{copy_environment, CopySelection};
            let context = retained_claude_context(handle).unwrap();
            let inputs = context.prepared_inputs.as_ref().unwrap();
            let selections = std::iter::once(CopySelection {
                source: stage.join(&inputs.manifest.relative_path),
                destination_relative: inputs.manifest.relative_path.clone().into(),
            })
            .chain(inputs.resource_mounts.iter().map(|unit| CopySelection {
                source: stage.join(&unit.stage_relative_path),
                destination_relative: unit.stage_relative_path.clone().into(),
            }))
            .collect::<Vec<_>>();
            std::fs::create_dir(&prior_stage).unwrap();
            copy_environment(&selections, &prior_stage, &[], Default::default()).unwrap();
            std::fs::write(
                prior_stage.join(".freshell/prepared-context.json"),
                freshell_runtime_protocol::bounded_json_bytes(
                    context,
                    freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
                )
                .unwrap(),
            )
            .unwrap();
        }
        let calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let containers = Arc::new(Mutex::new(BTreeMap::<String, Value>::new()));
        let volume = Arc::new(Mutex::new(None::<Value>));
        let listener = UnixListener::bind(owned.path().join("docker.sock")).unwrap();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let (seen, bodies, backing) = (calls.clone(), containers.clone(), volume.clone());
        let expected_scratch = format!(
            "freshell-claude-candidate-{}",
            request.observation_request.request_id
        );
        let retained_name_for_server = retained_name.clone();
        let server = tokio::spawn(async move {
            let retained_name = retained_name_for_server;
            let mut jobs = JoinSet::new();
            let private_jobs = Arc::new(Mutex::new(Vec::<tokio::task::JoinHandle<()>>::new()));
            loop {
                tokio::select! {
                    _=&mut stopped=>break,
                    accepted=listener.accept()=>{
                        let (mut stream,_)=accepted.unwrap();
                        let (seen,bodies,backing,daemon,private_jobs,expected_scratch,retained_name)=(seen.clone(),bodies.clone(),backing.clone(),daemon.clone(),private_jobs.clone(),expected_scratch.clone(),retained_name.clone());
                        jobs.spawn(async move {
                            let mut header=Vec::new();let mut byte=[0];
                            while !header.ends_with(b"\r\n\r\n") {stream.read_exact(&mut byte).await.unwrap();header.push(byte[0]);assert!(header.len()<=32*1024);}
                            let header=String::from_utf8(header).unwrap();let line=header.lines().next().unwrap().to_string();
                            let length=header.lines().find_map(|line|line.strip_prefix("Content-Length: ")).unwrap().trim().parse::<usize>().unwrap();
                            assert!(length<=1024*1024);let mut raw=vec![0;length];stream.read_exact(&mut raw).await.unwrap();
                            let body=if raw.is_empty(){Value::Null}else{serde_json::from_slice(&raw).unwrap()};
                            seen.lock().unwrap().push((line.clone(),body.clone()));
                            let (status,value)=if line.contains("/info "){(200,json!({"ID":daemon,"SecurityOptions":["name=rootless"]}))}
                            else if line.contains("/images/"){(200,json!({"Config":{"Env":["PATH=/usr/bin","ANTHROPIC_API_KEY=PRIVATE_IMAGE_CREDENTIAL_SENTINEL"]}}))}
                            else if line.starts_with("POST") && line.contains("/volumes/create "){assert_eq!(body["Name"],expected_scratch,"private candidate request must identify its exact scratch backing before creation");let actual=json!({"Name":body["Name"],"Driver":"local","Options":{},"Labels":body["Labels"],"Mountpoint":"/synthetic/ordinary-volume"});*backing.lock().unwrap()=Some(actual.clone());(201,actual)}
                            else if line.starts_with("GET") && line.contains("/volumes/"){if retained_name.as_ref().is_some_and(|name|line.contains(name)) {(200,json!({"Name":retained_name,"Driver":"local","Options":{},"Mountpoint":"/synthetic/retained-home"}))} else {match backing.lock().unwrap().clone(){Some(v) if line.contains(v["Name"].as_str().unwrap())=>(200,v),_=>(404,json!({}))}}}
                            else if line.starts_with("DELETE") && line.contains("/volumes/"){assert!(bodies.lock().unwrap().is_empty(),"candidate helpers must be gone before volume deletion");if mode!="volume-still-present" {*backing.lock().unwrap()=None;}(204,json!({}))}
                            else if line.contains("/containers/create?"){
                                if body["Cmd"]==json!(["project-claude-candidate-private"]) {let root=body["HostConfig"]["Mounts"].as_array().unwrap().iter().find(|m|m["Target"]=="/run/freshell-candidate-inputs").unwrap()["Source"].as_str().unwrap();assert!(!Path::new(root).join(".freshell/mcp-capability.json").exists(),"ordinary candidate input root must not expose capability credentials");}
                                let name=line.split("name=").nth(1).unwrap().split_whitespace().next().unwrap().to_string();let id=if body["Cmd"]==json!(["prepare-provider-mountpoints"]) {"a".repeat(64)} else {"b".repeat(64)};bodies.lock().unwrap().insert(name,json!({"Id":id,"Config":body,"HostConfig":body["HostConfig"],"State":{"Running":false}}));(if mode=="lost-projection-ack" && body["Cmd"]==json!(["project-claude-candidate-private"]) {503}else{201},json!({"Id":id}))}
                            else if line.starts_with("GET") && line.contains("/containers/"){let key=line.split("/containers/").nth(1).unwrap().split('/').next().unwrap();let found=bodies.lock().unwrap().iter().find(|(name,v)|*name==key || v["Id"]==key).map(|(_,v)|v.clone());match found {Some(mut v)=>{
                                let reports=v["HostConfig"]["Mounts"].as_array().unwrap().iter().map(|m|json!({"Type":m["Type"],"Destination":m["Target"],"RW":!m["ReadOnly"].as_bool().unwrap(),"Source":if m["Type"]=="volume" {json!(if m["Target"]=="/run/freshell-retained-home" {"/synthetic/retained-home"} else {"/synthetic/ordinary-volume"})} else {m["Source"].clone()},"Name":if m["Type"]=="volume" {m["Source"].clone()} else {Value::Null}})).collect::<Vec<_>>();
                                v["Mounts"]=json!(reports);
                                if mode=="docker-empty-tmpfs" && v["Config"]["Cmd"]==json!(["project-claude-candidate-private"]) {v["HostConfig"]["Tmpfs"]=Value::Null;}
                                if key.len()==64 && v["Config"]["Cmd"]==json!(["project-claude-candidate-private"]) {
                                    if mode=="unexpected-tmpfs" {v["HostConfig"]["Tmpfs"]=json!({"/foreign":"rw,size=1m"});}
                                    if mode=="wrong-caps" {v["HostConfig"]["CapAdd"]=json!(["SYS_ADMIN"]);}
                                    if mode=="wrong-mount-report" {v["Mounts"][0]["RW"]=json!(true);}
                                    if mode=="wrong-resource-subpath" {let mount=v["HostConfig"]["Mounts"].as_array_mut().unwrap().iter_mut().find(|m|m["VolumeOptions"]["Subpath"].is_string()).unwrap();mount["VolumeOptions"]["Subpath"]=json!("foreign/ordinary");}
                                    if mode=="writable-retained-home" {v["Mounts"].as_array_mut().unwrap().iter_mut().find(|m|m["Destination"]=="/run/freshell-retained-home").unwrap()["RW"]=json!(true);}
                                    if mode=="wrong-retained-volume" {v["Mounts"].as_array_mut().unwrap().iter_mut().find(|m|m["Destination"]=="/run/freshell-retained-home").unwrap()["Name"]=json!("foreign-provider-home");}
                                } (200,v)},None=>(404,json!({}))}}
                            else if line.starts_with("DELETE") && line.contains("/containers/"){let key=line.split("/containers/").nth(1).unwrap().split('?').next().unwrap();let name=bodies.lock().unwrap().iter().find(|(name,v)|*name==key || v["Id"]==key).map(|(name,_)|name.clone());if let Some(name)=name{bodies.lock().unwrap().remove(&name);}(204,json!({}))}
                            else if line.contains("/start "){let id=line.split("/containers/").nth(1).unwrap().split('/').next().unwrap();let v=bodies.lock().unwrap().values().find(|v|v["Id"]==id).unwrap().clone();private_jobs.lock().unwrap().push(tokio::spawn(async move {
                                let is_mountpoint=v["Config"]["Cmd"]==json!(["prepare-provider-mountpoints"]);
                                let target=if is_mountpoint {"/run/freshell-input-exchange"} else {"/run/freshell-source-exchange"};
                                let path=v["HostConfig"]["Mounts"].as_array().unwrap().iter().find(|m|m["Target"]==target).unwrap()["Source"].as_str().unwrap();
                                let mut channel=UnixStream::connect(Path::new(path).join("reply.sock")).await.unwrap();
                                if !is_mountpoint && mode=="projection-timeout" {tokio::time::sleep(Duration::from_secs(10)).await;return;}
                                let length=channel.read_u32().await.unwrap() as usize;assert!(length<=1024*1024);let mut raw=vec![0;length];channel.read_exact(&mut raw).await.unwrap();
                                if is_mountpoint {let _:Vec<freshell_platform::provider_mountpoints::Mountpoint>=serde_json::from_slice(&raw).unwrap();channel.write_all(b"ok").await.unwrap();}
                                else {
                                    let p:freshell_runtime_protocol::ClaudeCandidateProjectionRequest=serde_json::from_slice(&raw).unwrap();
                                    p.validate().unwrap();
                                    if let Some(generation) = p.publication.prior_generation_id.as_deref() {
                                        let mounts = v["HostConfig"]["Mounts"].as_array().unwrap();
                                        let context = mounts.iter().find(|m|m["Target"]=="/run/freshell-retained-inputs/.freshell/prepared-context.json").unwrap()["Source"].as_str().unwrap();
                                        let prior:freshell_runtime_protocol::ProviderLaunchContext = serde_json::from_slice(&std::fs::read(context).unwrap()).unwrap();
                                        assert_eq!(prior.prepared_inputs.as_ref().unwrap().generation_id,generation);
                                        let unit = mounts.iter().find(|m|m["Target"]=="/run/freshell-retained-inputs/.freshell/resource-units/unit-0").unwrap()["Source"].as_str().unwrap();
                                        let mut consumer = std::process::Command::new("node").arg(Path::new(unit).join("probe/consumer.cjs")).current_dir(&p.workspace_path).env_clear().env("PATH","/usr/local/bin:/usr/bin:/bin").stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
                                        let started = std::time::Instant::now();
                                        let completed = loop {
                                            if let Some(status) = consumer.try_wait().unwrap() { break status; }
                                            if started.elapsed() >= Duration::from_secs(3) { consumer.kill().unwrap();consumer.wait().unwrap();panic!("owned frozen consumer timed out after finite joined cleanup"); }
                                            std::thread::sleep(Duration::from_millis(5));
                                        };
                                        assert!(completed.success());
                                        let mut output = Vec::new();
                                        std::io::Read::read_to_end(&mut consumer.stdout.take().unwrap(),&mut output).unwrap();
                                        assert_eq!(output,format!("qualified-frozen-dependency:{}",p.workspace_path).as_bytes());
                                        if mode=="changed-prior-context" { std::fs::write(context,b"{}").unwrap(); }
                                    }
                                    let source=p.source_request;let canonical=freshell_runtime_protocol::bounded_json_bytes(&source,MAX_REQUEST_BYTES).unwrap();let reply=ObservationReply {request_sha256:format!("{:x}",Sha256::digest(canonical)),observation:NativeObservation {version:1,native_source_runtime:source.native_source_runtime,setting_sources:source.setting_sources,uid:65534,euid:65534,gid:0,egid:0,supplementary_groups:vec![],cwd:source.cwd,home:Some(source.home),roots:None,local_settings:vec![],local_decision:LocalDecision::Disabled,root_uid:None,git_uid:None,claude_uid:None}};let raw=serde_json::to_vec(&reply).unwrap();channel.write_u32(raw.len() as u32).await.unwrap();channel.write_all(&raw).await.unwrap();channel.shutdown().await.unwrap();
                                }
                            }));(204,json!({}))}
                            else if line.contains("/wait?"){(200,json!({"StatusCode":0}))}else{(500,json!({}))};
                            let response=value.to_string();let _=stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await;
                        });
                    }
                    result=jobs.join_next(),if !jobs.is_empty()=>{result.unwrap().unwrap();}
                }
            }
            jobs.shutdown().await;
            let workers = std::mem::take(&mut *private_jobs.lock().unwrap());
            for worker in workers {
                if mode == "projection-timeout" && !worker.is_finished() {
                    worker.abort();
                }
                match tokio::time::timeout(Duration::from_secs(5), worker)
                    .await
                    .expect("owned private worker must finish and join")
                {
                    Ok(()) => {}
                    Err(e) if e.is_cancelled() => {}
                    Err(e) => panic!("private fixture worker failed: {e}"),
                }
            }
        });
        let backend = DockerEngineBackend::new(owned.path().join("docker.sock"));
        let result = backend
            .read_claude_candidate_helper(
                owner,
                request,
                stage,
                "synthetic-source-run",
                Duration::from_millis(250),
                retained_name.as_ref().map(|_| prior_stage.as_path()),
            )
            .await;
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result.is_ok(),
            matches!(mode, "success" | "docker-empty-tmpfs"),
            "{mode}: candidate projection and confirmed owned cleanup gate evidence: {result:?}"
        );
        assert!(
            containers.lock().unwrap().is_empty(),
            "{mode}: both helpers must be removed"
        );
        assert_eq!(
            volume.lock().unwrap().is_some(),
            mode == "volume-still-present"
        );
        let seen = calls.lock().unwrap();
        if matches!(
            mode,
            "unexpected-tmpfs"
                | "wrong-caps"
                | "wrong-mount-report"
                | "wrong-resource-subpath"
                | "writable-retained-home"
                | "wrong-retained-volume"
        ) {
            assert!(
                !seen
                    .iter()
                    .any(|(line, _)| line
                        .contains(&format!("/containers/{}/start ", "b".repeat(64)))),
                "{mode}: changed candidate topology must block before projection starts"
            );
        }
        for (line, body) in seen.iter() {
            assert!(!line.contains("/logs"));
            if let Some(retained) = retained_name.as_ref() {
                assert!(
                    !line.starts_with("DELETE") || !line.contains(retained),
                    "candidate cleanup must preserve the exact retained native HOME"
                );
            }
            assert!(!body
                .to_string()
                .contains("PRIVATE_IMAGE_CREDENTIAL_SENTINEL"));
            if body["Cmd"] == json!(["project-claude-candidate-private"]) {
                for target in [
                    "/run/freshell-candidate-inputs",
                    "/run/freshell-retained-inputs",
                ] {
                    let root = body["HostConfig"]["Mounts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|mount| mount["Target"] == target);
                    let Some(root) = root else {
                        assert!(
                            target == "/run/freshell-retained-inputs" && retained_name.is_none()
                        );
                        continue;
                    };
                    let root = root["Source"].as_str().unwrap();
                    assert!(
                    !Path::new(root).exists(),
                    "{mode}: owned ordinary mount skeleton must be gone after reader settlement"
                );
                }
            }
        }
        if let Some((_, body)) = seen
            .iter()
            .find(|(_, body)| body["Cmd"] == json!(["project-claude-candidate-private"]))
        {
            assert_eq!(body["User"], "0:0");
            assert_eq!(
                body["HostConfig"]["CapAdd"],
                json!(["CHOWN", "SETGID", "SETUID"])
            );
            assert_eq!(body["HostConfig"]["NetworkMode"], "none");
            assert_eq!(body["HostConfig"]["ReadonlyRootfs"], true);
            assert!(
                body["HostConfig"]["Tmpfs"].is_null() || body["HostConfig"]["Tmpfs"] == json!({})
            );
            assert_eq!(body["WorkingDir"], json!(request.observation_request.cwd));
            assert!(body["HostConfig"]["Mounts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["Target"] == "/run/freshell-candidate-inputs"
                    && m["Source"] != json!(stage)
                    && m["ReadOnly"] == true));
        }
    }
}

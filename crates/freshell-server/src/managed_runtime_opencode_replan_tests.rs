//! Actual initial controller callers with synthetic authenticated control transport.
use super::*;
use freshell_freshagent::hosted_rest::{HostedFreshAgentRestGateway, HostedRestCreate};
use freshell_runtime_protocol::*;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt};
use tokio::net::UnixListener;

#[test]
fn managed_provider_initial_opencode_callers_replan_changed_selection_with_two_retry_bound() {
    const CHILD: &str = "FRESHELL_TEST_INITIAL_OPENCODE_REPLAN_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "managed_runtime::opencode_replan_tests::managed_provider_initial_opencode_callers_replan_changed_selection_with_two_retry_bound", "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        print!("{}", String::from_utf8_lossy(&output.stdout));
        return;
    }
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let control = owned.path().join("control");
        for directory in [&home.join(".config/opencode"), &workspace, &control] { std::fs::create_dir_all(directory).unwrap(); }
        let config = home.join(".config/opencode/opencode.json");
        let raw = r#"{"agent":{"probe":{"prompt":"{file:{env:RULE_FILE}}"}}}"#;
        std::fs::write(&config, raw).unwrap();
        let files = (0..4).map(|index| {
            let path = workspace.join(format!("rules-{index}.txt"));
            std::fs::write(&path, format!("approved-consumption-{index}")).unwrap(); path
        }).collect::<Vec<_>>();
        let auth = owned.path().join("auth.json");
        let write_auth = |path: &Path| {
            std::fs::write(&auth, serde_json::to_vec(&serde_json::json!({"fixture":{"type":"wellknown","key":"RULE_FILE","token":path}})).unwrap()).unwrap();
            std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
        };
        write_auth(&files[0]);
        std::env::set_var("HOME", &home);
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("OPENCODE_CONFIG");
        std::env::remove_var("OPENCODE_CONFIG_DIR");
        std::env::remove_var("OPENCODE_CONFIG_CONTENT");
        std::env::set_var("FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE", &auth);
        std::env::remove_var("FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE");
        std::env::remove_var("FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE");
        std::env::set_var("FRESHELL_MANAGED_FRESH_AGENT_V1", "1");
        let socket = control.join("supervisor.sock");
        let secret = "fixture-opencode-control-secret";
        let secret_path = control.join("secret");
        std::fs::write(&secret_path, secret).unwrap();
        crate::managed_mcp_capability::configure("0.0.0.0", 45678, &socket, &secret_path).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let attempts = Arc::new(Mutex::new(BTreeMap::<String, usize>::new()));
        let consumed = Arc::new(Mutex::new(Vec::<String>::new()));
        let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn({
            let auth=auth.clone(); let files=files.clone(); let attempts=attempts.clone(); let consumed=consumed.clone(); let control=control.clone();
            async move { loop {
                let (mut stream, _) = tokio::select! { accepted=listener.accept() => accepted.unwrap(), _=&mut shutdown_rx => break };
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                assert_eq!(envelope.auth.as_deref(), Some(secret));
                let result = match envelope.body {
                    AdminCommand::Health => Ok(AdminResult::Health {control_epoch:1,installation_id:InstallationId::parse("fixture-installation").unwrap()}),
                    AdminCommand::Inventory => Ok(AdminResult::Inventory(vec![])),
                    AdminCommand::ReserveProviderInputs(request) => Ok(AdminResult::ProviderInputReservation(ProviderInputReservation {
                        reservation_id:uuid::Uuid::new_v4().to_string(),installation_id:InstallationId::parse("fixture-installation").unwrap(),soul_id:request.soul_id,provider:request.provider,creation_seed_ref:request.creation_seed_ref,intent_revision:1,provider_volume_name:"fixture-volume".into(),image_ref:"fixture-image".into(),host_binary_path:"/fixture/host".into(),host_binary_sha256:"a".repeat(64),observation:InitialAuthVolumeObservation::Absent {daemon_id:DockerDaemonId::parse("fixture-daemon").unwrap()},
                    })),
                    AdminCommand::BindProviderPathInputs(_) => Ok(AdminResult::ProviderPathInputsBound),
                    AdminCommand::Launch(request) => {
                        let soul=request.creation_seed_ref.clone();
                        let mut all=attempts.lock().await; let count=all.entry(soul).or_default(); *count+=1;
                        let changing=request.creation_seed_ref.contains("changing");
                        let uncertain=request.creation_seed_ref.contains("uncertain");
                        let references=request.terminal.as_ref().map(|s| &s.provider_secret_references).or_else(|| request.fresh_agent.as_ref().map(|s| &s.provider_secret_references)).unwrap();
                        let selected=references.iter().find(|r| r.profile==ProviderSecretProfile::OpencodeConfigurationFile).expect("approved file selection");
                        assert_eq!(Path::new(&selected.source_path), files[if changing {*count-1} else {usize::from(*count>1)}]);
                        let stages=std::fs::read_dir(control.join("mcp-capabilities")).unwrap().filter_map(Result::ok).filter_map(|e| std::fs::read(e.path()).ok()).filter_map(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).filter(|v|v["soulId"]==request.soul_id.as_str()).count();
                        assert!(stages<=2,"initial retry must not accumulate pending stages: {stages}");
                        if changing || *count==1 {
                            let next=if changing {*count} else {1};
                            std::fs::write(&auth, serde_json::to_vec(&serde_json::json!({"fixture":{"type":"wellknown","key":"RULE_FILE","token":files[next]}})).unwrap()).unwrap();
                            Err(RuntimeError::new(if uncertain {RuntimeErrorCode::HostUnreachable} else {RuntimeErrorCode::ProviderInputsChanged},"configuration reference selection changed before dispatch"))
                        } else {
                            consumed.lock().await.push(std::fs::read_to_string(&selected.source_path).unwrap());
                            let view:RuntimeView=serde_json::from_value(serde_json::json!({"soulId":request.soul_id,"incarnationId":IncarnationId::new(),"launchState":"running","cleanupState":"none","intentRevision":1,"executionGeneration":1,"desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated","evidenceRevision":0,"successfulRecoveriesInWindow":0})).unwrap();
                            Ok(AdminResult::Launch(LaunchResult {view,worker_pid:123,worker_launch_count:1,host_boot_id:HostBootId::new(),effective_limits:request.limits,fixture_evidence:serde_json::Value::Null}))
                        }
                    },
                    AdminCommand::FreshAgentReadEvents(_) => Err(RuntimeError::new(RuntimeErrorCode::HostUnreachable,"fixture poll completed")),
                    _=>panic!("unexpected control fixture operation"),
                };
                write_frame(&mut stream,&AdminReply {request_id:envelope.request_id,result}).await.unwrap();
            }}
        });
        let client=RuntimeClient::new(&socket, secret);
        let controller=ServerManagedRuntimeController {client:client.clone(), recovery:Arc::new(ManagedRecoveryState::default())};
        let (broadcast,_receiver)=tokio::sync::broadcast::channel(32);
        let fresh=crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(Some(client),Arc::new(broadcast)).unwrap().unwrap();
        let routes = if std::env::var("FRESHELL_TEST_INITIAL_OPENCODE_REPLAN_ROUTE").ok().as_deref()==Some("fresh") {vec![true]} else {vec![false,true]};
        for fresh_route in routes {
            for outcome in ["stable","changing","uncertain"] {
                let changing=outcome=="changing";
                let uncertain=outcome=="uncertain";
                write_auth(&files[0]);
                let seed=format!("{}-{}",if fresh_route {"fresh"} else {"terminal"},outcome);
                let soul=if fresh_route {SoulId::parse(format!("soul-fresh-opencode-{}",&format!("{:x}",Sha256::digest(seed.as_bytes()))[..32])).unwrap()} else {stable_soul_id(&seed).unwrap()};
                let prior=crate::managed_provider_references::prepare_managed_opencode(crate::managed_provider_references::OpencodePreparation {
                    client:&controller.client,soul:&soul,creation_seed:&seed,home:&home,cwd:&workspace,workspace:&workspace,
                    original:&|name|std::env::var(name).ok(),references:crate::managed_provider_bootstrap::named_provider_onecli_references("opencode").unwrap(),auth_authority:None,selected_sources:None,accepted_global_root:None,selected_resource_roots:None,native_source_flags:None,rebind_enabled:None,inherited_inline:None,inline_edits:None,
                }).await.unwrap();
                crate::managed_mcp_capability::accept_initial_replan_fixture_preparation(&soul, &prior.context).unwrap();
                let prior_grant=prior.context.mcp_capability.as_ref().unwrap().grant_id.clone();
                let prior_stage=control.join("provider-roots").join(&prior_grant);
                let prior_manifest=std::fs::read(prior_stage.join(".freshell/input-manifest.json")).unwrap();
                let result=if fresh_route {
                    fresh.clone().create_agent(HostedRestCreate {request_id:seed.clone(),provider:"opencode".into(),session_type:"freshopencode".into(),cwd:Some(workspace.to_string_lossy().into_owned()),model:None,effort:None,native_session_id:None,plugins:None,model_selection:None,permission_mode:None,sandbox:None}).await.map(|_|()).map_err(|_|"fresh refusal".to_string())
                } else {
                    controller.launch(ManagedTerminalLaunch {spec:freshell_platform::SpawnSpec {program:"opencode".into(),args:vec![],env_overrides:BTreeMap::new(),cwd:Some(workspace.to_string_lossy().into_owned()),cols:80,rows:24},env:BTreeMap::new(),terminal_id:seed.clone(),stream_id:seed.clone(),mode:"opencode".into(),resume_session_id:None,provider_model:None,provider_reasoning_effort:None,provider_sandbox:None,provider_permission_mode:None,view_tab_id:None,view_pane_id:None,create_request_id:Some(seed.clone())}).await.map(|_|())
                };
                assert_eq!(result.is_ok(),!changing && !uncertain,"actual initial caller fresh={fresh_route} changing={changing}: {result:?}");
                assert_eq!(attempts.lock().await[&seed],if uncertain {1} else if changing {3} else {2});
                assert_eq!(std::fs::read(prior_stage.join(".freshell/input-manifest.json")).unwrap(),prior_manifest,"prior usable preparation is preserved");
                assert!(control.join("mcp-capabilities").join(format!("{prior_grant}.json")).is_file());
                assert_eq!(std::fs::read_to_string(&prior.references.iter().find(|r|r.profile.is_configuration_file()).unwrap().source_path).unwrap(),"approved-consumption-0");
                if uncertain { // Both current and prior ownership remain available for reconciliation.
                    let grants=std::fs::read_dir(control.join("mcp-capabilities")).unwrap().filter_map(Result::ok).filter_map(|e|std::fs::read(e.path()).ok()).filter_map(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).filter(|v|v["soulId"]==soul.as_str()).count();
                    assert_eq!(grants,2);
                }
                println!("initial_opencode_caller {{\"route\":\"{}\",\"outcome\":\"{}\",\"attempts\":{}}}",if fresh_route {"fresh"} else {"terminal"},outcome,attempts.lock().await[&seed]);
                assert_eq!(std::fs::read_to_string(&config).unwrap(),raw);
            }
        }
        assert!(consumed.lock().await.iter().all(|v|v=="approved-consumption-1"));
        assert_eq!(consumed.lock().await.len(),if std::env::var("FRESHELL_TEST_INITIAL_OPENCODE_REPLAN_ROUTE").ok().as_deref()==Some("fresh") {1} else {2});
        // Polling receives an error then empty inventory and settles on the same runtime.
        tokio::task::yield_now().await;
        shutdown.send(()).unwrap(); server.await.unwrap();
    });
}

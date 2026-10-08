use super::*;
use freshell_platform::claude_inputs::observation::{LocalDecision, NativeObservation};
use freshell_runtime_protocol::{
    ClaudeSourceAuthority, InitialAuthVolumeObservation, ReserveProviderInputsRequest,
};
use std::sync::{Arc, Mutex};
use tokio::{net::UnixListener, task::JoinSet};

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

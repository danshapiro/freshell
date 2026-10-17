//! Explicit, provider-free Linux contract. Run only in a disposable rootless
//! Docker PID namespace; the retaining parent settles exactly its own PTY.
use super::*;
use freshell_supervisor::backend::{CreateRuntimeSpec, DockerEngineBackend, RuntimeBackend};
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, process::Command as StdCommand};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TEST: &str = "stop_contract_tests::managed_host_stop_reaps_its_different_uid_provider";
const CHILD_CAPS: &str = "FRESHELL_STOP_CONTRACT_CHILD_CAPS";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn launch(root: &Path) -> TerminalLaunchSpec {
    serde_json::from_value(serde_json::json!({
        "terminalId":"stop-contract", "streamId":"stop-contract", "mode":"shell",
        "program":"/bin/sh", "args":["-c","exec /bin/sleep 120"],
        "cwd":root, "workspacePath":root, "projectKey":"stop-contract",
        "cols":80,"rows":24,"runAsUid":65534,"runAsGid":0,
        "env":{"PATH":"/usr/bin:/bin"}
    }))
    .unwrap()
}

/// Capture the real production serializer across its Unix HTTP boundary.
async fn create_capabilities(root: &Path, fresh: bool) -> Vec<String> {
    let socket = root.join("docker.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let daemon = tokio::spawn(async move {
        let mut capabilities = None;
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(stream.read_u8().await.unwrap());
            }
            let head = String::from_utf8(head).unwrap();
            let length: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            let (status, response) = if head.starts_with("GET /v1.47/info ") {
                (
                    200,
                    serde_json::json!({"ID":"stop-contract-daemon","SecurityOptions":["name=rootless"]}),
                )
            } else {
                assert!(head.starts_with("POST /v1.47/containers/create?"));
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                capabilities =
                    Some(serde_json::from_value(body["HostConfig"]["CapAdd"].clone()).unwrap());
                (201, serde_json::json!({"Id":"a".repeat(64)}))
            };
            let response = serde_json::to_vec(&response).unwrap();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.write_all(&response).await.unwrap();
            stream.shutdown().await.unwrap();
        }
        capabilities.unwrap()
    });
    let installation_id = freshell_runtime_protocol::InstallationId::new();
    let soul_id = SoulId::new();
    let incarnation_id = IncarnationId::new();
    let runtime_dir = root.join(incarnation_id.as_str());
    std::fs::create_dir(&runtime_dir).unwrap();
    let actor_key = format!(
        "{:x}",
        Sha256::digest(format!("{installation_id}\0{soul_id}"))
    );
    let actor = root.join("souls").join(actor_key).join("actor");
    std::fs::create_dir_all(&actor).unwrap();
    std::fs::set_permissions(&actor, std::fs::Permissions::from_mode(0o700)).unwrap();
    let agent = fresh.then(|| {
        serde_json::from_value(serde_json::json!({
            "sessionId":"stop-contract", "provider":"codex", "sessionType":"freshcodex",
            "runtimeVariant":"stop-contract", "providerStoreId":"stop-contract",
            "cwd":root,"workspacePath":root,"runAsUid":65534,"runAsGid":0
        }))
        .unwrap()
    });
    let spec = CreateRuntimeSpec {
        installation_id,
        soul_id,
        incarnation_id,
        image_ref: format!("sha256:{}", "b".repeat(64)),
        host_binary_path: std::env::current_exe().unwrap(),
        runtime_dir,
        limits: RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 128 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 64,
        },
        test_run_id: "stop-contract".into(),
        terminal: (!fresh).then(|| launch(root)),
        fresh_agent: agent,
        opencode_transfer_dir: None,
        provider_volume_name: "freshell-provider-stop-contract".into(),
        initial_input_reservation: None,
        prior_provider_owner: None,
    };
    DockerEngineBackend::new(&socket)
        .create_stopped(&spec)
        .await
        .unwrap();
    daemon.await.unwrap()
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn apply_capabilities(capabilities: &[String]) {
    let mut mask = 0u32;
    for capability in capabilities {
        mask |= 1
            << match capability.as_str() {
                "CHOWN" => 0,
                "KILL" => 5,
                "SETGID" => 6,
                "SETUID" => 7,
                other => panic!("unexpected production capability {other}"),
            };
    }
    let header = CapHeader {
        version: 0x2008_0522,
        pid: 0,
    };
    let data = [
        CapData {
            effective: mask,
            permitted: mask,
            inheritable: 0,
        },
        CapData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
    ];
    // Only this disposable test child changes its thread's kernel credentials.
    assert_eq!(
        unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) },
        0
    );
}

fn proc_identity(pid: u32) -> Option<(String, i32)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    Some((fields.get(19)?.to_string(), fields.get(2)?.parse().ok()?))
}

async fn child(capabilities: &[String], evidence: &Path) {
    let state = Arc::new(HostState {
        incarnation_id: IncarnationId::new(),
        host_boot_id: HostBootId::new(),
        state_dir: evidence.to_owned(),
        secret: b"owned-stop-contract-secret".to_vec(),
        requested_limits: RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 128 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 64,
        },
        control_fence: std::sync::Mutex::new(HostControlFence {
            max_control_epoch: 1,
            max_execution_generation: 1,
            stopped: false,
        }),
        persisted: Mutex::new(PersistedHostState {
            max_control_epoch: 1,
            max_execution_generation: 1,
            ..Default::default()
        }),
        child: Mutex::new(None),
        pty: Mutex::new(None),
        fresh_agent: Mutex::new(None),
        fresh_native_command: Mutex::new(()),
        provider_config_paths: ProviderConfigPaths::default(),
        opencode_transfer_mount: PathBuf::from(OPENCODE_TRANSFER_MOUNT),
        bootstrap_root: PathBuf::from("/run/freshell-bootstrap"),
    });
    let pty = HostedPty::spawn(
        evidence,
        state.incarnation_id.clone(),
        &launch(evidence),
        BTreeMap::new(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let pid = pty.pid();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        if status
            .lines()
            .any(|line| line.starts_with("Uid:\t65534\t65534\t65534\t65534"))
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "provider UID transition did not complete"
        );
        sleep(Duration::from_millis(10)).await;
    }
    let (start, group) = proc_identity(pid).unwrap();
    assert_eq!(group, pid as i32, "PTY must own its process group");
    *state.pty.lock().await = Some(pty);
    apply_capabilities(capabilities);
    let permission = unsafe { libc::kill(pid as i32, 0) };
    let permission_errno =
        (permission != 0).then(|| io::Error::last_os_error().raw_os_error().unwrap());
    let group_permission = unsafe { libc::kill(-group, 0) };
    let group_errno =
        (group_permission != 0).then(|| io::Error::last_os_error().raw_os_error().unwrap());
    std::fs::write(
        evidence.join("ready.json"),
        serde_json::to_vec(&serde_json::json!({
            "pid":pid,"start":start,"group":group,"permission":permission,"errno":permission_errno,
            "groupPermission":group_permission,"groupErrno":group_errno
        }))
        .unwrap(),
    )
    .unwrap();
    let (mut client, server) = UnixStream::pair().unwrap();
    let serving = tokio::spawn(handle_connection(server, state.clone()));
    let mut envelope = Envelope::new(
        freshell_runtime_protocol::RequestId::new(),
        ControlRole::Supervisor,
        HostCommand::Stop {
            incarnation_id: state.incarnation_id.clone(),
            control_epoch: 1,
            execution_generation: 1,
        },
    );
    envelope.auth = Some(host_proof(
        &state.secret,
        "command-auth",
        &state.host_boot_id,
        &state.incarnation_id,
    ));
    write_frame(&mut client, &envelope).await.unwrap();
    let reply: HostReply = read_frame(&mut client).await.unwrap();
    assert!(matches!(reply.result.unwrap(), HostResult::Stopped));
    serving.await.unwrap().unwrap();
    assert!(state.pty.lock().await.is_none());
    std::fs::write(evidence.join("completed"), b"stopped").unwrap();
}

fn run_child(capabilities: &[String], evidence: &Path, expect_authority: bool) -> bool {
    let mut child = StdCommand::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env(CHILD_CAPS, serde_json::to_string(capabilities).unwrap())
        .env("FRESHELL_STOP_CONTRACT_EVIDENCE", evidence)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !evidence.join("ready.json").exists() && std::time::Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "probe exited before ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready: serde_json::Value =
        serde_json::from_slice(&std::fs::read(evidence.join("ready.json")).unwrap()).unwrap();
    let pid = ready["pid"].as_u64().unwrap() as u32;
    let group = ready["group"].as_i64().unwrap() as i32;
    let start = ready["start"].as_str().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let initial = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if std::time::Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stopped_before_cleanup = evidence.join("completed").exists();
    let log = std::fs::read_to_string(evidence.join("host-lifecycle.jsonl")).unwrap_or_default();
    let event_before_cleanup = log.lines().any(|line| {
        serde_json::from_str::<serde_json::Value>(line).unwrap()["event"] == "host.stop_requested"
    });
    println!(
        "{}",
        serde_json::json!({"severity":"info","event":"stop_contract.initial","capabilities":capabilities,
        "kernel":ready,"completedBeforeCleanup":stopped_before_cleanup,"stopEventBeforeCleanup":event_before_cleanup})
    );
    if initial.is_none() {
        assert_eq!(
            proc_identity(pid),
            Some((start.to_string(), group)),
            "owned provider identity changed before settlement"
        );
        assert_eq!(
            unsafe { libc::kill(-group, libc::SIGKILL) },
            0,
            "retaining sandbox parent must settle only owned PTY group"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "owned probe failed to settle after exact group cleanup"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    assert!(
        proc_identity(pid).is_none(),
        "PTY waiter must reap exact owned provider"
    );
    if expect_authority {
        ready["permission"] == 0
            && ready["groupPermission"] == 0
            && stopped_before_cleanup
            && event_before_cleanup
            && initial.is_some_and(|status| status.success())
    } else {
        ready["errno"] == libc::EPERM
            && ready["groupErrno"] == libc::EPERM
            && !stopped_before_cleanup
            && !event_before_cleanup
    }
}

#[test]
fn managed_host_stop_reaps_its_different_uid_provider() {
    assert_eq!(
        std::env::var("FRESHELL_STOP_CONTRACT_SANDBOX").as_deref(),
        Ok("rootless-disposable"),
        "run this explicit contract only in its isolated rootless sandbox"
    );
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "probe needs sandbox UID0, never host elevation"
    );
    if let Ok(capabilities) = std::env::var(CHILD_CAPS) {
        runtime().block_on(child(
            &serde_json::from_str::<Vec<String>>(&capabilities).unwrap(),
            Path::new(&std::env::var("FRESHELL_STOP_CONTRACT_EVIDENCE").unwrap()),
        ));
        return;
    }
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut outcomes = Vec::new();
    for fresh in [false, true] {
        let policy = root.path().join(if fresh {
            "fresh-policy"
        } else {
            "terminal-policy"
        });
        std::fs::create_dir(&policy).unwrap();
        std::fs::set_permissions(&policy, std::fs::Permissions::from_mode(0o755)).unwrap();
        let capabilities = runtime().block_on(create_capabilities(&policy, fresh));
        let evidence = policy.join("evidence");
        std::fs::create_dir(&evidence).unwrap();
        outcomes.push(run_child(&capabilities, &evidence, true));
        if !fresh {
            let mut denied = capabilities.clone();
            denied.retain(|cap| cap != "KILL");
            let evidence = policy.join("denied");
            std::fs::create_dir(&evidence).unwrap();
            assert!(
                run_child(&denied, &evidence, false),
                "missing signal authority must remain a real denied/unfinished Stop"
            );
        }
    }
    assert!(outcomes.into_iter().all(|ok|ok),"production managed runtime policy must allow real authenticated Stop and PTY Drop to finish before cleanup");
}

use super::*;

#[test]
fn parallel_host_fixture_state_directories_are_independent() {
    let barrier = Arc::new(std::sync::Barrier::new(32));
    let workers: Vec<_> = (0..32)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let state = test_host_state();
                let marker = state.incarnation_id.to_string();
                std::fs::write(state.state_dir.join("fixture-owner"), &marker).unwrap();
                (state, marker)
            })
        })
        .collect();
    let fixtures: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    for (state, marker) in fixtures {
        assert_eq!(
            std::fs::read_to_string(state.state_dir.join("fixture-owner")).unwrap(),
            marker,
            "parallel fixtures must retain their own physical state"
        );
    }
}

async fn probe(state: &Arc<HostState>, never_dispatched: bool) -> RecoveryProbe {
    let result = dispatch(
        authenticated_host_envelope(
            state,
            HostCommand::ProbeRecovery {
                incarnation_id: state.incarnation_id.clone(),
                resume_spec: None,
                creation_seed_ref: "original-seed".into(),
                never_dispatched,
                run_as_uid: unsafe { libc::geteuid() },
                run_as_gid: unsafe { libc::getegid() },
            },
        ),
        state,
    )
    .await
    .unwrap();
    let HostResult::RecoveryProbe(probe) = result else {
        panic!("wrong result")
    };
    probe
}

#[tokio::test]
async fn dispatched_without_identity_blocks_and_preserves_data() {
    let state = test_host_state();
    std::fs::write(state.state_dir.join("conversation"), b"accepted-turn").unwrap();
    state.persisted.lock().await.fixture_evidence = serde_json::json!({"mode":"opencode"});
    assert!(matches!(
        probe(&state, false).await,
        RecoveryProbe::Blocked { .. }
    ));
    assert_eq!(
        std::fs::read(state.state_dir.join("conversation")).unwrap(),
        b"accepted-turn"
    );
}

#[tokio::test]
async fn startup_before_identity_retains_diagnostic() {
    let state = test_host_state();
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"early-exit", "streamId":"early-exit", "mode":"shell", "program":"/bin/sh",
        "args":["-c","echo synthetic-startup-failure >&2; exit 23"], "env":{}, "cwd":state.state_dir,
        "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()}, "cols":80,"rows":24,
        "projectKey":"fixture", "workspacePath":state.state_dir
    })).unwrap();
    let pty = HostedPty::spawn(
        &state.state_dir,
        state.incarnation_id.clone(),
        &terminal,
        std::collections::BTreeMap::new(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    *state.pty.lock().await = Some(pty);
    state.persisted.lock().await.fixture_evidence = serde_json::json!({"mode":"opencode"});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let mut guard = state.pty.lock().await;
        let pty = guard.as_mut().unwrap();
        let output = pty.read_output(state.incarnation_id.clone(), 0, 64 * 1024, None);
        if serde_json::to_string(&output)
            .unwrap()
            .contains("synthetic-startup-failure")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "startup diagnostic missing"
        );
        drop(guard);
        sleep(Duration::from_millis(10)).await;
    }
    let result = probe(&state, false).await;
    let mut guard = state.pty.lock().await;
    let pty = guard.as_mut().unwrap();
    let output = pty.read_output(state.incarnation_id.clone(), 0, 64 * 1024, None);
    pty.stop().await;
    assert!(matches!(result, RecoveryProbe::Blocked { .. }));
    assert!(serde_json::to_string(&output)
        .unwrap()
        .contains("synthetic-startup-failure"));
    assert_eq!(
        state.persisted.lock().await.worker_launch_count,
        0,
        "no replacement"
    );
}

#[tokio::test]
async fn pristine_seed_still_recovers() {
    let state = test_host_state();
    assert!(matches!(probe(&state, true).await,
        RecoveryProbe::PristineSeedReady { seed, .. } if seed == "original-seed"));
}

#[tokio::test]
async fn cold_initialization_without_worker_does_not_claim_live() {
    for (grant_recorded, worker_pid, worker_launch_count) in [
        (true, Some(123), 1),
        (false, Some(123), 1),
        (false, None, 1),
    ] {
        let state = test_host_state();
        {
            let mut persisted = state.persisted.lock().await;
            persisted.provider = Some("opencode".into());
            persisted.grant_id = grant_recorded.then(GrantId::new);
            persisted.worker_pid = worker_pid;
            persisted.worker_launch_count = worker_launch_count;
            write_state(&state.state_dir, &persisted).unwrap();
        }
        std::fs::write(
            state.state_dir.join("retained-output"),
            b"startup diagnostic",
        )
        .unwrap();
        let status = dispatch(
            authenticated_host_envelope(
                &state,
                HostCommand::Status {
                    incarnation_id: state.incarnation_id.clone(),
                },
            ),
            &state,
        )
        .await;
        assert!(
            status.is_err(),
            "durable grant and stale PID cannot prove a live worker: {status:?}"
        );
        assert!(matches!(
            probe(&state, false).await,
            RecoveryProbe::Blocked {
                path: RecoveryPath::NativeResume,
                reason: freshell_runtime_protocol::RecoveryBlockReason::StoreUnreadable,
                ..
            }
        ));
        assert_eq!(
            std::fs::read(state.state_dir.join("retained-output")).unwrap(),
            b"startup diagnostic"
        );
    }
}

#[tokio::test]
async fn shell_without_native_paths_uses_terminal_end_policy() {
    let state = test_host_state();
    state.persisted.lock().await.fixture_evidence = serde_json::json!({"mode":"shell"});
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"ended-shell", "streamId":"ended-shell", "mode":"shell", "program":"/bin/sh",
        "args":["-c","echo synthetic-shell-end; exit 0"], "env":{}, "cwd":state.state_dir,
        "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()}, "cols":80,"rows":24,
        "projectKey":"fixture", "workspacePath":state.state_dir
    })).unwrap();
    *state.pty.lock().await = Some(
        HostedPty::spawn(
            &state.state_dir,
            state.incarnation_id.clone(),
            &terminal,
            std::collections::BTreeMap::new(),
            None,
            None,
            None,
        )
        .await
        .unwrap(),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !state.pty.lock().await.as_ref().unwrap().exited() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "shell end was not observed"
        );
        sleep(Duration::from_millis(10)).await;
    }
    let result = probe(&state, false).await;
    state.pty.lock().await.as_mut().unwrap().stop().await;
    assert!(matches!(
        result,
        RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::Reattach,
            ..
        }
    ));
}

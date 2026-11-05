// Included in automatic_retry_tests to reuse its real registry, store reader,
// and authenticated host IPC. A fatal worker-stack regression stays in a child.
fn native_recovery_stage(stage: &str) {
    eprintln!(
        "{}",
        serde_json::json!({"severity":"info", "event":"test.native_recovery", "stage":stage})
    );
}

#[derive(Default)]
struct NativeRecoveryReadiness {
    pending: tokio::sync::Notify,
    release: tokio::sync::Notify,
    released: std::sync::atomic::AtomicBool,
    grants: std::sync::atomic::AtomicUsize,
}

async fn native_recovery_control(
    socket: &Path,
    command: freshell_runtime_protocol::AdminCommand,
) -> freshell_runtime_protocol::AdminResult {
    use freshell_runtime_protocol::{AdminReply, ControlRole, RequestId};
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let mut request = Envelope::new(RequestId::new(), ControlRole::Web, command);
    request.auth = Some("synthetic-secret".into());
    write_frame(&mut stream, &request).await.unwrap();
    let reply: AdminReply = read_frame(&mut stream).await.unwrap();
    reply.result.unwrap()
}

async fn exercise_native_recovery_worker(root: &Path, wrong_identity: bool) {
    use freshell_runtime_protocol::{AdminCommand, AdminResult, LaunchState};
    let (seeded, _, _) = open(root, 0);
    let soul = seed_native(&seeded, root).await;
    let before = seeded
        .registry
        .recovery_context(soul.clone())
        .await
        .unwrap();
    let initial = seeded.registry.inventory().await.unwrap();
    assert_eq!(initial[0].launch_state, LaunchState::Running);
    assert_eq!(initial[0].recovery_state, RecoveryState::Live);
    let readiness = Arc::new(NativeRecoveryReadiness::default());
    let mut backend = RetryBackend::new(root, Arc::new(AtomicI64::new(0)));
    backend.native_readiness = Some(readiness.clone());
    let backend = Arc::new(backend);
    let supervisor = Supervisor::new(
        seeded.registry.clone(),
        backend.clone(),
        (*seeded.config).clone(),
    )
    .unwrap();
    drop(seeded);
    let socket = supervisor.config.control_socket_path.clone();
    let control = tokio::spawn({
        let supervisor = supervisor.clone();
        let socket = socket.clone();
        async move { crate::service::serve_control(supervisor, &socket).await }
    });
    while !socket.exists() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    native_recovery_stage("observe_live");
    // observe_once spawns the same per-soul worker used by the live observer.
    // The missing old enclosure requires exact saved-store recovery before
    // replacement activation; no native readiness or Running event is forged.
    let observing = tokio::spawn({
        let supervisor = supervisor.clone();
        async move { supervisor.observe_once().await }
    });
    tokio::time::timeout(Duration::from_secs(15), readiness.pending.notified())
        .await
        .expect("replacement must reach its first post-grant Status");
    assert_eq!(readiness.grants.load(Ordering::SeqCst), 1);
    assert!(matches!(
        native_recovery_control(&socket, AdminCommand::Health).await,
        AdminResult::Health { .. }
    ));
    let AdminResult::Inventory(pending) =
        native_recovery_control(&socket, AdminCommand::Inventory).await
    else {
        panic!("expected inventory while native readiness is held")
    };
    let replacements: Vec<_> = pending
        .iter()
        .filter(|row| {
            row.soul_id == soul && &row.incarnation_id != before.prior_handle.incarnation_id()
        })
        .collect();
    assert_eq!(replacements.len(), 1);
    let replacement = replacements[0];
    assert_eq!(replacement.launch_state, LaunchState::Starting);
    if wrong_identity {
        let current = supervisor
            .registry
            .owned_handle(replacement.incarnation_id.clone())
            .await
            .unwrap();
        std::fs::write(current.runtime_dir().join("final-wrong-identity"), b"wrong").unwrap();
    }
    readiness.released.store(true, Ordering::Release);
    readiness.release.notify_one();
    observing.await.unwrap().unwrap();
    let after = supervisor
        .registry
        .recovery_context(soul.clone())
        .await
        .unwrap();
    assert_eq!(after.native_session_id, before.native_session_id);
    assert_eq!(backend.count("creates"), 1);
    assert_eq!(readiness.grants.load(Ordering::SeqCst), 1);
    if wrong_identity {
        assert_ne!(after.recovery_state, RecoveryState::Live);
        assert!(supervisor
            .registry
            .inventory()
            .await
            .unwrap()
            .iter()
            .all(|row| row.soul_id != soul || row.launch_state != LaunchState::Running));
    } else {
        assert_eq!(after.recovery_state, RecoveryState::Live);
        assert_ne!(
            after.prior_handle.incarnation_id(),
            before.prior_handle.incarnation_id()
        );
        let conn = Connection::open(supervisor.registry.database_path()).unwrap();
        let writer: String = conn
            .query_row(
                "SELECT incarnation_id FROM writer_claims WHERE soul_id=?1",
                [soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(writer, after.prior_handle.incarnation_id().as_str());
        assert_root_and_successes(&supervisor, &soul, 1).await;
    }
    assert!(matches!(
        native_recovery_control(&socket, AdminCommand::Health).await,
        AdminResult::Health { .. }
    ));
    native_recovery_stage("worker_settled");
    control.abort();
    let _ = control.await;
}

#[test]
fn observer_native_recovery_runs_on_normal_runtime_workers() {
    const CHILD: &str = "FRESHELL_NATIVE_RECOVERY_STACK_CHILD";
    const NAME: &str =
        "recovery::automatic_retry_tests::observer_native_recovery_runs_on_normal_runtime_workers";
    if std::env::var(CHILD).as_deref() == Ok("1") {
        for wrong_identity in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(Box::pin(exercise_native_recovery_worker(
                dir.path(),
                wrong_identity,
            )));
            // Drop every listener, peer and maintenance task before its owned files.
            drop(runtime);
            drop(dir);
        }
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let stdout = dir.path().join("stdout");
    let stderr = dir.path().join("stderr");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", NAME, "--nocapture"])
        .env(CHILD, "1")
        .env_remove("RUST_MIN_STACK")
        .stdout(std::fs::File::create(&stdout).unwrap())
        .stderr(std::fs::File::create(&stderr).unwrap())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned native recovery child exceeded its bounded deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stderr = std::fs::read_to_string(stderr).unwrap();
    assert!(
        status.success(),
        "native recovery child {status}\n{}\n{stderr}",
        std::fs::read_to_string(stdout).unwrap()
    );
    eprint!("{stderr}");
}

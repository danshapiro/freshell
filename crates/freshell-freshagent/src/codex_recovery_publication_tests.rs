async fn crashed_publication_fixture() -> (
    FreshCodexState,
    String,
    Arc<crate::identity_sink::FakeIdentitySink>,
) {
    configure_fake_codex_cmd(r#"{"threadStartThreadId":"publication-original"}"#);
    let (state, mut rx, sink) = state_with_sink();
    let id = create_real_fake_session(&state, &mut rx).await;
    let (pid, runtime) = {
        let sessions = state.sessions.lock().await;
        let old = &sessions[&id];
        (old.sidecar_pid.unwrap(), old.sidecar_ownership_id.clone())
    };
    assert!(
        crate::session_lease::kill_and_confirm_tree_dead(
            pid,
            CODEX_SIDECAR_OWNERSHIP_ENV,
            &runtime
        )
        .await
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let done = {
                let sessions = state.sessions.lock().await;
                let old = &sessions[&id];
                old.watcher.is_finished() && old.consumer.is_finished()
            };
            if done {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the original writer is confirmed dead");
    state.leases.clear_binding(PROVIDER, &id);
    (state, id, sink)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn superseded_successful_crash_resume_retains_lease_until_exact_writer_teardown() {
    let _env = ENV_LOCK.lock().await;
    let (mut state, id, _sink) = crashed_publication_fixture().await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests");
    let release = temporary.path().join("release");
    configure_fake_codex_cmd(
        &json!({"appendRequestLogPath":requests,
        "waitForThreadResumeReleasePath":release})
        .to_string(),
    );
    let (mut cleanup_entered, mut cleanup_completed, cleanup_release) =
        arm_delayed_exact_cleanup(&state);
    let recovery_state = state.clone();
    let recovery_id = id.clone();
    let task = tokio::spawn(async move {
        recovery_state
            .ensure_session_alive(&recovery_id, None, DeadThreadCachePolicy::Respect)
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if std::fs::read_to_string(&requests)
                .unwrap_or_default()
                .lines()
                .filter_map(|row| serde_json::from_str::<Value>(row).ok())
                .any(|row| row["method"] == "thread/resume")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the successful native reply is parked");
    let freshell_ownership::OwnershipState::Starting {
        operation_id,
        generation,
        ..
    } = registry.observe(PROVIDER, &id).state
    else {
        panic!("recovery is Starting")
    };
    registry.fail(PROVIDER, &id, &operation_id, generation, false);
    assert!(matches!(
        registry.begin_start(
            PROVIDER,
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "takeover",
            None,
            "test",
            0
        ),
        freshell_ownership::BeginOutcome::Granted { .. }
    ));
    let replacement = registry.observe(PROVIDER, &id);
    std::fs::write(&release, "release").unwrap();
    let recorded = tokio::time::timeout(Duration::from_secs(3), cleanup_entered.recv())
        .await
        .expect("a successful superseded resume must enter confirmed writer teardown")
        .expect("cleanup probe remains connected");
    assert!(
        !task.is_finished(),
        "superseded reply waits for writer death"
    );
    assert!(
        matches!(
            state.leases.claim(
                PROVIDER,
                &id,
                "competitor",
                crate::session_lease::now_epoch_ms()
            ),
            crate::session_lease::FreshSessionClaim::Held { .. }
        ),
        "lease remains held during exact teardown"
    );
    assert_eq!(registry.observe(PROVIDER, &id), replacement);
    assert_eq!(
        state.condemned_priors.lock().unwrap()[&id].ownership_id,
        recorded.ownership_id
    );
    cleanup_release.send(true).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), cleanup_completed.recv())
            .await
            .unwrap()
            .unwrap()
    );
    let result = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(EnsureAliveError::Superseded(_))));
    assert!(crate::ownership_lane::partial_pid_confirmed_dead(
        recorded.pid
    ));
    assert!(matches!(
        state.leases.claim(
            PROVIDER,
            &id,
            "after-death",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Acquired
    ));
    state.leases.fail(PROVIDER, &id, "after-death");
    assert_eq!(registry.observe(PROVIDER, &id), replacement);
    state.shutdown().await;
}

#[test]
fn classified_create_refusal_uses_ownership_message_instead_of_native_error() {
    let (state, mut rx) = state_with_bus();
    let outcome = state.fail_create_classified(
        "req-source-message",
        None,
        "FRESH_AGENT_CREATE_FAILED",
        "no rollout found for thread id old",
        Some(CodexSuperseded {
            message: "ownership changed while recovering old".into(),
            owner: None,
        }),
    );
    let CodexCreateOutcome::Failed {
        message, recovery, ..
    } = outcome
    else {
        panic!("failure")
    };
    assert_eq!(message, "ownership changed while recovering old");
    assert!(recovery.is_superseded());
    let wire: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(wire["message"], "ownership changed while recovering old");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn superseded_mint_entry_releases_the_already_confirmed_dead_lease() {
    let _env = ENV_LOCK.lock().await;
    let (mut state, id, _) = crashed_publication_fixture().await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let source = registry.observe(PROVIDER, &id);
    assert!(matches!(
        registry.begin_start(
            PROVIDER,
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "takeover",
            None,
            "test",
            0
        ),
        freshell_ownership::BeginOutcome::Granted { .. }
    ));
    assert!(matches!(
        state.leases.claim(
            PROVIDER,
            &id,
            "recovery",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Acquired
    ));
    let mut lease =
        crate::FreshSessionLeaseGuard::armed(state.leases.clone(), PROVIDER, &id, "recovery");
    {
        let sessions = state.sessions.lock().await;
        let old = &sessions[&id];
        lease.set_kill_handle(old.sidecar_pid.unwrap(), &old.sidecar_ownership_id);
    }
    let result = state
        .respawn_as_new_thread_after_crash(
            &id,
            CodexEffectiveSettings {
                cwd: None,
                model: String::new(),
                effort: None,
                sandbox: None,
                permission_mode: None,
                collaboration_mode: None,
            },
            Some(lease),
            None,
            None,
            Some((source.epoch, source.generation)),
        )
        .await;
    assert!(matches!(result, Err(EnsureAliveError::Superseded(_))));
    assert!(
        matches!(
            state.leases.claim(
                PROVIDER,
                &id,
                "after-rejection",
                crate::session_lease::now_epoch_ms()
            ),
            crate::session_lease::FreshSessionClaim::Acquired
        ),
        "no writer remains to justify holding the recovery lease"
    );
    state.leases.fail(PROVIDER, &id, "after-rejection");
    state.shutdown().await;
}

async fn wait_for_publication_resume(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|row| serde_json::from_str::<Value>(row).ok())
                .any(|row| row["method"] == "thread/resume")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the native resume reaches its reply gate");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn historical_not_found_rechecks_authority_after_waiting_for_the_dead_cache() {
    let _env = ENV_LOCK.lock().await;
    let (mut state, _, _) = state_with_sink();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests");
    let release = temporary.path().join("release");
    let pid_path = temporary.path().join("pid");
    let id = "publication-historical";
    configure_fake_codex_cmd(
        &json!({"appendRequestLogPath":requests, "sidecarPidFile":pid_path,
        "waitForResumeReleasePath":release, "overrides":{"thread/resume":{"error":{
            "code":-32600, "message":format!("no rollout found for thread id {id}")}}}})
        .to_string(),
    );
    let st = state.clone();
    let task = tokio::spawn(async move { st.ensure_session_resumable(id, None, None, None).await });
    wait_for_publication_resume(&requests).await;
    let cache = state.dead_threads.lock().await;
    std::fs::write(&release, "release").unwrap();
    let pid: u32 = std::fs::read_to_string(pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !crate::ownership_lane::partial_pid_confirmed_dead(pid) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the failed native writer settles before the cache write");
    let freshell_ownership::OwnershipState::Starting {
        operation_id,
        generation,
        ..
    } = registry.observe(PROVIDER, id).state
    else {
        panic!("cache writer still holds its claim")
    };
    registry.fail(PROVIDER, id, &operation_id, generation, false);
    registry.begin_start(
        PROVIDER,
        id,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "new-owner",
        None,
        "test",
        0,
    );
    drop(cache);
    let outcome = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(outcome, Err(ResumeSessionError::Superseded(_))),
        "the stale cache writer must return supersession"
    );
    assert!(
        !state.is_known_dead_thread(id).await,
        "a stale native absence cannot poison the cache"
    );
    state.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_readiness_reports_superseded_recovery_distinctly() {
    let _env = ENV_LOCK.lock().await;
    let (state, id, sink) = crashed_publication_fixture().await;
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests");
    let release = temporary.path().join("release");
    configure_fake_codex_cmd(
        &json!({"appendRequestLogPath":requests,"waitForResumeReleasePath":release,
        "overrides":{"thread/resume":{"error":{"code":-32042,"message":"provider reply 437"}}}})
        .to_string(),
    );
    let st = state.clone();
    let sid = id.clone();
    let task = tokio::spawn(async move { st.prepare_native_readiness(&sid).await });
    wait_for_publication_resume(&requests).await;
    crate::PaneIdentitySink::retire_closed(sink.as_ref(), PROVIDER, &id)
        .await
        .unwrap();
    std::fs::write(&release, "release").unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(result, Err(CodexNativeReadinessError::Superseded)),
        "{result:?}"
    );
    state.shutdown().await;
}

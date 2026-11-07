async fn assert_unconfirmed_startup_cleanup_releases_requester(hanging_probe: bool) {
    let _env = ENV_LOCK.lock().await;
    let (mut state, id, sink) = crashed_publication_fixture().await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests");
    let release_native = temporary.path().join("resume-release");
    configure_fake_codex_cmd(
        &json!({"appendRequestLogPath":requests,
        "waitForThreadResumeReleasePath":release_native})
        .to_string(),
    );
    let (probe_entered, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let (allow_confirmation, allowed) = tokio::sync::watch::channel(false);
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    state.set_sidecar_cleanup_probe(Arc::new(move |recorded| {
        let entered = probe_entered.clone();
        let mut allowed = allowed.clone();
        let first = attempts.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            let _ = entered.send(recorded.clone());
            if hanging_probe && first {
                while !*allowed.borrow() {
                    if allowed.changed().await.is_err() {
                        return Ok(false);
                    }
                }
            }
            if !*allowed.borrow() {
                return Ok(false);
            }
            Ok(crate::session_lease::kill_and_confirm_recorded_tree_dead(
                &recorded,
                CODEX_SIDECAR_OWNERSHIP_ENV,
            )
            .await)
        })
    }));
    let (reply_tx, mut replies) = tokio::sync::mpsc::unbounded_channel();
    let mut attach = attach_msg(&id);
    attach.request_id = Some("unconfirmed-cleanup-request".into());
    attach.view_id = Some("unconfirmed-cleanup-view".into());
    let recovering = state.clone();
    let mut requester = tokio::spawn(async move {
        recovering
            .handle_attach(
                attach,
                Arc::new(move |frame| {
                    let _ = reply_tx.send(frame);
                }),
            )
            .await
    });
    wait_for_publication_resume(&requests).await;
    crate::PaneIdentitySink::retire_closed(sink.as_ref(), PROVIDER, &id)
        .await
        .unwrap();
    std::fs::write(release_native, "release").unwrap();
    let recorded = tokio::time::timeout(Duration::from_secs(5), observed.recv())
        .await
        .unwrap()
        .unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(5), &mut requester).await;
    let requester_finished = settled.is_ok();
    let status = state
        .session_recovery
        .status(&state.recovery_map_key(&id))
        .await
        .unwrap();
    let permit = state.resuming.lock().await[&id].clone();
    let permit_released = permit.try_lock().is_ok();
    let lease_held = matches!(
        state.leases.claim(
            PROVIDER,
            &id,
            "while-unconfirmed",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Held { .. }
    );
    let ownership_held = matches!(
        registry.begin_start(
            PROVIDER,
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "while-unconfirmed",
            None,
            "test",
            0
        ),
        freshell_ownership::BeginOutcome::Blocked { .. }
    );
    let evidence_retained = state
        .condemned_priors
        .lock()
        .unwrap()
        .get(&id)
        .is_some_and(|prior| prior.ownership_id == recorded.ownership_id);
    let reply = replies
        .try_recv()
        .ok()
        .map(|frame| serde_json::to_value(frame).unwrap());

    // Settle this fixture even on RED: an unconfirmable probe must not strand
    // a sandbox test's runtime or leave its exact child behind.
    allow_confirmation.send(true).unwrap();
    if !requester_finished {
        tokio::time::timeout(Duration::from_secs(10), requester)
            .await
            .unwrap()
            .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !state.condemned_priors.lock().unwrap().contains_key(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("detached cleanup eventually confirms and clears the exact prior");
    assert!(crate::ownership_lane::partial_pid_confirmed_dead(
        recorded.pid
    ));
    state.shutdown().await;

    assert!(
        requester_finished,
        "unconfirmed cleanup must answer the requester within a bounded attempt"
    );
    assert!(
        !status.in_flight,
        "shared recovery is settled while fenced cleanup continues"
    );
    assert_eq!(status.failed_launches, 0);
    assert!(
        permit_released,
        "the real per-thread recovery permit is released before cleanup proof"
    );
    assert!(
        lease_held && ownership_held && evidence_retained,
        "requester liveness must not release the writer lease, coordinator claim, or evidence"
    );
    let reply =
        reply.expect("the requester receives its correlated typed failure before confirmation");
    assert_eq!(reply["type"], "freshAgent.attach.failed");
    assert_eq!(reply["requestId"], "unconfirmed-cleanup-request");
    assert_eq!(reply["viewId"], "unconfirmed-cleanup-view");
    // The existing generic ErrorCode envelope maps the legacy Codex attach
    // failure to INTERNAL_ERROR; keep that public contract while asserting
    // the typed attach result, correlated request, and supersession message.
    assert_eq!(reply["code"], "INTERNAL_ERROR");
    assert_eq!(reply["status"], "failed");
    assert_eq!(reply["sessionId"], id);
    assert!(reply["message"]
        .as_str()
        .unwrap()
        .contains("ownership or close changed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unconfirmable_cleanup_replies_and_releases_recovery_while_retaining_the_writer_fence() {
    assert_unconfirmed_startup_cleanup_releases_requester(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_cleanup_probe_cannot_hold_the_requester_or_recovery_permit_forever() {
    assert_unconfirmed_startup_cleanup_releases_requester(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readiness_retained_stamp_mismatch_is_superseded_before_any_native_launch() {
    let _env = ENV_LOCK.lock().await;
    for missing in [true, false] {
        configure_fake_codex_cmd(r#"{"threadStartThreadId":"stamp-readiness"}"#);
        let (mut state, mut rx, _) = state_with_sink();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        state.set_ownership(registry.clone());
        let id = create_real_fake_session(&state, &mut rx).await;
        let owner = registry.observe(PROVIDER, &id);
        let mut stamp = state.ownership_stamps.lock().unwrap().remove(&id).unwrap();
        if !missing {
            stamp.owner.ownership_id = Some("a-different-native-incarnation".into());
            state
                .ownership_stamps
                .lock()
                .unwrap()
                .insert(id.clone(), stamp);
        }
        let result = state.prepare_native_readiness(&id).await;
        assert!(state
            .session_recovery
            .status(&state.recovery_map_key(&id))
            .await
            .is_none());
        assert_eq!(registry.observe(PROVIDER, &id), owner);
        assert!(state.has_live_session(&id).await);
        state.shutdown().await;
        assert_eq!(result.unwrap_err(), CodexNativeReadinessError::Superseded);
    }
}

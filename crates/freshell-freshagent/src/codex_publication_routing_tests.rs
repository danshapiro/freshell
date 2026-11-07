struct StagedCodexPublication {
    state: FreshCodexState,
    original: String,
    target: &'static str,
    sink: Arc<crate::identity_sink::FakeIdentitySink>,
    registry: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    release: oneshot::Sender<()>,
    recovery: tokio::task::JoinHandle<Result<EnsureAliveOutcome, EnsureAliveError>>,
    replies: tokio::sync::broadcast::Receiver<String>,
    target_pid: u32,
    _temporary: tempfile::TempDir,
}

async fn stage_codex_publication(target: &'static str) -> StagedCodexPublication {
    stage_codex_publication_with_probe(target, None).await
}

async fn stage_codex_publication_with_probe(
    target: &'static str,
    probe: Option<CodexSidecarCleanupProbe>,
) -> StagedCodexPublication {
    let (mut state, original, sink) = crashed_publication_fixture().await;
    if let Some(probe) = probe {
        state.set_sidecar_cleanup_probe(probe);
    }
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    state.mark_thread_dead(&original).await;
    let temporary = tempfile::tempdir().unwrap();
    let pid_path = temporary.path().join("replacement.pid");
    configure_fake_codex_cmd(
        &json!({
            "threadStartThreadId": target,
            "sidecarPidFile": pid_path,
        })
        .to_string(),
    );
    let stage = sink.arm_binding_stall(PROVIDER, target);
    let replies = state.broadcast_tx.subscribe();
    let recovering = state.clone();
    let recovering_id = original.clone();
    let recovery = tokio::spawn(async move {
        recovering
            .ensure_session_alive_once(&recovering_id, None, DeadThreadCachePolicy::Respect)
            .await
    });
    let stage = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::task::spawn_blocking(move || {
            stage.entered.recv_timeout(Duration::from_secs(15)).expect(
                "the replacement binding must be persisted before its stage response pauses",
            );
            stage
        }),
    )
    .await
    .expect("the stage observation is bounded")
    .unwrap();
    let target_pid: u32 = std::fs::read_to_string(pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        state.sessions.lock().await[target].sidecar_pid,
        Some(target_pid)
    );
    assert!(!crate::ownership_lane::partial_pid_confirmed_dead(
        target_pid
    ));
    assert!(matches!(
        registry.observe(PROVIDER, target).state,
        freshell_ownership::OwnershipState::Starting { .. }
    ));
    assert_eq!(
        crate::PaneIdentitySink::chain_terminus(sink.as_ref(), PROVIDER, &original),
        None
    );
    StagedCodexPublication {
        state,
        original,
        target,
        sink,
        registry,
        release: stage.release,
        recovery,
        replies,
        target_pid,
        _temporary: temporary,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_replacement_publication_emits_ledger_alarm_after_materialization() {
    let _environment = ENV_LOCK.lock().await;
    let mut fixture = stage_codex_publication("publication-routed-target").await;
    let source_state = fixture
        .sink
        .states
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), fixture.original.clone()))
        .copied();
    let source_retires = fixture.sink.retires.lock().unwrap().clone();

    // The stage already applied successfully. Fail the NEXT write before it
    // applies, unlike arm_binding_stall_result(..., true), which fails after
    // its retire/link mutations have landed.
    fixture.sink.set_fail_writes(true);
    fixture.release.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(20), fixture.recovery)
        .await
        .expect("a final metadata failure cannot strand recovery")
        .unwrap();
    let live_target = fixture.state.has_live_session(fixture.target).await;
    let writer_live = !crate::ownership_lane::partial_pid_confirmed_dead(fixture.target_pid);
    let target_owner = fixture.registry.observe(PROVIDER, fixture.target);
    let source_chain =
        crate::PaneIdentitySink::chain_terminus(fixture.sink.as_ref(), PROVIDER, &fixture.original);
    let source_state_after = fixture
        .sink
        .states
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), fixture.original.clone()))
        .copied();
    let source_retires_after = fixture.sink.retires.lock().unwrap().clone();
    let source_link_written = fixture
        .sink
        .bindings
        .lock()
        .unwrap()
        .iter()
        .any(|binding| binding.supersedes.as_deref() == Some(fixture.original.as_str()));
    let mut raw = Vec::new();
    while let Ok(wire) = fixture.replies.try_recv() {
        let frame: Value = serde_json::from_str(&wire).unwrap();
        raw.push(frame);
    }
    fixture.sink.set_fail_writes(false);
    tokio::time::timeout(Duration::from_secs(15), fixture.state.shutdown())
        .await
        .expect("the retained replacement is cleaned up after observations");

    assert!(
        matches!(result, Ok(EnsureAliveOutcome::Respawned { new_session_id })
        if new_session_id == fixture.target)
    );
    assert!(
        live_target && writer_live,
        "final publication failure retains the real live replacement"
    );
    assert!(matches!(target_owner.state,
        freshell_ownership::OwnershipState::Live { owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
                && owner.live_session_key.as_deref() == Some(fixture.target)
                && owner.pid == Some(fixture.target_pid)));
    assert_eq!(
        source_chain, None,
        "the failed write must not have published an old-to-new chain"
    );
    assert!(!source_link_written);
    assert_eq!(
        source_state_after, source_state,
        "the failed write must not retire the source"
    );
    assert_eq!(source_retires_after, source_retires);
    let is_alarm = |frame: &&Value| {
        frame["sessionId"] == fixture.target && frame["event"]["code"] == "LEDGER_WRITE_FAILED"
    };
    assert_eq!(
        raw.iter().filter(is_alarm).count(),
        1,
        "the real producer emits one publication alarm"
    );
    let materialized = raw
        .iter()
        .position(|frame| {
            frame["type"] == "freshAgent.session.materialized"
                && frame["previousSessionId"] == fixture.original
                && frame["sessionId"] == fixture.target
        })
        .expect("the producer materializes the replacement");
    let alarm = raw
        .iter()
        .position(|frame| frame["event"]["code"] == "LEDGER_WRITE_FAILED")
        .unwrap();
    assert!(
        materialized < alarm,
        "the producer must materialize the replacement before emitting its alarm"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replacement_publication_keeps_settings_updated_after_staging() {
    let _environment = ENV_LOCK.lock().await;
    let fixture = stage_codex_publication("publication-concurrent-settings-target").await;
    let staged_settings =
        crate::PaneIdentitySink::load_settings(fixture.sink.as_ref(), PROVIDER, fixture.target)
            .expect("staging records native settings");
    let latest = crate::identity_sink::FreshAgentSettings {
        model: Some("concurrent-settings-model".into()),
        effort: Some("high".into()),
        permission_mode: Some("never".into()),
        cwd: Some("/concurrent/settings/workspace".into()),
        ..crate::identity_sink::FreshAgentSettings::default()
    };
    assert_ne!(staged_settings, latest);
    let mut update = fixture
        .sink
        .bindings
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|binding| binding.session_id == fixture.target)
        .unwrap()
        .clone();
    assert!(
        update.supersedes.is_none(),
        "the staged target has not linked its source"
    );
    update.settings = crate::identity_sink::SettingsUpdate::Replace(latest.clone());
    crate::PaneIdentitySink::record_binding(fixture.sink.as_ref(), update)
        .await
        .unwrap();
    assert_eq!(
        crate::PaneIdentitySink::load_settings(fixture.sink.as_ref(), PROVIDER, fixture.target),
        Some(latest.clone()),
        "the concurrent target settings update has landed before stage release"
    );
    assert_eq!(
        crate::PaneIdentitySink::chain_terminus(fixture.sink.as_ref(), PROVIDER, &fixture.original),
        None
    );

    fixture.release.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(20), fixture.recovery)
        .await
        .expect("source publication settles after staging")
        .unwrap();
    let published_settings =
        crate::PaneIdentitySink::load_settings(fixture.sink.as_ref(), PROVIDER, fixture.target);
    let source_chain =
        crate::PaneIdentitySink::chain_terminus(fixture.sink.as_ref(), PROVIDER, &fixture.original);
    let live_target = fixture.state.has_live_session(fixture.target).await;
    let writer_live = !crate::ownership_lane::partial_pid_confirmed_dead(fixture.target_pid);
    let target_owner = fixture.registry.observe(PROVIDER, fixture.target);
    tokio::time::timeout(Duration::from_secs(15), fixture.state.shutdown())
        .await
        .expect("the replacement is cleaned up after publication observations");

    assert!(
        matches!(result, Ok(EnsureAliveOutcome::Respawned { new_session_id })
        if new_session_id == fixture.target)
    );
    assert_eq!(
        source_chain.as_deref(),
        Some(fixture.target),
        "the successful final write links the original"
    );
    assert!(live_target && writer_live);
    assert!(matches!(
        target_owner.state,
        freshell_ownership::OwnershipState::Live { .. }
    ));
    assert_eq!(
        published_settings,
        Some(latest),
        "source-link publication must preserve settings saved after the target was staged"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canceled_publication_waiter_still_materializes_and_reports_both_recovery_failures() {
    let _environment = ENV_LOCK.lock().await;
    let mut fixture = stage_codex_publication("canceled-publication-diagnostics").await;
    let publication = fixture
        .sink
        .arm_binding_stall_result(PROVIDER, fixture.target, true);
    fixture.release.send(()).unwrap();
    publication
        .entered
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    fixture.recovery.abort();
    assert!(fixture.recovery.await.unwrap_err().is_cancelled());
    publication.release.send(()).unwrap();
    let mut frames = Vec::new();
    let delivered = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame: Value =
                serde_json::from_str(&fixture.replies.recv().await.unwrap()).unwrap();
            let done = frame["event"]["code"] == "THREAD_MEMORY_LOST";
            frames.push(frame);
            if done {
                break;
            }
        }
    })
    .await
    .is_ok();
    let target_live = fixture.state.has_live_session(fixture.target).await;
    tokio::time::timeout(Duration::from_secs(15), fixture.state.shutdown())
        .await
        .unwrap();
    assert!(target_live, "an I/O error retains the valid replacement");
    assert!(delivered, "owned publication must emit materialization and both diagnostics after its waiter is canceled: {frames:?}");
    let materialized = frames
        .iter()
        .position(|f| f["type"] == "freshAgent.session.materialized")
        .unwrap();
    let ledger = frames
        .iter()
        .position(|f| f["event"]["code"] == "LEDGER_WRITE_FAILED")
        .unwrap();
    let memory = frames
        .iter()
        .position(|f| f["event"]["code"] == "THREAD_MEMORY_LOST")
        .unwrap();
    assert!(materialized < ledger && ledger < memory);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_source_during_final_publication_stops_the_exact_replacement_and_refuses_recovery() {
    let _environment = ENV_LOCK.lock().await;
    let mut fixture = stage_codex_publication("closed-source-publication-target").await;
    let publication = fixture
        .sink
        .arm_binding_before_write_stall(PROVIDER, fixture.target);
    fixture.release.send(()).unwrap();
    publication
        .entered
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    crate::PaneIdentitySink::retire_closed(fixture.sink.as_ref(), PROVIDER, &fixture.original)
        .await
        .unwrap();
    publication.release.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), fixture.recovery)
        .await
        .unwrap()
        .unwrap();
    let target_live = fixture.state.has_live_session(fixture.target).await;
    let target_state = fixture
        .sink
        .states
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), fixture.target.into()))
        .copied();
    let source_state = fixture
        .sink
        .states
        .lock()
        .unwrap()
        .get(&(PROVIDER.into(), fixture.original.clone()))
        .copied();
    let source_chain =
        crate::PaneIdentitySink::chain_terminus(fixture.sink.as_ref(), PROVIDER, &fixture.original);
    let target_owner = fixture.registry.observe(PROVIDER, fixture.target);
    let target_dead = crate::ownership_lane::partial_pid_confirmed_dead(fixture.target_pid);
    let mut frames = Vec::new();
    while let Ok(wire) = fixture.replies.try_recv() {
        frames.push(serde_json::from_str::<Value>(&wire).unwrap());
    }
    fixture.state.shutdown().await;
    assert!(
        matches!(result, Err(EnsureAliveError::Superseded(_))),
        "close must be a typed recovery refusal: {result:?}"
    );
    assert!(
        !target_live && target_dead,
        "a closed source must not leave its replacement running"
    );
    assert_eq!(
        target_state,
        Some(crate::identity_sink::FakeRowState::FailedTransition)
    );
    assert_eq!(
        source_state,
        Some(crate::identity_sink::FakeRowState::Closed)
    );
    assert_eq!(source_chain, None);
    assert!(!matches!(
        target_owner.state,
        freshell_ownership::OwnershipState::Live { .. }
    ));
    assert!(
        !frames
            .iter()
            .any(|f| f["type"] == "freshAgent.session.materialized"),
        "closed recovery never materializes a usable replacement: {frames:?}"
    );
    assert!(!frames
        .iter()
        .any(|f| f["event"]["code"] == "LEDGER_WRITE_FAILED"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_replacement_cleanup_replies_before_unconfirmable_teardown_and_keeps_its_lease()
{
    let _environment = ENV_LOCK.lock().await;
    let (allow, allowed) = tokio::sync::watch::channel(false);
    let probe: CodexSidecarCleanupProbe = Arc::new(move |recorded| {
        let allowed = allowed.clone();
        Box::pin(async move {
            if !*allowed.borrow() {
                return Ok(false);
            }
            Ok(crate::session_lease::kill_and_confirm_recorded_tree_dead(
                &recorded,
                CODEX_SIDECAR_OWNERSHIP_ENV,
            )
            .await)
        })
    });
    let mut fixture =
        stage_codex_publication_with_probe("registered-unconfirmed-cleanup", Some(probe)).await;
    crate::PaneIdentitySink::retire_closed(fixture.sink.as_ref(), PROVIDER, &fixture.original)
        .await
        .unwrap();
    fixture.release.send(()).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(5), &mut fixture.recovery).await;
    let replied = response.is_ok();
    let refused = response
        .ok()
        .is_some_and(|r| matches!(r.unwrap(), Err(EnsureAliveError::Superseded(_))));
    let lease_held = matches!(
        fixture.state.leases.claim(
            PROVIDER,
            &fixture.original,
            "while-cleaning",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Held { .. }
    );
    let owner_held = matches!(
        fixture.registry.observe(PROVIDER, fixture.target).state,
        freshell_ownership::OwnershipState::Starting { .. }
    );
    allow.send(true).unwrap();
    if !replied {
        tokio::time::timeout(Duration::from_secs(10), fixture.recovery)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while matches!(
            fixture.registry.observe(PROVIDER, fixture.target).state,
            freshell_ownership::OwnershipState::Starting { .. }
        ) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.state.shutdown().await;
    assert!(replied && refused, "the first requester must receive typed supersession while registered writer cleanup is still unconfirmed");
    assert!(
        lease_held && owner_held,
        "bounded replies must retain the exact startup lease and coordinator claim"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_waiting_on_closed_source_publication_is_refused_without_native_dispatch() {
    let _environment = ENV_LOCK.lock().await;
    let (mut state, original, sink) = crashed_publication_fixture().await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry);
    state.mark_thread_dead(&original).await;
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests.jsonl");
    let target = "closed-publication-send-target";
    configure_fake_codex_cmd(
        &json!({"threadStartThreadId":target,"appendRequestLogPath":requests}).to_string(),
    );
    let publication = sink.arm_binding_before_write_stall(PROVIDER, target);
    let mut replies = state.broadcast_tx.subscribe();
    let sending = state.clone();
    let id = original.clone();
    let task = tokio::spawn(async move {
        let mut message = send_msg(&id, "must never reach native turn/start");
        message.request_id = Some("closed-publication-send".into());
        sending.handle_send(message).await
    });
    publication
        .entered
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    crate::PaneIdentitySink::retire_closed(sink.as_ref(), PROVIDER, &original)
        .await
        .unwrap();
    publication.release.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    let status = state
        .session_recovery
        .status(&state.recovery_map_key(&original))
        .await
        .unwrap();
    let mut frames = Vec::new();
    while let Ok(wire) = replies.try_recv() {
        frames.push(serde_json::from_str::<Value>(&wire).unwrap());
    }
    let native: Vec<Value> = std::fs::read_to_string(requests)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    state.shutdown().await;
    assert!(
        matches!(result, CodexSendOutcome::Refused { code, message, .. }
        if code == "CODEX_RESPAWN_FAILED" && message.contains("closed during recovery"))
    );
    assert!(!status.in_flight);
    assert_eq!(
        status.failed_launches, 0,
        "explicit close is supersession, not a failed native launch"
    );
    assert!(
        !native.iter().any(|r| r["method"] == "turn/start"),
        "refused pending input must never dispatch: {native:?}"
    );
    assert!(!frames
        .iter()
        .any(|f| f["type"] == "freshAgent.session.materialized"));
    assert!(
        frames.iter().any(|f| f["type"] == "error"
            && f["code"] == "INTERNAL_ERROR"
            && f["message"]
                .as_str()
                .is_some_and(|message| message.starts_with("CODEX_RESPAWN_FAILED:"))
            && f["requestId"] == "closed-publication-send"),
        "the waiting sender receives its correlated refusal: {frames:?}"
    );
}

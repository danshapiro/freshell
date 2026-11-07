// Execute the websocket's production routing implementation without adding a
// circular freshagent -> ws dependency or reproducing its routing rules here.
#[path = "../../freshell-ws/src/fresh_agent_view_routes.rs"]
mod codex_publication_view_routes;

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
    let (mut state, original, sink) = crashed_publication_fixture().await;
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
async fn failed_replacement_publication_routes_ledger_alarm_after_materialization() {
    let _environment = ENV_LOCK.lock().await;
    let mut fixture = stage_codex_publication("publication-routed-target").await;
    let mut routes = codex_publication_view_routes::FreshAgentViewRoutes::default();
    routes.negotiate_fresh_agent_reconciliation_v1();
    assert!(routes.fresh_agent_reconciliation_v1());
    routes.observe_client_value(&json!({
        "type": "freshAgent.attach", "provider": PROVIDER, "sessionType": SESSION_TYPE,
        "sessionId": fixture.original, "viewId": "publication-requester-view",
    }));
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
    let mut delivered = Vec::new();
    while let Ok(wire) = fixture.replies.try_recv() {
        let frame: Value = serde_json::from_str(&wire).unwrap();
        if routes.should_deliver(&wire) {
            delivered.push(frame.clone());
        }
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
    assert_eq!(
        delivered.iter().filter(is_alarm).count(),
        1,
        "the attached view must receive the alarm through actual websocket routing: {raw:?}"
    );
    let materialized = delivered
        .iter()
        .position(|frame| {
            frame["type"] == "freshAgent.session.materialized"
                && frame["previousSessionId"] == fixture.original
                && frame["sessionId"] == fixture.target
        })
        .expect("the attached view follows the replacement");
    let alarm = delivered
        .iter()
        .position(|frame| frame["event"]["code"] == "LEDGER_WRITE_FAILED")
        .unwrap();
    assert!(
        materialized < alarm,
        "the view must adopt the replacement before its alarm is delivered"
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

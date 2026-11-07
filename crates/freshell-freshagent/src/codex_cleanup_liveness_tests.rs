async fn assert_unconfirmed_startup_cleanup_releases_requester(
    hanging_probe: bool,
    native_not_found: bool,
) {
    let _env = ENV_LOCK.lock().await;
    let (mut state, id, sink) = crashed_publication_fixture().await;
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let temporary = tempfile::tempdir().unwrap();
    let requests = temporary.path().join("requests");
    let release_native = temporary.path().join("resume-release");
    let mut behavior = json!({"appendRequestLogPath":requests,
        "waitForThreadResumeReleasePath":release_native});
    if native_not_found {
        behavior["overrides"] = json!({"thread/resume":{"error":{
            "code":-32600,"message":format!("no rollout found for thread id {id}")}}});
    }
    configure_fake_codex_cmd(&behavior.to_string());
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
    if !native_not_found {
        crate::PaneIdentitySink::retire_closed(sink.as_ref(), PROVIDER, &id)
            .await
            .unwrap();
    }
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
    let reusable = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if matches!(
                state.leases.claim(
                    PROVIDER,
                    &id,
                    "after-proof",
                    crate::session_lease::now_epoch_ms()
                ),
                crate::session_lease::FreshSessionClaim::Acquired
            ) {
                state.leases.fail(PROVIDER, &id, "after-proof");
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    state.shutdown().await;

    assert!(
        reusable,
        "confirmed deferred cleanup must release its lease promptly, without TTL recovery"
    );

    assert!(
        requester_finished,
        "unconfirmed cleanup must answer the requester within a bounded attempt"
    );
    assert!(
        !status.in_flight,
        "shared recovery is settled while fenced cleanup continues"
    );
    assert_eq!(status.failed_launches, u32::from(native_not_found));
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
        .contains(if native_not_found {
            "not yet confirmed"
        } else {
            "ownership or close changed"
        }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unconfirmable_cleanup_replies_and_releases_recovery_while_retaining_the_writer_fence() {
    assert_unconfirmed_startup_cleanup_releases_requester(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_cleanup_probe_cannot_hold_the_requester_or_recovery_permit_forever() {
    assert_unconfirmed_startup_cleanup_releases_requester(true, false).await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unconfirmed_duplicate_startup_refuses_without_adopting_the_wired_healthy_incumbent() {
    let _env = ENV_LOCK.lock().await;
    configure_fake_codex_cmd(r#"{"threadStartThreadId":"healthy-incumbent-cleanup"}"#);
    let (mut state, mut replies, sink) = state_with_sink();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let id = create_real_fake_session(&state, &mut replies).await;
    let owner = registry.observe(PROVIDER, &id);
    let bindings = sink.bindings.lock().unwrap().clone();
    let incumbent = state.sessions.lock().await[&id]
        .sidecar_ownership_id
        .clone();
    let (allow, allowed) = tokio::sync::watch::channel(false);
    state.set_sidecar_cleanup_probe(Arc::new(move |recorded| {
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
    }));
    let (client, notifs, runtime, child) = state.spawn_sidecar(None).await.unwrap();
    let duplicate_pid = child.id().unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        state.finish_create(
            "duplicate-unconfirmed".into(),
            Some("duplicate-view".into()),
            id.clone(),
            client,
            notifs,
            runtime.clone(),
            child,
            "must-not-adopt".into(),
            None,
            None,
            None,
            None,
            None,
            json!({}),
            None,
            None,
            None,
            Some(crate::BindProvenance::for_create(
                Some("wrong-client"),
                Some("wrong-device"),
                Some("wrong-tab"),
                1,
            )),
            None,
            None,
        ),
    )
    .await
    .expect("the duplicate teardown cannot hold its requester");
    let refused =
        matches!(&result, CodexCreateOutcome::Failed { code, .. } if code == "SESSION_RESERVED");
    let unchanged_owner = registry.observe(PROVIDER, &id) == owner;
    let unchanged_runtime = state.sessions.lock().await[&id].sidecar_ownership_id == incumbent;
    let unchanged_bindings = *sink.bindings.lock().unwrap() == bindings;
    allow.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !state
                .condemned_priors
                .lock()
                .unwrap()
                .values()
                .any(|p| p.ownership_id == runtime)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(crate::ownership_lane::partial_pid_confirmed_dead(
        duplicate_pid
    ));
    state.shutdown().await;
    assert!(
        refused,
        "unconfirmed duplicate startup must return SESSION_RESERVED: {result:?}"
    );
    assert!(
        unchanged_owner && unchanged_runtime && unchanged_bindings,
        "the healthy incumbent must not be adopted, overwritten, or restamped"
    );
}

#[tokio::test]
async fn incomplete_unregistered_identity_stops_retrying_without_releasing_its_fence() {
    let (mut state, _, _) = state_with_sink();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let id = "sticky-incomplete-cleanup";
    let ticket = match state.begin_lane_claim_at(id, "sticky-cleanup", None, "test") {
        crate::ownership_lane::LaneClaim::Granted(ticket) => ticket,
        _ => panic!("fixture claim"),
    };
    let (transport, _peer) = freshell_codex::new_channel_transport();
    let (client, _notifications) = CodexAppServerClient::connect(transport);
    let mut child: CodexChild = spawn_sleeper().into();
    child.start_kill().unwrap();
    child.wait().await.unwrap();
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = attempts.clone();
    state.set_sidecar_cleanup_probe(Arc::new(move |_recorded| {
        observed.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(false) })
    }));
    tokio::time::pause();
    let confirmed = state
        .settle_unregistered_startup(
            id,
            (Arc::new(client), "incomplete-runtime".into(), child),
            None,
            Some(ticket),
        )
        .await;
    for _ in 0..20 {
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
    }
    assert!(!confirmed);
    assert!(attempts.load(Ordering::SeqCst) <= 1,
        "a missing immutable root identity cannot improve through repeated helper processes: {} attempts", attempts.load(Ordering::SeqCst));
    assert!(matches!(
        registry.begin_start(
            PROVIDER,
            id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "competitor",
            None,
            "test",
            0
        ),
        freshell_ownership::BeginOutcome::Blocked { .. }
    ));
    assert!(state.condemned_priors.lock().unwrap().contains_key(id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unregistered_cleanup_reaps_the_direct_child_before_its_first_hosted_proof() {
    let (state, _, _) = state_with_sink();
    let alive_at_probe = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = alive_at_probe.clone();
    state.set_sidecar_cleanup_probe(Arc::new(move |recorded| {
        if !crate::ownership_lane::partial_pid_confirmed_dead(recorded.pid) {
            observed.fetch_add(1, Ordering::SeqCst);
        }
        Box::pin(async move {
            Ok(crate::session_lease::kill_and_confirm_recorded_tree_dead(
                &recorded,
                CODEX_SIDECAR_OWNERSHIP_ENV,
            )
            .await)
        })
    }));
    for n in 0..12 {
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifications) = CodexAppServerClient::connect(transport);
        let runtime = mint_ownership_id();
        let mut command = tokio::process::Command::new("sleep");
        command
            .arg("30")
            .env(CODEX_SIDECAR_OWNERSHIP_ENV, &runtime)
            .kill_on_drop(true);
        let child = command.spawn().unwrap();
        #[cfg(target_os = "linux")]
        tokio::time::timeout(Duration::from_secs(2), async {
            let process_name = format!("/proc/{}/comm", child.id().unwrap());
            while std::fs::read_to_string(&process_name).ok().as_deref() != Some("sleep\n") {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the fixture has completed exec before its identity is captured");
        assert!(
            state
                .settle_unregistered_startup(
                    &runtime,
                    (Arc::new(client), runtime.clone(), child.into()),
                    None,
                    None
                )
                .await,
            "attempt {n}: {:?}",
            state.condemned_priors.lock().unwrap()
        );
    }
    assert_eq!(alive_at_probe.load(Ordering::SeqCst), 0,
        "the first hosted proof must follow bounded direct-child exit/reap, not race SIGKILL delivery");
}

#[tokio::test]
async fn canceled_source_publication_claim_releases_its_ticket_before_the_watchdog_can_recover_it()
{
    let (mut state, _, _) = state_with_sink();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    for polled in [false, true] {
        let id = if polled {
            "polled-publication-claim"
        } else {
            "unpolled-publication-claim"
        };
        let ticket = match state.begin_lane_claim_at(id, "publish-source", None, "test") {
            crate::ownership_lane::LaneClaim::Granted(ticket) => ticket,
            _ => panic!("fixture claim"),
        };
        let claim = CodexPublicationSourceClaim::new(ticket);
        assert!(
            registry.recover_stale_starts(u64::MAX, 0).is_empty(),
            "the binding hold protects the captured source claim"
        );
        let (entered, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _claim = claim;
            let _ = entered.send(());
            std::future::pending::<()>().await;
        });
        if polled {
            ready.await.unwrap();
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(matches!(
            registry.observe(PROVIDER, id).state,
            freshell_ownership::OwnershipState::Vacant
        ));
        assert!(registry.recover_stale_starts(u64::MAX, 0).is_empty(),
            "cancellation drops the exact ticket while its hold still fences watchdog recovery; no stale start remains");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn not_found_resume_cleanup_answers_its_first_requester_while_the_hosted_proof_is_stalled() {
    assert_unconfirmed_startup_cleanup_releases_requester(true, true).await;
}

#[tokio::test]
async fn canceled_source_publication_claim_observably_drops_ticket_before_watchdog_hold() {
    struct ObservedDrop(&'static str, Arc<StdMutex<Vec<&'static str>>>);
    impl Drop for ObservedDrop {
        fn drop(&mut self) {
            self.1.lock().unwrap().push(self.0);
        }
    }
    for polled in [false, true] {
        let drops = Arc::new(StdMutex::new(Vec::new()));
        // The same production Drop implementation owns observable resources.
        let claim = CodexPublicationSourceClaim {
            ticket: Some(ObservedDrop("ticket", drops.clone())),
            hold: Some(ObservedDrop("watchdog hold", drops.clone())),
        };
        let (entered, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _claim = claim;
            let _ = entered.send(());
            std::future::pending::<()>().await;
        });
        if polled {
            ready.await.unwrap();
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(*drops.lock().unwrap(), ["ticket", "watchdog hold"]);
    }
}

#[tokio::test(start_paused = true)]
async fn complete_identity_cleanup_recovers_after_rapid_retry_budget_with_one_active_probe() {
    let attempts = Arc::new(StdMutex::new(Vec::new()));
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = attempts.clone();
    let running = active.clone();
    let probe: CodexSidecarCleanupProbe = Arc::new(move |_| {
        let seen = seen.clone();
        let running = running.clone();
        Box::pin(async move {
            assert_eq!(
                running.fetch_add(1, Ordering::SeqCst),
                0,
                "only one owned proof may run at once"
            );
            let confirmed = {
                let mut attempts = seen.lock().unwrap();
                attempts.push(tokio::time::Instant::now());
                attempts.len() == 10
            };
            tokio::task::yield_now().await;
            assert_eq!(running.fetch_sub(1, Ordering::SeqCst), 1);
            Ok(confirmed)
        })
    });
    let recorded = crate::session_lease::CondemnedRuntimeIdentity {
        pid: 123,
        start_time: Some(456),
        tree: vec![(123, 456)],
        root_parent: None,
        ownership_id: "bounded-proof-fixture".into(),
        capture_complete: true,
    };
    let result = tokio::time::timeout(
        Duration::from_secs(1200),
        codex_tree_death_escalation(recorded, "bounded-proof-session".into(), Some(probe)),
    )
    .await;
    assert_eq!(
        result,
        Ok(true),
        "a temporary failure beyond the rapid budget must still settle the exact cleanup owner"
    );
    let times = attempts.lock().unwrap().clone();
    assert_eq!(times.len(), 10);
    for pair in times.windows(2) {
        assert!(pair[1].duration_since(pair[0]) >= Duration::from_millis(250));
    }
    for pair in times.windows(3) {
        assert!(pair[2].duration_since(pair[1]) >= pair[1].duration_since(pair[0]));
    }
    assert!(
        times[8].duration_since(times[7]) >= Duration::from_secs(60),
        "exhaustion moves to slow background confirmation, without a helper every thirty seconds"
    );
    tokio::time::advance(Duration::from_secs(3600)).await;
    assert_eq!(attempts.lock().unwrap().len(), 10);
    assert_eq!(active.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn job_object_cleanup_proves_a_windows_shaped_identity_without_proc_capture() {
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = attempts.clone();
    let probe: CodexSidecarCleanupProbe = Arc::new(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(true) })
    });
    let recorded = crate::session_lease::CondemnedRuntimeIdentity {
        pid: 123,
        start_time: None,
        tree: vec![],
        root_parent: None,
        ownership_id: "job-object-identity".into(),
        capture_complete: false,
    };
    assert!(
        confirm_codex_tree_with_retries(
            recorded,
            "job-session".into(),
            CodexTreeDeathProof::WindowsJob(probe),
            None,
            None
        )
        .await,
        "the exact job handle supplies the tree proof; Linux capture fields do not apply"
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn local_cleanup_accepts_a_complete_capture_after_the_root_exited() {
    let runtime = mint_ownership_id();
    let mut child = tokio::process::Command::new("true")
        .env(CODEX_SIDECAR_OWNERSHIP_ENV, &runtime)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    child.wait().await.unwrap();
    let recorded = crate::session_lease::record_condemned_runtime_identity(
        pid,
        CODEX_SIDECAR_OWNERSHIP_ENV,
        &runtime,
    );
    assert!(recorded.capture_complete);
    assert_eq!(recorded.start_time, None);
    assert!(
        confirm_codex_tree_with_retries(
            recorded,
            "already-exited".into(),
            CodexTreeDeathProof::Local,
            None,
            None
        )
        .await,
        "complete local evidence can prove a tree gone without signaling its reused root PID"
    );
}

#[tokio::test]
async fn hosted_cleanup_rejects_missing_root_or_incomplete_capture_without_launching_a_helper() {
    for (start_time, capture_complete) in [(None, true), (Some(123), false)] {
        let probe: CodexSidecarCleanupProbe = Arc::new(|_| panic!("unsafe hosted probe"));
        let recorded = crate::session_lease::CondemnedRuntimeIdentity {
            pid: 123,
            start_time,
            tree: vec![],
            root_parent: None,
            ownership_id: "hosted-incomplete".into(),
            capture_complete,
        };
        assert!(
            !confirm_codex_tree_with_retries(
                recorded,
                "hosted".into(),
                CodexTreeDeathProof::Hosted(probe),
                None,
                None
            )
            .await
        );
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn deferred_cleanup_after_the_rapid_budget_releases_its_real_lease_and_ticket() {
    let (mut state, _, _) = state_with_sink();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.set_ownership(registry.clone());
    let id = "deferred-after-rapid-budget";
    let ticket = match state.begin_lane_claim_at(id, "deferred-startup", None, "test") {
        crate::ownership_lane::LaneClaim::Granted(ticket) => ticket,
        _ => panic!("fixture owns its Starting claim"),
    };
    assert!(matches!(
        state.leases.claim(
            PROVIDER,
            id,
            "deferred-startup",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Acquired
    ));
    let runtime = mint_ownership_id();
    let child = tokio::process::Command::new("sleep")
        .arg("30")
        .env(CODEX_SIDECAR_OWNERSHIP_ENV, &runtime)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .as_deref()
            != Some("sleep\n")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut lease = crate::FreshSessionLeaseGuard::armed(
        state.leases.clone(),
        PROVIDER,
        id,
        "deferred-startup",
    );
    lease.set_kill_handle(pid, &runtime);
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = attempts.clone();
    state.set_sidecar_cleanup_probe(Arc::new(move |recorded| {
        let attempt = observed.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move {
            Ok(attempt >= 10
                && crate::session_lease::kill_and_confirm_recorded_tree_dead(
                    &recorded,
                    CODEX_SIDECAR_OWNERSHIP_ENV,
                )
                .await)
        })
    }));
    let (transport, _peer) = freshell_codex::new_channel_transport();
    let (client, _notifications) = CodexAppServerClient::connect(transport);
    assert!(
        !state
            .settle_unregistered_startup(
                id,
                (Arc::new(client), runtime, child.into()),
                Some(lease),
                Some(ticket)
            )
            .await
    );
    assert!(matches!(
        state.leases.claim(
            PROVIDER,
            id,
            "blocked",
            crate::session_lease::now_epoch_ms()
        ),
        crate::session_lease::FreshSessionClaim::Held { .. }
    ));
    tokio::time::pause();
    tokio::time::timeout(Duration::from_secs(1200), async {
        while state.condemned_priors.lock().unwrap().contains_key(id) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        // Evidence is cleared inside cleanup, before its confirmed-result
        // destructor releases the retained lease and ticket in the same task.
        while !matches!(
            registry.observe(PROVIDER, id).state,
            freshell_ownership::OwnershipState::Vacant
        ) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the original detached owner settles after delayed exact proof");
    assert_eq!(attempts.load(Ordering::SeqCst), 10);
    assert!(
        matches!(
            state.leases.claim(
                PROVIDER,
                id,
                "after-proof",
                crate::session_lease::now_epoch_ms()
            ),
            crate::session_lease::FreshSessionClaim::Acquired
        ),
        "proof releases the killed lease without waiting for wall-clock TTL"
    );
    state.leases.fail(PROVIDER, id, "after-proof");
    assert!(crate::ownership_lane::partial_pid_confirmed_dead(pid));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cleanup_reaps_a_child_that_exits_during_a_failed_proof_before_retrying() {
    let runtime = mint_ownership_id();
    let mut child: CodexChild = tokio::process::Command::new("sleep")
        .arg("30")
        .env(CODEX_SIDECAR_OWNERSHIP_ENV, &runtime)
        .kill_on_drop(true)
        .spawn()
        .unwrap()
        .into();
    let pid = child.id().unwrap();
    let recorded = crate::session_lease::record_condemned_runtime_identity(
        pid,
        CODEX_SIDECAR_OWNERSHIP_ENV,
        &runtime,
    );
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = attempts.clone();
    let probe: CodexSidecarCleanupProbe = Arc::new(move |_| {
        let attempt = observed.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if attempt == 0 {
                // This test owns and retains the exact Child, so PID cannot
                // be reused until the cleanup owner reaps it.
                assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !crate::ownership_lane::partial_pid_confirmed_dead(pid) {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                Ok(false)
            } else {
                assert!(
                    !std::path::Path::new(&format!("/proc/{pid}")).exists(),
                    "each retry must reap the now-exited direct child, not retain its zombie"
                );
                Ok(true)
            }
        })
    });
    assert!(
        confirm_codex_tree_with_retries(
            recorded,
            "late-child-exit".into(),
            CodexTreeDeathProof::Hosted(probe),
            None,
            Some(&mut child)
        )
        .await
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

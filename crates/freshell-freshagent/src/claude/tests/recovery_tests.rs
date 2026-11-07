use super::*;
use std::{future::Future, task::Poll};

async fn assert_superseded_recovery_owner_reply(kind: &'static str) {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    for session_type in [SessionType::Freshclaude, SessionType::Kilroy] {
        let _env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        write_fake_transcript(home.path(), &id);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (mut state, mut bus) = state_with_bus();
        let identity = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        identity.seed(
            PROVIDER,
            &id,
            crate::identity_sink::FreshAgentSettings::default(),
        );
        state.set_identity_sink(identity.clone());
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(
            211,
        ));
        state.set_ownership(registry.clone());
        let handoff_generation = if kind == "handoff" {
            let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_handoff(
                PROVIDER,
                &id,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "handoff-recovery",
                None,
                "test",
                1,
            ) else {
                panic!("the fixture owns the handoff claim");
            };
            Some(generation)
        } else {
            None
        };
        let gate = identity.arm_binding_stall_result(PROVIDER, &id, kind == "handoff");
        let frames = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let captured = frames.clone();
        let st = state.clone();
        let operation_id = id.clone();
        let request = tokio::spawn(async move {
            match kind {
                "attach_legacy" | "attach_modern" => {
                    // An old pane id is intentionally not the registry key;
                    // the refusal payload must carry the canonical owner's fields.
                    let mut msg = attach_msg_with_resume("old-pane-key", &operation_id);
                    msg.session_type = session_type;
                    if kind == "attach_modern" {
                        msg.request_id = Some("owner-reply".into());
                    }
                    st.handle_attach(
                        msg,
                        Arc::new(move |frame| {
                            captured
                                .lock()
                                .unwrap()
                                .push(serde_json::to_value(frame).unwrap())
                        }),
                    )
                    .await;
                    None
                }
                "create" => {
                    let mut msg = dedup_create_msg("owner-reply");
                    msg.resume_session_id = Some(operation_id);
                    msg.session_type = session_type;
                    let ClaudeCreateOutcome::Failed { code, owner, .. } =
                        st.handle_create(msg, None).await
                    else {
                        panic!("superseded create must fail");
                    };
                    assert_eq!(code, "CLAUDE_ATTACH_RESUME_FAILED");
                    owner
                }
                "send" => {
                    let mut msg = send_msg(&operation_id, "not sent");
                    msg.request_id = Some("owner-reply".into());
                    msg.session_type = session_type;
                    let ClaudeSendOutcome::Refused { code, owner, .. } = st.handle_send(msg).await
                    else {
                        panic!("superseded send must be refused");
                    };
                    assert_eq!(code, "CLAUDE_ATTACH_RESUME_FAILED");
                    owner
                }
                "compact" => {
                    let mut msg = compact_msg(&operation_id, None);
                    msg.request_id = Some("owner-reply".into());
                    msg.session_type = session_type;
                    st.handle_compact(msg).await;
                    None
                }
                "handoff" => {
                    let error = st
                        .resume_for_handoff(
                            session_type_str(session_type),
                            &operation_id,
                            None,
                            None,
                            None,
                            handoff_generation.unwrap(),
                            "handoff-recovery",
                        )
                        .await
                        .expect_err("the superseded handoff must refuse");
                    assert_eq!(error.code, "claude resume failed");
                    assert!(error.detail.contains("ownership changed"));
                    error.owner
                }
                _ => unreachable!(),
            }
        });
        gate.entered.recv_timeout(Duration::from_secs(15)).unwrap();
        let old_owner = registry.observe(PROVIDER, &id);
        let generation = old_owner.generation;
        let (freshell_ownership::OwnershipState::Starting { operation_id, .. }
        | freshell_ownership::OwnershipState::Handoff { operation_id, .. }) = old_owner.state
        else {
            panic!("the parked recovery owns a real claim");
        };
        registry.fail(PROVIDER, &id, &operation_id, generation, false);
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            PROVIDER,
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "current-owner",
            None,
            "test",
            1,
        ) else {
            panic!("replacement terminal claim");
        };
        assert_eq!(
            registry.commit_live(
                PROVIDER,
                &id,
                "current-owner",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("replacement-terminal".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None
                }
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        gate.release.send(()).unwrap();
        let outcome_owner = tokio::time::timeout(Duration::from_secs(15), request)
            .await
            .unwrap()
            .unwrap();
        state.shutdown().await;
        if matches!(kind, "create" | "send" | "handoff") {
            assert_eq!(
                outcome_owner,
                Some(crate::ownership_lane::TerminalOwnerFields {
                    owner_kind: "terminal",
                    owner_epoch: 211,
                    owner_generation: generation,
                })
            );
        }
        if kind == "handoff" {
            continue;
        }
        let mut replies = frames.lock().unwrap().clone();
        replies.extend(
            std::iter::from_fn(|| bus.try_recv().ok())
                .map(|raw| serde_json::from_str::<Value>(&raw).unwrap())
                .filter(|frame| {
                    frame["requestId"] == "owner-reply"
                        || frame["event"]["requestId"] == "owner-reply"
                }),
        );
        assert_eq!(
            replies.len(),
            1,
            "{session_type:?}/{kind}: exactly one requester reply: {replies:?}"
        );
        let payload = replies[0].get("event").unwrap_or(&replies[0]);
        assert_eq!(
            json!([
                payload["ownerKind"],
                payload["ownerEpoch"],
                payload["ownerGeneration"]
            ]),
            json!(["terminal", 211, generation]),
            "{session_type:?}/{kind}: preserve the refusal's owner: {replies:?}"
        );
        if kind == "send" {
            assert!(payload["message"]
                .as_str()
                .unwrap()
                .starts_with("CLAUDE_ATTACH_RESUME_FAILED:"));
        } else {
            assert_eq!(payload["code"], "CLAUDE_ATTACH_RESUME_FAILED");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_superseded_recovery_legacy_attach_preserves_owner() {
    assert_superseded_recovery_owner_reply("attach_legacy").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_superseded_recovery_modern_attach_preserves_owner() {
    assert_superseded_recovery_owner_reply("attach_modern").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_superseded_recovery_create_preserves_owner() {
    assert_superseded_recovery_owner_reply("create").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_superseded_recovery_send_preserves_owner() {
    assert_superseded_recovery_owner_reply("send").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_superseded_recovery_compact_preserves_owner() {
    assert_superseded_recovery_owner_reply("compact").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_superseded_recovery_handoff_preserves_owner() {
    assert_superseded_recovery_owner_reply("handoff").await;
}

async fn assert_shared_resume_binding_outcome(cause: &str) {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    for session_type in [SessionType::Freshclaude, SessionType::Kilroy] {
        let _env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        write_fake_transcript(home.path(), &id);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (mut state, _rx) = state_with_bus();
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink.seed(
            PROVIDER,
            &id,
            crate::identity_sink::FreshAgentSettings::default(),
        );
        state.set_identity_sink(sink.clone());
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        if !matches!(cause, "closed" | "closed_binding") {
            state.set_ownership(registry.clone());
        }
        let gate = sink.arm_binding_stall_result(
            PROVIDER,
            &id,
            matches!(cause, "binding_io" | "stale_binding" | "closed_binding"),
        );
        let mut msg = attach_msg(&id);
        msg.session_type = session_type;
        let operation = {
            let state = state.clone();
            let id = id.clone();
            tokio::spawn(async move {
                state
                    .resume_shared(msg, id, None, true, "test/recovery-accounting")
                    .await
            })
        };
        gate.entered.recv_timeout(Duration::from_secs(15)).unwrap();
        let pid = state.sessions.lock().await[&id].child.id().unwrap();
        match cause {
            "closed" | "closed_binding" => {
                tokio::time::timeout(Duration::from_secs(5), state.handle_kill(kill_msg(&id)))
                    .await
                    .expect("closing the registered writer completes while its binding is parked");
            }
            "ownership" | "stale_binding" => {
                let freshell_ownership::OwnershipState::Starting {
                    operation_id,
                    generation,
                    ..
                } = registry.observe(PROVIDER, &id).state
                else {
                    panic!("the parked provider launch owns the Starting claim");
                };
                registry.fail(PROVIDER, &id, &operation_id, generation, false);
                let freshell_ownership::BeginOutcome::Granted { generation } = registry
                    .begin_start(
                        PROVIDER,
                        &id,
                        freshell_ownership::RuntimeOwnerKind::Terminal,
                        "new-terminal-owner",
                        None,
                        "test",
                        1,
                    )
                else {
                    panic!("the superseding terminal claim succeeds");
                };
                assert_eq!(
                    registry.commit_live(
                        PROVIDER,
                        &id,
                        "new-terminal-owner",
                        generation,
                        freshell_ownership::OwnerIdentity {
                            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                            terminal_id: Some("new-terminal".into()),
                            live_session_key: None,
                            pid: None,
                            ownership_id: None
                        }
                    ),
                    freshell_ownership::CommitOutcome::Committed
                );
            }
            "lease" => {
                // Release the lease only after the actual writer has stopped,
                // matching the native-death cleanup that can race registration.
                let old = state.sessions.lock().await.remove(&id).unwrap();
                assert!(matches!(
                    state.teardown_removed_session_logged(old).await,
                    LoggedTeardown::Confirmed
                ));
                assert!(crate::ownership_lane::partial_pid_confirmed_dead(pid));
                state
                    .leases
                    .force_release_after_confirmed_kill(PROVIDER, &id);
            }
            "binding_io" => {}
            _ => unreachable!(),
        }
        gate.release.send(()).unwrap();
        let answer = tokio::time::timeout(Duration::from_secs(15), operation)
            .await
            .expect("the parked recovery settles")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !crate::ownership_lane::partial_pid_confirmed_dead(pid) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the uncommitted writer is torn down");
        state.shutdown().await;
        assert!(
            answer.result.is_err(),
            "the interrupted registration cannot succeed"
        );
        let genuine_failure = cause == "binding_io";
        if !genuine_failure {
            assert!(
                matches!(
                    answer.result.as_ref(),
                    Err(crate::session_recovery::RecoveryFailure::Attempt(
                        recovery::RuntimeResumeError::Superseded { .. }
                    ))
                ),
                "{session_type:?}/{cause}: preserve the typed supersession cause: {:?}",
                answer.result
            );
        }
        assert_eq!(answer.status.failed_launches, u32::from(genuine_failure),
            "{session_type:?}/{cause}: only genuine provider or persistence failures consume the budget: {:?}", answer.result);
        assert_eq!(
            answer.status.retry_after_ms.is_some(),
            genuine_failure,
            "{session_type:?}/{cause}: supersession must not impose a provider retry delay"
        );
        assert!(!answer.status.exhausted);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_closed_resume_preserves_launch_budget() {
    assert_shared_resume_binding_outcome("closed").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_replaced_owner_preserves_launch_budget() {
    assert_shared_resume_binding_outcome("ownership").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_revoked_lease_preserves_launch_budget() {
    assert_shared_resume_binding_outcome("lease").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_binding_io_failure_spends_launch_budget() {
    assert_shared_resume_binding_outcome("binding_io").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_stale_binding_preserves_launch_budget() {
    assert_shared_resume_binding_outcome("stale_binding").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_closed_binding_preserves_launch_budget() {
    assert_shared_resume_binding_outcome("closed_binding").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_claim_io_and_boot_failures_spend_launch_budget() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    for session_type in [SessionType::Freshclaude, SessionType::Kilroy] {
        for boot_failure in [false, true] {
            let _env = FakeClaudeSidecarEnv::install_with_knobs(None, boot_failure);
            let home = tempfile::tempdir().unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            write_fake_transcript(home.path(), &id);
            std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
            let (mut state, _rx) = state_with_bus();
            let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
            state.set_ownership(registry.clone());
            let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
            sink.seed(
                PROVIDER,
                &id,
                crate::identity_sink::FreshAgentSettings::default(),
            );
            sink.set_fail_writes(!boot_failure);
            state.set_identity_sink(sink);
            let mut msg = attach_msg(&id);
            msg.session_type = session_type;
            let answer = tokio::time::timeout(
                Duration::from_secs(15),
                state.resume_shared(msg, id.clone(), None, true, "test/genuine-failure"),
            )
            .await
            .expect("the failed launch settles");
            state.shutdown().await;
            assert!(
                registry.observe(PROVIDER, &id).generation > 0,
                "the failed launch acquired a real ownership claim"
            );
            assert!(matches!(answer.result.as_ref(), Err(crate::session_recovery::RecoveryFailure::Attempt(recovery::RuntimeResumeError::Unavailable { .. }))),
                "{session_type:?}/boot_failure={boot_failure}: genuine failures keep their type: {:?}", answer.result);
            assert_eq!(answer.status.failed_launches, 1);
            assert!(answer.status.retry_after_ms.is_some());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_claude_kilroy_superseded_boot_preserves_launch_budget() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    for session_type in [SessionType::Freshclaude, SessionType::Kilroy] {
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1_500), false);
        let home = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        write_fake_transcript(home.path(), &id);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (mut state, _rx) = state_with_bus();
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(sink);
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        state.set_ownership(registry.clone());
        let mut msg = attach_msg(&id);
        msg.session_type = session_type;
        let operation = {
            let state = state.clone();
            let id = id.clone();
            tokio::spawn(async move {
                state
                    .resume_shared(msg, id, None, true, "test/superseded-boot")
                    .await
            })
        };
        env.create_request().await;
        let (pid, _) = state.leases.peek_kill_handle(PROVIDER, &id).unwrap();
        let freshell_ownership::OwnershipState::Starting {
            operation_id,
            generation,
            ..
        } = registry.observe(PROVIDER, &id).state
        else {
            panic!("the native boot holds its Starting claim");
        };
        registry.fail(PROVIDER, &id, &operation_id, generation, false);
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            PROVIDER,
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "new-boot-owner",
            None,
            "test",
            1,
        ) else {
            panic!("the replacement lifecycle claims the key");
        };
        assert_eq!(
            registry.commit_live(
                PROVIDER,
                &id,
                "new-boot-owner",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("replacement-terminal".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                }
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        // Model cancellation of the superseded start's exact, recorded child.
        assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGTERM) }, 0);
        let answer = tokio::time::timeout(Duration::from_secs(15), operation)
            .await
            .unwrap()
            .unwrap();
        state.shutdown().await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !crate::ownership_lane::partial_pid_confirmed_dead(pid) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the canceled native boot's process is reaped");
        assert!(
            matches!(
                answer.result.as_ref(),
                Err(crate::session_recovery::RecoveryFailure::Attempt(
                    recovery::RuntimeResumeError::Superseded { .. }
                ))
            ),
            "the old boot's cancellation remains typed: {:?}",
            answer.result
        );
        assert_eq!(answer.status.failed_launches, 0);
        assert!(answer.status.retry_after_ms.is_none());
        assert!(
            matches!(registry.observe(PROVIDER, &id).state, freshell_ownership::OwnershipState::Live { owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal)
        );
        assert!(crate::ownership_lane::partial_pid_confirmed_dead(pid));
    }
}

#[tokio::test]
async fn an_enabled_resume_waiter_survives_fast_owner_completion() {
    let state = state();
    let owner = state.try_resume_flight("fast-resume").unwrap();
    let waiting = state.wait_resume_flight("fast-resume");
    tokio::pin!(waiting);
    std::future::poll_fn(|cx| {
        assert!(matches!(waiting.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    drop(owner);
    let next = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("completion must wake the already-registered waiter");
    drop(next);
    assert!(!state.resuming.lock().unwrap().contains("fast-resume"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canceling_a_resume_owner_wakes_its_enabled_waiter() {
    let state = state();
    let acquired = Arc::new(tokio::sync::Notify::new());
    let owner = {
        let state = state.clone();
        let acquired = acquired.clone();
        tokio::spawn(async move {
            let _flight = state.wait_resume_flight("canceled-resume").await;
            acquired.notify_one();
            std::future::pending::<()>().await;
        })
    };
    acquired.notified().await;
    let waiting = state.wait_resume_flight("canceled-resume");
    tokio::pin!(waiting);
    std::future::poll_fn(|cx| {
        assert!(matches!(waiting.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());
    let next = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("RAII cancellation must remove the flight before waking its waiter");
    drop(next);
    assert!(!state.resuming.lock().unwrap().contains("canceled-resume"));
}

#[tokio::test]
async fn a_configure_receipt_from_a_replaced_runtime_cannot_change_its_replacement() {
    let (state, _rx) = state_with_bus();
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&state, &id).await;
    let turn_lock = state.sessions.lock().await[&id].turn_lock.clone();
    let configuring = {
        let state = state.clone();
        let id = id.clone();
        let turn_lock = turn_lock.clone();
        tokio::spawn(async move {
            let _turn = turn_lock.lock().await;
            state
                .configure_for_send(
                    &id,
                    &freshell_protocol::FreshAgentSendSettings {
                        collaboration_mode: None,
                        model: Some("old-runtime-model".into()),
                        cwd: None,
                        effort: None,
                        permission_mode: None,
                        sandbox: None,
                    },
                )
                .await
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let old_reply = loop {
        if let Some((_, reply)) = state
            .sessions
            .lock()
            .await
            .get_mut(&id)
            .unwrap()
            .configuration
            .pending
            .take()
        {
            break reply;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "configure never reached its RPC wait"
        );
        tokio::task::yield_now().await;
    };
    let removed = state.sessions.lock().await.remove(&id).unwrap();
    insert_fake_claude_session(&state, &id).await;
    {
        let mut sessions = state.sessions.lock().await;
        let replacement = sessions.get_mut(&id).unwrap();
        replacement.ownership_id = "replacement-runtime".into();
        replacement.turn_lock = turn_lock;
        replacement.configuration.settings.model = Some("replacement-model".into());
    }
    old_reply.send(Ok(())).unwrap();
    let outcome = configuring.await.unwrap();
    assert!(
        outcome.is_err(),
        "an obsolete receipt must not acknowledge a replacement's settings"
    );
    assert_eq!(
        state.sessions.lock().await[&id]
            .configuration
            .settings
            .model
            .as_deref(),
        Some("replacement-model")
    );
    let _ = state.teardown_removed_session_logged(removed).await;
    state.shutdown().await;
}

#[tokio::test]
async fn an_observed_hosted_transcript_cannot_fall_back_to_fresh_after_it_is_removed() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    env.program(json!([{"kind":"text", "data":{"text":"transcript observed"}}]));
    let home = tempfile::tempdir().unwrap();
    let (st, mut rx) = state_with_bus();
    let mut environment: Vec<(String, String)> = std::env::vars().collect();
    environment.retain(|(key, _)| key != "CLAUDE_CONFIG_DIR");
    environment.push((
        "CLAUDE_CONFIG_DIR".into(),
        home.path().to_string_lossy().into(),
    ));
    let st = st.with_sidecar_environment(environment);
    st.handle_create(dedup_create_msg("hosted-observed-genesis"), None)
        .await;
    let created = await_claude_created(&mut rx, "hosted-observed-genesis").await;
    let id = created["sessionId"].as_str().unwrap().to_string();
    assert!(st.sessions.lock().await[&id].launch_genesis.is_some());
    write_fake_transcript(home.path(), &id);
    st.handle_send(send_msg(&id, "observe the saved transcript"))
        .await;
    await_frame_of_inner_type(&mut rx, "freshAgent.result").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while st.sessions.lock().await[&id].launch_genesis.is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "observing the transcript must retire the in-memory Fresh genesis too"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid = st.sessions.lock().await[&id].child.id().unwrap();
    // SAFETY: this process belongs to this test's isolated fake sidecar.
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
    loop {
        let status = await_frame_of_inner_type(&mut rx, "freshAgent.status").await;
        if status["event"]["status"] == "exited" {
            break;
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while st.resolve_session_key(&id).await.is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the dead runtime was not removed"
        );
        tokio::task::yield_now().await;
    }
    // The real CLI wrote its own project directory in addition to the seeded
    // file. Once its writer is confirmed stopped, remove every copy of this id.
    let mut moved = 0;
    for project in std::fs::read_dir(home.path().join("projects")).unwrap() {
        let transcript = project.unwrap().path().join(format!("{id}.jsonl"));
        if transcript.is_file() {
            std::fs::rename(&transcript, transcript.with_extension("saved")).unwrap();
            moved += 1;
        }
    }
    assert!(
        moved >= 1,
        "the observed transcript was present before removal"
    );
    assert!(matches!(
        st.ensure_runtime(&id, SessionType::Freshclaude, None, None)
            .await,
        Err(recovery::RuntimeResumeError::Lost)
    ));
    assert_eq!(
        env.spawn_count(),
        1,
        "a conversed session is never recreated Fresh"
    );
    st.shutdown().await;
}

#[tokio::test]
async fn a_compact_with_an_obsolete_owner_fence_never_arms_or_writes_a_turn() {
    let (mut st, mut rx) = state_with_bus();
    st.set_ownership(Arc::new(
        freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41),
    ));
    let id = uuid::Uuid::new_v4().to_string();
    insert_fake_claude_session(&st, &id).await;
    let mut msg = compact_msg(&id, None);
    msg.request_id = Some("stale-compact".into());
    msg.observed_epoch = Some(41);
    msg.observed_generation = Some(7);
    st.handle_compact(msg).await;
    let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(frame["event"]["code"], "SESSION_RESERVED", "{frame}");
    assert_eq!(frame["event"]["requestId"], "stale-compact");
    assert!(!st.sessions.lock().await[&id].ledger.lock().unwrap().busy());
    st.shutdown().await;
}

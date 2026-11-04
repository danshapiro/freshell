use super::*;

fn terminal_owner(registry: &freshell_ownership::RuntimeOwnershipRegistry, id: &str) -> u64 {
    let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        id,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "terminal-owner",
        None,
        "test",
        0,
    ) else {
        panic!("terminal start must be granted")
    };
    assert!(matches!(
        registry.commit_live(
            PROVIDER,
            id,
            "terminal-owner",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some("terminal-original".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            }
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    generation
}

#[tokio::test]
async fn a_claude_create_refusal_names_the_terminal_that_refused_it() {
    let (mut state, _rx) = state_with_bus();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41));
    let id = uuid::Uuid::new_v4().to_string();
    let generation = terminal_owner(&registry, &id);
    state.set_ownership(registry);
    let mut msg = dedup_create_msg("refused-by-terminal");
    msg.resume_session_id = Some(id);
    let outcome = state.handle_create(msg, None).await;
    match outcome {
        ClaudeCreateOutcome::Failed {
            code,
            retryable,
            owner,
            ..
        } => {
            assert_eq!(code, "SESSION_RESERVED");
            assert_eq!(retryable, Some(true));
            assert_eq!(
                owner,
                Some(crate::ownership_lane::TerminalOwnerFields {
                    owner_kind: "terminal",
                    owner_epoch: 41,
                    owner_generation: generation,
                })
            );
        }
        created => panic!("foreign ownership must refuse before any spawn: {created:?}"),
    }
}

#[test]
fn a_stale_guard_refusal_keeps_the_owner_captured_by_the_atomic_decision() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41));
    let id = uuid::Uuid::new_v4().to_string();
    let generation = terminal_owner(&registry, &id);
    let refusal = crate::ownership_lane::arm_reclaimless_op_guard(
        &Some(registry.clone()),
        PROVIDER,
        &id,
        "stale-operation",
        Some(freshell_ownership::ObservedFence {
            epoch: 41,
            generation: generation - 1,
        }),
        "test",
    );
    let crate::ownership_lane::LaneOpGuard::Refused { owner, .. } = refusal else {
        panic!("stale guard must refuse")
    };
    let freshell_ownership::BeginOutcome::Granted { generation: newer } = registry.begin_handoff(
        PROVIDER,
        &id,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "move-after-refusal",
        None,
        "test",
        0,
    ) else {
        panic!("later ownership transition starts")
    };
    assert!(matches!(
        registry.commit_live(
            PROVIDER,
            &id,
            "move-after-refusal",
            newer,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(id.clone()),
                pid: None,
                ownership_id: None,
            }
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    assert_eq!(
        owner,
        Some(crate::ownership_lane::TerminalOwnerFields {
            owner_kind: "terminal",
            owner_epoch: 41,
            owner_generation: generation,
        }),
        "a later ownership lookup must not replace the refusal's captured owner"
    );
}

#[tokio::test]
async fn a_fenced_claude_send_returns_retry_and_owner_details_from_its_refusal() {
    let (mut state, mut rx) = state_with_bus();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41));
    let id = uuid::Uuid::new_v4().to_string();
    let generation = terminal_owner(&registry, &id);
    state.set_ownership(registry);
    insert_fake_claude_session(&state, &id).await;
    let mut msg = send_msg(&id, "must not reach another owner's process");
    msg.request_id = Some("refused-send".into());
    msg.observed_epoch = Some(41);
    msg.observed_generation = Some(generation - 1);
    let outcome = state.handle_send(msg).await;
    assert!(
        matches!(outcome, ClaudeSendOutcome::Refused { ref code, retryable: Some(true),
        owner: Some(crate::ownership_lane::TerminalOwnerFields {
            owner_kind: "terminal", owner_epoch: 41, owner_generation,
        }), .. } if code == "SESSION_RESERVED" && owner_generation == generation),
        "{outcome:?}"
    );
    let wire: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(wire["type"], "error");
    assert_eq!(wire["requestId"], "refused-send");
    assert!(
        wire.get("ownerKind").is_none(),
        "the existing wire response stays unchanged"
    );
    state.shutdown().await;
}

#[tokio::test]
async fn attach_result_keeps_lifecycle_guard_until_correlated_ack_is_sent() {
    let (mut state, _rx) = state_with_bus();
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41));
    let id = uuid::Uuid::new_v4().to_string();
    let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        &id,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "test-fresh-agent-owner",
        None,
        "test",
        0,
    ) else {
        panic!("fresh-agent ownership begins")
    };
    assert!(matches!(
        registry.commit_live(
            PROVIDER,
            &id,
            "test-fresh-agent-owner",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(id.clone()),
                pid: None,
                ownership_id: None,
            }
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    state.set_ownership(Arc::clone(&registry));
    insert_fake_claude_session(&state, &id).await;

    let handoff_at_ack = Arc::new(std::sync::Mutex::new(None));
    let observed_handoff = Arc::clone(&handoff_at_ack);
    let registry_for_reply = Arc::clone(&registry);
    let session_for_reply = id.clone();
    let reply: freshell_terminal::FrameSink = Arc::new(move |message| {
        if matches!(
            message,
            freshell_protocol::ServerMessage::FreshAgentAttached(_)
        ) {
            let outcome = registry_for_reply.begin_handoff(
                PROVIDER,
                &session_for_reply,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "competing-terminal-handoff",
                None,
                "attach-ack-race-test",
                0,
            );
            *observed_handoff.lock().expect("handoff result mutex") = Some(outcome);
        }
    });
    let mut request = attach_msg(&id);
    request.request_id = Some("attach-guard-ack-race".into());
    request.view_id = Some("attach-guard-view".into());
    request.observed_epoch = Some(41);
    request.observed_generation = Some(generation);

    state.handle_attach(request, reply).await;

    assert!(
        matches!(
            handoff_at_ack
                .lock()
                .expect("handoff result mutex")
                .as_ref(),
            Some(freshell_ownership::BeginOutcome::Blocked { .. })
        ),
        "a competing ownership handoff must stay blocked until the requester ack is sent"
    );
    state.shutdown().await;
}

#[test]
fn a_fresh_lane_blocked_outcome_preserves_its_captured_fresh_agent_kind() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(41));
    let id = uuid::Uuid::new_v4().to_string();
    let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
        PROVIDER,
        &id,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "fresh-owner",
        None,
        "test",
        0,
    ) else {
        panic!("fresh start")
    };
    assert!(matches!(
        registry.commit_live(
            PROVIDER,
            &id,
            "fresh-owner",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(id.clone()),
                pid: None,
                ownership_id: None,
            }
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    let outcome = freshell_ownership::BeginOutcome::Blocked {
        state: registry.observe(PROVIDER, &id).state,
        retry_after_ms: 25,
    };
    let owner =
        crate::ownership_lane::fresh_agent_owner_fields_from_outcome(&Some(registry), &outcome);
    assert_eq!(
        owner,
        Some(crate::ownership_lane::TerminalOwnerFields {
            owner_kind: "fresh-agent",
            owner_epoch: 41,
            owner_generation: generation,
        })
    );
}

use super::*;
use freshell_runtime_protocol::{AgentEventBatch, AgentJournalEvent};
use futures_util::FutureExt;
use std::sync::Mutex as StdMutex;

struct JournalState {
    native: String,
    public: String,
    batch: AgentEventBatch,
    reads: usize,
    advance_on_read: Option<String>,
}

struct JournalFixture {
    _dir: tempfile::TempDir,
    proxy: Arc<HostedFreshAgentProxy>,
    frames: broadcast::Receiver<String>,
    server: tokio::task::JoinHandle<()>,
    state: Arc<StdMutex<JournalState>>,
    soul: SoulId,
}

impl JournalFixture {
    async fn new(native: &str, public: &str, batch: AgentEventBatch) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("review-repairs.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let state = Arc::new(StdMutex::new(JournalState {
            native: native.into(),
            public: public.into(),
            batch,
            reads: 0,
            advance_on_read: None,
        }));
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let result = {
                    let mut state = server_state.lock().unwrap();
                    match envelope.body {
                        AdminCommand::Health => AdminResult::Health {
                            control_epoch: 1, installation_id: InstallationId::new(),
                        },
                        AdminCommand::Inventory => AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                            "soulId":"review-soul", "incarnationId":"review-incarnation", "hostBootId":"review-boot",
                            "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
                            "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                            "evidenceRevision":1, "successfulRecoveriesInWindow":0, "provider":"codex",
                            "nativeSessionId":state.native, "freshAgentSessionId":state.public, "freshAgentSessionType":"freshcodex"
                        })).unwrap()]),
                        AdminCommand::FreshAgentReadEvents(read) => {
                            state.reads += 1;
                            let mut page = state.batch.clone();
                            if let Some(native) = state.advance_on_read.take() { state.native = native; }
                            page.events.retain(|row| row.sequence > read.after_sequence);
                            if read.after_sequence != 0 { page.retained_state = None; page.reset_required = false; }
                            AdminResult::FreshAgentEvents(page)
                        }
                        AdminCommand::FreshAgentFork(fork) => {
                            state.native = "native-c".into();
                            state.public = "native-c".into();
                            AdminResult::FreshAgentFork(FreshAgentForkResult {
                                claude_fork: None, parent_session_id: fork.parent_session_id,
                                child_session_id: "native-c".into(), parent_retired_by_runtime: true,
                            })
                        }
                        other => panic!("unexpected review fixture request: {other:?}"),
                    }
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: envelope.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
            }
        });
        let (proxy, frames) = configure_proxy(&socket, HashMap::new());
        Self {
            _dir: dir,
            proxy,
            frames,
            server,
            state,
            soul: SoulId::parse("review-soul").unwrap(),
        }
    }

    async fn shutdown(self) {
        self.server.abort();
        let _ = self.server.await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.proxy.pollers.lock().await.contains(&self.soul) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the owned poller must settle after its control socket closes");
    }
}

fn journal_batch() -> AgentEventBatch {
    AgentEventBatch {
        accepted_native_dispatch: Some(accepted_codex_journal_proof()),
        native_dispatch_in_flight: false,
        retained_from: 1,
        head: 1,
        reset_required: false,
        retained_state: None,
        events: vec![AgentJournalEvent {
            sequence: 1,
            event: status("native-b", "initial"),
        }],
    }
}

fn status(native: &str, label: &str) -> AgentEvent {
    AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":native,
            "event":{"type":"freshAgent.status", "sessionId":native, "status":label}
        }),
    }
}

fn attach(id: &str, reference_provider: &str, reference: &str) -> HostedFreshAgentCommand {
    HostedFreshAgentCommand::Attach(
        serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":id,
            "sessionRef":{"provider":reference_provider,"sessionId":reference}
        }))
        .unwrap(),
    )
}

async fn collect_until(
    frames: &mut broadcast::Receiver<String>,
    output: &mut Vec<serde_json::Value>,
    complete: impl Fn(&[serde_json::Value]) -> bool,
) -> bool {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !complete(output) {
            output.push(serde_json::from_str(&frames.recv().await.unwrap()).unwrap());
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn displaced_presentation_requires_current_matching_transition_proof() {
    let mut failures = Vec::new();
    for changed in [false, true] {
        let fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        let scenario = std::panic::AssertUnwindSafe(async {
            let inventory = fixture.proxy.client.inventory().await.unwrap();
            {
                let mut state = fixture.state.lock().unwrap();
                if changed {
                    state.advance_on_read = Some("native-c".into());
                } else {
                    state
                        .batch
                        .accepted_native_dispatch
                        .as_mut()
                        .unwrap()
                        .identity
                        .previous_native_session_id = "other-a".into();
                }
            }
            let result = fixture
                .proxy
                .reserve_displaced_codex_presentation(&inventory, "native-a")
                .await;
            if changed {
                assert!(result.is_err(), "a changed source must force a retry");
            } else {
                assert_eq!(
                    result.unwrap(),
                    None,
                    "an unrelated transition cannot claim A"
                );
            }
            assert!(fixture.proxy.aliases.lock().await.is_empty());
        })
        .catch_unwind()
        .await;
        fixture.shutdown().await;
        if let Err(failure) = scenario {
            failures.push(failure);
        }
    }
    if let Some(failure) = failures.pop() {
        std::panic::resume_unwind(failure);
    }
}

// The supervisor fixture models a previously missing native A becoming
// resumable after its old soul has committed A -> B. It acknowledges a real
// gateway Launch for A, then records which soul receives public commands.
async fn exact_native_collision_case(old_public: &str, attach_first: bool) {
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("exact-native-collision.sock");
    let secret = root.path().join("control-secret");
    std::fs::write(&secret, "0123456789abcdef").unwrap();
    crate::managed_mcp_capability::configure("0.0.0.0", 39486, &socket, &secret).unwrap();
    let listener = UnixListener::bind(&socket).unwrap();
    let old_soul = SoulId::parse("review-soul").unwrap();
    let new_soul = stable_soul_id("codex", "exact-native-collision").unwrap();
    let old_view: freshell_runtime_protocol::RuntimeView = serde_json::from_value(serde_json::json!({
        "soulId":old_soul, "incarnationId":"old-incarnation", "hostBootId":"old-boot",
        "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
        "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
        "evidenceRevision":1, "successfulRecoveriesInWindow":0, "provider":"codex",
        "nativeSessionId":"native-b", "freshAgentSessionId":old_public, "freshAgentSessionType":"freshcodex"
    })).unwrap();
    let views = Arc::new(StdMutex::new(vec![old_view]));
    let sends = Arc::new(StdMutex::new(Vec::new()));
    let server_views = views.clone();
    let server_sends = sends.clone();
    let server_old_soul = old_soul.clone();
    let server_new_soul = new_soul.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            if !matches!(&request.body, AdminCommand::Inventory)
                && reply_to_create_preparation(&mut stream, &request).await
            {
                continue;
            }
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Inventory => {
                    AdminResult::Inventory(server_views.lock().unwrap().clone())
                }
                AdminCommand::Launch(launch) => {
                    assert_eq!(launch.soul_id, server_new_soul);
                    assert_eq!(launch.native_session_id.as_deref(), Some("native-a"));
                    let public = launch.fresh_agent.as_ref().unwrap().session_id.clone();
                    let view: freshell_runtime_protocol::RuntimeView = serde_json::from_value(serde_json::json!({
                        "soulId":launch.soul_id, "incarnationId":"new-incarnation", "hostBootId":"new-boot",
                        "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
                        "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                        "evidenceRevision":1, "successfulRecoveriesInWindow":0, "provider":"codex",
                        "nativeSessionId":"native-a", "freshAgentSessionId":public, "freshAgentSessionType":"freshcodex"
                    })).unwrap();
                    server_views.lock().unwrap().push(view.clone());
                    AdminResult::Launch(freshell_runtime_protocol::LaunchResult {
                        view,
                        worker_pid: 42,
                        worker_launch_count: 1,
                        host_boot_id: serde_json::from_value(serde_json::json!("new-boot"))
                            .unwrap(),
                        effective_limits: launch.limits,
                        fixture_evidence: serde_json::Value::Null,
                    })
                }
                AdminCommand::FreshAgentReadEvents(read) => {
                    let mut batch = if read.soul_id == server_old_soul {
                        journal_batch()
                    } else {
                        assert_eq!(read.soul_id, server_new_soul);
                        let mut batch = journal_batch();
                        batch.accepted_native_dispatch = None;
                        batch.events[0].event = status("native-a", "new-native-a");
                        batch
                    };
                    batch
                        .events
                        .retain(|row| row.sequence > read.after_sequence);
                    AdminResult::FreshAgentEvents(batch)
                }
                AdminCommand::FreshAgentSend(send) => {
                    server_sends.lock().unwrap().push((send.text, send.soul_id));
                    AdminResult::FreshAgentCommand {
                        state: freshell_runtime_protocol::CommandState::ProviderAcked,
                    }
                }
                AdminCommand::FreshAgentReadSnapshot(read) => {
                    let native = if read.soul_id == server_old_soul {
                        "native-b"
                    } else {
                        assert_eq!(read.soul_id, server_new_soul);
                        "native-a"
                    };
                    AdminResult::FreshAgentSnapshot(serde_json::json!({
                        "threadId":native, "provider":"codex", "sessionType":"freshcodex",
                        "status":"idle", "turns":[], "capabilities":{}, "extensions":{}
                    }))
                }
                other => panic!("unexpected collision fixture request: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let (mut proxy, mut frames) = configure_proxy(&socket, HashMap::new());
    Arc::get_mut(&mut proxy)
        .unwrap()
        .fixture_modes
        .insert("freshcodex".into());
    let mut restarted_proxy = None;
    let scenario = std::panic::AssertUnwindSafe(async {
        if attach_first {
            proxy
                .clone()
                .handle(attach("native-a", "codex", "native-b"))
                .await;
            let mut seen = Vec::new();
            assert!(
                collect_until(&mut frames, &mut seen, |frames| frames.iter().any(
                    |frame| {
                        frame["sessionId"] == "native-a" && frame["event"]["status"] == "initial"
                    }
                ))
                .await,
                "old A must attach to its accepted B replacement: {seen:?}"
            );
        }
        while frames.try_recv().is_ok() {}

        let create = serde_json::from_value(serde_json::json!({
            "requestId":"exact-native-collision", "provider":"codex", "sessionType":"freshcodex",
            "cwd":root.path(), "sessionRef":{"provider":"codex", "sessionId":"native-a"}
        }))
        .unwrap();
        let receipt = tokio::time::timeout(Duration::from_secs(5), proxy.create(create))
            .await
            .unwrap()
            .unwrap();
        assert!(
            receipt.cleanup_receipt.is_some(),
            "a deliberate exact-A resume must launch the newly available A"
        );
        let mut created = Vec::new();
        assert!(
            collect_until(&mut frames, &mut created, |frames| frames
                .iter()
                .any(|frame| frame["type"] == "freshAgent.created"))
            .await
        );
        let created = created
            .iter()
            .find(|frame| frame["type"] == "freshAgent.created")
            .unwrap();
        let new_public = created["sessionId"].as_str().unwrap().to_string();
        assert_ne!(
            new_public, "native-a",
            "both live panes need distinct public identities"
        );
        assert_eq!(created["sessionRef"]["sessionId"], "native-a");

        if !attach_first {
            let old = proxy
                .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                    session_id: "native-a".into(),
                    provider: "codex".into(),
                    session_type: "freshcodex".into(),
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                old["threadId"], "native-b",
                "old A remains authoritative before its pane reattaches"
            );
            proxy
                .clone()
                .handle(attach("native-a", "codex", "native-b"))
                .await;
        }

        let repeated = proxy
            .clone()
            .create_agent(RestLaneCreate {
                request_id: "second-exact-native-collision".into(),
                provider: "codex".into(),
                session_type: "freshcodex".into(),
                cwd: Some(root.path().to_str().unwrap().into()),
                native_session_id: Some("native-a".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            repeated.session_id, new_public,
            "REST reuse must return the same collision-free presentation"
        );

        for (session, native) in [("native-a", "native-b"), (new_public.as_str(), "native-a")] {
            let snapshot = proxy
                .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                    session_id: session.into(),
                    provider: "codex".into(),
                    session_type: "freshcodex".into(),
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                snapshot["threadId"], native,
                "snapshot must use the presentation's owning soul"
            );
        }

        for (session, text) in [("native-a", "old"), (new_public.as_str(), "new")] {
            let send = serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":session, "text":text
            }))
            .unwrap();
            proxy
                .clone()
                .handle(HostedFreshAgentCommand::Send(send))
                .await;
        }
        assert_eq!(
            *sends.lock().unwrap(),
            vec![
                ("old".into(), old_soul.clone()),
                ("new".into(), new_soul.clone())
            ]
        );

        let (mut restarted, mut replay) = configure_proxy(&socket, HashMap::new());
        Arc::get_mut(&mut restarted)
            .unwrap()
            .fixture_modes
            .insert("freshcodex".into());
        restarted_proxy = Some(restarted.clone());
        let before_attach = restarted
            .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                session_id: "native-a".into(),
                provider: "codex".into(),
                session_type: "freshcodex".into(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            before_attach["threadId"], "native-b",
            "restart must recover old A before attach"
        );
        restarted
            .clone()
            .handle(attach("native-a", "codex", "native-b"))
            .await;
        restarted
            .clone()
            .handle(attach(&new_public, "codex", "native-a"))
            .await;
        let mut observed = Vec::new();
        assert!(
            collect_until(&mut replay, &mut observed, |frames| {
                frames.iter().any(|frame| {
                    frame["sessionId"] == "native-a" && frame["event"]["status"] == "initial"
                }) && frames.iter().any(|frame| {
                    frame["sessionId"] == new_public && frame["event"]["status"] == "new-native-a"
                })
            })
            .await,
            "both distinct identities must replay after gateway restart: {observed:?}"
        );
        assert!(!observed
            .iter()
            .any(|frame| frame["sessionId"] == "native-a"
                && frame["event"]["status"] == "new-native-a"));
        assert!(
            !observed
                .iter()
                .any(|frame| frame["sessionId"] == new_public
                    && frame["event"]["status"] == "initial")
        );
        for (session, text) in [
            ("native-a", "old-after-restart"),
            (new_public.as_str(), "new-after-restart"),
        ] {
            let send = serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":session, "text":text
            }))
            .unwrap();
            restarted
                .clone()
                .handle(HostedFreshAgentCommand::Send(send))
                .await;
        }
        assert_eq!(
            &sends.lock().unwrap()[2..],
            &[
                ("old-after-restart".into(), old_soul.clone()),
                ("new-after-restart".into(), new_soul.clone())
            ]
        );
    })
    .catch_unwind()
    .await;
    server.abort();
    let _ = server.await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let initial_running = !proxy.pollers.lock().await.is_empty();
            let restarted_running = match &restarted_proxy {
                Some(restarted) => !restarted.pollers.lock().await.is_empty(),
                None => false,
            };
            if !initial_running && !restarted_running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("owned pollers must settle after fixture shutdown");
    if let Err(error) = scenario {
        std::panic::resume_unwind(error);
    }
}

#[tokio::test]
async fn exact_native_collision_preserves_a_resumed_old_presentation() {
    if create_failure_trace_child("collision-resumed", "fresh_agent_proxy::tests::review_repairs::exact_native_collision_preserves_a_resumed_old_presentation") { return; }
    exact_native_collision_case("managed-public", true).await;
}

#[tokio::test]
async fn exact_native_collision_preserves_the_old_canonical_presentation() {
    if create_failure_trace_child("collision-canonical", "fresh_agent_proxy::tests::review_repairs::exact_native_collision_preserves_the_old_canonical_presentation") { return; }
    exact_native_collision_case("native-a", true).await;
}

#[tokio::test]
async fn exact_native_collision_reserves_old_presentation_before_reattach() {
    if create_failure_trace_child("collision-before-attach", "fresh_agent_proxy::tests::review_repairs::exact_native_collision_reserves_old_presentation_before_reattach") { return; }
    exact_native_collision_case("managed-public", false).await;
}

#[tokio::test]
async fn reconnect_registers_each_presentation_in_either_order() {
    let mut failures = Vec::new();
    for order in [
        ["managed-public", "native-b"],
        ["native-b", "managed-public"],
    ] {
        let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        let scenario = std::panic::AssertUnwindSafe(async {
            let mut frames = Vec::new();
            fixture.proxy.clone().handle(attach(order[0], "codex", "native-b")).await;
            assert!(collect_until(&mut fixture.frames, &mut frames, |frames| frames.iter().any(|frame| frame["sessionId"] == order[0] && frame["event"]["status"] == "initial")).await,
                "the first attachment must receive the journal: {frames:?}");
            while fixture.frames.try_recv().is_ok() {}
            let mut replay_frames = Vec::new();
            fixture.proxy.clone().handle(attach(order[1], "codex", "native-b")).await;
            let second_replayed = collect_until(&mut fixture.frames, &mut replay_frames, |frames| frames.iter().any(|frame| frame["sessionId"] == order[1] && frame["event"]["status"] == "initial")).await;
            {
                let mut state = fixture.state.lock().unwrap();
                state.batch.head = 2;
                state.batch.events.push(AgentJournalEvent { sequence: 2, event: status("native-b", "later-live") });
            }
            let both_live = collect_until(&mut fixture.frames, &mut frames, |frames| order.iter().all(|id| frames.iter().any(|frame| frame["sessionId"] == *id && frame["event"]["status"] == "later-live"))).await;
            assert!(second_replayed, "the second attachment needs its own replay: order={order:?}; replay={replay_frames:?}; frames={frames:?}");
            assert!(both_live, "both attachments need later live output: order={order:?}; frames={frames:?}");
        }).catch_unwind().await;
        fixture.shutdown().await;
        if scenario.is_err() {
            failures.push(order);
        }
    }
    assert!(
        failures.is_empty(),
        "each attachment order must work: {failures:?}"
    );
}

#[tokio::test]
async fn reconnect_requires_the_accepted_old_to_current_identity() {
    let mut failures = Vec::new();
    for (id, provider, reference) in [
        ("unrelated", "codex", "native-b"),
        ("native-a", "codex", "native-a"),
        ("native-a", "claude", "native-b"),
        ("managed-public", "codex", "stale-native"),
    ] {
        let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        fixture
            .proxy
            .clone()
            .handle(attach(id, provider, reference))
            .await;
        let mut frames = Vec::new();
        let refused = collect_until(&mut fixture.frames, &mut frames, |frames| {
            frames.iter().any(|frame| {
                frame["sessionId"] == id && frame["event"]["code"] == "MANAGED_FRESH_AGENT_ERROR"
            })
        })
        .await;
        fixture.shutdown().await;
        if !refused {
            failures.push((id, provider, reference, frames));
        }
    }
    assert!(
        failures.is_empty(),
        "unrelated, stale, or wrong-provider references must not attach: {failures:?}"
    );
}

#[tokio::test]
async fn reconnect_accepts_the_proven_previous_presentation() {
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture
            .proxy
            .clone()
            .handle(attach("native-a", "codex", "native-b"))
            .await;
        let mut frames = Vec::new();
        let replayed = collect_until(&mut fixture.frames, &mut frames, |frames| {
            frames.iter().any(|frame| {
                frame["sessionId"] == "native-a" && frame["event"]["status"] == "initial"
            })
        })
        .await;
        assert!(
            replayed,
            "the previous A presentation with accepted A→B proof must attach: {frames:?}"
        );
        assert!(
            frames
                .iter()
                .any(|frame| frame["type"] == "freshAgent.session.materialized"
                    && frame["sessionId"] == "native-a"
                    && frame["sessionRef"]["sessionId"] == "native-b"),
            "{frames:?}"
        );
        assert_eq!(
            fixture
                .proxy
                .resolve_soul(&AgentProvider::Codex, SessionType::Freshcodex, "native-a")
                .await,
            Some(fixture.soul.clone())
        );
    })
    .catch_unwind()
    .await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn reconnect_does_not_claim_a_terminal_owned_native_session() {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
    };
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    let ownership = Arc::new(RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } = ownership.begin_start(
        "codex",
        "native-b",
        RuntimeOwnerKind::Terminal,
        "terminal-owner",
        None,
        "review-test",
        1,
    ) else {
        panic!("test terminal must acquire its owner")
    };
    assert_eq!(
        ownership.commit_live(
            "codex",
            "native-b",
            "terminal-owner",
            generation,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("terminal".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            }
        ),
        CommitOutcome::Committed
    );
    let observed = ownership.observe("codex", "native-b");
    fixture.proxy.set_ownership(ownership);
    let command = HostedFreshAgentCommand::Attach(
        serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
            "sessionRef":{"provider":"codex", "sessionId":"native-b"},
            "observedEpoch":observed.epoch, "observedGeneration":observed.generation
        }))
        .unwrap(),
    );
    fixture.proxy.clone().handle(command).await;
    let mut frames = Vec::new();
    let refused = collect_until(&mut fixture.frames, &mut frames, |frames| {
        frames.iter().any(|frame| {
            frame["sessionId"] == "managed-public" && frame["event"]["type"] == "freshAgent.error"
        })
    })
    .await;
    let route_claimed = fixture
        .proxy
        .presentation_routes
        .lock()
        .await
        .contains_key(&fixture.soul);
    fixture.shutdown().await;
    assert!(
        refused && !route_claimed,
        "terminal-owned B cannot be claimed as a fresh agent: {frames:?}"
    );
}

#[tokio::test]
async fn reconnect_accepts_only_a_current_fresh_agent_owner_fence() {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
    };
    for scenario in ["current", "stale", "half", "legacy-resume"] {
        let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            "native-b",
            RuntimeOwnerKind::FreshAgent,
            "fresh-owner",
            None,
            "review-test",
            1,
        ) else {
            panic!("test owner must acquire the session")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                "native-b",
                "fresh-owner",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                }
            ),
            CommitOutcome::Committed
        );
        let observed = ownership.observe("codex", "native-b");
        fixture.proxy.set_ownership(ownership);
        let mut value = serde_json::json!({"provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
            "sessionRef":{"provider":"codex","sessionId":"native-b"}, "observedEpoch":observed.epoch,
            "observedGeneration":observed.generation});
        match scenario {
            "stale" => value["observedGeneration"] = serde_json::json!(observed.generation + 1),
            "half" => {
                value.as_object_mut().unwrap().remove("observedGeneration");
            }
            "legacy-resume" => value["resumeSessionId"] = "native-b".into(),
            _ => {}
        }
        fixture
            .proxy
            .clone()
            .handle(HostedFreshAgentCommand::Attach(
                serde_json::from_value(value).unwrap(),
            ))
            .await;
        let mut frames = Vec::new();
        let delivered = collect_until(&mut fixture.frames, &mut frames, |frames| {
            frames.iter().any(|frame| {
                frame["sessionId"] == "managed-public"
                    && if scenario == "current" {
                        frame["event"]["status"] == "initial"
                    } else {
                        frame["event"]["type"] == "freshAgent.error"
                    }
            })
        })
        .await;
        fixture.shutdown().await;
        assert!(
            delivered,
            "only a complete current owner fence can attach ({scenario}): {frames:?}"
        );
    }
}

#[tokio::test]
async fn provisional_controls_do_not_reach_old_presentation_or_retained_snapshot() {
    let mut leaks = Vec::new();
    for retained in [false, true] {
        for in_flight in [false, true] {
            let controls: Vec<_> = ["permission", "question", "elicitation"].into_iter().map(|kind| {
                serde_json::json!({"type":format!("freshAgent.{kind}.request"), "sessionId":"native-b", "requestId":format!("{kind}-b")})
            }).collect();
            let mut batch = journal_batch();
            batch.accepted_native_dispatch = None;
            batch.native_dispatch_in_flight = in_flight;
            batch.events = controls
                .iter()
                .enumerate()
                .map(|(index, payload)| AgentJournalEvent {
                    sequence: index as u64 + 1,
                    event: AgentEvent::PermissionRequested {
                        decision_id: payload["requestId"].as_str().unwrap().into(),
                        payload: payload.clone(),
                    },
                })
                .collect();
            batch.head = 3;
            if retained {
                batch.retained_state = Some(serde_json::json!({
                    "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"owned","ownerEpoch":0,"ownerGeneration":0},
                    "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-a","turns":[],
                        "pendingApprovals":[controls[0].clone()], "pendingQuestions":[controls[1].clone()],
                        "pendingElicitations":[controls[2].clone()]},
                    "attentionMarks":[],"pendingControls":controls
                }));
            }
            let mut fixture = JournalFixture::new("native-a", "managed-public", batch).await;
            fixture.proxy.presentation_routes.lock().await.insert(
                fixture.soul.clone(),
                PresentationRoute::initial("managed-public"),
            );
            fixture
                .proxy
                .replay_once(
                    fixture.soul.clone(),
                    "codex",
                    "managed-public",
                    "freshcodex",
                )
                .await;
            let mut frames = Vec::new();
            while let Ok(frame) = fixture.frames.try_recv() {
                frames.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
            }
            fixture.shutdown().await;
            if frames.iter().any(|frame| {
                frame["event"]["type"]
                    .as_str()
                    .is_some_and(|kind| kind.ends_with(".request"))
                    || frame["event"]["retainedState"]["pendingControls"]
                        .as_array()
                        .is_some_and(|controls| !controls.is_empty())
                    || [
                        "pendingApprovals",
                        "pendingQuestions",
                        "pendingElicitations",
                    ]
                    .iter()
                    .any(|field| {
                        frame["event"]["retainedState"]["snapshot"][field]
                            .as_array()
                            .is_some_and(|controls| !controls.is_empty())
                    })
            }) {
                leaks.push((retained, in_flight, frames));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "unaccepted B controls must not reach A/M: {leaks:?}"
    );
}

#[tokio::test]
async fn retained_provisional_control_is_retried_after_replacement_is_accepted() {
    let control = serde_json::json!({"type":"freshAgent.permission.request","sessionId":"native-b","requestId":"permission-b"});
    let mut batch = journal_batch();
    batch.accepted_native_dispatch = None;
    batch.native_dispatch_in_flight = true;
    batch.events = vec![AgentJournalEvent {
        sequence: 1,
        event: AgentEvent::PermissionRequested {
            decision_id: "permission-b".into(),
            payload: control.clone(),
        },
    }];
    batch.retained_state = Some(serde_json::json!({
        "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"owned","ownerEpoch":0,"ownerGeneration":0},
        "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-a","turns":[]},
        "attentionMarks":[],"pendingControls":[control]
    }));
    let mut fixture = JournalFixture::new("native-a", "managed-public", batch).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        assert!(
            fixture
                .proxy
                .start_poller(
                    fixture.soul.clone(),
                    "codex".into(),
                    "managed-public".into(),
                    "freshcodex".into(),
                    0
                )
                .await
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.state.lock().unwrap().reads < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the unresolved retained batch must be retried");
        let mut before = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() {
            before.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
        }
        assert!(
            !before
                .iter()
                .any(|frame| frame["event"]["requestId"] == "permission-b"),
            "{before:?}"
        );
        {
            let mut state = fixture.state.lock().unwrap();
            state.native = "native-b".into();
            state.batch.native_dispatch_in_flight = false;
            state.batch.accepted_native_dispatch = Some(accepted_codex_journal_proof());
            state.batch.retained_state.as_mut().unwrap()["snapshot"]["threadId"] =
                "native-b".into();
        }
        let mut after = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut after, |frames| frames
                .iter()
                .any(|frame| frame["event"]["requestId"] == "permission-b"))
            .await,
            "accepted control must be retried: {after:?}"
        );
        let materialized = after
            .iter()
            .position(|frame| {
                frame["type"] == "freshAgent.session.materialized"
                    && frame["sessionId"] == "managed-public"
            })
            .unwrap();
        let control = after
            .iter()
            .position(|frame| frame["event"]["requestId"] == "permission-b")
            .unwrap();
        assert!(
            materialized < control,
            "B must be announced before its pending control: {after:?}"
        );
    })
    .catch_unwind()
    .await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn fork_discards_a_previously_captured_batch_before_delivering_child_output() {
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        let mut route = PresentationRoute::initial("managed-public");
        route.resumed_session_ids.insert("native-b".into());
        fixture.proxy.presentation_routes.lock().await.insert(fixture.soul.clone(), route);
        fixture.proxy.aliases.lock().await.insert(("codex".into(), "managed-public".into()), fixture.soul.clone());
        let source = fixture.proxy.current_source(&fixture.soul).await.unwrap();
        let delivery = PolledDelivery { soul: &fixture.soul, route_generation:fixture.proxy.route_generation(&fixture.soul).await,
            provider: "codex", fallback_presentation_id: "managed-public",
            session_type: "freshcodex", attention_since: Some(0), source: Some(&source), native_dispatch_in_flight: false,
            force_materialization: false, replay_session_id: None };
        assert!(fixture.proxy.publish_accepted_codex_dispatch(&delivery, Some(&accepted_codex_journal_proof()), false).await);
        while fixture.frames.try_recv().is_ok() {}
        let retained = serde_json::json!({
            "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"b","ownerEpoch":0,"ownerGeneration":0},
            "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-b","turns":[{"id":"parent-turn"}]},
            "attentionMarks":[],"pendingControls":[{"type":"freshAgent.permission.request","sessionId":"native-b","requestId":"parent-control"}]
        });
        assert!(retained_batch_matches_source(Some(&source), Some(&source), Some(&retained)));
        fixture.proxy.clone().handle(HostedFreshAgentCommand::Fork(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"review-fork"
        })).unwrap())).await;
        let mut forked = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() { forked.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap()); }
        assert!(forked.iter().any(|frame| frame["type"] == "freshAgent.forked" && frame["sessionId"] == "native-c"), "{forked:?}");
        let old = [
            AgentEvent::Provider { payload: serde_json::json!({"type":"freshAgent.session.materialized","provider":"codex","sessionType":"freshcodex","previousSessionId":"native-a","sessionId":"native-b","sessionRef":{"provider":"codex","sessionId":"native-b"}}) },
            AgentEvent::Provider { payload: serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-b","event":{"type":"freshAgent.transcript.patch","sessionId":"native-b","marker":"parent-transcript"}}) },
            AgentEvent::Provider { payload: serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-b","event":{"type":"freshAgent.error","sessionId":"native-b","code":"PARENT_WARNING"}}) },
            AgentEvent::PermissionRequested { decision_id:"parent-control".into(), payload:serde_json::json!({"type":"freshAgent.permission.request","sessionId":"native-b","requestId":"parent-control"}) },
        ];
        for event in old.clone() { fixture.proxy.deliver_polled_event(event, &delivery).await; }
        fixture.proxy.forward_retained_batch(retained.clone(), &delivery, "freshAgent.host.backpressure").await;
        let replay = PolledDelivery { replay_session_id: Some("managed-public"), ..delivery };
        for event in old { fixture.proxy.deliver_polled_event(event, &replay).await; }
        fixture.proxy.forward_retained_batch(retained, &replay, "freshAgent.host.backpressure").await;
        fixture.proxy.forward_polled_event(&fixture.soul, status("native-c", "child-live"), "codex", "native-c", "freshcodex", Some(0)).await;
        let mut after = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() { after.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap()); }
        assert!(after.iter().any(|frame| frame["sessionId"] == "native-c" && frame["event"]["status"] == "child-live"), "{after:?}");
        assert_eq!(after.len(), 1, "a captured parent batch must never be delivered under the child: {after:?}");
    }).catch_unwind().await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

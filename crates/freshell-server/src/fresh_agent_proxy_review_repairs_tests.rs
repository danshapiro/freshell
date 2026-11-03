use super::*;
use freshell_runtime_protocol::{AgentEventBatch, AgentJournalEvent};
use futures_util::FutureExt;
use std::sync::Mutex as StdMutex;

struct JournalState {
    native: String,
    public: String,
    fork_native: String,
    presentations: Vec<String>,
    batch: AgentEventBatch,
    reads: usize,
    advance_on_read: Option<String>,
    inventory_gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    fail_inventory_reads: usize,
    replay_gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    live_gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    sends: Vec<String>,
    ambiguous_send: bool,
    disconnect_send: bool,
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
            fork_native: "native-c".into(),
            presentations: Vec::new(),
            batch,
            reads: 0,
            advance_on_read: None,
            inventory_gate: None,
            fail_inventory_reads: 0,
            replay_gate: None,
            live_gate: None,
            sends: Vec::new(),
            ambiguous_send: false,
            disconnect_send: false,
        }));
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                Some(done) = connections.join_next(), if !connections.is_empty() => done.unwrap(),
                incoming = listener.accept() => {
                let (mut stream, _) = incoming.unwrap();
                let server_state = server_state.clone();
                connections.spawn(async move {
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let (result, gate, stale_claim, failed_inventory, ambiguous_send, disconnect_send) = {
                    let mut state = server_state.lock().unwrap();
                    let mut gate = None;
                    let mut stale_claim = false;
                    let mut failed_inventory = false;
                    let mut ambiguous_send = false;
                    let mut disconnect_send = false;
                    let result = match envelope.body {
                        AdminCommand::Health => AdminResult::Health {
                            control_epoch: 1, installation_id: InstallationId::new(),
                        },
                        AdminCommand::Inventory => { gate = state.inventory_gate.take();
                            if state.fail_inventory_reads > 0 { state.fail_inventory_reads -= 1; failed_inventory = true; }
                            AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                            "soulId":"review-soul", "incarnationId":"review-incarnation", "hostBootId":"review-boot",
                            "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
                            "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                            "evidenceRevision":1, "successfulRecoveriesInWindow":0, "provider":"codex",
                            "nativeSessionId":state.native, "freshAgentSessionId":state.public,
                            "freshAgentPresentationIds":state.presentations, "freshAgentSessionType":"freshcodex"
                        })).unwrap()]) },
                        AdminCommand::FreshAgentClaimPresentation(claim) => {
                            if claim.native_session_id != state.native {
                                stale_claim = true;
                            } else if !state.presentations.contains(&claim.native_session_id) {
                                state.presentations.push(claim.native_session_id);
                            }
                            AdminResult::FreshAgentPresentationClaimed
                        }
                        AdminCommand::FreshAgentReadEvents(read) => {
                            state.reads += 1;
                            let mut page = state.batch.clone();
                            if read.max_events == 4096 { gate = state.replay_gate.take(); }
                            if read.max_events == 128 && read.after_sequence > 0 { gate = state.live_gate.take(); }
                            if let Some(native) = state.advance_on_read.take() { state.native = native; }
                            page.events.retain(|row| row.sequence > read.after_sequence);
                            if read.after_sequence != 0 { page.retained_state = None; page.reset_required = false; }
                            AdminResult::FreshAgentEvents(page)
                        }
                        AdminCommand::FreshAgentFork(fork) => {
                            state.native = state.fork_native.clone();
                            state.public = state.fork_native.clone();
                            state.presentations.clear();
                            AdminResult::FreshAgentFork(FreshAgentForkResult {
                                claude_fork: None, parent_session_id: fork.parent_session_id,
                                child_session_id: state.fork_native.clone(), parent_retired_by_runtime: true,
                            })
                        }
                        AdminCommand::FreshAgentReadSnapshot(_) => AdminResult::FreshAgentSnapshot(serde_json::json!({
                            "threadId":state.native, "provider":"codex", "sessionType":"freshcodex", "turns":[], "status":"idle", "capabilities":{}, "extensions":{}
                        })),
                        AdminCommand::FreshAgentSend(send) => {
                            state.sends.push(send.text);
                            ambiguous_send = state.ambiguous_send;
                            disconnect_send = state.disconnect_send;
                            AdminResult::FreshAgentCommand { state: freshell_runtime_protocol::CommandState::ProviderAcked }
                        }
                        other => panic!("unexpected review fixture request: {other:?}"),
                    };
                    (result, gate, stale_claim, failed_inventory, ambiguous_send, disconnect_send)
                };
                if let Some((entered, release)) = gate {
                    entered.notify_one();
                    release.notified().await;
                }
                if disconnect_send { return; }
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: envelope.request_id,
                        result: if ambiguous_send {
                            Err(freshell_runtime_protocol::RuntimeError::new(
                                RuntimeErrorCode::CommandAmbiguous, "fixture delivery is ambiguous",
                            ))
                        } else if failed_inventory {
                            Err(freshell_runtime_protocol::RuntimeError::new(
                                RuntimeErrorCode::BackendUnavailable, "fixture inventory unavailable",
                            ))
                        } else if stale_claim {
                            Err(freshell_runtime_protocol::RuntimeError::new(
                                RuntimeErrorCode::OwnershipMismatch, "fixture source changed",
                            ))
                        } else { Ok(result) },
                    },
                )
                .await
                .unwrap();
                });
                }
                }
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

struct IdentityRow {
    view: freshell_runtime_protocol::RuntimeView,
    batch: AgentEventBatch,
    unavailable: bool,
    delay: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
}

struct IdentityFixture {
    _dir: tempfile::TempDir,
    socket: std::path::PathBuf,
    rows: Arc<StdMutex<Vec<IdentityRow>>>,
    sends: Arc<StdMutex<Vec<(SoulId, String)>>>,
    server: tokio::task::JoinHandle<()>,
}

fn identity_row(soul: &str, public: &str, native: &str, prior: Option<&str>) -> IdentityRow {
    let view = serde_json::from_value(serde_json::json!({
        "soulId":soul, "incarnationId":format!("{soul}-incarnation"), "hostBootId":format!("{soul}-boot"),
        "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
        "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
        "evidenceRevision":1, "successfulRecoveriesInWindow":0, "provider":"codex",
        "nativeSessionId":native, "freshAgentSessionId":public, "freshAgentSessionType":"freshcodex"
    })).unwrap();
    let mut batch = journal_batch();
    batch.accepted_native_dispatch = prior.map(|prior| {
        let mut proof = accepted_codex_journal_proof();
        proof.identity.previous_native_session_id = prior.into();
        proof.identity.native_session_id = native.into();
        proof.prior_native_session_ids = vec![prior.into()];
        proof
    });
    batch.events[0].event = status(native, soul);
    IdentityRow {
        view,
        batch,
        unavailable: false,
        delay: None,
    }
}

impl IdentityFixture {
    async fn new(rows: Vec<IdentityRow>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("identity.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let rows = Arc::new(StdMutex::new(rows));
        let sends = Arc::new(StdMutex::new(Vec::new()));
        let server_rows = rows.clone();
        let server_sends = sends.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    Some(done) = connections.join_next(), if !connections.is_empty() => { let _ = done; },
                    incoming = listener.accept() => {
                        let (mut stream, _) = incoming.unwrap();
                        let rows = server_rows.clone();
                        let sends = server_sends.clone();
                        connections.spawn(async move {
                            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                            let (result, gate) = {
                                let mut rows = rows.lock().unwrap();
                                let unavailable = || Err(freshell_runtime_protocol::RuntimeError::new(
                                    RuntimeErrorCode::BackendUnavailable, "fixture actor unavailable"));
                                match envelope.body {
                                    AdminCommand::Health => (Ok(AdminResult::Health { control_epoch: 1, installation_id: InstallationId::new() }), None),
                                    AdminCommand::Inventory => (Ok(AdminResult::Inventory(rows.iter().map(|row| row.view.clone()).collect())), None),
                                    AdminCommand::FreshAgentReadEvents(read) => {
                                        let row = rows.iter_mut().find(|row| row.view.soul_id == read.soul_id).unwrap();
                                        let gate = row.delay.take();
                                        if row.unavailable { (unavailable(), gate) } else {
                                            let mut page = row.batch.clone();
                                            page.events.retain(|event| event.sequence > read.after_sequence);
                                            (Ok(AdminResult::FreshAgentEvents(page)), gate)
                                        }
                                    }
                                    AdminCommand::FreshAgentReadSnapshot(read) => {
                                        let row = rows.iter_mut().find(|row| row.view.soul_id == read.soul_id).unwrap();
                                        let gate = row.delay.take();
                                        if row.unavailable { (unavailable(), gate) } else {
                                            let mut snapshot: serde_json::Value = serde_json::from_str(include_str!(
                                                "../../../test/fixtures/managed-native-history/codex-hosted-live.json"
                                            )).unwrap();
                                            snapshot["threadId"] = serde_json::json!(row.view.native_session_id);
                                            snapshot["turns"][0]["id"] = serde_json::json!(row.view.soul_id);
                                            snapshot["turns"][0]["turnId"] = serde_json::json!(row.view.soul_id);
                                            (Ok(AdminResult::FreshAgentSnapshot(snapshot)), gate)
                                        }
                                    }
                                    AdminCommand::FreshAgentReadHistory(read) => {
                                        let row = rows.iter().find(|row| row.view.soul_id == read.soul_id).unwrap();
                                        if row.unavailable { (unavailable(), None) } else {
                                            (Ok(AdminResult::FreshAgentHistory(serde_json::json!({
                                                "threadId":row.view.native_session_id, "provider":"codex", "sessionType":"freshcodex",
                                                "status":"idle", "turns":[], "capabilities":{}, "extensions":{}
                                            }))), None)
                                        }
                                    }
                                    AdminCommand::FreshAgentSend(send) => {
                                        let row = rows.iter().find(|row| row.view.soul_id == send.soul_id).unwrap();
                                        if row.unavailable { (unavailable(), None) } else {
                                            sends.lock().unwrap().push((send.soul_id, send.text));
                                            (Ok(AdminResult::FreshAgentCommand { state: freshell_runtime_protocol::CommandState::ProviderAcked }), None)
                                        }
                                    }
                                    AdminCommand::FreshAgentClaimPresentation(claim) => {
                                        let conflict = rows.iter().any(|row| row.view.soul_id != claim.soul_id
                                            && (row.view.fresh_agent_session_id.as_deref() == Some(claim.native_session_id.as_str())
                                                || row.view.fresh_agent_presentation_ids.contains(&claim.native_session_id)));
                                        let row = rows.iter_mut().find(|row| row.view.soul_id == claim.soul_id).unwrap();
                                        if conflict || row.view.native_session_id.as_deref() != Some(claim.native_session_id.as_str()) {
                                            (unavailable(), None)
                                        } else {
                                            if !row.view.fresh_agent_presentation_ids.contains(&claim.native_session_id) {
                                                row.view.fresh_agent_presentation_ids.push(claim.native_session_id);
                                            }
                                            (Ok(AdminResult::FreshAgentPresentationClaimed), None)
                                        }
                                    }
                                    other => panic!("unexpected identity fixture request: {other:?}"),
                                }
                            };
                            if let Some((entered, release)) = gate { entered.notify_one(); release.notified().await; }
                            let _ = write_frame(&mut stream, &AdminReply { request_id: envelope.request_id, result }).await;
                        });
                    }
                }
            }
        });
        Self {
            _dir: dir,
            socket,
            rows,
            sends,
            server,
        }
    }

    fn proxy(&self) -> (Arc<HostedFreshAgentProxy>, broadcast::Receiver<String>) {
        let (mut proxy, frames) = configure_proxy(&self.socket, HashMap::new());
        Arc::get_mut(&mut proxy)
            .unwrap()
            .fixture_modes
            .insert("freshcodex".into());
        (proxy, frames)
    }

    async fn shutdown(self, proxies: &[Arc<HostedFreshAgentProxy>]) {
        self.server.abort();
        let _ = self.server.await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut any = false;
                for proxy in proxies {
                    any |= !proxy.pollers.lock().await.is_empty();
                }
                if !any {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fixture pollers must settle");
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
async fn gateway_failures_identify_attach_source_and_operation_request() {
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    fixture.state.lock().unwrap().fail_inventory_reads = 2;
    fixture
        .proxy
        .clone()
        .handle(attach("managed-public", "codex", "native-b"))
        .await;
    fixture
        .proxy
        .clone()
        .handle(HostedFreshAgentCommand::Send(
            serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
                "requestId":"send-current", "text":"hello"
            }))
            .unwrap(),
        ))
        .await;
    let mut frames = Vec::new();
    while let Ok(frame) = fixture.frames.try_recv() {
        frames.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
    }
    fixture.shutdown().await;
    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(
        frames[0]["event"]["gateway"],
        serde_json::json!({"operation":"attach", "nativeSessionId":"native-b"}),
        "{frames:?}"
    );
    assert_eq!(
        frames[1]["event"]["gateway"],
        serde_json::json!({"operation":"send"}),
        "{frames:?}"
    );
    assert_eq!(
        frames[1]["event"]["requestId"], "send-current",
        "{frames:?}"
    );
    println!(
        "FRESHELL_GATEWAY_ERRORS={}",
        serde_json::json!({"attach":frames[0],"send":frames[1]})
    );
}

#[tokio::test]
async fn gateway_correlates_other_failed_operations() {
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    fixture.state.lock().unwrap().fail_inventory_reads = 6;
    let commands = vec![
        HostedFreshAgentCommand::Interrupt(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"interrupt-id"
        })).unwrap()),
        HostedFreshAgentCommand::Configure(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"configure-id", "settings":{}
        })).unwrap()),
        HostedFreshAgentCommand::Compact(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"compact-id"
        })).unwrap()),
        HostedFreshAgentCommand::Fork(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"fork-id"
        })).unwrap()),
        HostedFreshAgentCommand::Undo(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"rollback-id"
        })).unwrap()),
        HostedFreshAgentCommand::Approval(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"decision-id", "decision":{}
        })).unwrap()),
    ];
    for command in commands {
        fixture.proxy.clone().handle(command).await;
    }
    let mut frames = Vec::new();
    while let Ok(frame) = fixture.frames.try_recv() {
        frames.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
    }
    fixture.shutdown().await;
    assert_eq!(frames.len(), 6, "{frames:?}");
    for (frame, operation) in frames.iter().zip([
        "interrupt",
        "configure",
        "compact",
        "fork",
        "rollback",
        "decision",
    ]) {
        assert_eq!(
            frame["event"]["gateway"]["operation"], operation,
            "{frames:?}"
        );
        assert_eq!(
            frame["event"]["requestId"],
            format!("{operation}-id"),
            "{frames:?}"
        );
    }
    assert_eq!(frames[4]["event"]["rollback"], true);
}

#[tokio::test]
async fn gateway_preserves_ambiguous_send_delivery() {
    let mut outcomes = Vec::new();
    for disconnect in [false, true] {
        let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        {
            let mut state = fixture.state.lock().unwrap();
            state.ambiguous_send = !disconnect;
            state.disconnect_send = disconnect;
        }
        fixture.proxy.aliases.lock().await.insert(
            ("codex".into(), "managed-public".into()),
            fixture.soul.clone(),
        );
        fixture
            .proxy
            .clone()
            .handle(HostedFreshAgentCommand::Send(
                serde_json::from_value(serde_json::json!({
                    "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
                    "requestId":"ambiguous-send", "text":"one delivery"
                }))
                .unwrap(),
            ))
            .await;
        let mut frames = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() {
            frames.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
        }
        let sends = fixture.state.lock().unwrap().sends.clone();
        fixture.shutdown().await;
        outcomes.push((disconnect, sends, frames));
    }
    if let Some((_, _, frames)) = outcomes.first() {
        if let Some(frame) = frames.first() {
            println!("FRESHELL_GATEWAY_AMBIGUOUS={frame}");
        }
    }
    for (disconnect, sends, frames) in outcomes {
        assert_eq!(sends, vec!["one delivery"], "disconnect={disconnect}");
        assert_eq!(frames.len(), 1, "disconnect={disconnect}: {frames:?}");
        assert_eq!(
            frames[0]["event"]["requestId"], "ambiguous-send",
            "{frames:?}"
        );
        assert_eq!(
            frames[0]["event"]["code"], "COMMAND_AMBIGUOUS",
            "{frames:?}"
        );
        assert!(
            frames[0]["event"]["message"]
                .as_str()
                .unwrap()
                .starts_with("CODEX_DELIVERY_AMBIGUOUS:"),
            "{frames:?}"
        );
    }
}

#[tokio::test]
async fn retained_replay_recovers_only_current_codex_memory_loss() {
    const CURRENT_WARNING: &str = "Codex crashed and this pane was restarted as a new thread. The agent no longer has memory of the earlier conversation in this pane.";
    let warning = |native: &str| AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":native,
            "event":{"type":"freshAgent.error", "sessionId":native, "code":"THREAD_MEMORY_LOST",
                "message":if native == "native-c" { CURRENT_WARNING.to_string() } else { format!("stale {native} warning") }}
        }),
    };
    for native in ["native-b", "native-c"] {
        let mut batch = journal_batch();
        let mut proof = accepted_codex_journal_proof();
        if native == "native-c" {
            proof.identity.previous_native_session_id = "native-b".into();
            proof.identity.native_session_id = native.into();
            proof.prior_native_session_ids = vec!["native-a".into(), "native-b".into()];
        }
        batch.accepted_native_dispatch = Some(proof);
        let mut events = vec![warning("native-a")];
        if native == "native-c" {
            events.push(warning("native-b"));
        }
        events.push(warning(native));
        events.push(status(native, "unrelated"));
        events.push(AgentEvent::Provider {
            payload: serde_json::json!({
                "type":"freshAgent.send.accepted", "provider":"codex", "sessionType":"freshcodex",
                "sessionId":native, "requestId":"retained-receipt", "submittedTurnId":"turn-receipt"
            }),
        });
        batch.events = events
            .into_iter()
            .enumerate()
            .map(|(index, event)| AgentJournalEvent {
                sequence: index as u64 + 1,
                event,
            })
            .collect();
        batch.head = batch.events.len() as u64;
        let mut snapshot: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/managed-native-history/codex-hosted-live.json"
        ))
        .unwrap();
        snapshot["threadId"] = native.into();
        snapshot["status"] = "running".into();
        snapshot["turns"][0]["items"][0]["text"] = "Retained current transcript".into();
        snapshot["extensions"]["codex"]["projection"] = serde_json::json!({
            "id":"current", "historyGeneration":0, "eventRevision":1,
            "eventOwnedTurnIds":[], "nativePreviewTurnIds":[], "nativeFinalTurnIds":[],
            "turnRows":{}, "turnOutputStates":{}, "settledTurnIds":[]
        });
        let retained = serde_json::json!({
            "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"current","ownerEpoch":0,"ownerGeneration":0},
            "snapshot":snapshot, "attentionMarks":[], "pendingControls":[]
        });
        let mut retained_live_batch = batch.clone();
        retained_live_batch.retained_state = Some(retained.clone());
        let mut fixture = JournalFixture::new(native, "managed-public", batch).await;
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
            let mut live = Vec::new();
            assert!(
                collect_until(&mut fixture.frames, &mut live, |frames| frames
                    .iter()
                    .any(|frame| frame["type"] == "freshAgent.send.accepted"
                        && frame["requestId"] == "retained-receipt"))
                .await,
                "{live:?}"
            );
            fixture.state.lock().unwrap().batch.retained_state = Some(retained);
            fixture
                .proxy
                .replay_once(
                    fixture.soul.clone(),
                    "codex",
                    "managed-public",
                    "freshcodex",
                )
                .await;
            let mut replay = Vec::new();
            while let Ok(frame) = fixture.frames.try_recv() {
                replay.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
            }
            (live, replay)
        })
        .catch_unwind()
        .await;
        fixture.shutdown().await;
        let (live, replay) = scenario.unwrap();
        let expected_warning = if native == "native-c" {
            CURRENT_WARNING.to_string()
        } else {
            format!("stale {native} warning")
        };
        for frames in [&live, &replay] {
            let notices: Vec<_> = frames
                .iter()
                .filter(|frame| frame["event"]["code"] == "THREAD_MEMORY_LOST")
                .collect();
            assert_eq!(notices.len(), 1, "{frames:?}");
            assert_eq!(notices[0]["event"]["message"], expected_warning);
        }
        assert!(live
            .iter()
            .all(|frame| frame["event"]["retainedReplay"].is_null()));
        assert!(replay
            .iter()
            .any(|frame| frame["event"]["code"] == "THREAD_MEMORY_LOST"
                && frame["event"]["retainedReplay"] == true));
        assert!(
            replay.iter().any(
                |frame| frame["event"]["retainedState"]["snapshot"]["turns"][0]["items"][0]["text"]
                    == "Retained current transcript"
            ),
            "{replay:?}"
        );
        assert!(
            replay
                .iter()
                .any(|frame| frame["type"] == "freshAgent.send.accepted"
                    && frame["requestId"] == "retained-receipt"),
            "{replay:?}"
        );
        assert!(
            !replay
                .iter()
                .any(|frame| frame["event"]["status"] == "unrelated"),
            "{replay:?}"
        );
        let mut retained_fixture =
            JournalFixture::new(native, "managed-public", retained_live_batch).await;
        let retained_scenario = std::panic::AssertUnwindSafe(async {
            assert!(
                retained_fixture
                    .proxy
                    .start_poller(
                        retained_fixture.soul.clone(),
                        "codex".into(),
                        "managed-public".into(),
                        "freshcodex".into(),
                        0
                    )
                    .await
            );
            let mut frames = Vec::new();
            assert!(
                collect_until(&mut retained_fixture.frames, &mut frames, |frames| frames
                    .iter()
                    .any(|frame| frame["type"] == "freshAgent.send.accepted"
                        && frame["requestId"] == "retained-receipt"))
                .await,
                "{frames:?}"
            );
            frames
        })
        .catch_unwind()
        .await;
        retained_fixture.shutdown().await;
        let retained_live = retained_scenario.unwrap();
        assert_eq!(
            retained_live
                .iter()
                .filter(|frame| frame["event"]["code"] == "THREAD_MEMORY_LOST")
                .count(),
            1,
            "{retained_live:?}"
        );
        assert!(retained_live
            .iter()
            .any(|frame| frame["event"]["code"] == "THREAD_MEMORY_LOST"
                && frame["event"]["retainedReplay"] == true));
        assert!(
            !retained_live
                .iter()
                .any(|frame| frame["event"]["status"] == "unrelated"),
            "{retained_live:?}"
        );
        if native == "native-c" {
            println!(
                "FRESHELL_GATEWAY_BRIDGE={}",
                serde_json::json!({"live":live,"replay":replay})
            );
        }
    }
}

#[tokio::test]
async fn displaced_presentation_requires_recorded_owner_and_current_source() {
    let mut failures = Vec::new();
    for changed in [false, true] {
        let fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        let scenario = std::panic::AssertUnwindSafe(async {
            if changed {
                fixture
                    .state
                    .lock()
                    .unwrap()
                    .presentations
                    .push("native-a".into());
            }
            let inventory = fixture.proxy.client.inventory().await.unwrap();
            {
                let mut state = fixture.state.lock().unwrap();
                if changed {
                    state.native = "native-c".into();
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
async fn exact_native_collision_case(
    old_public: &str,
    attach_first: bool,
    old_batch: Option<AgentEventBatch>,
) {
    let old_native = if old_batch.is_some() {
        "native-c"
    } else {
        "native-b"
    };
    let old_batch = old_batch.unwrap_or_else(journal_batch);
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
        "nativeSessionId":old_native, "freshAgentSessionId":old_public,
        "freshAgentPresentationIds":if old_public == "native-a" { Vec::<String>::new() } else { vec!["native-a".to_string()] },
        "freshAgentSessionType":"freshcodex"
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
                        old_batch.clone()
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
                        old_native
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
                .handle(attach("native-a", "codex", old_native))
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
                old["threadId"], old_native,
                "old A remains authoritative before its pane reattaches"
            );
            proxy
                .clone()
                .handle(attach("native-a", "codex", old_native))
                .await;
        }

        if old_public == "managed-public" {
            while frames.try_recv().is_ok() {}
            // A pane that missed the replacements still holds M/A even after
            // exact A has become a separate live soul.
            proxy
                .clone()
                .handle(attach("managed-public", "codex", "native-a"))
                .await;
            let mut reconnected = Vec::new();
            assert!(
                collect_until(&mut frames, &mut reconnected, |frames| frames.iter().any(
                    |frame| frame["sessionId"] == "managed-public"
                        && (frame["event"]["status"] == "initial"
                            || frame["event"]["type"] == "freshAgent.error")
                ))
                .await,
                "{reconnected:?}"
            );
            let announcement = reconnected.iter().position(|frame| {
                frame["type"] == "freshAgent.session.materialized"
                    && frame["sessionId"] == "managed-public"
                    && frame["sessionRef"]["sessionId"] == old_native
            });
            let output = reconnected.iter().position(|frame| {
                frame["sessionId"] == "managed-public" && frame["event"]["status"] == "initial"
            });
            assert!(
                announcement.zip(output).is_some_and(|(a, b)| a < b),
                "saved M/A must reconnect to its original soul: {reconnected:?}"
            );
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

        for (session, native) in [("native-a", old_native), (new_public.as_str(), "native-a")] {
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
            before_attach["threadId"], old_native,
            "restart must recover old A before attach"
        );
        restarted
            .clone()
            .handle(attach("native-a", "codex", old_native))
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
    exact_native_collision_case("managed-public", true, None).await;
}

#[tokio::test]
async fn exact_native_collision_preserves_the_old_canonical_presentation() {
    if create_failure_trace_child("collision-canonical", "fresh_agent_proxy::tests::review_repairs::exact_native_collision_preserves_the_old_canonical_presentation") { return; }
    exact_native_collision_case("native-a", true, None).await;
}

#[tokio::test]
async fn exact_native_collision_reserves_old_presentation_before_reattach() {
    if create_failure_trace_child("collision-before-attach", "fresh_agent_proxy::tests::review_repairs::exact_native_collision_reserves_old_presentation_before_reattach") { return; }
    exact_native_collision_case("managed-public", false, None).await;
}

#[tokio::test]
async fn native_ancestry_does_not_transfer_public_presentation_ownership() {
    let mut old = identity_row("original-soul", "native-a", "native-c", Some("native-a"));
    let mut newer = identity_row("second-soul", "managed-two", "native-d", Some("native-a"));
    old.unavailable = false;
    newer.unavailable = false;
    let fixture = IdentityFixture::new(vec![old, newer]).await;
    let mut proxies = Vec::new();
    let mut failures = Vec::new();
    for (case, old_available, new_available, old_running) in [
        ("both-live", true, true, true),
        ("old-unavailable", false, true, true),
        ("new-unavailable", true, false, true),
        ("old-retired", false, true, false),
    ] {
        {
            let mut rows = fixture.rows.lock().unwrap();
            rows[0].unavailable = !old_available;
            rows[0].view.desired_state = if old_running {
                DesiredState::Running
            } else {
                DesiredState::Stopped
            };
            rows[1].unavailable = !new_available;
        }
        fixture.sends.lock().unwrap().clear();
        // Every case begins at a new gateway, with no in-memory alias cache.
        let (proxy, mut frames) = fixture.proxy();
        proxies.push(proxy.clone());
        for (presentation, expected, available) in [
            ("native-a", "native-c", old_available && old_running),
            ("managed-two", "native-d", new_available),
        ] {
            let snapshot = proxy
                .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                    provider: "codex".into(),
                    session_type: "freshcodex".into(),
                    session_id: presentation.into(),
                })
                .await;
            let actual = snapshot
                .as_ref()
                .ok()
                .and_then(Option::as_ref)
                .and_then(|snapshot| snapshot["threadId"].as_str());
            if (available && actual != Some(expected)) || (!available && actual.is_some()) {
                failures.push(format!("{case} {presentation} snapshot expected {expected} if available, got {snapshot:?}"));
            }
            let send = serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":presentation, "text":format!("{case}-{presentation}")
            })).unwrap();
            proxy
                .clone()
                .handle(HostedFreshAgentCommand::Send(send))
                .await;
            while frames.try_recv().is_ok() {}
            proxy
                .clone()
                .handle(attach(presentation, "codex", expected))
                .await;
            if available {
                let mut observed = Vec::new();
                if !collect_until(&mut frames, &mut observed, |frames| {
                    frames.iter().any(|frame| {
                        frame["sessionId"] == presentation
                            && (frame["event"]["status"]
                                == if presentation == "native-a" {
                                    "original-soul"
                                } else {
                                    "second-soul"
                                }
                                || frame["event"]["type"] == "freshAgent.error")
                    })
                })
                .await
                    || !observed.iter().any(|frame| {
                        frame["sessionId"] == presentation
                            && frame["event"]["status"]
                                == if presentation == "native-a" {
                                    "original-soul"
                                } else {
                                    "second-soul"
                                }
                    })
                {
                    failures.push(format!(
                        "{case} {presentation} attachment did not recover its owner: {observed:?}"
                    ));
                }
            }
        }
        let sent = fixture.sends.lock().unwrap().clone();
        for (presentation, soul, available) in [
            ("native-a", "original-soul", old_available && old_running),
            ("managed-two", "second-soul", new_available),
        ] {
            let matches: Vec<_> = sent
                .iter()
                .filter(|(_, text)| text == &format!("{case}-{presentation}"))
                .collect();
            if (available && (matches.len() != 1 || matches[0].0.as_str() != soul))
                || (!available && !matches.is_empty())
            {
                failures.push(format!(
                    "{case} {presentation} command routed incorrectly: {sent:?}"
                ));
            }
        }
    }
    fixture.shutdown(&proxies).await;
    assert!(
        failures.is_empty(),
        "native history is not public ownership: {failures:#?}"
    );
}

#[tokio::test]
async fn hosted_snapshot_fences_stale_source_and_routes_public_id_to_its_owner() {
    let fixture = IdentityFixture::new(vec![
        identity_row("original-soul", "managed-public", "native-a", None),
        identity_row("other-soul", "native-b", "other-current-native", None),
    ])
    .await;
    let (proxy, _) = fixture.proxy();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    fixture.rows.lock().unwrap()[0].delay = Some((entered.clone(), release.clone()));
    let scenario = std::panic::AssertUnwindSafe(async {
        let pending = tokio::spawn({
            let proxy = proxy.clone();
            async move {
                proxy
                    .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                        provider: "codex".into(),
                        session_type: "freshcodex".into(),
                        session_id: "managed-public".into(),
                    })
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        fixture.rows.lock().unwrap()[0].view.native_session_id = Some("native-b".into());
        release.notify_one();
        let stale = tokio::time::timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap();
        assert!(
            stale.is_err(),
            "captured A must fail once the source becomes B: {stale:?}"
        );
        for (public, expected_native, expected_soul) in [
            ("managed-public", "native-b", "original-soul"),
            ("native-b", "other-current-native", "other-soul"),
        ] {
            let snapshot = proxy
                .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                    provider: "codex".into(),
                    session_type: "freshcodex".into(),
                    session_id: public.into(),
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(snapshot["threadId"], expected_native);
            assert_eq!(snapshot["turns"][0]["id"], expected_soul);
            assert_eq!(snapshot["extensions"]["codex"]["statusFromLiveState"], true);
            if public == "managed-public" {
                let client_fixture: serde_json::Value = serde_json::from_str(include_str!(
                    "../../../test/fixtures/managed-native-history/codex-hosted-live.json"
                ))
                .unwrap();
                assert_eq!(
                    snapshot, client_fixture,
                    "the mounted client consumes the route's exact live payload"
                );
            }
        }
    })
    .catch_unwind()
    .await;
    release.notify_one();
    fixture.shutdown(&[proxy]).await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn actual_secondary_presentation_survives_restart_and_a_second_souls_replacement() {
    let fixture = IdentityFixture::new(vec![identity_row(
        "original-soul",
        "managed-one",
        "native-a",
        None,
    )])
    .await;
    let (first, mut frames) = fixture.proxy();
    first
        .clone()
        .handle(attach("native-a", "codex", "native-a"))
        .await;
    let mut initial = Vec::new();
    let attached = collect_until(&mut frames, &mut initial, |frames| {
        frames.iter().any(|frame| {
            frame["sessionId"] == "native-a" && frame["event"]["status"] == "original-soul"
        })
    })
    .await;
    {
        let mut rows = fixture.rows.lock().unwrap();
        rows[0].view.native_session_id = Some("native-c".into());
        rows[0].batch =
            identity_row("original-soul", "managed-one", "native-c", Some("native-a")).batch;
        rows.push(identity_row(
            "second-soul",
            "managed-two",
            "native-d",
            Some("native-a"),
        ));
    }
    let (restarted, mut replay) = fixture.proxy();
    let snapshot = restarted
        .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: "native-a".into(),
        })
        .await;
    let old_native = snapshot
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .and_then(|snapshot| snapshot["threadId"].as_str())
        .map(str::to_owned);
    let send = serde_json::from_value(serde_json::json!({
        "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a", "text":"old-pane-input"
    })).unwrap();
    restarted
        .clone()
        .handle(HostedFreshAgentCommand::Send(send))
        .await;
    while replay.try_recv().is_ok() {}
    restarted
        .clone()
        .handle(attach("native-a", "codex", "native-c"))
        .await;
    let mut recovered = Vec::new();
    let replayed = collect_until(&mut replay, &mut recovered, |frames| {
        frames.iter().any(|frame| {
            frame["sessionId"] == "native-a"
                && (frame["event"]["status"] == "original-soul"
                    || frame["event"]["type"] == "freshAgent.error")
        })
    })
    .await
        && recovered.iter().any(|frame| {
            frame["sessionId"] == "native-a" && frame["event"]["status"] == "original-soul"
        });
    let sent = fixture.sends.lock().unwrap().clone();
    fixture.shutdown(&[first, restarted]).await;
    assert!(
        attached,
        "the secondary A presentation must actually be created first: {initial:?}"
    );
    assert_eq!(
        old_native.as_deref(),
        Some("native-c"),
        "restart must recover A's actual public owner: {snapshot:?}"
    );
    assert_eq!(
        sent,
        vec![(
            SoulId::parse("original-soul").unwrap(),
            "old-pane-input".into()
        )]
    );
    assert!(
        replayed,
        "the recovered secondary presentation must replay its original conversation: {recovered:?}"
    );
}

#[tokio::test]
async fn fork_retired_incarnation_cannot_reclaim_parent_presentation() {
    // The inventory can include an older stopped incarnation after the live
    // one. Its stale public parent must never win over the active child.
    let current = identity_row("same-soul", "native-child", "native-child", None);
    let mut old = identity_row("same-soul", "native-parent", "native-child", None);
    old.view.launch_state = freshell_runtime_protocol::LaunchState::Stopped;
    old.view.incarnation_id =
        freshell_runtime_protocol::IncarnationId::parse("old-incarnation").unwrap();
    let fixture = IdentityFixture::new(vec![current, old]).await;
    let (proxy, mut frames) = fixture.proxy();
    let parent = proxy
        .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: "native-parent".into(),
        })
        .await;
    let child = proxy
        .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: "native-child".into(),
        })
        .await;
    proxy
        .clone()
        .handle(attach("native-child", "codex", "native-child"))
        .await;
    let mut delivered = Vec::new();
    let child_attached = collect_until(&mut frames, &mut delivered, |frames| {
        frames.iter().any(|frame| {
            frame["sessionId"] == "native-child"
                && (frame["event"]["status"] == "same-soul"
                    || frame["event"]["type"] == "freshAgent.error")
        })
    })
    .await
        && delivered
            .iter()
            .any(|frame| frame["event"]["status"] == "same-soul");
    fixture.shutdown(&[proxy]).await;
    assert!(
        !matches!(parent, Ok(Some(_))),
        "the retired parent must not snapshot its child: {parent:?}"
    );
    assert!(
        matches!(child, Ok(Some(ref value)) if value["threadId"] == "native-child"),
        "current child snapshot must work: {child:?}"
    );
    assert!(
        child_attached,
        "current child attachment must work: {delivered:?}"
    );
}

#[tokio::test]
async fn healthy_exact_native_operations_ignore_unrelated_actor_failure_or_delay() {
    let fixture = IdentityFixture::new(vec![
        identity_row(
            "unrelated-soul",
            "unrelated-public",
            "unrelated-native",
            None,
        ),
        identity_row("healthy-soul", "healthy-public", "healthy-native", None),
    ])
    .await;
    let mut proxies = Vec::new();
    let mut failures = Vec::new();
    for mode in ["unavailable", "delayed"] {
        for operation in ["snapshot", "attach", "create"] {
            let release = Arc::new(tokio::sync::Notify::new());
            {
                let mut rows = fixture.rows.lock().unwrap();
                rows[0].unavailable = mode == "unavailable";
                rows[0].delay = (mode == "delayed")
                    .then(|| (Arc::new(tokio::sync::Notify::new()), release.clone()));
            }
            let (proxy, mut frames) = fixture.proxy();
            proxies.push(proxy.clone());
            let mut task = tokio::spawn(async move {
                match operation {
                    "snapshot" => proxy
                        .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                            provider: "codex".into(),
                            session_type: "freshcodex".into(),
                            session_id: "healthy-native".into(),
                        })
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|snapshot| snapshot["threadId"] == "healthy-native"),
                    "attach" => {
                        proxy
                            .clone()
                            .handle(attach("healthy-native", "codex", "healthy-native"))
                            .await;
                        let mut observed = Vec::new();
                        collect_until(&mut frames, &mut observed, |frames| {
                            frames.iter().any(|frame| {
                                frame["sessionId"] == "healthy-native"
                                    && (frame["event"]["status"] == "healthy-soul"
                                        || frame["event"]["type"] == "freshAgent.error")
                            })
                        })
                        .await
                            && observed.iter().any(|frame| {
                                frame["sessionId"] == "healthy-native"
                                    && frame["event"]["status"] == "healthy-soul"
                            })
                    }
                    _ => {
                        let create = serde_json::from_value(serde_json::json!({
                            "requestId":"healthy-resume", "provider":"codex", "sessionType":"freshcodex",
                            "sessionRef":{"provider":"codex", "sessionId":"healthy-native"}
                        })).unwrap();
                        proxy
                            .create(create)
                            .await
                            .is_ok_and(|created| created.session_id == "healthy-native")
                    }
                }
            });
            let result = tokio::time::timeout(Duration::from_secs(1), &mut task).await;
            release.notify_one();
            if !matches!(result, Ok(Ok(true))) {
                failures.push(format!(
                    "{mode} unrelated actor blocked healthy {operation}: {result:?}"
                ));
                if result.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
        }
    }
    fixture.shutdown(&proxies).await;
    assert!(
        failures.is_empty(),
        "unrelated actors must not block exact native operations: {failures:#?}"
    );
}

#[tokio::test]
async fn unavailable_displaced_owner_keeps_its_public_id_while_exact_native_resumes() {
    let mut old = identity_row("original-soul", "native-a", "native-c", Some("native-a"));
    old.unavailable = true;
    let exact = identity_row("second-soul", "managed-two", "native-a", None);
    let fixture = IdentityFixture::new(vec![old, exact]).await;
    let (proxy, mut frames) = fixture.proxy();
    let create = serde_json::from_value(serde_json::json!({
        "requestId":"resume-with-displaced-owner", "provider":"codex", "sessionType":"freshcodex",
        "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    }))
    .unwrap();
    let resumed = proxy.create(create).await;
    let old = proxy
        .snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: "native-a".into(),
        })
        .await;
    let send = serde_json::from_value(serde_json::json!({
        "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a", "text":"old-pane-input"
    })).unwrap();
    proxy
        .clone()
        .handle(HostedFreshAgentCommand::Send(send))
        .await;
    while frames.try_recv().is_ok() {}
    proxy
        .clone()
        .handle(attach("managed-two", "codex", "native-a"))
        .await;
    let mut delivered = Vec::new();
    let attached = collect_until(&mut frames, &mut delivered, |frames| {
        frames.iter().any(|frame| {
            frame["sessionId"] == "managed-two"
                && (frame["event"]["status"] == "second-soul"
                    || frame["event"]["type"] == "freshAgent.error")
        })
    })
    .await
        && delivered.iter().any(|frame| {
            frame["sessionId"] == "managed-two" && frame["event"]["status"] == "second-soul"
        });
    let sent = fixture.sends.lock().unwrap().clone();
    fixture.shutdown(&[proxy]).await;
    assert!(
        resumed.is_ok_and(|created| created.session_id == "managed-two"),
        "exact native resume must use its own public ID"
    );
    assert!(
        !matches!(old, Ok(Some(_))),
        "unavailable old A must not expose the second soul: {old:?}"
    );
    assert!(
        sent.is_empty(),
        "old A must not send to the second soul: {sent:?}"
    );
    assert!(
        attached,
        "the exact native's own presentation must remain usable: {delivered:?}"
    );
}

#[tokio::test]
async fn canonical_resume_reuses_the_same_unmaterialized_soul() {
    let mut row = identity_row("original-soul", "managed-one", "placeholder", None);
    row.view.native_session_id = None;
    row.batch.events.clear();
    row.batch.head = 0;
    let fixture = IdentityFixture::new(vec![row]).await;
    let (proxy, _) = fixture.proxy();
    let create = serde_json::from_value(serde_json::json!({
        "requestId":"resume-unmaterialized", "provider":"codex", "sessionType":"freshcodex",
        "sessionRef":{"provider":"codex", "sessionId":"managed-one"}
    }))
    .unwrap();
    let result = proxy.create(create).await;
    fixture.shutdown(&[proxy]).await;
    assert!(
        result.is_ok_and(|created| created.session_id == "managed-one"),
        "the existing canonical pane must remain reusable before native materialization"
    );
}

#[tokio::test]
async fn unmaterialized_canonical_owner_keeps_its_id_during_exact_native_resume() {
    let mut owner = identity_row("original-soul", "native-a", "placeholder", None);
    owner.view.native_session_id = None;
    owner.batch.events.clear();
    owner.batch.head = 0;
    let fixture = IdentityFixture::new(vec![
        owner,
        identity_row("second-soul", "managed-two", "native-a", None),
    ])
    .await;
    let (proxy, _) = fixture.proxy();
    let create = serde_json::from_value(serde_json::json!({
        "requestId":"resume-conflict-before-materialization", "provider":"codex", "sessionType":"freshcodex",
        "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    })).unwrap();
    let result = proxy.create(create).await;
    fixture.shutdown(&[proxy]).await;
    assert!(
        result.is_ok_and(|created| created.session_id == "managed-two"),
        "a separate exact-native soul must not take the unmaterialized owner's public ID"
    );
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
        ("native-a", "codex", "stale-native"),
    ] {
        let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        if id == "native-a" && reference == "native-a" {
            // A stale reference is invalid without authenticated replacement proof.
            fixture.state.lock().unwrap().batch.accepted_native_dispatch = None;
        } else if id == "native-a" {
            // A recorded secondary presentation still cannot borrow an
            // unrelated reference from outside its accepted transition.
            fixture
                .state
                .lock()
                .unwrap()
                .presentations
                .push("native-a".into());
        }
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
    fixture
        .state
        .lock()
        .unwrap()
        .presentations
        .push("native-a".into());
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
async fn disconnected_pane_reconnects_with_its_saved_pre_replacement_reference() {
    let mut batch = journal_batch();
    batch.accepted_native_dispatch = None;
    batch.events[0].event = status("native-a", "before-disconnect");
    let mut fixture = JournalFixture::new("native-a", "managed-public", batch).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture
            .proxy
            .clone()
            .handle(attach("managed-public", "codex", "native-a"))
            .await;
        let mut initial = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut initial, |frames| frames
                .iter()
                .any(|frame| frame["event"]["status"] == "before-disconnect"))
            .await,
            "{initial:?}"
        );
        // Drop the client's receiver before another client accepts A -> B.
        fixture.frames = fixture.proxy.broadcast.subscribe();
        {
            let mut state = fixture.state.lock().unwrap();
            state.native = "native-b".into();
            state.batch.accepted_native_dispatch = Some(accepted_codex_journal_proof());
            state.batch.head = 2;
            state.batch.events.push(AgentJournalEvent {
                sequence: 2,
                event: status("native-b", "after-replacement"),
            });
        }
        let mut other_client = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut other_client, |frames| frames
                .iter()
                .any(|frame| frame["event"]["status"] == "after-replacement"))
            .await,
            "{other_client:?}"
        );
        fixture.frames = fixture.proxy.broadcast.subscribe();
        fixture
            .proxy
            .clone()
            .handle(attach("managed-public", "codex", "native-a"))
            .await;
        let mut replay = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut replay, |frames| frames
                .iter()
                .any(|frame| frame["event"]["status"] == "after-replacement"
                    || frame["event"]["type"] == "freshAgent.error"))
            .await,
            "{replay:?}"
        );
        let announced = replay.iter().position(|frame| {
            frame["type"] == "freshAgent.session.materialized"
                && frame["sessionId"] == "managed-public"
                && frame["sessionRef"]["sessionId"] == "native-b"
        });
        let output = replay
            .iter()
            .position(|frame| frame["event"]["status"] == "after-replacement");
        assert!(
            announced.zip(output).is_some_and(|(a, b)| a < b),
            "the disconnected pane must learn B before its replayed output: {replay:?}"
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
async fn legacy_canonical_pane_reconnects_to_current_native_without_fabricating_proof() {
    use freshell_agent_runtime::host_actor::{FreshAgentHostActor, FreshAgentProfile};
    let directory = tempfile::tempdir().unwrap();
    let profile: FreshAgentProfile = serde_json::from_value(serde_json::json!({
        "provider":"codex", "runtimeVariant":"codex", "cwd":directory.path(), "providerStoreId":"legacy-reconnect",
        "nativeSessionId":"native-a", "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    })).unwrap();
    let actor = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    actor
        .dispatch(
            RequestId::parse("legacy-a-to-b").unwrap(),
            "recover".into(),
            None,
        )
        .await
        .unwrap();
    let profile = actor.profile().await;
    assert_eq!(profile.native_session_id.as_deref(), Some("native-b"));
    actor.stop().await.unwrap();
    // The approved base serialized this exact actor shape without the new
    // transition proof, while already persisting B as the current native.
    let path = directory.path().join("fresh-agent-state.json");
    let mut old_state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(old_state
        .as_object_mut()
        .unwrap()
        .remove("acceptedNativeDispatch")
        .is_some());
    std::fs::write(&path, serde_json::to_vec(&old_state).unwrap()).unwrap();
    let reopened = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    let mut batch = reopened.read_events(0, 128).await;
    assert!(batch.accepted_native_dispatch.is_none());
    batch.head += 1;
    batch.events.push(AgentJournalEvent {
        sequence: batch.head,
        event: status("native-b", "legacy-current"),
    });
    reopened.stop().await.unwrap();

    let mut fixture = JournalFixture::new("native-b", "managed-public", batch).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture
            .proxy
            .clone()
            .handle(attach("managed-public", "codex", "native-a"))
            .await;
        let mut frames = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut frames, |frames| frames
                .iter()
                .any(|frame| frame["event"]["status"] == "legacy-current"
                    || frame["event"]["type"] == "freshAgent.error"))
            .await,
            "{frames:?}"
        );
        let announcement = frames.iter().position(|frame| {
            frame["type"] == "freshAgent.session.materialized"
                && frame["sessionId"] == "managed-public"
                && frame["sessionRef"]["sessionId"] == "native-b"
        });
        let output = frames.iter().position(|frame| {
            frame["sessionId"] == "managed-public" && frame["event"]["status"] == "legacy-current"
        });
        assert!(
            announcement.zip(output).is_some_and(|(a, b)| a < b),
            "legacy M/A must announce its authoritative current B before replay: {frames:?}"
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
async fn legacy_canonical_reconnect_survives_a_later_recorded_replacement() {
    use freshell_agent_runtime::host_actor::{FreshAgentHostActor, FreshAgentProfile};
    let directory = tempfile::tempdir().unwrap();
    let profile: FreshAgentProfile = serde_json::from_value(serde_json::json!({
        "provider":"codex", "runtimeVariant":"codex", "cwd":directory.path(), "providerStoreId":"legacy-two-replacements",
        "nativeSessionId":"native-a", "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    })).unwrap();
    let actor = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    actor
        .dispatch(
            RequestId::parse("old-a-to-b").unwrap(),
            "recover".into(),
            None,
        )
        .await
        .unwrap();
    let profile = actor.profile().await;
    actor.stop().await.unwrap();
    let path = directory.path().join("fresh-agent-state.json");
    let mut old: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(old
        .as_object_mut()
        .unwrap()
        .remove("acceptedNativeDispatch")
        .is_some());
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let reopened = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    assert!(reopened
        .read_events(0, 128)
        .await
        .accepted_native_dispatch
        .is_none());
    reopened
        .dispatch(
            RequestId::parse("new-b-to-c").unwrap(),
            "recover".into(),
            None,
        )
        .await
        .unwrap();
    let mut batch = reopened.read_events(0, 128).await;
    let proof = batch.accepted_native_dispatch.as_ref().unwrap();
    assert_eq!(proof.identity.previous_native_session_id, "native-b");
    assert_eq!(proof.identity.native_session_id, "native-c");
    assert!(!proof
        .prior_native_session_ids
        .iter()
        .any(|id| id == "native-a"));
    batch.head += 1;
    batch.events.push(AgentJournalEvent {
        sequence: batch.head,
        event: status("native-c", "legacy-current-c"),
    });
    reopened.stop().await.unwrap();

    let mut fixture = JournalFixture::new("native-c", "managed-public", batch).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture.proxy.clone().handle(attach("managed-public", "codex", "native-a")).await;
        let mut frames = Vec::new();
        assert!(collect_until(&mut fixture.frames, &mut frames, |frames| frames.iter().any(|frame|
            frame["event"]["status"] == "legacy-current-c" || frame["event"]["type"] == "freshAgent.error"
        )).await, "{frames:?}");
        let announced = frames.iter().position(|frame| frame["type"] == "freshAgent.session.materialized"
            && frame["sessionId"] == "managed-public" && frame["sessionRef"]["sessionId"] == "native-c");
        let replayed = frames.iter().position(|frame| frame["sessionId"] == "managed-public"
            && frame["event"]["status"] == "legacy-current-c");
        assert!(announced.zip(replayed).is_some_and(|(a, b)| a < b), "{frames:?}");
        assert!(!fixture.state.lock().unwrap().presentations.iter().any(|id| id == "native-a"));
        fixture.state.lock().unwrap().fork_native = "native-d".into();
        fixture.proxy.clone().handle(HostedFreshAgentCommand::Fork(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"legacy-fork"
        })).unwrap())).await;
        while fixture.frames.try_recv().is_ok() {}
        fixture.proxy.clone().handle(attach("managed-public", "codex", "native-a")).await;
        let mut retired = Vec::new();
        assert!(collect_until(&mut fixture.frames, &mut retired, |frames| frames.iter().any(|frame|
            frame["sessionId"] == "managed-public" && frame["event"]["type"] == "freshAgent.error"
        )).await, "a fork-retired canonical route cannot attach to its child: {retired:?}");
        assert!(!retired.iter().any(|frame| frame["sessionId"] == "managed-public"
            && frame["sessionRef"]["sessionId"] == "native-d"), "{retired:?}");
    }).catch_unwind().await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

async fn legacy_canonical_owner_fences(native: &str, prior: Option<&str>) {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
    };
    let fixture = IdentityFixture::new(vec![
        identity_row("original-soul", "managed-one", native, prior),
        identity_row("other-soul", "other-public", "native-a", None),
    ])
    .await;
    let mut proxies = Vec::new();
    let mut failures = Vec::new();
    for case in ["fresh-current", "fresh-stale", "terminal"] {
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let kind = if case == "terminal" {
            RuntimeOwnerKind::Terminal
        } else {
            RuntimeOwnerKind::FreshAgent
        };
        let BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            native,
            kind,
            "current-owner",
            None,
            "legacy-test",
            1,
        ) else {
            panic!("current owner must acquire {native}")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                native,
                "current-owner",
                generation,
                OwnerIdentity {
                    kind,
                    terminal_id: (kind == RuntimeOwnerKind::Terminal).then(|| "terminal".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                }
            ),
            CommitOutcome::Committed
        );
        let observed = ownership.observe("codex", native);
        let (proxy, mut frames) = fixture.proxy();
        proxy.set_ownership(ownership);
        proxies.push(proxy.clone());
        let command = HostedFreshAgentCommand::Attach(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-one",
            "sessionRef":{"provider":"codex", "sessionId":"native-a"}, "observedEpoch":observed.epoch,
            "observedGeneration":if case == "fresh-stale" { observed.generation + 1 } else { observed.generation }
        })).unwrap());
        proxy.handle(command).await;
        let mut received = Vec::new();
        let done = collect_until(&mut frames, &mut received, |frames| {
            frames.iter().any(|frame| {
                frame["sessionId"] == "managed-one"
                    && (frame["event"]["status"] == "original-soul"
                        || frame["event"]["type"] == "freshAgent.error")
            })
        })
        .await;
        let acceptable = if case == "fresh-current" {
            received.iter().any(|frame| {
                frame["type"] == "freshAgent.session.materialized"
                    && frame["sessionRef"]["sessionId"] == native
            }) && received
                .iter()
                .any(|frame| frame["event"]["status"] == "original-soul")
                && !received
                    .iter()
                    .any(|frame| frame["event"]["status"] == "other-soul")
        } else {
            received
                .iter()
                .any(|frame| frame["event"]["code"] == "SESSION_RESERVED")
        };
        if !done || !acceptable {
            failures.push(format!("{case}: {received:?}"));
        }
    }
    fixture.shutdown(&proxies).await;
    assert!(
        failures.is_empty(),
        "legacy canonical reconnect must follow the actual {native} owner and fence: {failures:#?}"
    );
}

#[tokio::test]
async fn legacy_canonical_reference_uses_the_current_owner_even_if_old_native_is_owned_elsewhere() {
    legacy_canonical_owner_fences("native-b", None).await;
}

#[tokio::test]
async fn legacy_canonical_reference_keeps_owner_fences_after_later_replacement() {
    legacy_canonical_owner_fences("native-c", Some("native-b")).await;
}

#[tokio::test]
async fn older_presentation_can_reconnect_with_its_proven_saved_reference() {
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    fixture
        .state
        .lock()
        .unwrap()
        .presentations
        .push("native-a".into());
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture
            .proxy
            .clone()
            .handle(attach("native-a", "codex", "native-a"))
            .await;
        let mut frames = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut frames, |frames| frames
                .iter()
                .any(|frame| frame["event"]["status"] == "initial"
                    || frame["event"]["type"] == "freshAgent.error"))
            .await,
            "{frames:?}"
        );
        let announcement = frames.iter().position(|frame| {
            frame["type"] == "freshAgent.session.materialized"
                && frame["sessionRef"]["sessionId"] == "native-b"
        });
        let output = frames
            .iter()
            .position(|frame| frame["event"]["status"] == "initial");
        assert!(
            announcement.zip(output).is_some_and(|(a, b)| a < b),
            "{frames:?}"
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
async fn saved_old_reference_checks_the_current_native_owner_and_fence() {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
    };
    for scenario in ["fresh-current", "fresh-stale", "terminal"] {
        let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
        let ownership = Arc::new(RuntimeOwnershipRegistry::new());
        let kind = if scenario == "terminal" {
            RuntimeOwnerKind::Terminal
        } else {
            RuntimeOwnerKind::FreshAgent
        };
        let BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            "native-b",
            kind,
            "current-owner",
            None,
            "review-test",
            1,
        ) else {
            panic!("owner must start")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                "native-b",
                "current-owner",
                generation,
                OwnerIdentity {
                    kind,
                    terminal_id: (kind == RuntimeOwnerKind::Terminal).then(|| "terminal".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None
                }
            ),
            CommitOutcome::Committed
        );
        let observed = ownership.observe("codex", "native-b");
        fixture.proxy.set_ownership(ownership);
        let scenario_result = std::panic::AssertUnwindSafe(async {
            let command = HostedFreshAgentCommand::Attach(serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
                "sessionRef":{"provider":"codex", "sessionId":"native-a"}, "observedEpoch":observed.epoch,
                "observedGeneration":if scenario == "fresh-stale" { observed.generation + 1 } else { observed.generation }
            })).unwrap());
            fixture.proxy.clone().handle(command).await;
            let mut frames = Vec::new();
            assert!(collect_until(&mut fixture.frames, &mut frames, |frames| frames.iter().any(|frame|
                frame["event"]["status"] == "initial" || frame["event"]["type"] == "freshAgent.error")).await, "{frames:?}");
            if scenario == "fresh-current" {
                let announce = frames.iter().position(|frame| frame["type"] == "freshAgent.session.materialized" && frame["sessionRef"]["sessionId"] == "native-b");
                let output = frames.iter().position(|frame| frame["event"]["status"] == "initial");
                assert!(announce.zip(output).is_some_and(|(a,b)| a < b), "{frames:?}");
            } else {
                assert!(frames.iter().any(|frame| frame["event"]["code"] == "SESSION_RESERVED"), "{scenario}: {frames:?}");
                assert!(!fixture.proxy.presentation_routes.lock().await.contains_key(&fixture.soul));
            }
        }).catch_unwind().await;
        fixture.shutdown().await;
        if let Err(panic) = scenario_result {
            std::panic::resume_unwind(panic);
        }
    }
}

#[tokio::test]
async fn reconnect_rejects_a_reference_when_its_source_changes_during_inspection() {
    let mut fixture = JournalFixture::new("native-b", "managed-public", journal_batch()).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        fixture.state.lock().unwrap().inventory_gate = Some((entered.clone(), release.clone()));
        let work = tokio::spawn({
            let proxy = fixture.proxy.clone();
            async move {
                proxy
                    .handle(attach("managed-public", "codex", "native-a"))
                    .await;
            }
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        fixture.state.lock().unwrap().native = "native-c".into();
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), work)
            .await
            .unwrap()
            .unwrap();
        let mut frames = Vec::new();
        assert!(
            collect_until(&mut fixture.frames, &mut frames, |frames| frames
                .iter()
                .any(|frame| frame["event"]["type"] == "freshAgent.error"))
            .await,
            "{frames:?}"
        );
        assert!(!fixture
            .proxy
            .presentation_routes
            .lock()
            .await
            .contains_key(&fixture.soul));
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

// The live poller's cursor has already passed the receipt when a second pane
// attaches. Pause that pane's actual replay after it captures A, then let the
// live poller publish B (or let a fork retire the pane) before replay resumes.
async fn targeted_replay_after_route_change(fork: bool) {
    let receipt = AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.send.accepted", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"native-a", "requestId":"prior-request", "submittedTurnId":"prior-turn"
        }),
    };
    let mut first = journal_batch();
    first.accepted_native_dispatch = None;
    first.events = vec![AgentJournalEvent {
        sequence: 1,
        event: receipt,
    }];
    let mut fixture = JournalFixture::new("native-a", "managed-public", first).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let scenario = std::panic::AssertUnwindSafe(async {
        assert!(fixture.proxy.start_poller(
            fixture.soul.clone(), "codex".into(), "managed-public".into(), "freshcodex".into(), 0,
        ).await);
        let mut initial = Vec::new();
        assert!(collect_until(&mut fixture.frames, &mut initial, |frames| frames.iter().any(|frame|
            frame["type"] == "freshAgent.send.accepted" && frame["sessionId"] == "managed-public"
        )).await, "live poller did not advance: {initial:?}");
        fixture.state.lock().unwrap().replay_gate = Some((entered.clone(), release.clone()));
        let attaching = tokio::spawn({
            let proxy = fixture.proxy.clone();
            async move { proxy.handle(attach("native-a", "codex", "native-a")).await }
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified()).await
            .expect("targeted replay must capture the old batch");
        if fork {
            fixture.proxy.clone().handle(HostedFreshAgentCommand::Fork(serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"replay-fork"
            })).unwrap())).await;
            let mut forked = Vec::new();
            assert!(collect_until(&mut fixture.frames, &mut forked, |frames| frames.iter().any(|frame|
                frame["type"] == "freshAgent.forked" && frame["sessionId"] == "native-c"
            )).await, "fork must retire the parent: {forked:?}");
        } else {
            {
                let mut state = fixture.state.lock().unwrap();
                state.native = "native-b".into();
                state.batch.accepted_native_dispatch = Some(accepted_codex_journal_proof());
                state.batch.retained_state = Some(serde_json::json!({
                    "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"current","ownerEpoch":0,"ownerGeneration":0},
                    "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-b","turns":[{"id":"current-turn"}]},
                    "attentionMarks":[], "pendingControls":[{"type":"freshAgent.permission.request","sessionId":"native-b","requestId":"current-control"}]
                }));
            }
            let mut live = Vec::new();
            assert!(collect_until(&mut fixture.frames, &mut live, |frames| frames.iter().any(|frame|
                frame["type"] == "freshAgent.session.materialized"
                    && frame["sessionId"] == "managed-public" && frame["sessionRef"]["sessionId"] == "native-b"
            )).await, "live poller must publish replacement B: {live:?}");
        }
        while fixture.frames.try_recv().is_ok() {}
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), attaching).await.unwrap().unwrap();
        let mut after = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() {
            after.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
        }
        if fork {
            assert!(!after.iter().any(|frame| frame["sessionId"] == "native-a"),
                "targeted replay must not resurrect the fork-retired presentation: {after:?}");
        } else {
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a"
                && frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"] == "current-turn"),
                "targeted replay must recover current retained transcript: {after:?}");
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a"
                && frame["event"]["requestId"] == "current-control"),
                "targeted replay must recover current pending control: {after:?}");
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a"
                && frame["type"] == "freshAgent.send.accepted" && frame["requestId"] == "prior-request"),
                "targeted replay must recover receipts already passed by the live cursor: {after:?}");
            assert!(!after.iter().any(|frame| frame["event"]["retainedState"]["snapshot"]["threadId"] == "native-a"),
                "old A retained state cannot follow B: {after:?}");
        }
    }).catch_unwind().await;
    release.notify_one();
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn targeted_replay_recovers_after_a_live_replacement() {
    targeted_replay_after_route_change(false).await;
}

#[tokio::test]
async fn targeted_replay_does_not_revive_a_fork_retired_presentation() {
    targeted_replay_after_route_change(true).await;
}

// Keep the live poller past the retained prefix while another presentation
// attaches. Only its targeted replay can supply the earlier receipt.
async fn targeted_replay_with_unstable_source(mismatched_producer: bool) {
    let mut batch = journal_batch();
    batch.accepted_native_dispatch = None;
    batch.events = vec![AgentJournalEvent {
        sequence: 1,
        event: AgentEvent::Provider {
            payload: serde_json::json!({"type":"freshAgent.send.accepted", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"native-a", "requestId":"prior-receipt"}),
        },
    }];
    batch.retained_state = Some(serde_json::json!({
        "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"current","ownerEpoch":0,"ownerGeneration":0},
        "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-a","turns":[{"id":"current-turn"}]},
        "attentionMarks":[],"pendingControls":[{"type":"freshAgent.permission.request","sessionId":"native-a","requestId":"current-control"}]
    }));
    let mut fixture = JournalFixture::new("native-a", "managed-public", batch).await;
    let live_entered = Arc::new(tokio::sync::Notify::new());
    let live_release = Arc::new(tokio::sync::Notify::new());
    let replay_entered = Arc::new(tokio::sync::Notify::new());
    let replay_release = Arc::new(tokio::sync::Notify::new());
    let scenario = std::panic::AssertUnwindSafe(async {
        assert!(fixture.proxy.start_poller(fixture.soul.clone(), "codex".into(), "managed-public".into(), "freshcodex".into(), 0).await);
        let mut first = Vec::new();
        assert!(collect_until(&mut fixture.frames, &mut first, |frames| frames.iter().any(|frame|
            frame["type"] == "freshAgent.send.accepted" && frame["requestId"] == "prior-receipt"
        )).await, "initial live poller must pass the receipt: {first:?}");
        fixture.state.lock().unwrap().live_gate = Some((live_entered.clone(), live_release.clone()));
        tokio::time::timeout(Duration::from_secs(3), live_entered.notified()).await.unwrap();
        {
            let mut state = fixture.state.lock().unwrap();
            if mismatched_producer {
                state.batch.retained_state.as_mut().unwrap()["snapshot"]["threadId"] = "native-b".into();
            }
            state.replay_gate = Some((replay_entered.clone(), replay_release.clone()));
        }
        let attaching = tokio::spawn({ let proxy = fixture.proxy.clone(); async move {
            proxy.handle(attach("native-a", "codex", "native-a")).await;
        }});
        tokio::time::timeout(Duration::from_secs(3), replay_entered.notified()).await.unwrap();
        if !mismatched_producer { fixture.state.lock().unwrap().fail_inventory_reads = 1; }
        while fixture.frames.try_recv().is_ok() {}
        replay_release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), attaching).await.unwrap().unwrap();
        let mut after = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() { after.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap()); }
        if mismatched_producer {
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a" && frame["event"]["code"] == "FRESH_AGENT_REPLAY_RETRY"),
                "a retained producer that disagrees with stable inventory needs an explicit retry error: {after:?}");
            assert!(!after.iter().any(|frame| frame["event"]["retainedState"]["snapshot"]["threadId"] == "native-b"), "{after:?}");
        } else {
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a" && frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"] == "current-turn"), "{after:?}");
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a" && frame["event"]["requestId"] == "current-control"), "{after:?}");
            assert!(after.iter().any(|frame| frame["sessionId"] == "native-a" && frame["type"] == "freshAgent.send.accepted" && frame["requestId"] == "prior-receipt"), "{after:?}");
        }
    }).catch_unwind().await;
    live_release.notify_one();
    replay_release.notify_one();
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn targeted_replay_retries_after_unavailable_inventory() {
    targeted_replay_with_unstable_source(false).await;
}

#[tokio::test]
async fn targeted_replay_retries_when_initial_inventory_is_unavailable() {
    let mut batch = journal_batch();
    batch.accepted_native_dispatch = None;
    batch.events[0].event = status("native-a", "initial");
    batch.retained_state = Some(serde_json::json!({
        "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"current","ownerEpoch":0,"ownerGeneration":0},
        "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-a","turns":[{"id":"current-turn"}]},
        "attentionMarks":[],"pendingControls":[]
    }));
    let mut fixture = JournalFixture::new("native-a", "managed-public", batch).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture.proxy.presentation_routes.lock().await.insert(
            fixture.soul.clone(),
            PresentationRoute::initial("managed-public"),
        );
        fixture.state.lock().unwrap().fail_inventory_reads = 1;
        fixture
            .proxy
            .replay_once(
                fixture.soul.clone(),
                "codex",
                "managed-public",
                "freshcodex",
            )
            .await;
        let mut after = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() {
            after.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
        }
        assert!(
            after
                .iter()
                .any(|frame| frame["sessionId"] == "managed-public"
                    && frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"]
                        == "current-turn"),
            "{after:?}"
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
async fn targeted_replay_reports_a_mismatched_retained_producer() {
    targeted_replay_with_unstable_source(true).await;
}

#[tokio::test]
async fn targeted_replay_retries_when_retained_source_changes_before_live_announcement() {
    let mut initial = journal_batch();
    initial.accepted_native_dispatch = None;
    initial.events[0].event = status("native-a", "initial-a");
    initial.retained_state = Some(serde_json::json!({
        "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"old","ownerEpoch":0,"ownerGeneration":0},
        "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-a","turns":[{"id":"old-turn"}]},
        "attentionMarks":[],"pendingControls":[]
    }));
    let mut fixture = JournalFixture::new("native-a", "managed-public", initial).await;
    let live_entered = Arc::new(tokio::sync::Notify::new());
    let live_release = Arc::new(tokio::sync::Notify::new());
    let replay_entered = Arc::new(tokio::sync::Notify::new());
    let replay_release = Arc::new(tokio::sync::Notify::new());
    let scenario = std::panic::AssertUnwindSafe(async {
        assert!(fixture.proxy.start_poller(fixture.soul.clone(), "codex".into(),
            "managed-public".into(), "freshcodex".into(), 0).await);
        let mut first = Vec::new();
        assert!(collect_until(&mut fixture.frames, &mut first, |frames| frames.iter().any(|frame|
            frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"] == "old-turn"
        )).await, "initial retained state must be delivered: {first:?}");
        fixture.state.lock().unwrap().live_gate = Some((live_entered.clone(), live_release.clone()));
        tokio::time::timeout(Duration::from_secs(3), live_entered.notified()).await
            .expect("live poller must pause after its old-source read");
        fixture.state.lock().unwrap().replay_gate = Some((replay_entered.clone(), replay_release.clone()));
        let attaching = tokio::spawn({ let proxy = fixture.proxy.clone(); async move {
            proxy.handle(attach("native-a", "codex", "native-a")).await;
        }});
        tokio::time::timeout(Duration::from_secs(3), replay_entered.notified()).await
            .expect("targeted replay must capture the old retained batch");
        {
            let mut state = fixture.state.lock().unwrap();
            state.native = "native-b".into();
            state.batch.accepted_native_dispatch = Some(accepted_codex_journal_proof());
            let retained = state.batch.retained_state.as_mut().unwrap();
            retained["snapshot"]["threadId"] = "native-b".into();
            retained["snapshot"]["turns"][0]["id"] = "current-turn".into();
            retained["pendingControls"] = serde_json::json!([{"type":"freshAgent.permission.request","sessionId":"native-b","requestId":"current-control"}]);
        }
        while fixture.frames.try_recv().is_ok() {}
        replay_release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), attaching).await.unwrap().unwrap();
        let mut recovered = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() {
            recovered.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
        }
        live_release.notify_one();
        assert!(recovered.iter().any(|frame| frame["sessionId"] == "native-a"
            && frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"] == "current-turn"),
            "the targeted replay must recover B while the live poller remains paused: {recovered:?}");
        assert!(recovered.iter().any(|frame| frame["sessionId"] == "native-a"
            && frame["event"]["requestId"] == "current-control"), "{recovered:?}");
        assert!(!recovered.iter().any(|frame| frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"] == "old-turn"),
            "captured A retained state cannot follow the replacement: {recovered:?}");
    }).catch_unwind().await;
    live_release.notify_one();
    replay_release.notify_one();
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
        let mut delivery = PolledDelivery { soul: &fixture.soul, route_generation:fixture.proxy.route_generation(&fixture.soul).await,
            provider: "codex", fallback_presentation_id: "managed-public",
            session_type: "freshcodex", attention_since: Some(0), source: Some(&source), native_dispatch_in_flight: false,
            force_materialization: false, replay_session_id: None };
        assert!(fixture.proxy.publish_accepted_codex_dispatch(&mut delivery, Some(&accepted_codex_journal_proof()), false).await);
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

#[tokio::test]
async fn replacement_discards_a_captured_old_source_for_live_replay_and_retained_state() {
    let mut fixture = JournalFixture::new("native-a", "managed-public", journal_batch()).await;
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture.proxy.presentation_routes.lock().await.insert(
            fixture.soul.clone(), PresentationRoute::initial("managed-public"));
        let old_source = fixture.proxy.current_source(&fixture.soul).await.unwrap();
        let generation = fixture.proxy.route_generation(&fixture.soul).await;
        let mut old_delivery = PolledDelivery {
            soul: &fixture.soul, route_generation: generation, provider: "codex",
            fallback_presentation_id: "managed-public", session_type: "freshcodex",
            attention_since: Some(0), source: Some(&old_source), native_dispatch_in_flight: false,
            force_materialization: false, replay_session_id: None,
        };
        let mut old_proof = accepted_codex_journal_proof();
        old_proof.identity.previous_native_session_id = "native-before-a".into();
        old_proof.identity.native_session_id = "native-a".into();
        assert!(fixture.proxy.publish_accepted_codex_dispatch(&mut old_delivery, Some(&old_proof), false).await);
        while fixture.frames.try_recv().is_ok() {}

        // Capture the old publisher's final source read and hold the reply.
        // Its source check will succeed, but B must win the route lock first.
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        fixture.state.lock().unwrap().inventory_gate = Some((entered.clone(), release.clone()));
        let old_publisher = tokio::spawn({
            let proxy = fixture.proxy.clone();
            let soul = fixture.soul.clone();
            let source = old_source.clone();
            let proof = old_proof.clone();
            let route_generation = old_delivery.route_generation;
            async move {
                let mut delivery = PolledDelivery { soul:&soul, route_generation, provider:"codex",
                    fallback_presentation_id:"managed-public", session_type:"freshcodex", attention_since:Some(0),
                    source:Some(&source), native_dispatch_in_flight:false, force_materialization:false,
                    replay_session_id:Some("managed-public") };
                proxy.publish_accepted_codex_dispatch(&mut delivery, Some(&proof), true).await
            }
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified()).await.unwrap();
        // A different publisher commits and announces B while A is delayed.
        fixture.state.lock().unwrap().native = "native-b".into();
        let new_source = fixture.proxy.current_source(&fixture.soul).await.unwrap();
        let mut new_delivery = PolledDelivery { source: Some(&new_source), ..old_delivery };
        assert!(fixture.proxy.publish_accepted_codex_dispatch(&mut new_delivery, Some(&accepted_codex_journal_proof()), false).await);
        let materialized: serde_json::Value = serde_json::from_str(&fixture.frames.recv().await.unwrap()).unwrap();
        assert_eq!(materialized["sessionRef"]["sessionId"], "native-b");
        release.notify_one();
        assert!(!tokio::time::timeout(Duration::from_secs(3), old_publisher).await.unwrap().unwrap(),
            "an older publisher cannot announce after B, even after its final source read");

        let old_events = [
            AgentEvent::Provider { payload: serde_json::json!({"type":"freshAgent.session.materialized", "provider":"codex", "sessionType":"freshcodex", "previousSessionId":"native-before-a", "sessionId":"native-a", "sessionRef":{"provider":"codex", "sessionId":"native-a"}}) },
            AgentEvent::Provider { payload: serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a", "event":{"type":"freshAgent.transcript.patch", "sessionId":"native-a", "marker":"old-transcript"}}) },
            status("native-a", "old-status"),
            AgentEvent::PermissionRequested { decision_id:"old-control".into(), payload:serde_json::json!({"type":"freshAgent.permission.request", "sessionId":"native-a", "requestId":"old-control"}) },
            AgentEvent::Provider { payload: serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a", "event":{"type":"freshAgent.turn.complete", "sessionId":"native-a", "at":1}}) },
        ];
        let retained = serde_json::json!({
            "source":{"soulId":"review-soul","incarnationId":"review-incarnation","hostBootId":"review-boot","projectionId":"a","ownerEpoch":0,"ownerGeneration":0},
            "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-a","turns":[{"id":"old-turn"}]},
            "attentionMarks":[], "pendingControls":[{"type":"freshAgent.permission.request","sessionId":"native-a","requestId":"old-control"}]
        });
        assert!(retained_batch_matches_source(Some(&old_source), Some(&old_source), Some(&retained)));
        for replay_session_id in [None, Some("managed-public")] {
            let delivery = PolledDelivery { replay_session_id, ..old_delivery };
            for event in old_events.clone() { fixture.proxy.deliver_polled_event(event, &delivery).await; }
            fixture.proxy.forward_retained_batch(retained.clone(), &delivery, "freshAgent.host.backpressure").await;
        }
        assert!(fixture.proxy.deliver_polled_event(status("native-b", "new-live"), &new_delivery).await);
        let mut after = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() { after.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap()); }
        assert_eq!(after.len(), 1, "no captured A materialization, output, control, attention, or retained state may follow B: {after:?}");
        assert_eq!(after[0]["event"]["status"], "new-live");
    }).catch_unwind().await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

struct GatedNaming {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl SessionNaming for GatedNaming {
    fn get(
        &self,
        _: Vec<freshell_protocol::session_names::SessionNameRef>,
    ) -> freshell_freshagent::naming::NameFuture<
        Vec<freshell_protocol::session_names::SessionNameUpdate>,
    > {
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.notify_one();
            release.notified().await;
            Ok(Vec::new())
        })
    }
    fn ensure_pending(
        &self,
        _: freshell_freshagent::naming::PendingNameInput,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        unreachable!()
    }
    fn bind_pending(
        &self,
        _: freshell_freshagent::naming::BindNameInput,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        unreachable!()
    }
    fn rename(
        &self,
        _: freshell_freshagent::naming::RenameNameInput,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        unreachable!()
    }
    fn activity(
        &self,
        _: freshell_freshagent::naming::NameActivity,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        unreachable!()
    }
    fn observe_native(
        &self,
        _: freshell_freshagent::naming::NativeNameObservation,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        unreachable!()
    }
    fn record_acquisition(
        &self,
        _: freshell_protocol::session_names::SessionNameRef,
        _: freshell_protocol::native_location::NativeAcquisition,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        unreachable!()
    }
}

async fn fork_while_operation_is_paused(snapshot: bool) {
    let mut fixture = JournalFixture::new("native-a", "managed-public", journal_batch()).await;
    Arc::get_mut(&mut fixture.proxy)
        .unwrap()
        .fixture_modes
        .insert("freshcodex".into());
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let scenario = std::panic::AssertUnwindSafe(async {
        fixture.proxy.aliases.lock().await.insert(("codex".into(), "managed-public".into()), fixture.soul.clone());
        fixture.proxy.presentation_routes.lock().await.insert(fixture.soul.clone(), PresentationRoute::initial("managed-public"));
        if snapshot {
            fixture.state.lock().unwrap().inventory_gate = Some((entered.clone(), release.clone()));
        } else {
            fixture.proxy.set_session_naming(Arc::new(GatedNaming { entered: entered.clone(), release: release.clone() }));
        }
        let operation = tokio::spawn({
            let proxy = fixture.proxy.clone();
            async move {
                if snapshot {
                    let result = proxy.snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                        provider:"codex".into(), session_type:"freshcodex".into(), session_id:"native-a".into()
                    }).await;
                    matches!(result, Ok(Some(_)))
                } else {
                    let create = serde_json::from_value(serde_json::json!({
                        "requestId":"race-reuse", "provider":"codex", "sessionType":"freshcodex",
                        "sessionRef":{"provider":"codex","sessionId":"native-a"}
                    })).unwrap();
                    proxy.create(create).await.is_ok()
                }
            }
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified()).await.expect("operation reached its controlled pause");
        fixture.proxy.clone().handle(HostedFreshAgentCommand::Fork(serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public", "requestId":"race-fork"
        })).unwrap())).await;
        let mut forked = Vec::new();
        while let Ok(frame) = fixture.frames.try_recv() { forked.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap()); }
        assert!(forked.iter().any(|frame| frame["type"] == "freshAgent.forked" && frame["sessionId"] == "native-c"), "{forked:?}");
        release.notify_one();
        let success = tokio::time::timeout(Duration::from_secs(3), operation).await.unwrap().unwrap();
        for id in ["native-a", "managed-public"] {
            let send = serde_json::from_value(serde_json::json!({"provider":"codex", "sessionType":"freshcodex", "sessionId":id, "text":format!("retired-{id}")})).unwrap();
            fixture.proxy.clone().handle(HostedFreshAgentCommand::Send(send)).await;
        }
        assert!(!success, "the captured parent operation must refuse or retry after the fork");
        assert!(fixture.state.lock().unwrap().sends.is_empty(), "retired parents must not send to the child");
        {
            let aliases = fixture.proxy.aliases.lock().await;
            assert!(!aliases.contains_key(&("codex".into(), "native-a".into())) && !aliases.contains_key(&("codex".into(), "managed-public".into())), "retired parent aliases must remain retired: {aliases:?}");
        }
        for id in ["native-a", "managed-public"] {
            let result = fixture.proxy.snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
                provider:"codex".into(), session_type:"freshcodex".into(), session_id:id.into()
            }).await;
            assert!(!matches!(result, Ok(Some(_))), "retired parent {id} cannot snapshot the child");
        }
        let child = fixture.proxy.snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
            provider:"codex".into(), session_type:"freshcodex".into(), session_id:"native-c".into()
        }).await.unwrap().unwrap();
        assert_eq!(child["threadId"], "native-c");
        let send = serde_json::from_value(serde_json::json!({"provider":"codex", "sessionType":"freshcodex", "sessionId":"native-c", "text":"child-current"})).unwrap();
        fixture.proxy.clone().handle(HostedFreshAgentCommand::Send(send)).await;
        assert_eq!(fixture.state.lock().unwrap().sends, vec!["child-current"]);
    }).catch_unwind().await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn fork_retires_a_resume_paused_at_real_naming_projection() {
    fork_while_operation_is_paused(false).await;
}

#[tokio::test]
async fn fork_retires_a_snapshot_paused_after_inventory_capture() {
    fork_while_operation_is_paused(true).await;
}

struct ConsecutiveAcceptedReplacements;

#[async_trait::async_trait]
impl freshell_agent_runtime::host_actor::FreshAgentTransport for ConsecutiveAcceptedReplacements {
    async fn start(
        &self,
        profile: &freshell_agent_runtime::host_actor::FreshAgentProfile,
    ) -> Result<freshell_agent_runtime::host_actor::TransportStart, String> {
        Ok(freshell_agent_runtime::host_actor::TransportStart {
            native_session_id: profile.native_session_id.clone(),
        })
    }
    async fn dispatch(
        &self,
        _: &RequestId,
        _: &str,
        profile: &freshell_agent_runtime::host_actor::FreshAgentProfile,
    ) -> Result<
        freshell_agent_runtime::host_actor::DispatchAck,
        freshell_agent_runtime::host_actor::DispatchFailure,
    > {
        let from = profile.native_session_id.as_deref().unwrap();
        let to = match from {
            "native-a" => "native-b",
            "native-b" => "native-c",
            "native-fork" => "native-after-fork",
            _ => panic!("unexpected identity {from}"),
        };
        Ok(freshell_agent_runtime::host_actor::DispatchAck {
            provider_ack_id: Some(format!("accepted-{to}")),
            native_identity: Some(freshell_runtime_protocol::NativeDispatchIdentity {
                previous_native_session_id: from.into(),
                native_session_id: to.into(),
                pending_naming_handle: None,
            }),
        })
    }
    async fn resolve_permission(
        &self,
        _: &str,
        _: serde_json::Value,
    ) -> Result<(), freshell_agent_runtime::host_actor::DispatchFailure> {
        unreachable!()
    }
    async fn fork(
        &self,
        _: &RequestId,
        parent: &str,
        _: Option<serde_json::Value>,
    ) -> Result<
        freshell_agent_runtime::host_actor::ForkTransition,
        freshell_agent_runtime::host_actor::DispatchFailure,
    > {
        Ok(freshell_agent_runtime::host_actor::ForkTransition {
            parent_session_id: parent.into(),
            child_session_id: if parent == "native-fork" {
                "native-c"
            } else {
                "native-fork"
            }
            .into(),
            parent_retired_by_runtime: true,
        })
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn stop(self: Arc<Self>) -> Result<(), String> {
        Ok(())
    }
    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>> {
        None
    }
}

#[tokio::test]
async fn repeated_forks_cannot_revive_a_retired_replacement_proof() {
    use freshell_agent_runtime::host_actor::{FreshAgentHostActor, FreshAgentProfile};
    let directory = tempfile::tempdir().unwrap();
    let profile: FreshAgentProfile = serde_json::from_value(serde_json::json!({
        "provider":"codex", "runtimeVariant":"codex", "cwd":directory.path(), "providerStoreId":"fork-retirement",
        "nativeSessionId":"native-a", "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    })).unwrap();
    let actor = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    for request in ["fork-proof-a-to-b", "fork-proof-b-to-c"] {
        actor
            .dispatch(RequestId::parse(request).unwrap(), "recover".into(), None)
            .await
            .unwrap();
    }
    actor
        .fork(
            RequestId::parse("fork-away").unwrap(),
            "native-c".into(),
            None,
        )
        .await
        .unwrap();
    actor
        .fork(
            RequestId::parse("fork-back").unwrap(),
            "native-fork".into(),
            None,
        )
        .await
        .unwrap();
    let proof = actor.read_events(0, 128).await.accepted_native_dispatch;
    actor.stop().await.unwrap();
    assert!(
        proof.is_none(),
        "a retired B-to-C proof cannot return when C is a fork child: {proof:?}"
    );
}

async fn two_accepted_replacements_batch() -> AgentEventBatch {
    use freshell_agent_runtime::host_actor::{FreshAgentHostActor, FreshAgentProfile};
    let directory = tempfile::tempdir().unwrap();
    let profile: FreshAgentProfile = serde_json::from_value(serde_json::json!({
        "provider":"codex", "runtimeVariant":"codex", "cwd":directory.path(), "providerStoreId":"consecutive-replacements",
        "nativeSessionId":"native-a", "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    })).unwrap();
    let actor = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    for (request, expected) in [
        ("accepted-a-to-b", "native-b"),
        ("accepted-b-to-c", "native-c"),
    ] {
        assert_eq!(
            actor
                .dispatch(RequestId::parse(request).unwrap(), "recover".into(), None)
                .await
                .unwrap(),
            freshell_runtime_protocol::CommandState::ProviderAcked
        );
        assert_eq!(
            actor.profile().await.native_session_id.as_deref(),
            Some(expected)
        );
    }
    let profile = actor.profile().await;
    actor.stop().await.unwrap();
    let reopened = FreshAgentHostActor::open(
        directory.path(),
        profile,
        Arc::new(ConsecutiveAcceptedReplacements),
    )
    .await
    .unwrap();
    let mut batch = reopened.read_events(0, 128).await;
    assert_eq!(
        batch
            .accepted_native_dispatch
            .as_ref()
            .unwrap()
            .identity
            .previous_native_session_id,
        "native-b"
    );
    assert_eq!(
        batch
            .accepted_native_dispatch
            .as_ref()
            .unwrap()
            .identity
            .native_session_id,
        "native-c"
    );
    assert!(batch
        .accepted_native_dispatch
        .as_ref()
        .unwrap()
        .prior_native_session_ids
        .contains(&"native-a".into()));
    batch.head += 1;
    batch.events.push(AgentJournalEvent {
        sequence: batch.head,
        event: status("native-c", "initial"),
    });
    reopened
        .fork(
            RequestId::parse("retire-c").unwrap(),
            "native-c".into(),
            None,
        )
        .await
        .unwrap();
    assert!(
        reopened
            .read_events(0, 128)
            .await
            .accepted_native_dispatch
            .is_none(),
        "fork retires the old replacement proof"
    );
    reopened
        .dispatch(
            RequestId::parse("replacement-after-fork").unwrap(),
            "continue".into(),
            None,
        )
        .await
        .unwrap();
    let proof = reopened
        .read_events(0, 128)
        .await
        .accepted_native_dispatch
        .unwrap();
    assert_eq!(proof.prior_native_session_ids, vec!["native-fork"]);
    reopened.stop().await.unwrap();
    batch
}

#[tokio::test]
async fn older_presentation_reconnects_after_two_accepted_actor_transitions_and_restart() {
    let batch = two_accepted_replacements_batch().await;
    let mut fixture = JournalFixture::new("native-c", "managed-public", batch).await;
    fixture
        .state
        .lock()
        .unwrap()
        .presentations
        .push("native-a".into());
    let scenario = std::panic::AssertUnwindSafe(async {
        // A new proxy represents a gateway restart after a resumed A pane was
        // displaced by two real actor-accepted transitions.
        fixture.proxy.clone().handle(attach("native-a", "codex", "native-c")).await;
        let mut frames = Vec::new();
        assert!(collect_until(&mut fixture.frames, &mut frames, |frames| frames.iter().any(|frame|
            frame["event"]["status"] == "initial" || frame["event"]["type"] == "freshAgent.error")).await, "{frames:?}");
        let announcement = frames.iter().position(|frame| frame["type"] == "freshAgent.session.materialized" && frame["sessionId"] == "native-a" && frame["sessionRef"]["sessionId"] == "native-c");
        let output = frames.iter().position(|frame| frame["event"]["status"] == "initial");
        assert!(announcement.zip(output).is_some_and(|(a, b)| a < b), "the older A pane must recover C before output: {frames:?}");
        {
            let mut state = fixture.state.lock().unwrap();
            state.batch.head += 1;
            let sequence = state.batch.head;
            state.batch.events.push(AgentJournalEvent { sequence, event:status("native-c", "later-live") });
        }
        assert!(collect_until(&mut fixture.frames, &mut frames, |frames| frames.iter().any(|frame|
            frame["sessionId"] == "native-a" && frame["event"]["status"] == "later-live")).await, "{frames:?}");
        let snapshot = fixture.proxy.snapshot(freshell_freshagent::rest_lane::RestLaneSnapshot {
            provider:"codex".into(), session_type:"freshcodex".into(), session_id:"native-a".into()
        }).await.unwrap().unwrap();
        assert_eq!(snapshot["threadId"], "native-c");
        let send = serde_json::from_value(serde_json::json!({"provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a", "text":"older-presentation-command"})).unwrap();
        fixture.proxy.clone().handle(HostedFreshAgentCommand::Send(send)).await;
        assert_eq!(fixture.state.lock().unwrap().sends, vec!["older-presentation-command"]);
    }).catch_unwind().await;
    fixture.shutdown().await;
    if let Err(panic) = scenario {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn two_replacements_preserve_exact_native_collision_after_old_attach() {
    if create_failure_trace_child("two-replacements-old-first", "fresh_agent_proxy::tests::review_repairs::two_replacements_preserve_exact_native_collision_after_old_attach") { return; }
    exact_native_collision_case(
        "managed-public",
        true,
        Some(two_accepted_replacements_batch().await),
    )
    .await;
}

#[tokio::test]
async fn two_replacements_preserve_exact_native_collision_before_old_attach() {
    if create_failure_trace_child("two-replacements-new-first", "fresh_agent_proxy::tests::review_repairs::two_replacements_preserve_exact_native_collision_before_old_attach") { return; }
    exact_native_collision_case(
        "managed-public",
        false,
        Some(two_accepted_replacements_batch().await),
    )
    .await;
}

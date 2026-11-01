use super::readiness_tests::readiness_fixture;
use super::*;
use freshell_runtime_protocol::{AgentJournalEvent, NativeIdentitySource};

const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn clear_evidence(
    launch: &freshell_runtime_protocol::NativeIdentityLaunch,
    previous: &str,
    current: &str,
    provider_digest: &str,
) -> (serde_json::Value, String) {
    use sha2::{Digest, Sha256};
    let provider = serde_json::json!({
        "launch":launch, "digest":provider_digest.repeat(64), "source":"clear",
        "queryGeneration":1, "previousNativeSessionId":previous,
    });
    // Match HostedNativeIdentity::bind_evidence, then the host observation's
    // hash of the complete binding rather than its nested provider digest.
    let bound = serde_json::json!({
        "nativeSessionId":current, "providerEvidence":provider, "launch":launch,
        "nativeClear":{"previousNativeSessionId":previous,"nativeSessionId":current},
        "queryGeneration":1,
    });
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&bound).unwrap()));
    (provider, digest)
}

async fn next_frame(receiver: &mut broadcast::Receiver<String>, kind: &str) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame: serde_json::Value =
                serde_json::from_str(&receiver.recv().await.unwrap()).unwrap();
            assert_ne!(frame["type"], "freshAgent.create.failed", "{frame}");
            if frame["type"] == kind {
                return frame;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the actual proxy did not publish {kind}"))
}

#[tokio::test]
async fn verified_clear_materializes_current_ref_and_reload_resumes_same_soul() {
    let fixture = readiness_fixture().await;
    let (proxy, mut receiver) = configure_proxy(&fixture.control_socket, HashMap::new());
    Arc::clone(&proxy).handle(HostedFreshAgentCommand::Create(serde_json::from_value(serde_json::json!({
        "provider":"claude", "requestId":"clear-parent-resume", "sessionType":"freshclaude", "cwd":fixture.workspace,
        "sessionRef":{"provider":"claude", "sessionId":PARENT},
    })).unwrap())).await;
    let created = next_frame(&mut receiver, "freshAgent.created").await;
    assert_eq!(created["sessionRef"]["sessionId"], PARENT);
    assert!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&fixture.soul)
            .unwrap()
            .materialized
    );

    // The real SDK publishes this public rekey before its next actual native
    // init. It is provisional while the authoritative root is still parent.
    fixture.events.lock().unwrap().push(AgentJournalEvent { sequence:4, event:AgentEvent::Provider { payload:serde_json::json!({
        "type":"freshAgent.session.materialized", "provider":"claude", "sessionType":"freshclaude",
        "previousSessionId":PARENT, "sessionId":CHILD,
        "sessionRef":{"provider":"claude", "sessionId":CHILD},
    }) } });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.commands.lock().unwrap().iter().any(|command|
            matches!(command, freshell_runtime_protocol::HostCommand::FreshAgentReadEvents { after_sequence, .. } if *after_sequence >= 4)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the early public rekey must not block polling its later native proof");
    while let Ok(raw) = receiver.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(
            !(frame["type"] == "freshAgent.session.materialized" && frame["sessionId"] == CHILD),
            "the provisional public UUID cannot rekey a pane by itself"
        );
    }
    let context = fixture
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let mut clear = fixture.native.lock().unwrap().1.clone();
    let (proof, observation_digest) = clear_evidence(&fixture.launch, PARENT, CHILD, "b");
    clear.source = NativeIdentitySource::ClaudeNativeClear;
    clear.native_session_id = CHILD.into();
    clear.evidence_digest = observation_digest;
    fixture
        .registry
        .transition_claude_clear_fenced(
            fixture.soul.clone(),
            fixture.launch.incarnation_id.clone(),
            PARENT,
            CHILD,
            context.write_fence(),
            clear.clone(),
        )
        .await
        .unwrap();
    *fixture.native.lock().unwrap() = (CHILD.into(), clear);
    // The authoritative clear arrives through existing Started/init frames;
    // the SDK does not repeat its materialized message after proof publication.
    fixture.events.lock().unwrap().extend([
        AgentJournalEvent { sequence:5, event:AgentEvent::Started { native_session_id:CHILD.into() } },
        AgentJournalEvent { sequence:6, event:AgentEvent::Provider { payload:serde_json::json!({
            "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":CHILD,
            "event":{"type":"freshAgent.session.init", "sessionId":CHILD, "cliSessionId":CHILD,
                "nativeIdentityEvidence":proof},
        }) } },
        AgentJournalEvent { sequence:7, event:AgentEvent::Provider { payload:serde_json::json!({
            "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":CHILD,
            "event":{"type":"freshAgent.status", "sessionId":CHILD, "status":"idle"},
        }) } },
    ]);
    let materialized = next_frame(&mut receiver, "freshAgent.session.materialized").await;
    assert_eq!(materialized["previousSessionId"], PARENT);
    assert_eq!(materialized["sessionId"], CHILD);
    assert_eq!(materialized["sessionRef"]["sessionId"], CHILD);
    assert_eq!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&fixture.soul)
            .unwrap()
            .session_id,
        CHILD
    );

    // Carry the emitted canonical ref through persisted layout and a new proxy
    // instance, so a stale in-memory alias cannot make the resume test pass.
    let layout = fixture.root.path().join("browser-session-ref.json");
    std::fs::write(
        &layout,
        serde_json::to_vec(&materialized["sessionRef"]).unwrap(),
    )
    .unwrap();
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&layout).unwrap()).unwrap();
    let (reloaded, mut reload_frames) = configure_proxy(&fixture.control_socket, HashMap::new());
    Arc::clone(&reloaded).handle(HostedFreshAgentCommand::Create(serde_json::from_value(serde_json::json!({
        "provider":"claude", "requestId":"clear-child-browser-reload", "sessionType":"freshclaude", "cwd":fixture.workspace,
        "sessionRef":persisted,
    })).unwrap())).await;
    let reattached = next_frame(&mut reload_frames, "freshAgent.created").await;
    assert_eq!(reattached["sessionId"], CHILD);
    assert_eq!(reattached["sessionRef"]["sessionId"], CHILD);
    assert_eq!(
        reloaded
            .aliases
            .lock()
            .await
            .get(&("claude".into(), CHILD.into())),
        Some(&fixture.soul)
    );
    let snapshot = reloaded
        .client
        .fresh_agent_snapshot(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(snapshot["threadId"], CHILD);
    assert_eq!(snapshot["capabilities"]["send"], true);
    Arc::clone(&reloaded).handle(HostedFreshAgentCommand::Send(serde_json::from_value(serde_json::json!({
        "provider":"claude", "sessionId":CHILD, "sessionType":"freshclaude", "requestId":"input-after-clear-reload",
        "text":"one original browser input", "cwd":fixture.workspace,
    })).unwrap())).await;
    assert_eq!(*fixture.sent_roots.lock().unwrap(), vec![CHILD.to_owned()]);
    let inventory = fixture.registry.inventory().await.unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].soul_id, fixture.soul);
    assert_eq!(inventory[0].native_session_id.as_deref(), Some(CHILD));

    // A retained old-parent materialization is still history, even after a
    // browser reload started a fresh poller at journal cursor zero.
    reloaded.forward_polled_event(&fixture.soul, AgentEvent::Provider { payload:serde_json::json!({
        "type":"freshAgent.session.materialized", "provider":"claude", "sessionType":"freshclaude",
        "previousSessionId":"older-public-parent", "sessionId":PARENT,
        "sessionRef":{"provider":"claude", "sessionId":PARENT},
    }) }, "claude", CHILD, "freshclaude", None).await;
    assert_eq!(
        reloaded
            .presentation_routes
            .lock()
            .await
            .get(&fixture.soul)
            .unwrap()
            .session_id,
        CHILD
    );
    while let Ok(raw) = reload_frames.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(
            !(frame["type"] == "freshAgent.session.materialized" && frame["sessionId"] == PARENT),
            "historical parent replay must not replace the current saved ref"
        );
    }
}

#[tokio::test]
async fn delayed_clear_events_materialize_the_latest_current_root_once() {
    const LATEST: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let fixture = readiness_fixture().await;
    let (proxy, mut receiver) = configure_proxy(&fixture.control_socket, HashMap::new());
    proxy.observe_native_session(&fixture.soul, PARENT).await;

    // A background browser can consume both inits only after two genuine
    // clears have already committed. Only the latest root remains current.
    for (previous, current, digest) in [(PARENT, CHILD, "b"), (CHILD, LATEST, "c")] {
        let context = fixture
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        let mut clear = fixture.native.lock().unwrap().1.clone();
        clear.source = NativeIdentitySource::ClaudeNativeClear;
        clear.native_session_id = current.into();
        clear.evidence_digest = clear_evidence(&fixture.launch, previous, current, digest).1;
        fixture
            .registry
            .transition_claude_clear_fenced(
                fixture.soul.clone(),
                fixture.launch.incarnation_id.clone(),
                previous,
                current,
                context.write_fence(),
                clear.clone(),
            )
            .await
            .unwrap();
        *fixture.native.lock().unwrap() = (current.into(), clear);
    }

    for (previous, current, digest) in [(PARENT, CHILD, "b"), (CHILD, LATEST, "c")] {
        proxy.forward_polled_event(&fixture.soul, AgentEvent::Provider { payload:serde_json::json!({
            "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":current,
            "event":{"type":"freshAgent.session.init", "sessionId":current, "cliSessionId":current,
                "nativeIdentityEvidence":clear_evidence(&fixture.launch, previous, current, digest).0},
        }) }, "claude", PARENT, "freshclaude", None).await;
    }

    let mut materializations = Vec::new();
    while let Ok(raw) = receiver.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if frame["type"] == "freshAgent.session.materialized" {
            materializations.push(frame);
        }
    }
    assert_eq!(materializations.len(), 1, "{materializations:?}");
    assert_eq!(materializations[0]["previousSessionId"], PARENT);
    assert_eq!(materializations[0]["sessionId"], LATEST);
    assert_eq!(materializations[0]["sessionRef"]["sessionId"], LATEST);
    assert_eq!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&fixture.soul)
            .unwrap()
            .session_id,
        LATEST
    );
}

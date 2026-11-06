//! Requester-scoped attach replies for independent browser connections.

mod common;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind};
use common::multiple_devices::{
    attach_request, create_mode, fenced_attach_request, legacy_attach_request, owner_pair_for,
    send_mode_text, ProviderFixtureEnv, ProviderMode, FRESH_AGENT_RECONCILIATION_CAPABILITY,
    PROVIDER_ENV_LOCK,
};
use serde_json::json;
use std::time::Duration;

async fn wait_for_attach_result(
    connection: &mut RigConnection,
    start: usize,
    request_id: &str,
    frame_type: &'static str,
) -> serde_json::Value {
    tokio::time::timeout(
        Duration::from_secs(10),
        connection.wait_for_since(start, "the correlated attach result", |frame| {
            frame["type"] == frame_type && frame["requestId"] == request_id
        }),
    )
    .await
    .expect("the provider's attach result settles within ten seconds")
}

async fn provider_attach_outcome_matrix(mode: ProviderMode) {
    let fixture = ProviderFixtureEnv::install();
    let prompt_gate = fixture.claude_prompt_release.to_string_lossy().to_string();
    let claude_resume_failure_path = fixture.claude_resume_failure.to_string_lossy().to_string();
    let rig = ClaudeRig::start_with_env(
        RigKind::Sim,
        &[
            ("FRESHELL_CLAUDE_SIM_HOLD_PROMPT_GATE_PATH", &prompt_gate),
            (
                "FRESHELL_CLAUDE_SIM_FAIL_RESUME_PATH",
                &claude_resume_failure_path,
            ),
        ],
    )
    .await;
    let capabilities = json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true });
    let mut desktop = rig.connect_with_capabilities(capabilities.clone()).await;
    let mut mobile = rig.connect_with_capabilities(capabilities).await;
    let request_id = format!("matrix-create-{}", mode.session_type());
    let created_session = create_mode(&mut desktop, mode, &request_id).await;

    // OpenCode deliberately creates a lazy placeholder. Its first send is the
    // native session boot, so use the canonical ID from the materialization event
    // for every subsequent fence and attach.
    let mut session_id = created_session.clone();
    let desktop_start = desktop.frames.len();
    send_mode_text(
        &mut desktop,
        mode,
        &created_session,
        "matrix-stream-send",
        "SLOW",
    )
    .await;
    if mode == ProviderMode::Freshclaude || mode == ProviderMode::Kilroy {
        desktop
            .wait_for_since(
                desktop_start,
                "the simulator's first live text chunk",
                |frame| {
                    frame["type"] == "freshAgent.event"
                        && frame["sessionId"] == created_session
                        && frame["event"]["type"] == "freshAgent.stream"
                },
            )
            .await;
    } else if mode == ProviderMode::Freshcodex {
        let send_answer = desktop
            .wait_for_since(desktop_start, "Codex send acceptance or refusal", |frame| {
                frame["type"] == "freshAgent.send.accepted"
                    || frame["type"] == "error"
                    || (frame["type"] == "freshAgent.event"
                        && frame["event"]["type"] == "freshAgent.error")
            })
            .await;
        assert_eq!(
            send_answer["type"], "freshAgent.send.accepted",
            "Codex send failed: {send_answer}"
        );
        fixture
            .wait_for_jsonl(&fixture.codex_turn_audit, "Codex turn/start", |row| {
                row["method"] == "turn/start"
            })
            .await;
    } else {
        let send_answer = desktop
            .wait_for_since(
                desktop_start,
                "OpenCode send acceptance or refusal",
                |frame| {
                    frame["type"] == "freshAgent.send.accepted"
                        || frame["type"] == "error"
                        || (frame["type"] == "freshAgent.event"
                            && frame["event"]["type"] == "freshAgent.error")
                },
            )
            .await;
        assert_eq!(
            send_answer["type"], "freshAgent.send.accepted",
            "OpenCode send failed: {send_answer}"
        );
        let row = fixture
            .wait_for_jsonl(&fixture.opencode_audit, "OpenCode prompt_async", |row| {
                row["method"] == "POST"
                    && row["path"]
                        .as_str()
                        .is_some_and(|p| p.ends_with("/prompt_async"))
            })
            .await;
        assert_eq!(row["path"], "/session/ses_multidevice/prompt_async");
        fixture
            .wait_for_jsonl(
                &fixture.opencode_events,
                "OpenCode observed busy activity",
                |row| row["kind"] == "activity" && row["data"]["status"] == "busy",
            )
            .await;
        let materialized = desktop
            .wait_for_since(
                desktop_start,
                "OpenCode's canonical materialized id",
                |frame| {
                    frame["type"] == "freshAgent.session.materialized"
                        && frame["previousSessionId"] == created_session
                },
            )
            .await;
        session_id = materialized["sessionId"]
            .as_str()
            .expect("materialized event has a canonical id")
            .to_string();
    }

    // Both authenticated sockets observe the current fence before mobile attaches.
    mobile.read_for(Duration::from_millis(100)).await;
    let current_fence = owner_pair_for(&mobile, mode.provider(), &session_id);
    if mode != ProviderMode::Freshopencode {
        assert!(
            current_fence.is_some(),
            "{} create publishes owner facts",
            mode.session_type()
        );
    }
    let peer_start = desktop.frames.len();
    let result_start = mobile.frames.len();
    let running_request = format!("matrix-running-{}", mode.session_type());
    mobile
        .send(fenced_attach_request(
            mode,
            &session_id,
            "mobile-view",
            &running_request,
            current_fence,
        ))
        .await;
    let running = wait_for_attach_result(
        &mut mobile,
        result_start,
        &running_request,
        "freshAgent.attached",
    )
    .await;
    assert_eq!(running["viewId"], "mobile-view");
    assert_eq!(
        running["status"],
        "running",
        "{}: {running}",
        mode.session_type()
    );
    assert_eq!(running["snapshot"]["status"], "running");
    mobile.read_for(Duration::from_millis(100)).await;
    assert_eq!(
        mobile.frames[result_start..]
            .iter()
            .filter(|frame| frame["type"] == "freshAgent.attached"
                && frame["requestId"] == running_request)
            .count(),
        1,
        "one running attach has one requester result"
    );
    assert!(
        desktop.frames[peer_start..].iter().all(|frame| {
            frame["type"] != "freshAgent.attached"
                && frame["type"] != "freshAgent.attach.failed"
                && !(frame["type"] == "freshAgent.event"
                    && frame["sessionId"] == session_id
                    && matches!(
                        frame["event"]["type"].as_str(),
                        Some("freshAgent.session.snapshot" | "freshAgent.error")
                    ))
        }),
        "the desktop peer never receives the mobile attach result/snapshot"
    );

    // Release the provider's held turn only after the second view got its
    // requester-scoped snapshot. Both views then observe its shared completion.
    match mode {
        ProviderMode::Freshclaude | ProviderMode::Kilroy => {
            fixture.release(&fixture.claude_prompt_release)
        }
        ProviderMode::Freshcodex => fixture.release(&fixture.codex_turn_release),
        ProviderMode::Freshopencode => {
            fixture.release(&fixture.opencode_release);
            fixture
                .wait_for_jsonl(
                    &fixture.opencode_events,
                    "OpenCode turn completion",
                    |row| row["kind"] == "completion",
                )
                .await;
        }
    }
    for view in [&mut desktop, &mut mobile] {
        view.wait_for_since(0, "shared completion after the attach", |frame| {
            frame["type"] == "freshAgent.event"
                && frame["sessionId"] == session_id
                && frame["event"]["type"] == "freshAgent.turn.complete"
        })
        .await;
    }

    // The settled runtime now has an idle snapshot, still requester-scoped.
    mobile.read_for(Duration::from_millis(50)).await;
    let idle_start = mobile.frames.len();
    let idle_request = format!("matrix-idle-{}", mode.session_type());
    mobile
        .send(fenced_attach_request(
            mode,
            &session_id,
            "mobile-view",
            &idle_request,
            owner_pair_for(&mobile, mode.provider(), &session_id),
        ))
        .await;
    let idle = wait_for_attach_result(
        &mut mobile,
        idle_start,
        &idle_request,
        "freshAgent.attached",
    )
    .await;
    assert_eq!(idle["status"], "idle", "{}: {idle}", mode.session_type());

    // Unknown-session/lost, malformed-fence, stale-authority, and reserved
    // failures each settle mobile without mutating the desktop peer.
    let unknown_start = mobile.frames.len();
    let unknown_request = format!("matrix-unknown-{}", mode.session_type());
    mobile
        .send(fenced_attach_request(
            mode,
            "session-does-not-exist",
            "mobile-view",
            &unknown_request,
            None,
        ))
        .await;
    let unknown = wait_for_attach_result(
        &mut mobile,
        unknown_start,
        &unknown_request,
        "freshAgent.attach.failed",
    )
    .await;
    assert_eq!(
        unknown["code"],
        "INVALID_SESSION_ID",
        "{}: {unknown}",
        mode.session_type()
    );

    let malformed_start = mobile.frames.len();
    let malformed_request = format!("matrix-malformed-{}", mode.session_type());
    let mut malformed =
        fenced_attach_request(mode, &session_id, "mobile-view", &malformed_request, None);
    malformed["observedEpoch"] = json!(rig.ownership.boot_epoch());
    mobile.send(malformed).await;
    let malformed = wait_for_attach_result(
        &mut mobile,
        malformed_start,
        &malformed_request,
        "freshAgent.attach.failed",
    )
    .await;
    assert_eq!(malformed["code"], "INVALID_FENCE");

    let stale_start = mobile.frames.len();
    let stale_request = format!("matrix-stale-{}", mode.session_type());
    let stale_pair = current_fence
        .map(|(_, generation)| (rig.ownership.boot_epoch().saturating_sub(1), generation));
    mobile
        .send(fenced_attach_request(
            mode,
            &session_id,
            "mobile-view",
            &stale_request,
            stale_pair,
        ))
        .await;
    let stale = wait_for_attach_result(
        &mut mobile,
        stale_start,
        &stale_request,
        "freshAgent.attach.failed",
    )
    .await;
    assert_ne!(
        stale["code"], "INVALID_SESSION_ID",
        "stale ownership is not a lost session"
    );
    assert_ne!(
        stale["code"], "INVALID_FENCE",
        "a well-formed stale pair is a distinct failure"
    );

    let transient_start = mobile.frames.len();
    let transient_request = format!("matrix-transient-{}", mode.session_type());
    let transient_session_id = if mode == ProviderMode::Freshclaude || mode == ProviderMode::Kilroy
    {
        fixture.release(&fixture.claude_resume_failure);
        rig.kill_first_sidecar(&mut desktop).await;
        session_id.as_str()
    } else {
        mode.attach_failure_session_id()
    };
    mobile
        .send(fenced_attach_request(
            mode,
            transient_session_id,
            "mobile-view",
            &transient_request,
            None,
        ))
        .await;
    let transient = wait_for_attach_result(
        &mut mobile,
        transient_start,
        &transient_request,
        "freshAgent.attach.failed",
    )
    .await;
    assert_ne!(
        transient["code"],
        "INVALID_SESSION_ID",
        "{} transient provider failures must not be classified as missing sessions: {transient}",
        mode.session_type()
    );
    assert_ne!(
        transient["code"],
        "SESSION_RESERVED",
        "{} transient provider failures are distinct from reservation: {transient}",
        mode.session_type()
    );
    let expected_transient_code = match mode {
        ProviderMode::Freshclaude | ProviderMode::Kilroy => "CLAUDE_ATTACH_RESUME_FAILED",
        ProviderMode::Freshcodex => "CODEX_ATTACH_RESUME_FAILED",
        ProviderMode::Freshopencode => "OPENCODE_ATTACH_RESUME_FAILED",
    };
    if mode == ProviderMode::Freshclaude || mode == ProviderMode::Kilroy {
        assert_eq!(transient["code"], expected_transient_code, "{transient}");
    } else {
        assert_eq!(transient["code"], "INTERNAL_ERROR", "{transient}");
        assert!(
            transient["message"]
                .as_str()
                .is_some_and(|message| message.contains(expected_transient_code)),
            "{} preserves its provider failure identity in the requester outcome: {transient}",
            mode.session_type()
        );
    }

    let freshell_ownership::BeginOutcome::Granted { .. } = rig.ownership.begin_handoff(
        mode.provider(),
        &session_id,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        &format!("matrix-reserved-{}", mode.session_type()),
        None,
        "multiple-devices-test",
        1,
    ) else {
        panic!(
            "the live {} runtime must be reservable for the refusal case",
            mode.session_type()
        );
    };
    let reserved_start = mobile.frames.len();
    let reserved_request = format!("matrix-reserved-{}", mode.session_type());
    mobile
        .send(fenced_attach_request(
            mode,
            &session_id,
            "mobile-view",
            &reserved_request,
            current_fence,
        ))
        .await;
    let reserved = wait_for_attach_result(
        &mut mobile,
        reserved_start,
        &reserved_request,
        "freshAgent.attach.failed",
    )
    .await;
    assert_eq!(
        reserved["code"],
        "SESSION_RESERVED",
        "{}: {reserved}",
        mode.session_type()
    );

    desktop.read_for(Duration::from_millis(100)).await;
    assert!(
        desktop.frames.iter().all(|frame| {
            !(frame["type"] == "freshAgent.attach.failed"
                && frame["requestId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("matrix-")))
        }),
        "provider attach failures remain requester-scoped"
    );

    let (boots, submits, decisions) = match mode {
        ProviderMode::Freshclaude | ProviderMode::Kilroy => (
            rig.ledger_rows("boot")
                .iter()
                .filter(|row| row["sessionId"] == created_session)
                .count(),
            rig.ledger_rows("prompt")
                .iter()
                .filter(|row| row["sessionId"] == created_session)
                .count(),
            rig.ledger_rows("can_use_tool")
                .iter()
                .filter(|row| row["sessionId"] == created_session)
                .count(),
        ),
        ProviderMode::Freshcodex => (
            fixture.jsonl_count(&fixture.codex_audit, |row| row["method"] == "thread/start"),
            fixture.jsonl_count(&fixture.codex_turn_audit, |row| {
                row["method"] == "turn/start"
            }),
            fixture.jsonl_count(&fixture.codex_audit, |row| {
                row["method"] == "item/tool/requestUserInput"
            }),
        ),
        ProviderMode::Freshopencode => (
            fixture.jsonl_count(&fixture.opencode_launch_audit, |row| {
                row["provider"] == "opencode-server"
            }),
            fixture.jsonl_count(&fixture.opencode_audit, |row| {
                row["method"] == "POST"
                    && row["path"]
                        .as_str()
                        .is_some_and(|p| p.ends_with("/prompt_async"))
            }),
            0,
        ),
    };
    assert_eq!(
        boots,
        1,
        "{} starts one native runtime",
        mode.session_type()
    );
    assert_eq!(
        submits,
        1,
        "{} submits one held native turn",
        mode.session_type()
    );
    eprintln!(
        "{}",
        json!({
            "severity": "info",
            "event": "freshagent.multiple_devices.provider_audit",
            "provider": mode.provider(),
            "sessionType": mode.session_type(),
            "selectedOutcomeCases": 7,
            "executedOutcomeCases": 7,
            "nativeBootCalls": boots,
            "nativeSubmitCalls": submits,
            "nativeDecisionCalls": decisions,
        })
    );
    rig.fresh_codex.shutdown().await;
    rig.fresh_opencode.shutdown().await;
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_device_attach_outcomes_cover_freshclaude_provider_gate() {
    let _env = PROVIDER_ENV_LOCK.lock().await;
    provider_attach_outcome_matrix(ProviderMode::Freshclaude).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_device_attach_outcomes_cover_kilroy_provider_gate() {
    let _env = PROVIDER_ENV_LOCK.lock().await;
    provider_attach_outcome_matrix(ProviderMode::Kilroy).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_device_attach_outcomes_cover_codex_provider_gate() {
    let _env = PROVIDER_ENV_LOCK.lock().await;
    provider_attach_outcome_matrix(ProviderMode::Freshcodex).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_device_attach_outcomes_cover_opencode_provider_gate() {
    let _env = PROVIDER_ENV_LOCK.lock().await;
    provider_attach_outcome_matrix(ProviderMode::Freshopencode).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_authenticated_cli_views_join_one_running_claude_runtime() {
    let rig = ClaudeRig::start(RigKind::Cli).await;
    let capabilities = json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true });
    let mut desktop = rig.connect_with_capabilities(capabilities.clone()).await;
    let mut mobile = rig.connect_with_capabilities(capabilities).await;
    let session_id = create_mode(
        &mut desktop,
        ProviderMode::Freshclaude,
        "cli-multi-device-create",
    )
    .await;
    assert!(rig.fresh_claude.has_live_session(&session_id).await);

    let send_start = desktop.frames.len();
    send_mode_text(
        &mut desktop,
        ProviderMode::Freshclaude,
        &session_id,
        "cli-multi-device-hang",
        "HANG",
    )
    .await;
    let accepted = desktop
        .wait_for_since(
            send_start,
            "the real CLI provider accepted the submitted turn",
            |frame| {
                frame["type"] == "freshAgent.send.accepted"
                    && frame["requestId"] == "cli-multi-device-hang"
            },
        )
        .await;
    assert_eq!(accepted["sessionId"], session_id);

    mobile.read_for(Duration::from_millis(100)).await;
    let fence = owner_pair_for(&mobile, "claude", &session_id);
    assert!(
        fence.is_some(),
        "the real CLI runtime publishes its owner fence"
    );
    let peer_start = desktop.frames.len();
    let attach_start = mobile.frames.len();
    mobile
        .send(fenced_attach_request(
            ProviderMode::Freshclaude,
            &session_id,
            "cli-mobile-view",
            "cli-multi-device-attach",
            fence,
        ))
        .await;
    let attached = wait_for_attach_result(
        &mut mobile,
        attach_start,
        "cli-multi-device-attach",
        "freshAgent.attached",
    )
    .await;
    assert_eq!(attached["status"], "running");
    assert_eq!(attached["snapshot"]["status"], "running");
    desktop.read_for(Duration::from_millis(100)).await;
    assert!(
        desktop.frames[peer_start..].iter().all(|frame| {
            frame["type"] != "freshAgent.attached"
                && frame["type"] != "freshAgent.attach.failed"
                && !(frame["type"] == "freshAgent.event"
                    && frame["sessionId"] == session_id
                    && frame["event"]["type"] == "freshAgent.session.snapshot")
        }),
        "the first real-CLI observer never receives the second observer's snapshot"
    );

    desktop
        .send(json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
        }))
        .await;
    for view in [&mut desktop, &mut mobile] {
        view.wait_for_since(0, "shared completion after the real-CLI attach", |frame| {
            frame["type"] == "freshAgent.event"
                && frame["sessionId"] == session_id
                && frame["event"]["type"] == "freshAgent.result"
        })
        .await;
    }
    assert!(rig.fresh_claude.has_live_session(&session_id).await);
    eprintln!(
        "{}",
        json!({
            "severity": "info",
            "event": "freshagent.multiple_devices.provider_audit",
            "provider": "claude",
            "sessionType": "freshclaude",
            "rig": "Cli",
            "selectedOutcomeCases": 1,
            "executedOutcomeCases": 1,
            "nativeBootCalls": 1,
            "nativeSubmitCalls": 1,
            "nativeDecisionCalls": 0,
        })
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_recovery_failure_is_reused_by_concurrent_attach_views() {
    let failure_gate = tempfile::tempdir().expect("create recovery failure gate");
    let failure_path = failure_gate.path().join("fail-resume");
    let failure_path_string = failure_path.to_string_lossy().to_string();
    let mut rig = ClaudeRig::start_with_env(
        RigKind::Sim,
        &[("FRESHELL_CLAUDE_SIM_FAIL_RESUME_PATH", &failure_path_string)],
    )
    .await;
    let capabilities = json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true });
    let mut seeder = rig.connect().await;
    let session_id = create_mode(
        &mut seeder,
        ProviderMode::Freshclaude,
        "shared-recovery-seed",
    )
    .await;
    let seed_start = seeder.frames.len();
    send_mode_text(
        &mut seeder,
        ProviderMode::Freshclaude,
        &session_id,
        "shared-recovery-seed-turn",
        "Persist one turn before recovery",
    )
    .await;
    seeder
        .wait_for_since(seed_start, "the seeded transcript turn", |frame| {
            frame["type"] == "freshAgent.event"
                && frame["sessionId"] == session_id
                && frame["event"]["type"] == "freshAgent.result"
        })
        .await;

    // Recover from the same durable transcript after a server restart. Both
    // devices begin without an in-memory session and must join one provider
    // recovery operation for this locator.
    rig.restart().await;
    std::fs::write(&failure_path, "fail the next resume")
        .expect("arm the provider's transient recovery failure");
    let mut desktop = rig.connect_with_capabilities(capabilities.clone()).await;
    let mut mobile = rig.connect_with_capabilities(capabilities).await;
    let desktop_start = desktop.frames.len();
    let mobile_start = mobile.frames.len();
    let desktop_request = "shared-recovery-desktop";
    let mobile_request = "shared-recovery-mobile";

    tokio::join!(
        desktop.send(attach_request(
            "claude",
            "freshclaude",
            &session_id,
            "desktop-recovery-view",
            desktop_request,
        )),
        mobile.send(attach_request(
            "claude",
            "freshclaude",
            &session_id,
            "mobile-recovery-view",
            mobile_request,
        )),
    );

    let (desktop_result, mobile_result) = tokio::join!(
        wait_for_attach_result(
            &mut desktop,
            desktop_start,
            desktop_request,
            "freshAgent.attach.failed",
        ),
        wait_for_attach_result(
            &mut mobile,
            mobile_start,
            mobile_request,
            "freshAgent.attach.failed",
        ),
    );
    for (result, request_id, view_id) in [
        (&desktop_result, desktop_request, "desktop-recovery-view"),
        (&mobile_result, mobile_request, "mobile-recovery-view"),
    ] {
        assert_eq!(result["requestId"], request_id);
        assert_eq!(result["viewId"], view_id);
        assert_eq!(result["sessionId"], session_id);
    }

    let failed_resume_attempts = rig
        .ledger_rows("resume_failure")
        .into_iter()
        .filter(|row| row["sessionId"] == session_id)
        .count();
    assert_eq!(
        failed_resume_attempts,
        1,
        "both view failures must reuse one failed provider resume operation; \
         desktop={desktop_result}, mobile={mobile_result}, \
         ledger={:?}",
        rig.ledger_rows("query")
    );
    eprintln!(
        "{}",
        json!({
            "severity": "info",
            "event": "freshagent.multiple_devices.shared_recovery_failure",
            "provider": "claude",
            "selectedCases": 1,
            "executedCases": 1,
            "requesterResults": 2,
            "failedNativeLaunches": failed_resume_attempts,
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_requester_isolation() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig
        .connect_with_capabilities(json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true }))
        .await;
    let created = first
        .request_create(
            "create-multiple-device-attach",
            json!({"viewId":"desktop-view"}),
        )
        .await;
    assert_eq!(created["type"], "freshAgent.created");
    assert_eq!(created["viewId"], "desktop-view");
    let session = created["sessionId"]
        .as_str()
        .expect("create response includes the session id")
        .to_string();
    let mut second = rig
        .connect_with_capabilities(json!({ (FRESH_AGENT_RECONCILIATION_CAPABILITY): true }))
        .await;

    first
        .send_text(&session, "held-multiple-device-turn", "HANG")
        .await;
    first.wait_for_event("freshAgent.stream").await;

    let peer_start = first.frames.len();
    let reply_start = second.frames.len();
    second
        .send(attach_request(
            "claude",
            "freshclaude",
            &session,
            "mobile-view",
            "mobile-attach-1",
        ))
        .await;
    let attached = second
        .wait_for_since(reply_start, "the correlated attach result", |frame| {
            frame["type"] == "freshAgent.attached"
                && frame["requestId"] == "mobile-attach-1"
                && frame["viewId"] == "mobile-view"
        })
        .await;
    assert_eq!(attached["status"], "running");
    assert_eq!(attached["snapshot"]["type"], "freshAgent.session.snapshot");
    assert_eq!(attached["snapshot"]["status"], "running");
    second.read_for(Duration::from_millis(100)).await;
    assert_eq!(
        second.frames[reply_start..]
            .iter()
            .filter(|frame| frame["type"] == "freshAgent.attached")
            .count(),
        1,
        "one attach request must settle exactly once"
    );

    first.read_for(Duration::from_millis(100)).await;
    assert!(
        !first.frames[peer_start..].iter().any(|frame| {
            frame["type"] == "freshAgent.attached"
                || (frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.snapshot")
        }),
        "the first view must not receive the second view's attach snapshot"
    );

    let failure_start = second.frames.len();
    second
        .send(json!({
            "type": "freshAgent.attach",
            "requestId": "mobile-attach-invalid-fence",
            "viewId": "mobile-view",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
            "sessionRef": { "provider": "claude", "sessionId": session },
            "observedEpoch": 7,
        }))
        .await;
    let failed = second
        .wait_for_since(failure_start, "typed requester attach failure", |frame| {
            frame["type"] == "freshAgent.attach.failed"
                && frame["requestId"] == "mobile-attach-invalid-fence"
        })
        .await;
    assert_eq!(failed["code"], "INVALID_FENCE");
    first.read_for(Duration::from_millis(100)).await;
    assert!(!first.frames[peer_start..].iter().any(|frame| {
        frame["type"] == "freshAgent.attach.failed"
            || (frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "INVALID_FENCE")
    }));

    first
        .send(json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
        }))
        .await;
    first.wait_for_event("freshAgent.result").await;
    second.wait_for_event("freshAgent.result").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_attach_keeps_event_shape_on_its_requester_only() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig.connect().await;
    let session = first.create("legacy-multiple-device-attach").await;
    let mut second = rig.connect().await;

    first
        .send_text(&session, "held-legacy-attach-turn", "HANG")
        .await;
    first.wait_for_event("freshAgent.stream").await;

    let peer_start = first.frames.len();
    let requester_start = second.frames.len();
    second
        .send(legacy_attach_request(
            "claude",
            "freshclaude",
            &session,
            "legacy-mobile-view",
        ))
        .await;
    let snapshot = second
        .wait_for_since(
            requester_start,
            "legacy event-shaped attach snapshot",
            |frame| {
                frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.snapshot"
                    && frame["sessionId"] == session
            },
        )
        .await;
    assert_eq!(snapshot["event"]["status"], "running");
    second.read_for(Duration::from_millis(100)).await;
    assert!(
        !second.frames[requester_start..]
            .iter()
            .any(|frame| frame["type"] == "freshAgent.attached"),
        "an unnegotiated request without requestId keeps the prior event-shaped protocol"
    );

    first.read_for(Duration::from_millis(100)).await;
    assert!(
        !first.frames[peer_start..].iter().any(|frame| {
            frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.session.snapshot"
                && frame["sessionId"] == session
        }),
        "the legacy attach snapshot is requester-scoped even though its wire shape is old"
    );

    let unnegotiated_start = second.frames.len();
    second
        .send(json!({
            "type": "freshAgent.attach",
            "requestId": "legacy-client-attach-request-id",
            "viewId": "legacy-mobile-view",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
            "sessionRef": { "provider": "claude", "sessionId": session },
        }))
        .await;
    second
        .wait_for_since(
            unnegotiated_start,
            "unnegotiated event-shaped compatibility snapshot",
            |frame| {
                frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.snapshot"
                    && frame["sessionId"] == session
            },
        )
        .await;
    second.read_for(Duration::from_millis(100)).await;
    assert!(!second.frames[unnegotiated_start..].iter().any(|frame| {
        matches!(
            frame["type"].as_str(),
            Some("freshAgent.attached" | "freshAgent.attach.failed")
        )
    }));

    first
        .send(json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session,
        }))
        .await;
    first.wait_for_event("freshAgent.result").await;
    second.wait_for_event("freshAgent.result").await;
}

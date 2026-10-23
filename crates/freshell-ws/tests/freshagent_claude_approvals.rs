//! Claude approvals with the CLI's own permission suggestions (client-alerts
//! plan G20), end to end over the REAL claude sidecar and the CLI simulator
//! (RealSidecarSim, `common::claude_rig`), a real freshell-ws server, its
//! snapshot REST route and a WS client.
//!
//! - The approval's suggestions reach the snapshot the card renders from,
//!   normalized to the strict contract shape.
//! - "Allow and don't ask again" sends them back as `updatedPermissions`, and
//!   the CLI receives exactly that decision; a malformed list is refused with
//!   `INVALID_APPROVAL_DECISION`, nothing reaches the CLI and the card stays.
//! - A permission mode the CLI moves to by itself (an accepted `setMode`) is
//!   the session's mode from then on, across a server restart too.

mod common;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};

const APPROVAL_PROMPT: &str = "run the tests";

/// The CLI's suggestions for `npm test`, plus one no client could parse.
fn offered_suggestions() -> Value {
    json!([
        { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test *" }],
          "behavior": "allow", "destination": "localSettings" },
        { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
        { "type": "grantEverything", "destination": "session" },
    ])
}

/// What the snapshot states: the well-formed suggestions only.
fn normalized_suggestions() -> Value {
    json!([
        { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test *" }],
          "behavior": "allow", "destination": "localSettings" },
        { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
    ])
}

async fn approvals_rig() -> ClaudeRig {
    let program = json!({ "rules": [
        { "on": "msg:prompt", "match": { "text": APPROVAL_PROMPT }, "emit": [
            { "kind": "approval", "data": {
                "tool": "Bash", "input": { "command": "npm test" },
                "suggestions": offered_suggestions(),
            } },
            { "kind": "text", "data": { "text": "tests ran" } },
        ] },
    ] })
    .to_string();
    ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            env: vec![("FRESHELL_CLAUDE_SIM_PROGRAM".into(), program)],
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await
}

/// Create a session in `default` mode (where the CLI asks before a Bash call)
/// and raise the approval; returns (pane id, durable id, request id).
async fn raise_approval(conn: &mut RigConnection) -> (String, String, Value) {
    let created = conn
        .request_create("approvals", json!({ "permissionMode": "default" }))
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let pane = created["sessionId"].as_str().unwrap().to_string();
    conn.send_text(&pane, "send-approval", APPROVAL_PROMPT)
        .await;
    let request = conn.wait_for_event("freshAgent.permission.request").await;
    let durable = conn.init_session_id(&pane);
    (pane, durable, request["event"]["requestId"].clone())
}

fn respond(pane: &str, request_id: &Value, decision: Value) -> Value {
    json!({
        "type": "freshAgent.approval.respond",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": pane,
        "requestId": request_id,
        "decision": decision,
    })
}

/// Poll the snapshot route until `ready` holds.
async fn snapshot_when(
    rig: &ClaudeRig,
    thread_id: &str,
    what: &str,
    ready: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let (status, snapshot) = rig.snapshot(thread_id).await;
        if status == 200 && ready(&snapshot) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the snapshot never showed {what}; last answer {status}: {snapshot}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// What the simulated CLI's canUseTool resolved with, in order.
fn cli_decisions(rig: &ClaudeRig) -> Vec<Value> {
    rig.ledger_rows("can_use_tool")
        .into_iter()
        .map(|row| row["decision"].clone())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remembered_approval_sends_the_clis_suggestions_and_a_malformed_list_is_refused() {
    let rig = approvals_rig().await;
    let mut conn = rig.connect().await;
    let (pane, durable, request_id) = raise_approval(&mut conn).await;

    let pending = snapshot_when(&rig, &durable, "the pending approval", |snapshot| {
        snapshot["pendingApprovals"]
            .as_array()
            .is_some_and(|list| !list.is_empty())
    })
    .await;
    assert_eq!(
        pending["pendingApprovals"][0]["suggestions"],
        normalized_suggestions()
    );

    // A malformed list: refused, nothing reaches the CLI, the card stays.
    conn.send(respond(
        &pane,
        &request_id,
        json!({ "behavior": "allow", "updatedPermissions": offered_suggestions() }),
    ))
    .await;
    let refusal = conn.wait_for_event("freshAgent.error").await;
    assert_eq!(refusal["event"]["code"], "INVALID_APPROVAL_DECISION");
    let (_, still) = rig.snapshot(&durable).await;
    assert_eq!(
        still["pendingApprovals"][0]["requestId"], request_id,
        "{still}"
    );
    assert!(cli_decisions(&rig).is_empty());

    // The suggestions as the card has them: the CLI gets exactly this decision.
    let decision = json!({
        "behavior": "allow",
        "updatedPermissions": pending["pendingApprovals"][0]["suggestions"],
    });
    conn.send(respond(&pane, &request_id, decision.clone()))
        .await;
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while cli_decisions(&rig).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the CLI never got the decision"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(cli_decisions(&rig), vec![decision]);
    // The accepted setMode moves the CLI to acceptEdits; every client hears it.
    conn.wait_for("the CLI's own mode change", |frame| {
        frame["sessionId"] == pane.as_str()
            && frame["event"]["type"] == "freshAgent.session.metadata"
            && frame["event"]["permissionMode"] == "acceptEdits"
    })
    .await;
    snapshot_when(&rig, &durable, "the approval answered", |snapshot| {
        snapshot["pendingApprovals"] == json!([])
            && snapshot["settings"]["permissionMode"] == "acceptEdits"
    })
    .await;
    conn.kill(&pane).await;
}

/// The mode the CLI moved to by itself is saved with the session: after a
/// server restart the pane's attach resumes the conversation in that mode,
/// not in the mode the pane created it with.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mode_the_cli_moved_to_is_the_mode_a_resume_boots_in() {
    let mut rig = approvals_rig().await;
    let mut conn = rig.connect().await;
    let (pane, durable, request_id) = raise_approval(&mut conn).await;
    conn.send(respond(
        &pane,
        &request_id,
        json!({ "behavior": "allow", "updatedPermissions": normalized_suggestions() }),
    ))
    .await;
    conn.wait_for("the CLI's own mode change", |frame| {
        frame["sessionId"] == pane.as_str()
            && frame["event"]["type"] == "freshAgent.session.metadata"
            && frame["event"]["permissionMode"] == "acceptEdits"
    })
    .await;
    conn.wait_for_event("freshAgent.result").await;
    rig.wait_for_transcript(&durable).await;
    drop(conn);

    rig.restart().await;
    let mut conn = rig.connect().await;
    conn.attach(&durable).await;
    let boots: Vec<Value> = rig
        .ledger_rows("query")
        .into_iter()
        .map(|row| row["options"].clone())
        .collect();
    assert_eq!(
        boots.len(),
        2,
        "the create's boot and the resume's: {boots:?}"
    );
    assert_eq!(boots[0]["permissionMode"], "default", "{:?}", boots[0]);
    assert_eq!(boots[1]["resume"], durable.as_str(), "{:?}", boots[1]);
    assert_eq!(boots[1]["permissionMode"], "acceptEdits", "{:?}", boots[1]);
    conn.kill(&durable).await;
}

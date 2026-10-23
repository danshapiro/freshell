//! G15 (core-runtime design §4.9, C11): every claude sidecar launch hands the CLI
//! the pane's plugins and, in a hosted lane, the hosted Freshell MCP.
//!
//! Four launches start a sidecar for a session: the create, an attach that resumes
//! an untracked session (a reload after the sidecar died, or after a restart), a
//! handoff that resumes it as a fresh agent, and a rollback (undo/redo) respawn.
//! Each test runs one of them on the real sidecar over the CLI simulator
//! (RealSidecarSim), whose ledger records the options each `query()` call
//! received, and checks those options.
//!
//! The rig runs the claude lane the hosted way (the lane selects the hosted MCP and
//! the sidecar runs as hosted claude, so `hostedMcp: true` becomes the fixed
//! `freshell` MCP server) over a real pane ledger, so the create's plugins land in
//! the session's binding row and the resumes read them back from there.

mod common;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};

async fn hosted_rig() -> (ClaudeRig, String) {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            hosted_claude: true,
            handoff: true,
            ..RigOptions::default()
        },
    )
    .await;
    let plugin = rig.workspace.join(".claude/plugins/review");
    std::fs::create_dir_all(&plugin).expect("create the plugin directory");
    let plugin = plugin.to_str().expect("utf-8 path").to_string();
    (rig, plugin)
}

/// Create a session with `plugin`; returns the session id `created` named.
async fn create_with_plugin(conn: &mut RigConnection, plugin: &str) -> String {
    let created = conn
        .request_create("create-1", json!({ "plugins": [plugin] }))
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    created["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string()
}

/// One finished turn per prompt (each `freshAgent.result`), so the conversation is
/// on disk; returns the durable id the first turn reported.
async fn converse(
    rig: &ClaudeRig,
    conn: &mut RigConnection,
    session_id: &str,
    prompts: &[&str],
) -> String {
    for (n, prompt) in prompts.iter().enumerate() {
        let results_before = conn.events_seen("freshAgent.result");
        conn.send_text(session_id, &format!("send-{n}"), prompt)
            .await;
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        while conn.events_seen("freshAgent.result") == results_before {
            assert!(
                tokio::time::Instant::now() < deadline,
                "turn {n} never finished"
            );
            conn.read_for(std::time::Duration::from_millis(50)).await;
        }
    }
    rig.wait_for_transcripts().await;
    conn.frames
        .iter()
        .find_map(|v| {
            (v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.session.init"
                && v["event"]["sessionId"] == session_id)
                .then(|| v["event"]["cliSessionId"].as_str().map(str::to_string))
                .flatten()
        })
        .expect("the first turn reported the durable id")
}

/// The session's sidecar dies on its own (SIGKILL of the Node process): the session
/// is untracked, the state a reload or a handoff resumes from.
async fn kill_the_sidecar(rig: &ClaudeRig, conn: &mut RigConnection) {
    let pid = rig.ledger_rows("boot")[0]["pid"]
        .as_i64()
        .expect("the boot row names the sidecar's pid") as i32;
    // SAFETY: a plain signal to the sidecar this rig spawned.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    conn.wait_for("the sidecar's exit", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.error"
            && v["event"]["code"] == "SIDECAR_EXITED"
    })
    .await;
}

/// The options of the `query()` calls the simulator recorded, in order.
fn query_options(rig: &ClaudeRig) -> Vec<Value> {
    rig.ledger_rows("query")
        .into_iter()
        .map(|row| row["options"].clone())
        .collect()
}

/// The first recorded `query()` options matching `predicate`, once recorded.
async fn wait_for_query(rig: &ClaudeRig, what: &str, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        if let Some(options) = query_options(rig).into_iter().find(|o| predicate(o)) {
            return options;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no query() call for {what}; recorded: {:?}",
            query_options(rig)
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

fn assert_carries_plugin_and_hosted_mcp(options: &Value, plugin: &str, launch: &str) {
    assert_eq!(
        options["plugins"],
        json!([{ "type": "local", "path": plugin }]),
        "the {launch} hands the CLI the pane's plugins: {options}"
    );
    assert!(
        options["mcpServers"]["freshell"].is_object(),
        "the {launch} hands the CLI the hosted Freshell MCP: {options}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_create_carries_the_panes_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    create_with_plugin(&mut conn, &plugin).await;

    let options = query_options(&rig);
    assert_eq!(options.len(), 1, "one sidecar booted: {options:?}");
    assert_carries_plugin_and_hosted_mcp(&options[0], &plugin, "create");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_resume_carries_the_bound_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    let session_id = create_with_plugin(&mut conn, &plugin).await;
    let durable = converse(&rig, &mut conn, &session_id, &["first prompt"]).await;
    kill_the_sidecar(&rig, &mut conn).await;

    // The pane attaches again (a reload): the lane resumes the session.
    conn.send(json!({
        "type": "freshAgent.attach",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "sessionRef": { "provider": "claude", "sessionId": durable },
    }))
    .await;
    conn.wait_for("the attach-resume acknowledgement", |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    let resumed = wait_for_query(&rig, "the attach-resume", |o| o["resume"] == durable).await;
    assert_carries_plugin_and_hosted_mcp(&resumed, &plugin, "attach-resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handoff_resume_carries_the_bound_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    let session_id = create_with_plugin(&mut conn, &plugin).await;
    let durable = converse(&rig, &mut conn, &session_id, &["first prompt"]).await;
    kill_the_sidecar(&rig, &mut conn).await;

    let (status, answer) = rig
        .post_json(
            "/api/sessions/handoff",
            &json!({
                "provider": "claude",
                "sessionId": durable,
                "targetKind": "fresh-agent",
                "sessionType": "freshclaude",
                "cwd": rig.workspace.to_str().expect("utf-8 path"),
            }),
        )
        .await;
    assert_eq!(status, 200, "the handoff resumes the session: {answer}");

    let resumed = wait_for_query(&rig, "the handoff resume", |o| o["resume"] == durable).await;
    assert_carries_plugin_and_hosted_mcp(&resumed, &plugin, "handoff resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rollback_respawn_carries_the_bound_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    let session_id = create_with_plugin(&mut conn, &plugin).await;
    let durable = converse(
        &rig,
        &mut conn,
        &session_id,
        &["first prompt", "second prompt"],
    )
    .await;

    // The client sends the owner pair of the latest `session.runtimeOwner` frame
    // for the durable id with every rollback.
    let owner = conn
        .frames
        .iter()
        .rev()
        .find(|v| v["type"] == "session.runtimeOwner" && v["sessionId"] == durable.as_str())
        .cloned()
        .expect("the session's owner record was broadcast");
    conn.send(json!({
        "type": "freshAgent.undo",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": "undo-1",
        "mode": "step",
        "observedEpoch": owner["epoch"],
        "observedGeneration": owner["generation"],
    }))
    .await;

    // The undo boots a fork of the conversation through its first turn. (Until C13
    // the rollback then waits for a turn that never comes, G01; the fork's launch
    // is what this test pins, and the rig's teardown stops the fork.)
    let fork = wait_for_query(&rig, "the undo's fork", |o| {
        o["forkSession"] == true && o["resume"] == durable
    })
    .await;
    assert_carries_plugin_and_hosted_mcp(&fork, &plugin, "rollback respawn");
}

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

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions};

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

    let options = rig.query_options();
    assert_eq!(options.len(), 1, "one sidecar booted: {options:?}");
    assert_carries_plugin_and_hosted_mcp(&options[0], &plugin, "create");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_resume_carries_the_bound_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    let session_id = create_with_plugin(&mut conn, &plugin).await;
    let durable = rig
        .converse(&mut conn, &session_id, &["first prompt"])
        .await;
    rig.kill_first_sidecar(&mut conn).await;

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

    let resumed = rig
        .wait_for_query("the attach-resume", |o| o["resume"] == durable)
        .await;
    assert_carries_plugin_and_hosted_mcp(&resumed, &plugin, "attach-resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handoff_resume_carries_the_bound_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    let session_id = create_with_plugin(&mut conn, &plugin).await;
    let durable = rig
        .converse(&mut conn, &session_id, &["first prompt"])
        .await;
    rig.kill_first_sidecar(&mut conn).await;

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

    let resumed = rig
        .wait_for_query("the handoff resume", |o| o["resume"] == durable)
        .await;
    assert_carries_plugin_and_hosted_mcp(&resumed, &plugin, "handoff resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rollback_respawn_carries_the_bound_plugins_and_the_hosted_mcp() {
    let (rig, plugin) = hosted_rig().await;
    let mut conn = rig.connect().await;
    let session_id = create_with_plugin(&mut conn, &plugin).await;
    let durable = rig
        .converse(&mut conn, &session_id, &["first prompt", "second prompt"])
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

    // The undo boots a fork of the conversation through its first turn, and
    // answers once the CLI booted it (C13).
    let ack = conn
        .wait_for("the undo's ack", |v| {
            v["type"] == "freshAgent.event" && v["event"]["requestId"] == "undo-1"
        })
        .await;
    assert_eq!(ack["event"]["type"], "freshAgent.rolledBack", "{ack}");
    let fork = rig
        .wait_for_query("the undo's fork", |o| {
            o["forkSession"] == true && o["resume"] == durable
        })
        .await;
    assert_carries_plugin_and_hosted_mcp(&fork, &plugin, "rollback respawn");
}

//! G19 (api-hosted-ops plan §2.4): a freshclaude or kilroy pane's CLI gets the
//! ordinary Freshell MCP server, the way a terminal pane's CLI does.
//!
//! Every sidecar launch (create, attach-resume, handoff resume, undo/redo
//! respawn, fork) asks the lane's recipe provider, so the setting
//! (`settings.codingCli.mcpServer`) applies to the next launch without a
//! restart. The recipe travels in the `create` line as a command and its
//! arguments only; the endpoint and token are in the sidecar's environment,
//! which the server sets from its own bound port and token; the pane the
//! session runs for travels as `freshellContext` and lands in the CLI's
//! environment, from which the CLI hands all of it to the MCP child.
//!
//! Each test runs the real sidecar over the CLI simulator (RealSidecarSim),
//! whose ledger records the options of every `query()` call, including the
//! Freshell context values of the CLI environment and a digest of the token.

mod common;

use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use common::AUTH_TOKEN;
use freshell_freshagent::claude_freshell_mcp::{ClaudeFreshellMcp, ClaudeFreshellMcpResolution};

/// The recipe the rig's provider resolves (the simulator records it as given).
fn recipe() -> ClaudeFreshellMcp {
    ClaudeFreshellMcp {
        command: "node".into(),
        args: vec!["/srv/freshell/dist/tools/freshell-mcp/server.js".into()],
    }
}

fn resolved() -> ClaudeFreshellMcpResolution {
    ClaudeFreshellMcpResolution::Resolved(recipe())
}

/// A RealSidecarSim rig wired the way main.rs wires the default server, with
/// a durable ledger (resumes read the session back) and the handoff route.
async fn rig_with(
    resolution: ClaudeFreshellMcpResolution,
    hosted: bool,
) -> (
    ClaudeRig,
    Arc<std::sync::Mutex<ClaudeFreshellMcpResolution>>,
) {
    let cell = Arc::new(std::sync::Mutex::new(resolution));
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            handoff: true,
            hosted_claude: hosted,
            env: vec![("KILROY_ENABLED".into(), "1".into())],
            freshell_mcp: Some(Arc::clone(&cell)),
            ..RigOptions::default()
        },
    )
    .await;
    (rig, cell)
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

/// The simulator's digest of a credential value (`query.mjs`).
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..12].to_string()
}

/// The launch handed the CLI the ordinary recipe (command and arguments, no
/// environment) and an environment that reaches the rig's server for `pane`.
fn assert_mcp_for_pane(rig: &ClaudeRig, options: &Value, pane: Option<(&str, &str)>, launch: &str) {
    assert_eq!(
        options["mcpServers"],
        json!({ "freshell": { "command": "node", "args": ["/srv/freshell/dist/tools/freshell-mcp/server.js"] } }),
        "the {launch} hands the CLI the Freshell MCP recipe and nothing else: {options}"
    );
    let mut context = json!({ "FRESHELL": "1", "FRESHELL_URL": rig.http_url });
    if let Some((tab, pane)) = pane {
        context["FRESHELL_TAB_ID"] = json!(tab);
        context["FRESHELL_PANE_ID"] = json!(pane);
    }
    assert_eq!(
        options["envContext"], context,
        "the {launch}'s CLI reaches this server for its pane: {options}"
    );
    assert_eq!(
        options["envDigests"]["FRESHELL_TOKEN"],
        json!(digest(AUTH_TOKEN)),
        "the {launch}'s CLI carries this server's token: {options}"
    );
}

/// Create a session for `pane` (`tabId`, `paneId`); returns the session id.
async fn create_for_pane(
    conn: &mut RigConnection,
    request_id: &str,
    session_type: &str,
    pane: (&str, &str),
) -> String {
    let created = conn
        .request_create(
            request_id,
            json!({ "sessionType": session_type, "tabId": pane.0, "paneId": pane.1 }),
        )
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    created["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string()
}

/// One finished turn per prompt, so the conversation is on disk; returns the
/// durable id the first turn reported.
async fn converse(conn: &mut RigConnection, session_id: &str, prompts: &[&str]) -> String {
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

/// The session's sidecar dies on its own: the session is untracked, the state a
/// reload or a handoff resumes from.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_freshclaude_and_a_kilroy_create_hand_the_cli_the_freshell_mcp_for_their_pane() {
    let (rig, _) = rig_with(resolved(), false).await;
    let mut conn = rig.connect().await;
    create_for_pane(
        &mut conn,
        "create-claude",
        "freshclaude",
        ("tab-1", "pane-1"),
    )
    .await;
    create_for_pane(&mut conn, "create-kilroy", "kilroy", ("tab-2", "pane-2")).await;

    let options = query_options(&rig);
    assert_eq!(options.len(), 2, "two sidecars booted: {options:?}");
    assert_mcp_for_pane(
        &rig,
        &options[0],
        Some(("tab-1", "pane-1")),
        "freshclaude create",
    );
    assert_mcp_for_pane(
        &rig,
        &options[1],
        Some(("tab-2", "pane-2")),
        "kilroy create",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_setting_applies_to_the_next_launch_without_a_restart() {
    let (rig, setting) = rig_with(ClaudeFreshellMcpResolution::Disabled, false).await;
    let mut conn = rig.connect().await;
    create_for_pane(&mut conn, "create-off", "freshclaude", ("tab-1", "pane-1")).await;
    *setting.lock().unwrap() = resolved();
    create_for_pane(&mut conn, "create-on", "freshclaude", ("tab-1", "pane-2")).await;
    *setting.lock().unwrap() =
        ClaudeFreshellMcpResolution::Unavailable("no MCP server build".into());
    create_for_pane(
        &mut conn,
        "create-unresolved",
        "freshclaude",
        ("tab-1", "pane-3"),
    )
    .await;

    let options = query_options(&rig);
    assert_eq!(options.len(), 3, "three sidecars booted: {options:?}");
    assert!(
        options[0].get("mcpServers").is_none(),
        "with the setting off the CLI gets no MCP server: {}",
        options[0]
    );
    assert_mcp_for_pane(
        &rig,
        &options[1],
        Some(("tab-1", "pane-2")),
        "create after the setting turned on",
    );
    assert!(
        options[2].get("mcpServers").is_none(),
        "a command that cannot be resolved starts the pane without it: {}",
        options[2]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hosted_lane_keeps_its_fixed_recipe_and_never_gets_the_ordinary_one() {
    let (rig, _) = rig_with(resolved(), true).await;
    let mut conn = rig.connect().await;
    create_for_pane(
        &mut conn,
        "create-hosted",
        "freshclaude",
        ("tab-1", "pane-1"),
    )
    .await;

    let options = query_options(&rig);
    assert_eq!(
        options[0]["mcpServers"],
        json!({ "freshell": { "command": "node", "args": ["/opt/freshell-mcp/server.js"] } }),
        "{}",
        options[0]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_resume_hands_the_cli_the_freshell_mcp_for_the_attaching_pane() {
    let (rig, _) = rig_with(resolved(), false).await;
    let mut conn = rig.connect().await;
    let session_id =
        create_for_pane(&mut conn, "create-1", "freshclaude", ("tab-1", "pane-1")).await;
    let durable = converse(&mut conn, &session_id, &["first prompt"]).await;
    kill_the_sidecar(&rig, &mut conn).await;

    // The pane, moved to another tab meanwhile, attaches again (a reload).
    conn.send(json!({
        "type": "freshAgent.attach",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "sessionRef": { "provider": "claude", "sessionId": durable },
        "tabId": "tab-9",
        "paneId": "pane-1",
    }))
    .await;
    let resumed = wait_for_query(&rig, "the attach-resume", |o| o["resume"] == durable).await;
    assert_mcp_for_pane(&rig, &resumed, Some(("tab-9", "pane-1")), "attach-resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handoff_resume_hands_the_cli_the_freshell_mcp() {
    let (rig, _) = rig_with(resolved(), false).await;
    let mut conn = rig.connect().await;
    let session_id =
        create_for_pane(&mut conn, "create-1", "freshclaude", ("tab-1", "pane-1")).await;
    let durable = converse(&mut conn, &session_id, &["first prompt"]).await;
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
    // A handoff names no pane: the pane that adopts the session is not known
    // yet, so the CLI reaches the server without a pane of its own.
    let resumed = wait_for_query(&rig, "the handoff resume", |o| o["resume"] == durable).await;
    assert_mcp_for_pane(&rig, &resumed, None, "handoff resume");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_respawn_runs_for_the_same_pane() {
    let (rig, _) = rig_with(resolved(), false).await;
    let mut conn = rig.connect().await;
    let session_id =
        create_for_pane(&mut conn, "create-1", "freshclaude", ("tab-1", "pane-1")).await;
    let durable = converse(&mut conn, &session_id, &["first prompt", "second prompt"]).await;

    let (epoch, generation) = conn
        .owner_pair(&durable)
        .expect("the session's owner record was broadcast");
    conn.send(json!({
        "type": "freshAgent.undo",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": "undo-1",
        "mode": "step",
        "observedEpoch": epoch,
        "observedGeneration": generation,
    }))
    .await;
    let ack = conn
        .wait_for("the undo's ack", |v| {
            v["type"] == "freshAgent.event" && v["event"]["requestId"] == "undo-1"
        })
        .await;
    assert_eq!(ack["event"]["type"], "freshAgent.rolledBack", "{ack}");
    let undone = wait_for_query(&rig, "the undo's respawn", |o| {
        o["forkSession"] == true && o["resume"] == durable
    })
    .await;
    assert_mcp_for_pane(&rig, &undone, Some(("tab-1", "pane-1")), "undo respawn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_child_runs_for_the_forking_pane() {
    let (rig, _) = rig_with(resolved(), false).await;
    let mut conn = rig.connect().await;
    let session_id =
        create_for_pane(&mut conn, "create-1", "freshclaude", ("tab-1", "pane-1")).await;
    let durable = converse(&mut conn, &session_id, &["first prompt"]).await;

    let mut fork = json!({
        "type": "freshAgent.fork",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": "fork-1",
        "tabId": "tab-1",
    });
    if let Some((epoch, generation)) = conn.owner_pair(&durable) {
        fork["observedEpoch"] = json!(epoch);
        fork["observedGeneration"] = json!(generation);
    }
    conn.send(fork).await;
    let forked = conn
        .wait_for("the fork's answer", |v| {
            (v["type"] == "freshAgent.forked" && v["requestId"] == "fork-1")
                || (v["type"] == "freshAgent.event"
                    && v["event"]["type"] == "freshAgent.error"
                    && v["event"]["sessionId"] == session_id.as_str())
        })
        .await;
    assert_eq!(forked["type"], "freshAgent.forked", "{forked}");
    let child = forked["sessionId"]
        .as_str()
        .expect("forked names the child");
    let options = wait_for_query(&rig, "the fork's child", |o| o["sessionId"] == child).await;
    assert_mcp_for_pane(&rig, &options, Some(("tab-1", "pane-1")), "fork child");
}

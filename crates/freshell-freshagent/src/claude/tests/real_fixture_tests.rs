use super::*;

#[tokio::test]
async fn the_rust_runtime_fixture_completes_a_real_sidecar_turn() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    std::env::set_var(
        "FRESHELL_CLAUDE_SIM_PROGRAM",
        json!({"rules":[{"on":"msg:prompt", "match":{"text":"prove the real sidecar path"},
            "emit":[{"kind":"text", "data":{"text":"the simulator answered through index.mjs"}}]}]})
        .to_string(),
    );
    let (state, mut rx) = state_with_bus();
    state
        .handle_create(dedup_create_msg("real-fixture-smoke"), None)
        .await;
    let created = await_claude_created(&mut rx, "real-fixture-smoke").await;
    let session_id = created["sessionId"].as_str().unwrap();
    state
        .handle_send(send_msg(session_id, "prove the real sidecar path"))
        .await;
    let assistant = await_frame_of_inner_type(&mut rx, "freshAgent.assistant").await;
    assert_eq!(
        assistant["event"]["content"][0]["text"],
        "the simulator answered through index.mjs"
    );
    let result = await_frame_of_inner_type(&mut rx, "freshAgent.result").await;
    assert_eq!(result["sessionId"], session_id);
    let rows: Vec<Value> = std::fs::read_to_string(env.dir.join("sim-ledger.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let prompt = rows.iter().find(|row| row["kind"] == "prompt").unwrap();
    assert_eq!(prompt["sessionId"], session_id);
    assert!(uuid::Uuid::parse_str(prompt["uuid"].as_str().unwrap()).is_ok());
    assert_eq!(rows.iter().filter(|row| row["kind"] == "query").count(), 1);
    assert_eq!(rows.iter().filter(|row| row["kind"] == "result").count(), 1);
    #[cfg(unix)]
    let processes = {
        let boot = rows.iter().find(|row| row["kind"] == "boot").unwrap();
        [
            boot["pid"].as_u64().unwrap(),
            boot["cliPid"].as_u64().unwrap(),
        ]
        .map(|pid| {
            (
                pid,
                crate::process_probe::ProcessProbe::open(u32::try_from(pid).unwrap()),
            )
        })
    };
    // Keep the Rust state alive: ending the unique fixture guard must itself
    // close the SDK query and stop both the production sidecar and its CLI.
    drop(env);
    #[cfg(unix)]
    for (pid, process) in processes {
        assert!(
            process.exits_within(Duration::from_secs(15)).await,
            "dropping the fixture guard left process {pid} running"
        );
    }
    state.shutdown().await;
}

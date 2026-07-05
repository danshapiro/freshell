//! Deliverable #4 — round-trip fidelity + frozen-schema conformance.
//!
//! The real acceptance. Three layers of proof:
//!
//! 1. **Real captured data** — the handshake transcript (`ready`,
//!    `settings.updated`, `perf.logging`, `terminal.inventory`, plus an outbound
//!    `hello`) is deserialized into the Rust types, checked variant + fields,
//!    re-serialized, and asserted semantically equal to the original wire JSON.
//! 2. **Frozen-schema conformance** — every re-serialized message is validated
//!    against the committed JSON Schema (`ws-server-messages.schema.json` /
//!    `ClientMessageSchema`). A shape the Rust types get wrong is a FIDELITY GAP
//!    and fails loudly here.
//! 3. **Breadth** — hand-authored (straight from the contract's field names)
//!    instances of the structurally rich / tricky messages exercise the parts
//!    the transcript doesn't: opaque blobs, `string | number`, nullable-optional
//!    (`double_option`), `#[serde(flatten)]` passthrough, deep codex durability.

use std::path::PathBuf;

use freshell_protocol::*;
use serde_json::{json, Value};

// --------------------------------------------------------------------------
// Fixtures / schema loading.
// --------------------------------------------------------------------------

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}

fn read_json(rel: &str) -> Value {
    let text = std::fs::read_to_string(repo_path(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {rel}: {e}"))
}

fn outbound_schema() -> Value {
    read_json("port/contract/ws-server-messages.schema.json")
}

fn inbound_schema() -> Value {
    read_json("port/contract/ws-protocol.schema.json")
}

fn validator(schema: &Value) -> jsonschema::Validator {
    jsonschema::validator_for(schema).expect("compile frozen schema")
}

/// Assert an instance validates against a frozen schema, or report the gap.
fn assert_conforms(v: &jsonschema::Validator, instance: &Value, ctx: &str) {
    if !v.is_valid(instance) {
        let errs: Vec<String> = v.iter_errors(instance).map(|e| e.to_string()).collect();
        panic!("FIDELITY GAP: `{ctx}` does not conform to the frozen contract:\n  - {}\n  serialized: {instance}",
            errs.join("\n  - "));
    }
}

/// Deserialize a server message from a wire string, re-serialize it, assert the
/// round-trip is semantically equal to `expected_wire`, and validate against the
/// frozen outbound schema for `type_name`.
fn server_roundtrip(wire: &str, type_name: &str) -> ServerMessage {
    let expected: Value = serde_json::from_str(wire).expect("wire is JSON");
    let msg: ServerMessage =
        serde_json::from_str(wire).unwrap_or_else(|e| panic!("deserialize {type_name}: {e}"));
    let reser = serde_json::to_value(&msg).expect("serialize");
    assert_eq!(reser, expected, "round-trip changed `{type_name}` structure");
    let schema = outbound_schema()["messages"][type_name].clone();
    assert!(!schema.is_null(), "no frozen schema for server `{type_name}`");
    assert_conforms(&validator(&schema), &reser, type_name);
    msg
}

/// Same, for a client message (validated against the `ClientMessageSchema` union).
fn client_roundtrip(wire: &str, type_name: &str) -> ClientMessage {
    let expected: Value = serde_json::from_str(wire).expect("wire is JSON");
    let msg: ClientMessage =
        serde_json::from_str(wire).unwrap_or_else(|e| panic!("deserialize {type_name}: {e}"));
    let reser = serde_json::to_value(&msg).expect("serialize");
    assert_eq!(reser, expected, "round-trip changed `{type_name}` structure");
    let schema = inbound_schema()["schemas"]["ClientMessageSchema"].clone();
    assert_conforms(&validator(&schema), &reser, type_name);
    msg
}

// --------------------------------------------------------------------------
// 1 + 2. The real handshake transcript.
// --------------------------------------------------------------------------

#[test]
fn handshake_transcript_roundtrips_and_conforms() {
    let transcript = read_json("port/oracle/fixtures/handshake-transcript.json");
    let entries = transcript["transcript"].as_array().expect("transcript array");
    assert_eq!(entries.len(), 5, "transcript has hello + 4 server messages");

    let mut server_types_seen = Vec::new();

    for entry in entries {
        let dir = entry["dir"].as_str().unwrap();
        let type_name = entry["type"].as_str().unwrap();
        let raw = entry["raw"].as_str().expect("entry has raw wire string");
        let parsed = &entry["parsed"];

        match dir {
            "out" => {
                // client → server (the `hello`)
                let msg = client_roundtrip(raw, type_name);
                assert!(
                    matches!(msg, ClientMessage::Hello(_)),
                    "outbound handshake message is a hello"
                );
            }
            "in" => {
                // server → client
                let msg = server_roundtrip(raw, type_name);
                let reser = serde_json::to_value(&msg).unwrap();
                assert_eq!(&reser, parsed, "`{type_name}` must equal transcript `parsed`");
                server_types_seen.push(type_name.to_string());
            }
            other => panic!("unexpected dir {other}"),
        }
    }

    server_types_seen.sort();
    assert_eq!(
        server_types_seen,
        vec!["perf.logging", "ready", "settings.updated", "terminal.inventory"]
    );
}

#[test]
fn ready_carries_server_instance_id_and_boot_id() {
    // deliverable: assert `ready` carries serverInstanceId + bootId.
    let wire = r#"{"type":"ready","timestamp":"2026-07-05T04:20:52.546Z","serverInstanceId":"srv-abc","bootId":"boot-xyz"}"#;
    let msg = server_roundtrip(wire, "ready");
    match msg {
        ServerMessage::Ready(r) => {
            assert_eq!(r.timestamp, "2026-07-05T04:20:52.546Z");
            assert_eq!(r.server_instance_id.as_deref(), Some("srv-abc"));
            assert_eq!(r.boot_id.as_deref(), Some("boot-xyz"));
        }
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn terminal_inventory_and_settings_parse_from_transcript() {
    let transcript = read_json("port/oracle/fixtures/handshake-transcript.json");
    let entries = transcript["transcript"].as_array().unwrap();

    let inv_raw = entries
        .iter()
        .find(|e| e["type"] == json!("terminal.inventory"))
        .unwrap()["raw"]
        .as_str()
        .unwrap();
    match server_roundtrip(inv_raw, "terminal.inventory") {
        ServerMessage::TerminalInventory(inv) => {
            assert_eq!(inv.boot_id, "boot-e5b76607-9e87-4895-91c3-725e38e914b6");
            assert!(inv.terminals.is_empty());
            assert!(inv.terminal_meta.is_empty());
        }
        other => panic!("expected TerminalInventory, got {other:?}"),
    }

    let settings_raw = entries
        .iter()
        .find(|e| e["type"] == json!("settings.updated"))
        .unwrap()["raw"]
        .as_str()
        .unwrap();
    match server_roundtrip(settings_raw, "settings.updated") {
        ServerMessage::SettingsUpdated(s) => {
            assert_eq!(s.settings.safety.auto_kill_idle_minutes, 15);
            assert_eq!(s.settings.terminal.scrollback, 10000);
            assert_eq!(s.settings.network.host, NetworkHost::Loopback);
            assert!(matches!(s.settings.editor.external_editor, ExternalEditor::Auto));
            assert_eq!(
                s.settings.coding_cli.enabled_providers,
                vec!["claude", "codex", "opencode"]
            );
        }
        other => panic!("expected SettingsUpdated, got {other:?}"),
    }
}

// --------------------------------------------------------------------------
// 3. Breadth — structurally rich / tricky messages, straight from the contract.
// --------------------------------------------------------------------------

#[test]
fn rich_server_messages() {
    // error — ErrorCode enum + optional session refs.
    let wire = r#"{"type":"error","code":"INVALID_TERMINAL_ID","message":"no such terminal","timestamp":"2026-07-05T00:00:00.000Z","requestId":"req-1","terminalId":"t1","terminalExitCode":1,"expectedSessionRef":{"provider":"codex","sessionId":"ses_1"},"actualSessionRef":{"provider":"codex","sessionId":"ses_2"}}"#;
    match server_roundtrip(wire, "error") {
        ServerMessage::Error(e) => assert_eq!(e.code, ErrorCode::InvalidTerminalId),
        other => panic!("expected Error, got {other:?}"),
    }

    // terminal.output.batch — segments[] with a barrier enum.
    let wire = r#"{"type":"terminal.output.batch","attachRequestId":"a1","data":"aGVsbG8=","segments":[{"seqStart":1,"seqEnd":3,"endOffset":5,"rawFrameCount":2,"barrier":"turn_complete","data":"aGk="}],"seqStart":1,"seqEnd":3,"serializedBytes":42,"source":"live","streamId":"s1","terminalId":"t1"}"#;
    match server_roundtrip(wire, "terminal.output.batch") {
        ServerMessage::TerminalOutputBatch(b) => {
            assert_eq!(b.segments.len(), 1);
            assert_eq!(b.segments[0].barrier, Some(SegmentBarrier::TurnComplete));
            assert_eq!(b.serialized_bytes, 42);
        }
        other => panic!("expected TerminalOutputBatch, got {other:?}"),
    }

    // terminal.inventory — populated codexDurability + tokenUsage.
    let wire = r#"{"type":"terminal.inventory","bootId":"b1","terminals":[{"terminalId":"t1","createdAt":1,"lastActivityAt":2,"mode":"shell","status":"running","title":"bash","cwd":"/home","description":"d","runtimeStatus":"recovering","sessionRef":{"provider":"codex","sessionId":"ses_1"},"codexDurability":{"schemaVersion":1,"state":"durable","candidate":{"candidateThreadId":"th1","capturedAt":10,"provider":"codex","rolloutPath":"/tmp/r","source":"thread_start_response","cliVersion":"1.2.3"},"durableThreadId":"th1","lastProofFailure":{"checkedAt":11,"message":"m","reason":"missing"},"nonRestorableReason":"n","turnCompletedAt":12}}],"terminalMeta":[{"terminalId":"t1","updatedAt":3,"branch":"main","isDirty":true,"tokenUsage":{"cachedTokens":1,"inputTokens":2,"outputTokens":3,"totalTokens":6,"compactPercent":10,"contextTokens":4,"modelContextWindow":200000,"compactThresholdTokens":150000}}]}"#;
    match server_roundtrip(wire, "terminal.inventory") {
        ServerMessage::TerminalInventory(inv) => {
            let d = inv.terminals[0].codex_durability.as_ref().unwrap();
            assert_eq!(d.state, CodexDurabilityState::Durable);
            assert_eq!(d.candidate.as_ref().unwrap().source, CodexDurabilitySource::ThreadStartResponse);
            let tu = inv.terminal_meta[0].token_usage.as_ref().unwrap();
            assert_eq!(tu.total_tokens, 6);
        }
        other => panic!("expected TerminalInventory, got {other:?}"),
    }

    // terminal.created — restoreError const + reason enum.
    let wire = r#"{"type":"terminal.created","createdAt":1,"requestId":"r1","terminalId":"t1","clearCodexDurability":true,"cwd":"/x","restoreError":{"code":"RESTORE_UNAVAILABLE","reason":"dead_live_handle"},"sessionRef":{"provider":"codex","sessionId":"ses_1"}}"#;
    server_roundtrip(wire, "terminal.created");

    // terminal.turn.complete — provider enum.
    let wire = r#"{"type":"terminal.turn.complete","at":1,"completionSeq":5,"provider":"opencode","terminalId":"t1","sessionId":"ses_1"}"#;
    match server_roundtrip(wire, "terminal.turn.complete") {
        ServerMessage::TerminalTurnComplete(t) => assert_eq!(t.provider, AgentProvider::Opencode),
        other => panic!("expected TerminalTurnComplete, got {other:?}"),
    }
}

#[test]
fn rich_client_messages() {
    // terminal.create (inbound) — shell enum + nested codexDurability + liveTerminal.
    let wire = r#"{"type":"terminal.create","requestId":"r1","mode":"shell","shell":"wsl","cwd":"/home","tabId":"tab1","paneId":"pane1","restore":true,"recoveryIntent":"fresh_after_restore_unavailable","liveTerminal":{"serverInstanceId":"srv-1","terminalId":"t1"},"sessionRef":{"provider":"codex","sessionId":"ses_1"},"codexDurability":{"schemaVersion":1,"state":"identity_pending"}}"#;
    match client_roundtrip(wire, "terminal.create") {
        ClientMessage::TerminalCreate(c) => {
            assert_eq!(c.shell, Shell::Wsl);
            assert_eq!(c.live_terminal.as_ref().unwrap().server_instance_id, "srv-1");
        }
        other => panic!("expected TerminalCreate, got {other:?}"),
    }

    // terminal.attach (inbound) — intent + priority enums.
    let wire = r#"{"type":"terminal.attach","terminalId":"t1","intent":"viewport_hydrate","cols":80,"rows":24,"attachRequestId":"a1","priority":"foreground","sinceSeq":5,"maxReplayBytes":1024,"expectedSessionRef":{"provider":"codex","sessionId":"ses_1"}}"#;
    match client_roundtrip(wire, "terminal.attach") {
        ClientMessage::TerminalAttach(a) => {
            assert_eq!(a.intent, TerminalAttachIntent::ViewportHydrate);
            assert_eq!(a.priority, Some(TerminalAttachPriority::Foreground));
        }
        other => panic!("expected TerminalAttach, got {other:?}"),
    }

    // codingcli.create — PermissionMode enum (vs freshAgent's free string).
    let wire = r#"{"type":"codingcli.create","prompt":"hi","provider":"claude","requestId":"r1","cwd":"/x","maxTurns":3,"model":"sonnet","permissionMode":"acceptEdits","sandbox":"workspace-write","resumeSessionId":"prev"}"#;
    match client_roundtrip(wire, "codingcli.create") {
        ClientMessage::CodingCliCreate(c) => {
            assert_eq!(c.permission_mode, Some(PermissionMode::AcceptEdits));
            assert_eq!(c.sandbox, Some(Sandbox::WorkspaceWrite));
        }
        other => panic!("expected CodingCliCreate, got {other:?}"),
    }

    // ping — unit variant.
    match client_roundtrip(r#"{"type":"ping"}"#, "ping") {
        ClientMessage::Ping => {}
        other => panic!("expected Ping, got {other:?}"),
    }
}

#[test]
fn string_or_number_request_id() {
    // numeric requestId (freshAgent.approval.respond).
    let wire = r#"{"type":"freshAgent.approval.respond","provider":"codex","sessionId":"ses_1","sessionType":"freshcodex","decision":{"approved":true,"scope":"once"},"requestId":42,"cwd":"/x"}"#;
    match client_roundtrip(wire, "freshAgent.approval.respond") {
        ClientMessage::FreshAgentApprovalRespond(m) => {
            assert_eq!(m.request_id, StringOrNumber::Num(42));
        }
        other => panic!("expected FreshAgentApprovalRespond, got {other:?}"),
    }

    // string requestId (freshAgent.question.respond).
    let wire = r#"{"type":"freshAgent.question.respond","provider":"claude","sessionId":"s","sessionType":"freshclaude","answers":{"q1":"a1"},"requestId":"req-str"}"#;
    match client_roundtrip(wire, "freshAgent.question.respond") {
        ClientMessage::FreshAgentQuestionRespond(m) => {
            assert_eq!(m.request_id, StringOrNumber::Str("req-str".into()));
            assert_eq!(m.answers.get("q1").map(String::as_str), Some("a1"));
        }
        other => panic!("expected FreshAgentQuestionRespond, got {other:?}"),
    }
}

#[test]
fn double_option_distinguishes_absent_null_value() {
    // present-null: activeTabId: null  and  modelSelection: null.
    // paneTitles is Record<string, Record<string, string>>; paneTitleSetByUser
    // is Record<string, Record<string, boolean>> in the frozen contract.
    let wire = r#"{"type":"ui.layout.sync","tabs":[{"id":"tab1","title":"T","fallbackSessionRef":{"provider":"codex","sessionId":"s"}}],"layouts":{"tab1":{"direction":"row"}},"activePane":{"pane1":"content-a"},"timestamp":1720000000000,"activeTabId":null,"paneTitles":{"pane1":{"x":"y"}},"paneTitleSetByUser":{"pane1":{"x":true}}}"#;
    match client_roundtrip(wire, "ui.layout.sync") {
        ClientMessage::UiLayoutSync(m) => {
            assert_eq!(m.active_tab_id, Some(None), "explicit null preserved");
            assert_eq!(m.active_pane.get("pane1").map(String::as_str), Some("content-a"));
        }
        other => panic!("expected UiLayoutSync, got {other:?}"),
    }

    // present-value.
    let wire = r#"{"type":"ui.layout.sync","tabs":[],"layouts":{},"activePane":{},"timestamp":1,"activeTabId":"tab7"}"#;
    match client_roundtrip(wire, "ui.layout.sync") {
        ClientMessage::UiLayoutSync(m) => {
            assert_eq!(m.active_tab_id, Some(Some("tab7".to_string())));
        }
        other => panic!("expected UiLayoutSync, got {other:?}"),
    }

    // absent -> None, and must be omitted on re-serialize (not `null`).
    let wire = r#"{"type":"ui.layout.sync","tabs":[],"layouts":{},"activePane":{},"timestamp":1}"#;
    match client_roundtrip(wire, "ui.layout.sync") {
        ClientMessage::UiLayoutSync(m) => assert_eq!(m.active_tab_id, None),
        other => panic!("expected UiLayoutSync, got {other:?}"),
    }

    // freshAgent.create with modelSelection: null (double_option) + legacy context.
    let wire = r#"{"type":"freshAgent.create","requestId":"r1","sessionType":"freshcodex","provider":"codex","cwd":"/x","effort":"high","model":"gpt","permissionMode":"default","plugins":["p1"],"sandbox":"workspace-write","resumeSessionId":"prev","sessionRef":{"provider":"codex","sessionId":"s"},"legacyRestoreContext":{"createdAt":1,"title":"t","updatedAt":2},"modelSelection":null}"#;
    match client_roundtrip(wire, "freshAgent.create") {
        ClientMessage::FreshAgentCreate(m) => {
            assert_eq!(m.model_selection, Some(None));
            assert_eq!(m.session_type, SessionType::Freshcodex);
        }
        other => panic!("expected FreshAgentCreate, got {other:?}"),
    }
}

#[test]
fn flatten_passthrough_preserves_unknown_integer_keys() {
    // tabs.sync.snapshot open records are OPEN objects: extra keys (incl.
    // integers) must survive the flatten round-trip byte-for-byte.
    let wire = r#"{"type":"tabs.sync.snapshot","requestId":"r1","data":{"devices":[{"deviceId":"d1","deviceLabel":"L","lastSeenAt":5}],"closed":[{"deviceId":"d1","deviceLabel":"L","tabId":"tab9"}],"localOpen":[{"clientInstanceId":"c1","deviceId":"d1","deviceLabel":"L","tabId":"tab1","extraCount":7}],"remoteOpen":[],"sameDeviceOpen":[]}}"#;
    match server_roundtrip(wire, "tabs.sync.snapshot") {
        ServerMessage::TabsSyncSnapshot(s) => {
            let extra = &s.data.local_open[0].extra;
            assert_eq!(extra.get("extraCount"), Some(&json!(7)), "integer extra survives flatten");
            assert_eq!(extra.get("tabId"), Some(&json!("tab1")));
        }
        other => panic!("expected TabsSyncSnapshot, got {other:?}"),
    }

    // Usage passthrough (standalone exported schema) with an integer extra.
    let usage_wire = r#"{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3,"service_tier":"standard","extra_count":99}"#;
    let expected: Value = serde_json::from_str(usage_wire).unwrap();
    let usage: Usage = serde_json::from_str(usage_wire).unwrap();
    assert_eq!(usage.input_tokens, 10);
    assert_eq!(usage.passthrough.get("extra_count"), Some(&json!(99)));
    let reser = serde_json::to_value(&usage).unwrap();
    assert_eq!(reser, expected, "Usage passthrough must round-trip exactly");
    let schema = inbound_schema()["schemas"]["UsageSchema"].clone();
    assert_conforms(&validator(&schema), &reser, "UsageSchema");
}

#[test]
fn content_blocks_roundtrip() {
    let wire = r#"{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"x"}],"is_error":false}"#;
    let expected: Value = serde_json::from_str(wire).unwrap();
    let block: ContentBlock = serde_json::from_str(wire).unwrap();
    assert!(matches!(block, ContentBlock::ToolResult(_)));
    let reser = serde_json::to_value(&block).unwrap();
    assert_eq!(reser, expected);
    let schema = inbound_schema()["schemas"]["ContentBlockSchema"].clone();
    assert_conforms(&validator(&schema), &reser, "ContentBlockSchema");
}

#[test]
fn accept_and_strip_ignores_unknown_fields() {
    // Inbound is accept-and-strip (no deny_unknown_fields): a forward-compatible
    // extra key must deserialize fine and simply be dropped on re-serialize.
    let wire = r#"{"type":"ping","futureField":123}"#;
    let msg: ClientMessage = serde_json::from_str(wire).expect("unknown field tolerated");
    assert!(matches!(msg, ClientMessage::Ping));
    let reser = serde_json::to_value(&msg).unwrap();
    assert_eq!(reser, json!({"type":"ping"}), "unknown field stripped");

    // Same for a closed server payload.
    let wire = r#"{"type":"perf.logging","enabled":true,"unexpected":"x"}"#;
    let msg: ServerMessage = serde_json::from_str(wire).expect("unknown field tolerated");
    match msg {
        ServerMessage::PerfLogging(p) => assert!(p.enabled),
        other => panic!("expected PerfLogging, got {other:?}"),
    }
}

//! Real-sidecar integration test for the `settings.update` frame (Task z7j7-3):
//! mid-session model/permissionMode/effort changes for freshclaude/kilroy. The
//! Rust adapter (`claude.rs::handle_send`) writes
//! `{"type":"settings.update","sessionId",…,"model"?,"permissionMode"?,"effort"?}`
//! to the sidecar's stdin BEFORE the following `send`; the sidecar must route it
//! to the SDK Query's control methods (`setPermissionMode`/`setModel`/
//! `applyFlagSettings`) on a per-session serialized op chain so the update is
//! fully applied BEFORE the user turn enters the SDK's streaming input — and it
//! must refuse invalid knobs loudly (`sdk.error`, nothing applied) and bound
//! every control call at 10s (a never-answering SDK surface emits `sdk.error`
//! and releases the chain, never a wedge).
//!
//! Staging pattern copied from `claude_sidecar_interrupt_dispatch.rs`: the REAL
//! sidecar modules (`index.mjs` + `permission-channel.mjs`) are copied VERBATIM
//! into a temp dir with a stub `node_modules/@anthropic-ai/claude-agent-sdk`
//! whose `query()` returns a recording control surface and consumes the prompt
//! boundary (logging every pushed user message). Only module RESOLUTION is
//! redirected — every dispatched line of JS is the real source, read at test
//! time. The pre-fix failure signature: stderr
//! `unknown request type: settings.update` and no control calls logged.
//!
//! Requires `node` on PATH — the same requirement the crate's existing
//! fake-sidecar tests already impose.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Recording stub SDK: `query()` logs every control call and every prompt-
/// boundary user message to `FRESHELL_TEST_STUB_SDK_LOG` (newline-JSON). The
/// async iterator never yields (a parked open turn — the session stays live in
/// the sidecar's map). `FRESHELL_TEST_STUB_STALL_APPLY=1` makes
/// `applyFlagSettings` never resolve (the 10s control-call bound's stall arm).
const STUB_SDK_INDEX: &str = r#"
import fs from 'node:fs'

const logPath = process.env.FRESHELL_TEST_STUB_SDK_LOG
const stallApply = process.env.FRESHELL_TEST_STUB_STALL_APPLY === '1'
function log(row) {
  try { fs.appendFileSync(logPath, JSON.stringify(row) + '\n') } catch { /* best effort */ }
}

export function query({ prompt }) {
  ;(async () => {
    for await (const msg of prompt) {
      log({ input: msg?.message?.content?.[0]?.text ?? null })
    }
  })().catch(() => {})
  return {
    setModel: async (model) => { log({ call: 'setModel', model }) },
    setPermissionMode: async (mode) => { log({ call: 'setPermissionMode', mode }) },
    applyFlagSettings: async (settings) => {
      log({ call: 'applyFlagSettings', settings })
      if (stallApply) await new Promise(() => {})
    },
    interrupt: async () => {},
    close: async () => {},
    [Symbol.asyncIterator]: async function* () { await new Promise(() => {}) },
  }
}
"#;

const STUB_SDK_PACKAGE_JSON: &str = r#"{
  "name": "@anthropic-ai/claude-agent-sdk",
  "version": "0.0.0-test-stub",
  "type": "module",
  "main": "index.mjs"
}
"#;

/// Read one real sidecar module verbatim (`index.mjs` or its sibling
/// `permission-channel.mjs`, which `index.mjs` imports by relative path — both
/// must be present in the staged dir for ESM resolution to succeed).
fn real_sidecar_source(module: &str) -> String {
    let path = format!(
        "{}/../freshell-claude-sidecar/{module}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read the real crates/freshell-claude-sidecar/{module}: {e}"))
}

struct StagedSidecar {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<(&'static str, String)>,
    stub_log: std::path::PathBuf,
}

/// Stage the real sidecar + stub SDK into `dir` and spawn it, wiring the
/// tagged stdout/stderr reader threads (so the main thread can always poll
/// with timeouts — a pre-fix hang fails the test, never blocks it). Starts
/// with an empty stub log.
fn spawn_staged_sidecar(dir: &tempfile::TempDir, stall_apply: bool) -> StagedSidecar {
    std::fs::write(
        dir.path().join("index.mjs"),
        real_sidecar_source("index.mjs"),
    )
    .expect("copy real index.mjs verbatim");
    std::fs::write(
        dir.path().join("permission-channel.mjs"),
        real_sidecar_source("permission-channel.mjs"),
    )
    .expect("copy real permission-channel.mjs verbatim");
    let sdk_dir = dir
        .path()
        .join("node_modules/@anthropic-ai/claude-agent-sdk");
    std::fs::create_dir_all(&sdk_dir).expect("create stub sdk dir");
    std::fs::write(sdk_dir.join("package.json"), STUB_SDK_PACKAGE_JSON).expect("stub package");
    std::fs::write(sdk_dir.join("index.mjs"), STUB_SDK_INDEX).expect("stub entry");
    let stub_log = dir.path().join("stub-sdk.log");
    std::fs::write(&stub_log, "").expect("init stub log");

    let mut cmd = Command::new("node");
    cmd.arg(dir.path().join("index.mjs"))
        .env("FRESHELL_TEST_STUB_SDK_LOG", &stub_log)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stall_apply {
        cmd.env("FRESHELL_TEST_STUB_STALL_APPLY", "1");
    }
    let mut child = cmd
        .spawn()
        .expect("spawn node with the real sidecar source (node is required by this crate's tests)");

    let (tx, rx) = mpsc::channel::<(&'static str, String)>();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let tx_out = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx_out.send(("stdout", line)).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx.send(("stderr", line)).is_err() {
                break;
            }
        }
    });
    let stdin = child.stdin.take().expect("piped stdin");
    StagedSidecar {
        child,
        stdin,
        rx,
        stub_log,
    }
}

/// One pumped line folded into the capture (stdout parsed as newline-JSON).
struct Capture {
    stdout: Vec<serde_json::Value>,
    stderr: Vec<String>,
}

fn pump(sc: &StagedSidecar, cap: &mut Capture, timeout: Duration) -> bool {
    match sc.rx.recv_timeout(timeout) {
        Ok(("stdout", line)) => {
            cap.stdout
                .push(serde_json::from_str(&line).expect("sidecar stdout is newline-JSON"));
            true
        }
        Ok(("stderr", line)) => {
            cap.stderr.push(line);
            true
        }
        Ok((other, line)) => panic!("unexpected channel tag {other}: {line}"),
        Err(_) => false,
    }
}

/// Gate on the sidecar's `ready` startup log, then write the `create` frame and
/// answer with the `created.sessionId` (fails with the captured stderr on any
/// pre-condition miss).
fn create_session(sc: &mut StagedSidecar, cap: &mut Capture) -> String {
    let ready_deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < ready_deadline,
            "sidecar never logged ready; stderr so far: {:?}",
            cap.stderr
        );
        if !pump(sc, cap, Duration::from_secs(30)) {
            continue;
        }
        if cap.stderr.iter().any(|l| l.contains("ready")) {
            break;
        }
    }
    write_frame(
        &mut sc.stdin,
        &serde_json::json!({ "type": "create", "requestId": "r1", "cwd": "/tmp" }),
    );
    let frame = await_stdout_type(sc, cap, "created", Duration::from_secs(30));
    frame["sessionId"]
        .as_str()
        .expect("created carries a sessionId")
        .to_string()
}

fn write_frame(stdin: &mut ChildStdin, frame: &serde_json::Value) {
    stdin
        .write_all(frame.to_string().as_bytes())
        .expect("write frame");
    stdin.write_all(b"\n").expect("write newline");
    stdin.flush().expect("flush frame");
}

/// Bounded-wait for a stdout frame of the given newline-JSON `type`.
fn await_stdout_type(
    sc: &StagedSidecar,
    cap: &mut Capture,
    wanted: &str,
    budget: Duration,
) -> serde_json::Value {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(found) = cap
            .stdout
            .iter()
            .find(|f| f["type"].as_str() == Some(wanted))
        {
            return found.clone();
        }
        if Instant::now() >= deadline {
            break;
        }
        if !pump(sc, cap, deadline.saturating_duration_since(Instant::now())) {
            break;
        }
    }
    panic!(
        "no stdout frame of type {wanted} within budget; stdout: {:?}\nstderr: {:?}",
        cap.stdout, cap.stderr
    );
}

fn stub_rows(stub_log: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(stub_log)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("stub log line is JSON"))
        .collect()
}

/// Bounded-poll the stub log until it holds at least `min` rows.
fn poll_stub_log(
    stub_log: &std::path::Path,
    min: usize,
    budget: Duration,
) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + budget;
    loop {
        let rows = stub_rows(stub_log);
        if rows.len() >= min {
            return rows;
        }
        assert!(
            Instant::now() < deadline,
            "stub SDK log never reached {min} row(s); rows so far: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// The core proof (acceptance 1): the SDK control calls land BEFORE the user
/// message, in the sidecar's exact production apply order. A `settings.update
/// {model, permissionMode, effort}` drives `setPermissionMode` → `setModel` →
/// `applyFlagSettings` on the serialized per-session op chain, all strictly
/// ahead of the pushed user turn (asserted as the stub log's full ordered
/// sequence); the post-apply `sdk.session.metadata` echoes the new baseline.
#[test]
fn settings_update_control_calls_land_before_the_user_message() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let mut sc = spawn_staged_sidecar(&dir, false);
    let mut cap = Capture {
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    let session_id = create_session(&mut sc, &mut cap);

    write_frame(
        &mut sc.stdin,
        &serde_json::json!({
            "type": "settings.update",
            "sessionId": session_id,
            "model": "opus-y",
            "permissionMode": "plan",
            "effort": "xhigh",
        }),
    );
    write_frame(
        &mut sc.stdin,
        &serde_json::json!({ "type": "send", "sessionId": session_id, "text": "hello" }),
    );

    let rows = poll_stub_log(&sc.stub_log, 4, Duration::from_secs(30));
    // Assert the FULL stub-log sequence, exactly and in order — not merely
    // "every control call precedes the input". The relative control-call
    // order asserted here is the production-implemented apply order in
    // index.mjs's `handleSettingsUpdate` op: setPermissionMode → setModel →
    // applyFlagSettings (each 10s-bounded on the per-session serialized
    // chain), THEN the user message crosses the prompt boundary. A silent
    // reorder of the control calls is a behavior change and must fail here,
    // not pass as a refactor.
    assert_eq!(
        rows,
        vec![
            serde_json::json!({"call":"setPermissionMode","mode":"plan"}),
            serde_json::json!({"call":"setModel","model":"opus-y"}),
            serde_json::json!({"call":"applyFlagSettings","settings":{"effortLevel":"xhigh"}}),
            serde_json::json!({"input":"hello"}),
        ],
        "control calls must land in the production-implemented order \
         (setPermissionMode → setModel → applyFlagSettings), all before the user message"
    );

    let metadata = await_stdout_type(
        &sc,
        &mut cap,
        "sdk.session.metadata",
        Duration::from_secs(10),
    );
    assert_eq!(metadata["sessionId"], serde_json::json!(session_id));
    assert_eq!(
        metadata["model"],
        serde_json::json!("opus-y"),
        "the post-apply metadata echoes the new baseline: {metadata}"
    );
    assert!(
        !cap.stderr
            .iter()
            .any(|l| l.contains("unknown request type")),
        "the settings.update frame must be dispatched (never the default arm); stderr: {:?}",
        cap.stderr
    );

    sc.child.kill().ok();
    sc.child.wait().ok();
}

/// The sidecar validates incoming knobs BEFORE applying anything (defense in
/// depth on the internal frame; Rust validates too): an invalid effort refuses
/// the WHOLE update loudly on `sdk.error` — no `applyFlagSettings` call — and
/// the session keeps working (a following send is processed).
#[test]
fn settings_update_with_an_invalid_effort_is_refused_loudly() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let mut sc = spawn_staged_sidecar(&dir, false);
    let mut cap = Capture {
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    let session_id = create_session(&mut sc, &mut cap);

    write_frame(
        &mut sc.stdin,
        &serde_json::json!({
            "type": "settings.update",
            "sessionId": session_id,
            "effort": "bogus",
        }),
    );
    let refused = await_stdout_type(&sc, &mut cap, "sdk.error", Duration::from_secs(10));
    assert!(
        refused["message"]
            .as_str()
            .unwrap_or_default()
            .contains("effort"),
        "the refusal names the rejected knob: {refused}"
    );

    // The session is unaffected: a following user turn is processed...
    write_frame(
        &mut sc.stdin,
        &serde_json::json!({ "type": "send", "sessionId": session_id, "text": "after refusal" }),
    );
    let rows = poll_stub_log(&sc.stub_log, 1, Duration::from_secs(30));
    let input = rows
        .iter()
        .position(|r| *r == serde_json::json!({"input":"after refusal"}))
        .unwrap_or_else(|| panic!("the post-refusal send was dropped; rows: {rows:?}"));
    let _ = input;
    // ...and NOTHING was applied for the refused update.
    assert!(
        !rows.iter().any(|r| r["call"] == "applyFlagSettings"),
        "an invalid effort must never reach applyFlagSettings; rows: {rows:?}"
    );
    assert!(
        !rows
            .iter()
            .any(|r| r["call"] == "setModel" || r["call"] == "setPermissionMode"),
        "nothing else may be applied by a refused update; rows: {rows:?}"
    );

    sc.child.kill().ok();
    sc.child.wait().ok();
}

/// Every control call is 10s-bounded: a never-answering `applyFlagSettings`
/// emits `sdk.error` and RELEASES the per-session chain — a following `send`
/// is still processed (never a wedge).
#[test]
fn a_stalled_control_call_times_out_and_releases_the_op_chain() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let mut sc = spawn_staged_sidecar(&dir, true);
    let mut cap = Capture {
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    let session_id = create_session(&mut sc, &mut cap);

    write_frame(
        &mut sc.stdin,
        &serde_json::json!({
            "type": "settings.update",
            "sessionId": session_id,
            "effort": "high",
        }),
    );
    // The stalled call IS attempted (its entry row lands at call time)...
    let rows = poll_stub_log(&sc.stub_log, 1, Duration::from_secs(30));
    assert_eq!(
        rows[0],
        serde_json::json!({"call":"applyFlagSettings","settings":{"effortLevel":"high"}}),
        "rows: {rows:?}"
    );
    // ...then the 10s bound fires: an sdk.error surfaces (never silence).
    let timed_out = await_stdout_type(&sc, &mut cap, "sdk.error", Duration::from_secs(25));
    assert!(
        timed_out["message"]
            .as_str()
            .unwrap_or_default()
            .contains("timed out"),
        "the bound names the timeout: {timed_out}"
    );
    // The chain released: a following send reaches the prompt boundary.
    write_frame(
        &mut sc.stdin,
        &serde_json::json!({ "type": "send", "sessionId": session_id, "text": "after stall" }),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = stub_rows(&sc.stub_log);
        if rows
            .iter()
            .any(|r| *r == serde_json::json!({"input":"after stall"}))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the post-stall send never reached the prompt — the op chain stayed wedged; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    sc.child.kill().ok();
    sc.child.wait().ok();
}

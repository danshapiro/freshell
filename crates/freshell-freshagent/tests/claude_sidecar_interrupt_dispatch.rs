//! Regression test for the freshclaude Stop/Interrupt silent no-op: the REAL
//! sidecar (`crates/freshell-claude-sidecar/index.mjs`) defines `handleInterrupt`
//! but its stdin dispatch switch historically only routed `create`/`send`/`shutdown`,
//! so the `{"type":"interrupt",...}` frame the Rust adapter writes
//! (`claude.rs::handle_interrupt`) fell into `default: logerr('unknown request
//! type: ...')` and was dropped — the user's Stop click did nothing. The crate's
//! unit tests all use a FAKE sidecar (embedded JS that handles `interrupt`),
//! which is exactly how this real-sidecar gap slipped past them.
//!
//! This test spawns the REAL `index.mjs` source with `node` and drives its stdin
//! directly. The `@anthropic-ai/claude-agent-sdk` dependency is vendored via
//! `npm install` into the sidecar package's own node_modules and is NOT present
//! in a plain checkout/CI, so the test copies the real sidecar modules (`index.mjs`
//! and its Task 1 sibling `permission-channel.mjs`) VERBATIM into a temp dir with a
//! stub `node_modules/@anthropic-ai/claude-agent-sdk` that satisfies only the
//! top-level `import { query }` (the interrupt-dispatch path under test never calls
//! `query()`; the stub throws if it is called). Only module RESOLUTION is redirected
//! — every dispatched line of JS is the real source, read at test time.
//!
//! Observable contract (fire-and-forget interrupt, per the comment above
//! `handleInterrupt`): an interrupt for an unknown session emits an
//! `sdk.error "session not found"` frame on stdout. Pre-fix behavior was a
//! stderr `unknown request type: interrupt` log and NO stdout frame.
//!
//! Requires `node` on PATH — the same requirement the crate's existing
//! fake-sidecar tests already impose.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Stub SDK entry: satisfies `import { query } from '@anthropic-ai/claude-agent-sdk'`
/// without the vendored dependency. The interrupt-dispatch path never calls it.
const STUB_SDK_INDEX: &str = "export function query() {\n  throw new Error('test stub: query() must not be called by the interrupt-dispatch test')\n}\n";

const STUB_SDK_PACKAGE_JSON: &str = r#"{
  "name": "@anthropic-ai/claude-agent-sdk",
  "version": "0.0.0-test-stub",
  "type": "module",
  "main": "index.mjs"
}
"#;

/// Read one real sidecar module verbatim (`index.mjs` or its Task 1 sibling
/// `permission-channel.mjs`, which `index.mjs` imports by relative path — both must
/// be present in the staged dir for ESM resolution to succeed).
fn real_sidecar_source(module: &str) -> String {
    let path = format!(
        "{}/../freshell-claude-sidecar/{module}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read the real crates/freshell-claude-sidecar/{module}: {e}"))
}

#[test]
fn real_sidecar_dispatches_interrupt_frames_to_handle_interrupt() {
    let dir = tempfile::tempdir().expect("create temp dir");
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
    std::fs::write(
        dir.path().join("session-settings.mjs"),
        real_sidecar_source("session-settings.mjs"),
    )
    .expect("copy real session-settings.mjs verbatim");
    let sdk_dir = dir
        .path()
        .join("node_modules/@anthropic-ai/claude-agent-sdk");
    std::fs::create_dir_all(&sdk_dir).expect("create stub sdk dir");
    std::fs::write(sdk_dir.join("package.json"), STUB_SDK_PACKAGE_JSON).expect("stub package");
    std::fs::write(sdk_dir.join("index.mjs"), STUB_SDK_INDEX).expect("stub entry");

    let mut child = Command::new("node")
        .arg(dir.path().join("index.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node with the real sidecar source (node is required by this crate's tests)");

    // Reader threads: forward each line with a tag so the main thread can poll
    // with timeouts (the pre-fix failure mode is "no stdout frame ever arrives",
    // which must fail the test, not hang it).
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

    // Gate on the sidecar's startup log so the interrupt frame is never written
    // before the dispatch loop is armed.
    let mut stderr_lines: Vec<String> = Vec::new();
    let ready = loop {
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(("stderr", line)) => {
                let is_ready = line.contains("ready");
                stderr_lines.push(line);
                if is_ready {
                    break true;
                }
            }
            Ok((_, line)) => panic!("unexpected stdout frame before any request: {line}"),
            Err(_) => break false,
        }
    };
    assert!(
        ready,
        "sidecar never logged ready; stderr so far: {stderr_lines:?}"
    );

    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin
        .write_all(b"{\"type\":\"interrupt\",\"sessionId\":\"nope\"}\n")
        .expect("write interrupt frame");
    stdin.flush().expect("flush interrupt frame");

    // Post-fix observable: handleInterrupt emits the session-not-found sdk.error
    // frame on stdout. Pre-fix: the frame is dropped by the `default:` arm and
    // stderr logs `unknown request type: interrupt` instead.
    let mut error_frame: Option<serde_json::Value> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while error_frame.is_none() {
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            break;
        };
        match rx.recv_timeout(remaining) {
            Ok(("stdout", line)) => {
                error_frame =
                    Some(serde_json::from_str(&line).expect("sidecar stdout is newline-JSON"));
            }
            Ok((_, line)) => stderr_lines.push(line),
            Err(_) => break,
        }
    }

    child.kill().ok();
    child.wait().ok();

    assert!(
        !stderr_lines
            .iter()
            .any(|l| l.contains("unknown request type: interrupt")),
        "pre-fix behavior: the interrupt frame fell into the dispatch default arm and was \
         dropped; stderr: {stderr_lines:?}"
    );
    let frame = error_frame.expect(
        "no stdout frame arrived: the interrupt request was not dispatched to handleInterrupt",
    );
    assert_eq!(frame["type"], "sdk.error", "frame: {frame}");
    assert_eq!(frame["sessionId"], "nope", "frame: {frame}");
    assert_eq!(frame["message"], "session not found", "frame: {frame}");
}

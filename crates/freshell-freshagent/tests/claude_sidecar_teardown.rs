//! How a Claude Node sidecar is stopped (`freshell_freshagent::claude_spawn`).
//!
//! These tests drive small fake sidecars written in Node, so they run on every
//! platform the desktop app ships on: Linux in the Rust gate, and Windows and
//! macOS in the `electron-build` workflow (the crate's unit tests do not
//! compile on Windows, so the cross-platform behavior lives in this
//! integration target). They need `node` on PATH (or `FRESHELL_CLAUDE_NODE`),
//! like the crate's other sidecar tests.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use freshell_freshagent::claude_spawn::{graceful_then_kill, SIDECAR_GRACEFUL_EXIT};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

/// Honors the protocol like `index.mjs`: the shutdown line ends the process
/// with exit 0. Its SIGTERM handler records that a signal was needed.
const FAKE_HONORS_SHUTDOWN: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n'); process.exit(143) })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') {
    fs.appendFileSync(out, 'shutdown-handled\n')
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

/// A wedged sidecar: ignores the shutdown line and stdin EOF, but still
/// exits on SIGTERM (recording it).
const FAKE_IGNORES_SHUTDOWN: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n'); process.exit(143) })
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

/// Ignores the shutdown line, stdin EOF, and SIGTERM: only SIGKILL ends it.
#[cfg(unix)]
const FAKE_IGNORES_SIGTERM: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n') })
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

fn node() -> String {
    std::env::var("FRESHELL_CLAUDE_NODE").unwrap_or_else(|_| "node".to_string())
}

/// Spawn a fake sidecar and wait until it has installed its handlers.
async fn spawn_fake(script: &str, record: &Path) -> (Child, ChildStdin, ChildStdout) {
    let mut child = tokio::process::Command::new(node())
        .arg("-e")
        .arg(script)
        .arg(record)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the fake sidecar with node");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .expect("the fake sidecar announces readiness")
        .expect("read the fake sidecar's stdout");
    assert_eq!(ready.as_deref(), Some("ready"));
    (child, stdin, lines.into_inner().into_inner())
}

fn record_of(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[tokio::test]
async fn a_sidecar_that_honors_shutdown_exits_gracefully_without_a_signal() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (child, stdin, _stdout) = spawn_fake(FAKE_HONORS_SHUTDOWN, &record).await;

    let exit = graceful_then_kill(child, stdin, SIDECAR_GRACEFUL_EXIT).await;

    assert!(
        exit.graceful,
        "the shutdown line alone stopped the sidecar: {exit:?}"
    );
    assert!(
        exit.elapsed < SIDECAR_GRACEFUL_EXIT,
        "a graceful exit returns within the grace period: {exit:?}"
    );
    assert!(
        exit.status.is_some_and(|status| status.success()),
        "the sidecar exited 0 by itself: {exit:?}"
    );
    assert_eq!(
        record_of(&record),
        "shutdown-handled\n",
        "only the shutdown handler ran; no signal was sent"
    );
}

#[tokio::test]
async fn a_sidecar_that_ignores_shutdown_is_escalated_after_the_grace_period() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (child, stdin, _stdout) = spawn_fake(FAKE_IGNORES_SHUTDOWN, &record).await;
    let grace = Duration::from_millis(400);

    let exit = graceful_then_kill(child, stdin, grace).await;

    assert!(
        !exit.graceful,
        "the sidecar ignored the shutdown line: {exit:?}"
    );
    assert!(
        exit.elapsed >= grace,
        "no signal is sent before the grace period ends: {exit:?}"
    );
    assert!(
        exit.elapsed < grace + Duration::from_secs(3),
        "escalation is bounded: {exit:?}"
    );
    assert!(
        exit.status.is_some(),
        "the sidecar is dead and reaped: {exit:?}"
    );
    #[cfg(unix)]
    assert_eq!(
        record_of(&record),
        "sigterm\n",
        "the escalation starts with SIGTERM (the sidecar's own graceful handler)"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_sidecar_that_ignores_sigterm_is_killed() {
    use std::os::unix::process::ExitStatusExt;

    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (child, stdin, _stdout) = spawn_fake(FAKE_IGNORES_SIGTERM, &record).await;
    let grace = Duration::from_millis(300);

    let exit = graceful_then_kill(child, stdin, grace).await;

    assert!(!exit.graceful, "{exit:?}");
    assert_eq!(
        exit.status.and_then(|status| status.signal()),
        Some(libc_sigkill()),
        "SIGKILL ended the TERM-immune sidecar: {exit:?}"
    );
    assert!(
        exit.elapsed < grace + Duration::from_secs(3),
        "escalation is bounded: {exit:?}"
    );
    assert_eq!(
        record_of(&record),
        "sigterm\n",
        "SIGTERM came before SIGKILL"
    );
}

#[cfg(unix)]
fn libc_sigkill() -> i32 {
    9
}

//! # claude_spawn — how a Claude Node child process is stopped
//!
//! The freshclaude/kilroy sidecar (`crates/freshell-claude-sidecar/index.mjs`)
//! owns an SDK query, and the SDK owns the real `claude` CLI grandchild. The
//! only way to stop that CLI cleanly is to let the sidecar abort its query:
//! the sidecar's `shutdown` handler (and its stdin-EOF and SIGTERM handlers)
//! abort the query, which kills the CLI, and then exit 0. A probe against the
//! pinned CLI (plan §3.1) measured node exiting about 24 ms after the shutdown
//! line and the CLI about 126 ms after it. Killing node hard instead leaves
//! the CLI running the in-flight turn until that turn ends.
//!
//! [`graceful_then_kill`] therefore asks first and escalates only when node
//! has not exited within the grace period.

use std::process::ExitStatus;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::time::Instant;

/// How long a sidecar gets to exit on its own after the shutdown line (about
/// fifteen times the measured graceful exit).
pub const SIDECAR_GRACEFUL_EXIT: Duration = Duration::from_secs(2);

/// The sidecar protocol's shutdown request (`index.mjs`: `case 'shutdown'`).
pub const SHUTDOWN_REQUEST: &[u8] = b"{\"type\":\"shutdown\"}\n";

/// After the escalation's SIGTERM, how long node gets before SIGKILL.
#[cfg(unix)]
const ESCALATION_TERM_WAIT: Duration = Duration::from_millis(250);

/// After SIGKILL, the bound on reaping node's exit status.
const KILL_REAP_BUDGET: Duration = Duration::from_secs(2);

/// What happened when a sidecar was stopped.
#[derive(Debug)]
pub struct SidecarExit {
    /// Node exited by itself within the grace period after the shutdown
    /// request (no signal was needed).
    pub graceful: bool,
    /// Wall time from the shutdown request to node's reaped exit.
    pub elapsed: Duration,
    /// Node's exit status, or `None` when even the SIGKILL reap timed out.
    pub status: Option<ExitStatus>,
}

/// Stop a sidecar: write the shutdown request and close its stdin, wait up
/// to `grace` for node to exit, and only then escalate (on Unix SIGTERM, then
/// SIGKILL 250 ms later; on Windows TerminateProcess). Never fails: every step is best-effort and
/// the returned [`SidecarExit`] says what actually happened.
pub async fn graceful_then_kill(
    mut child: Child,
    stdin: ChildStdin,
    grace: Duration,
) -> SidecarExit {
    let started = Instant::now();
    let deadline = started + grace;
    request_shutdown(stdin, deadline).await;
    if let Ok(Ok(status)) = tokio::time::timeout_at(deadline, child.wait()).await {
        return SidecarExit {
            graceful: true,
            elapsed: started.elapsed(),
            status: Some(status),
        };
    }
    let status = escalate(&mut child).await;
    SidecarExit {
        graceful: false,
        elapsed: started.elapsed(),
        status,
    }
}

/// Write the shutdown line and close stdin (EOF is the sidecar's second
/// shutdown trigger). Bounded by `deadline`: a wedged node with a full stdin
/// pipe must not hang the teardown. A write error means node's stdin is
/// already gone; the exit wait that follows decides what happened.
async fn request_shutdown(mut stdin: ChildStdin, deadline: Instant) {
    let write = async {
        stdin.write_all(SHUTDOWN_REQUEST).await?;
        stdin.flush().await
    };
    let _ = tokio::time::timeout_at(deadline, write).await;
    drop(stdin);
}

/// SIGTERM (Unix only; the sidecar's SIGTERM handler is another graceful
/// path), then SIGKILL, then reap.
async fn escalate(child: &mut Child) -> Option<ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: `pid` is this child's own, still-unreaped process id.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        if let Ok(Ok(status)) = tokio::time::timeout(ESCALATION_TERM_WAIT, child.wait()).await {
            return Some(status);
        }
    }
    let _ = child.start_kill();
    match tokio::time::timeout(KILL_REAP_BUDGET, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        _ => None,
    }
}

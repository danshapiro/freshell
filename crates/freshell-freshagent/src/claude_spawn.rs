//! # claude_spawn — how a Claude Node child process is started and stopped
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
//! [`graceful_then_kill`] therefore asks first and escalates only when the
//! tree has not exited within the grace period. [`spawn_guarded`] starts the
//! child inside a [`SidecarTreeGuard`] so that whatever escalation is needed
//! reaches the whole tree on every platform, not just node:
//!
//! - **Unix** (Linux and macOS): the child leads its own process group
//!   (`process_group(0)`); the SDK spawns the CLI non-detached, so the CLI
//!   shares that group. Escalation signals the group, and "the tree is gone"
//!   means no live process is left in it (on Linux zombies are not counted;
//!   they hold no pipes and write nothing).
//! - **Windows**: the child is created suspended, assigned to a
//!   kill-on-close Job Object (`freshell_platform::process_job`), and only
//!   then resumed, so every process it starts is born in the job.
//!   Escalation terminates the job, and "the tree is gone" means the job has
//!   no active process. If the job cannot be created or assigned, the child
//!   runs unguarded and `freshagent.claude.tree_guard_unavailable` is logged.
//! - Dropping the guard (an early-return path, a panic, a dropped session)
//!   kills whatever is left of the tree (Windows: closing the job handle does
//!   it too), so no path leaks the CLI.
//!
//! On Linux the stronger, start-time-checked `/proc` ownership-tag
//! confirmation in `claude.rs` still runs on top of this.

use std::process::ExitStatus;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
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

/// When the tree outlives its drain window: how long it gets after SIGTERM
/// before SIGKILL.
#[cfg(unix)]
const TREE_TERM_WAIT: Duration = Duration::from_millis(100);

/// After the tree was killed, the bound on waiting for every member to go.
const TREE_KILL_SETTLE: Duration = Duration::from_secs(2);

/// How often the guard re-checks whether any tree member is still alive.
const TREE_POLL: Duration = Duration::from_millis(10);

/// What the process-tree guard established about the sidecar's descendants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeConfirmation {
    /// Every process of the tree is gone.
    Confirmed,
    /// Tree members were still alive when the bounded wait ended.
    Lingering,
    /// There is no guard (it could not be created, or a test built the
    /// session by hand), so nothing beyond node itself can be confirmed.
    Unguarded,
}

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
    /// Whether the rest of the tree (the CLI) is confirmed gone too.
    pub tree: TreeConfirmation,
}

/// Stop a sidecar: write the shutdown request and close its stdin, wait up
/// to `grace` for node to exit, and only then escalate (on Unix SIGTERM to
/// the tree, then SIGKILL 250 ms later; on Windows termination). When node
/// exits by itself, the rest of its tree gets what is left of `grace` to
/// follow before the guard kills it. Never fails: every step is best-effort
/// and the returned [`SidecarExit`] says what actually happened.
pub async fn graceful_then_kill(
    mut child: Child,
    stdin: ChildStdin,
    mut guard: SidecarTreeGuard,
    grace: Duration,
) -> SidecarExit {
    let started = Instant::now();
    let deadline = started + grace;
    request_shutdown(stdin, deadline).await;
    if let Ok(Ok(status)) = tokio::time::timeout_at(deadline, child.wait()).await {
        let drain = deadline.saturating_duration_since(Instant::now());
        let tree = guard.settle(drain).await;
        return SidecarExit {
            graceful: true,
            elapsed: started.elapsed(),
            status: Some(status),
            tree,
        };
    }
    let (status, tree) = escalate(&mut child, &mut guard).await;
    SidecarExit {
        graceful: false,
        elapsed: started.elapsed(),
        status,
        tree,
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
/// path), then SIGKILL, then reap; the guard carries both to the whole tree.
async fn escalate(
    child: &mut Child,
    guard: &mut SidecarTreeGuard,
) -> (Option<ExitStatus>, TreeConfirmation) {
    #[cfg(unix)]
    {
        if guard.is_guarded() {
            guard.signal_tree(libc::SIGTERM);
        } else if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
            // SAFETY: `pid` is this child's own, still-unreaped process id.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        if let Ok(Ok(status)) = tokio::time::timeout(ESCALATION_TERM_WAIT, child.wait()).await {
            // The CLI got the same SIGTERM; it gets the same window to go.
            return (Some(status), guard.settle(ESCALATION_TERM_WAIT).await);
        }
    }
    guard.kill_tree(child).await
}

/// Spawn `command` inside a [`SidecarTreeGuard`] so its whole process tree
/// can be killed. The caller configures program, arguments, environment and
/// stdio; this adds only the tree ownership. An error is the spawn's own.
pub fn spawn_guarded(command: &mut Command) -> std::io::Result<(Child, SidecarTreeGuard)> {
    #[cfg(unix)]
    {
        command.process_group(0);
        let child = command.spawn()?;
        let guard = match child.id().and_then(|pid| i32::try_from(pid).ok()) {
            Some(pgid) => SidecarTreeGuard {
                tree: Tree::ProcessGroup { pgid, gone: false },
            },
            None => {
                tree_guard_unavailable("the spawned child has no process id");
                SidecarTreeGuard::unguarded()
            }
        };
        Ok((child, guard))
    }
    #[cfg(windows)]
    {
        spawn_in_job(command)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let child = command.spawn()?;
        Ok((child, SidecarTreeGuard::unguarded()))
    }
}

/// Windows: create the child suspended, assign it to a fresh kill-on-close
/// job, then resume it. A guard failure leaves the child running unguarded
/// (logged); only a failure to resume it fails the spawn, because a child
/// that stays suspended can never run.
#[cfg(windows)]
fn spawn_in_job(command: &mut Command) -> std::io::Result<(Child, SidecarTreeGuard)> {
    use freshell_platform::process_job::{
        resume_suspended_process, KillOnCloseJob, CREATE_SUSPENDED,
    };

    let job = match KillOnCloseJob::new() {
        Ok(job) => job,
        Err(error) => {
            tree_guard_unavailable(&format!("job object creation failed: {error}"));
            let child = command.spawn()?;
            return Ok((child, SidecarTreeGuard::unguarded()));
        }
    };
    command.creation_flags(CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    let Some(process_id) = child.id() else {
        let _ = child.start_kill();
        return Err(std::io::Error::other(
            "the suspended child exited before it could be assigned",
        ));
    };
    let guard = match job.assign_process(process_id) {
        Ok(()) => SidecarTreeGuard {
            tree: Tree::Job { job, gone: false },
        },
        Err(error) => {
            tree_guard_unavailable(&format!("job assignment failed: {error}"));
            SidecarTreeGuard::unguarded()
        }
    };
    if let Err(error) = resume_suspended_process(process_id) {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok((child, guard))
}

fn tree_guard_unavailable(cause: &str) {
    tracing::error!(target: "freshell_freshagent::claude",
        event = "freshagent.claude.tree_guard_unavailable",
        cause,
        "the Claude child runs without a process-tree guard; only node itself can be killed"
    );
}

/// Owns a spawned child's whole process tree (see the module docs). Drop
/// kills whatever is left of the tree.
pub struct SidecarTreeGuard {
    tree: Tree,
}

enum Tree {
    None,
    /// `gone` is set once the group is confirmed empty, so a later drop
    /// never signals a process-group id the system may have reused.
    #[cfg(unix)]
    ProcessGroup {
        pgid: i32,
        gone: bool,
    },
    /// Closing the job's last handle (dropping it) kills every process
    /// still in it.
    #[cfg(windows)]
    Job {
        job: freshell_platform::process_job::KillOnCloseJob,
        gone: bool,
    },
}

impl std::fmt::Debug for SidecarTreeGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.tree {
            Tree::None => formatter.write_str("SidecarTreeGuard(unguarded)"),
            #[cfg(unix)]
            Tree::ProcessGroup { pgid, gone } => {
                write!(formatter, "SidecarTreeGuard(pgid {pgid}, gone {gone})")
            }
            #[cfg(windows)]
            Tree::Job { gone, .. } => write!(formatter, "SidecarTreeGuard(job, gone {gone})"),
        }
    }
}

impl SidecarTreeGuard {
    /// No guard: for a child spawned without [`spawn_guarded`] (tests) or
    /// when the guard could not be created.
    pub fn unguarded() -> Self {
        Self { tree: Tree::None }
    }

    pub fn is_guarded(&self) -> bool {
        !matches!(self.tree, Tree::None)
    }

    /// The process group that holds the tree.
    #[cfg(unix)]
    pub fn process_group(&self) -> Option<i32> {
        match self.tree {
            Tree::ProcessGroup { pgid, .. } => Some(pgid),
            Tree::None => None,
        }
    }

    /// How many processes of the tree are alive in its job (`None` when
    /// unguarded or when the job cannot be queried).
    #[cfg(windows)]
    pub fn active_processes(&self) -> Option<u32> {
        match &self.tree {
            Tree::Job { job, .. } => job.active_processes().ok(),
            Tree::None => None,
        }
    }

    /// Wait up to `drain` for the tree to exit by itself, then kill what is
    /// left (Unix: SIGTERM, SIGKILL 100 ms later) and wait (bounded) until
    /// nothing is left. Call it after node itself has been reaped.
    pub async fn settle(&mut self, drain: Duration) -> TreeConfirmation {
        if !self.is_guarded() {
            return TreeConfirmation::Unguarded;
        }
        if self.wait_gone(drain).await {
            return TreeConfirmation::Confirmed;
        }
        #[cfg(unix)]
        {
            self.signal_tree(libc::SIGTERM);
            if self.wait_gone(TREE_TERM_WAIT).await {
                return TreeConfirmation::Confirmed;
            }
        }
        self.kill_now();
        if self.wait_gone(TREE_KILL_SETTLE).await {
            TreeConfirmation::Confirmed
        } else {
            TreeConfirmation::Lingering
        }
    }

    /// Kill the whole tree now, including `child` (node), reap `child`, and
    /// wait (bounded) until nothing of the tree is left.
    pub async fn terminate(&mut self, child: &mut Child) -> TreeConfirmation {
        self.kill_tree(child).await.1
    }

    async fn kill_tree(&mut self, child: &mut Child) -> (Option<ExitStatus>, TreeConfirmation) {
        self.kill_now();
        let _ = child.start_kill();
        let status = match tokio::time::timeout(KILL_REAP_BUDGET, child.wait()).await {
            Ok(Ok(status)) => Some(status),
            _ => None,
        };
        if !self.is_guarded() {
            return (status, TreeConfirmation::Unguarded);
        }
        let tree = if self.wait_gone(TREE_KILL_SETTLE).await {
            TreeConfirmation::Confirmed
        } else {
            TreeConfirmation::Lingering
        };
        (status, tree)
    }

    /// Poll until no tree member is alive (marking the guard spent) or
    /// `budget` elapses.
    async fn wait_gone(&mut self, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            if !self.tree_alive() {
                self.mark_gone();
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(TREE_POLL).await;
        }
    }

    fn tree_alive(&self) -> bool {
        match &self.tree {
            Tree::None => false,
            #[cfg(unix)]
            Tree::ProcessGroup { gone: true, .. } => false,
            #[cfg(unix)]
            Tree::ProcessGroup { pgid, gone: false } => process_group_alive(*pgid),
            #[cfg(windows)]
            Tree::Job { gone: true, .. } => false,
            // A failed query counts as alive: the bounded wait then ends
            // as Lingering rather than claiming a confirmation.
            #[cfg(windows)]
            Tree::Job { job, gone: false } => job.active_processes().map_or(true, |n| n > 0),
        }
    }

    fn mark_gone(&mut self) {
        match &mut self.tree {
            Tree::None => {}
            #[cfg(unix)]
            Tree::ProcessGroup { gone, .. } => *gone = true,
            #[cfg(windows)]
            Tree::Job { gone, .. } => *gone = true,
        }
    }

    /// Hard-kill every process still in the tree.
    fn kill_now(&self) {
        #[cfg(unix)]
        self.signal_tree(libc::SIGKILL);
        #[cfg(windows)]
        if let Tree::Job { job, gone: false } = &self.tree {
            if let Err(error) = job.terminate() {
                tracing::warn!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.tree_terminate_failed",
                    cause = %error,
                    "the Claude child's job could not be terminated; closing it still kills the tree"
                );
            }
        }
    }

    #[cfg(unix)]
    fn signal_tree(&self, signal: i32) {
        if let Tree::ProcessGroup { pgid, gone: false } = self.tree {
            // SAFETY: a negative pid targets the group this guard created.
            // `gone` is set as soon as the group is observed empty, and the
            // system never reuses a group id while any member is alive.
            unsafe {
                libc::kill(-pgid, signal);
            }
        }
    }
}

impl Drop for SidecarTreeGuard {
    fn drop(&mut self) {
        self.kill_now();
    }
}

/// Whether any live (non-zombie) process remains in process group `pgid`.
#[cfg(unix)]
fn process_group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    let probed = unsafe { libc::kill(-pgid, 0) };
    if probed != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        // The group exists; it is alive only if a member is not a zombie
        // (an orphan waiting for a reaper that may never come in a
        // container without one).
        linux_group_has_live_member(pgid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(target_os = "linux")]
fn linux_group_has_live_member(pgid: i32) -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        // Cannot look: the existence probe above is the answer.
        return true;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .filter(|name| name.bytes().all(|b| b.is_ascii_digit()))
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // `comm` may hold spaces or parentheses: fields resume after the
        // last ')' with field 3 (state), then ppid, then pgrp.
        let Some(rest) = stat.rsplit(')').next() else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let state = fields.next();
        let group = fields.nth(1).and_then(|group| group.parse::<i32>().ok());
        if group == Some(pgid) && !matches!(state, Some("Z") | Some("X")) {
            return true;
        }
    }
    false
}

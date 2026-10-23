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
//!   means no live process is left in it. On Linux a zombie is not counted
//!   once its last thread has ended (it holds no pipes and writes nothing),
//!   but one whose main thread alone ended still runs and is counted.
//! - **Windows**: the child is created suspended, assigned to a
//!   kill-on-close Job Object (`freshell_platform::process_job`), and only
//!   then resumed, so every process it starts is born in the job.
//!   Escalation terminates the job, and "the tree is gone" means the job has
//!   no active process AND every process the guard saw in it has exited (its
//!   handle is signaled, as node's is once reaped). The job stops counting a
//!   process as soon as it starts to exit, a few milliseconds (more for a
//!   large process) before Windows has finished that exit, and may stop
//!   listing it then too. So when a stop begins the guard records the job's members
//!   and has the job report every process that joins it from then on, and
//!   at every check it watches the members reported since, even one already
//!   exiting (`freshell_platform::process_job::JobMembers`). If the job
//!   cannot be created or assigned, the child runs unguarded and
//!   `freshagent.claude.tree_guard_unavailable` is logged.
//! - Dropping the guard (an early-return path, a panic, a dropped session)
//!   kills whatever is left of the tree (Windows: closing the job handle does
//!   it too), so no path leaks the CLI.
//!
//! On Linux the stronger, start-time-checked `/proc` ownership-tag
//! confirmation in `claude.rs` still runs on top of this.
//!
//! [`ClaudeNodeCommand`] is the one recipe for launching a Claude Node child
//! (the session sidecar and the model-catalog probe), so the two can never
//! drift apart in node binary, run-as wrapper, managed secrets, the OneCLI
//! key flag, or the provider exec check (audit G30).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::Instant;

/// How long a sidecar gets to exit on its own after the shutdown line (about
/// fifteen times the measured graceful exit).
pub const SIDECAR_GRACEFUL_EXIT: Duration = Duration::from_secs(2);

/// The grace period when the whole server stops. Its stop (WS drain,
/// terminals, every provider's sidecars, the codex launch manager, the
/// layout flush) must finish inside freshell-server's 5 s hard ceiling
/// (`SHUTDOWN_HARD_TIMEOUT`), so the claude sidecars get half a session's
/// grace: still about forty times the measured graceful exit, and the real
/// sidecar's SIGTERM handler is the same graceful stop.
pub const SERVER_STOP_GRACE: Duration = Duration::from_secs(1);

/// The ownership tag a sidecar and its claude CLI grandchild carry (the codex
/// analog is `FRESHELL_CODEX_SIDECAR_ID`); the Linux `/proc` reaper keys on
/// it, and the SDK's clean env passes it through to the CLI.
pub const CLAUDE_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_CLAUDE_SIDECAR_ID";

/// Tells the sidecar's clean env (`sdk-env.mjs`) to keep the managed
/// `ANTHROPIC_API_KEY` for the SDK instead of stripping it.
const ONECLI_API_KEY_FLAG: &str = "FRESHELL_CLAUDE_ONECLI_API_KEY";

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

/// How node ended once its stop began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarStop {
    /// Node exited 0 within the grace period after the shutdown request: its
    /// shutdown handler ran (it aborts the SDK query, which stops the CLI)
    /// and no signal was needed.
    Graceful,
    /// Node exited within the grace period, but not with status 0. It
    /// crashed on its way down (for example on a write to a stdout nobody
    /// reads any more), so nothing may have stopped the CLI; the guard
    /// killed the rest of the tree at once.
    AbnormalExit,
    /// Node was still running when the grace period ended and was signaled.
    Forced,
}

impl SidecarStop {
    /// The log label (`freshagent.claude.teardown`'s `stop`).
    pub fn label(self) -> &'static str {
        match self {
            Self::Graceful => "graceful",
            Self::AbnormalExit => "abnormal_exit",
            Self::Forced => "forced",
        }
    }
}

/// What happened when a sidecar was stopped.
#[derive(Debug)]
pub struct SidecarExit {
    /// How node ended.
    pub stop: SidecarStop,
    /// Wall time of the whole stop: from the shutdown request until node
    /// was reaped and the guard settled the rest of the tree.
    pub elapsed: Duration,
    /// Node's exit status, or `None` when even the SIGKILL reap timed out.
    pub status: Option<ExitStatus>,
    /// Whether the rest of the tree (the CLI) is confirmed gone too.
    pub tree: TreeConfirmation,
}

impl SidecarExit {
    /// Node stopped on the shutdown request alone.
    pub fn graceful(&self) -> bool {
        self.stop == SidecarStop::Graceful
    }
}

/// How a Claude Node child (`node <entry>`) is launched. Built from the
/// process environment and the managed child secrets ([`Self::new`]), or
/// from injected parts in tests ([`Self::from_parts`]).
pub struct ClaudeNodeCommand {
    entry: PathBuf,
    node: String,
    run_as_ids: Option<(String, String)>,
    secrets: Option<BTreeMap<String, String>>,
    run_as: bool,
    managed_environment: bool,
    ownership_tag: Option<String>,
    closed_stdin: bool,
    complete_environment: Option<Vec<(String, String)>>,
    freshell_endpoint: Option<freshell_platform::freshell_context_env::FreshellEndpoint>,
}

impl ClaudeNodeCommand {
    /// `node <entry>` from the live process: `FRESHELL_CLAUDE_NODE` (default
    /// `node`), `FRESHELL_PROVIDER_RUN_AS_UID`/`_GID`, and the managed child
    /// secrets installed by the session host (none in the default server).
    pub fn new(entry: impl Into<PathBuf>) -> Self {
        Self::from_parts(
            entry,
            &|name| std::env::var(name).ok(),
            freshell_platform::managed_child_secrets::snapshot().cloned(),
        )
    }

    /// The same recipe with the environment and secrets injected.
    pub fn from_parts(
        entry: impl Into<PathBuf>,
        env: &dyn Fn(&str) -> Option<String>,
        secrets: Option<BTreeMap<String, String>>,
    ) -> Self {
        Self {
            entry: entry.into(),
            node: env("FRESHELL_CLAUDE_NODE").unwrap_or_else(|| "node".to_string()),
            run_as_ids: env("FRESHELL_PROVIDER_RUN_AS_UID")
                .zip(env("FRESHELL_PROVIDER_RUN_AS_GID")),
            secrets,
            run_as: false,
            managed_environment: false,
            ownership_tag: None,
            closed_stdin: false,
            complete_environment: None,
            freshell_endpoint: None,
        }
    }

    /// Give the child the managed secrets, plus the OneCLI key flag when
    /// they carry `ANTHROPIC_API_KEY`, and run the provider exec check on
    /// the final command before spawning (Linux, managed mode).
    pub fn with_managed_environment(mut self) -> Self {
        self.managed_environment = true;
        self
    }

    /// Wrap node in `setpriv` when the provider run-as ids are configured.
    pub fn with_run_as(mut self) -> Self {
        self.run_as = true;
        self
    }

    /// Tag the child (and, through the SDK's clean env, its CLI) for the
    /// Linux `/proc` ownership reaper.
    pub fn with_ownership_tag(mut self, ownership_id: &str) -> Self {
        self.ownership_tag = Some(ownership_id.to_string());
        self
    }

    /// When `Some`, the child's complete environment: it replaces the one the
    /// child would inherit from this process (the test rigs give each sidecar
    /// exactly its own). The ownership tag, the OneCLI key flag and the managed
    /// secrets still layer over it. `None` keeps the inherited environment.
    pub fn with_complete_environment(mut self, environment: Option<&[(String, String)]>) -> Self {
        self.complete_environment = environment.map(<[(String, String)]>::to_vec);
        self
    }

    /// When `Some`, the child reaches this server through `endpoint` (G19):
    /// it gets `FRESHELL=1`, `FRESHELL_URL` and `FRESHELL_TOKEN`, and none of
    /// the pane-scoped names (`FRESHELL_TERMINAL_ID`, `FRESHELL_TAB_ID`,
    /// `FRESHELL_PANE_ID`) it would otherwise inherit, for example from a
    /// server that itself runs inside a Freshell terminal: its session's pane
    /// arrives with the `create` line. `None` leaves those names alone.
    pub fn with_freshell_endpoint(
        mut self,
        endpoint: Option<&freshell_platform::freshell_context_env::FreshellEndpoint>,
    ) -> Self {
        self.freshell_endpoint = endpoint.cloned();
        self
    }

    /// The child reads no stdin (the catalog probe); the default is a pipe.
    pub fn with_closed_stdin(mut self) -> Self {
        self.closed_stdin = true;
        self
    }

    /// The node binary this command runs (for error messages).
    pub fn node(&self) -> &str {
        &self.node
    }

    fn run_as_ids(&self) -> Option<&(String, String)> {
        self.run_as_ids.as_ref().filter(|_| self.run_as)
    }

    fn managed_secrets(&self) -> Option<&BTreeMap<String, String>> {
        self.secrets.as_ref().filter(|_| self.managed_environment)
    }

    /// The fully configured, not yet spawned command: program and wrapper,
    /// environment overlay, piped stdout/stderr, `kill_on_drop`.
    pub fn command(&self) -> Command {
        let mut command = match self.run_as_ids() {
            Some((uid, gid)) => {
                let mut command = Command::new("/usr/bin/setpriv");
                command.args([
                    "--reuid",
                    uid,
                    "--regid",
                    gid,
                    "--clear-groups",
                    "--no-new-privs",
                    "--",
                    &self.node,
                ]);
                command
            }
            None => Command::new(&self.node),
        };
        command.arg(&self.entry);
        if let Some(environment) = &self.complete_environment {
            command.env_clear();
            command.envs(environment.iter().map(|(key, value)| (key, value)));
        }
        if let Some(endpoint) = &self.freshell_endpoint {
            use freshell_platform::freshell_context_env as context;
            for name in context::FRESHELL_PANE_CONTEXT_ENV_VARS {
                command.env_remove(name);
            }
            command.envs(context::freshell_context_env(endpoint, None, None, None));
        }
        if let Some(ownership_id) = &self.ownership_tag {
            command.env(CLAUDE_SIDECAR_OWNERSHIP_ENV, ownership_id);
        }
        if let Some(secrets) = self.managed_secrets() {
            if secrets.contains_key("ANTHROPIC_API_KEY") {
                command.env(ONECLI_API_KEY_FLAG, "1");
            }
            command.envs(secrets);
        }
        command
            .stdin(if self.closed_stdin {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    /// Check (managed mode, Linux) and spawn the command inside its
    /// process-tree guard.
    pub fn spawn_guarded(self) -> Result<(Child, SidecarTreeGuard), ClaudeSpawnError> {
        let mut command = self.command();
        #[cfg(target_os = "linux")]
        if self.managed_secrets().is_some() {
            let wrapper_targets = [self.node.as_str()];
            let additional: &[&str] = if self.run_as_ids().is_some() {
                &wrapper_targets
            } else {
                &[]
            };
            freshell_platform::provider_exec::check_command(command.as_std(), true, additional)
                .map_err(|error| ClaudeSpawnError::ExecProfile(error.to_string()))?;
        }
        spawn_guarded(&mut command).map_err(ClaudeSpawnError::Spawn)
    }
}

/// Why [`ClaudeNodeCommand::spawn_guarded`] did not start the child.
#[derive(Debug)]
pub enum ClaudeSpawnError {
    /// The managed provider exec check refused the final command (its
    /// classification; never the command's contents).
    ExecProfile(String),
    /// The operating system could not start the process.
    Spawn(std::io::Error),
}

impl std::fmt::Display for ClaudeSpawnError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ExecProfile(classification) => formatter.write_str(classification),
            Self::Spawn(error) => write!(formatter, "{error}"),
        }
    }
}

/// Stop a sidecar: write the shutdown request and close its stdin, wait up
/// to `grace` for node to exit, and only then escalate (on Unix SIGTERM to
/// the tree, then SIGKILL 250 ms later; on Windows termination). When node
/// exits 0 by itself, the rest of its tree gets what is left of `grace` to
/// follow before the guard kills it; when node exits any other way, its
/// shutdown handler may not have run, so the guard kills the rest of the
/// tree at once. Never fails: every step is best-effort and the returned
/// [`SidecarExit`] says what actually happened.
pub async fn graceful_then_kill(
    mut child: Child,
    stdin: ChildStdin,
    mut guard: SidecarTreeGuard,
    grace: Duration,
) -> SidecarExit {
    let started = Instant::now();
    let deadline = started + grace;
    // Before anything can end a member (node's exit can: on Windows node
    // keeps the children it spawns in a kill-on-close job of its own).
    guard.watch_members();
    request_shutdown(stdin, deadline).await;
    if let Ok(Ok(status)) = tokio::time::timeout_at(deadline, child.wait()).await {
        let (stop, drain) = if status.success() {
            (
                SidecarStop::Graceful,
                deadline.saturating_duration_since(Instant::now()),
            )
        } else {
            (SidecarStop::AbnormalExit, Duration::ZERO)
        };
        let tree = guard.settle(drain).await;
        return SidecarExit {
            stop,
            elapsed: started.elapsed(),
            status: Some(status),
            tree,
        };
    }
    let (status, tree) = escalate(&mut child, &mut guard).await;
    SidecarExit {
        stop: SidecarStop::Forced,
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
        resume_suspended_process, JobMembers, KillOnCloseJob, CREATE_SUSPENDED,
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
            tree: Tree::Job {
                job,
                members: JobMembers::default(),
                gone: false,
            },
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
    /// still in it. `members` holds the processes seen in it, which must
    /// have exited too before the tree is gone (see the module docs).
    #[cfg(windows)]
    Job {
        job: freshell_platform::process_job::KillOnCloseJob,
        members: freshell_platform::process_job::JobMembers,
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

    /// Windows: start watching every process in the job not watched yet,
    /// and (the first time) every process that joins it from now on (see
    /// the module docs). Nothing to do elsewhere: the process group is
    /// checked as a whole.
    fn watch_members(&mut self) {
        #[cfg(windows)]
        if let Tree::Job {
            job,
            members,
            gone: false,
        } = &mut self.tree
        {
            if let Err(error) = members.record(job) {
                tracing::warn!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.tree_members_unwatched",
                    cause = %error,
                    "the Claude child's job members could not be watched; the tree stays unconfirmed until they can"
                );
            }
        }
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

    fn tree_alive(&mut self) -> bool {
        match &mut self.tree {
            Tree::None => false,
            #[cfg(unix)]
            Tree::ProcessGroup { gone: true, .. } => false,
            #[cfg(unix)]
            Tree::ProcessGroup { pgid, gone: false } => process_group_alive(*pgid),
            #[cfg(windows)]
            Tree::Job { gone: true, .. } => false,
            // Alive while the job counts an active process or a member it
            // held has not finished exiting (see the module docs). A failed
            // query counts as alive: the bounded wait then ends as Lingering
            // rather than claiming a confirmation.
            #[cfg(windows)]
            Tree::Job {
                job,
                members,
                gone: false,
            } => members
                .record(job)
                .and_then(|()| Ok(job.active_processes()? > 0 || members.any_running()?))
                .unwrap_or(true),
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
    fn kill_now(&mut self) {
        // While the job still lists them (Windows).
        self.watch_members();
        #[cfg(unix)]
        self.signal_tree(libc::SIGKILL);
        #[cfg(windows)]
        if let Tree::Job {
            job, gone: false, ..
        } = &self.tree
        {
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

/// Whether any live process remains in process group `pgid` (on Linux a
/// zombie is not live once its last thread has ended).
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
        // container without one) or is one that still has threads.
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
        // `comm` may hold spaces or parentheses: the fields resume after
        // the last ')' at field 3 (state). `proc(5)` numbers them from 1.
        let Some(rest) = stat.rsplit(')').next() else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        let field = |number: usize| fields.get(number - 3).copied();
        if field(5).and_then(|group| group.parse::<i32>().ok()) != Some(pgid) {
            continue;
        }
        let live = match field(3) {
            Some("X" | "x") => false,
            // `Z` is the main thread's state. The process has exited only
            // once no other thread (field 20 counts them) is left: one
            // whose main thread alone ended runs on, and a killed one's
            // other threads may still be finishing their exit.
            Some("Z") => field(20)
                .and_then(|threads| threads.parse::<u32>().ok())
                .is_none_or(|threads| threads > 1),
            _ => true,
        };
        if live {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const RUN_AS_ENV: [(&str, &str); 3] = [
        ("FRESHELL_PROVIDER_RUN_AS_UID", "1234"),
        ("FRESHELL_PROVIDER_RUN_AS_GID", "5678"),
        ("FRESHELL_CLAUDE_NODE", "/opt/node/bin/node"),
    ];

    fn env_from(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    fn managed_secrets() -> Option<BTreeMap<String, String>> {
        Some(BTreeMap::from([
            ("ANTHROPIC_API_KEY".to_string(), "sk-managed".to_string()),
            (
                "ONECLI_URL".to_string(),
                "http://127.0.0.1:10254".to_string(),
            ),
        ]))
    }

    fn program(command: &Command) -> String {
        command
            .as_std()
            .get_program()
            .to_string_lossy()
            .into_owned()
    }

    fn args(command: &Command) -> Vec<String> {
        command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    fn envs(command: &Command) -> BTreeMap<String, Option<String>> {
        command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    /// G30: the catalog probe launches node exactly as the session sidecar
    /// does (same program, run-as wrapper, OneCLI flag and managed secrets);
    /// only the entry file and the sidecar's ownership tag differ.
    #[test]
    fn the_sidecar_and_the_catalog_probe_launch_node_the_same_way() {
        let env = env_from(&RUN_AS_ENV);
        let sidecar = crate::claude::sidecar_node_command(
            ClaudeNodeCommand::from_parts("/srv/sidecar/index.mjs", &env, managed_secrets()),
            "claude-sidecar-parity",
        )
        .command();
        let probe = crate::model_capabilities::catalog_node_command(ClaudeNodeCommand::from_parts(
            "/srv/sidecar/model-catalog.mjs",
            &env,
            managed_secrets(),
        ))
        .command();

        assert_eq!(program(&sidecar), "/usr/bin/setpriv");
        assert_eq!(program(&probe), "/usr/bin/setpriv");
        let wrapper = [
            "--reuid",
            "1234",
            "--regid",
            "5678",
            "--clear-groups",
            "--no-new-privs",
            "--",
            "/opt/node/bin/node",
        ];
        assert_eq!(
            args(&sidecar),
            [&wrapper[..], &["/srv/sidecar/index.mjs"]].concat()
        );
        assert_eq!(
            args(&probe),
            [&wrapper[..], &["/srv/sidecar/model-catalog.mjs"]].concat()
        );
        let mut sidecar_env = envs(&sidecar);
        assert_eq!(
            sidecar_env.remove(CLAUDE_SIDECAR_OWNERSHIP_ENV),
            Some(Some("claude-sidecar-parity".to_string()))
        );
        let probe_env = envs(&probe);
        assert_eq!(sidecar_env, probe_env, "same flag and secrets for both");
        assert_eq!(
            probe_env.get("FRESHELL_CLAUDE_ONECLI_API_KEY"),
            Some(&Some("1".to_string()))
        );
        assert_eq!(
            probe_env.get("ANTHROPIC_API_KEY"),
            Some(&Some("sk-managed".to_string()))
        );
        assert_eq!(
            probe_env.get("ONECLI_URL"),
            Some(&Some("http://127.0.0.1:10254".to_string()))
        );
    }

    #[test]
    fn without_managed_mode_node_runs_directly_with_no_key() {
        let env = env_from(&[]);
        let probe = crate::model_capabilities::catalog_node_command(ClaudeNodeCommand::from_parts(
            "/srv/sidecar/model-catalog.mjs",
            &env,
            None,
        ))
        .command();

        assert_eq!(program(&probe), "node");
        assert_eq!(args(&probe), ["/srv/sidecar/model-catalog.mjs"]);
        assert!(envs(&probe).is_empty(), "{:?}", envs(&probe));
    }

    #[test]
    fn managed_secrets_without_the_api_key_do_not_select_it() {
        let env = env_from(&[]);
        let command = ClaudeNodeCommand::from_parts(
            "/srv/sidecar/index.mjs",
            &env,
            Some(BTreeMap::from([(
                "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                "managed-oauth".to_string(),
            )])),
        )
        .with_managed_environment()
        .command();

        let env = envs(&command);
        assert_eq!(
            env.get("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(&Some("managed-oauth".to_string()))
        );
        assert!(
            !env.contains_key("FRESHELL_CLAUDE_ONECLI_API_KEY"),
            "{env:?}"
        );
    }

    /// The test rigs give each sidecar exactly its own environment: a
    /// configured environment replaces the inherited one, and the ownership
    /// tag, the OneCLI key flag and the managed secrets still layer over it.
    #[test]
    fn a_complete_environment_replaces_the_inherited_one_under_the_overlay() {
        let env = env_from(&[]);
        let configured = [
            ("HOME".to_string(), "/rig/home".to_string()),
            ("ONECLI_URL".to_string(), "http://configured".to_string()),
        ];
        let command = crate::claude::sidecar_node_command(
            ClaudeNodeCommand::from_parts("/srv/sidecar/index.mjs", &env, managed_secrets()),
            "claude-sidecar-rig",
        )
        .with_complete_environment(Some(&configured))
        .command();

        let env = envs(&command);
        assert_eq!(env.get("HOME"), Some(&Some("/rig/home".to_string())));
        assert_eq!(
            env.get(CLAUDE_SIDECAR_OWNERSHIP_ENV),
            Some(&Some("claude-sidecar-rig".to_string()))
        );
        assert_eq!(
            env.get("ONECLI_URL"),
            Some(&Some("http://127.0.0.1:10254".to_string())),
            "the managed secrets win over the configured environment"
        );
        assert_eq!(
            env.get("FRESHELL_CLAUDE_ONECLI_API_KEY"),
            Some(&Some("1".to_string()))
        );
    }

    /// Nothing of the server's own environment reaches a child launched with
    /// a complete environment (here `env -0` stands in for node and prints
    /// what the child got).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_with_a_complete_environment_inherits_nothing() {
        let env = env_from(&[("FRESHELL_CLAUDE_NODE", "/usr/bin/env")]);
        let configured = [("HOME".to_string(), "/rig/home".to_string())];
        let output = ClaudeNodeCommand::from_parts("-0", &env, None)
            .with_complete_environment(Some(&configured))
            .with_closed_stdin()
            .command()
            .output()
            .await
            .expect("run env");
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "HOME=/rig/home\0");
    }

    /// G19: a sidecar reaches this server through the endpoint it is given,
    /// never through an inherited one, and inherits no other pane's ids (here
    /// `env -0` stands in for node and prints what the child got).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_gets_this_servers_endpoint_and_no_other_panes_ids() {
        let env = env_from(&[("FRESHELL_CLAUDE_NODE", "/usr/bin/env")]);
        let inherited = [
            ("HOME".to_string(), "/rig/home".to_string()),
            (
                "FRESHELL_URL".to_string(),
                "http://localhost:3001".to_string(),
            ),
            ("FRESHELL_TOKEN".to_string(), "outer-token".to_string()),
            (
                "FRESHELL_TERMINAL_ID".to_string(),
                "outer-terminal".to_string(),
            ),
            ("FRESHELL_TAB_ID".to_string(), "outer-tab".to_string()),
            ("FRESHELL_PANE_ID".to_string(), "outer-pane".to_string()),
        ];
        let endpoint =
            freshell_platform::freshell_context_env::FreshellEndpoint::local(4100, "this-token");
        let output = ClaudeNodeCommand::from_parts("-0", &env, None)
            .with_complete_environment(Some(&inherited))
            .with_freshell_endpoint(Some(&endpoint))
            .with_closed_stdin()
            .command()
            .output()
            .await
            .expect("run env");
        assert!(output.status.success(), "{output:?}");
        let mut got: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect();
        got.sort();
        assert_eq!(
            got,
            [
                "FRESHELL=1",
                "FRESHELL_TOKEN=this-token",
                "FRESHELL_URL=http://localhost:4100",
                "HOME=/rig/home",
            ]
        );
    }

    /// Without an endpoint the child's Freshell names are left as inherited.
    #[test]
    fn a_child_without_an_endpoint_keeps_its_freshell_names() {
        let env = env_from(&[]);
        let inherited = [("FRESHELL_TAB_ID".to_string(), "tab".to_string())];
        let command = ClaudeNodeCommand::from_parts("/srv/sidecar/index.mjs", &env, None)
            .with_complete_environment(Some(&inherited))
            .command();
        assert_eq!(
            envs(&command).get("FRESHELL_TAB_ID"),
            Some(&Some("tab".to_string()))
        );
        assert!(!envs(&command).contains_key("FRESHELL_URL"));
    }

    #[test]
    fn the_run_as_wrapper_needs_both_ids() {
        let env = env_from(&[("FRESHELL_PROVIDER_RUN_AS_UID", "1234")]);
        let command = ClaudeNodeCommand::from_parts("/srv/sidecar/index.mjs", &env, None)
            .with_run_as()
            .command();

        assert_eq!(program(&command), "node");
    }
}

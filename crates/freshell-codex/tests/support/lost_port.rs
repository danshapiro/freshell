//! A lost listen port: how a test start of the fake app-server copes with it.
//!
//! When the product starts the app-server, it chooses the port and releases
//! it before the fake binds it (`allocate_loopback_port`), so another socket
//! on the host can bind it first. The fake then records that it lost the port
//! and exits with its own status, 98 (`fake-app-server.mjs` `listen()`).
//! Whatever took the port may also answer the product's readiness probe
//! (another fake app-server, a `CodexRemoteProxy`). The start then fails in
//! some other way (a seeded start: its listener "is not a member of this
//! unit"), or it "succeeds" against that other app-server while its own fake
//! is still starting. So a start is judged by its own fake's record, never by
//! how the start ended:
//!
//! - Every fake a test starts through these helpers records whether it
//!   listened or lost its port, in a directory of its runtime's own
//!   ([`ListenRecords`], `FAKE_CODEX_LISTEN_RECORD_DIR`).
//! - After any outcome, the start waits (bounded) for that record while the
//!   attempt's processes may still write it. A start whose fake lost its port
//!   is rejected, whatever it returned, and is retried on a new port, at most
//!   [`LOST_PORT_ATTEMPTS`] times. Every other failure fails the test at
//!   once, and so does a start that answered while its own fake never said
//!   it listened.
//! - A planner stops a failed attempt at once, before its fake may have tried
//!   the port. A runtime a planner starts is therefore wrapped in
//!   [`ListenChecked`]: its start answers only once its fake's record says
//!   how the start went.
//!
//! A fake the product kills before it runs can record nothing: a seeded start
//! with a disabled store kills its launcher when the start fails, which a
//! probe answered on a taken port does within milliseconds. Such a start is
//! not retried.
//!
//! A test that starts the fake itself avoids the race altogether: the fake
//! binds a port the kernel chooses and reports it
//! ([`spawn_on_its_own_port`], `FAKE_CODEX_APP_SERVER_PORT_FILE`).
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use freshell_codex::launch_lifecycle::{
    CodexLaunchRuntime, CodexRuntimeReady, CodexTerminalLaunch, CodexTerminalLaunchManager,
    LaunchClass, SpawnedCodexAppServerRuntime,
};
use freshell_codex::launch_plan::{CodexLaunchPlanInput, CodexSidecarLaunchContext};
use freshell_codex::BoxFuture;
use freshell_containment::{AgentUnit, StopHandle, StopMode, StopReason, StopRequest, UNIT_ENV};

/// Where a fake records whether it listened (see [`ListenRecords`]).
pub const LISTEN_RECORD_DIR_ENV: &str = "FAKE_CODEX_LISTEN_RECORD_DIR";

/// Where a fake told to listen on port 0 reports the port it was given.
pub const PORT_FILE_ENV: &str = "FAKE_CODEX_APP_SERVER_PORT_FILE";

/// How a start begins its error when its fake recorded that it lost its
/// listen port. Only these helpers write it, from that record.
pub const LOST_PORT: &str = "the fake app-server lost its listen port";

/// Attempts per start. A lost port is rare (a few starts in ten thousand on a
/// busy host), so three in a row means something else is wrong.
pub const LOST_PORT_ATTEMPTS: u32 = 3;

/// How long a start waits for its fake's record while the attempt's
/// processes may still write it.
const LISTEN_RECORD_LIMIT: Duration = Duration::from_secs(10);

/// How long a rejected attempt's unit gets to reach Gone and be swept.
const REJECTED_STOP_LIMIT: Duration = Duration::from_secs(10);

/// How often the bounded waits here look again.
const POLL: Duration = Duration::from_millis(20);

/// Whether `error` says the start's fake lost its listen port.
pub fn lost_its_port(error: &impl std::fmt::Display) -> bool {
    error.to_string().contains(LOST_PORT)
}

/// Runs `attempt` until it succeeds, again only after a lost port and at most
/// [`LOST_PORT_ATTEMPTS`] times; any other failure (or a port lost on the
/// last attempt) panics with `what`, as `expect(what)` would. A failed attempt
/// leaves nothing of itself running: [`ready_attempt`] stops a rejected
/// attempt, and a planner stops a failed plan's attempt and confirms it Gone
/// before it answers.
pub async fn retrying_a_lost_port<T, E, Fut>(what: &str, mut attempt: impl FnMut() -> Fut) -> T
where
    E: std::fmt::Debug + std::fmt::Display,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut attempts = 0;
    loop {
        attempts += 1;
        match attempt().await {
            Ok(value) => return value,
            Err(error) if lost_its_port(&error) && attempts < LOST_PORT_ATTEMPTS => {
                eprintln!(
                    "{what}: the fake app-server lost its listen port on attempt {attempts} \
                     (another socket bound it first); retrying on a new port"
                );
            }
            Err(error) => panic!("{what}: {error:?}"),
        }
    }
}

/// The directory where the fakes one runtime starts record whether they
/// listened (`listen-<pid>.json`: `listening`, or `listenError` for a port
/// another socket took). A fake writes it before it answers anyone, or before
/// it exits on a taken port. Removed when dropped.
pub struct ListenRecords(tempfile::TempDir);

impl Default for ListenRecords {
    fn default() -> Self {
        Self::new()
    }
}

impl ListenRecords {
    pub fn new() -> Self {
        Self(tempfile::tempdir().expect("a listen record directory"))
    }

    pub fn path(&self) -> &Path {
        self.0.path()
    }

    /// `context` with this directory in its spawn environment.
    pub fn context(&self, mut context: CodexSidecarLaunchContext) -> CodexSidecarLaunchContext {
        context.env.insert(
            LISTEN_RECORD_DIR_ENV.to_string(),
            self.path().display().to_string(),
        );
        context
    }

    /// The records written so far.
    fn names(&self) -> BTreeSet<OsString> {
        std::fs::read_dir(self.path())
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.file_name())
            .filter(|name| {
                name.to_str()
                    .is_some_and(|name| name.starts_with("listen-") && name.ends_with(".json"))
            })
            .collect()
    }

    /// What the records written since `before` say, if anything. A lost port
    /// wins: a fake that lost its port never listened.
    fn said_since(&self, before: &BTreeSet<OsString>) -> Option<Fate> {
        let mut said = None;
        for name in self.names().difference(before) {
            let Ok(raw) = std::fs::read_to_string(self.path().join(name)) else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            if record["listenError"] == "EADDRINUSE" {
                return Some(Fate::LostPort);
            }
            if record["listening"] == true {
                said = Some(Fate::Listened);
            }
        }
        said
    }
}

/// What a start's own fake said about its port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fate {
    Listened,
    LostPort,
    /// Nothing, and nothing of the attempt is left to say it (or the wait
    /// ran out).
    Unsaid,
}

/// The processes of one attempt that may still write its record.
enum Writers {
    /// Every running process carrying the attempt's unit tag (placed or not
    /// yet placed in the unit: the tag is in its environment from its spawn).
    Unit(String),
    /// The runtime's own child, by pid and start time.
    Child(u32, u64),
    /// Not known: only the bound ends the wait.
    Unknown,
    /// None: a failed seedless start has killed its exact child and swept its
    /// ownership tag.
    Gone,
}

impl Writers {
    async fn of(attempt: &(impl AttemptRuntime + ?Sized), started: bool) -> Self {
        if let Some(unit) = attempt.runtime().unit() {
            return Self::Unit(unit.id().as_str().to_string());
        }
        if !started {
            return Self::Gone;
        }
        match attempt.child_pid().await {
            Some(pid) => freshell_containment::process::start_time(pid)
                .map_or(Self::Gone, |start| Self::Child(pid, start)),
            None => Self::Unknown,
        }
    }

    fn may_write(&self) -> bool {
        use freshell_containment::process::{all_pids, environ_value, is_running, start_time};
        match self {
            Self::Unit(id) => all_pids().into_iter().any(|pid| {
                environ_value(pid, UNIT_ENV).as_deref() == Some(id.as_str()) && is_running(pid)
            }),
            Self::Child(pid, start) => {
                is_running(*pid) && start_time(*pid).is_ok_and(|now| now == *start)
            }
            Self::Unknown => true,
            Self::Gone => false,
        }
    }
}

/// Waits (bounded) for what the attempt's fake records since `before`, while
/// any of `writers` may still write it.
async fn fate(records: &ListenRecords, before: &BTreeSet<OsString>, writers: Writers) -> Fate {
    let deadline = tokio::time::Instant::now() + LISTEN_RECORD_LIMIT;
    loop {
        if let Some(fate) = records.said_since(before) {
            return fate;
        }
        let writing = writers.may_write();
        // Read again after the writers: a fake records before it exits, so
        // one seen gone has said whatever it will say by now.
        if let Some(fate) = records.said_since(before) {
            return fate;
        }
        if !writing || tokio::time::Instant::now() >= deadline {
            return Fate::Unsaid;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// How one start went, judged by its own fake's record.
enum Verdict {
    /// What the runtime answered stands: its own fake served, or the start
    /// failed for a reason of its own.
    Stands(Result<CodexRuntimeReady, String>),
    /// What the runtime answered is not its own fake's start; the attempt is
    /// to be stopped.
    Rejected(String),
}

/// Judges `outcome`, the start of `attempt` begun when `records` held
/// `before`.
async fn judge(
    records: &ListenRecords,
    before: &BTreeSet<OsString>,
    attempt: &(impl AttemptRuntime + ?Sized),
    outcome: Result<CodexRuntimeReady, String>,
) -> Verdict {
    let writers = Writers::of(attempt, outcome.is_ok()).await;
    match (fate(records, before, writers).await, outcome) {
        (Fate::LostPort, outcome) => Verdict::Rejected(format!(
            "{LOST_PORT} (its own record says EADDRINUSE); the start {}",
            match outcome {
                Ok(ready) => format!("answered at {} for whatever took the port", ready.ws_url),
                Err(error) => format!("failed: {error}"),
            }
        )),
        (Fate::Unsaid, Ok(ready)) => Verdict::Rejected(format!(
            "the start answered at {} but its own fake app-server never said it listened \
             (did another app-server answer on its port?)",
            ready.ws_url
        )),
        (_, outcome) => Verdict::Stands(outcome),
    }
}

/// A start attempt's runtime as a test holds it.
pub trait AttemptRuntime: Send + Sync {
    fn runtime(&self) -> &dyn CodexLaunchRuntime;
    /// The spawned process, when the runtime says.
    fn child_pid(&self) -> BoxFuture<'_, Option<u32>>;
}

impl AttemptRuntime for SpawnedCodexAppServerRuntime {
    fn runtime(&self) -> &dyn CodexLaunchRuntime {
        self
    }

    fn child_pid(&self) -> BoxFuture<'_, Option<u32>> {
        Box::pin(SpawnedCodexAppServerRuntime::child_pid(self))
    }
}

impl AttemptRuntime for Arc<SpawnedCodexAppServerRuntime> {
    fn runtime(&self) -> &dyn CodexLaunchRuntime {
        self.as_ref()
    }

    fn child_pid(&self) -> BoxFuture<'_, Option<u32>> {
        Box::pin(SpawnedCodexAppServerRuntime::child_pid(self))
    }
}

impl AttemptRuntime for Arc<dyn CodexLaunchRuntime> {
    fn runtime(&self) -> &dyn CodexLaunchRuntime {
        self.as_ref()
    }

    fn child_pid(&self) -> BoxFuture<'_, Option<u32>> {
        Box::pin(async { None })
    }
}

/// One start of `runtime`, whose fakes record into `records`, judged by its
/// fake's record. A rejected attempt is gone before the error returns: a
/// seeded attempt's unit is stopped (straight through the unit, so a test's
/// recording lifecycle sees only the test's own stops) and confirmed Gone
/// with its leftover members swept; a seedless runtime tears its exact child
/// down.
pub async fn ready_attempt<R: AttemptRuntime>(
    runtime: R,
    records: &ListenRecords,
) -> Result<(R, CodexRuntimeReady), String> {
    let before = records.names();
    let outcome = runtime.runtime().ensure_ready(None).await;
    match judge(records, &before, &runtime, outcome).await {
        Verdict::Stands(outcome) => outcome.map(|ready| (runtime, ready)),
        Verdict::Rejected(why) => {
            stop_rejected(runtime.runtime()).await;
            Err(why)
        }
    }
}

/// Stops a rejected attempt: its unit to Gone and swept, or (seedless) its
/// exact child.
async fn stop_rejected(runtime: &dyn CodexLaunchRuntime) {
    match runtime.unit() {
        Some(unit) => {
            let stop = unit.stop(StopRequest::new(
                StopMode::Force,
                StopReason::StartCancelled,
                "test-rejected-start",
            ));
            tokio::time::timeout(REJECTED_STOP_LIMIT, async {
                stop.wait().await;
                stop.wait_swept().await
            })
            .await
            .expect("the rejected attempt's unit is Gone and swept");
        }
        None => {
            let _ = runtime
                .stop(
                    StopMode::Force,
                    StopReason::StartCancelled,
                    "test-rejected-start".to_string(),
                )
                .await;
        }
    }
}

/// Builds a runtime with `build` (given the record directory its context
/// must carry, [`ListenRecords::context`]) and starts it; after a lost port,
/// a new runtime (a new port; a seeded one also a new unit) tries again.
pub async fn ready_retrying_a_lost_port<R: AttemptRuntime>(
    what: &str,
    mut build: impl FnMut(&ListenRecords) -> R,
) -> (R, CodexRuntimeReady) {
    let records = ListenRecords::new();
    let records = &records;
    retrying_a_lost_port(what, || ready_attempt(build(records), records)).await
}

/// One Interactive plan of a single attempt, planned again only after a
/// lost port (the failed plan has stopped its attempt and confirmed it Gone).
/// The manager's runtimes are [`ListenChecked`].
pub async fn plan_retrying_a_lost_port(
    what: &str,
    manager: &CodexTerminalLaunchManager,
    input: &CodexLaunchPlanInput<'_>,
) -> CodexTerminalLaunch {
    retrying_a_lost_port(what, || {
        manager.plan_create_with_retry_uncancellable(input, 1, LaunchClass::Interactive)
    })
    .await
}

/// A spawned runtime, for a planner, whose start answers only once its own
/// fake's record says how the start went: a start whose fake lost its port
/// fails with [`LOST_PORT`] whatever the runtime answered, and a start that
/// answered while its fake never said it listened fails too. The planner
/// stops such an attempt as it stops any failed one. Everything else is the
/// runtime's own.
pub struct ListenChecked {
    runtime: Arc<SpawnedCodexAppServerRuntime>,
    records: ListenRecords,
}

impl ListenChecked {
    /// The runtime `build` makes from `context` plus a record directory of
    /// its own.
    pub fn build(
        context: CodexSidecarLaunchContext,
        build: impl FnOnce(CodexSidecarLaunchContext) -> SpawnedCodexAppServerRuntime,
    ) -> Arc<Self> {
        let records = ListenRecords::new();
        let runtime = Arc::new(build(records.context(context)));
        Arc::new(Self { runtime, records })
    }

    /// The wrapped runtime (its child, its unit, its record).
    pub fn spawned(&self) -> &Arc<SpawnedCodexAppServerRuntime> {
        &self.runtime
    }
}

impl CodexLaunchRuntime for ListenChecked {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            if self.runtime.child_pid().await.is_some() {
                // Already started: there is no new start to judge.
                return self.runtime.ensure_ready(cwd).await;
            }
            let before = self.records.names();
            let outcome = self.runtime.ensure_ready(cwd).await;
            match judge(&self.records, &before, &self.runtime, outcome).await {
                Verdict::Stands(outcome) => outcome,
                Verdict::Rejected(why) => Err(why),
            }
        })
    }

    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        self.runtime
            .update_ownership_metadata(terminal_id, generation)
    }

    fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
        self.runtime.note_session_id(session_id)
    }

    fn prepare_retention(&self, reason: String) -> BoxFuture<'_, Result<(), String>> {
        self.runtime.prepare_retention(reason)
    }

    fn stop(
        &self,
        mode: StopMode,
        reason: StopReason,
        initiator: String,
    ) -> BoxFuture<'_, Option<StopHandle>> {
        self.runtime.stop(mode, reason, initiator)
    }

    fn unit(&self) -> Option<AgentUnit> {
        self.runtime.unit()
    }

    fn reattached(&self) -> bool {
        self.runtime.reattached()
    }

    fn finish_after_gone(&self) -> BoxFuture<'_, ()> {
        self.runtime.finish_after_gone()
    }

    fn retainable(&self) -> BoxFuture<'_, bool> {
        self.runtime.retainable()
    }

    fn note_codex_home(&self, codex_home: String) -> BoxFuture<'_, ()> {
        self.runtime.note_codex_home(codex_home)
    }

    fn note_held_threads(&self, ids: Vec<String>) -> BoxFuture<'_, ()> {
        self.runtime.note_held_threads(ids)
    }

    fn forget_held_thread(&self, id: String) -> BoxFuture<'_, ()> {
        self.runtime.forget_held_thread(id)
    }
}

/// Starts the single-process fake app-server `fake` (`node
/// fake-app-server.mjs` with its other arguments) on a port the kernel
/// chooses as the fake binds it (`--listen ws://127.0.0.1:0` and a port
/// file), and returns it with that port once it listens. No other socket can
/// take the port first. Panics when the fake exits first or reports nothing
/// within 30 s.
pub async fn spawn_on_its_own_port(
    mut fake: tokio::process::Command,
) -> (tokio::process::Child, u16) {
    let port_file = tempfile::NamedTempFile::new().expect("a port file for the fake app-server");
    fake.args(["--listen", "ws://127.0.0.1:0"])
        .env(PORT_FILE_ENV, port_file.path());
    let mut child = fake.spawn().expect("spawn the fake app-server");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(port) = reported_port(port_file.path()) {
            return (child, port);
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("the fake app-server exited before it listened: {status}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fake app-server never reported the port it listens on"
        );
        tokio::time::sleep(POLL).await;
    }
}

/// The port a fake wrote to `port_file` once it listened (`<port>\n`;
/// nothing before).
pub fn reported_port(port_file: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(port_file).ok()?;
    raw.strip_suffix('\n')?
        .parse()
        .ok()
        .filter(|port| *port != 0)
}

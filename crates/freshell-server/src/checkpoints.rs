//! Code rewind checkpoints for FreshAgent panes. The routes here create, list,
//! annotate, and restore snapshots in a shadow bare Git repository under
//! `<home>/.freshell/checkpoints/<sha1-of-workspace-path>.git`; the source
//! repository's index, refs, and permissions are never changed.
//!
//! A pane carries checkpoint workspace intent separately from its launch/routing
//! cwd. Directory-picker selections can name a non-Git directory; an inferred
//! workspace resolves to the enclosing Git root. An account HOME is never an
//! implicit capture scope. Older checkpoint stores remain addressable by their
//! exact legacy cwd locator.
//!
//! Each create uses a request-local index, applies the workspace's Git ignore
//! rules, expands nested repositories and submodules into ordinary files, and
//! verifies that every selected regular file and symlink can be read. Metadata
//! is written before the shadow ref is advanced, and the ref update is the final
//! publication step. Restore and metadata routes accept only commits reachable
//! from the published ref, so failed/orphaned objects never become targets.
//!
//! The create response retains the legacy `{ id, ts, label, requestId? }` fields
//! and adds the resolved `{ path, provenance }` workspace locator. Expected
//! scope/readability failures return a stable code and user-safe details while
//! structured logs retain bounded internal cause and request correlation.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use axum::routing::get as get_method;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex, OwnedMutexGuard};

use freshell_protocol::{
    AgentProvider, CheckpointWorkspaceProvenance, FreshAgentCheckpointOutcome,
    FreshAgentCheckpointStatus, FreshAgentCheckpointWorkspace, FreshAgentSend, ServerMessage,
    SessionType,
};

use crate::boot::{is_authed, unauthorized};

/// `CHECKPOINT_LABEL_LIMIT` (`fresh-agent-extras-router.ts:349` inline `.slice(0,
/// 120)` on the label — mirrored here as a named constant for clarity, matching
/// the client's own `CHECKPOINT_LABEL_LIMIT` in `src/lib/fresh-agent-checkpoints.ts:6`).
/// NOTE: truncation here is by Unicode scalar value (Rust `char`), not by UTF-16
/// code unit as JS `String.prototype.slice` counts — astral-plane characters
/// (rare in a checkpoint label, which is derived from the outgoing message text)
/// would truncate one char later here than in JS. Not fixed: a byte-for-byte port
/// of JS's UTF-16 indexing has no ergonomic Rust equivalent and the divergence is
/// unobservable for the overwhelming majority of real labels (ASCII/BMP text).
const CHECKPOINT_LABEL_LIMIT: usize = 120;

/// `CHECKPOINT_IDENTITY` (`fresh-agent-extras-router.ts:73`): the shadow repo's
/// commit author/committer identity, so a checkpoint commit never depends on (or
/// pollutes) the real user's global git config.
const CHECKPOINT_IDENTITY: [&str; 4] = [
    "-c",
    "user.name=freshell",
    "-c",
    "user.email=checkpoints@freshell.local",
];

/// Shared state for the `/api/fresh-agent/checkpoints` route.
#[derive(Clone)]
pub struct CheckpointsApiState {
    pub auth_token: Arc<String>,
    /// The resolved home directory whose `.freshell/checkpoints/` holds every
    /// shadow repo (mirrors `os.homedir()` in `checkpointGitDir`,
    /// `fresh-agent-extras-router.ts:76`). `Arc`-shared, not re-resolved per
    /// request, matching this crate's convention for boot-resolved paths (see
    /// `main.rs`'s `session_metadata_dir`).
    pub home: Arc<PathBuf>,
    /// Same service instance used by the WebSocket local and managed send
    /// paths, so REST capture, listing and restore share workspace locks and
    /// durable attempt outcomes.
    pub service: Arc<CheckpointService>,
}

const CHECKPOINT_AUTO_BUDGET: Duration = Duration::from_secs(15);
const CHECKPOINT_EXPLICIT_BUDGET: Duration = Duration::from_secs(120);
const CHECKPOINT_TIMEOUT_COOLDOWN: Duration = Duration::from_secs(60);
const CHECKPOINT_COOLDOWN_LIMIT: usize = 128;
const CHECKPOINT_OUTCOME_STORE_VERSION: u8 = 1;
const CHECKPOINT_OUTCOME_STORE_LIMIT: usize = 8192;
const CHECKPOINT_DISPATCH_FENCE_LIMIT: usize = CHECKPOINT_OUTCOME_STORE_LIMIT;
const CHECKPOINT_VOLATILE_FENCE_LIMIT: usize = 1024;

#[derive(Clone, Copy)]
struct CheckpointAttemptFence {
    dispatch_started: bool,
    capture_settled: bool,
}

#[derive(Default)]
struct CheckpointOutcomeCache {
    outcomes: HashMap<String, StoredCheckpointOutcome>,
    snapshot_loaded: bool,
    store_file_observed: bool,
    snapshot_complete: bool,
}

impl CheckpointOutcomeCache {
    fn replace_from_store(&mut self, store: &CheckpointOutcomeStore) {
        self.snapshot_loaded = true;
        self.store_file_observed = true;
        self.snapshot_complete = store.outcomes.len() <= CHECKPOINT_DISPATCH_FENCE_LIMIT;
        self.outcomes = store
            .outcomes
            .iter()
            .take(CHECKPOINT_DISPATCH_FENCE_LIMIT)
            .map(|(key, record)| (key.clone(), record.clone()))
            .collect();
    }

    fn observe_absent_store(&mut self) {
        self.snapshot_loaded = true;
        self.snapshot_complete = true;
    }

    fn known_attempt(&self, key: &str) -> Option<CheckpointAttemptFence> {
        self.outcomes.get(key).map(|record| CheckpointAttemptFence {
            dispatch_started: record.dispatch_started,
            capture_settled: record.capture_settled,
        })
    }

    fn cached_outcome(&self, key: &str) -> Option<StoredCheckpointOutcome> {
        self.outcomes.get(key).cloned()
    }

    fn cached_outcomes(&self) -> BTreeMap<String, StoredCheckpointOutcome> {
        self.outcomes
            .iter()
            .map(|(key, outcome)| (key.clone(), outcome.clone()))
            .collect()
    }

    fn can_rule_out_unknown_attempt(&self) -> bool {
        self.snapshot_loaded && self.snapshot_complete
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCheckpointOutcome {
    version: u8,
    outcome: FreshAgentCheckpointOutcome,
    request_ids: Vec<String>,
    session_aliases: Vec<String>,
    #[serde(default)]
    dispatch_started: bool,
    #[serde(default = "capture_settled_by_default")]
    capture_settled: bool,
    submitted_turn_id: Option<String>,
    created_at_ms: u64,
}

fn capture_settled_by_default() -> bool {
    true
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointOutcomeStore {
    version: u8,
    outcomes: BTreeMap<String, StoredCheckpointOutcome>,
}

struct CheckpointAttemptJob {
    outcome: watch::Sender<Option<StoredCheckpointOutcome>>,
    finished: watch::Sender<bool>,
}

#[derive(Clone)]
struct CheckpointCooldown {
    expires_at: Instant,
}

struct CaptureRequestCancellation {
    sender: watch::Sender<bool>,
}

impl Drop for CaptureRequestCancellation {
    fn drop(&mut self) {
        self.sender.send_replace(true);
    }
}

enum ExplicitCaptureError {
    WorkspaceUnavailable(CheckpointWorkspaceUnavailable),
    ResolutionTimeout(String),
    WorkspaceBusy(ResolvedCheckpointWorkspace),
    Capture {
        workspace: ResolvedCheckpointWorkspace,
        message: String,
    },
    Unsettled {
        candidate: PathBuf,
        workspace: Option<ResolvedCheckpointWorkspace>,
        message: String,
    },
    Cancelled,
    ServiceStopped,
}

async fn wait_for_capture_cancellation(receiver: &mut watch::Receiver<bool>) {
    if !*receiver.borrow() {
        let _ = receiver.changed().await;
    }
}

async fn cancel_and_settle_capture_task<T>(
    control: &CheckpointCaptureControl,
    task: &mut tokio::task::JoinHandle<T>,
) -> Result<(), String> {
    if let Err(error) = control.cancel_processes().await {
        tracing::error!(
            event = "code_checkpoint.process_termination_failed",
            cause = %error,
            "checkpoint child termination was not confirmed"
        );
    }
    // Let the runner reap a killed direct child normally. If it is still in a
    // filesystem future after its process groups/jobs are gone, abort that
    // remaining future rather than letting it outlive the attempt deadline.
    if tokio::time::timeout(Duration::from_secs(1), &mut *task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
    control
        .wait_for_process_groups()
        .await
        .map_err(|error| error.to_string())
}

/// Shared checkpoint route/service state. Automatic WebSocket sends and the
/// explicit REST capture path use the same workspace serialization and
/// published shadow repository. Outcomes are persisted separately from the
/// checkpoint metadata patch, so a lost client connection can recover the
/// result after reattach.
pub struct CheckpointService {
    home: Arc<PathBuf>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    workspace_locks: StdMutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
    outcome_gate: Mutex<()>,
    attempt_jobs: Mutex<HashMap<String, Arc<CheckpointAttemptJob>>>,
    cooldowns: StdMutex<HashMap<PathBuf, CheckpointCooldown>>,
    durable_outcome_cache: StdMutex<CheckpointOutcomeCache>,
    volatile_outcomes: StdMutex<BTreeMap<String, StoredCheckpointOutcome>>,
    #[cfg(test)]
    test_capture_attempt_override: StdMutex<Option<CaptureAttempt>>,
}

tokio::task_local! {
    static CHECKPOINT_CAPTURE_CONTEXT: Arc<CheckpointCaptureControl>;
}

#[derive(Default)]
struct CheckpointCaptureControl {
    cancelled: AtomicBool,
    #[cfg(unix)]
    process_groups: StdMutex<HashSet<i32>>,
    #[cfg(windows)]
    jobs: StdMutex<Vec<Arc<WindowsJob>>>,
    #[cfg(test)]
    test_settlement_gate: StdMutex<Option<Arc<TestSettlementGate>>>,
}

#[cfg(test)]
struct TestSettlementGate {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl CheckpointCaptureControl {
    fn spawn_child(self: &Arc<Self>, command: &mut Command) -> std::io::Result<CheckpointChild> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let mut groups = self
                .process_groups
                .lock()
                .expect("checkpoint process group set poisoned");
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "checkpoint capture was cancelled",
                ));
            }
            command.as_std_mut().process_group(0);
            command.kill_on_drop(true);
            let child = command.spawn()?;
            let group = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .ok_or_else(|| {
                    std::io::Error::other("checkpoint child process has no process group id")
                })?;
            groups.insert(group);
            Ok(CheckpointChild {
                child: Some(child),
                control: Some(Arc::clone(self)),
                process_group: Some(group),
                #[cfg(windows)]
                job: None,
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

            let mut jobs = self.jobs.lock().expect("checkpoint job list poisoned");
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "checkpoint capture was cancelled",
                ));
            }
            let job = Arc::new(WindowsJob::new()?);
            command.as_std_mut().creation_flags(CREATE_SUSPENDED);
            command.kill_on_drop(true);
            let mut child = command.spawn()?;
            let process_id = child.id().ok_or_else(|| {
                std::io::Error::other("checkpoint child process has no process id")
            })?;
            if let Err(error) = job.assign_suspended_process(process_id) {
                job.terminate();
                let _ = child.start_kill();
                return Err(error);
            }
            jobs.push(Arc::clone(&job));
            Ok(CheckpointChild {
                child: Some(child),
                control: Some(Arc::clone(self)),
                process_group: None,
                job: Some(job),
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "checkpoint capture was cancelled",
                ));
            }
            command.kill_on_drop(true);
            let child = command.spawn()?;
            Ok(CheckpointChild {
                child: Some(child),
                control: Some(Arc::clone(self)),
                process_group: None,
                #[cfg(windows)]
                job: None,
            })
        }
    }

    async fn cancel_processes(&self) -> std::io::Result<()> {
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            let groups = self
                .process_groups
                .lock()
                .expect("checkpoint process group set poisoned")
                .iter()
                .copied()
                .collect::<Vec<_>>();
            for group in &groups {
                signal_process_group(*group, libc::SIGTERM);
            }
            if !groups.is_empty() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            for group in groups {
                signal_process_group(group, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let jobs = self
                .jobs
                .lock()
                .expect("checkpoint job list poisoned")
                .clone();
            for job in jobs {
                job.terminate();
            }
        }
        Ok(())
    }

    async fn wait_for_process_groups(&self) -> std::io::Result<()> {
        #[cfg(test)]
        let test_gate = {
            self.test_settlement_gate
                .lock()
                .expect("checkpoint test settlement gate poisoned")
                .clone()
        };
        #[cfg(test)]
        if let Some(gate) = test_gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        #[cfg(unix)]
        {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let has_groups = {
                    let mut groups = self
                        .process_groups
                        .lock()
                        .expect("checkpoint process group set poisoned");
                    groups.retain(|group| process_group_exists(*group));
                    !groups.is_empty()
                };
                if !has_groups {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "checkpoint process group did not settle within five seconds",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        #[cfg(windows)]
        {
            let jobs = self
                .jobs
                .lock()
                .expect("checkpoint job list poisoned")
                .clone();
            for job in jobs {
                job.settle().await?;
                self.jobs
                    .lock()
                    .expect("checkpoint job list poisoned")
                    .retain(|candidate| !Arc::ptr_eq(candidate, &job));
            }
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(())
        }
    }

    #[cfg(unix)]
    async fn settle_process_group(&self, group: i32) -> std::io::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        if process_group_exists(group) {
            signal_process_group(group, libc::SIGTERM);
            for _ in 0..4 {
                if !process_group_exists(group) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if process_group_exists(group) {
                signal_process_group(group, libc::SIGKILL);
            }
            while process_group_exists(group) {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "checkpoint child process group did not settle within five seconds",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        self.process_groups
            .lock()
            .expect("checkpoint process group set poisoned")
            .remove(&group);
        Ok(())
    }
}

struct CheckpointChild {
    child: Option<Child>,
    control: Option<Arc<CheckpointCaptureControl>>,
    process_group: Option<i32>,
    #[cfg(windows)]
    job: Option<Arc<WindowsJob>>,
}

impl CheckpointChild {
    async fn wait_with_output(mut self) -> std::io::Result<std::process::Output> {
        let child = self
            .child
            .take()
            .expect("checkpoint child must be present before wait")
            .wait_with_output()
            .await?;
        self.settle().await?;
        Ok(child)
    }

    async fn terminate_and_wait(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let _ = self.settle().await;
    }

    async fn settle(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        if let (Some(control), Some(group)) = (&self.control, self.process_group) {
            control.settle_process_group(group).await?;
        }
        #[cfg(windows)]
        if let (Some(control), Some(job)) = (&self.control, &self.job) {
            job.settle().await?;
            control
                .jobs
                .lock()
                .expect("checkpoint job list poisoned")
                .retain(|candidate| !Arc::ptr_eq(candidate, job));
        }
        Ok(())
    }
}

fn checkpoint_child(command: &mut Command) -> std::io::Result<CheckpointChild> {
    CHECKPOINT_CAPTURE_CONTEXT
        .try_with(|control| control.spawn_child(command))
        .unwrap_or_else(|_| {
            Err(std::io::Error::other(
                "checkpoint Git process requires the server-owned capture runner",
            ))
        })
}

/// Non-capture checkpoint operations (listing, metadata lookup, and restore)
/// still use the same child wrapper, but do not have a capture supervisor.
/// Capture code is guarded by `create_checkpoint` and can only use the strict
/// `checkpoint_child` path above.
fn checkpoint_read_only_child(command: &mut Command) -> std::io::Result<CheckpointChild> {
    match CHECKPOINT_CAPTURE_CONTEXT.try_with(|control| control.spawn_child(command)) {
        Ok(result) => result,
        Err(_) => {
            command.kill_on_drop(true);
            command.spawn().map(|child| CheckpointChild {
                child: Some(child),
                control: None,
                process_group: None,
                #[cfg(windows)]
                job: None,
            })
        }
    }
}

#[cfg(unix)]
fn signal_process_group(group: i32, signal: i32) {
    // Negative PID targets the complete group, including Git filters/hooks.
    let _ = unsafe { libc::kill(-group, signal) };
}

#[cfg(unix)]
fn process_group_exists(group: i32) -> bool {
    let result = unsafe { libc::kill(-group, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self { handle })
    }

    fn assign_suspended_process(&self, process_id: u32) -> std::io::Result<()> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id) };
        if process.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
        let assign_error = (assigned == 0).then(std::io::Error::last_os_error);
        unsafe { CloseHandle(process) };
        if let Some(error) = assign_error {
            return Err(error);
        }

        let thread_id = find_process_thread(process_id)?;
        let thread = unsafe {
            windows_sys::Win32::System::Threading::OpenThread(
                windows_sys::Win32::System::Threading::THREAD_SUSPEND_RESUME,
                0,
                thread_id,
            )
        };
        if thread.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let resumed = unsafe { windows_sys::Win32::System::Threading::ResumeThread(thread) };
        unsafe { CloseHandle(thread) };
        if resumed == u32::MAX {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn active_processes(&self) -> std::io::Result<u32> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };

        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                std::ptr::addr_of_mut!(accounting).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    fn terminate(&self) {
        let terminated =
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) };
        if terminated == 0 {
            tracing::error!(
                event = "code_checkpoint.job_termination_failed",
                cause = %std::io::Error::last_os_error(),
                "checkpoint child job could not be terminated"
            );
        }
    }

    async fn settle(&self) -> std::io::Result<()> {
        let active_processes = match self.active_processes() {
            Ok(active_processes) => active_processes,
            Err(error) => {
                tracing::error!(
                    event = "code_checkpoint.job_process_query_failed",
                    cause = %error,
                    "checkpoint child job activity could not be queried; terminating it"
                );
                u32::MAX
            }
        };
        if active_processes > 0 {
            self.terminate();
        } else {
            return Ok(());
        }
        let handle = self.handle as usize;
        let wait_result = tokio::task::spawn_blocking(move || unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(
                handle as windows_sys::Win32::Foundation::HANDLE,
                5_000,
            )
        })
        .await
        .map_err(|error| {
            std::io::Error::other(format!("checkpoint job wait task failed: {error}"))
        })?;
        match wait_result {
            windows_sys::Win32::Foundation::WAIT_OBJECT_0 => Ok(()),
            windows_sys::Win32::Foundation::WAIT_TIMEOUT => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "checkpoint job did not settle within five seconds",
            )),
            windows_sys::Win32::Foundation::WAIT_FAILED => Err(std::io::Error::last_os_error()),
            status => Err(std::io::Error::other(format!(
                "checkpoint job wait returned unexpected status {status}"
            ))),
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
fn find_process_thread(process_id: u32) -> std::io::Result<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) };
    while has_entry != 0 {
        if entry.th32OwnerProcessID == process_id {
            found = Some(entry.th32ThreadID);
            break;
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    found.ok_or_else(|| std::io::Error::other("suspended Git process thread was not found"))
}

impl CheckpointService {
    pub fn new(
        home: Arc<PathBuf>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ) -> Self {
        Self {
            home,
            broadcast_tx,
            workspace_locks: StdMutex::new(HashMap::new()),
            outcome_gate: Mutex::new(()),
            attempt_jobs: Mutex::new(HashMap::new()),
            cooldowns: StdMutex::new(HashMap::new()),
            durable_outcome_cache: StdMutex::new(CheckpointOutcomeCache::default()),
            volatile_outcomes: StdMutex::new(BTreeMap::new()),
            #[cfg(test)]
            test_capture_attempt_override: StdMutex::new(None),
        }
    }

    pub fn start_observer(self: &Arc<Self>) {
        let mut receiver = self.broadcast_tx.subscribe();
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(frame) => {
                        let Some(service) = service.upgrade() else {
                            break;
                        };
                        service.observe_broadcast_frame(&frame).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        tracing::warn!(
                            event = "code_checkpoint.outcome_observer_lagged",
                            skipped_frames = count,
                            "checkpoint outcome observer skipped broadcast frames"
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn outcome_store_path(&self) -> PathBuf {
        self.home
            .join(".freshell")
            .join("checkpoints")
            .join("attempt-outcomes-v1.json")
    }

    fn outcome_store_presence_marker_path(&self) -> PathBuf {
        self.home
            .join(".freshell")
            .join("checkpoints")
            .join("attempt-outcomes-v1.initialized")
    }

    async fn ensure_outcome_store_presence_marker(&self) -> Result<(), String> {
        let path = self.outcome_store_presence_marker_path();
        #[cfg(unix)]
        let open_result = {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true).mode(0o600);
            options.open(&path).await
        };
        #[cfg(not(unix))]
        let open_result = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await;

        let mut marker = match open_result {
            Ok(marker) => marker,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "failed to create checkpoint outcome presence marker: {error}"
                ));
            }
        };
        marker
            .write_all(b"freshell checkpoint outcomes initialized v1\n")
            .await
            .map_err(|error| {
                format!("failed to write checkpoint outcome presence marker: {error}")
            })?;
        marker.sync_all().await.map_err(|error| {
            format!("failed to flush checkpoint outcome presence marker: {error}")
        })?;
        #[cfg(unix)]
        {
            let parent = path.parent().ok_or_else(|| {
                "checkpoint outcome presence marker has no parent directory".to_owned()
            })?;
            tokio::fs::File::open(parent)
                .await
                .map_err(|error| {
                    format!("failed to open checkpoint outcome directory for flush: {error}")
                })?
                .sync_all()
                .await
                .map_err(|error| {
                    format!("failed to flush checkpoint outcome directory: {error}")
                })?;
        }
        Ok(())
    }

    async fn outcome_store_presence_marker_exists(&self) -> Result<bool, String> {
        match tokio::fs::symlink_metadata(self.outcome_store_presence_marker_path()).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "failed to inspect checkpoint outcome presence marker: {error}"
            )),
        }
    }

    fn mark_outcome_store_observed(&self) {
        self.durable_outcome_cache
            .lock()
            .expect("checkpoint dispatch fences mutex poisoned")
            .store_file_observed = true;
    }

    fn workspace_lock(&self, workspace: &Path) -> Arc<Mutex<()>> {
        let key = resolve_absolute(workspace);
        let mut locks = self
            .workspace_locks
            .lock()
            .expect("checkpoint workspace lock map poisoned");
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    async fn lock_workspace(
        &self,
        workspace: &Path,
        budget: Duration,
    ) -> Result<OwnedMutexGuard<()>, ()> {
        tokio::time::timeout(budget, self.workspace_lock(workspace).lock_owned())
            .await
            .map_err(|_| ())
    }

    fn quarantine_workspace(
        &self,
        workspace: PathBuf,
        lock: OwnedMutexGuard<()>,
        control: Arc<CheckpointCaptureControl>,
        request_id: Option<String>,
        stage: &'static str,
        initial_cause: String,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            // Keep the lock alive for the whole retry loop. A caller must never
            // release workspace serialization while a child may still mutate
            // the shadow repository.
            let _workspace_lock = lock;
            tracing::error!(
                event = "code_checkpoint.workspace_quarantined",
                workspace = %workspace.display(),
                request_id = request_id.as_deref().unwrap_or(""),
                stage,
                cause = %initial_cause,
                "checkpoint child settlement is uncertain; workspace remains locked"
            );
            let mut retry = 0_u64;
            loop {
                retry = retry.saturating_add(1);
                if let Err(error) = control.cancel_processes().await {
                    tracing::error!(
                        event = "code_checkpoint.quarantine_termination_failed",
                        workspace = %workspace.display(),
                        request_id = request_id.as_deref().unwrap_or(""),
                        stage,
                        retry,
                        cause = %error,
                        "checkpoint process termination retry failed"
                    );
                }
                match control.wait_for_process_groups().await {
                    Ok(()) => {
                        tracing::warn!(
                            event = "code_checkpoint.workspace_quarantine_released",
                            workspace = %workspace.display(),
                            request_id = request_id.as_deref().unwrap_or(""),
                            stage,
                            retry,
                            "checkpoint children settled; workspace lock released"
                        );
                        break;
                    }
                    Err(error) => {
                        tracing::error!(
                            event = "code_checkpoint.quarantine_settlement_pending",
                            workspace = %workspace.display(),
                            request_id = request_id.as_deref().unwrap_or(""),
                            stage,
                            retry,
                            cause = %error,
                            "checkpoint workspace remains locked until child settlement is confirmed"
                        );
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        })
    }

    async fn read_outcome_store(&self) -> Result<CheckpointOutcomeStore, String> {
        let path = self.outcome_store_path();
        let raw = match tokio::fs::read(&path).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let marker_exists = match self.outcome_store_presence_marker_exists().await {
                    Ok(exists) => exists,
                    Err(marker_error) => {
                        self.mark_outcome_store_observed();
                        return Err(marker_error);
                    }
                };
                let mut fences = self
                    .durable_outcome_cache
                    .lock()
                    .expect("checkpoint dispatch fences mutex poisoned");
                if marker_exists || fences.store_file_observed {
                    fences.store_file_observed = true;
                    return Err(
                        "checkpoint attempt outcome store is missing after its prior presence could not be ruled out".into(),
                    );
                }
                fences.observe_absent_store();
                return Ok(CheckpointOutcomeStore {
                    version: CHECKPOINT_OUTCOME_STORE_VERSION,
                    outcomes: BTreeMap::new(),
                });
            }
            Err(error) => {
                self.mark_outcome_store_observed();
                let marker_error = self
                    .ensure_outcome_store_presence_marker()
                    .await
                    .err()
                    .map(|error| format!("; {error}"))
                    .unwrap_or_default();
                return Err(format!(
                    "failed to read checkpoint attempt outcomes: {error}{marker_error}"
                ));
            }
        };
        self.mark_outcome_store_observed();
        if let Err(error) = self.ensure_outcome_store_presence_marker().await {
            tracing::error!(
                event = "code_checkpoint.outcome_presence_marker_write_failed",
                cause = %error,
                "checkpoint outcome store was readable but its durable presence marker could not be written"
            );
        }
        let store: CheckpointOutcomeStore = serde_json::from_slice(&raw)
            .map_err(|error| format!("invalid checkpoint attempt outcome store: {error}"))?;
        if store.version != CHECKPOINT_OUTCOME_STORE_VERSION {
            return Err("unsupported checkpoint attempt outcome store version".to_string());
        }
        self.durable_outcome_cache
            .lock()
            .expect("checkpoint dispatch fences mutex poisoned")
            .replace_from_store(&store);
        Ok(store)
    }

    async fn write_outcome_store(&self, store: &CheckpointOutcomeStore) -> Result<(), String> {
        let path = self.outcome_store_path();
        let parent = path
            .parent()
            .ok_or_else(|| "checkpoint outcome store has no parent directory".to_string())?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create checkpoint outcome directory: {error}"))?;
        self.ensure_outcome_store_presence_marker().await?;
        let temporary = parent.join(format!(
            "attempt-outcomes-v1.json.tmp-{}",
            uuid::Uuid::new_v4()
        ));
        let serialized = serde_json::to_vec_pretty(store)
            .map_err(|error| format!("failed to serialize checkpoint outcomes: {error}"))?;
        #[cfg(unix)]
        let write_result = {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true).mode(0o600);
            match options.open(&temporary).await {
                Ok(mut file) => match file.write_all(&serialized).await {
                    Ok(()) => file
                        .sync_all()
                        .await
                        .map_err(|error| format!("failed to flush checkpoint outcomes: {error}")),
                    Err(error) => Err(format!("failed to write checkpoint outcomes: {error}")),
                },
                Err(error) => Err(format!("failed to create checkpoint outcome file: {error}")),
            }
        };
        #[cfg(not(unix))]
        let write_result = tokio::fs::write(&temporary, &serialized)
            .await
            .map_err(|error| format!("failed to write checkpoint outcomes: {error}"));
        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(format!("failed to publish checkpoint outcomes: {error}"));
        }
        self.durable_outcome_cache
            .lock()
            .expect("checkpoint dispatch fences mutex poisoned")
            .replace_from_store(store);
        Ok(())
    }

    async fn persist_outcome(
        &self,
        key: &str,
        outcome: StoredCheckpointOutcome,
    ) -> Result<(), String> {
        let _guard = self.outcome_gate.lock().await;
        let mut store = self.read_outcome_store().await?;
        store.outcomes.insert(key.to_string(), outcome.clone());
        while store.outcomes.len() > CHECKPOINT_OUTCOME_STORE_LIMIT {
            let oldest = store
                .outcomes
                .iter()
                .min_by_key(|(_, item)| item.created_at_ms)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else { break };
            store.outcomes.remove(&oldest);
        }
        self.write_outcome_store(&store).await?;
        self.volatile_outcomes
            .lock()
            .expect("volatile checkpoint outcomes mutex poisoned")
            .remove(key);
        Ok(())
    }

    fn attempt_state_for_store_failure(&self, key: &str) -> (Option<CheckpointAttemptFence>, bool) {
        let fences = self
            .durable_outcome_cache
            .lock()
            .expect("checkpoint dispatch fences mutex poisoned");
        (
            fences.known_attempt(key),
            fences.can_rule_out_unknown_attempt(),
        )
    }

    fn remember_volatile_outcome(&self, key: &str, outcome: StoredCheckpointOutcome) -> bool {
        let mut outcomes = self
            .volatile_outcomes
            .lock()
            .expect("volatile checkpoint outcomes mutex poisoned");
        if !outcomes.contains_key(key) && outcomes.len() >= CHECKPOINT_VOLATILE_FENCE_LIMIT {
            return false;
        }
        outcomes.insert(key.to_string(), outcome);
        true
    }

    fn mark_outcome_store_failure(
        record: &mut StoredCheckpointOutcome,
        operation: &'static str,
    ) -> bool {
        let allow_forward = record.capture_settled;
        record.dispatch_started = allow_forward;
        record.outcome.status = FreshAgentCheckpointStatus::Unavailable;
        record.outcome.checkpoint_id = None;
        record.outcome.code = Some("outcome_store_unavailable".into());
        record.outcome.reason = Some(if allow_forward {
            format!(
                "{operation}; rewind for this message is unknown. Your message will still be sent."
            )
        } else {
            format!("{operation}, and the pre-turn snapshot is still settling; your message was withheld.")
        });
        allow_forward
    }

    fn mark_known_attempt_store_failure(
        record: &mut StoredCheckpointOutcome,
        state: CheckpointAttemptFence,
    ) {
        record.dispatch_started = state.dispatch_started;
        record.capture_settled = state.capture_settled;
        record.outcome.status = FreshAgentCheckpointStatus::Unavailable;
        record.outcome.checkpoint_id = None;
        record.outcome.code = Some("outcome_store_unavailable".into());
        record.outcome.reason = Some(if !state.capture_settled {
            "Rewind status could not be read, and the pre-turn snapshot is still settling; your message was withheld.".into()
        } else {
            "Rewind status could not be read; an earlier dispatch may already have started, so this retry was withheld to prevent a duplicate.".into()
        });
    }

    fn mark_unverified_attempt_store_failure(record: &mut StoredCheckpointOutcome) {
        record.dispatch_started = false;
        record.capture_settled = false;
        record.outcome.status = FreshAgentCheckpointStatus::Unavailable;
        record.outcome.checkpoint_id = None;
        record.outcome.code = Some("outcome_store_unavailable".into());
        record.outcome.reason = Some(
            "Rewind status could not be read, and prior send history could not be verified; your message was withheld.".into(),
        );
    }

    fn mark_volatile_fence_capacity_failure(record: &mut StoredCheckpointOutcome) {
        record.dispatch_started = false;
        record.outcome.status = FreshAgentCheckpointStatus::Unavailable;
        record.outcome.checkpoint_id = None;
        record.outcome.code = Some("outcome_store_unavailable".into());
        record.outcome.reason = Some(
            "Rewind status could not be saved, and local duplicate protection is full; your message was withheld.".into(),
        );
    }

    async fn find_outcome(&self, key: &str) -> Result<Option<StoredCheckpointOutcome>, String> {
        if let Some(outcome) = self
            .volatile_outcomes
            .lock()
            .expect("volatile checkpoint outcomes mutex poisoned")
            .get(key)
            .cloned()
        {
            return Ok(Some(outcome));
        }
        if let Some(outcome) = self
            .durable_outcome_cache
            .lock()
            .expect("durable checkpoint outcome cache mutex poisoned")
            .cached_outcome(key)
        {
            return Ok(Some(outcome));
        }
        let _guard = self.outcome_gate.lock().await;
        let store = self.read_outcome_store().await?;
        Ok(store.outcomes.get(key).cloned())
    }

    async fn replay_for_identity(
        &self,
        provider: AgentProvider,
        session_id: &str,
        session_type: SessionType,
    ) {
        let records = {
            let _guard = self.outcome_gate.lock().await;
            match self.read_outcome_store().await {
                Ok(store) => store.outcomes,
                Err(error) => {
                    tracing::error!(
                        event = "code_checkpoint.outcome_store_read_failed",
                        cause = %error,
                        "durable checkpoint outcomes could not be replayed"
                    );
                    let mut cached = self
                        .durable_outcome_cache
                        .lock()
                        .expect("durable checkpoint outcome cache mutex poisoned")
                        .cached_outcomes();
                    cached.extend(
                        self.volatile_outcomes
                            .lock()
                            .expect("volatile checkpoint outcomes mutex poisoned")
                            .clone(),
                    );
                    cached
                }
            }
        };
        for record in records.values().filter(|record| {
            record.outcome.provider == provider
                && record.outcome.session_type == session_type
                && record
                    .session_aliases
                    .iter()
                    .any(|alias| alias == session_id)
        }) {
            if record.request_ids.is_empty() {
                self.broadcast_outcome(record.outcome.clone());
            } else {
                for request_id in &record.request_ids {
                    let mut outcome = record.outcome.clone();
                    outcome.request_id = request_id.clone();
                    self.broadcast_outcome(outcome);
                }
            }
        }
    }

    fn broadcast_outcome(&self, outcome: FreshAgentCheckpointOutcome) {
        let message = ServerMessage::FreshAgentCheckpointOutcome(outcome);
        if let Ok(frame) = serde_json::to_string(&message) {
            let _ = self.broadcast_tx.send(frame);
        }
    }

    async fn observe_broadcast_frame(&self, frame: &str) {
        let Ok(message) = serde_json::from_str::<Value>(frame) else {
            return;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("freshAgent.send.accepted") => self.observe_accepted(&message).await,
            Some("freshAgent.session.materialized") => self.observe_materialized(&message).await,
            Some("freshAgent.event") => self.observe_turn_identity(&message).await,
            _ => {}
        }
    }

    async fn update_matching_outcomes<Matches, Update>(
        &self,
        mut matches: Matches,
        mut update: Update,
    ) -> Result<Vec<StoredCheckpointOutcome>, String>
    where
        Matches: FnMut(&StoredCheckpointOutcome) -> bool,
        Update: FnMut(&mut StoredCheckpointOutcome),
    {
        let _guard = self.outcome_gate.lock().await;
        let mut store = self.read_outcome_store().await?;
        let mut changed = Vec::new();
        for record in store.outcomes.values_mut() {
            if matches(record) {
                update(record);
                changed.push(record.clone());
            }
        }
        if !changed.is_empty() {
            self.write_outcome_store(&store).await?;
        }
        Ok(changed)
    }

    async fn observe_accepted(&self, message: &Value) {
        let Some(request_id) = message.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let Some(provider) = message
            .get("provider")
            .and_then(Value::as_str)
            .and_then(parse_agent_provider)
        else {
            return;
        };
        let Some(session_type) = message
            .get("sessionType")
            .and_then(Value::as_str)
            .and_then(parse_session_type)
        else {
            return;
        };
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let submitted_turn_id = message
            .get("submittedTurnId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let updated = self
            .update_matching_outcomes(
                |record| {
                    record.outcome.provider == provider
                        && record.outcome.session_type == session_type
                        && record.request_ids.iter().any(|alias| alias == request_id)
                        && record
                            .session_aliases
                            .iter()
                            .any(|alias| alias == session_id)
                        && submitted_turn_id.as_deref().is_none_or(|submitted| {
                            record
                                .outcome
                                .native_turn_id
                                .as_deref()
                                .is_none_or(|native| native == submitted)
                        })
                },
                |record| {
                    if submitted_turn_id.is_some() {
                        record.submitted_turn_id = submitted_turn_id.clone();
                    }
                },
            )
            .await;
        if let Err(error) = updated {
            tracing::error!(
                event = "code_checkpoint.accepted_identity_persist_failed",
                request_id,
                cause = %error,
                "accepted turn identity could not be persisted"
            );
        }
    }

    async fn observe_materialized(&self, message: &Value) {
        let Some(previous) = message.get("previousSessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(provider) = message
            .get("provider")
            .and_then(Value::as_str)
            .and_then(parse_agent_provider)
        else {
            return;
        };
        let Some(session_type) = message
            .get("sessionType")
            .and_then(Value::as_str)
            .and_then(parse_session_type)
        else {
            return;
        };
        let updated = self
            .update_matching_outcomes(
                |record| {
                    record.outcome.provider == provider
                        && record.outcome.session_type == session_type
                        && record.session_aliases.iter().any(|alias| alias == previous)
                },
                |record| {
                    if !record
                        .session_aliases
                        .iter()
                        .any(|alias| alias == session_id)
                    {
                        record.session_aliases.push(session_id.to_string());
                    }
                },
            )
            .await;
        if let Err(error) = updated {
            tracing::error!(
                event = "code_checkpoint.session_alias_persist_failed",
                cause = %error,
                "checkpoint session materialization alias could not be persisted"
            );
        }
    }

    async fn observe_turn_identity(&self, message: &Value) {
        let Some(event) = message.get("event") else {
            return;
        };
        if event.get("type").and_then(Value::as_str) != Some("checkpointTurnIdentity") {
            return;
        }
        let Some(logical_attempt_id) = event.get("logicalAttemptId").and_then(Value::as_str) else {
            return;
        };
        let Some(request_id) = event.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let Some(native_turn_id) = event.get("nativeTurnId").and_then(Value::as_str) else {
            return;
        };
        let session_id = event
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| message.get("sessionId").and_then(Value::as_str));
        let Some(session_id) = session_id else { return };
        let display_turn_id = event
            .get("displayTurnId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(provider) = message
            .get("provider")
            .and_then(Value::as_str)
            .and_then(parse_agent_provider)
        else {
            return;
        };
        let Some(session_type) = message
            .get("sessionType")
            .and_then(Value::as_str)
            .and_then(parse_session_type)
        else {
            return;
        };
        let updated = self
            .update_matching_outcomes(
                |record| {
                    record.outcome.logical_attempt_id == logical_attempt_id
                        && record.outcome.provider == provider
                        && record.outcome.session_type == session_type
                        && record.request_ids.iter().any(|alias| alias == request_id)
                        && record
                            .session_aliases
                            .iter()
                            .any(|alias| alias == session_id)
                        && record
                            .submitted_turn_id
                            .as_deref()
                            .is_none_or(|submitted| submitted == native_turn_id)
                        && record
                            .outcome
                            .native_turn_id
                            .as_deref()
                            .is_none_or(|existing| existing == native_turn_id)
                },
                |record| {
                    record.outcome.native_turn_id = Some(native_turn_id.to_string());
                    if display_turn_id.is_some() {
                        record.outcome.display_turn_id = display_turn_id.clone();
                    }
                },
            )
            .await;
        match updated {
            Ok(records) => {
                for record in records {
                    if record.request_ids.is_empty() {
                        self.broadcast_outcome(record.outcome.clone());
                    } else {
                        for request_id in &record.request_ids {
                            let mut outcome = record.outcome.clone();
                            outcome.request_id = request_id.clone();
                            self.broadcast_outcome(outcome);
                        }
                    }
                }
            }
            Err(error) => tracing::error!(
                event = "code_checkpoint.turn_identity_persist_failed",
                logical_attempt_id,
                cause = %error,
                "provider checkpoint turn identity could not be persisted"
            ),
        }
    }

    fn active_cooldown(&self, workspace: &Path) -> Option<Duration> {
        let now = Instant::now();
        let mut cooldowns = self
            .cooldowns
            .lock()
            .expect("checkpoint cooldown map poisoned");
        cooldowns.retain(|_, cooldown| cooldown.expires_at > now);
        cooldowns
            .get(workspace)
            .map(|cooldown| cooldown.expires_at.saturating_duration_since(now))
    }

    fn establish_cooldown(&self, workspace: &Path) {
        let now = Instant::now();
        let mut cooldowns = self
            .cooldowns
            .lock()
            .expect("checkpoint cooldown map poisoned");
        cooldowns.retain(|_, cooldown| cooldown.expires_at > now);
        cooldowns.insert(
            workspace.to_path_buf(),
            CheckpointCooldown {
                expires_at: now + CHECKPOINT_TIMEOUT_COOLDOWN,
            },
        );
        while cooldowns.len() > CHECKPOINT_COOLDOWN_LIMIT {
            let oldest = cooldowns
                .iter()
                .min_by_key(|(_, cooldown)| cooldown.expires_at)
                .map(|(path, _)| path.clone());
            let Some(oldest) = oldest else { break };
            cooldowns.remove(&oldest);
        }
    }

    fn clear_cooldown(&self, workspace: &Path) {
        self.cooldowns
            .lock()
            .expect("checkpoint cooldown map poisoned")
            .remove(workspace);
    }

    fn new_record(
        &self,
        send: &FreshAgentSend,
        logical_attempt_id: &str,
        request_id: &str,
        workspace: Option<(&ResolvedCheckpointWorkspace, &str)>,
        result: Result<String, (&'static str, String)>,
    ) -> StoredCheckpointOutcome {
        let (status, checkpoint_id, code, reason, resolved_workspace) = match result {
            Ok(checkpoint_id) => (
                FreshAgentCheckpointStatus::Available,
                Some(checkpoint_id),
                None,
                None,
                workspace.map(|(workspace, _)| FreshAgentCheckpointWorkspace {
                    path: workspace.path.to_string_lossy().into_owned(),
                    provenance: workspace_provenance(&workspace.provenance),
                }),
            ),
            Err((code, reason)) => (
                FreshAgentCheckpointStatus::Unavailable,
                None,
                Some(code.to_string()),
                Some(reason),
                workspace.map(|(workspace, _)| FreshAgentCheckpointWorkspace {
                    path: workspace.path.to_string_lossy().into_owned(),
                    provenance: workspace_provenance(&workspace.provenance),
                }),
            ),
        };
        let mut request_ids = vec![request_id.to_string()];
        request_ids.truncate(16);
        let mut session_aliases = vec![send.session_id.clone()];
        session_aliases.truncate(16);
        StoredCheckpointOutcome {
            version: CHECKPOINT_OUTCOME_STORE_VERSION,
            outcome: FreshAgentCheckpointOutcome {
                logical_attempt_id: logical_attempt_id.to_string(),
                request_id: request_id.to_string(),
                provider: send.provider,
                session_id: send.session_id.clone(),
                session_type: send.session_type,
                status,
                checkpoint_id,
                workspace: resolved_workspace,
                code,
                reason,
                native_turn_id: None,
                display_turn_id: None,
            },
            request_ids,
            session_aliases,
            dispatch_started: false,
            capture_settled: true,
            submitted_turn_id: None,
            created_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }

    async fn capture_automatic(
        &self,
        send: &FreshAgentSend,
        request_id: &str,
        logical_attempt_id: &str,
    ) -> StoredCheckpointOutcome {
        let started_at = Instant::now();
        let launch_cwd = send
            .settings
            .as_ref()
            .and_then(|settings| settings.cwd.as_deref())
            .or(send.cwd.as_deref());
        let intent = send
            .checkpoint_intent
            .as_ref()
            .and_then(|intent| serde_json::to_value(intent.workspace.as_ref()).ok())
            .and_then(|value| if value.is_null() { None } else { Some(value) });
        // An explicitly selected checkpoint workspace is independent from the
        // provider's launch cwd. Use it only as the resolver anchor when a
        // resumed pane no longer has its original cwd; never write it back to
        // `send` or change the provider's working directory.
        let workspace_anchor = launch_cwd.or_else(|| {
            send.checkpoint_intent
                .as_ref()
                .and_then(|intent| intent.workspace.as_ref())
                .map(|workspace| workspace.path.as_str())
        });
        let Some(workspace_anchor) = workspace_anchor else {
            return self.new_record(
                send,
                logical_attempt_id,
                request_id,
                None,
                Err((
                    "workspace_unavailable",
                    "No selected code workspace is available for a snapshot; rewind is unavailable, and your message will still be sent.".into(),
                )),
            );
        };
        let resolve_control = Arc::new(CheckpointCaptureControl::default());
        let resolve_control_for_task = Arc::clone(&resolve_control);
        let home = Arc::clone(&self.home);
        let workspace_anchor = workspace_anchor.to_string();
        let mut resolve_task = tokio::spawn(CHECKPOINT_CAPTURE_CONTEXT.scope(
            resolve_control_for_task,
            async move {
                resolve_checkpoint_workspace(&home, Path::new(&workspace_anchor), intent.as_ref())
                    .await
            },
        ));
        let remaining = CHECKPOINT_AUTO_BUDGET.saturating_sub(started_at.elapsed());
        let workspace = match tokio::time::timeout(remaining, &mut resolve_task).await {
            Ok(Ok(Ok(workspace))) => workspace,
            Ok(Ok(Err(error))) => {
                log_workspace_unavailable(&error.candidate, &error.reason, Some(request_id));
                return self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    None,
                    Err((
                        "workspace_unavailable",
                        "No eligible code workspace is available for a snapshot; rewind is unavailable, and your message will still be sent.".into(),
                    )),
                );
            }
            Ok(Err(error)) => {
                return self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    None,
                    Err((
                        "workspace_resolution_failed",
                        format!("Workspace resolution failed; your message will still be sent ({error})."),
                    )),
                );
            }
            Err(_) => {
                let settlement =
                    cancel_and_settle_capture_task(&resolve_control, &mut resolve_task).await;
                let mut record = self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    None,
                    Err(match &settlement {
                        Ok(()) => (
                            "workspace_resolution_timeout",
                            "Workspace resolution took too long; your message will still be sent.".into(),
                        ),
                        Err(cause) => (
                            "workspace_resolution_unsettled",
                            format!("Workspace resolution timed out and its child process could not be confirmed settled; the send was withheld ({cause})."),
                        ),
                    }),
                );
                record.capture_settled = settlement.is_ok();
                return record;
            }
        };
        if let Some(remaining) = self.active_cooldown(&workspace.path) {
            return self.new_record(
                send,
                logical_attempt_id,
                request_id,
                Some((&workspace, "")),
                Err((
                    "capture_timeout_cooldown",
                    format!("Code snapshot capture is paused briefly after a timeout; retry in {} seconds.", remaining.as_secs().saturating_add(1)),
                )),
            );
        }

        let remaining = CHECKPOINT_AUTO_BUDGET.saturating_sub(started_at.elapsed());
        if remaining.is_zero() {
            return self.new_record(
                send,
                logical_attempt_id,
                request_id,
                Some((&workspace, "")),
                Err(("workspace_resolution_timeout", "Workspace resolution used the available snapshot time; your message will still be sent.".into())),
            );
        }
        let lock = match self.lock_workspace(&workspace.path, remaining).await {
            Ok(lock) => lock,
            Err(()) => {
                return self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    Some((&workspace, "")),
                    Err(("workspace_lock_timeout", "This workspace is busy with another snapshot; your message will still be sent.".into())),
                );
            }
        };
        let remaining = CHECKPOINT_AUTO_BUDGET.saturating_sub(started_at.elapsed());
        if remaining.is_zero() {
            drop(lock);
            return self.new_record(
                send,
                logical_attempt_id,
                request_id,
                Some((&workspace, "")),
                Err(("workspace_lock_timeout", "This workspace is busy with another snapshot; your message will still be sent.".into())),
            );
        }

        match self
            .capture_with_budget(
                &workspace,
                "Automatic pre-turn snapshot",
                request_id,
                remaining,
                None,
            )
            .await
        {
            CaptureAttempt::Published(checkpoint_id) => {
                self.clear_cooldown(&workspace.path);
                drop(lock);
                self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    Some((&workspace, "")),
                    Ok(checkpoint_id),
                )
            }
            CaptureAttempt::TimedOut(published) => {
                self.establish_cooldown(&workspace.path);
                drop(lock);
                if let Some(checkpoint_id) = published {
                    self.clear_cooldown(&workspace.path);
                    self.new_record(
                        send,
                        logical_attempt_id,
                        request_id,
                        Some((&workspace, "")),
                        Ok(checkpoint_id),
                    )
                } else {
                    self.new_record(
                        send,
                        logical_attempt_id,
                        request_id,
                        Some((&workspace, "")),
                        Err((
                            "capture_timeout",
                            "The code snapshot took too long; your message will still be sent."
                                .into(),
                        )),
                    )
                }
            }
            CaptureAttempt::Cancelled(published) => {
                drop(lock);
                if let Some(checkpoint_id) = published {
                    self.new_record(
                        send,
                        logical_attempt_id,
                        request_id,
                        Some((&workspace, "")),
                        Ok(checkpoint_id),
                    )
                } else {
                    self.new_record(
                        send,
                        logical_attempt_id,
                        request_id,
                        Some((&workspace, "")),
                        Err((
                            "capture_cancelled",
                            "The code snapshot was cancelled; your message will still be sent."
                                .into(),
                        )),
                    )
                }
            }
            CaptureAttempt::Unsettled {
                message: error,
                control,
            } => {
                let mut record = self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    Some((&workspace, "")),
                    Err((
                        "capture_unsettled",
                        format!("The code snapshot could not be confirmed settled; the send was withheld ({error})."),
                    )),
                );
                record.capture_settled = false;
                let quarantine = self.quarantine_workspace(
                    workspace.path.clone(),
                    lock,
                    control,
                    Some(request_id.to_string()),
                    "automatic_capture",
                    error,
                );
                match quarantine.await {
                    Ok(()) => {
                        if let Some(checkpoint_id) = self
                            .reconcile_published_request(&workspace, request_id)
                            .await
                        {
                            return self.new_record(
                                send,
                                logical_attempt_id,
                                request_id,
                                Some((&workspace, "")),
                                Ok(checkpoint_id),
                            );
                        }
                        record.capture_settled = true;
                        record.outcome.code = Some("capture_failed".into());
                        record.outcome.reason = Some(
                            "The code snapshot could not be completed; rewind is unavailable, and your message will still be sent."
                                .into(),
                        );
                    }
                    Err(settlement_error) => {
                        tracing::error!(
                            event = "code_checkpoint.quarantine_task_failed",
                            workspace = %workspace.path.display(),
                            request_id,
                            cause = %settlement_error,
                            "checkpoint child settlement was not confirmed; the provider send remains withheld"
                        );
                        record.outcome.reason = Some(format!(
                            "The code snapshot could not be confirmed settled; your message was withheld ({settlement_error})."
                        ));
                    }
                }
                record
            }
            CaptureAttempt::Failed(error) => {
                drop(lock);
                let failure =
                    CheckpointFailure::from_capture_detail(&self.home, &workspace.path, &error);
                failure.log(Some(request_id));
                self.new_record(
                    send,
                    logical_attempt_id,
                    request_id,
                    Some((&workspace, "")),
                    Err((failure.code, failure.user_details.to_string())),
                )
            }
        }
    }

    async fn capture_explicit(
        self: &Arc<Self>,
        launch_cwd: PathBuf,
        workspace_intent: Option<Value>,
        label: String,
        request_id: Option<String>,
    ) -> Result<(Value, ResolvedCheckpointWorkspace), ExplicitCaptureError> {
        let deadline = Instant::now() + CHECKPOINT_EXPLICIT_BUDGET;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cancellation_guard = CaptureRequestCancellation { sender: cancel_tx };
        let service = Arc::clone(self);
        let (settled_tx, settled_rx) = tokio::sync::oneshot::channel::<
            Result<(Value, ResolvedCheckpointWorkspace), ExplicitCaptureError>,
        >();
        tokio::spawn(async move {
            let result = service
                .capture_explicit_supervisor(
                    launch_cwd,
                    workspace_intent,
                    label,
                    request_id,
                    deadline,
                    cancel_rx,
                )
                .await;
            let _ = settled_tx.send(result);
        });
        let result = settled_rx
            .await
            .unwrap_or(Err(ExplicitCaptureError::ServiceStopped));
        drop(cancellation_guard);
        result
    }

    async fn capture_explicit_supervisor(
        &self,
        launch_cwd: PathBuf,
        workspace_intent: Option<Value>,
        label: String,
        request_id: Option<String>,
        deadline: Instant,
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<(Value, ResolvedCheckpointWorkspace), ExplicitCaptureError> {
        let resolve_control = Arc::new(CheckpointCaptureControl::default());
        let resolve_control_for_task = Arc::clone(&resolve_control);
        let launch_cwd_for_task = launch_cwd.clone();
        let home = Arc::clone(&self.home);
        let mut resolve_task = tokio::spawn(CHECKPOINT_CAPTURE_CONTEXT.scope(
            resolve_control_for_task,
            async move {
                resolve_checkpoint_workspace(&home, &launch_cwd_for_task, workspace_intent.as_ref())
                    .await
            },
        ));
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let candidate = launch_cwd.clone();
            return match cancel_and_settle_capture_task(&resolve_control, &mut resolve_task).await {
                Ok(()) => Err(ExplicitCaptureError::ResolutionTimeout(
                    candidate.to_string_lossy().into_owned(),
                )),
                Err(message) => Err(ExplicitCaptureError::Unsettled {
                    candidate,
                    workspace: None,
                    message,
                }),
            };
        }

        let workspace = tokio::select! {
            biased;
            _ = wait_for_capture_cancellation(&mut cancel_rx) => {
                let candidate = launch_cwd.clone();
                return match cancel_and_settle_capture_task(&resolve_control, &mut resolve_task).await {
                    Ok(()) => Err(ExplicitCaptureError::Cancelled),
                    Err(message) => Err(ExplicitCaptureError::Unsettled {
                        candidate,
                        workspace: None,
                        message,
                    }),
                };
            }
            result = tokio::time::timeout(remaining, &mut resolve_task) => {
                match result {
                    Ok(Ok(Ok(workspace))) => workspace,
                    Ok(Ok(Err(error))) => return Err(ExplicitCaptureError::WorkspaceUnavailable(error)),
                    Ok(Err(error)) => return Err(ExplicitCaptureError::Capture {
                        workspace: ResolvedCheckpointWorkspace {
                            path: resolve_absolute(&launch_cwd),
                            provenance: "resolved-project".to_string(),
                        },
                        message: format!("workspace resolution task failed: {error}"),
                    }),
                    Err(_) => {
                        let candidate = launch_cwd.clone();
                        return match cancel_and_settle_capture_task(&resolve_control, &mut resolve_task).await {
                            Ok(()) => Err(ExplicitCaptureError::ResolutionTimeout(
                                candidate.to_string_lossy().into_owned(),
                            )),
                            Err(message) => Err(ExplicitCaptureError::Unsettled {
                                candidate,
                                workspace: None,
                                message,
                            }),
                        };
                    }
                }
            }
        };

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ExplicitCaptureError::ResolutionTimeout(
                launch_cwd.to_string_lossy().into_owned(),
            ));
        }
        let lock = tokio::select! {
            biased;
            _ = wait_for_capture_cancellation(&mut cancel_rx) => {
                return Err(ExplicitCaptureError::Cancelled);
            }
            lock = self.lock_workspace(&workspace.path, remaining) => match lock {
                Ok(lock) => lock,
                Err(()) => return Err(ExplicitCaptureError::WorkspaceBusy(workspace)),
            }
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            drop(lock);
            return Err(ExplicitCaptureError::WorkspaceBusy(workspace));
        }
        let result = self
            .capture_with_budget(
                &workspace,
                &label,
                request_id.as_deref().unwrap_or(""),
                remaining,
                Some(cancel_rx),
            )
            .await;
        match result {
            CaptureAttempt::Published(checkpoint_id) => {
                self.clear_cooldown(&workspace.path);
                drop(lock);
                Ok((
                    explicit_capture_response(checkpoint_id, &label, request_id.as_deref()),
                    workspace,
                ))
            }
            CaptureAttempt::TimedOut(Some(checkpoint_id)) => {
                self.clear_cooldown(&workspace.path);
                drop(lock);
                Ok((
                    explicit_capture_response(checkpoint_id, &label, request_id.as_deref()),
                    workspace,
                ))
            }
            CaptureAttempt::TimedOut(None) => {
                self.establish_cooldown(&workspace.path);
                drop(lock);
                Err(ExplicitCaptureError::Capture {
                    workspace,
                    message: "checkpoint capture timed out".to_string(),
                })
            }
            CaptureAttempt::Cancelled(_) => {
                drop(lock);
                Err(ExplicitCaptureError::Cancelled)
            }
            CaptureAttempt::Unsettled { message, control } => {
                let candidate = workspace.path.clone();
                let _quarantine = self.quarantine_workspace(
                    candidate.clone(),
                    lock,
                    control,
                    request_id.clone(),
                    "explicit_capture",
                    message.clone(),
                );
                Err(ExplicitCaptureError::Unsettled {
                    candidate,
                    workspace: Some(workspace),
                    message,
                })
            }
            CaptureAttempt::Failed(error) => {
                drop(lock);
                Err(ExplicitCaptureError::Capture {
                    workspace,
                    message: error,
                })
            }
        }
    }

    async fn capture_with_budget(
        &self,
        workspace: &ResolvedCheckpointWorkspace,
        label: &str,
        request_id: &str,
        budget: Duration,
        mut cancellation: Option<watch::Receiver<bool>>,
    ) -> CaptureAttempt {
        #[cfg(test)]
        if let Some(attempt) = self
            .test_capture_attempt_override
            .lock()
            .expect("checkpoint test capture override mutex poisoned")
            .take()
        {
            return attempt;
        }

        // The task is owned by this server service, not by the socket/HTTP
        // request future. On budget expiry the scoped runner is terminated,
        // reaped, and reconciled under the workspace lock before this returns.
        let control = Arc::new(CheckpointCaptureControl::default());
        let home = Arc::clone(&self.home);
        let workspace_path = workspace.path.clone();
        let label = label.to_string();
        let request_id_owned = request_id.to_string();
        let task_control = Arc::clone(&control);
        let mut task = tokio::spawn(CHECKPOINT_CAPTURE_CONTEXT.scope(task_control, async move {
            create_checkpoint(
                &home,
                &workspace_path,
                &label,
                if request_id_owned.is_empty() {
                    None
                } else {
                    Some(request_id_owned.as_str())
                },
            )
            .await
        }));
        let result = if let Some(receiver) = cancellation.as_mut() {
            tokio::select! {
                biased;
                _ = wait_for_capture_cancellation(receiver) => {
                    match cancel_and_settle_capture_task(&control, &mut task).await {
                        Ok(()) => {
                            let published = self.reconcile_published_request(workspace, request_id).await;
                            return CaptureAttempt::Cancelled(published);
                        }
                        Err(error) => {
                            return CaptureAttempt::Unsettled {
                                message: error,
                                control: Arc::clone(&control),
                            };
                        }
                    }
                }
                result = tokio::time::timeout(budget, &mut task) => result,
            }
        } else {
            tokio::time::timeout(budget, &mut task).await
        };
        match result {
            Ok(Ok(Ok(entry))) => {
                CaptureAttempt::Published(entry["id"].as_str().unwrap_or_default().to_string())
            }
            Ok(Ok(Err(error))) => {
                if let Err(settlement_error) = control.wait_for_process_groups().await {
                    return CaptureAttempt::Unsettled {
                        message: format!(
                            "Git operation failed ({error}); child settlement failed ({settlement_error})"
                        ),
                        control: Arc::clone(&control),
                    };
                }
                if let Some(published) = self
                    .reconcile_published_request(workspace, request_id)
                    .await
                {
                    CaptureAttempt::Published(published)
                } else {
                    CaptureAttempt::Failed(error)
                }
            }
            Ok(Err(error)) => {
                if let Err(settlement_error) = control.cancel_processes().await {
                    tracing::error!(
                        event = "code_checkpoint.process_termination_failed",
                        cause = %settlement_error,
                        "checkpoint child termination was not confirmed after a capture task failure"
                    );
                }
                if let Err(settlement_error) = control.wait_for_process_groups().await {
                    return CaptureAttempt::Unsettled {
                        message: format!(
                            "capture task failed ({error}); child settlement failed ({settlement_error})"
                        ),
                        control: Arc::clone(&control),
                    };
                }
                if let Some(published) = self
                    .reconcile_published_request(workspace, request_id)
                    .await
                {
                    CaptureAttempt::Published(published)
                } else {
                    CaptureAttempt::Failed(format!("checkpoint capture task failed: {error}"))
                }
            }
            Err(_) => {
                if let Err(error) = cancel_and_settle_capture_task(&control, &mut task).await {
                    return CaptureAttempt::Unsettled {
                        message: error,
                        control: Arc::clone(&control),
                    };
                }
                let published = self
                    .reconcile_published_request(workspace, request_id)
                    .await;
                CaptureAttempt::TimedOut(published)
            }
        }
    }

    async fn reconcile_published_request(
        &self,
        workspace: &ResolvedCheckpointWorkspace,
        request_id: &str,
    ) -> Option<String> {
        if request_id.is_empty() {
            return None;
        }
        list_checkpoints(&self.home, &workspace.path)
            .await
            .ok()
            .and_then(|entries| {
                entries
                    .into_iter()
                    .find(|entry| entry["requestId"].as_str() == Some(request_id))
                    .and_then(|entry| entry["id"].as_str().map(str::to_string))
            })
    }
}

enum CaptureAttempt {
    Published(String),
    Failed(String),
    TimedOut(Option<String>),
    Cancelled(Option<String>),
    Unsettled {
        message: String,
        control: Arc<CheckpointCaptureControl>,
    },
}

fn explicit_capture_response(
    checkpoint_id: String,
    label: &str,
    request_id: Option<&str>,
) -> Value {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut response = Map::new();
    response.insert("id".to_string(), json!(checkpoint_id));
    response.insert("ts".to_string(), json!(ts));
    response.insert("label".to_string(), json!(label));
    if let Some(request_id) = request_id {
        response.insert("requestId".to_string(), json!(request_id));
    }
    Value::Object(response)
}

fn checkpoint_attempt_key(send: &FreshAgentSend, logical_attempt_id: &str) -> String {
    let provider = serde_json::to_string(&send.provider).unwrap_or_default();
    let session_type = serde_json::to_string(&send.session_type).unwrap_or_default();
    format!(
        "{provider}:{session_type}:{}:{logical_attempt_id}",
        send.session_id
    )
}

fn parse_agent_provider(value: &str) -> Option<AgentProvider> {
    match value {
        "claude" => Some(AgentProvider::Claude),
        "codex" => Some(AgentProvider::Codex),
        "opencode" => Some(AgentProvider::Opencode),
        _ => None,
    }
}

fn parse_session_type(value: &str) -> Option<SessionType> {
    match value {
        "freshclaude" => Some(SessionType::Freshclaude),
        "freshcodex" => Some(SessionType::Freshcodex),
        "kilroy" => Some(SessionType::Kilroy),
        "freshopencode" => Some(SessionType::Freshopencode),
        _ => None,
    }
}

fn workspace_provenance(value: &str) -> CheckpointWorkspaceProvenance {
    match value {
        "directory-picker" => CheckpointWorkspaceProvenance::DirectoryPicker,
        "legacy-checkpoint" => CheckpointWorkspaceProvenance::LegacyCheckpoint,
        _ => CheckpointWorkspaceProvenance::ResolvedProject,
    }
}

impl freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier for CheckpointService {
    fn barrier_and_forward(
        self: Arc<Self>,
        send: FreshAgentSend,
        forward: futures_util::future::BoxFuture<'static, ()>,
    ) -> futures_util::future::BoxFuture<'static, ()> {
        Box::pin(async move {
            let Some(intent) = send.checkpoint_intent.clone() else {
                forward.await;
                return;
            };
            let Some(request_id) = send
                .request_id
                .clone()
                .filter(|request_id| !request_id.trim().is_empty())
            else {
                tracing::warn!(
                    event = "code_checkpoint.send_missing_request_id",
                    provider = ?send.provider,
                    session_id = %send.session_id,
                    logical_attempt_id = %intent.logical_attempt_id,
                    "checkpoint send was refused because its request identity is missing"
                );
                return;
            };
            let logical_attempt_id = intent.logical_attempt_id.trim().to_string();
            let key = checkpoint_attempt_key(&send, &logical_attempt_id);

            let (job, leader) = {
                let mut jobs = self.attempt_jobs.lock().await;
                if let Some(job) = jobs.get(&key) {
                    (Arc::clone(job), false)
                } else {
                    let (outcome, _) = watch::channel(None);
                    let (finished, _) = watch::channel(false);
                    let job = Arc::new(CheckpointAttemptJob { outcome, finished });
                    jobs.insert(key.clone(), Arc::clone(&job));
                    (job, true)
                }
            };

            if !leader {
                let mut outcome_rx = job.outcome.subscribe();
                while outcome_rx.borrow().is_none() {
                    if outcome_rx.changed().await.is_err() {
                        return;
                    }
                }
                let outcome_snapshot = outcome_rx.borrow().clone();
                if let Some(mut record) = outcome_snapshot {
                    if !record.request_ids.iter().any(|alias| alias == &request_id)
                        && record.request_ids.len() < 16
                    {
                        record.request_ids.push(request_id.clone());
                        let _ = self.persist_outcome(&key, record.clone()).await;
                    }
                    record.outcome.request_id = request_id.clone();
                    self.broadcast_outcome(record.outcome);
                }
                let mut finished_rx = job.finished.subscribe();
                while !*finished_rx.borrow() {
                    if finished_rx.changed().await.is_err() {
                        break;
                    }
                }
                return;
            }

            let mut volatile_fallback = false;
            let (record, mut allow_forward) = match self.find_outcome(&key).await {
                Ok(Some(mut record)) => {
                    let added_alias = !record.request_ids.iter().any(|alias| alias == &request_id)
                        && record.request_ids.len() < 16;
                    if added_alias {
                        record.request_ids.push(request_id.clone());
                    }
                    if !record.capture_settled {
                        if added_alias {
                            if let Err(error) = self.persist_outcome(&key, record.clone()).await {
                                tracing::error!(
                                    event = "code_checkpoint.outcome_alias_persist_failed",
                                    send_request_id = %request_id,
                                    logical_attempt_id = %logical_attempt_id,
                                    cause = %error,
                                    "checkpoint request alias could not be persisted"
                                );
                            }
                        }
                        (record, false)
                    } else if record.dispatch_started {
                        if added_alias {
                            if let Err(error) = self.persist_outcome(&key, record.clone()).await {
                                tracing::error!(
                                    event = "code_checkpoint.outcome_alias_persist_failed",
                                    send_request_id = %request_id,
                                    logical_attempt_id = %logical_attempt_id,
                                    cause = %error,
                                    "checkpoint request alias could not be persisted"
                                );
                            }
                        }
                        // A durable dispatch fence is terminal for this logical
                        // attempt. An explicit retry must use a new attempt ID.
                        (record, false)
                    } else {
                        // Persist the admission fence before forwarding. A crash
                        // after this point can lose a provider send, but cannot
                        // replay the same logical attempt twice.
                        record.dispatch_started = true;
                        match self.persist_outcome(&key, record.clone()).await {
                            Ok(()) => (record, true),
                            Err(error) => {
                                let allow_forward = Self::mark_outcome_store_failure(
                                    &mut record,
                                    "Rewind status could not be saved",
                                );
                                volatile_fallback = true;
                                tracing::error!(
                                    event = "code_checkpoint.outcome_persist_failed",
                                    send_request_id = %request_id,
                                    logical_attempt_id = %logical_attempt_id,
                                    cause = %error,
                                    dispatch_allowed = allow_forward,
                                    dispatch_fence = if allow_forward { "process_local" } else { "none" },
                                    "checkpoint outcome and durable dispatch fence could not be saved"
                                );
                                (record, allow_forward)
                            }
                        }
                    }
                }
                Ok(None) => {
                    let mut record = self
                        .capture_automatic(&send, &request_id, &logical_attempt_id)
                        .await;
                    record.dispatch_started = record.capture_settled;
                    match self.persist_outcome(&key, record.clone()).await {
                        Ok(()) => {
                            let allow_forward = record.capture_settled;
                            (record, allow_forward)
                        }
                        Err(error) => {
                            let allow_forward = Self::mark_outcome_store_failure(
                                &mut record,
                                "Rewind status could not be saved",
                            );
                            volatile_fallback = true;
                            tracing::error!(
                                event = "code_checkpoint.outcome_persist_failed",
                                send_request_id = %request_id,
                                logical_attempt_id = %logical_attempt_id,
                                cause = %error,
                                dispatch_allowed = allow_forward,
                                dispatch_fence = if allow_forward { "process_local" } else { "none" },
                                "checkpoint outcome and durable dispatch fence could not be saved"
                            );
                            (record, allow_forward)
                        }
                    }
                }
                Err(error) => {
                    let (known_attempt, can_rule_out_prior_attempt) =
                        self.attempt_state_for_store_failure(&key);
                    tracing::error!(
                        event = "code_checkpoint.outcome_store_read_failed",
                        send_request_id = %request_id,
                        logical_attempt_id = %logical_attempt_id,
                        cause = %error,
                        known_dispatched_attempt = known_attempt.is_some_and(|state| state.dispatch_started),
                        known_unsettled_attempt = known_attempt.is_some_and(|state| !state.capture_settled),
                        can_rule_out_prior_attempt,
                        "durable checkpoint attempt history is unavailable; dispatch depends on the last trusted snapshot"
                    );
                    let mut record = self.new_record(
                        &send,
                        &logical_attempt_id,
                        &request_id,
                        None,
                        Err((
                            "outcome_store_unavailable",
                            "Rewind status could not be read".into(),
                        )),
                    );
                    let allow_forward = match known_attempt {
                        Some(state) if !state.capture_settled || state.dispatch_started => {
                            Self::mark_known_attempt_store_failure(&mut record, state);
                            false
                        }
                        Some(_) => {
                            volatile_fallback = true;
                            Self::mark_outcome_store_failure(
                                &mut record,
                                "Rewind status could not be read",
                            )
                        }
                        None if can_rule_out_prior_attempt => {
                            volatile_fallback = true;
                            Self::mark_outcome_store_failure(
                                &mut record,
                                "Rewind status could not be read",
                            )
                        }
                        None => {
                            Self::mark_unverified_attempt_store_failure(&mut record);
                            false
                        }
                    };
                    (record, allow_forward)
                }
            };
            let mut record = record;
            record.outcome.request_id = request_id.clone();
            if volatile_fallback && !self.remember_volatile_outcome(&key, record.clone()) {
                Self::mark_volatile_fence_capacity_failure(&mut record);
                allow_forward = false;
                tracing::error!(
                    event = "code_checkpoint.volatile_fence_capacity_exhausted",
                    send_request_id = %request_id,
                    logical_attempt_id = %logical_attempt_id,
                    capacity = CHECKPOINT_VOLATILE_FENCE_LIMIT,
                    "checkpoint send was withheld because its process-local duplicate fence could not be retained"
                );
            }
            self.broadcast_outcome(record.outcome.clone());
            job.outcome.send_replace(Some(record));
            if allow_forward {
                forward.await;
            }
            job.finished.send_replace(true);
            let mut jobs = self.attempt_jobs.lock().await;
            if jobs
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &job))
            {
                jobs.remove(&key);
            }
        })
    }

    fn replay_for_session(
        self: Arc<Self>,
        provider: AgentProvider,
        session_id: String,
        session_type: SessionType,
    ) -> futures_util::future::BoxFuture<'static, ()> {
        Box::pin(async move {
            self.replay_for_identity(provider, &session_id, session_type)
                .await;
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedCheckpointWorkspace {
    path: PathBuf,
    provenance: String,
}

#[derive(Debug)]
struct CheckpointWorkspaceUnavailable {
    candidate: String,
    reason: String,
}

impl CheckpointWorkspaceUnavailable {
    fn response(&self) -> Response {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": self.reason,
                "code": "workspace_unavailable",
                "workspace": self.candidate,
                "details": self.reason,
            })),
        )
            .into_response()
    }
}

#[derive(Debug)]
struct CheckpointFailure {
    stage: &'static str,
    operation: String,
    code: &'static str,
    workspace: String,
    path: Option<String>,
    filesystem_kind: Option<String>,
    errno: Option<i32>,
    git_exit_status: Option<i32>,
    cause: String,
    user_details: &'static str,
}

impl CheckpointFailure {
    fn from_capture_detail(home: &Path, workspace: &Path, detail: &str) -> Self {
        let mut operation = "capture".to_string();
        let mut path = None;
        let mut cause = detail;
        if let Some(after_prefix) = detail.strip_prefix("checkpoint operation ") {
            if let Some((name, after_name)) = after_prefix.split_once(" failed") {
                operation = name.to_string();
                if let Some(after_for) = after_name.strip_prefix(" for ") {
                    if let Some((path_value, cause_value)) = after_for.split_once(": ") {
                        path = Some(path_value.to_string());
                        cause = cause_value;
                    }
                } else if let Some(cause_value) = after_name.strip_prefix(": ") {
                    cause = cause_value;
                }
            }
        }
        if let Some(after_prefix) = detail.strip_prefix("Git operation ") {
            if let Some((name, after_name)) = after_prefix.split_once(" failed") {
                operation = name.to_string();
                cause = after_name.trim_start_matches([' ', ':']);
            }
        } else if detail.starts_with("git index update failed") {
            operation = "git-index-update".to_string();
            cause = detail;
        } else if detail.starts_with("failed to read checkpoint metadata") {
            operation = "read-metadata".to_string();
            cause = detail;
        } else if detail.starts_with("failed to persist checkpoint metadata") {
            operation = "write-metadata".to_string();
            cause = detail;
        }

        if path.is_none() && matches!(operation.as_str(), "read-metadata" | "write-metadata") {
            path = Some(
                checkpoint_metadata_path(&checkpoint_git_dir(home, workspace))
                    .to_string_lossy()
                    .into_owned(),
            );
        }

        if path.is_none() {
            path = git_open_failure_path(detail);
        }

        let git_exit_status = cause
            .split_once("exit_status=")
            .and_then(|(_, rest)| {
                rest.strip_prefix("Some(")
                    .unwrap_or(rest)
                    .split(|ch: char| !ch.is_ascii_digit() && ch != '-')
                    .next()
            })
            .and_then(|value| value.parse::<i32>().ok());
        let lowered_cause = cause.to_ascii_lowercase();
        let filesystem_kind = if lowered_cause.contains("permission denied") {
            Some("PermissionDenied".to_string())
        } else if lowered_cause.contains("is a directory") {
            Some("IsADirectory".to_string())
        } else {
            None
        };
        let errno = cause
            .split_once("os error ")
            .and_then(|(_, rest)| {
                rest.split(|ch: char| !ch.is_ascii_digit() && ch != '-')
                    .next()
            })
            .and_then(|value| value.parse::<i32>().ok());
        let permission_denied = cause.to_ascii_lowercase().contains("permission denied");
        let unreadable = operation == "verify-readable"
            || operation == "verify-symlink"
            || (permission_denied && path.is_some());
        Self {
            stage: if unreadable { "readability" } else { "capture" },
            operation,
            code: if unreadable {
                "checkpoint_path_unreadable"
            } else {
                "checkpoint_capture_failed"
            },
            workspace: workspace.to_string_lossy().into_owned(),
            path,
            filesystem_kind,
            errno,
            git_exit_status,
            cause: bounded_log_detail(cause),
            user_details: if unreadable {
                "A selected project file could not be read, so this code checkpoint is unavailable."
            } else {
                "The project code checkpoint could not be saved."
            },
        }
    }

    fn log(&self, send_request_id: Option<&str>) {
        if self.code == "checkpoint_path_unreadable" {
            tracing::warn!(
                target: "freshell_server::checkpoints",
                event = "code_checkpoint.failed",
                send_request_id = %send_request_id.unwrap_or(""),
                stage = self.stage,
                operation = %self.operation,
                failure_code = self.code,
                workspace = %self.workspace,
                path = %self.path.as_deref().unwrap_or(""),
                filesystem_kind = %self.filesystem_kind.as_deref().unwrap_or(""),
                errno = self.errno.unwrap_or_default(),
                git_exit_status = self.git_exit_status.unwrap_or_default(),
                cause = %self.cause,
                "code checkpoint failed"
            );
        } else {
            tracing::error!(
                target: "freshell_server::checkpoints",
                event = "code_checkpoint.failed",
                send_request_id = %send_request_id.unwrap_or(""),
                stage = self.stage,
                operation = %self.operation,
                failure_code = self.code,
                workspace = %self.workspace,
                path = %self.path.as_deref().unwrap_or(""),
                filesystem_kind = %self.filesystem_kind.as_deref().unwrap_or(""),
                errno = self.errno.unwrap_or_default(),
                git_exit_status = self.git_exit_status.unwrap_or_default(),
                cause = %self.cause,
                "code checkpoint failed"
            );
        }
    }

    fn response(&self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "Code checkpoint unavailable",
                "code": self.code,
                "details": self.user_details,
                "workspace": self.workspace,
            })),
        )
            .into_response()
    }
}

fn git_open_failure_path(detail: &str) -> Option<String> {
    let (start, marker) = ["fatal: open(", "error: open("]
        .iter()
        .find_map(|marker| detail.find(marker).map(|start| (start, *marker)))?;
    let start = start + marker.len();
    let remainder = &detail[start..];
    let (path, suffix) = match remainder.as_bytes().first().copied() {
        Some(b'\'') => {
            let end = remainder[1..].find("'):")? + 1;
            (&remainder[1..end], &remainder[end + 3..])
        }
        Some(b'\"') => {
            let end = remainder[1..].find("\"):")? + 1;
            (&remainder[1..end], &remainder[end + 3..])
        }
        _ => {
            let end = remainder.find("):")?;
            (&remainder[..end], &remainder[end + 2..])
        }
    };
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
        || !suffix.to_ascii_lowercase().contains("permission denied")
    {
        return None;
    }
    Some(path.to_string_lossy().into_owned())
}

fn bounded_log_detail(detail: &str) -> String {
    detail
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(240)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn safe_send_request_id(request_id: Option<&str>) -> Option<&str> {
    request_id.filter(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
    })
}

fn log_workspace_unavailable(candidate: &str, cause: &str, send_request_id: Option<&str>) {
    tracing::warn!(
        target: "freshell_server::checkpoints",
        event = "code_checkpoint.failed",
        send_request_id = %send_request_id.unwrap_or(""),
        stage = "workspace-resolution",
        operation = "resolve-workspace",
        failure_code = "workspace_unavailable",
        workspace = candidate,
        path = candidate,
        cause = %bounded_log_detail(cause),
        "code checkpoint workspace unavailable"
    );
}

fn recognized_account_homes(server_home: Option<&Path>) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    let mut add_existing = |candidate: &Path| {
        if let Ok(canonical) = std::fs::canonicalize(candidate) {
            if !homes.contains(&canonical) {
                homes.push(canonical);
            }
        }
    };
    if let Some(server_home) = server_home {
        add_existing(server_home);
    }
    for variable in ["HOME", "USERPROFILE"] {
        if let Some(value) = std::env::var_os(variable) {
            add_existing(Path::new(&value));
        }
    }
    #[cfg(unix)]
    if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
        for line in passwd.lines() {
            let fields = line.split(':').collect::<Vec<_>>();
            if fields.len() >= 6 && !fields[5].is_empty() {
                add_existing(Path::new(fields[5]));
            }
        }
    }
    #[cfg(windows)]
    if let (Some(drive), Some(path)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
    {
        add_existing(&PathBuf::from(drive).join(path));
    }
    homes
}

pub fn is_os_account_home(candidate: &Path) -> bool {
    let Ok(candidate) = std::fs::canonicalize(candidate) else {
        return false;
    };
    is_recognized_account_home(&candidate, &recognized_account_homes(None))
}

fn is_recognized_account_home(path: &Path, homes: &[PathBuf]) -> bool {
    homes.iter().any(|home| home == path)
}

async fn canonical_workspace(path: &Path) -> Result<PathBuf, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("workspace is not accessible: {error}"))?;
    if !metadata.is_dir() {
        return Err("workspace is not a directory".to_string());
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("workspace cannot be resolved: {error}"))
}

async fn git_checkout_root(path: &Path) -> Option<PathBuf> {
    let output = run_git(&["rev-parse", "--show-toplevel"], Some(path))
        .await
        .ok()?;
    tokio::fs::canonicalize(output.trim()).await.ok()
}

async fn resolve_checkpoint_workspace(
    server_home: &Path,
    launch_cwd: &Path,
    intent: Option<&Value>,
) -> Result<ResolvedCheckpointWorkspace, CheckpointWorkspaceUnavailable> {
    let candidate = intent
        .and_then(|workspace| workspace.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| launch_cwd.to_string_lossy().into_owned());
    let homes = recognized_account_homes(Some(server_home));
    if let Some(workspace) = intent {
        let provenance = workspace
            .get("provenance")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "directory-picker" | "resolved-project" | "legacy-checkpoint"
                )
            })
            .map(str::to_string)
            .ok_or_else(|| CheckpointWorkspaceUnavailable {
                candidate: candidate.clone(),
                reason: "workspace selection has no recognized provenance".to_string(),
            })?;
        let selected = canonical_workspace(Path::new(&candidate))
            .await
            .map_err(|reason| CheckpointWorkspaceUnavailable {
                candidate: candidate.clone(),
                reason,
            })?;
        if is_recognized_account_home(&selected, &homes) {
            return Err(CheckpointWorkspaceUnavailable {
                candidate,
                reason: "account home cannot be used as a code checkpoint workspace".to_string(),
            });
        }
        let path = if provenance == "legacy-checkpoint" {
            selected
        } else {
            git_checkout_root(&selected).await.unwrap_or(selected)
        };
        if is_recognized_account_home(&path, &homes) {
            return Err(CheckpointWorkspaceUnavailable {
                candidate,
                reason: "account home cannot be used as an inferred code checkpoint workspace"
                    .to_string(),
            });
        }
        return Ok(ResolvedCheckpointWorkspace { path, provenance });
    }

    let launch =
        canonical_workspace(launch_cwd)
            .await
            .map_err(|reason| CheckpointWorkspaceUnavailable {
                candidate: candidate.clone(),
                reason,
            })?;
    if is_recognized_account_home(&launch, &homes) {
        return Err(CheckpointWorkspaceUnavailable {
            candidate,
            reason: "account home has no selected code checkpoint workspace".to_string(),
        });
    }
    let root = git_checkout_root(&launch)
        .await
        .ok_or_else(|| CheckpointWorkspaceUnavailable {
            candidate: candidate.clone(),
            reason: "no explicit workspace or Git project root is available".to_string(),
        })?;
    let path = root;
    if is_recognized_account_home(&path, &homes) {
        return Err(CheckpointWorkspaceUnavailable {
            candidate,
            reason: "account home cannot be used as an inferred code checkpoint workspace"
                .to_string(),
        });
    }
    Ok(ResolvedCheckpointWorkspace {
        path,
        provenance: "resolved-project".to_string(),
    })
}

fn workspace_response_value(workspace: &ResolvedCheckpointWorkspace) -> Value {
    json!({
        "path": workspace.path.to_string_lossy(),
        "provenance": workspace.provenance,
    })
}

/// The `/api/fresh-agent/checkpoints` sub-router. `GET` (list) and `POST`
/// (create) share the one `/checkpoints` path; `restore` and `metadata` are
/// their own POST-only sibling paths (`fresh-agent-extras-router.ts:230-232`).
pub fn router(state: CheckpointsApiState) -> Router {
    Router::new()
        .route(
            "/api/fresh-agent/checkpoints",
            post(post_checkpoint).get(get_method(get_checkpoints)),
        )
        .route(
            "/api/fresh-agent/checkpoints/restore",
            post(post_checkpoint_restore),
        )
        .route(
            "/api/fresh-agent/checkpoints/metadata",
            post(post_checkpoint_metadata),
        )
        .with_state(state)
}

async fn post_checkpoint(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = match body
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(cwd) => cwd.to_string(),
        None => return bad_request("cwd is required"),
    };

    let label = body
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(CHECKPOINT_LABEL_LIMIT).collect::<String>())
        .unwrap_or_else(|| "checkpoint".to_string());

    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let send_request_id = safe_send_request_id(request_id.as_deref());
    match state
        .service
        .capture_explicit(
            PathBuf::from(&cwd),
            body.get("workspace").cloned(),
            label,
            request_id.clone(),
        )
        .await
    {
        Ok((mut entry, workspace)) => {
            if let Some(fields) = entry.as_object_mut() {
                fields.insert(
                    "workspace".to_string(),
                    workspace_response_value(&workspace),
                );
            }
            Json(entry).into_response()
        }
        Err(ExplicitCaptureError::WorkspaceUnavailable(error)) => {
            log_workspace_unavailable(&error.candidate, &error.reason, send_request_id);
            error.response()
        }
        Err(ExplicitCaptureError::ResolutionTimeout(candidate)) => {
            tracing::warn!(
                event = "code_checkpoint.workspace_resolution_timeout",
                request_id = ?send_request_id,
                candidate = %candidate,
                "checkpoint workspace resolution exceeded its budget"
            );
            let failure = CheckpointFailure::from_capture_detail(
                &state.home,
                Path::new(&candidate),
                "workspace resolution timed out",
            );
            failure.log(send_request_id);
            failure.response()
        }
        Err(ExplicitCaptureError::WorkspaceBusy(workspace)) => {
            tracing::warn!(
                event = "code_checkpoint.workspace_lock_timeout",
                request_id = ?send_request_id,
                workspace = %workspace.path.display(),
                "checkpoint workspace stayed busy until the request budget expired"
            );
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "checkpoint workspace lock wait timed out" })),
            )
                .into_response()
        }
        Err(ExplicitCaptureError::Capture { workspace, message }) => {
            let failure =
                CheckpointFailure::from_capture_detail(&state.home, &workspace.path, &message);
            failure.log(send_request_id);
            failure.response()
        }
        Err(ExplicitCaptureError::Unsettled {
            candidate,
            workspace,
            message,
        }) => {
            let path = workspace
                .as_ref()
                .map(|workspace| workspace.path.as_path())
                .unwrap_or(candidate.as_path());
            tracing::error!(
                event = "code_checkpoint.capture_settlement_failed",
                request_id = ?send_request_id,
                workspace = %path.display(),
                cause = %message,
                "checkpoint child settlement could not be confirmed; no provider dispatch is involved"
            );
            let failure = CheckpointFailure::from_capture_detail(
                &state.home,
                path,
                "checkpoint child settlement could not be confirmed",
            );
            failure.log(send_request_id);
            failure.response()
        }
        Err(ExplicitCaptureError::Cancelled) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "checkpoint capture was cancelled" })),
        )
            .into_response(),
        Err(ExplicitCaptureError::ServiceStopped) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "checkpoint capture service stopped unexpectedly" })),
        )
            .into_response(),
    }
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

// ── checkpoint git operations (fresh-agent-extras-router.ts:75-184) ─────────

/// `createCheckpoint` (`fresh-agent-extras-router.ts:174-184`): `git add -A` +
/// `commit --allow-empty` in the shadow repo, then (iff a `requestId` was
/// supplied) persist a `sha -> {requestId}` metadata entry. Returns the exact
/// legacy response shape.
async fn create_checkpoint(
    home: &Path,
    cwd: &Path,
    label: &str,
    request_id: Option<&str>,
) -> Result<Value, String> {
    let capture_started_at = Instant::now();
    if CHECKPOINT_CAPTURE_CONTEXT.try_with(|_| ()).is_err() {
        return Err("checkpoint capture requires the server-owned capture runner".to_string());
    }
    let repo_prepare_started_at = Instant::now();
    let git_dir = ensure_checkpoint_repo(home, cwd).await?;
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", cwd.display());

    let index_path = git_dir.join("index");
    let request_index = git_dir.join(format!("index.tmp-{}", uuid::Uuid::new_v4()));
    let old_head = run_git(&[&git_dir_arg, "rev-parse", "--verify", "HEAD"], None)
        .await
        .ok()
        .map(|head| head.trim().to_string());

    if old_head.is_some() {
        if tokio::fs::copy(&index_path, &request_index).await.is_err() {
            let tree = run_git(&[&git_dir_arg, "rev-parse", "HEAD^{tree}"], None)
                .await?
                .trim()
                .to_string();
            run_git_with_index(&[&git_dir_arg, "read-tree", &tree], None, &request_index).await?;
        } else {
            let cached_tree =
                run_git_with_index(&[&git_dir_arg, "write-tree"], None, &request_index)
                    .await
                    .ok()
                    .map(|tree| tree.trim().to_string());
            let published_tree = run_git(&[&git_dir_arg, "rev-parse", "HEAD^{tree}"], None)
                .await
                .ok()
                .map(|tree| tree.trim().to_string());
            if cached_tree != published_tree {
                let _ = tokio::fs::remove_file(&request_index).await;
                let tree = published_tree.ok_or_else(|| {
                    "checkpoint operation resolve-published-tree failed: current HEAD is unavailable"
                        .to_string()
                })?;
                run_git_with_index(&[&git_dir_arg, "read-tree", &tree], None, &request_index)
                    .await?;
            }
        }
    } else {
        run_git_with_index(
            &[&git_dir_arg, "read-tree", "--empty"],
            None,
            &request_index,
        )
        .await?;
    }
    let repo_prepare_ms = repo_prepare_started_at.elapsed().as_millis() as u64;
    let mut stage_ms = BTreeMap::<&'static str, u64>::new();

    let capture = async {
        let stage_started_at = Instant::now();
        verify_readable_directories(&git_dir, cwd).await?;
        stage_ms.insert("readability", stage_started_at.elapsed().as_millis() as u64);

        let stage_started_at = Instant::now();
        run_git_with_index(
            &[&git_dir_arg, &work_tree_arg, "add", "-A", "--", "."],
            Some(cwd),
            &request_index,
        )
        .await?;
        stage_ms.insert("git_add", stage_started_at.elapsed().as_millis() as u64);

        let stage_started_at = Instant::now();
        expand_nested_repositories(&git_dir, cwd, &request_index).await?;
        stage_ms.insert(
            "nested_expansion",
            stage_started_at.elapsed().as_millis() as u64,
        );

        let stage_started_at = Instant::now();
        let eligible_file_count = verify_checkpoint_index(&git_dir, cwd, &request_index).await?;
        stage_ms.insert(
            "index_validation",
            stage_started_at.elapsed().as_millis() as u64,
        );

        let stage_started_at = Instant::now();
        let tree = run_git_with_index(&[&git_dir_arg, "write-tree"], None, &request_index)
            .await?
            .trim()
            .to_string();
        let mut commit_args: Vec<&str> = vec![git_dir_arg.as_str()];
        commit_args.extend(CHECKPOINT_IDENTITY);
        commit_args.extend(["commit-tree", tree.as_str()]);
        if let Some(parent) = old_head.as_deref() {
            commit_args.extend(["-p", parent]);
        }
        commit_args.extend(["-m", label]);
        let sha = run_git(&commit_args, None).await?.trim().to_string();

        let changed_file_count = run_git_bytes(
            &[
                &git_dir_arg,
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                &sha,
            ],
            None,
        )
        .await?
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .count();
        stage_ms.insert(
            "tree_and_commit",
            stage_started_at.elapsed().as_millis() as u64,
        );

        if let Some(request_id) = request_id {
            let stage_started_at = Instant::now();
            update_checkpoint_metadata(&git_dir, &sha, request_id).await?;
            stage_ms.insert("metadata", stage_started_at.elapsed().as_millis() as u64);
        }

        let stage_started_at = Instant::now();
        let head_ref = run_git(&[&git_dir_arg, "symbolic-ref", "HEAD"], None)
            .await?
            .trim()
            .to_string();
        let mut update_ref = vec![&git_dir_arg, "update-ref", head_ref.as_str(), sha.as_str()];
        if let Some(parent) = old_head.as_deref() {
            update_ref.push(parent);
        }
        run_git(&update_ref, None).await?;
        stage_ms.insert(
            "ref_publication",
            stage_started_at.elapsed().as_millis() as u64,
        );

        Ok::<(String, usize, usize), String>((sha, eligible_file_count, changed_file_count))
    }
    .await;

    let (sha, eligible_file_count, changed_file_count) = match capture {
        Ok(capture) => capture,
        Err(error) => {
            let _ = tokio::fs::remove_file(&request_index).await;
            return Err(error);
        }
    };

    // The published tree is already complete. Losing this disposable stat cache
    // can make the next request slower, but cannot hide or invalidate a target.
    let index_cache_started_at = Instant::now();
    if let Err(error) = install_checkpoint_index(&request_index, &index_path).await {
        tracing::warn!(
            event = "code_checkpoint.index_cache_install_failed",
            workspace = %cwd.display(),
            cause = %error,
            "checkpoint index cache could not be retained"
        );
        let _ = tokio::fs::remove_file(&request_index).await;
    }
    let index_cache_install_ms = index_cache_started_at.elapsed().as_millis() as u64;

    tracing::info!(
        event = "code_checkpoint.capture_succeeded",
        workspace = %cwd.display(),
        request_id = ?safe_send_request_id(request_id),
        checkpoint_id = %sha,
        eligible_file_count,
        changed_file_count,
        repo_prepare_ms,
        readability_ms = stage_ms.get("readability").copied().unwrap_or_default(),
        git_add_ms = stage_ms.get("git_add").copied().unwrap_or_default(),
        nested_expansion_ms = stage_ms.get("nested_expansion").copied().unwrap_or_default(),
        index_validation_ms = stage_ms.get("index_validation").copied().unwrap_or_default(),
        tree_and_commit_ms = stage_ms.get("tree_and_commit").copied().unwrap_or_default(),
        metadata_ms = stage_ms.get("metadata").copied().unwrap_or_default(),
        ref_publication_ms = stage_ms.get("ref_publication").copied().unwrap_or_default(),
        index_cache_install_ms,
        total_ms = capture_started_at.elapsed().as_millis() as u64,
        "checkpoint capture published successfully"
    );

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut entry = Map::new();
    entry.insert("id".to_string(), json!(sha));
    entry.insert("ts".to_string(), json!(ts));
    entry.insert("label".to_string(), json!(label));
    if let Some(request_id) = request_id {
        entry.insert("requestId".to_string(), json!(request_id));
    }
    Ok(Value::Object(entry))
}

/// `ensureCheckpointRepo` (`fresh-agent-extras-router.ts:96-105`): create the
/// bare shadow repo on first use for this `cwd`, otherwise reuse it.
async fn ensure_checkpoint_repo(home: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let git_dir = checkpoint_git_dir(home, cwd);
    match tokio::fs::metadata(git_dir.join("HEAD")).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(&git_dir)
                .await
                .map_err(|e| format!("failed to create checkpoint dir: {e}"))?;
            run_git(&["init", "--bare", "-q", &git_dir.to_string_lossy()], None).await?;
        }
        Err(error) => return Err(format!("failed to inspect checkpoint repository: {error}")),
    }
    Ok(git_dir)
}

/// `checkpointGitDir` (`fresh-agent-extras-router.ts:75-78`): the shadow repo
/// path is `<home>/.freshell/checkpoints/<first-16-hex-of-sha1(resolved cwd)>.git`
/// — a stable, deterministic per-cwd identity.
fn checkpoint_git_dir(home: &Path, cwd: &Path) -> PathBuf {
    let resolved = resolve_absolute(cwd);
    let mut hasher = Sha1::new();
    hasher.update(resolved.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex = hex_encode(&digest);
    let short = &hex[..16.min(hex.len())];
    home.join(".freshell")
        .join("checkpoints")
        .join(format!("{short}.git"))
}

/// Lexical (no symlink-following) equivalent of Node's `path.resolve(cwd)`: an
/// already-absolute path is normalized (`.`/`..` segments collapsed); a relative
/// one is resolved against the process's current directory first. Node's
/// `path.resolve` never touches the filesystem (no symlink resolution) — this
/// mirrors that, unlike `Path::canonicalize` which would.
fn resolve_absolute(input: &Path) -> PathBuf {
    let base = if input.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    let mut components: Vec<std::ffi::OsString> = Vec::new();
    for comp in base.components().chain(input.components()) {
        match comp {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                components.clear();
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::Normal(part) => {
                components.push(part.to_os_string());
            }
        }
    }
    let mut result = PathBuf::from("/");
    for c in components {
        result.push(c);
    }
    result
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Run Git without exposing the shadow-store flags or full argv in diagnostics.
/// Failures retain a safe operation name, exit status, and bounded stderr cause.
async fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let output = invoke_git(args, cwd, None).await?;
    check_git_output(args, output)
}

async fn run_git_with_index(
    args: &[&str],
    cwd: Option<&Path>,
    index: &Path,
) -> Result<String, String> {
    let output = invoke_git(args, cwd, Some(index)).await?;
    check_git_output(args, output)
}

async fn run_git_bytes(args: &[&str], cwd: Option<&Path>) -> Result<Vec<u8>, String> {
    let output = invoke_git(args, cwd, None).await?;
    check_git_output_bytes(args, output)
}

async fn run_git_with_index_bytes(
    args: &[&str],
    cwd: Option<&Path>,
    index: &Path,
) -> Result<Vec<u8>, String> {
    let output = invoke_git(args, cwd, Some(index)).await?;
    check_git_output_bytes(args, output)
}

async fn run_git_with_index_input(
    args: &[&str],
    cwd: Option<&Path>,
    index: &Path,
    input: &[u8],
) -> Result<(), String> {
    let mut cmd = Command::new("git");
    // Request cancellation drops this future. Tokio leaves child processes
    // running by default, so every checkpoint-owned Git process must be
    // configured to stop with its request instead of outliving it.
    cmd.kill_on_drop(true);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.env("GIT_INDEX_FILE", index);
    let mut child = checkpoint_child(&mut cmd)
        .map_err(|error| format!("git update-index failed to start: {error}"))?;
    if let Some(mut stdin) = child.child.as_mut().and_then(|child| child.stdin.take()) {
        if let Err(error) = stdin.write_all(input).await {
            child.terminate_and_wait().await;
            return Err(format!(
                "git update-index failed to write path list: {error}"
            ));
        }
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("git update-index failed to wait: {error}"))?;
    check_git_output_bytes(args, output).map(|_| ())
}

async fn ignored_git_directories(
    git_dir: &Path,
    work_tree: &Path,
    directory_paths: &[Vec<u8>],
) -> Result<std::collections::HashSet<Vec<u8>>, String> {
    if directory_paths.is_empty() {
        return Ok(std::collections::HashSet::new());
    }

    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", work_tree.display());
    let mut command = Command::new("git");
    command
        .kill_on_drop(true)
        .arg(git_dir_arg)
        .arg(work_tree_arg)
        .args(["check-ignore", "--no-index", "--stdin", "-z"])
        .current_dir(work_tree)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = checkpoint_child(&mut command)
        .map_err(|error| format!("git check-ignore failed to start: {error}"))?;
    let mut input = Vec::new();
    for path in directory_paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    if let Some(mut stdin) = child.child.as_mut().and_then(|child| child.stdin.take()) {
        if let Err(error) = stdin.write_all(&input).await {
            child.terminate_and_wait().await;
            return Err(format!("git check-ignore failed to write paths: {error}"));
        }
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("git check-ignore failed to wait: {error}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(format!(
            "Git operation check-ignore failed (exit_status={:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

fn git_path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        path.to_string_lossy().as_bytes().to_vec()
    }
}

fn display_relative_path(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path.to_string_lossy().into_owned()
    }
}

async fn verify_readable_directories(git_dir: &Path, work_tree: &Path) -> Result<(), String> {
    let mut pending = vec![PathBuf::new()];
    while let Some(relative_parent) = pending.pop() {
        let absolute_parent = work_tree.join(&relative_parent);
        let mut entries = tokio::fs::read_dir(&absolute_parent)
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    display_relative_path(&relative_parent)
                )
            })?;
        let mut candidates = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            format!(
                "checkpoint operation verify-readable failed for {}: {error}",
                display_relative_path(&relative_parent)
            )
        })? {
            if entry.file_name() == ".git" {
                continue;
            }
            let file_type = entry.file_type().await.map_err(|error| {
                let relative = relative_parent.join(entry.file_name());
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    display_relative_path(&relative)
                )
            })?;
            if !file_type.is_dir() {
                continue;
            }
            let relative = relative_parent.join(entry.file_name());
            let mut ignore_path = git_path_bytes(&relative);
            ignore_path.push(b'/');
            candidates.push((relative, ignore_path));
        }

        let candidate_paths = candidates
            .iter()
            .map(|(_, path)| path.clone())
            .collect::<Vec<_>>();
        let ignored = ignored_git_directories(git_dir, work_tree, &candidate_paths).await?;
        for (relative, ignore_path) in candidates {
            if !ignored.contains(&ignore_path) {
                pending.push(relative);
            }
        }
    }
    Ok(())
}

async fn invoke_git(
    args: &[&str],
    cwd: Option<&Path>,
    index: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    // Unlike JavaScript child_process, Tokio's default is to leave a child
    // alive when its owner future is dropped. HTTP cancellation must not
    // detach an in-flight snapshot command.
    cmd.kill_on_drop(true);
    cmd.args(args);
    // `wait_with_output` only captures the output streams that were explicitly
    // piped. Keep Git output available for both normal values (tree/ref ids)
    // and actionable structured failure causes instead of inheriting/discarding
    // it in the server process.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    checkpoint_read_only_child(&mut cmd)
        .map_err(|e| format!("Git process failed to start: {e}"))?
        .wait_with_output()
        .await
        .map_err(|e| format!("Git process failed to wait: {e}"))
}

fn check_git_output(args: &[&str], output: std::process::Output) -> Result<String, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let operation = git_operation_label(args);
        let message = if stderr.trim().is_empty() {
            format!(
                "Git operation {operation} failed (exit_status={:?})",
                output.status.code()
            )
        } else {
            format!(
                "Git operation {operation} failed (exit_status={:?}): {}",
                output.status.code(),
                stderr.trim()
            )
        };
        return Err(message);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn check_git_output_bytes(args: &[&str], output: std::process::Output) -> Result<Vec<u8>, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let operation = git_operation_label(args);
        let message = if stderr.trim().is_empty() {
            format!(
                "Git operation {operation} failed (exit_status={:?})",
                output.status.code()
            )
        } else {
            format!(
                "Git operation {operation} failed (exit_status={:?}): {}",
                output.status.code(),
                stderr.trim()
            )
        };
        return Err(message);
    }
    Ok(output.stdout)
}

fn git_operation_label(args: &[&str]) -> &'static str {
    args.iter()
        .rev()
        .find_map(|argument| match *argument {
            "add" => Some("add"),
            "check-ignore" => Some("check-ignore"),
            "read-tree" => Some("read-tree"),
            "write-tree" => Some("write-tree"),
            "commit-tree" => Some("commit-tree"),
            "update-ref" => Some("update-ref"),
            "ls-files" => Some("ls-files"),
            "rev-parse" => Some("rev-parse"),
            "symbolic-ref" => Some("symbolic-ref"),
            "merge-base" => Some("merge-base"),
            "log" => Some("log"),
            "checkout" => Some("checkout"),
            "init" => Some("init"),
            "config" => Some("config"),
            _ => None,
        })
        .unwrap_or("other")
}

#[derive(Clone, Debug)]
struct GitIndexEntry {
    mode: Vec<u8>,
    path: Vec<u8>,
}

fn parse_git_index_entries(raw: &[u8]) -> Result<Vec<GitIndexEntry>, String> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| {
            let separator = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(|| {
                    "checkpoint operation inspect-index failed: malformed Git index row".to_string()
                })?;
            let mode = record[..separator]
                .split(|byte| byte.is_ascii_whitespace())
                .next()
                .unwrap_or_default()
                .to_vec();
            Ok(GitIndexEntry {
                mode,
                path: record[separator + 1..].to_vec(),
            })
        })
        .collect()
}

async fn checkpoint_index_entries(
    git_dir: &Path,
    index: &Path,
) -> Result<Vec<GitIndexEntry>, String> {
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let raw =
        run_git_with_index_bytes(&[&git_dir_arg, "ls-files", "--stage", "-z"], None, index).await?;
    parse_git_index_entries(&raw)
}

#[cfg(unix)]
fn git_relative_path(path: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(path))
}

#[cfg(windows)]
fn git_relative_path(path: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(path).as_ref())
}

fn git_path_ancestors(path: &[u8]) -> Vec<Vec<u8>> {
    let mut ancestors = Vec::new();
    for (index, byte) in path.iter().enumerate() {
        if *byte == b'/' && index > 0 {
            ancestors.push(path[..index].to_vec());
        }
    }
    ancestors
}

fn join_git_path(prefix: &[u8], relative: &[u8]) -> Vec<u8> {
    let mut joined = Vec::with_capacity(prefix.len() + 1 + relative.len());
    joined.extend_from_slice(prefix);
    joined.push(b'/');
    joined.extend_from_slice(relative);
    joined
}

fn git_path_is_at_or_below(path: &[u8], prefix: &[u8]) -> bool {
    path == prefix || (path.starts_with(prefix) && path.get(prefix.len()) == Some(&b'/'))
}

async fn directory_has_git_marker(work_tree: &Path, relative: &[u8]) -> bool {
    let path = work_tree.join(git_relative_path(relative));
    let metadata = tokio::fs::symlink_metadata(&path).await;
    if !metadata.is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink()) {
        return false;
    }
    tokio::fs::symlink_metadata(path.join(".git")).await.is_ok()
}

async fn nested_git_roots(
    repo_work_tree: &Path,
    staged: &[GitIndexEntry],
    selected_paths: &[Vec<u8>],
) -> Vec<Vec<u8>> {
    let mut candidates = Vec::new();
    for entry in staged {
        if entry.mode == b"160000" {
            candidates.push(entry.path.clone());
        }
        for ancestor in git_path_ancestors(&entry.path) {
            if directory_has_git_marker(repo_work_tree, &ancestor).await {
                candidates.push(ancestor);
            }
        }
    }
    for path in selected_paths {
        for ancestor in git_path_ancestors(path) {
            if directory_has_git_marker(repo_work_tree, &ancestor).await {
                candidates.push(ancestor);
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

async fn collect_nested_snapshot_paths(
    nested_root: &Path,
    index_prefix: &[u8],
    files: &mut Vec<Vec<u8>>,
) -> Result<(), String> {
    let mut pending = vec![(nested_root.to_path_buf(), index_prefix.to_vec(), 0usize)];
    while let Some((repo_root, prefix, depth)) = pending.pop() {
        if depth > 64 {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: nested repository depth exceeds 64",
                String::from_utf8_lossy(&prefix)
            ));
        }
        let root_metadata = tokio::fs::symlink_metadata(&repo_root)
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                    String::from_utf8_lossy(&prefix)
                )
            })?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: expected a populated repository directory",
                String::from_utf8_lossy(&prefix)
            ));
        }

        let top = run_git(&["rev-parse", "--show-toplevel"], Some(&repo_root))
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                    String::from_utf8_lossy(&prefix)
                )
            })?;
        let canonical_root = tokio::fs::canonicalize(&repo_root).await.map_err(|error| {
            format!(
                "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                String::from_utf8_lossy(&prefix)
            )
        })?;
        let canonical_git_root = tokio::fs::canonicalize(top.trim()).await.map_err(|error| {
            format!(
                "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                String::from_utf8_lossy(&prefix)
            )
        })?;
        if canonical_root != canonical_git_root {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: Git resolves this path to a different repository root",
                String::from_utf8_lossy(&prefix)
            ));
        }

        let staged_raw = run_git_bytes(&["ls-files", "--stage", "-z"], Some(&repo_root))
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                    String::from_utf8_lossy(&prefix)
                )
            })?;
        let staged = parse_git_index_entries(&staged_raw)?;
        let selected_raw = run_git_bytes(
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            Some(&repo_root),
        )
        .await
        .map_err(|error| {
            format!(
                "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                String::from_utf8_lossy(&prefix)
            )
        })?;
        let selected = selected_raw
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(<[u8]>::to_vec)
            .collect::<Vec<_>>();
        let child_roots = nested_git_roots(&repo_root, &staged, &selected).await;

        for path in &selected {
            if child_roots
                .iter()
                .any(|child| git_path_is_at_or_below(path, child))
            {
                continue;
            }
            files.push(join_git_path(&prefix, path));
        }

        for child in child_roots.into_iter().rev() {
            let child_prefix = join_git_path(&prefix, &child);
            pending.push((
                repo_root.join(git_relative_path(&child)),
                child_prefix,
                depth + 1,
            ));
        }
    }
    Ok(())
}

async fn expand_nested_repositories(
    git_dir: &Path,
    work_tree: &Path,
    index: &Path,
) -> Result<(), String> {
    let staged = checkpoint_index_entries(git_dir, index).await?;
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", work_tree.display());
    let selected_raw = run_git_with_index_bytes(
        &[
            &git_dir_arg,
            &work_tree_arg,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        Some(work_tree),
        index,
    )
    .await?;
    let selected = selected_raw
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(<[u8]>::to_vec)
        .collect::<Vec<_>>();
    let mut roots = nested_git_roots(work_tree, &staged, &selected).await;
    if let Ok(native_raw) = run_git_bytes(&["ls-files", "--stage", "-z"], Some(work_tree)).await {
        if let Ok(native_entries) = parse_git_index_entries(&native_raw) {
            roots.extend(
                native_entries
                    .into_iter()
                    .filter(|entry| entry.mode == b"160000")
                    .map(|entry| entry.path),
            );
        }
    }
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return Ok(());
    }

    let mut files = Vec::new();
    for root in &roots {
        collect_nested_snapshot_paths(&work_tree.join(git_relative_path(root)), root, &mut files)
            .await?;
    }

    let root_index_entries = checkpoint_index_entries(git_dir, index).await?;
    let removals = root_index_entries
        .iter()
        .filter(|entry| {
            roots
                .iter()
                .any(|root| git_path_is_at_or_below(&entry.path, root))
        })
        .map(|entry| entry.path.clone())
        .collect::<std::collections::BTreeSet<_>>();
    if !removals.is_empty() {
        let mut input = Vec::new();
        for path in removals {
            input.extend_from_slice(&path);
            input.push(0);
        }
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let work_tree_arg = format!("--work-tree={}", work_tree.display());
        run_git_with_index_input(
            &[
                &git_dir_arg,
                &work_tree_arg,
                "update-index",
                "-z",
                "--force-remove",
                "--stdin",
            ],
            Some(work_tree),
            index,
            &input,
        )
        .await?;
    }

    files.sort();
    files.dedup();
    if !files.is_empty() {
        let mut input = Vec::new();
        for path in files {
            input.extend_from_slice(&path);
            input.push(0);
        }
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let work_tree_arg = format!("--work-tree={}", work_tree.display());
        run_git_with_index_input(
            &[
                &git_dir_arg,
                &work_tree_arg,
                "update-index",
                "--add",
                "--remove",
                "-z",
                "--stdin",
            ],
            Some(work_tree),
            index,
            &input,
        )
        .await?;
    }
    Ok(())
}

async fn verify_checkpoint_index(
    git_dir: &Path,
    work_tree: &Path,
    index: &Path,
) -> Result<usize, String> {
    let staged = checkpoint_index_entries(git_dir, index).await?;
    for entry in &staged {
        let mode = entry.mode.as_slice();
        let path = git_relative_path(&entry.path);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(format!(
                "checkpoint operation inspect-index failed: unsafe captured path {}",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let absolute = work_tree.join(path);
        let metadata = tokio::fs::symlink_metadata(&absolute)
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    String::from_utf8_lossy(&entry.path)
                )
            })?;
        if mode == b"160000" {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: nested repository content is not captured as ordinary files",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        if mode == b"120000" {
            if !metadata.file_type().is_symlink() {
                return Err(format!(
                    "checkpoint operation verify-symlink failed for {}: indexed symlink is no longer a symlink",
                    String::from_utf8_lossy(&entry.path)
                ));
            }
            tokio::fs::read_link(&absolute).await.map_err(|error| {
                format!(
                    "checkpoint operation verify-symlink failed for {}: {error}",
                    String::from_utf8_lossy(&entry.path)
                )
            })?;
            continue;
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "checkpoint operation verify-readable failed for {}: expected a regular file",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let mut file = tokio::fs::File::open(&absolute).await.map_err(|error| {
            format!(
                "checkpoint operation verify-readable failed for {}: {error}",
                String::from_utf8_lossy(&entry.path)
            )
        })?;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let count = file.read(&mut buffer).await.map_err(|error| {
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    String::from_utf8_lossy(&entry.path)
                )
            })?;
            if count == 0 {
                break;
            }
        }
    }
    Ok(staged.len())
}

async fn install_checkpoint_index(
    request_index: &Path,
    published_index: &Path,
) -> Result<(), String> {
    if tokio::fs::try_exists(published_index)
        .await
        .unwrap_or(false)
    {
        tokio::fs::remove_file(published_index)
            .await
            .map_err(|error| format!("failed to remove stale checkpoint index cache: {error}"))?;
    }
    tokio::fs::rename(request_index, published_index)
        .await
        .map_err(|error| format!("failed to install checkpoint index cache: {error}"))
}

// ── checkpoint metadata (fresh-agent-extras-router.ts:107-149) ──────────────

fn checkpoint_metadata_path(git_dir: &Path) -> PathBuf {
    git_dir.join("freshell-checkpoint-metadata.json")
}

/// `readCheckpointMetadata` (`fresh-agent-extras-router.ts:118-137`): a missing
/// file degrades to an empty map (first checkpoint ever taken for this cwd);
/// anything else that isn't a JSON object also degrades to empty (legacy:
/// `Array.isArray(parsed)` or non-object `parsed` -> `{}`). A file that exists
/// but fails to PARSE as JSON at all is a real error in legacy (only the ENOENT
/// case is swallowed) — mirrored here as `Err`, not silently degraded.
async fn read_checkpoint_metadata(git_dir: &Path) -> Result<Map<String, Value>, String> {
    let path = checkpoint_metadata_path(git_dir);
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Ok(Map::new()),
            Err(e) => Err(format!("invalid checkpoint metadata: {e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("failed to read checkpoint metadata: {e}")),
    }
}

/// `writeCheckpointMetadata` (`fresh-agent-extras-router.ts:139-149`): write to a
/// uniquely-named temp file, then atomically rename over the real path — a
/// concurrent checkpoint write for a different sha can never observe a
/// half-written file.
async fn write_checkpoint_metadata(
    git_dir: &Path,
    metadata: &Map<String, Value>,
) -> Result<(), String> {
    let path = checkpoint_metadata_path(git_dir);
    let tmp_name = format!(
        "freshell-checkpoint-metadata.json.tmp-{}",
        uuid::Uuid::new_v4()
    );
    let tmp_path = git_dir.join(tmp_name);
    let serialized = serde_json::to_string_pretty(&Value::Object(metadata.clone()))
        .map_err(|e| format!("failed to serialize checkpoint metadata: {e}"))?;
    tokio::fs::write(&tmp_path, format!("{serialized}\n"))
        .await
        .map_err(|e| format!("failed to write checkpoint metadata: {e}"))?;
    match tokio::fs::rename(&tmp_path, &path).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            Err(format!("failed to persist checkpoint metadata: {e}"))
        }
    }
}

/// `updateCheckpointMetadata` (`fresh-agent-extras-router.ts:151-172`), narrowed
/// to this port's one call site: merge a `requestId` into the (possibly absent)
/// existing entry for `sha` and persist. The full legacy function also resolves
/// short/ambiguous ids via `git rev-parse --verify` and merges a `turnId` field —
/// unneeded here since `create_checkpoint` always calls this with the exact,
/// just-created full sha (deferred alongside the `/checkpoints/metadata` route
/// that is this function's only OTHER caller in legacy).
async fn update_checkpoint_metadata(
    git_dir: &Path,
    sha: &str,
    request_id: &str,
) -> Result<(), String> {
    let mut metadata = read_checkpoint_metadata(git_dir).await?;
    let mut entry = metadata
        .get(sha)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    entry.insert("requestId".to_string(), json!(request_id));
    metadata.insert(sha.to_string(), Value::Object(entry));
    write_checkpoint_metadata(git_dir, &metadata).await
}

// ── list / restore / metadata routes (fresh-agent-extras-router.ts:114-232,370-428) ──

/// `CHECKPOINT_LIST_LIMIT` (`fresh-agent-extras-router.ts:72`): cap on the
/// number of commits `git log` returns for a listing.
const CHECKPOINT_LIST_LIMIT: u32 = 100;

/// `isValidCheckpointId` (`fresh-agent-extras-router.ts:114-116`):
/// `/^[0-9a-f]{7,40}$/i` — a short (7+) to full (40) hex commit id. Rejects
/// anything that couldn't possibly be a git object id before ever shelling
/// out to git.
fn is_valid_checkpoint_id(id: &str) -> bool {
    let len = id.chars().count();
    (7..=40).contains(&len) && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// `listCheckpoints` (`fresh-agent-extras-router.ts:186-213`): read the shadow
/// repo's commit log (newest-first, `git log`'s default order — no explicit
/// sort needed) and decorate each entry with any persisted `requestId`/
/// `turnId` metadata. A cwd that has never been checkpointed (no shadow repo
/// yet) or whose shadow repo has zero commits both degrade to `[]`, not an
/// error — mirrors the two `try {} catch { return [] }` guards in legacy.
async fn list_checkpoints(home: &Path, cwd: &Path) -> Result<Vec<Value>, String> {
    let git_dir = checkpoint_git_dir(home, cwd);
    match tokio::fs::symlink_metadata(git_dir.join("HEAD")).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return match tokio::fs::symlink_metadata(&git_dir).await {
                Err(directory_error) if directory_error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(Vec::new())
                }
                Ok(_) => Err("checkpoint repository exists but its HEAD is missing".to_string()),
                Err(directory_error) => Err(format!(
                    "failed to inspect checkpoint repository: {directory_error}"
                )),
            };
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect checkpoint repository HEAD: {error}"
            ));
        }
    }
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    // A successfully inspected but unborn shadow repository is the one
    // legitimate `git log` failure that means "no checkpoints yet". Probe
    // HEAD first and accept only Git's quiet missing-revision status; corrupt
    // refs, unreadable storage, and all other Git failures must remain errors
    // so callers cannot erase a previously Available turn as an empty list.
    let head_args = [&git_dir_arg, "rev-parse", "--verify", "--quiet", "HEAD"];
    let head = invoke_git(&head_args, None, None).await?;
    if !head.status.success() {
        if head.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        check_git_output(&head_args, head)?;
    }
    let limit = CHECKPOINT_LIST_LIMIT.to_string();
    let raw = run_git(
        &[
            &git_dir_arg,
            "log",
            "-n",
            &limit,
            "--pretty=format:%H%x09%ct%x09%s",
        ],
        None,
    )
    .await?;
    let metadata = read_checkpoint_metadata(&git_dir).await?;
    let mut entries = Vec::new();
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        // `[id, ts, ...rest] = line.split('\t'); label: rest.join('\t')` —
        // `splitn(3, ...)` reproduces this: the third piece is left intact
        // (re-joined) even if the subject itself contained tab characters.
        let mut parts = line.splitn(3, '\t');
        let id = parts.next().unwrap_or_default().to_string();
        let ts = parts
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let label = parts.next().unwrap_or_default().to_string();
        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(id));
        entry.insert("ts".to_string(), json!(ts));
        entry.insert("label".to_string(), json!(label));
        if let Some(meta) = metadata.get(&id).and_then(Value::as_object) {
            if let Some(request_id) = meta.get("requestId") {
                entry.insert("requestId".to_string(), request_id.clone());
            }
            if let Some(turn_id) = meta.get("turnId") {
                entry.insert("turnId".to_string(), turn_id.clone());
            }
        }
        entries.push(Value::Object(entry));
    }
    Ok(entries)
}

/// Resolve a (possibly abbreviated) checkpoint id to the full 40-hex commit
/// sha via `git rev-parse --verify <id>^{commit}` — the resolution step
/// `updateCheckpointMetadata` performs (`fresh-agent-extras-router.ts:160`)
/// before it merges a metadata patch, so a short prefix from the client
/// always keys the persisted metadata file by full sha.
async fn resolve_checkpoint_commit(git_dir: &Path, id: &str) -> Result<String, String> {
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let revision = format!("{id}^{{commit}}");
    let out = run_git(&[&git_dir_arg, "rev-parse", "--verify", &revision], None).await?;
    let resolved = out.trim().to_string();
    let ancestry = invoke_git(
        &[
            &git_dir_arg,
            "merge-base",
            "--is-ancestor",
            &resolved,
            "HEAD",
        ],
        None,
        None,
    )
    .await?;
    if ancestry.status.success() {
        return Ok(resolved);
    }
    if ancestry.status.code() == Some(1) {
        return Err("invalid checkpoint id: target is not published".to_string());
    }
    check_git_output(
        &[
            &git_dir_arg,
            "merge-base",
            "--is-ancestor",
            &resolved,
            "HEAD",
        ],
        ancestry,
    )?;
    unreachable!("failed merge-base command must return an error")
}

/// `updateCheckpointMetadata` (`fresh-agent-extras-router.ts:151-172`), full
/// version backing the `/checkpoints/metadata` route: validate the id's
/// *format*, resolve it to a full sha, merge whichever of `requestId`/
/// `turnId` the caller supplied into that sha's metadata entry, persist, then
/// re-read the entry back out of `list_checkpoints` (matching legacy's own
/// `listCheckpoints(cwd)` + `.find(...)` round-trip) so the response always
/// reflects the merged, persisted state rather than just the patch applied.
async fn apply_checkpoint_metadata_patch(
    home: &Path,
    cwd: &Path,
    id: &str,
    request_id: Option<&str>,
    turn_id: Option<&str>,
) -> Result<Value, String> {
    if !is_valid_checkpoint_id(id) {
        return Err("invalid checkpoint id".to_string());
    }
    let git_dir = ensure_checkpoint_repo(home, cwd).await?;
    let resolved_id = resolve_checkpoint_commit(&git_dir, id).await?;

    let mut metadata = read_checkpoint_metadata(&git_dir).await?;
    let mut entry = metadata
        .get(&resolved_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(request_id) = request_id {
        entry.insert("requestId".to_string(), json!(request_id));
    }
    if let Some(turn_id) = turn_id {
        entry.insert("turnId".to_string(), json!(turn_id));
    }
    metadata.insert(resolved_id.clone(), Value::Object(entry));
    write_checkpoint_metadata(&git_dir, &metadata).await?;

    let entries = list_checkpoints(home, cwd).await?;
    entries
        .into_iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(resolved_id.as_str()))
        .ok_or_else(|| "invalid checkpoint id".to_string())
}

/// `restoreCheckpoint` (`fresh-agent-extras-router.ts:215-221`): `git checkout
/// <id> -- .` in the shadow repo, using the real cwd as `--work-tree`. Git's
/// default *overlay* checkout semantics govern the observable behavior (see
/// the module doc comment): tracked paths that exist in the checkpoint's tree
/// are written back (recreating deleted files, reverting modified ones);
/// paths that exist in the working tree but NOT in the checkpoint's tree
/// (i.e. files created after the checkpoint) are left completely alone — this
/// is not a `git reset --hard` / `git clean`, so nothing is ever deleted.
async fn restore_checkpoint(home: &Path, cwd: &Path, id: &str) -> Result<(), String> {
    if !is_valid_checkpoint_id(id) {
        return Err("invalid checkpoint id".to_string());
    }
    let git_dir = ensure_checkpoint_repo(home, cwd).await?;
    let published_id = resolve_checkpoint_commit(&git_dir, id).await?;
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", cwd.display());
    run_git(
        &[
            &git_dir_arg,
            &work_tree_arg,
            "checkout",
            "-q",
            &published_id,
            "--",
            ".",
        ],
        Some(cwd),
    )
    .await?;
    Ok(())
}

// ── list / restore / metadata route handlers (fresh-agent-extras-router.ts:370-428) ──

/// `GET /checkpoints?cwd=` (`fresh-agent-extras-router.ts:370-380`). Note:
/// unlike the sibling POST routes in this file, legacy does NOT check that
/// `cwd` exists on disk here — a cwd that's never been checkpointed (or
/// doesn't exist at all) just yields an empty list, not a 400.
async fn get_checkpoints(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let cwd = match params
        .get("cwd")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(cwd) => cwd.to_string(),
        None => return bad_request("cwd query parameter required"),
    };
    let explicit_intent = params
        .get("workspacePath")
        .map(String::as_str)
        .filter(|path| !path.is_empty())
        .map(|path| {
            json!({
                "path": path,
                "provenance": params.get("workspaceProvenance")
                    .map(String::as_str)
                    .unwrap_or("resolved-project"),
            })
        });
    let workspaces = if let Some(intent) = explicit_intent {
        match resolve_checkpoint_workspace(&state.home, Path::new(&cwd), Some(&intent)).await {
            Ok(workspace) => vec![workspace],
            Err(error) => return error.response(),
        }
    } else {
        // Modern panes resolve nested launch directories to the Git project
        // root. Old panes can still have an immutable checkpoint store keyed
        // by their exact launch cwd, so include that store only when it already
        // exists. An unselected non-Git directory or HOME therefore lists as
        // empty and can never become an implicit capture scope. Include the
        // exact launch cwd as a candidate even when its store is absent; the
        // shared workspace lock makes the missing-store check race-free with
        // the first create.
        let mut workspaces = Vec::new();
        if let Ok(workspace) =
            resolve_checkpoint_workspace(&state.home, Path::new(&cwd), None).await
        {
            workspaces.push(workspace);
        }

        let legacy_path = resolve_absolute(Path::new(&cwd));
        let candidate_for_home_check = tokio::fs::canonicalize(&legacy_path)
            .await
            .unwrap_or_else(|_| legacy_path.clone());
        if !is_recognized_account_home(
            &candidate_for_home_check,
            &recognized_account_homes(Some(&state.home)),
        ) {
            let already_present = workspaces
                .iter()
                .any(|workspace| workspace.path == legacy_path);
            if !already_present {
                workspaces.push(ResolvedCheckpointWorkspace {
                    path: legacy_path,
                    provenance: "legacy-checkpoint".to_string(),
                });
            }
        }
        workspaces
    };

    let mut entries = Vec::new();
    for workspace in workspaces {
        let _workspace_lock = match state
            .service
            .lock_workspace(&workspace.path, CHECKPOINT_EXPLICIT_BUDGET)
            .await
        {
            Ok(lock) => lock,
            Err(()) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "checkpoint workspace is busy" })),
                )
                    .into_response();
            }
        };
        match list_checkpoints(&state.home, &workspace.path).await {
            Ok(mut scoped_entries) => {
                for entry in &mut scoped_entries {
                    if let Some(fields) = entry.as_object_mut() {
                        fields.insert(
                            "workspace".to_string(),
                            workspace_response_value(&workspace),
                        );
                    }
                }
                entries.extend(scoped_entries);
            }
            Err(message) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": message })),
                )
                    .into_response();
            }
        }
    }
    entries.sort_by(|left, right| {
        right["ts"]
            .as_u64()
            .unwrap_or_default()
            .cmp(&left["ts"].as_u64().unwrap_or_default())
    });
    entries.truncate(CHECKPOINT_LIST_LIMIT as usize);
    Json(json!({ "checkpoints": entries })).into_response()
}

/// `POST /checkpoints/metadata` (`fresh-agent-extras-router.ts:382-408`).
async fn post_checkpoint_metadata(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = body.get("cwd").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let turn_id = body
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if cwd.is_empty() || id.is_empty() {
        return bad_request("cwd and id are required");
    }
    if request_id.is_none() && turn_id.is_none() {
        return bad_request("requestId or turnId is required");
    }
    let cwd_path = Path::new(cwd);
    let workspace = if let Some(intent) = body.get("workspace") {
        match resolve_checkpoint_workspace(&state.home, cwd_path, Some(intent)).await {
            Ok(workspace) => workspace.path,
            Err(error) => return error.response(),
        }
    } else {
        if tokio::fs::metadata(cwd_path).await.is_err() {
            return bad_request(&format!("cwd does not exist: {cwd}"));
        }
        cwd_path.to_path_buf()
    };

    let _workspace_lock = match state
        .service
        .lock_workspace(&workspace, CHECKPOINT_EXPLICIT_BUDGET)
        .await
    {
        Ok(lock) => lock,
        Err(()) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "checkpoint workspace is busy" })),
            )
                .into_response();
        }
    };
    match apply_checkpoint_metadata_patch(&state.home, &workspace, id, request_id, turn_id).await {
        Ok(entry) => Json(entry).into_response(),
        Err(message) => {
            let status = if message.contains("invalid checkpoint id") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "error": message }))).into_response()
        }
    }
}

/// `POST /checkpoints/restore` (`fresh-agent-extras-router.ts:410-428`).
async fn post_checkpoint_restore(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = body.get("cwd").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    if cwd.is_empty() || id.is_empty() {
        return bad_request("cwd and id are required");
    }
    let cwd_path = Path::new(cwd);
    let workspace = if let Some(intent) = body.get("workspace") {
        match resolve_checkpoint_workspace(&state.home, cwd_path, Some(intent)).await {
            Ok(workspace) => workspace.path,
            Err(error) => return error.response(),
        }
    } else {
        if tokio::fs::metadata(cwd_path).await.is_err() {
            return bad_request(&format!("cwd does not exist: {cwd}"));
        }
        cwd_path.to_path_buf()
    };

    let _workspace_lock = match state
        .service
        .lock_workspace(&workspace, CHECKPOINT_EXPLICIT_BUDGET)
        .await
    {
        Ok(lock) => lock,
        Err(()) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "checkpoint workspace is busy" })),
            )
                .into_response();
        }
    };
    match restore_checkpoint(&state.home, &workspace, id).await {
        Ok(()) => Json(json!({ "restored": true })).into_response(),
        Err(message) => {
            let status = if message.contains("invalid checkpoint id") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "error": message }))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    fn state(home: &Path) -> CheckpointsApiState {
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(8);
        let home = Arc::new(home.to_path_buf());
        CheckpointsApiState {
            auth_token: Arc::new("tok".to_string()),
            home: Arc::clone(&home),
            service: Arc::new(CheckpointService::new(home, Arc::new(broadcast_tx))),
        }
    }

    #[tokio::test]
    async fn unsettled_capture_quarantine_holds_workspace_lock_until_settlement() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let state = state(home_dir.path());
        let service = Arc::clone(&state.service);
        let workspace = workspace_dir.path().to_path_buf();
        let lock = service
            .lock_workspace(&workspace, Duration::from_secs(1))
            .await
            .unwrap();
        let control = Arc::new(CheckpointCaptureControl::default());
        let gate = Arc::new(TestSettlementGate {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        *control
            .test_settlement_gate
            .lock()
            .expect("test settlement gate mutex poisoned") = Some(Arc::clone(&gate));

        let quarantine = service.quarantine_workspace(
            workspace.clone(),
            lock,
            Arc::clone(&control),
            Some("unsettled-attempt".to_string()),
            "automatic_capture_test",
            "simulated uncertain child settlement".to_string(),
        );
        tokio::time::timeout(Duration::from_secs(1), gate.entered.notified())
            .await
            .expect("quarantine began checking child settlement");

        assert!(
            service
                .lock_workspace(&workspace, Duration::from_millis(30))
                .await
                .is_err(),
            "another capture must not enter while child settlement is unconfirmed"
        );

        gate.release.notify_one();
        tokio::time::timeout(Duration::from_secs(1), quarantine)
            .await
            .expect("quarantine released after settlement was confirmed")
            .expect("quarantine worker completed");
        let later_lock = service
            .lock_workspace(&workspace, Duration::from_secs(1))
            .await
            .expect("workspace lock becomes available after settlement");
        drop(later_lock);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn checkpoint_timeout_settles_spawned_descendant_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let started = dir.path().join("descendant-started");
        let marker = dir.path().join("late-publish");
        let shell_script = format!(
            "(sleep 0.8; printf late > '{}') & printf started > '{}'; wait",
            marker.display(),
            started.display(),
        );
        let control = Arc::new(CheckpointCaptureControl::default());
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(shell_script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = control.spawn_child(&mut command).unwrap();
        let child_task = tokio::spawn(async move { child.wait_with_output().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the child started its delayed descendant");

        control.cancel_processes().await.unwrap();
        child_task.await.unwrap().unwrap();
        control.wait_for_process_groups().await.unwrap();
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(
            !marker.exists(),
            "a killed Git descendant must not publish after checkpoint settlement"
        );
        assert!(control.process_groups.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn checkpoint_timeout_settles_windows_job_descendant_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let started = dir.path().join("descendant-started.txt");
        let marker = dir.path().join("late-publish.txt");
        let started_path = started.to_string_lossy().replace('\'', "''");
        let marker_path = marker.to_string_lossy().replace('\'', "''");
        let script = format!(
            "start \"\" /B powershell -NoProfile -Command \"Set-Content -NoNewline -Path '{started_path}' -Value started; Start-Sleep -Seconds 1; Set-Content -NoNewline -Path '{marker_path}' -Value late\" & ping -n 60 127.0.0.1 > nul"
        );
        let control = Arc::new(CheckpointCaptureControl::default());
        let mut command = Command::new("cmd.exe");
        command
            .args(["/C", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = control.spawn_child(&mut command).unwrap();
        let child_task = tokio::spawn(async move { child.wait_with_output().await });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the Windows child started its Job-owned descendant");

        control.cancel_processes().await.unwrap();
        child_task.await.unwrap().unwrap();
        control.wait_for_process_groups().await.unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(
            !marker.exists(),
            "a terminated Job descendant cannot publish after checkpoint settlement"
        );
        assert!(control.jobs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn accepted_logical_attempt_is_never_forwarded_again() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-1".into(),
            session_type: SessionType::Freshopencode,
            text: "the request body is never stored in checkpoint outcomes".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "logical-attempt-1".into(),
                workspace: None,
            }),
        };

        let dispatches_for_first = Arc::clone(&dispatches);
        service
            .clone()
            .barrier_and_forward(
                make_send("request-1"),
                Box::pin(async move {
                    dispatches_for_first.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .await;
        service
            .observe_accepted(&json!({
                "requestId": "request-1",
                "provider": "opencode",
                "sessionId": "session-1",
                "sessionType": "freshopencode",
                "submittedTurnId": "provider-turn-1"
            }))
            .await;

        let dispatches_for_second = Arc::clone(&dispatches);
        service
            .clone()
            .barrier_and_forward(
                make_send("request-2"),
                Box::pin(async move {
                    dispatches_for_second.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .await;

        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        let key = "\"opencode\":\"freshopencode\":session-1:logical-attempt-1".to_string();
        let record = service.find_outcome(&key).await.unwrap().unwrap();
        assert!(record.dispatch_started);
        assert_eq!(record.submitted_turn_id.as_deref(), Some("provider-turn-1"));
        assert!(record.request_ids.contains(&"request-2".to_string()));
    }

    #[tokio::test]
    async fn outcome_store_read_failure_without_a_trusted_baseline_withholds_send() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        tokio::fs::create_dir_all(&store_path).await.unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-read-failure".into(),
            session_type: SessionType::Freshopencode,
            text: "send despite unavailable rewind status".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-read-failure".into(),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        service
            .clone()
            .barrier_and_forward(
                make_send("request-read-failure-1"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        service
            .clone()
            .barrier_and_forward(
                make_send("request-read-failure-2"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            0,
            "an unreadable store at startup cannot prove that this attempt was never dispatched"
        );
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["type"], "freshAgent.checkpoint.outcome");
        assert_eq!(outcome["status"], "unavailable");
        assert_eq!(outcome["code"], "outcome_store_unavailable");
        assert!(outcome["reason"]
            .as_str()
            .unwrap()
            .contains("prior send history could not be verified"));
        assert!(outcome["reason"].as_str().unwrap().contains("withheld"));
    }

    #[tokio::test]
    async fn malformed_seen_store_disappearing_does_not_establish_empty_baseline() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        tokio::fs::create_dir_all(store_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&store_path, b"not a checkpoint outcome store")
            .await
            .unwrap();

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let key = "\"opencode\":\"freshopencode\":session-malformed-store:attempt-malformed-store";
        assert!(service.find_outcome(key).await.is_err());
        tokio::fs::remove_file(&store_path).await.unwrap();

        let dispatches = Arc::new(AtomicUsize::new(0));
        let send = FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-malformed-store".into(),
            session_type: SessionType::Freshopencode,
            text: "do not assume a deleted malformed store was empty".into(),
            cwd: None,
            images: None,
            request_id: Some("request-malformed-store".into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-malformed-store".into(),
                workspace: None,
            }),
        };
        service
            .clone()
            .barrier_and_forward(
                send,
                Box::pin({
                    let dispatches = Arc::clone(&dispatches);
                    async move {
                        dispatches.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .await;

        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert!(outcome["reason"]
            .as_str()
            .unwrap()
            .contains("prior send history could not be verified"));
    }

    #[tokio::test]
    async fn durable_dispatch_fence_blocks_retry_when_outcome_store_becomes_unreadable() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-read-after-dispatch".into(),
            session_type: SessionType::Freshopencode,
            text: "retry must not duplicate an already dispatched turn".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-read-after-dispatch".into(),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        service
            .clone()
            .barrier_and_forward(
                make_send("request-read-after-dispatch-1"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);

        tokio::fs::remove_file(&store_path).await.unwrap();
        tokio::fs::create_dir(&store_path).await.unwrap();
        service
            .clone()
            .barrier_and_forward(
                make_send("request-read-after-dispatch-2"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            1,
            "an unreadable durable history cannot turn a known dispatched attempt into a new send"
        );
    }

    #[tokio::test]
    async fn loaded_durable_dispatch_fence_blocks_retry_after_store_is_removed() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        let (seed_broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let seed_service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(seed_broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-loaded-dispatch".into(),
            session_type: SessionType::Freshopencode,
            text: "retry must not duplicate a durable dispatch from a prior service".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-loaded-dispatch".into(),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        seed_service
            .clone()
            .barrier_and_forward(
                make_send("request-loaded-dispatch-1"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let key = "\"opencode\":\"freshopencode\":session-loaded-dispatch:attempt-loaded-dispatch";
        let loaded = service.find_outcome(key).await.unwrap().unwrap();
        assert!(loaded.dispatch_started);
        assert!(loaded.capture_settled);

        tokio::fs::remove_file(&store_path).await.unwrap();
        assert!(service.read_outcome_store().await.is_err());
        service
            .clone()
            .barrier_and_forward(
                make_send("request-loaded-dispatch-2"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;

        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["requestId"], "request-loaded-dispatch-2");
    }

    #[tokio::test]
    async fn durable_outcome_presence_marker_blocks_retry_after_restart_and_store_deletion() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        let (seed_broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let seed_service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(seed_broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-restart-store-deletion".into(),
            session_type: SessionType::Freshopencode,
            text: "do not duplicate after restart if the durable fence disappears".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-restart-store-deletion".into(),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        seed_service
            .clone()
            .barrier_and_forward(
                make_send("request-restart-store-deletion-1"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        tokio::fs::remove_file(&store_path).await.unwrap();

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        service
            .clone()
            .barrier_and_forward(
                make_send("request-restart-store-deletion-2"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            1,
            "a restarted service must not treat a deleted durable history as first use"
        );
    }

    #[tokio::test]
    async fn cached_durable_outcome_replays_when_store_becomes_unreadable() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let send = FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-cache-replay".into(),
            session_type: SessionType::Freshopencode,
            text: "replay the saved outcome after a transient store error".into(),
            cwd: None,
            images: None,
            request_id: Some("request-cache-replay".into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-cache-replay".into(),
                workspace: None,
            }),
        };
        service
            .clone()
            .barrier_and_forward(
                send,
                Box::pin({
                    let dispatches = Arc::clone(&dispatches);
                    async move {
                        dispatches.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .await;
        tokio::fs::remove_file(&store_path).await.unwrap();
        tokio::fs::create_dir(&store_path).await.unwrap();

        service
            .replay_for_identity(
                AgentProvider::Opencode,
                "session-cache-replay",
                SessionType::Freshopencode,
            )
            .await;

        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["requestId"], "request-cache-replay");
        assert_eq!(outcome["logicalAttemptId"], "attempt-cache-replay");
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn loaded_unsettled_attempt_stays_withheld_after_store_becomes_unreadable() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        let (seed_broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let seed_service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(seed_broadcast_tx),
        ));
        let seed_send = FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-loaded-unsettled".into(),
            session_type: SessionType::Freshopencode,
            text: "do not release this send until capture settlement is known".into(),
            cwd: None,
            images: None,
            request_id: Some("request-loaded-unsettled-1".into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-loaded-unsettled".into(),
                workspace: None,
            }),
        };
        let key =
            "\"opencode\":\"freshopencode\":session-loaded-unsettled:attempt-loaded-unsettled";
        let mut unsettled = seed_service.new_record(
            &seed_send,
            "attempt-loaded-unsettled",
            "request-loaded-unsettled-1",
            None,
            Err((
                "checkpoint_settlement_pending",
                "snapshot still settling".into(),
            )),
        );
        unsettled.capture_settled = false;
        unsettled.dispatch_started = false;
        seed_service.persist_outcome(key, unsettled).await.unwrap();

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let loaded = service.find_outcome(key).await.unwrap().unwrap();
        assert!(!loaded.dispatch_started);
        assert!(!loaded.capture_settled);

        tokio::fs::remove_file(&store_path).await.unwrap();
        tokio::fs::create_dir(&store_path).await.unwrap();
        assert!(service.read_outcome_store().await.is_err());
        let dispatches = Arc::new(AtomicUsize::new(0));
        let retry = FreshAgentSend {
            request_id: Some("request-loaded-unsettled-2".into()),
            ..seed_send
        };
        service
            .clone()
            .barrier_and_forward(
                retry,
                Box::pin({
                    let dispatches = Arc::clone(&dispatches);
                    async move {
                        dispatches.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .await;

        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["requestId"], "request-loaded-unsettled-2");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn outcome_store_write_failure_forwards_once_and_reports_unknown_rewind() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_dir = home.path().join(".freshell/checkpoints");
        tokio::fs::create_dir_all(&store_dir).await.unwrap();
        let store_path = store_dir.join("attempt-outcomes-v1.json");
        let empty_store = CheckpointOutcomeStore {
            version: CHECKPOINT_OUTCOME_STORE_VERSION,
            outcomes: BTreeMap::new(),
        };
        tokio::fs::write(&store_path, serde_json::to_vec(&empty_store).unwrap())
            .await
            .unwrap();
        let mut permissions = tokio::fs::metadata(&store_dir).await.unwrap().permissions();
        permissions.set_mode(0o555);
        tokio::fs::set_permissions(&store_dir, permissions)
            .await
            .unwrap();

        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-write-failure".into(),
            session_type: SessionType::Freshopencode,
            text: "send despite unavailable rewind status".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-write-failure".into(),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        service
            .clone()
            .barrier_and_forward(
                make_send("request-write-failure-1"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        service
            .clone()
            .barrier_and_forward(
                make_send("request-write-failure-2"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        let mut permissions = tokio::fs::metadata(&store_dir).await.unwrap().permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&store_dir, permissions)
            .await
            .unwrap();

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            1,
            "a store write error must allow one send and fence its duplicate"
        );
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["type"], "freshAgent.checkpoint.outcome");
        assert_eq!(outcome["status"], "unavailable");
        assert_eq!(outcome["code"], "outcome_store_unavailable");
        assert!(outcome["reason"].as_str().unwrap().contains("rewind"));
        assert!(outcome["reason"].as_str().unwrap().contains("sent"));
    }

    #[tokio::test]
    async fn volatile_fence_capacity_fails_closed_without_duplicate_dispatch() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_path = home
            .path()
            .join(".freshell/checkpoints/attempt-outcomes-v1.json");
        let store_dir = store_path.parent().unwrap();
        tokio::fs::create_dir_all(store_dir).await.unwrap();
        let empty_store = CheckpointOutcomeStore {
            version: CHECKPOINT_OUTCOME_STORE_VERSION,
            outcomes: BTreeMap::new(),
        };
        tokio::fs::write(&store_path, serde_json::to_vec(&empty_store).unwrap())
            .await
            .unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx.clone()),
        ));
        assert!(service
            .read_outcome_store()
            .await
            .unwrap()
            .outcomes
            .is_empty());
        tokio::fs::remove_file(&store_path).await.unwrap();
        tokio::fs::create_dir(&store_path).await.unwrap();
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |attempt: usize, request_id: String| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-fence-capacity".into(),
            session_type: SessionType::Freshopencode,
            text: "send only when duplicate protection is retained".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: format!("attempt-fence-capacity-{attempt}"),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        for attempt in 0..CHECKPOINT_VOLATILE_FENCE_LIMIT {
            service
                .clone()
                .barrier_and_forward(
                    make_send(attempt, format!("request-fence-capacity-{attempt}")),
                    make_forward(Arc::clone(&dispatches)),
                )
                .await;
        }
        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            CHECKPOINT_VOLATILE_FENCE_LIMIT
        );
        let current_len = service
            .volatile_outcomes
            .lock()
            .expect("volatile checkpoint outcomes mutex poisoned")
            .len();
        assert_eq!(
            current_len, CHECKPOINT_VOLATILE_FENCE_LIMIT,
            "process-local fences must never exceed their configured capacity"
        );

        let mut outcome_rx = broadcast_tx.subscribe();
        service
            .clone()
            .barrier_and_forward(
                make_send(
                    CHECKPOINT_VOLATILE_FENCE_LIMIT,
                    "request-fence-capacity-overflow".into(),
                ),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        service
            .clone()
            .barrier_and_forward(
                make_send(
                    CHECKPOINT_VOLATILE_FENCE_LIMIT,
                    "request-fence-capacity-overflow-retry".into(),
                ),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            CHECKPOINT_VOLATILE_FENCE_LIMIT,
            "an attempt without retained local duplicate protection must stay withheld"
        );
        for _ in 0..2 {
            let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
            assert_eq!(outcome["status"], "unavailable");
            assert_eq!(outcome["code"], "outcome_store_unavailable");
            assert!(outcome["reason"].as_str().unwrap().contains("withheld"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn durable_outcomes_do_not_consume_volatile_fence_capacity() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let store_dir = home.path().join(".freshell/checkpoints");
        tokio::fs::create_dir_all(&store_dir).await.unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let mut outcomes = BTreeMap::new();
        for index in 0..CHECKPOINT_VOLATILE_FENCE_LIMIT {
            let request_id = format!("durable-request-{index}");
            let send = FreshAgentSend {
                provider: AgentProvider::Opencode,
                session_id: format!("durable-session-{index}"),
                session_type: SessionType::Freshopencode,
                text: "not stored".into(),
                cwd: None,
                images: None,
                request_id: Some(request_id.clone()),
                settings: None,
                observed_epoch: None,
                observed_generation: None,
                checkpoint_intent: None,
            };
            let mut record = service.new_record(
                &send,
                &format!("durable-attempt-{index}"),
                &request_id,
                None,
                Err(("workspace_unavailable", "No workspace".into())),
            );
            record.dispatch_started = true;
            outcomes.insert(format!("durable-key-{index}"), record);
        }
        service
            .write_outcome_store(&CheckpointOutcomeStore {
                version: CHECKPOINT_OUTCOME_STORE_VERSION,
                outcomes,
            })
            .await
            .unwrap();
        service
            .observe_accepted(&json!({
                "requestId": "durable-request-0",
                "provider": "opencode",
                "sessionId": "durable-session-0",
                "sessionType": "freshopencode",
                "submittedTurnId": "durable-turn-0"
            }))
            .await;

        let durable_count = service.read_outcome_store().await.unwrap().outcomes.len();
        assert_eq!(durable_count, CHECKPOINT_VOLATILE_FENCE_LIMIT);
        let cached_durable_count = service
            .volatile_outcomes
            .lock()
            .expect("volatile checkpoint outcomes mutex poisoned")
            .len();
        assert_eq!(
            cached_durable_count, 0,
            "durable outcomes remain on disk and must not consume volatile fence slots"
        );

        let mut permissions = tokio::fs::metadata(&store_dir).await.unwrap().permissions();
        permissions.set_mode(0o555);
        tokio::fs::set_permissions(&store_dir, permissions)
            .await
            .unwrap();
        let dispatches = Arc::new(AtomicUsize::new(0));
        let send = FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-needs-volatile-fence".into(),
            session_type: SessionType::Freshopencode,
            text: "send with a new volatile fence slot".into(),
            cwd: None,
            images: None,
            request_id: Some("request-needs-volatile-fence".into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-needs-volatile-fence".into(),
                workspace: None,
            }),
        };
        service
            .clone()
            .barrier_and_forward(
                send,
                Box::pin({
                    let dispatches = Arc::clone(&dispatches);
                    async move {
                        dispatches.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .await;
        let mut permissions = tokio::fs::metadata(&store_dir).await.unwrap().permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&store_dir, permissions)
            .await
            .unwrap();

        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        let volatile_count = service
            .volatile_outcomes
            .lock()
            .expect("volatile checkpoint outcomes mutex poisoned")
            .len();
        assert_eq!(
            volatile_count, 1,
            "only the failed durable write should consume a volatile fence slot"
        );
    }

    #[tokio::test]
    async fn settled_workspace_failure_forwards_once_and_reports_unavailable_rewind() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-workspace-failure".into(),
            session_type: SessionType::Freshopencode,
            text: "send despite missing workspace".into(),
            cwd: None,
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-workspace-failure".into(),
                workspace: None,
            }),
        };
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };

        service
            .clone()
            .barrier_and_forward(
                make_send("request-workspace-failure-1"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;
        service
            .clone()
            .barrier_and_forward(
                make_send("request-workspace-failure-2"),
                make_forward(Arc::clone(&dispatches)),
            )
            .await;

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            1,
            "a settled workspace failure must not suppress or duplicate the provider send"
        );
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["type"], "freshAgent.checkpoint.outcome");
        assert_eq!(outcome["status"], "unavailable");
        assert_eq!(outcome["code"], "workspace_unavailable");
        assert!(outcome["reason"]
            .as_str()
            .unwrap()
            .contains("message will still be sent"));
    }

    #[tokio::test]
    async fn pending_send_forwards_once_after_quarantine_confirms_settlement() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;
        use std::sync::atomic::AtomicUsize;

        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        run_git(&["init", "-q"], Some(workspace.path()))
            .await
            .unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let mut outcome_rx = broadcast_tx.subscribe();
        let service = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(broadcast_tx),
        ));
        let gate = Arc::new(TestSettlementGate {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let control = Arc::new(CheckpointCaptureControl::default());
        *control
            .test_settlement_gate
            .lock()
            .expect("checkpoint test settlement gate poisoned") = Some(Arc::clone(&gate));
        *service
            .test_capture_attempt_override
            .lock()
            .expect("checkpoint test capture override mutex poisoned") =
            Some(CaptureAttempt::Unsettled {
                message: "simulated uncertain child settlement".into(),
                control,
            });

        let make_send = |request_id: &str| FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: "session-quarantine-settlement".into(),
            session_type: SessionType::Freshopencode,
            text: "continue after snapshot child settles".into(),
            cwd: Some(workspace.path().to_string_lossy().into_owned()),
            images: None,
            request_id: Some(request_id.into()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-quarantine-settlement".into(),
                workspace: None,
            }),
        };
        let dispatches = Arc::new(AtomicUsize::new(0));
        let make_forward = |dispatches: Arc<AtomicUsize>| {
            Box::pin(async move {
                dispatches.fetch_add(1, Ordering::SeqCst);
            }) as futures_util::future::BoxFuture<'static, ()>
        };
        let first = tokio::spawn(service.clone().barrier_and_forward(
            make_send("request-quarantine-settlement-1"),
            make_forward(Arc::clone(&dispatches)),
        ));

        tokio::time::timeout(Duration::from_secs(1), gate.entered.notified())
            .await
            .expect("automatic capture entered the existing quarantine settlement gate");
        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        assert!(
            service
                .lock_workspace(workspace.path(), Duration::from_millis(30))
                .await
                .is_err(),
            "the provider send must stay behind the quarantined workspace lock"
        );

        let duplicate = tokio::spawn(service.clone().barrier_and_forward(
            make_send("request-quarantine-settlement-2"),
            make_forward(Arc::clone(&dispatches)),
        ));
        tokio::task::yield_now().await;
        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        gate.release.notify_one();

        tokio::time::timeout(Duration::from_secs(2), first)
            .await
            .expect("settled pending send completed")
            .expect("pending send task completed");
        tokio::time::timeout(Duration::from_secs(2), duplicate)
            .await
            .expect("duplicate joined the pending send")
            .expect("duplicate task completed");

        assert_eq!(
            dispatches.load(Ordering::SeqCst),
            1,
            "a settled quarantined attempt forwards once despite a duplicate request"
        );
        let outcome: Value = serde_json::from_str(&outcome_rx.recv().await.unwrap()).unwrap();
        assert_eq!(outcome["type"], "freshAgent.checkpoint.outcome");
        assert_eq!(outcome["status"], "unavailable");
        assert_eq!(outcome["code"], "capture_failed");
        assert!(outcome["reason"]
            .as_str()
            .unwrap()
            .contains("message will still be sent"));
        let key = "\"opencode\":\"freshopencode\":session-quarantine-settlement:attempt-quarantine-settlement".to_string();
        let saved = service.find_outcome(&key).await.unwrap().unwrap();
        assert!(saved.capture_settled);
        assert!(saved.dispatch_started);
    }

    #[tokio::test]
    async fn codex_identity_receipt_is_durable_and_replayed_after_service_reload() {
        use freshell_ws::checkpoint_barrier::FreshAgentCheckpointBarrier;

        let home = tempfile::tempdir().unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service =
            CheckpointService::new(Arc::new(home.path().to_path_buf()), Arc::new(broadcast_tx));
        let workspace = ResolvedCheckpointWorkspace {
            path: PathBuf::from("/work/codex-project"),
            provenance: "directory-picker".to_string(),
        };
        let send = FreshAgentSend {
            provider: AgentProvider::Codex,
            session_id: "codex-session".to_string(),
            session_type: SessionType::Freshcodex,
            text: "do not persist this prompt".to_string(),
            cwd: Some("/work/codex-project".to_string()),
            images: None,
            request_id: Some("codex-request-1".to_string()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "codex-logical-attempt-1".to_string(),
                workspace: None,
            }),
        };
        let key = checkpoint_attempt_key(&send, "codex-logical-attempt-1");
        let mut record = service.new_record(
            &send,
            "codex-logical-attempt-1",
            "codex-request-1",
            Some((&workspace, "")),
            Ok("checkpoint-sha".to_string()),
        );
        record.dispatch_started = true;
        record.submitted_turn_id = Some("codex-native-turn-1".to_string());
        service.persist_outcome(&key, record).await.unwrap();

        service
            .observe_turn_identity(&json!({
                "provider": "codex",
                "sessionId": "codex-session",
                "sessionType": "freshcodex",
                "event": {
                    "type": "checkpointTurnIdentity",
                    "requestId": "codex-request-1",
                    "logicalAttemptId": "codex-logical-attempt-1",
                    "sessionId": "codex-session",
                    "nativeTurnId": "codex-native-turn-1",
                    "displayTurnId": "codex-native-turn-1:row-0"
                }
            }))
            .await;

        let persisted = service.read_outcome_store().await.unwrap();
        let saved = persisted.outcomes.get(&key).unwrap();
        assert_eq!(
            saved.outcome.native_turn_id.as_deref(),
            Some("codex-native-turn-1")
        );
        assert_eq!(
            saved.outcome.display_turn_id.as_deref(),
            Some("codex-native-turn-1:row-0")
        );
        assert!(
            !serde_json::to_string(&persisted)
                .unwrap()
                .contains("do not persist this prompt"),
            "durable checkpoint identity state never stores the sent prompt"
        );

        let (replay_tx, mut replay_rx) = tokio::sync::broadcast::channel(8);
        let reloaded = Arc::new(CheckpointService::new(
            Arc::new(home.path().to_path_buf()),
            Arc::new(replay_tx),
        ));
        reloaded
            .clone()
            .replay_for_session(
                AgentProvider::Codex,
                "codex-session".to_string(),
                SessionType::Freshcodex,
            )
            .await;
        let frame = replay_rx.recv().await.unwrap();
        let replayed: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(replayed["type"], "freshAgent.checkpoint.outcome");
        assert_eq!(replayed["logicalAttemptId"], "codex-logical-attempt-1");
        assert_eq!(replayed["nativeTurnId"], "codex-native-turn-1");
        assert_eq!(replayed["displayTurnId"], "codex-native-turn-1:row-0");
    }

    #[tokio::test]
    async fn codex_checkpoint_identity_must_match_accepted_provider_turn_id_in_either_event_order()
    {
        let home = tempfile::tempdir().unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(16);
        let service =
            CheckpointService::new(Arc::new(home.path().to_path_buf()), Arc::new(broadcast_tx));
        let workspace = ResolvedCheckpointWorkspace {
            path: PathBuf::from("/work/codex-project"),
            provenance: "directory-picker".to_string(),
        };
        let send = |request_id: &str, attempt_id: &str| FreshAgentSend {
            provider: AgentProvider::Codex,
            session_id: "codex-session".to_string(),
            session_type: SessionType::Freshcodex,
            text: "identity mismatch must not enable rewind".to_string(),
            cwd: Some("/work/codex-project".to_string()),
            images: None,
            request_id: Some(request_id.to_string()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: attempt_id.to_string(),
                workspace: None,
            }),
        };
        let identity_event = |request_id: &str, attempt_id: &str, native_turn_id: &str| {
            json!({
                "provider": "codex",
                "sessionId": "codex-session",
                "sessionType": "freshcodex",
                "event": {
                    "type": "checkpointTurnIdentity",
                    "requestId": request_id,
                    "logicalAttemptId": attempt_id,
                    "sessionId": "codex-session",
                    "nativeTurnId": native_turn_id,
                    "displayTurnId": format!("{native_turn_id}:row-0")
                }
            })
        };

        let first_send = send("request-identity-first", "attempt-identity-first");
        let first_key = checkpoint_attempt_key(&first_send, "attempt-identity-first");
        let mut first = service.new_record(
            &first_send,
            "attempt-identity-first",
            "request-identity-first",
            Some((&workspace, "")),
            Ok("checkpoint-first".to_string()),
        );
        first.dispatch_started = true;
        first.submitted_turn_id = Some("accepted-turn-first".to_string());
        service.persist_outcome(&first_key, first).await.unwrap();

        service
            .observe_turn_identity(&identity_event(
                "request-identity-first",
                "attempt-identity-first",
                "different-turn-first",
            ))
            .await;
        let persisted = service.read_outcome_store().await.unwrap();
        let first_saved = persisted.outcomes.get(&first_key).unwrap();
        assert_eq!(first_saved.outcome.native_turn_id, None);
        assert_eq!(first_saved.outcome.display_turn_id, None);

        service
            .observe_turn_identity(&identity_event(
                "request-identity-first",
                "attempt-identity-first",
                "accepted-turn-first",
            ))
            .await;
        let persisted = service.read_outcome_store().await.unwrap();
        assert_eq!(
            persisted
                .outcomes
                .get(&first_key)
                .unwrap()
                .outcome
                .native_turn_id
                .as_deref(),
            Some("accepted-turn-first")
        );

        let second_send = send("request-identity-second", "attempt-identity-second");
        let second_key = checkpoint_attempt_key(&second_send, "attempt-identity-second");
        let mut second = service.new_record(
            &second_send,
            "attempt-identity-second",
            "request-identity-second",
            Some((&workspace, "")),
            Ok("checkpoint-second".to_string()),
        );
        second.dispatch_started = true;
        service.persist_outcome(&second_key, second).await.unwrap();
        service
            .observe_turn_identity(&identity_event(
                "request-identity-second",
                "attempt-identity-second",
                "identity-before-acceptance",
            ))
            .await;
        service
            .observe_accepted(&json!({
                "requestId": "request-identity-second",
                "provider": "codex",
                "sessionId": "codex-session",
                "sessionType": "freshcodex",
                "submittedTurnId": "different-accepted-turn"
            }))
            .await;

        let persisted = service.read_outcome_store().await.unwrap();
        let second_saved = persisted.outcomes.get(&second_key).unwrap();
        assert_eq!(
            second_saved.outcome.native_turn_id.as_deref(),
            Some("identity-before-acceptance")
        );
        assert_eq!(
            second_saved.submitted_turn_id, None,
            "a conflicting later acceptance cannot be joined to this checkpoint"
        );

        let third_send = send("request-identity-third", "attempt-identity-third");
        let third_key = checkpoint_attempt_key(&third_send, "attempt-identity-third");
        let mut third = service.new_record(
            &third_send,
            "attempt-identity-third",
            "request-identity-third",
            Some((&workspace, "")),
            Ok("checkpoint-third".to_string()),
        );
        third.dispatch_started = true;
        third.submitted_turn_id = Some("accepted-turn-third".to_string());
        service.persist_outcome(&third_key, third).await.unwrap();
        service
            .observe_accepted(&json!({
                "requestId": "request-identity-third",
                "provider": "codex",
                "sessionId": "codex-session",
                "sessionType": "freshcodex"
            }))
            .await;

        let persisted = service.read_outcome_store().await.unwrap();
        assert_eq!(
            persisted
                .outcomes
                .get(&third_key)
                .unwrap()
                .submitted_turn_id
                .as_deref(),
            Some("accepted-turn-third"),
            "an accepted event without an optional native ID must preserve exact identity already recorded"
        );
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn is_full_sha(s: &str) -> bool {
        s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
    }

    // ── pure helper tests ────────────────────────────────────────────────

    #[test]
    fn checkpoint_git_dir_is_deterministic_and_scoped_under_home_freshell_checkpoints() {
        let home = PathBuf::from("/home/tester");
        let a = checkpoint_git_dir(&home, Path::new("/some/project"));
        let b = checkpoint_git_dir(&home, Path::new("/some/project"));
        assert_eq!(a, b, "same cwd must always hash to the same shadow repo");
        assert!(a.starts_with(home.join(".freshell").join("checkpoints")));
        assert!(a.extension().and_then(|e| e.to_str()) == Some("git"));
    }

    #[test]
    fn checkpoint_git_dir_differs_for_different_cwds() {
        let home = PathBuf::from("/home/tester");
        let a = checkpoint_git_dir(&home, Path::new("/project-a"));
        let b = checkpoint_git_dir(&home, Path::new("/project-b"));
        assert_ne!(a, b);
    }

    #[test]
    fn resolve_absolute_collapses_dot_and_dotdot_segments() {
        let resolved = resolve_absolute(Path::new("/a/b/../c/./d"));
        assert_eq!(resolved, PathBuf::from("/a/c/d"));
    }

    #[test]
    fn git_add_permission_failure_has_structured_path_and_cause() {
        let home = tempfile::tempdir().unwrap();
        let failure = CheckpointFailure::from_capture_detail(
            home.path(),
            Path::new("/workspace/project"),
            "Git operation add failed (exit_status=Some(128)): error: open(\"private-file\"): Permission denied\nerror: unable to index file 'private-file'\nfatal: adding files failed",
        );
        assert_eq!(failure.stage, "readability");
        assert_eq!(failure.operation, "add");
        assert_eq!(failure.code, "checkpoint_path_unreadable");
        assert_eq!(failure.path.as_deref(), Some("private-file"));
        assert_eq!(failure.filesystem_kind.as_deref(), Some("PermissionDenied"));
        assert_eq!(failure.git_exit_status, Some(128));
        assert!(failure.cause.contains("Permission denied"));
    }

    #[test]
    fn git_permission_failure_path_parser_rejects_unsafe_and_non_permission_paths() {
        assert_eq!(
            git_open_failure_path(
                "Git operation add failed (exit_status=128): fatal: open('../outside'): Permission denied"
            ),
            None
        );
        assert_eq!(
            git_open_failure_path(
                "Git operation add failed (exit_status=128): fatal: open(\"src/file.rs\"): No such file or directory"
            ),
            None
        );
    }

    #[tokio::test]
    async fn directory_ignore_probe_honors_workspace_gitignore_with_shadow_repo() {
        let work_tree = tempfile::tempdir().unwrap();
        let shadow_parent = tempfile::tempdir().unwrap();
        let git_dir = shadow_parent.path().join("shadow.git");
        tokio::fs::write(
            work_tree.path().join(".gitignore"),
            "private-dir.ignored/\n",
        )
        .await
        .unwrap();
        tokio::fs::create_dir(work_tree.path().join("private-dir.ignored"))
            .await
            .unwrap();
        run_git(
            &["init", "--bare", "--quiet", git_dir.to_str().unwrap()],
            None,
        )
        .await
        .unwrap();

        let ignored = CHECKPOINT_CAPTURE_CONTEXT
            .scope(
                Arc::new(CheckpointCaptureControl::default()),
                ignored_git_directories(
                    &git_dir,
                    work_tree.path(),
                    &[b"private-dir.ignored/".to_vec()],
                ),
            )
            .await
            .unwrap();
        assert!(ignored.contains(b"private-dir.ignored/".as_slice()));
    }

    // ── route-level tests ────────────────────────────────────────────────

    fn valid_body(cwd: &str) -> Value {
        json!({
            "cwd": cwd,
            "workspace": { "path": cwd, "provenance": "directory-picker" },
            "label": "fix the thing"
        })
    }

    #[tokio::test]
    async fn missing_auth_header_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(dir.path())),
            HeaderMap::new(),
            Json(valid_body(dir.path().to_str().unwrap())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_auth_token_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(dir.path())),
            headers_with_token("wrong"),
            Json(valid_body(dir.path().to_str().unwrap())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn missing_cwd_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(dir.path())),
            headers_with_token("tok"),
            Json(json!({ "label": "no cwd here" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("cwd is required"));
    }

    #[tokio::test]
    async fn nonexistent_cwd_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist");
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(missing.to_str().unwrap())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let value = body_json(resp).await;
        assert_eq!(value["code"], json!("workspace_unavailable"));
    }

    #[tokio::test]
    async fn valid_post_returns_200_with_id_ts_label() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert!(is_full_sha(value["id"].as_str().unwrap()));
        assert!(value["ts"].as_u64().unwrap() > 0);
        assert_eq!(value["label"], json!("fix the thing"));
        assert!(value.get("requestId").is_none());
    }

    #[tokio::test]
    async fn explicit_non_git_picker_scope_restores() {
        let home_dir = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let source = project_dir.path().join("source.txt");
        tokio::fs::write(&source, "before").await.unwrap();
        let workspace = json!({
            "path": project_dir.path(),
            "provenance": "directory-picker",
        });

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": workspace,
                "label": "before turn",
                "requestId": "scope-request",
            })),
        )
        .await;
        let status = response.status();
        let entry = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        assert_eq!(entry["workspace"]["path"], json!(project_dir.path()));
        assert_eq!(entry["workspace"]["provenance"], json!("directory-picker"));

        tokio::fs::write(&source, "after").await.unwrap();
        let listed = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Query(HashMap::from([
                (
                    "cwd".to_string(),
                    home_dir.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspacePath".to_string(),
                    project_dir.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspaceProvenance".to_string(),
                    "directory-picker".to_string(),
                ),
            ])),
        )
        .await;
        let listed = body_json(listed).await;
        assert_eq!(listed["checkpoints"][0]["id"], entry["id"]);

        let restored = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": workspace,
                "id": entry["id"],
            })),
        )
        .await;
        assert_eq!(restored.status(), StatusCode::OK);
        assert_eq!(tokio::fs::read_to_string(source).await.unwrap(), "before");
    }

    #[tokio::test]
    async fn home_launch_without_workspace_does_not_publish_checkpoint() {
        let home_dir = tempfile::tempdir().unwrap();
        tokio::fs::write(home_dir.path().join("private.txt"), "private")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": home_dir.path() })),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = body_json(response).await;
        assert_eq!(error["code"], json!("workspace_unavailable"));
        assert_eq!(error["workspace"], json!(home_dir.path()));
        let checkpoints = home_dir.path().join(".freshell/checkpoints");
        assert!(!tokio::fs::try_exists(checkpoints).await.unwrap());
    }

    #[tokio::test]
    async fn explicit_checkpoint_workspace_can_be_captured_without_a_launch_cwd() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let fixture = workspace_dir.path().join("selected-project.txt");
        tokio::fs::write(&fixture, "workspace selected independently of launch cwd\n")
            .await
            .unwrap();
        let (broadcast_tx, _) = tokio::sync::broadcast::channel(8);
        let service = CheckpointService::new(
            Arc::new(home_dir.path().to_path_buf()),
            Arc::new(broadcast_tx),
        );
        let send = FreshAgentSend {
            provider: AgentProvider::Codex,
            session_id: "thread-no-launch-cwd".to_string(),
            session_type: SessionType::Freshcodex,
            text: "continue from the selected project".to_string(),
            cwd: None,
            images: None,
            request_id: Some("request-no-launch-cwd".to_string()),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: "attempt-no-launch-cwd".to_string(),
                workspace: Some(FreshAgentCheckpointWorkspace {
                    path: workspace_dir.path().to_string_lossy().into_owned(),
                    provenance: CheckpointWorkspaceProvenance::DirectoryPicker,
                }),
            }),
        };

        let outcome = service
            .capture_automatic(&send, "request-no-launch-cwd", "attempt-no-launch-cwd")
            .await;

        assert_eq!(
            send.cwd, None,
            "capture must not synthesize provider launch cwd"
        );
        assert_eq!(
            outcome.outcome.status,
            FreshAgentCheckpointStatus::Available,
            "an explicit selected workspace is sufficient for checkpoint capture"
        );
        assert!(outcome.outcome.checkpoint_id.is_some());
        assert_eq!(
            outcome.outcome.workspace,
            Some(FreshAgentCheckpointWorkspace {
                path: workspace_dir.path().to_string_lossy().into_owned(),
                provenance: CheckpointWorkspaceProvenance::DirectoryPicker,
            }),
        );
        assert_eq!(
            tokio::fs::read_to_string(fixture).await.unwrap(),
            "workspace selected independently of launch cwd\n"
        );
    }

    #[tokio::test]
    async fn picker_home_is_launch_only() {
        let home_dir = tempfile::tempdir().unwrap();
        tokio::fs::write(home_dir.path().join("private.txt"), "private")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": {
                    "path": home_dir.path(),
                    "provenance": "directory-picker",
                },
            })),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = body_json(response).await;
        assert_eq!(error["code"], json!("workspace_unavailable"));
        assert!(
            !tokio::fs::try_exists(home_dir.path().join(".freshell/checkpoints"))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn resolved_project_scope_independent_of_routing_cwd() {
        let home_dir = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let nested = project_dir.path().join("src/nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        let source = project_dir.path().join("src/main.rs");
        tokio::fs::write(&source, "before").await.unwrap();
        run_git(&["init", "-q"], Some(project_dir.path()))
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": nested })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let entry = body_json(response).await;
        assert_eq!(entry["workspace"]["path"], json!(project_dir.path()));
        assert_eq!(entry["workspace"]["provenance"], json!("resolved-project"));

        tokio::fs::write(&source, "after").await.unwrap();
        let restored = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": entry["workspace"],
                "id": entry["id"],
            })),
        )
        .await;
        assert_eq!(restored.status(), StatusCode::OK);
        assert_eq!(tokio::fs::read_to_string(source).await.unwrap(), "before");
    }

    #[tokio::test]
    async fn nested_clone_non_git_scope_complete_restore() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let nested = workspace.path().join("vendor/project");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        run_git(&["init", "-q"], Some(&nested)).await.unwrap();

        let ignore_file = nested.join(".gitignore");
        let tracked = nested.join("tracked.txt");
        let tracked_ignored = nested.join("tracked-ignored.txt");
        let untracked = nested.join("untracked.txt");
        let ignored_untracked = nested.join("ignored-untracked.txt");
        tokio::fs::write(&ignore_file, "tracked-ignored.txt\nignored-untracked.txt\n")
            .await
            .unwrap();
        tokio::fs::write(&tracked, "tracked before").await.unwrap();
        tokio::fs::write(&tracked_ignored, "ignored but tracked before")
            .await
            .unwrap();
        run_git(&["add", ".gitignore", "tracked.txt"], Some(&nested))
            .await
            .unwrap();
        run_git(&["add", "-f", "tracked-ignored.txt"], Some(&nested))
            .await
            .unwrap();
        run_git(
            &[
                "-c",
                "user.name=Checkpoint Test",
                "-c",
                "user.email=checkpoint@example.invalid",
                "commit",
                "-m",
                "nested fixture",
            ],
            Some(&nested),
        )
        .await
        .unwrap();
        tokio::fs::write(&untracked, "untracked before")
            .await
            .unwrap();
        tokio::fs::write(&ignored_untracked, "ignored untracked before")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "label": "nested clone state",
            })),
        )
        .await;
        let status = response.status();
        let entry = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        let id = entry["id"].as_str().expect("checkpoint id").to_string();

        tokio::fs::write(&tracked, "tracked after").await.unwrap();
        tokio::fs::write(&tracked_ignored, "ignored but tracked after")
            .await
            .unwrap();
        tokio::fs::write(&untracked, "untracked after")
            .await
            .unwrap();
        tokio::fs::write(&ignored_untracked, "ignored untracked after")
            .await
            .unwrap();

        let restored = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "id": id,
            })),
        )
        .await;
        assert_eq!(
            restored.status(),
            StatusCode::OK,
            "{}",
            body_json(restored).await
        );
        assert_eq!(
            tokio::fs::read_to_string(tracked).await.unwrap(),
            "tracked before"
        );
        assert_eq!(
            tokio::fs::read_to_string(tracked_ignored).await.unwrap(),
            "ignored but tracked before"
        );
        assert_eq!(
            tokio::fs::read_to_string(untracked).await.unwrap(),
            "untracked before"
        );
        assert_eq!(
            tokio::fs::read_to_string(ignored_untracked).await.unwrap(),
            "ignored untracked after",
            "ignored untracked files stay outside the existing Git code scope"
        );
    }

    #[tokio::test]
    async fn submodule_working_edits_complete_restore() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let source_file = source.path().join("library.rs");
        tokio::fs::write(&source_file, "pub fn version() -> u8 { 1 }\n")
            .await
            .unwrap();
        run_git(&["init", "-q"], Some(source.path())).await.unwrap();
        run_git(&["add", "library.rs"], Some(source.path()))
            .await
            .unwrap();
        run_git(
            &[
                "-c",
                "user.name=Checkpoint Test",
                "-c",
                "user.email=checkpoint@example.invalid",
                "commit",
                "-m",
                "submodule source",
            ],
            Some(source.path()),
        )
        .await
        .unwrap();

        run_git(&["init", "-q"], Some(workspace.path()))
            .await
            .unwrap();
        run_git(
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.path().to_str().unwrap(),
                "modules/library",
            ],
            Some(workspace.path()),
        )
        .await
        .unwrap();
        let submodule = workspace.path().join("modules/library");
        let original_head = run_git(&["rev-parse", "HEAD"], Some(&submodule))
            .await
            .unwrap();
        let working_file = submodule.join("library.rs");
        tokio::fs::write(&working_file, "pub fn version() -> u8 { 2 }\n")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": workspace.path() })),
        )
        .await;
        let status = response.status();
        let entry = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        let id = entry["id"].as_str().unwrap().to_string();

        tokio::fs::write(&working_file, "pub fn version() -> u8 { 3 }\n")
            .await
            .unwrap();
        let restore = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": entry["workspace"],
                "id": id,
            })),
        )
        .await;
        assert_eq!(restore.status(), StatusCode::OK);
        assert_eq!(
            tokio::fs::read_to_string(working_file).await.unwrap(),
            "pub fn version() -> u8 { 2 }\n"
        );
        assert_eq!(
            run_git(&["rev-parse", "HEAD"], Some(&submodule))
                .await
                .unwrap(),
            original_head,
            "checkpoint restore does not move the nested repository's identity"
        );
        let git_dir = checkpoint_git_dir(home_dir.path(), workspace.path());
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let tree = run_git(&[&git_dir_arg, "ls-tree", &id, "modules/library"], None)
            .await
            .unwrap();
        assert!(
            tree.starts_with("040000 tree "),
            "nested contents must be blobs, not a gitlink: {tree}"
        );
    }

    #[tokio::test]
    async fn checkpoint_failed_metadata_publication_never_becomes_restore_target() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let file = workspace.path().join("source.txt");
        tokio::fs::write(&file, "current contents").await.unwrap();
        let git_dir = ensure_checkpoint_repo(home_dir.path(), workspace.path())
            .await
            .unwrap();
        tokio::fs::create_dir(checkpoint_metadata_path(&git_dir))
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "requestId": "metadata-write-failure",
            })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let fsck = run_git(
            &[&git_dir_arg, "fsck", "--no-reflogs", "--unreachable"],
            None,
        )
        .await
        .unwrap();
        let orphan = fsck
            .lines()
            .find_map(|line| {
                line.strip_prefix("unreachable commit ")
                    .or_else(|| line.strip_prefix("dangling commit "))
            })
            .unwrap_or_else(|| {
                panic!("metadata failure should leave an unreachable commit object: {fsck}")
            })
            .to_string();
        let current_head = run_git(&[&git_dir_arg, "rev-parse", "--verify", "HEAD"], None).await;
        assert!(
            current_head.is_err(),
            "failed target must not advance the published ref"
        );

        let list = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Query(HashMap::from([
                (
                    "cwd".to_string(),
                    workspace.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspacePath".to_string(),
                    workspace.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspaceProvenance".to_string(),
                    "directory-picker".to_string(),
                ),
            ])),
        )
        .await;
        let entries = body_json(list).await;
        assert_eq!(entries["checkpoints"], json!([]));

        tokio::fs::write(&file, "still current").await.unwrap();
        let restore = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "id": orphan,
            })),
        )
        .await;
        assert_eq!(restore.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            tokio::fs::read_to_string(file).await.unwrap(),
            "still current"
        );
    }

    #[tokio::test]
    async fn default_label_is_checkpoint_when_absent() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
            })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["label"], json!("checkpoint"));
    }

    #[tokio::test]
    async fn label_is_trimmed_and_truncated_to_120_chars() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let long_label = "x".repeat(200);
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": format!("  {long_label}  "),
            })),
        )
        .await
        .into_response();
        let value = body_json(resp).await;
        let label = value["label"].as_str().unwrap();
        assert_eq!(label.len(), 120);
        assert!(!label.starts_with(' '));
    }

    #[tokio::test]
    async fn request_id_is_included_in_response_and_persisted_to_metadata_file() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "with request id",
                "requestId": "req-123",
            })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["requestId"], json!("req-123"));
        let sha = value["id"].as_str().unwrap().to_string();

        let git_dir = checkpoint_git_dir(home_dir.path(), cwd_dir.path());
        let metadata_raw = tokio::fs::read_to_string(checkpoint_metadata_path(&git_dir))
            .await
            .expect("metadata file must be written when requestId is supplied");
        let metadata: Value = serde_json::from_str(&metadata_raw).unwrap();
        assert_eq!(metadata[&sha]["requestId"], json!("req-123"));
    }

    #[tokio::test]
    async fn repeated_checkpoints_for_same_cwd_produce_distinct_shas_and_reuse_shadow_repo() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();

        let resp1 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let value1 = body_json(resp1).await;
        let sha1 = value1["id"].as_str().unwrap().to_string();

        let resp2 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let value2 = body_json(resp2).await;
        let sha2 = value2["id"].as_str().unwrap().to_string();

        assert_ne!(sha1, sha2, "each checkpoint call must create a new commit");

        // Only ONE shadow repo dir should exist for this cwd across both calls.
        let checkpoints_root = home_dir.path().join(".freshell").join("checkpoints");
        let mut entries = tokio::fs::read_dir(&checkpoints_root).await.unwrap();
        let mut count = 0;
        while entries.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(
            count, 1,
            "one shadow repo per distinct cwd, reused across calls"
        );
    }

    #[tokio::test]
    async fn cwds_own_git_state_is_never_touched() {
        // A cwd that IS its own git repo must be left completely alone: the
        // shadow repo lives entirely under `home`, never inside `cwd/.git`.
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q"], Some(cwd_dir.path()))
            .await
            .unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        // The cwd's own .git must be untouched (still exactly what `git init`
        // produced) — no new refs/objects created by the shadow-repo commit.
        let head = tokio::fs::read_to_string(cwd_dir.path().join(".git/HEAD"))
            .await
            .unwrap();
        assert!(head.starts_with("ref:"));
    }

    #[tokio::test]
    async fn route_is_wired_at_api_fresh_agent_checkpoints() {
        use tower::ServiceExt;

        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let app = router(state(home_dir.path()));
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/fresh-agent/checkpoints")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(axum::body::Body::from(
                serde_json::to_vec(&valid_body(cwd_dir.path().to_str().unwrap())).unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(request).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropped_http_capture_holds_workspace_until_descendant_is_settled() {
        use std::os::unix::fs::PermissionsExt;
        use tower::ServiceExt;

        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let started = home_dir.path().join("filter-descendant-started");
        let late_write = home_dir.path().join("filter-descendant-late-write");
        // Runtime-suite sandboxes mount `/tmp` without executable permission.
        // Keep this deliberately executable Git filter in the sandbox-owned
        // executable temp volume when one is configured.
        let executable_tmp = std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.path().to_path_buf());
        let filter_dir = tempfile::Builder::new()
            .prefix("freshell-checkpoint-filter-")
            .tempdir_in(executable_tmp)
            .unwrap();
        let filter = filter_dir.path().join("blocking-clean-filter.sh");
        let filter_contents = format!(
            "#!/bin/sh\n( trap '' TERM; printf started > '{}'; sleep 1; printf late > '{}' ) &\nwait\ncat\n",
            started.display(),
            late_write.display(),
        );
        tokio::fs::write(&filter, filter_contents).await.unwrap();
        let mut permissions = tokio::fs::metadata(&filter).await.unwrap().permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&filter, permissions)
            .await
            .unwrap();
        tokio::fs::write(
            cwd_dir.path().join(".gitattributes"),
            "*.slow filter=blocking\n",
        )
        .await
        .unwrap();
        tokio::fs::write(cwd_dir.path().join("payload.slow"), "checkpoint data\n")
            .await
            .unwrap();

        let git_dir = ensure_checkpoint_repo(home_dir.path(), cwd_dir.path())
            .await
            .unwrap();
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let filter_command = filter.to_string_lossy().into_owned();
        run_git(
            &[
                &git_dir_arg,
                "config",
                "filter.blocking.clean",
                &filter_command,
            ],
            None,
        )
        .await
        .unwrap();
        run_git(
            &[&git_dir_arg, "config", "filter.blocking.required", "true"],
            None,
        )
        .await
        .unwrap();

        let state = state(home_dir.path());
        let service = Arc::clone(&state.service);
        let workspace = cwd_dir.path().to_path_buf();
        let workspace_text = workspace.to_string_lossy().into_owned();
        let app = router(state);
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/fresh-agent/checkpoints")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(axum::body::Body::from(
                serde_json::to_vec(&json!({
                    "cwd": workspace_text,
                    "workspace": {
                        "path": workspace_text,
                        "provenance": "directory-picker"
                    },
                    "requestId": "dropped-http-capture"
                }))
                .unwrap(),
            ))
            .unwrap();
        let request_task = tokio::spawn(app.oneshot(request));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !started.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the Git clean filter started its descendant");

        request_task.abort();
        let _ = request_task.await;

        let during_settlement = service
            .lock_workspace(&workspace, Duration::from_millis(30))
            .await;
        assert!(
            during_settlement.is_err(),
            "the workspace lock must remain owned while the descendant is being killed and reaped"
        );

        let settled_lock = tokio::time::timeout(
            Duration::from_secs(3),
            service.lock_workspace(&workspace, Duration::from_secs(3)),
        )
        .await
        .expect("the HTTP cancellation supervisor settles")
        .expect("the workspace is released after settlement");
        drop(settled_lock);

        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(
            !late_write.exists(),
            "a descendant cannot continue writing after the route has settled cancellation"
        );
        let entries = list_checkpoints(home_dir.path(), &workspace).await.unwrap();
        assert!(!entries
            .iter()
            .any(|entry| { entry["requestId"].as_str() == Some("dropped-http-capture") }));
    }

    // ── is_valid_checkpoint_id ──────────────────────────────────────────

    #[test]
    fn checkpoint_id_format_accepts_7_to_40_hex_chars_case_insensitively() {
        assert!(is_valid_checkpoint_id("abc1234")); // 7 chars, minimum
        assert!(is_valid_checkpoint_id("ABC1234")); // uppercase hex ok
        assert!(is_valid_checkpoint_id(&"a".repeat(40))); // 40 chars, maximum
    }

    #[test]
    fn checkpoint_id_format_rejects_too_short_too_long_or_non_hex() {
        assert!(!is_valid_checkpoint_id("abc123")); // 6 chars, too short
        assert!(!is_valid_checkpoint_id(&"a".repeat(41))); // 41 chars, too long
        assert!(!is_valid_checkpoint_id("nothexch")); // contains non-hex chars
        assert!(!is_valid_checkpoint_id(""));
    }

    // ── GET /checkpoints (list) ─────────────────────────────────────────

    fn list_query(cwd: &str) -> Query<HashMap<String, String>> {
        Query(HashMap::from([("cwd".to_string(), cwd.to_string())]))
    }

    #[tokio::test]
    async fn list_missing_auth_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            HeaderMap::new(),
            list_query("/tmp"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_wrong_auth_token_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("wrong"),
            list_query("/tmp"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_missing_cwd_query_param_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Query(HashMap::new()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn list_returns_empty_checkpoints_for_a_cwd_with_no_checkpoints_yet() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["checkpoints"], json!([]));
    }

    #[tokio::test]
    async fn list_returns_empty_for_an_initialized_but_unborn_shadow_repository() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        ensure_checkpoint_repo(home_dir.path(), cwd_dir.path())
            .await
            .unwrap();

        assert!(list_checkpoints(home_dir.path(), cwd_dir.path())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn list_reports_an_existing_shadow_repository_with_missing_head_as_corrupt() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let git_dir = ensure_checkpoint_repo(home_dir.path(), cwd_dir.path())
            .await
            .unwrap();
        tokio::fs::remove_file(git_dir.join("HEAD")).await.unwrap();

        let result = list_checkpoints(home_dir.path(), cwd_dir.path()).await;

        assert!(result
            .unwrap_err()
            .contains("checkpoint repository exists but its HEAD is missing"));
    }

    #[tokio::test]
    async fn list_does_not_require_cwd_to_exist_on_disk() {
        // Legacy GET /checkpoints has no fsp.access(cwd) guard (unlike POST
        // /checkpoints, /diff, /exec) -- fresh-agent-extras-router.ts:370-380.
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist-anywhere");
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(missing.to_str().unwrap()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["checkpoints"], json!([]));
    }

    #[tokio::test]
    async fn list_returns_checkpoints_newest_first_with_id_ts_label() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();

        let resp1 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "first"
            })),
        )
        .await
        .into_response();
        let id1 = body_json(resp1).await["id"].as_str().unwrap().to_string();

        let resp2 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "second"
            })),
        )
        .await
        .into_response();
        let id2 = body_json(resp2).await["id"].as_str().unwrap().to_string();
        assert_ne!(id1, id2);

        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        let checkpoints = value["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 2);
        assert_eq!(checkpoints[0]["id"], json!(id2), "newest checkpoint first");
        assert_eq!(checkpoints[0]["label"], json!("second"));
        assert_eq!(checkpoints[1]["id"], json!(id1));
        assert_eq!(checkpoints[1]["label"], json!("first"));
        assert!(checkpoints[0]["ts"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn list_storage_error_is_not_reported_as_an_empty_checkpoint_history() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let first = CHECKPOINT_CAPTURE_CONTEXT
            .scope(
                Arc::new(CheckpointCaptureControl::default()),
                create_checkpoint(home_dir.path(), cwd_dir.path(), "first", Some("req-1")),
            )
            .await
            .unwrap();
        let git_dir = checkpoint_git_dir(home_dir.path(), cwd_dir.path());
        let head_ref = run_git(
            &[
                &format!("--git-dir={}", git_dir.display()),
                "symbolic-ref",
                "HEAD",
            ],
            None,
        )
        .await
        .unwrap();
        let ref_path = git_dir.join(head_ref.trim());
        tokio::fs::write(&ref_path, format!("{}\n", "0".repeat(40)))
            .await
            .unwrap();

        let response = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;

        assert_eq!(first["id"].as_str().unwrap().len(), 40);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body_json(response).await;
        assert!(body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Git operation log failed"));
    }

    #[tokio::test]
    async fn list_includes_persisted_request_id_metadata() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "with metadata",
                "requestId": "req-1",
            })),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        let value = body_json(resp).await;
        let checkpoints = value["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0]["id"], json!(id));
        assert_eq!(checkpoints[0]["requestId"], json!("req-1"));
    }

    // ── POST /checkpoints/metadata ──────────────────────────────────────

    #[tokio::test]
    async fn metadata_missing_auth_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            HeaderMap::new(),
            Json(json!({ "cwd": "/tmp", "id": "abc1234", "turnId": "t1" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn metadata_missing_cwd_or_id_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "turnId": "t1" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("cwd and id are required"));
    }

    #[tokio::test]
    async fn metadata_missing_request_id_and_turn_id_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": "abc1234" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("requestId or turnId is required"));
    }

    #[tokio::test]
    async fn metadata_nonexistent_cwd_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist");
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": missing.to_str().unwrap(), "id": "abc1234", "turnId": "t1" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert!(value["error"]
            .as_str()
            .unwrap()
            .starts_with("cwd does not exist:"));
    }

    #[tokio::test]
    async fn metadata_invalid_checkpoint_id_format_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": "nothex!!", // fails the hex-chars format check
                "turnId": "t1",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("invalid checkpoint id"));
    }

    #[tokio::test]
    async fn metadata_well_formed_but_nonexistent_commit_id_is_500() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        // Create the shadow repo (with at least one commit) so rev-parse has
        // a repo to search, but reference a sha that was never committed.
        post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await;
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": "0000000000000000000000000000000000000f",
                "turnId": "t1",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn metadata_round_trip_persists_request_id_and_turn_id_and_returns_merged_entry() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": id,
                "requestId": "req-9",
                "turnId": "turn-9",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["id"], json!(id));
        assert_eq!(value["requestId"], json!("req-9"));
        assert_eq!(value["turnId"], json!("turn-9"));

        // The patch must be visible via the list route too (same persisted file).
        let list_resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        let list_value = body_json(list_resp).await;
        let checkpoints = list_value["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints[0]["turnId"], json!("turn-9"));
    }

    #[tokio::test]
    async fn metadata_short_sha_prefix_resolves_to_full_sha_entry() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let full_id = body_json(resp).await["id"].as_str().unwrap().to_string();
        let short_id = &full_id[..8];

        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": short_id,
                "turnId": "turn-short",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(
            value["id"],
            json!(full_id),
            "response id must be the resolved full sha, not the short prefix"
        );
    }

    // ── POST /checkpoints/restore ────────────────────────────────────────

    #[tokio::test]
    async fn restore_missing_auth_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            HeaderMap::new(),
            Json(json!({ "cwd": "/tmp", "id": "abc1234" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn restore_missing_cwd_or_id_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": "/tmp" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("cwd and id are required"));
    }

    #[tokio::test]
    async fn restore_nonexistent_cwd_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist");
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": missing.to_str().unwrap(), "id": "abc1234" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn restore_invalid_checkpoint_id_format_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": "nothex!!" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("invalid checkpoint id"));
    }

    #[tokio::test]
    async fn restore_well_formed_but_nonexistent_commit_id_is_500() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": "0000000000000000000000000000000000000f",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn restore_reverts_a_tracked_file_mutation() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let file_path = cwd_dir.path().join("file.txt");
        tokio::fs::write(&file_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        tokio::fs::write(&file_path, "modified after checkpoint")
            .await
            .unwrap();

        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["restored"], json!(true));

        let content = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(content, "original");
    }

    #[tokio::test]
    async fn restore_leaves_files_created_after_the_checkpoint_in_place() {
        // Pinning legacy's documented v1 semantics (fresh-agent-extras-router.ts:67-68,
        // and the client's own confirm-dialog copy in FreshAgentView.tsx:1719):
        // "Files created since are left in place." Restore uses overlay-mode
        // `git checkout <id> -- .`, which never deletes paths absent from the
        // checkpoint's tree.
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let tracked_path = cwd_dir.path().join("tracked.txt");
        tokio::fs::write(&tracked_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        let new_path = cwd_dir.path().join("created-after.txt");
        tokio::fs::write(&new_path, "new stuff").await.unwrap();
        tokio::fs::write(&tracked_path, "modified").await.unwrap();

        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        assert_eq!(
            tokio::fs::read_to_string(&tracked_path).await.unwrap(),
            "original",
            "tracked file changed since the checkpoint must be reverted"
        );
        assert_eq!(
            tokio::fs::read_to_string(&new_path).await.unwrap(),
            "new stuff",
            "a file created after the checkpoint must be left in place, not deleted"
        );
    }

    #[tokio::test]
    async fn restore_recreates_a_tracked_file_deleted_after_the_checkpoint() {
        // Overlay-mode `git checkout <id> -- .` restores any path present in
        // the checkpoint's tree, including one that was deleted from the
        // working tree afterward -- pinning this less-obvious corner of the
        // "restore" contract (not merely "revert modifications").
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let file_path = cwd_dir.path().join("file.txt");
        tokio::fs::write(&file_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        tokio::fs::remove_file(&file_path).await.unwrap();
        assert!(tokio::fs::metadata(&file_path).await.is_err());

        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let content = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(content, "original");
    }

    #[tokio::test]
    async fn restore_never_touches_cwds_own_git_state() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q"], Some(cwd_dir.path()))
            .await
            .unwrap();
        let file_path = cwd_dir.path().join("file.txt");
        tokio::fs::write(&file_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        tokio::fs::write(&file_path, "modified").await.unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The cwd's own .git must remain exactly what `git init` produced --
        // no HEAD/index mutation from the shadow-repo restore.
        let head = tokio::fs::read_to_string(cwd_dir.path().join(".git/HEAD"))
            .await
            .unwrap();
        assert!(head.starts_with("ref:"));
    }

    // ── outer end-to-end test: real HTTP routes, create -> list -> mutate -> restore ──

    #[tokio::test]
    async fn end_to_end_rewind_actually_rewinds_via_real_http_routes() {
        use tower::ServiceExt;

        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let file_path = cwd_dir.path().join("code.rs");
        tokio::fs::write(&file_path, "fn original() {}")
            .await
            .unwrap();

        async fn send(app: &Router, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
            let request = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .header("x-auth-token", "tok")
                .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap();
            let resp = app.clone().oneshot(request).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            let value: Value = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            (status, value)
        }

        let app = router(state(home_dir.path()));

        // 1. create
        let (status, body) = send(
            &app,
            "POST",
            "/api/fresh-agent/checkpoints",
            json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "before the fix"
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let checkpoint_id = body["id"].as_str().unwrap().to_string();

        // 2. list -- the checkpoint we just created must appear.
        let (status, body) = send(
            &app,
            "GET",
            &format!(
                "/api/fresh-agent/checkpoints?cwd={}",
                cwd_dir.path().to_str().unwrap()
            ),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let checkpoints = body["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0]["id"], json!(checkpoint_id));

        // 3. mutate the working tree (simulating an agent turn editing code).
        tokio::fs::write(&file_path, "fn broken() { panic!() }")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(&file_path).await.unwrap(),
            "fn broken() { panic!() }"
        );

        // 4. restore -- the whole point of "rewind code to here".
        let (status, body) = send(
            &app,
            "POST",
            "/api/fresh-agent/checkpoints/restore",
            json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": checkpoint_id }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["restored"], json!(true));

        // 5. verify: the file bytes are back to their checkpointed state.
        let restored_content = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(
            restored_content, "fn original() {}",
            "rewind must actually rewind the file to its checkpointed contents"
        );
    }
}

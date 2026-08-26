//! Provider-agnostic runtime ownership and restart transaction coordinator.
//!
//! Provider teardown/resume adapters live outside this module. This module owns
//! the cross-provider invariants: immutable request fingerprints, live runtime
//! generations, preflight-before-shutdown ordering, and terminal-result replay.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use freshell_protocol::{
    AgentRestart, AgentRestartFailed, AgentRestartFailureCode, AgentRestartReplaced,
    AgentRestartStarted, AgentRuntimeKind, OldRuntimeDescriptor, RuntimeDescriptor, ServerMessage,
};
use serde::{Deserialize, Serialize};

const RESTART_REPLACEMENT_OWNERSHIP_ENV: &str = "FRESHELL_RESTART_REPLACEMENT_ID";

/// Canonical durable identity of one restartable runtime.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RuntimeLocator {
    pub kind: AgentRuntimeKind,
    pub provider: String,
    pub session_id: String,
}

/// Cross-kind durable-session ownership key.
///
/// A terminal CLI and a fresh-agent sidecar can both write the same provider
/// transcript, so restart admission must serialize on this key rather than on
/// [`RuntimeLocator::kind`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RestartSessionKey {
    pub provider: String,
    pub session_id: String,
}

impl RestartSessionKey {
    pub fn new(provider: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            session_id: session_id.into(),
        }
    }
}

impl RuntimeLocator {
    pub fn new(
        kind: AgentRuntimeKind,
        provider: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            provider: provider.into(),
            session_id: session_id.into(),
        }
    }

    fn from_request(request: &AgentRestart) -> Self {
        Self::new(
            request.kind,
            request.provider.clone(),
            request.session_id.clone(),
        )
    }

    fn session_key(&self) -> RestartSessionKey {
        RestartSessionKey::new(self.provider.clone(), self.session_id.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredResult {
    fingerprint: AgentRestart,
    terminal: ServerMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRestartRecovery {
    pub request_id: String,
    pub request: AgentRestart,
    /// Distinct client request ids correlated to the same retired runtime.
    /// The owner remains authoritative for storage/recovery, while every
    /// follower receives and can replay a request-specific terminal result.
    #[serde(default)]
    pub followers: Vec<AgentRestart>,
    pub old_runtime: RuntimeDescriptor,
    /// True until provider teardown has crossed every process/consumer/lease
    /// barrier. A retry or boot recovery must finish this phase before it may
    /// create a replacement.
    #[serde(default)]
    pub retirement_pending: bool,
    #[serde(default)]
    pub resume_context: Option<RestartResumeContext>,
    /// Capture-before-kill proof retained across a real server process boot.
    /// When `retirement_pending` survives into a different boot, production
    /// recovery must complete every action here before it may create a new
    /// writer for the durable session.
    #[serde(default)]
    pub retirement_fence: Option<RestartRetirementFence>,
    /// Persisted before replacement creation begins. If the server dies after
    /// spawning a writer but before committing its runtime descriptor, boot
    /// recovery uses this ownership token to quiesce the ambiguous process (or
    /// remote session) before attempting another resume.
    #[serde(default)]
    pub replacement_fence: Option<RestartReplacementFence>,
    pub last_failure: Option<AgentRestartFailed>,
}

/// Minimal provider resume data that must survive a server restart after the
/// predecessor has already been retired.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartResumeContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_shell: Option<freshell_protocol::Shell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_codex_managed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_session_type: Option<freshell_protocol::SessionType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_sandbox: Option<freshell_protocol::Sandbox>,
}

/// Durable ownership actions captured while the predecessor is still live.
///
/// A process-tree action contains exact `(pid,starttime)` incarnations, never
/// a naked PID. OpenCode uses a shared serve process and therefore fences the
/// selected remote session with an explicit abort instead of killing the
/// process that also owns unrelated sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartRetirementFence {
    pub origin_boot_id: String,
    #[serde(default)]
    pub actions: Vec<RestartRetirementAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestartRetirementAction {
    ProcessTree {
        barrier: freshell_codex::transport::OwnedProcessTreeBarrier,
    },
    OpenCodeRemoteAbort {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
}

/// Durable identity assigned before a replacement spawn is allowed to begin.
///
/// The provider adapter stamps `ownership_id` onto every process that can
/// continue writing the resumed session. Recovery can therefore discover and
/// retire a replacement even when the server crashed before learning its
/// runtime id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartReplacementFence {
    pub ownership_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedGeneration {
    locator: RuntimeLocator,
    generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedResult {
    request_id: String,
    result: StoredResult,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedOwnership {
    #[serde(default)]
    generations: Vec<PersistedGeneration>,
    #[serde(default)]
    results: Vec<PersistedResult>,
    #[serde(default)]
    pending_recoveries: Vec<PendingRestartRecovery>,
}

#[derive(Debug, Clone, Default)]
struct RuntimeOwnership {
    by_locator: HashMap<RuntimeLocator, RuntimeDescriptor>,
    locator_order: VecDeque<RuntimeLocator>,
    /// Exact descriptor for every observed live runtime id, including retired
    /// generations whose already-queued output/exit frames still need fencing.
    descriptor_by_live: HashMap<(AgentRuntimeKind, String), RuntimeDescriptor>,
    descriptor_order: VecDeque<(AgentRuntimeKind, String)>,
    locator_by_live: HashMap<(AgentRuntimeKind, String), RuntimeLocator>,
    /// Distinguishes a genuinely never-bound terminal from a predecessor whose
    /// locator was deliberately removed during replacement. Retired entries
    /// remain for the same bounded late-frame window as their descriptors.
    retired_live: HashSet<(AgentRuntimeKind, String)>,
    fresh_event_aliases: HashMap<(String, String), RuntimeDescriptor>,
    fresh_alias_order: VecDeque<(String, String)>,
    last_generation: HashMap<RuntimeLocator, u64>,
    generation_order: VecDeque<RuntimeLocator>,
    results: HashMap<String, StoredResult>,
    result_order: VecDeque<String>,
    pending_recoveries: HashMap<String, PendingRestartRecovery>,
}

/// Error returned by a provider-specific restart adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartFailure {
    pub code: AgentRestartFailureCode,
    pub message: String,
    pub retryable: bool,
}

impl RestartFailure {
    pub fn new(code: AgentRestartFailureCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

/// Existing provider-specific resume paths implement this seam in Task 2.
#[async_trait::async_trait]
pub trait RestartRuntime: Send + Sync {
    type ResumePlan: Send;

    /// Validate durable resume eligibility and capture every setting needed by
    /// the eventual replacement. This always runs while the old runtime lives.
    async fn preflight(&self, request: &AgentRestart) -> Result<Self::ResumePlan, RestartFailure>;

    /// Release any non-destructive provider reservation acquired by
    /// [`Self::preflight`] when the coordinator cannot durably record the
    /// shutdown boundary. Implementations without a reservation are no-ops.
    async fn abort_preflight(&self, _request: &AgentRestart, _plan: &Self::ResumePlan) {}

    /// Quiesce only the selected live runtime without final-close semantics.
    async fn shutdown_for_restart(
        &self,
        request: &AgentRestart,
        plan: &Self::ResumePlan,
    ) -> Result<(), RestartFailure>;

    /// Create the one server-owned replacement through the normal resume path.
    async fn create_replacement(
        &self,
        request: &AgentRestart,
        plan: Self::ResumePlan,
    ) -> Result<String, RestartFailure>;

    /// Whether this adapter can leave an external writer alive across a hard
    /// server crash and therefore requires a durable pre-spawn ownership
    /// fence. Test-only/in-memory adapters may keep the default.
    fn requires_replacement_fence(&self) -> bool {
        false
    }

    /// Spawn using the ownership identity that was durably recorded before
    /// this call. The default preserves lightweight test adapter behavior.
    async fn create_replacement_fenced(
        &self,
        request: &AgentRestart,
        plan: Self::ResumePlan,
        _fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        self.create_replacement(request, plan).await
    }

    /// Capture the small provider context required to resume after process
    /// restart. Called after preflight and persisted before teardown.
    fn persisted_resume_context(
        &self,
        _request: &AgentRestart,
        _plan: &Self::ResumePlan,
    ) -> Option<RestartResumeContext> {
        None
    }

    /// Capture the ownership barrier that makes `retirement_pending` safe to
    /// recover after this server process is gone. Implementations that own no
    /// external writer may leave this absent; the production adapter requires
    /// one for every live production runtime before crossing the destructive
    /// boundary.
    fn persisted_retirement_fence(
        &self,
        _request: &AgentRestart,
        _plan: &Self::ResumePlan,
    ) -> Option<RestartRetirementFence> {
        None
    }

    /// Resume a replacement whose selected predecessor was already shut down
    /// before a retryable failure or server restart. Implementations may
    /// override this when recovery needs a path distinct from ordinary
    /// preflight; the default rebuilds a resume plan and creates directly.
    async fn recover_replacement(
        &self,
        request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        let plan = self.preflight(request).await?;
        self.create_replacement(request, plan).await
    }

    /// Quiesce a replacement whose spawn may have completed before a hard
    /// crash prevented its durable commit. This always runs before retrying a
    /// persisted pre-spawn fence.
    async fn recover_ambiguous_replacement(
        &self,
        _request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
        _fence: &RestartReplacementFence,
    ) -> Result<(), RestartFailure> {
        Ok(())
    }

    async fn recover_replacement_fenced(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        _fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        self.recover_replacement(request, context).await
    }

    /// Continue a teardown that was durably recorded before provider
    /// quiescence completed. The default is suitable for adapters whose live
    /// runtime remains preflightable; production adapters may resume an
    /// internal quarantined retirement directly.
    async fn recover_retirement(
        &self,
        request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<(), RestartFailure> {
        let plan = self.preflight(request).await?;
        self.shutdown_for_restart(request, &plan).await
    }

    /// Recover a durable retirement with its capture-before-kill fence. The
    /// default preserves the existing same-process adapter contract; the
    /// production adapter additionally distinguishes same-boot quarantine
    /// recovery from cross-boot process/remote ownership recovery.
    async fn recover_persisted_retirement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        _fence: Option<&RestartRetirementFence>,
    ) -> Result<(), RestartFailure> {
        self.recover_retirement(request, context).await
    }
}

/// Messages to broadcast for one request. A replay contains only the stored
/// terminal result (`replaced` or `failed`), never a second `started`.
#[derive(Debug, Clone)]
pub struct RestartOutcome {
    pub messages: Vec<ServerMessage>,
    pub replayed: bool,
}

struct UnavailableRestartRuntime;

#[async_trait::async_trait]
impl RestartRuntime for UnavailableRestartRuntime {
    type ResumePlan = ();

    async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
        Err(RestartFailure::new(
            AgentRestartFailureCode::Unresumable,
            "no restart adapter is registered for this runtime",
            false,
        ))
    }

    async fn shutdown_for_restart(
        &self,
        _request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        unreachable!("unavailable restart adapter never passes preflight")
    }

    async fn create_replacement(
        &self,
        _request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        unreachable!("unavailable restart adapter never passes preflight")
    }
}

/// Lifetime guard for the persistent journal's single-writer lock.
///
/// Unix uses a process-associated `fcntl` record lock so forked PTY children
/// do not inherit ownership. A same-process registry supplies the exclusion
/// semantics that POSIX record locks intentionally do not provide between
/// two descriptors opened by one process.
struct PersistenceLock {
    file: std::fs::File,
    key: PathBuf,
}

fn process_persistence_locks() -> &'static Mutex<HashSet<PathBuf>> {
    static LOCKS: std::sync::OnceLock<Mutex<HashSet<PathBuf>>> = std::sync::OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(unix)]
impl Drop for PersistenceLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        let mut unlock = libc::flock {
            l_type: libc::F_UNLCK as libc::c_short,
            l_whence: libc::SEEK_SET as libc::c_short,
            l_start: 0,
            l_len: 0,
            l_pid: 0,
        };
        // SAFETY: `file` owns a valid descriptor. Drop cannot report an
        // unlock error; closing the descriptor immediately afterwards is the
        // kernel backstop.
        unsafe {
            libc::fcntl(self.file.as_raw_fd(), libc::F_SETLK, &mut unlock);
        }
        process_persistence_locks()
            .lock()
            .expect("restart process lock registry")
            .remove(&self.key);
    }
}

#[cfg(not(unix))]
impl Drop for PersistenceLock {
    fn drop(&mut self) {
        process_persistence_locks()
            .lock()
            .expect("restart process lock registry")
            .remove(&self.key);
    }
}

/// One server-owned registry for runtime descriptors and restart results.
#[derive(Clone)]
pub struct RestartCoordinator {
    ownership: Arc<Mutex<RuntimeOwnership>>,
    persistence_path: Option<Arc<PathBuf>>,
    /// Holds the sibling journal's exclusive advisory lock for the complete
    /// lifetime of every clone of this persistent coordinator.
    #[allow(dead_code)] // read only by the kernel (record-lock lifetime)
    persistence_lock: Option<Arc<PersistenceLock>>,
    persistence_fault: Option<Arc<String>>,
    session_locks: Arc<Mutex<HashMap<RestartSessionKey, Arc<tokio::sync::Mutex<()>>>>>,
    session_lock_order: Arc<Mutex<VecDeque<RestartSessionKey>>>,
    request_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    request_lock_order: Arc<Mutex<VecDeque<String>>>,
    lock_limit: usize,
    ownership_limit: usize,
    registered_runtime:
        Arc<std::sync::RwLock<Option<std::sync::Weak<dyn RestartRuntime<ResumePlan = ()>>>>>,
}

const DEFAULT_RESTART_PERSISTED_GENERATION_LIMIT: usize = 1_024;
const DEFAULT_RESTART_LOCK_LIMIT: usize = 1_024;
const DEFAULT_RESTART_OWNERSHIP_LIMIT: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedOwnershipCounts {
    pub descriptors: usize,
    pub live_locators: usize,
    pub current_locators: usize,
    pub fresh_aliases: usize,
    pub generation_high_waters: usize,
}

/// Keeps a dynamically-installed restart adapter alive without introducing a
/// coordinator → adapter → [`crate::WsState`] reference cycle.
pub struct RestartRuntimeRegistration {
    _runtime: Arc<dyn RestartRuntime<ResumePlan = ()>>,
}

/// Opaque admission permit for one durable provider session.
///
/// Holding this permit prevents an explicit restart transaction for either
/// runtime kind from crossing preflight while a create/resume/adoption is in
/// progress. Callers must retain it through the final spawn/adoption commit.
pub struct RestartSessionAdmission {
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

struct LockRetentionGuard<'a>(&'a RestartCoordinator);

impl Drop for LockRetentionGuard<'_> {
    fn drop(&mut self) {
        self.0.prune_inactive_locks();
    }
}

impl Default for RestartCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl RestartCoordinator {
    pub fn new() -> Self {
        let mut coordinator = Self::new_with_limits(
            DEFAULT_RESTART_PERSISTED_GENERATION_LIMIT,
            DEFAULT_RESTART_LOCK_LIMIT,
        );
        coordinator.ownership_limit = DEFAULT_RESTART_OWNERSHIP_LIMIT;
        coordinator
    }

    pub fn new_with_limits(ownership_limit: usize, lock_limit: usize) -> Self {
        Self {
            ownership: Arc::new(Mutex::new(RuntimeOwnership::default())),
            persistence_path: None,
            persistence_lock: None,
            persistence_fault: None,
            session_locks: Arc::new(Mutex::new(HashMap::new())),
            session_lock_order: Arc::new(Mutex::new(VecDeque::new())),
            request_locks: Arc::new(Mutex::new(HashMap::new())),
            request_lock_order: Arc::new(Mutex::new(VecDeque::new())),
            lock_limit: lock_limit.max(1),
            ownership_limit: ownership_limit.max(1),
            registered_runtime: Arc::new(std::sync::RwLock::new(None)),
        }
    }

    pub fn new_persistent(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        Self::new_persistent_with_limits(
            path,
            DEFAULT_RESTART_PERSISTED_GENERATION_LIMIT,
            DEFAULT_RESTART_LOCK_LIMIT,
        )
    }

    pub fn new_persistent_with_limits(
        path: impl Into<PathBuf>,
        ownership_limit: usize,
        lock_limit: usize,
    ) -> std::io::Result<Self> {
        let path = path.into();
        let ownership_limit = ownership_limit.max(1);
        let lock_limit = lock_limit.max(1);
        let persistence_lock = Self::acquire_persistence_lock(&path)?;
        let ownership = Self::load_persisted(&path, ownership_limit)?;
        Ok(Self {
            ownership: Arc::new(Mutex::new(ownership)),
            persistence_path: Some(Arc::new(path)),
            persistence_lock: Some(Arc::new(persistence_lock)),
            persistence_fault: None,
            session_locks: Arc::new(Mutex::new(HashMap::new())),
            session_lock_order: Arc::new(Mutex::new(VecDeque::new())),
            request_locks: Arc::new(Mutex::new(HashMap::new())),
            request_lock_order: Arc::new(Mutex::new(VecDeque::new())),
            lock_limit,
            ownership_limit,
            registered_runtime: Arc::new(std::sync::RwLock::new(None)),
        })
    }

    pub fn disabled_for_persistence(error: impl Into<String>) -> Self {
        let mut coordinator = Self::new();
        coordinator.persistence_fault = Some(Arc::new(error.into()));
        coordinator
    }

    #[cfg(unix)]
    fn acquire_persistence_lock(path: &Path) -> std::io::Result<PersistenceLock> {
        use std::os::fd::AsRawFd;

        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("restart journal has no parent: {}", path.display()),
            )
        })?;
        std::fs::create_dir_all(parent)?;
        let lock_path = std::fs::canonicalize(parent)?.join(
            path.with_extension("lock").file_name().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("restart journal lock has no filename: {}", path.display()),
                )
            })?,
        );
        {
            let mut owned = process_persistence_locks()
                .lock()
                .expect("restart process lock registry");
            if !owned.insert(lock_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    format!(
                        "restart journal lock unavailable at {}: already owned by this process",
                        lock_path.display()
                    ),
                ));
            }
        }
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
        {
            Ok(file) => file,
            Err(error) => {
                process_persistence_locks()
                    .lock()
                    .expect("restart process lock registry")
                    .remove(&lock_path);
                return Err(error);
            }
        };
        let mut lock = libc::flock {
            l_type: libc::F_WRLCK as libc::c_short,
            l_whence: libc::SEEK_SET as libc::c_short,
            l_start: 0,
            l_len: 0,
            l_pid: 0,
        };
        // SAFETY: `file` owns this valid descriptor for the duration of the
        // call and remains stored by the coordinator while the lock is held.
        let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &mut lock) };
        if rc == 0 {
            Ok(PersistenceLock {
                file,
                key: lock_path,
            })
        } else {
            let source = std::io::Error::last_os_error();
            process_persistence_locks()
                .lock()
                .expect("restart process lock registry")
                .remove(&lock_path);
            Err(std::io::Error::new(
                source.kind(),
                format!(
                    "restart journal lock unavailable at {}: {source}",
                    lock_path.display()
                ),
            ))
        }
    }

    #[cfg(windows)]
    fn acquire_persistence_lock(path: &Path) -> std::io::Result<PersistenceLock> {
        use std::os::windows::fs::OpenOptionsExt;

        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("restart journal has no parent: {}", path.display()),
            )
        })?;
        std::fs::create_dir_all(parent)?;
        let lock_path = path.with_extension("lock");
        {
            let mut owned = process_persistence_locks()
                .lock()
                .expect("restart process lock registry");
            if !owned.insert(lock_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    format!(
                        "restart journal lock unavailable at {}: already owned by this process",
                        lock_path.display()
                    ),
                ));
            }
        }
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .share_mode(0)
            .open(&lock_path)
        {
            Ok(file) => file,
            Err(error) => {
                process_persistence_locks()
                    .lock()
                    .expect("restart process lock registry")
                    .remove(&lock_path);
                return Err(error);
            }
        };
        Ok(PersistenceLock {
            file,
            key: lock_path,
        })
    }

    #[cfg(not(any(unix, windows)))]
    fn acquire_persistence_lock(path: &Path) -> std::io::Result<PersistenceLock> {
        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("restart journal has no parent: {}", path.display()),
            )
        })?;
        std::fs::create_dir_all(parent)?;
        let lock_path = path.with_extension("lock");
        {
            let mut owned = process_persistence_locks()
                .lock()
                .expect("restart process lock registry");
            if !owned.insert(lock_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    format!(
                        "restart journal lock unavailable at {}: already owned by this process",
                        lock_path.display()
                    ),
                ));
            }
        }
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
        {
            Ok(file) => file,
            Err(error) => {
                process_persistence_locks()
                    .lock()
                    .expect("restart process lock registry")
                    .remove(&lock_path);
                return Err(error);
            }
        };
        Ok(PersistenceLock {
            file,
            key: lock_path,
        })
    }

    fn load_persisted(path: &Path, ownership_limit: usize) -> std::io::Result<RuntimeOwnership> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RuntimeOwnership::default())
            }
            Err(error) => return Err(error),
        };
        let persisted: PersistedOwnership = serde_json::from_slice(&bytes).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid restart transaction state: {error}"),
            )
        })?;
        let mut persisted_results = persisted.results;
        let pending_recoveries: HashMap<_, _> = persisted
            .pending_recoveries
            .into_iter()
            .map(|entry| (entry.request_id.clone(), entry))
            .collect();
        // Migration from the first durable format: retryable replacement
        // failures were incorrectly stored as terminal results. A pending
        // recovery is authoritative and must remain executable after reopen.
        persisted_results.retain(|entry| {
            !pending_recoveries.values().any(|pending| {
                pending.request_id == entry.request_id
                    || pending
                        .followers
                        .iter()
                        .any(|follower| follower.request_id == entry.request_id)
            })
        });
        if persisted_results.len() > ownership_limit {
            persisted_results.drain(..persisted_results.len().saturating_sub(ownership_limit));
        }
        let result_order = persisted_results
            .iter()
            .map(|entry| entry.request_id.clone())
            .collect();
        let mut generations = persisted.generations;
        if generations.len() > ownership_limit {
            generations.drain(..generations.len().saturating_sub(ownership_limit));
        }
        let generation_order = generations
            .iter()
            .map(|entry| entry.locator.clone())
            .collect();
        Ok(RuntimeOwnership {
            last_generation: generations
                .into_iter()
                .map(|entry| (entry.locator, entry.generation))
                .collect(),
            generation_order,
            results: persisted_results
                .into_iter()
                .map(|entry| (entry.request_id, entry.result))
                .collect(),
            result_order,
            pending_recoveries,
            ..RuntimeOwnership::default()
        })
    }

    fn persist_locked(&self, ownership: &RuntimeOwnership) -> std::io::Result<()> {
        if let Some(error) = &self.persistence_fault {
            return Err(std::io::Error::other(error.as_str()));
        }
        let Some(path) = self.persistence_path.as_deref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let state = PersistedOwnership {
            generations: ownership
                .generation_order
                .iter()
                .filter_map(|locator| {
                    ownership
                        .last_generation
                        .get(locator)
                        .map(|generation| PersistedGeneration {
                            locator: locator.clone(),
                            generation: *generation,
                        })
                })
                .collect(),
            results: ownership
                .result_order
                .iter()
                .filter_map(|request_id| {
                    ownership
                        .results
                        .get(request_id)
                        .map(|result| PersistedResult {
                            request_id: request_id.clone(),
                            result: result.clone(),
                        })
                })
                .collect(),
            pending_recoveries: ownership.pending_recoveries.values().cloned().collect(),
        };
        let bytes = serde_json::to_vec_pretty(&state)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let temp = path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        atomic_write_restart_journal(path, &temp, &bytes)
    }

    fn persist_or_log(&self, ownership: &RuntimeOwnership, operation: &'static str) {
        if let Err(error) = self.persist_locked(ownership) {
            tracing::error!(
                error = %error,
                operation,
                "agent.restart.persistence.failed"
            );
        }
    }

    fn try_update_ownership<T>(
        &self,
        operation: &'static str,
        update: impl FnOnce(&mut RuntimeOwnership) -> T,
    ) -> std::io::Result<T> {
        let mut ownership = self.ownership.lock().expect("restart ownership lock");
        let mut candidate = ownership.clone();
        let output = update(&mut candidate);
        self.persist_locked(&candidate).map_err(|error| {
            tracing::error!(
                error = %error,
                operation,
                "agent.restart.persistence.failed"
            );
            error
        })?;
        *ownership = candidate;
        Ok(output)
    }

    fn insert_result_locked(
        &self,
        ownership: &mut RuntimeOwnership,
        request: &AgentRestart,
        terminal: ServerMessage,
    ) {
        ownership
            .result_order
            .retain(|id| id != &request.request_id);
        ownership.result_order.push_back(request.request_id.clone());
        ownership.results.insert(
            request.request_id.clone(),
            StoredResult {
                fingerprint: request.clone(),
                terminal,
            },
        );
        // Keep a durable recent replay window so a lost terminal frame remains
        // idempotently recoverable across a crash without letting adversarial
        // unique request ids grow the journal forever. An evicted successful
        // request is still safe to retry: generation validation observes the
        // committed replacement and refuses to tear down that newer runtime.
        while ownership.result_order.len() > self.ownership_limit {
            let Some(expired) = ownership.result_order.pop_front() else {
                break;
            };
            ownership.results.remove(&expired);
        }
    }

    pub fn pending_recoveries(&self) -> Vec<PendingRestartRecovery> {
        self.ownership
            .lock()
            .expect("restart ownership lock")
            .pending_recoveries
            .values()
            .cloned()
            .collect()
    }

    /// Whether this durable provider session is reserved by any unfinished
    /// restart recovery, regardless of terminal versus fresh-agent kind or
    /// which historical generation owns the journal row.
    pub fn session_recovery_pending_for(&self, key: &RestartSessionKey) -> bool {
        self.ownership
            .lock()
            .expect("restart ownership lock")
            .pending_recoveries
            .values()
            .any(|pending| {
                pending.request.provider == key.provider
                    && pending.request.session_id == key.session_id
            })
    }

    /// Backward-compatible locator-shaped probe used by existing ingress
    /// wiring. The runtime kind is intentionally ignored: durable transcript
    /// ownership is cross-kind.
    pub fn retirement_pending_for(&self, locator: &RuntimeLocator) -> bool {
        self.session_recovery_pending_for(&locator.session_key())
    }

    /// Atomically admit one resume/create/adoption for a durable session.
    ///
    /// The returned permit must be held through final spawn/adoption commit.
    /// A restart transaction uses the same mutex from before preflight through
    /// replacement commit, eliminating check-then-act races in both
    /// directions.
    pub async fn acquire_session_admission(
        &self,
        provider: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<RestartSessionAdmission, ()> {
        let key = RestartSessionKey::new(provider, session_id);
        let lock = self.session_lock(&key);
        let guard = lock.lock_owned().await;
        if self.session_recovery_pending_for(&key) {
            return Err(());
        }
        Ok(RestartSessionAdmission { _guard: guard })
    }

    pub fn set_runtime(
        &self,
        runtime: Arc<dyn RestartRuntime<ResumePlan = ()>>,
    ) -> RestartRuntimeRegistration {
        *self
            .registered_runtime
            .write()
            .expect("registered restart runtime lock") = Some(Arc::downgrade(&runtime));
        RestartRuntimeRegistration { _runtime: runtime }
    }

    pub async fn execute_registered<F>(&self, request: AgentRestart, emit: F) -> RestartOutcome
    where
        F: FnMut(&ServerMessage),
    {
        let runtime = self
            .registered_runtime
            .read()
            .expect("registered restart runtime lock")
            .as_ref()
            .and_then(std::sync::Weak::upgrade);
        let runtime = runtime.unwrap_or_else(|| Arc::new(UnavailableRestartRuntime));
        self.execute_with_events(request, runtime.as_ref(), emit)
            .await
    }

    /// Retry every durable post-shutdown replacement after the production
    /// adapter has been installed. Terminal results are stored before this
    /// method forwards them to the shared broadcast bus.
    pub async fn recover_pending_registered<F>(&self, mut emit: F)
    where
        F: FnMut(&ServerMessage),
    {
        let max_passes = self.pending_recoveries().len().saturating_add(1);
        for _ in 0..max_passes {
            let before = self.pending_recoveries();
            if before.is_empty() {
                break;
            }
            let before_total = before.len();
            let before_retiring = before
                .iter()
                .filter(|recovery| recovery.retirement_pending)
                .count();
            for recovery in before {
                self.execute_registered(recovery.request, &mut emit).await;
            }
            let after = self.pending_recoveries();
            let after_retiring = after
                .iter()
                .filter(|recovery| recovery.retirement_pending)
                .count();
            if after.is_empty() {
                break;
            }
            if after.len() >= before_total && after_retiring >= before_retiring {
                break;
            }
        }
    }

    fn session_lock(&self, key: &RestartSessionKey) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.session_locks.lock().expect("restart session locks");
        if let Some(lock) = locks.get(key) {
            return Arc::clone(lock);
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(key.clone(), Arc::clone(&lock));
        let mut order = self
            .session_lock_order
            .lock()
            .expect("restart session lock order");
        order.push_back(key.clone());
        let mut inspected = 0;
        while locks.len() > self.lock_limit && inspected < order.len() {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            if locks
                .get(&oldest)
                .is_some_and(|lock| Arc::strong_count(lock) == 1)
            {
                locks.remove(&oldest);
            } else {
                order.push_back(oldest);
            }
            inspected += 1;
        }
        lock
    }

    fn request_lock(&self, request_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.request_locks.lock().expect("restart request locks");
        if let Some(lock) = locks.get(request_id) {
            return Arc::clone(lock);
        }
        let request_id = request_id.to_string();
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(request_id.clone(), Arc::clone(&lock));
        let mut order = self
            .request_lock_order
            .lock()
            .expect("restart request lock order");
        order.push_back(request_id);
        let mut inspected = 0;
        while locks.len() > self.lock_limit && inspected < order.len() {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            if locks
                .get(&oldest)
                .is_some_and(|lock| Arc::strong_count(lock) == 1)
            {
                locks.remove(&oldest);
            } else {
                order.push_back(oldest);
            }
            inspected += 1;
        }
        lock
    }

    fn prune_inactive_locks(&self) {
        {
            let mut locks = self.request_locks.lock().expect("restart request locks");
            let mut order = self
                .request_lock_order
                .lock()
                .expect("restart request lock order");
            let mut inspected = 0;
            while locks.len() > self.lock_limit && inspected < order.len() {
                let Some(oldest) = order.pop_front() else {
                    break;
                };
                if locks
                    .get(&oldest)
                    .is_some_and(|lock| Arc::strong_count(lock) == 1)
                {
                    locks.remove(&oldest);
                } else {
                    order.push_back(oldest);
                }
                inspected += 1;
            }
        }
        {
            let mut locks = self.session_locks.lock().expect("restart session locks");
            let mut order = self
                .session_lock_order
                .lock()
                .expect("restart session lock order");
            let mut inspected = 0;
            while locks.len() > self.lock_limit && inspected < order.len() {
                let Some(oldest) = order.pop_front() else {
                    break;
                };
                if locks
                    .get(&oldest)
                    .is_some_and(|lock| Arc::strong_count(lock) == 1)
                {
                    locks.remove(&oldest);
                } else {
                    order.push_back(oldest);
                }
                inspected += 1;
            }
        }
    }

    fn touch_key<T: PartialEq + Clone>(order: &mut VecDeque<T>, key: &T) {
        order.retain(|candidate| candidate != key);
        order.push_back(key.clone());
    }

    fn set_generation_locked(
        ownership: &mut RuntimeOwnership,
        locator: RuntimeLocator,
        generation: u64,
    ) {
        ownership
            .last_generation
            .insert(locator.clone(), generation);
        Self::touch_key(&mut ownership.generation_order, &locator);
    }

    fn set_fresh_alias_locked(
        ownership: &mut RuntimeOwnership,
        alias: (String, String),
        descriptor: RuntimeDescriptor,
    ) {
        ownership
            .fresh_event_aliases
            .insert(alias.clone(), descriptor);
        Self::touch_key(&mut ownership.fresh_alias_order, &alias);
    }

    fn touch_descriptor_locked(ownership: &mut RuntimeOwnership, key: (AgentRuntimeKind, String)) {
        Self::touch_key(&mut ownership.descriptor_order, &key);
    }

    fn prune_ownership_locked(ownership: &mut RuntimeOwnership, limit: usize) {
        while ownership.descriptor_order.len() > limit {
            let Some(key) = ownership.descriptor_order.pop_front() else {
                break;
            };
            let removed = ownership.descriptor_by_live.remove(&key);
            ownership.retired_live.remove(&key);
            if let Some(locator) = ownership.locator_by_live.remove(&key) {
                if ownership.by_locator.get(&locator) == removed.as_ref() {
                    ownership.by_locator.remove(&locator);
                    ownership.locator_order.retain(|entry| entry != &locator);
                }
            }
            if let Some(removed) = removed {
                ownership
                    .fresh_event_aliases
                    .retain(|_, descriptor| descriptor != &removed);
                ownership
                    .fresh_alias_order
                    .retain(|alias| ownership.fresh_event_aliases.contains_key(alias));
            }
        }
        while ownership.locator_order.len() > limit {
            let Some(locator) = ownership.locator_order.pop_front() else {
                break;
            };
            if let Some(descriptor) = ownership.by_locator.remove(&locator) {
                ownership
                    .locator_by_live
                    .remove(&(locator.kind, descriptor.runtime_id.clone()));
            }
        }
        while ownership.fresh_alias_order.len() > limit {
            let Some(alias) = ownership.fresh_alias_order.pop_front() else {
                break;
            };
            ownership.fresh_event_aliases.remove(&alias);
        }
        while ownership.generation_order.len() > limit {
            let Some(locator) = ownership.generation_order.pop_front() else {
                break;
            };
            ownership.last_generation.remove(&locator);
        }
    }

    pub fn retained_result_count(&self) -> usize {
        self.ownership
            .lock()
            .expect("restart ownership lock")
            .results
            .len()
    }

    pub fn retained_lock_counts(&self) -> (usize, usize) {
        (
            self.request_locks
                .lock()
                .expect("restart request locks")
                .len(),
            self.session_locks
                .lock()
                .expect("restart session locks")
                .len(),
        )
    }

    pub fn retained_ownership_counts(&self) -> RetainedOwnershipCounts {
        let ownership = self.ownership.lock().expect("restart ownership lock");
        RetainedOwnershipCounts {
            descriptors: ownership.descriptor_by_live.len(),
            live_locators: ownership.locator_by_live.len(),
            current_locators: ownership.by_locator.len(),
            fresh_aliases: ownership.fresh_event_aliases.len(),
            generation_high_waters: ownership.last_generation.len(),
        }
    }

    /// Register a runtime discovered by create/attach/inventory/reconciliation.
    /// Re-observing the same live id is stable; observing a new live id for the
    /// same durable locator advances the generation exactly once.
    pub fn register_initial(
        &self,
        locator: RuntimeLocator,
        runtime_id: impl Into<String>,
    ) -> RuntimeDescriptor {
        let runtime_id = runtime_id.into();
        let mut ownership = self.ownership.lock().expect("restart ownership lock");
        if let Some(existing) = ownership.by_locator.get(&locator) {
            if existing.runtime_id == runtime_id {
                return existing.clone();
            }
        }
        if let Some(existing) = ownership
            .descriptor_by_live
            .get(&(locator.kind, runtime_id.clone()))
            .cloned()
        {
            let live_key = (locator.kind, runtime_id.clone());
            if ownership.retired_live.contains(&live_key) {
                return existing;
            }
            let was_unbound = !ownership.locator_by_live.contains_key(&live_key);
            let existing = if was_unbound {
                let generation = ownership
                    .last_generation
                    .get(&locator)
                    .map_or(existing.generation, |generation| {
                        generation.saturating_add(1).max(existing.generation)
                    });
                let promoted = RuntimeDescriptor {
                    runtime_id: runtime_id.clone(),
                    generation,
                };
                ownership
                    .descriptor_by_live
                    .insert((locator.kind, runtime_id.clone()), promoted.clone());
                promoted
            } else {
                existing
            };
            let generation = ownership
                .last_generation
                .get(&locator)
                .copied()
                .unwrap_or_default()
                .max(existing.generation);
            Self::set_generation_locked(&mut ownership, locator.clone(), generation);
            Self::bind_locator_locked(&mut ownership, locator, runtime_id, existing.clone());
            Self::prune_ownership_locked(&mut ownership, self.ownership_limit);
            self.persist_or_log(&ownership, "bind_existing_runtime");
            return existing;
        }
        let generation = ownership
            .last_generation
            .get(&locator)
            .map_or(1, |generation| generation.saturating_add(1));
        let descriptor = RuntimeDescriptor {
            runtime_id: runtime_id.clone(),
            generation,
        };
        Self::bind_locator_locked(
            &mut ownership,
            locator.clone(),
            runtime_id,
            descriptor.clone(),
        );
        Self::set_generation_locked(&mut ownership, locator, generation);
        Self::prune_ownership_locked(&mut ownership, self.ownership_limit);
        self.persist_or_log(&ownership, "register_runtime");
        descriptor
    }

    fn bind_locator_locked(
        ownership: &mut RuntimeOwnership,
        locator: RuntimeLocator,
        runtime_id: String,
        descriptor: RuntimeDescriptor,
    ) {
        let live_key = (locator.kind, runtime_id.clone());
        if let Some(previous_locator) = ownership
            .locator_by_live
            .insert(live_key.clone(), locator.clone())
        {
            if previous_locator != locator
                && ownership
                    .by_locator
                    .get(&previous_locator)
                    .is_some_and(|current| current.runtime_id == runtime_id)
            {
                ownership.by_locator.remove(&previous_locator);
            }
        }
        if let Some(previous_runtime) = ownership.by_locator.insert(locator, descriptor.clone()) {
            if previous_runtime.runtime_id != runtime_id {
                let previous_key = (live_key.0, previous_runtime.runtime_id);
                ownership.locator_by_live.remove(&previous_key);
                ownership.retired_live.insert(previous_key);
            }
        }
        let bound_locator = ownership
            .locator_by_live
            .get(&live_key)
            .cloned()
            .expect("locator inserted above");
        Self::touch_key(&mut ownership.locator_order, &bound_locator);
        ownership.retired_live.remove(&live_key);
        ownership
            .descriptor_by_live
            .insert(live_key.clone(), descriptor);
        Self::touch_descriptor_locked(ownership, live_key);
    }

    /// Register a runtime that does not have a durable locator. This keeps the
    /// lifecycle contract fenced even for ordinary shell terminals, while a
    /// later durable observation can bind the same stable descriptor.
    pub fn register_live(
        &self,
        kind: AgentRuntimeKind,
        runtime_id: impl Into<String>,
    ) -> RuntimeDescriptor {
        let runtime_id = runtime_id.into();
        let mut ownership = self.ownership.lock().expect("restart ownership lock");
        let descriptor = ownership
            .descriptor_by_live
            .entry((kind, runtime_id.clone()))
            .or_insert_with(|| RuntimeDescriptor {
                runtime_id: runtime_id.clone(),
                generation: 1,
            })
            .clone();
        Self::touch_descriptor_locked(&mut ownership, (kind, runtime_id));
        Self::prune_ownership_locked(&mut ownership, self.ownership_limit);
        self.persist_or_log(&ownership, "register_unbound_runtime");
        descriptor
    }

    /// Descriptor lookup used to stamp runtime-addressed lifecycle surfaces.
    pub fn runtime_for_live(
        &self,
        kind: AgentRuntimeKind,
        runtime_id: &str,
    ) -> Option<RuntimeDescriptor> {
        let ownership = self.ownership.lock().expect("restart ownership lock");
        ownership
            .descriptor_by_live
            .get(&(kind, runtime_id.to_string()))
            .cloned()
    }

    pub fn runtime_for_locator(&self, locator: &RuntimeLocator) -> Option<RuntimeDescriptor> {
        self.ownership
            .lock()
            .expect("restart ownership lock")
            .by_locator
            .get(locator)
            .cloned()
    }

    fn adoptable_registered_replacement(
        &self,
        request: &AgentRestart,
        pending: &PendingRestartRecovery,
    ) -> Option<RuntimeDescriptor> {
        let ownership = self.ownership.lock().expect("restart ownership lock");
        let session_pending = ownership
            .pending_recoveries
            .values()
            .filter(|candidate| Self::same_durable_session(&candidate.request, request))
            .collect::<Vec<_>>();
        let replacement = ownership
            .by_locator
            .get(&RuntimeLocator::from_request(request))
            .filter(|current| {
                current.runtime_id != pending.old_runtime.runtime_id
                    && current.generation > pending.old_runtime.generation
                    && !session_pending
                        .iter()
                        .any(|candidate| candidate.old_runtime.runtime_id == current.runtime_id)
            })
            .cloned();
        let canonical = session_pending
            .iter()
            .max_by_key(|candidate| {
                (
                    candidate.old_runtime.generation,
                    candidate.request_id.as_str(),
                )
            })
            .is_some_and(|candidate| candidate.request_id == pending.request_id);
        if replacement.is_some()
            && (session_pending
                .iter()
                .any(|candidate| candidate.retirement_pending)
                || !canonical)
        {
            tracing::info!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                old_runtime_id = %pending.old_runtime.runtime_id,
                old_generation = pending.old_runtime.generation,
                "agent.restart.recovery.registered_replacement_waiting_for_retirement"
            );
            return None;
        }
        replacement
    }

    /// Stamp one typed lifecycle frame with this registry's descriptor. This
    /// is the single enrichment path used by handshake, direct terminal
    /// frames, registry fan-out, reconciliation, and fresh-agent broadcasts.
    pub fn observe_server_message(&self, message: &mut ServerMessage) {
        match message {
            ServerMessage::TerminalCreated(frame) => {
                frame.runtime = self.observe_terminal(
                    &frame.terminal_id,
                    frame.session_ref.as_ref(),
                    frame.runtime.as_ref(),
                );
            }
            ServerMessage::TerminalAttachReady(frame) => {
                frame.runtime = self.observe_terminal(
                    &frame.terminal_id,
                    frame.session_ref.as_ref(),
                    frame.runtime.as_ref(),
                );
            }
            ServerMessage::TerminalInventory(frame) => {
                for terminal in &mut frame.terminals {
                    terminal.runtime = self.observe_terminal(
                        &terminal.terminal_id,
                        terminal.session_ref.as_ref(),
                        terminal.runtime.as_ref(),
                    );
                }
            }
            ServerMessage::TerminalOutput(frame) => {
                frame.runtime = frame.runtime.clone().or_else(|| {
                    self.runtime_for_live(AgentRuntimeKind::Terminal, &frame.terminal_id)
                });
            }
            ServerMessage::TerminalOutputBatch(frame) => {
                frame.runtime = frame.runtime.clone().or_else(|| {
                    self.runtime_for_live(AgentRuntimeKind::Terminal, &frame.terminal_id)
                });
            }
            ServerMessage::TerminalOutputGap(frame) => {
                frame.runtime = frame.runtime.clone().or_else(|| {
                    self.runtime_for_live(AgentRuntimeKind::Terminal, &frame.terminal_id)
                });
            }
            ServerMessage::TerminalExit(frame) => {
                frame.runtime = frame.runtime.clone().or_else(|| {
                    self.runtime_for_live(AgentRuntimeKind::Terminal, &frame.terminal_id)
                });
            }
            ServerMessage::TerminalSessionAssociated(frame) => {
                let locator = RuntimeLocator::new(
                    AgentRuntimeKind::Terminal,
                    &frame.session_ref.provider,
                    &frame.session_ref.session_id,
                );
                frame.runtime = Some(self.register_initial(locator, &frame.terminal_id));
            }
            ServerMessage::FreshAgentCreated(frame) => {
                let locator = frame
                    .session_ref
                    .as_ref()
                    .map(|session| {
                        RuntimeLocator::new(
                            AgentRuntimeKind::FreshAgent,
                            &session.provider,
                            &session.session_id,
                        )
                    })
                    .unwrap_or_else(|| {
                        RuntimeLocator::new(
                            AgentRuntimeKind::FreshAgent,
                            &frame.provider,
                            &frame.session_id,
                        )
                    });
                frame.runtime = Some(match frame.runtime.as_ref() {
                    Some(runtime) => self.register_supplied(locator, runtime.clone()),
                    None => self.register_initial(
                        locator,
                        format!("fresh-runtime-{}", uuid::Uuid::new_v4()),
                    ),
                });
                if let Some(runtime) = frame.runtime.clone() {
                    let mut ownership = self.ownership.lock().expect("restart ownership lock");
                    Self::set_fresh_alias_locked(
                        &mut ownership,
                        (frame.provider.clone(), frame.session_id.clone()),
                        runtime,
                    );
                    Self::prune_ownership_locked(&mut ownership, self.ownership_limit);
                }
            }
            ServerMessage::FreshAgentSessionMaterialized(frame) => {
                let locator = frame
                    .session_ref
                    .as_ref()
                    .map(|session| {
                        RuntimeLocator::new(
                            AgentRuntimeKind::FreshAgent,
                            &session.provider,
                            &session.session_id,
                        )
                    })
                    .unwrap_or_else(|| {
                        RuntimeLocator::new(
                            AgentRuntimeKind::FreshAgent,
                            &frame.provider,
                            &frame.session_id,
                        )
                    });
                frame.runtime = Some(match frame.runtime.as_ref() {
                    Some(runtime) => self.register_supplied(locator, runtime.clone()),
                    None => self.register_initial(
                        locator,
                        format!("fresh-runtime-{}", uuid::Uuid::new_v4()),
                    ),
                });
                if let Some(runtime) = frame.runtime.clone() {
                    let mut ownership = self.ownership.lock().expect("restart ownership lock");
                    Self::set_fresh_alias_locked(
                        &mut ownership,
                        (frame.provider.clone(), frame.previous_session_id.clone()),
                        runtime.clone(),
                    );
                    Self::set_fresh_alias_locked(
                        &mut ownership,
                        (frame.provider.clone(), frame.session_id.clone()),
                        runtime,
                    );
                    Self::prune_ownership_locked(&mut ownership, self.ownership_limit);
                }
            }
            ServerMessage::FreshAgentEvent(frame) => {
                if frame.runtime.is_none() {
                    let alias = self
                        .ownership
                        .lock()
                        .expect("restart ownership lock")
                        .fresh_event_aliases
                        .get(&(frame.provider.clone(), frame.session_id.clone()))
                        .cloned();
                    frame.runtime = alias.or_else(|| {
                        self.runtime_for_locator(&RuntimeLocator::new(
                            AgentRuntimeKind::FreshAgent,
                            &frame.provider,
                            &frame.session_id,
                        ))
                    });
                }
            }
            ServerMessage::PaneReconcileResult(frame) => {
                for verdict in &mut frame.verdicts {
                    verdict.runtime = verdict.runtime.clone().or_else(|| {
                        if let Some(terminal_id) = verdict.terminal_id.as_deref() {
                            return self.observe_terminal(
                                terminal_id,
                                verdict.session_ref.as_ref(),
                                None,
                            );
                        }
                        verdict.session_ref.as_ref().and_then(|session| {
                            self.runtime_for_locator(&RuntimeLocator::new(
                                AgentRuntimeKind::FreshAgent,
                                &session.provider,
                                &session.session_id,
                            ))
                        })
                    });
                }
            }
            _ => {}
        }
    }

    /// Verify the descriptor portion of the `agentRestartV1` capability
    /// contract after [`Self::observe_server_message`] enrichment.
    ///
    /// Fields remain optional in the protocol types so a new v7 client can
    /// still parse an older v7 server. Once `ready.capabilities.agentRestartV1`
    /// is present, these runtime-addressed surfaces are required.
    pub fn restart_runtime_contract_satisfied(message: &ServerMessage) -> bool {
        match message {
            ServerMessage::TerminalCreated(frame) => frame.runtime.is_some(),
            ServerMessage::TerminalAttachReady(frame) => frame.runtime.is_some(),
            ServerMessage::TerminalInventory(frame) => frame
                .terminals
                .iter()
                .all(|terminal| terminal.runtime.is_some()),
            ServerMessage::TerminalOutput(frame) => frame.runtime.is_some(),
            ServerMessage::TerminalOutputBatch(frame) => frame.runtime.is_some(),
            ServerMessage::TerminalOutputGap(frame) => frame.runtime.is_some(),
            ServerMessage::TerminalExit(frame) => frame.runtime.is_some(),
            ServerMessage::TerminalSessionAssociated(frame) => frame.runtime.is_some(),
            ServerMessage::FreshAgentCreated(frame) => frame.runtime.is_some(),
            ServerMessage::FreshAgentEvent(frame) => {
                frame.runtime.is_some()
                    || frame.event.get("type").and_then(serde_json::Value::as_str)
                        == Some("freshAgent.error")
            }
            ServerMessage::FreshAgentSessionMaterialized(frame) => frame.runtime.is_some(),
            ServerMessage::PaneReconcileResult(frame) => frame.verdicts.iter().all(|verdict| {
                verdict.verdict != freshell_protocol::ReconcileVerdict::Attach
                    || verdict.runtime.is_some()
            }),
            _ => true,
        }
    }

    /// Enrich a pre-serialized broadcast frame when it belongs to the typed
    /// protocol. Unknown extension frames pass through byte-for-byte.
    pub fn observe_serialized(&self, json: &str) -> Option<String> {
        let Ok(envelope) = serde_json::from_str::<serde_json::Value>(json) else {
            return Some(json.to_string());
        };
        if !matches!(
            envelope.get("type").and_then(serde_json::Value::as_str),
            Some(
                "terminal.session.associated"
                    | "freshAgent.created"
                    | "freshAgent.event"
                    | "freshAgent.session.materialized"
            )
        ) {
            return Some(json.to_string());
        }
        let Ok(mut message) = serde_json::from_str::<ServerMessage>(json) else {
            return Some(json.to_string());
        };
        self.observe_server_message(&mut message);
        if !Self::restart_runtime_contract_satisfied(&message) {
            tracing::error!(
                message = ?message,
                "agent.restart.runtime_descriptor_contract.failed"
            );
            return None;
        }
        Some(serde_json::to_string(&message).unwrap_or_else(|_| json.to_string()))
    }

    pub fn register_supplied(
        &self,
        locator: RuntimeLocator,
        descriptor: RuntimeDescriptor,
    ) -> RuntimeDescriptor {
        let mut ownership = self.ownership.lock().expect("restart ownership lock");
        let last_generation = ownership
            .last_generation
            .get(&locator)
            .copied()
            .unwrap_or_default();
        if descriptor.generation < last_generation {
            return descriptor;
        }
        if descriptor.generation == last_generation
            && ownership
                .by_locator
                .get(&locator)
                .is_some_and(|current| current.runtime_id != descriptor.runtime_id)
        {
            return descriptor;
        }
        Self::set_generation_locked(&mut ownership, locator.clone(), descriptor.generation);
        Self::bind_locator_locked(
            &mut ownership,
            locator,
            descriptor.runtime_id.clone(),
            descriptor.clone(),
        );
        Self::prune_ownership_locked(&mut ownership, self.ownership_limit);
        self.persist_or_log(&ownership, "register_supplied_runtime");
        descriptor
    }

    fn observe_terminal(
        &self,
        terminal_id: &str,
        session_ref: Option<&freshell_protocol::SessionLocator>,
        supplied: Option<&RuntimeDescriptor>,
    ) -> Option<RuntimeDescriptor> {
        if let Some(runtime) = supplied {
            return Some(runtime.clone());
        }
        if let Some(runtime) = self.runtime_for_live(AgentRuntimeKind::Terminal, terminal_id) {
            return Some(runtime);
        }
        Some(if let Some(session_ref) = session_ref {
            self.register_initial(
                RuntimeLocator::new(
                    AgentRuntimeKind::Terminal,
                    &session_ref.provider,
                    &session_ref.session_id,
                ),
                terminal_id,
            )
        } else {
            self.register_live(AgentRuntimeKind::Terminal, terminal_id)
        })
    }

    /// Run or replay a transaction. Request-id and durable-locator locks close
    /// duplicate/overlap races without serializing unrelated providers or runtimes.
    pub async fn execute<R: RestartRuntime>(
        &self,
        request: AgentRestart,
        runtime: &R,
    ) -> RestartOutcome {
        self.execute_with_events(request, runtime, |_| {}).await
    }

    /// [`Self::execute`] with an event sink. `started` is delivered immediately
    /// after successful preflight and before shutdown; the terminal result is
    /// delivered only after it has been stored for reconnect replay.
    pub async fn execute_with_events<R, F>(
        &self,
        request: AgentRestart,
        runtime: &R,
        mut emit: F,
    ) -> RestartOutcome
    where
        R: RestartRuntime + ?Sized,
        F: FnMut(&ServerMessage),
    {
        let locator = RuntimeLocator::from_request(&request);
        let session_key = locator.session_key();
        let request_lock = self.request_lock(&request.request_id);
        let session_lock = self.session_lock(&session_key);
        let _retention_guard = LockRetentionGuard(self);
        let _request_guard = request_lock.lock_owned().await;
        let _session_guard = session_lock.lock_owned().await;

        let pending = self
            .ownership
            .lock()
            .expect("restart ownership lock")
            .pending_recoveries
            .get(&request.request_id)
            .cloned();
        if let Some(pending) = pending {
            if pending.request != request {
                let outcome = self.request_conflict(&request);
                emit(&outcome.messages[0]);
                return outcome;
            }
            if let Some(replacement) = self.adoptable_registered_replacement(&request, &pending) {
                return self
                    .adopt_pending_replacement_with_events(request, pending, replacement, emit)
                    .await;
            }
            return self
                .recover_pending_with_events(request, pending, runtime, emit)
                .await;
        }

        if let Some(outcome) = self.replay_or_conflict(&request) {
            for message in &outcome.messages {
                emit(message);
            }
            return outcome;
        }

        // A request id previously correlated as a follower has the same replay
        // and conflict semantics as the transaction owner's request id.
        let follower_pending = {
            let ownership = self.ownership.lock().expect("restart ownership lock");
            ownership.pending_recoveries.values().find_map(|pending| {
                pending
                    .followers
                    .iter()
                    .find(|follower| follower.request_id == request.request_id)
                    .map(|follower| (pending.clone(), follower.clone()))
            })
        };
        if let Some((pending, fingerprint)) = follower_pending {
            if fingerprint != request {
                let outcome = self.request_conflict(&request);
                emit(&outcome.messages[0]);
                return outcome;
            }
            if let Some(replacement) = self.adoptable_registered_replacement(&request, &pending) {
                return self
                    .adopt_pending_replacement_with_events(request, pending, replacement, emit)
                    .await;
            }
            return self
                .recover_pending_with_events(request, pending, runtime, emit)
                .await;
        }

        // Once the owner has retired the runtime, the canonical live locator
        // is intentionally absent. Correlate a distinct requester by its exact
        // old descriptor before ordinary RUNTIME_NOT_FOUND validation, persist
        // that correlation, and let either client drive recovery.
        let correlated_pending = {
            let ownership = self.ownership.lock().expect("restart ownership lock");
            ownership
                .pending_recoveries
                .values()
                .find(|pending| Self::same_restart_target(&pending.request, &request))
                .cloned()
        };
        if let Some(mut pending) = correlated_pending {
            let owner_request_id = pending.request_id.clone();
            if let Err(error) = self.try_update_ownership("join_pending_recovery", |ownership| {
                if let Some(canonical) = ownership.pending_recoveries.get_mut(&owner_request_id) {
                    if !canonical
                        .followers
                        .iter()
                        .any(|follower| follower.request_id == request.request_id)
                    {
                        // Followers are replay conveniences, not ownership
                        // authority. Keep the durable correlation window
                        // bounded just like terminal results so unique client
                        // request ids cannot inflate an unfinished journal.
                        if canonical.followers.len() >= self.ownership_limit {
                            canonical.followers.remove(0);
                        }
                        canonical.followers.push(request.clone());
                    }
                    pending = canonical.clone();
                }
            }) {
                let outcome =
                    self.persistence_failure_with_phase(&request, pending.old_runtime, error, true);
                emit(&outcome.messages[0]);
                return outcome;
            }
            return self
                .recover_pending_with_events(request, pending, runtime, emit)
                .await;
        }

        // A durable provider session is one writer across terminal and
        // fresh-agent kinds. Do not allow a different generation/kind to
        // start a second transaction while any recovery row still reserves
        // the session. Exact owner/follower retries were handled above.
        let reserved_by = {
            let ownership = self.ownership.lock().expect("restart ownership lock");
            ownership
                .pending_recoveries
                .values()
                .find(|pending| Self::same_durable_session(&pending.request, &request))
                .cloned()
        };
        if let Some(reserved_by) = reserved_by {
            let descriptor = RuntimeDescriptor {
                runtime_id: request.live_id.clone(),
                generation: request.expected_generation,
            };
            let failure = RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                format!(
                    "restart recovery {} still reserves this durable session",
                    reserved_by.request_id
                ),
                true,
            );
            let terminal = ServerMessage::AgentRestartFailed(
                self.failure_frame(&request, descriptor, &failure, true),
            );
            emit(&terminal);
            return RestartOutcome {
                messages: vec![terminal],
                replayed: false,
            };
        }

        // A distinct requester can race the transaction owner with the exact
        // same locator + old runtime generation. The locator lock intentionally
        // makes the follower wait for that one teardown/replacement. Once it
        // enters, adopt the owner's durable successful result under the
        // follower's own request id instead of misclassifying the now-replaced
        // generation as stale.
        if let Some(outcome) = self.join_completed_replacement(&request) {
            for message in &outcome.messages {
                emit(message);
            }
            return outcome;
        }

        let expected = RuntimeDescriptor {
            runtime_id: request.live_id.clone(),
            generation: request.expected_generation,
        };
        let current = self.runtime_for_locator(&locator);
        if current.as_ref() != Some(&expected) {
            let failure = if current.is_none() {
                RestartFailure::new(
                    AgentRestartFailureCode::RuntimeNotFound,
                    "live runtime was not found for the durable session",
                    false,
                )
            } else {
                RestartFailure::new(
                    AgentRestartFailureCode::StaleGeneration,
                    "live runtime generation no longer matches the restart request",
                    false,
                )
            };
            let outcome = self.store_failure(request, current.unwrap_or(expected), failure, false);
            emit(&outcome.messages[0]);
            return outcome;
        }

        // The critical safety ordering: no started event and no teardown until
        // the provider has proved that the durable conversation can resume.
        let plan = match runtime.preflight(&request).await {
            Ok(plan) => plan,
            Err(failure) => {
                let outcome = self.store_failure(request, expected, failure, false);
                emit(&outcome.messages[0]);
                return outcome;
            }
        };
        let resume_context = runtime.persisted_resume_context(&request, &plan);
        let retirement_fence = runtime.persisted_retirement_fence(&request, &plan);

        let started = ServerMessage::AgentRestartStarted(AgentRestartStarted {
            request_id: request.request_id.clone(),
            provider: request.provider.clone(),
            session_id: request.session_id.clone(),
            kind: request.kind,
            runtime: expected.clone(),
        });
        if let Err(error) = self.try_update_ownership("record_shutdown_pending", |ownership| {
            ownership.pending_recoveries.insert(
                request.request_id.clone(),
                PendingRestartRecovery {
                    request_id: request.request_id.clone(),
                    request: request.clone(),
                    followers: Vec::new(),
                    old_runtime: expected.clone(),
                    retirement_pending: true,
                    resume_context,
                    retirement_fence,
                    replacement_fence: None,
                    last_failure: None,
                },
            );
        }) {
            // Preflight may reserve provider-side state (notably the shared
            // OpenCode session). If the durable journal boundary cannot be
            // recorded, teardown must not begin and that non-destructive
            // reservation must be released before returning.
            runtime.abort_preflight(&request, &plan).await;
            let outcome = self.persistence_failure(&request, expected, error);
            emit(&outcome.messages[0]);
            return outcome;
        }
        tracing::info!(
            request_id = %request.request_id,
            provider = %request.provider,
            session_id = %request.session_id,
            runtime_id = %request.live_id,
            generation = request.expected_generation,
            "agent.restart.started"
        );
        emit(&started);

        if let Err(failure) = runtime.shutdown_for_restart(&request, &plan).await {
            tracing::warn!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                runtime_id = %expected.runtime_id,
                generation = expected.generation,
                code = ?failure.code,
                retryable = failure.retryable,
                error = %failure.message,
                "agent.restart.shutdown.failed"
            );
            let terminal = ServerMessage::AgentRestartFailed(self.failure_frame(
                &request,
                expected.clone(),
                &failure,
                failure.retryable,
            ));
            let persisted = if failure.retryable {
                self.try_update_ownership("record_retryable_shutdown_failure", |ownership| {
                    if let Some(recovery) =
                        ownership.pending_recoveries.get_mut(&request.request_id)
                    {
                        let ServerMessage::AgentRestartFailed(failed) = &terminal else {
                            unreachable!("shutdown failure frame")
                        };
                        recovery.last_failure = Some(failed.clone());
                    }
                })
            } else {
                self.try_update_ownership("store_failed_shutdown", |ownership| {
                    ownership.pending_recoveries.remove(&request.request_id);
                    self.insert_result_locked(ownership, &request, terminal.clone());
                })
            };
            let mut outcome = match persisted {
                Ok(()) => RestartOutcome {
                    messages: vec![terminal],
                    replayed: false,
                },
                Err(error) => self.persistence_failure_with_phase(&request, expected, error, true),
            };
            emit(&outcome.messages[0]);
            outcome.messages.insert(0, started);
            return outcome;
        }

        if let Err(error) = self.try_update_ownership("record_retirement_complete", |ownership| {
            if let Some(recovery) = ownership.pending_recoveries.get_mut(&request.request_id) {
                recovery.retirement_pending = false;
                recovery.last_failure = None;
            }
        }) {
            let mut outcome = self.persistence_failure_with_phase(&request, expected, error, true);
            emit(&outcome.messages[0]);
            outcome.messages.insert(0, started);
            return outcome;
        }

        let replacement_fence = match self.ensure_replacement_fence(&request.request_id, runtime) {
            Ok((fence, _already_persisted)) => fence,
            Err(error) => {
                let mut outcome =
                    self.persistence_failure_with_phase(&request, expected, error, true);
                emit(&outcome.messages[0]);
                outcome.messages.insert(0, started);
                return outcome;
            }
        };

        {
            let mut ownership = self.ownership.lock().expect("restart ownership lock");
            if ownership
                .by_locator
                .get(&locator)
                .is_some_and(|current| current == &expected)
            {
                ownership.by_locator.remove(&locator);
                ownership
                    .retired_live
                    .insert((request.kind, expected.runtime_id.clone()));
                ownership.locator_order.retain(|entry| entry != &locator);
            }
        }

        let replacement_id = match runtime
            .create_replacement_fenced(&request, plan, replacement_fence.as_ref())
            .await
        {
            Ok(runtime_id) => runtime_id,
            Err(failure) => {
                if failure.retryable {
                    tracing::warn!(
                        request_id = %request.request_id,
                        provider = %request.provider,
                        session_id = %request.session_id,
                        runtime_id = %expected.runtime_id,
                        generation = expected.generation,
                        code = ?failure.code,
                        retryable = true,
                        error = %failure.message,
                        "agent.restart.replacement.retryable_failure"
                    );
                    let failed = self.failure_frame(&request, expected.clone(), &failure, true);
                    let persisted = self.try_update_ownership(
                        "record_retryable_replacement_failure",
                        |ownership| {
                            if let Some(recovery) =
                                ownership.pending_recoveries.get_mut(&request.request_id)
                            {
                                recovery.last_failure = Some(failed.clone());
                            }
                        },
                    );
                    let mut outcome = match persisted {
                        Ok(()) => RestartOutcome {
                            messages: vec![ServerMessage::AgentRestartFailed(failed)],
                            replayed: false,
                        },
                        Err(error) => {
                            self.persistence_failure_with_phase(&request, expected, error, true)
                        }
                    };
                    emit(&outcome.messages[0]);
                    outcome.messages.insert(0, started);
                    return outcome;
                } else {
                    tracing::warn!(
                        request_id = %request.request_id,
                        provider = %request.provider,
                        session_id = %request.session_id,
                        runtime_id = %expected.runtime_id,
                        generation = expected.generation,
                        code = ?failure.code,
                        retryable = failure.retryable,
                        error = %failure.message,
                        "agent.restart.replacement.failed"
                    );
                    let terminal = self.failure_message(&request, expected.clone(), &failure);
                    let persisted = self.try_update_ownership(
                        "store_terminal_replacement_failure",
                        |ownership| {
                            ownership.pending_recoveries.remove(&request.request_id);
                            self.insert_result_locked(ownership, &request, terminal.clone());
                        },
                    );
                    let mut outcome = match persisted {
                        Ok(()) => RestartOutcome {
                            messages: vec![terminal],
                            replayed: false,
                        },
                        Err(error) => {
                            self.persistence_failure_with_phase(&request, expected, error, true)
                        }
                    };
                    emit(&outcome.messages[0]);
                    outcome.messages.insert(0, started);
                    return outcome;
                }
            }
        };
        if replacement_id == expected.runtime_id {
            let failure = RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "replacement did not produce a distinct live runtime",
                true,
            );
            tracing::warn!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                runtime_id = %expected.runtime_id,
                generation = expected.generation,
                code = ?failure.code,
                retryable = true,
                error = %failure.message,
                "agent.restart.replacement.retryable_failure"
            );
            let failed = self.failure_frame(&request, expected.clone(), &failure, true);
            let persisted =
                self.try_update_ownership("reject_reused_replacement_runtime", |ownership| {
                    if let Some(recovery) =
                        ownership.pending_recoveries.get_mut(&request.request_id)
                    {
                        recovery.last_failure = Some(failed.clone());
                    }
                });
            let mut outcome = match persisted {
                Ok(()) => RestartOutcome {
                    messages: vec![ServerMessage::AgentRestartFailed(failed)],
                    replayed: false,
                },
                Err(error) => self.persistence_failure_with_phase(&request, expected, error, true),
            };
            emit(&outcome.messages[0]);
            outcome.messages.insert(0, started);
            return outcome;
        }

        let (_replacement, terminal) =
            match self.commit_replacement(&request, &expected, replacement_id) {
                Ok(committed) => committed,
                Err(error) => {
                    let mut outcome =
                        self.persistence_failure_with_phase(&request, expected, error, true);
                    emit(&outcome.messages[0]);
                    outcome.messages.insert(0, started);
                    return outcome;
                }
            };
        emit(&terminal);
        RestartOutcome {
            messages: vec![started, terminal],
            replayed: false,
        }
    }

    fn same_restart_target(left: &AgentRestart, right: &AgentRestart) -> bool {
        left.provider == right.provider
            && left.session_id == right.session_id
            && left.kind == right.kind
            && left.live_id == right.live_id
            && left.expected_generation == right.expected_generation
    }

    fn same_durable_session(left: &AgentRestart, right: &AgentRestart) -> bool {
        left.provider == right.provider && left.session_id == right.session_id
    }

    fn ensure_replacement_fence<R: RestartRuntime + ?Sized>(
        &self,
        owner_request_id: &str,
        runtime: &R,
    ) -> std::io::Result<(Option<RestartReplacementFence>, bool)> {
        let existing = self
            .ownership
            .lock()
            .expect("restart ownership lock")
            .pending_recoveries
            .get(owner_request_id)
            .and_then(|pending| pending.replacement_fence.clone());
        if let Some(existing) = existing {
            return Ok((Some(existing), true));
        }
        if !runtime.requires_replacement_fence() {
            return Ok((None, false));
        }

        let fence = RestartReplacementFence {
            ownership_id: uuid::Uuid::new_v4().to_string(),
        };
        let persisted =
            self.try_update_ownership("record_replacement_spawn_fence", |ownership| {
                let pending = ownership
                    .pending_recoveries
                    .get_mut(owner_request_id)
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "pending restart disappeared before replacement fencing",
                        )
                    })?;
                if pending.replacement_fence.is_none() {
                    pending.replacement_fence = Some(fence.clone());
                }
                Ok::<_, std::io::Error>(pending.replacement_fence.clone())
            })??;
        Ok((persisted, false))
    }

    fn join_completed_replacement(&self, request: &AgentRestart) -> Option<RestartOutcome> {
        let joined = {
            let ownership = self.ownership.lock().expect("restart ownership lock");
            ownership.results.values().find_map(|stored| {
                if !Self::same_restart_target(&stored.fingerprint, request) {
                    return None;
                }
                match &stored.terminal {
                    ServerMessage::AgentRestartReplaced(replaced) => {
                        let mut correlated = replaced.clone();
                        correlated.request_id = request.request_id.clone();
                        Some(ServerMessage::AgentRestartReplaced(correlated))
                    }
                    _ => None,
                }
            })
        }?;

        if let Err(error) = self.try_update_ownership("join_completed_replacement", |ownership| {
            self.insert_result_locked(ownership, request, joined.clone());
        }) {
            return Some(self.persistence_failure_with_phase(
                request,
                RuntimeDescriptor {
                    runtime_id: request.live_id.clone(),
                    generation: request.expected_generation,
                },
                error,
                true,
            ));
        }
        tracing::info!(
            request_id = %request.request_id,
            provider = %request.provider,
            session_id = %request.session_id,
            old_runtime_id = %request.live_id,
            old_generation = request.expected_generation,
            "agent.restart.joined"
        );
        Some(RestartOutcome {
            messages: vec![joined],
            replayed: true,
        })
    }

    async fn recover_pending_with_events<R, F>(
        &self,
        request: AgentRestart,
        pending: PendingRestartRecovery,
        runtime: &R,
        mut emit: F,
    ) -> RestartOutcome
    where
        R: RestartRuntime + ?Sized,
        F: FnMut(&ServerMessage),
    {
        let started = ServerMessage::AgentRestartStarted(AgentRestartStarted {
            request_id: request.request_id.clone(),
            provider: request.provider.clone(),
            session_id: request.session_id.clone(),
            kind: request.kind,
            runtime: pending.old_runtime.clone(),
        });
        emit(&started);
        if pending.retirement_pending {
            if let Err(failure) = runtime
                .recover_persisted_retirement(
                    &request,
                    pending.resume_context.as_ref(),
                    pending.retirement_fence.as_ref(),
                )
                .await
            {
                tracing::warn!(
                    request_id = %request.request_id,
                    provider = %request.provider,
                    session_id = %request.session_id,
                    old_runtime_id = %pending.old_runtime.runtime_id,
                    old_generation = pending.old_runtime.generation,
                    code = ?failure.code,
                    retryable = failure.retryable,
                    error = %failure.message,
                    "agent.restart.retirement_recovery.failed"
                );
                let failed = self.failure_frame(
                    &request,
                    pending.old_runtime.clone(),
                    &failure,
                    failure.retryable,
                );
                let owner_request_id = pending.request_id.clone();
                let persisted = if failure.retryable {
                    self.try_update_ownership("record_retryable_retirement_failure", |ownership| {
                        if let Some(recovery) =
                            ownership.pending_recoveries.get_mut(&owner_request_id)
                        {
                            recovery.last_failure = Some(failed.clone());
                        }
                    })
                } else {
                    self.try_update_ownership("store_terminal_retirement_failure", |ownership| {
                        let correlated = ownership
                            .pending_recoveries
                            .remove(&owner_request_id)
                            .map(|recovery| {
                                std::iter::once(recovery.request)
                                    .chain(recovery.followers)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_else(|| vec![request.clone()]);
                        for correlated_request in correlated {
                            let mut correlated_failed = failed.clone();
                            correlated_failed.request_id = correlated_request.request_id.clone();
                            self.insert_result_locked(
                                ownership,
                                &correlated_request,
                                ServerMessage::AgentRestartFailed(correlated_failed),
                            );
                        }
                    })
                };
                let terminal = match persisted {
                    Ok(()) => ServerMessage::AgentRestartFailed(failed),
                    Err(error) => self
                        .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                        .messages
                        .remove(0),
                };
                emit(&terminal);
                return RestartOutcome {
                    messages: vec![started, terminal],
                    replayed: false,
                };
            }

            let owner_request_id = pending.request_id.clone();
            if let Err(error) =
                self.try_update_ownership("record_recovered_retirement_complete", |ownership| {
                    if let Some(recovery) = ownership.pending_recoveries.get_mut(&owner_request_id)
                    {
                        recovery.retirement_pending = false;
                        recovery.last_failure = None;
                    }
                })
            {
                let terminal = self
                    .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                    .messages
                    .remove(0);
                emit(&terminal);
                return RestartOutcome {
                    messages: vec![started, terminal],
                    replayed: false,
                };
            }
        }
        let (another_retirement_pending, is_canonical_replacement_owner) = {
            let ownership = self.ownership.lock().expect("restart ownership lock");
            let session_pending = ownership
                .pending_recoveries
                .values()
                .filter(|candidate| Self::same_durable_session(&candidate.request, &request))
                .collect::<Vec<_>>();
            let another_retirement_pending = session_pending
                .iter()
                .any(|candidate| candidate.retirement_pending);
            let is_canonical = session_pending
                .iter()
                .max_by_key(|candidate| {
                    (
                        candidate.old_runtime.generation,
                        candidate.request_id.as_str(),
                    )
                })
                .is_some_and(|candidate| candidate.request_id == pending.request_id);
            (another_retirement_pending, is_canonical)
        };
        if another_retirement_pending || !is_canonical_replacement_owner {
            if another_retirement_pending {
                tracing::info!(
                    request_id = %request.request_id,
                    provider = %request.provider,
                    session_id = %request.session_id,
                    old_runtime_id = %pending.old_runtime.runtime_id,
                    old_generation = pending.old_runtime.generation,
                    "agent.restart.recovery.registered_replacement_waiting_for_retirement"
                );
            } else {
                tracing::info!(
                    request_id = %request.request_id,
                    provider = %request.provider,
                    session_id = %request.session_id,
                    old_runtime_id = %pending.old_runtime.runtime_id,
                    old_generation = pending.old_runtime.generation,
                    "agent.restart.recovery.waiting_for_canonical_generation"
                );
            }
            let failure = RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                if another_retirement_pending {
                    "another predecessor retirement for this durable session is still pending"
                } else {
                    "a newer predecessor generation owns replacement recovery"
                },
                true,
            );
            let terminal = ServerMessage::AgentRestartFailed(self.failure_frame(
                &request,
                pending.old_runtime.clone(),
                &failure,
                true,
            ));
            emit(&terminal);
            return RestartOutcome {
                messages: vec![started, terminal],
                replayed: false,
            };
        }
        if let Some(replacement) = self
            .runtime_for_locator(&RuntimeLocator::from_request(&request))
            .filter(|current| {
                current.runtime_id != pending.old_runtime.runtime_id
                    && current.generation > pending.old_runtime.generation
            })
        {
            tracing::info!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                old_runtime_id = %pending.old_runtime.runtime_id,
                old_generation = pending.old_runtime.generation,
                runtime_id = %replacement.runtime_id,
                generation = replacement.generation,
                "agent.restart.recovery.adopting_registered_replacement_after_retirement"
            );
            let terminal = match self.commit_replacement(
                &request,
                &pending.old_runtime,
                replacement.runtime_id,
            ) {
                Ok((_replacement, terminal)) => terminal,
                Err(error) => {
                    let terminal = self
                        .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                        .messages
                        .remove(0);
                    emit(&terminal);
                    return RestartOutcome {
                        messages: vec![started, terminal],
                        replayed: false,
                    };
                }
            };
            emit(&terminal);
            return RestartOutcome {
                messages: vec![started, terminal],
                replayed: false,
            };
        }

        let (replacement_fence, fence_previously_persisted) =
            match self.ensure_replacement_fence(&pending.request_id, runtime) {
                Ok(fence) => fence,
                Err(error) => {
                    let terminal = self
                        .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                        .messages
                        .remove(0);
                    emit(&terminal);
                    return RestartOutcome {
                        messages: vec![started, terminal],
                        replayed: false,
                    };
                }
            };
        if fence_previously_persisted {
            if let Some(fence) = replacement_fence.as_ref() {
                if let Err(failure) = runtime
                    .recover_ambiguous_replacement(&request, pending.resume_context.as_ref(), fence)
                    .await
                {
                    let safe_failure = RestartFailure::new(
                        AgentRestartFailureCode::ShutdownFailed,
                        format!(
                            "ambiguous replacement ownership could not be quiesced: {}",
                            failure.message
                        ),
                        true,
                    );
                    let failed = self.failure_frame(
                        &request,
                        pending.old_runtime.clone(),
                        &safe_failure,
                        true,
                    );
                    let owner_request_id = pending.request_id.clone();
                    let persisted = self.try_update_ownership(
                        "record_ambiguous_replacement_quiesce_failure",
                        |ownership| {
                            if let Some(recovery) =
                                ownership.pending_recoveries.get_mut(&owner_request_id)
                            {
                                recovery.last_failure = Some(failed.clone());
                            }
                        },
                    );
                    let terminal = match persisted {
                        Ok(()) => ServerMessage::AgentRestartFailed(failed),
                        Err(error) => self
                            .persistence_failure_with_phase(
                                &request,
                                pending.old_runtime,
                                error,
                                true,
                            )
                            .messages
                            .remove(0),
                    };
                    emit(&terminal);
                    return RestartOutcome {
                        messages: vec![started, terminal],
                        replayed: false,
                    };
                }
            }
        }

        {
            let locator = RuntimeLocator::from_request(&request);
            let mut ownership = self.ownership.lock().expect("restart ownership lock");
            if ownership
                .by_locator
                .get(&locator)
                .is_some_and(|current| current == &pending.old_runtime)
            {
                ownership.by_locator.remove(&locator);
                ownership
                    .retired_live
                    .insert((request.kind, pending.old_runtime.runtime_id.clone()));
                ownership.locator_order.retain(|entry| entry != &locator);
            }
        }
        let replacement_id = match runtime
            .recover_replacement_fenced(
                &request,
                pending.resume_context.as_ref(),
                replacement_fence.as_ref(),
            )
            .await
        {
            Ok(runtime_id) => runtime_id,
            Err(failure) => {
                tracing::warn!(
                    request_id = %request.request_id,
                    provider = %request.provider,
                    session_id = %request.session_id,
                    old_runtime_id = %pending.old_runtime.runtime_id,
                    old_generation = pending.old_runtime.generation,
                    code = ?failure.code,
                    retryable = failure.retryable,
                    error = %failure.message,
                    "agent.restart.recovery.failed"
                );
                let failed = self.failure_frame(
                    &request,
                    pending.old_runtime.clone(),
                    &failure,
                    failure.retryable,
                );
                let persisted = if failure.retryable {
                    let owner_request_id = pending.request_id.clone();
                    self.try_update_ownership("record_retryable_recovery_failure", |ownership| {
                        if let Some(recovery) =
                            ownership.pending_recoveries.get_mut(&owner_request_id)
                        {
                            recovery.last_failure = Some(failed.clone());
                        }
                    })
                } else {
                    let owner_request_id = pending.request_id.clone();
                    self.try_update_ownership("store_terminal_recovery_failure", |ownership| {
                        let correlated = ownership
                            .pending_recoveries
                            .remove(&owner_request_id)
                            .map(|recovery| {
                                std::iter::once(recovery.request)
                                    .chain(recovery.followers)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_else(|| vec![request.clone()]);
                        for correlated_request in correlated {
                            let mut correlated_failed = failed.clone();
                            correlated_failed.request_id = correlated_request.request_id.clone();
                            self.insert_result_locked(
                                ownership,
                                &correlated_request,
                                ServerMessage::AgentRestartFailed(correlated_failed),
                            );
                        }
                    })
                };
                let terminal = match persisted {
                    Ok(()) => ServerMessage::AgentRestartFailed(failed),
                    Err(error) => self
                        .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                        .messages
                        .remove(0),
                };
                emit(&terminal);
                return RestartOutcome {
                    messages: vec![started, terminal],
                    replayed: false,
                };
            }
        };
        if replacement_id == pending.old_runtime.runtime_id {
            let failure = RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "replacement did not produce a distinct live runtime",
                true,
            );
            tracing::warn!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                old_runtime_id = %pending.old_runtime.runtime_id,
                old_generation = pending.old_runtime.generation,
                code = ?failure.code,
                retryable = true,
                error = %failure.message,
                "agent.restart.recovery.failed"
            );
            let failed = self.failure_frame(&request, pending.old_runtime.clone(), &failure, true);
            let owner_request_id = pending.request_id.clone();
            let persisted =
                self.try_update_ownership("reject_reused_recovery_runtime", |ownership| {
                    if let Some(recovery) = ownership.pending_recoveries.get_mut(&owner_request_id)
                    {
                        recovery.last_failure = Some(failed.clone());
                    }
                });
            let terminal = match persisted {
                Ok(()) => ServerMessage::AgentRestartFailed(failed),
                Err(error) => self
                    .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                    .messages
                    .remove(0),
            };
            emit(&terminal);
            return RestartOutcome {
                messages: vec![started, terminal],
                replayed: false,
            };
        }
        let terminal = match self.commit_replacement(&request, &pending.old_runtime, replacement_id)
        {
            Ok((_replacement, terminal)) => terminal,
            Err(error) => {
                let terminal = self
                    .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                    .messages
                    .remove(0);
                emit(&terminal);
                return RestartOutcome {
                    messages: vec![started, terminal],
                    replayed: false,
                };
            }
        };
        emit(&terminal);
        RestartOutcome {
            messages: vec![started, terminal],
            replayed: false,
        }
    }

    async fn adopt_pending_replacement_with_events<F>(
        &self,
        request: AgentRestart,
        pending: PendingRestartRecovery,
        replacement: RuntimeDescriptor,
        mut emit: F,
    ) -> RestartOutcome
    where
        F: FnMut(&ServerMessage),
    {
        let started = ServerMessage::AgentRestartStarted(AgentRestartStarted {
            request_id: request.request_id.clone(),
            provider: request.provider.clone(),
            session_id: request.session_id.clone(),
            kind: request.kind,
            runtime: pending.old_runtime.clone(),
        });
        tracing::info!(
            request_id = %request.request_id,
            provider = %request.provider,
            session_id = %request.session_id,
            old_runtime_id = %pending.old_runtime.runtime_id,
            old_generation = pending.old_runtime.generation,
            runtime_id = %replacement.runtime_id,
            generation = replacement.generation,
            "agent.restart.recovery.adopting_registered_replacement"
        );
        emit(&started);
        let terminal =
            match self.commit_replacement(&request, &pending.old_runtime, replacement.runtime_id) {
                Ok((_replacement, terminal)) => terminal,
                Err(error) => {
                    let terminal = self
                        .persistence_failure_with_phase(&request, pending.old_runtime, error, true)
                        .messages
                        .remove(0);
                    emit(&terminal);
                    return RestartOutcome {
                        messages: vec![started, terminal],
                        replayed: false,
                    };
                }
            };
        emit(&terminal);
        RestartOutcome {
            messages: vec![started, terminal],
            replayed: false,
        }
    }

    fn commit_replacement(
        &self,
        request: &AgentRestart,
        old_runtime: &RuntimeDescriptor,
        replacement_id: String,
    ) -> std::io::Result<(RuntimeDescriptor, ServerMessage)> {
        if replacement_id == old_runtime.runtime_id {
            return Err(std::io::Error::other(
                "replacement reported the retired runtime id",
            ));
        }
        let locator = RuntimeLocator::from_request(request);
        let replacement = {
            let ownership = self.ownership.lock().expect("restart ownership lock");
            let observed = ownership.by_locator.get(&locator).filter(|current| {
                current.runtime_id == replacement_id && current.generation > old_runtime.generation
            });
            observed.cloned().unwrap_or_else(|| RuntimeDescriptor {
                runtime_id: replacement_id.clone(),
                generation: ownership
                    .last_generation
                    .get(&locator)
                    .copied()
                    .unwrap_or(old_runtime.generation)
                    .max(old_runtime.generation)
                    .saturating_add(1),
            })
        };
        let terminal = ServerMessage::AgentRestartReplaced(AgentRestartReplaced {
            request_id: request.request_id.clone(),
            provider: request.provider.clone(),
            session_id: request.session_id.clone(),
            kind: request.kind,
            old_runtime: OldRuntimeDescriptor::from(old_runtime.clone()),
            runtime: replacement.clone(),
        });
        let committed = self.try_update_ownership("commit_replacement", |ownership| {
            if ownership.pending_recoveries.values().any(|pending| {
                pending.retirement_pending && Self::same_durable_session(&pending.request, request)
            }) {
                return false;
            }
            let pending_keys = ownership
                .pending_recoveries
                .iter()
                .filter(|(_, pending)| Self::same_durable_session(&pending.request, request))
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let mut correlated_requests = vec![(request.clone(), old_runtime.clone())];
            for key in pending_keys {
                if let Some(pending) = ownership.pending_recoveries.remove(&key) {
                    let pending_old_runtime = pending.old_runtime;
                    correlated_requests.push((pending.request, pending_old_runtime.clone()));
                    correlated_requests.extend(
                        pending
                            .followers
                            .into_iter()
                            .map(|follower| (follower, pending_old_runtime.clone())),
                    );
                }
            }
            correlated_requests.sort_by(|left, right| left.0.request_id.cmp(&right.0.request_id));
            correlated_requests.dedup_by(|left, right| left.0.request_id == right.0.request_id);

            let replacement_key = (request.kind, replacement.runtime_id.clone());
            ownership
                .descriptor_by_live
                .insert(replacement_key.clone(), replacement.clone());
            Self::touch_descriptor_locked(ownership, replacement_key);
            Self::set_generation_locked(ownership, locator.clone(), replacement.generation);
            Self::bind_locator_locked(
                ownership,
                locator,
                replacement.runtime_id.clone(),
                replacement.clone(),
            );
            for (correlated_request, correlated_old_runtime) in correlated_requests {
                let correlated_terminal = if correlated_request.kind == request.kind {
                    ServerMessage::AgentRestartReplaced(AgentRestartReplaced {
                        request_id: correlated_request.request_id.clone(),
                        provider: correlated_request.provider.clone(),
                        session_id: correlated_request.session_id.clone(),
                        kind: correlated_request.kind,
                        old_runtime: OldRuntimeDescriptor::from(correlated_old_runtime),
                        runtime: replacement.clone(),
                    })
                } else {
                    ServerMessage::AgentRestartFailed(AgentRestartFailed {
                        request_id: correlated_request.request_id.clone(),
                        provider: correlated_request.provider.clone(),
                        session_id: correlated_request.session_id.clone(),
                        kind: correlated_request.kind,
                        runtime: correlated_old_runtime,
                        code: AgentRestartFailureCode::ReplacementFailed,
                        message: format!(
                            "restart recovery was superseded by a {:?} replacement for the same durable session",
                            request.kind
                        ),
                        retryable: false,
                        recovery_pending: false,
                    })
                };
                self.insert_result_locked(ownership, &correlated_request, correlated_terminal);
            }
            Self::prune_ownership_locked(ownership, self.ownership_limit);
            true
        })?;
        if !committed {
            tracing::error!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                old_runtime_id = %old_runtime.runtime_id,
                old_generation = old_runtime.generation,
                "agent.restart.recovery.adoption_blocked_by_pending_retirement"
            );
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "replacement adoption is blocked until predecessor retirement completes",
            ));
        }
        tracing::info!(
            request_id = %request.request_id,
            provider = %request.provider,
            session_id = %request.session_id,
            runtime_id = %replacement.runtime_id,
            generation = replacement.generation,
            "agent.restart.replaced"
        );
        Ok((replacement, terminal))
    }

    fn failure_frame(
        &self,
        request: &AgentRestart,
        descriptor: RuntimeDescriptor,
        failure: &RestartFailure,
        recovery_pending: bool,
    ) -> AgentRestartFailed {
        AgentRestartFailed {
            request_id: request.request_id.clone(),
            provider: request.provider.clone(),
            session_id: request.session_id.clone(),
            kind: request.kind,
            runtime: descriptor,
            code: failure.code,
            message: failure.message.clone(),
            retryable: failure.retryable,
            recovery_pending,
        }
    }

    fn failure_message(
        &self,
        request: &AgentRestart,
        descriptor: RuntimeDescriptor,
        failure: &RestartFailure,
    ) -> ServerMessage {
        ServerMessage::AgentRestartFailed(self.failure_frame(request, descriptor, failure, false))
    }

    fn persistence_failure(
        &self,
        request: &AgentRestart,
        descriptor: RuntimeDescriptor,
        error: std::io::Error,
    ) -> RestartOutcome {
        self.persistence_failure_with_phase(request, descriptor, error, false)
    }

    fn persistence_failure_with_phase(
        &self,
        request: &AgentRestart,
        descriptor: RuntimeDescriptor,
        error: std::io::Error,
        recovery_pending: bool,
    ) -> RestartOutcome {
        RestartOutcome {
            messages: vec![ServerMessage::AgentRestartFailed(AgentRestartFailed {
                request_id: request.request_id.clone(),
                provider: request.provider.clone(),
                session_id: request.session_id.clone(),
                kind: request.kind,
                runtime: descriptor,
                code: AgentRestartFailureCode::PreflightFailed,
                message: format!("restart transaction could not be durably recorded: {error}"),
                retryable: true,
                recovery_pending,
            })],
            replayed: false,
        }
    }

    fn request_conflict(&self, request: &AgentRestart) -> RestartOutcome {
        let runtime = self
            .runtime_for_locator(&RuntimeLocator::from_request(request))
            .unwrap_or(RuntimeDescriptor {
                runtime_id: request.live_id.clone(),
                generation: request.expected_generation,
            });
        tracing::warn!(
            request_id = %request.request_id,
            provider = %request.provider,
            session_id = %request.session_id,
            kind = ?request.kind,
            "agent.restart.request_id_conflict"
        );
        RestartOutcome {
            messages: vec![ServerMessage::AgentRestartFailed(AgentRestartFailed {
                request_id: request.request_id.clone(),
                provider: request.provider.clone(),
                session_id: request.session_id.clone(),
                kind: request.kind,
                runtime,
                code: AgentRestartFailureCode::RequestIdConflict,
                message: "requestId was already used with a different restart fingerprint"
                    .to_string(),
                retryable: false,
                recovery_pending: false,
            })],
            replayed: true,
        }
    }

    fn replay_or_conflict(&self, request: &AgentRestart) -> Option<RestartOutcome> {
        let ownership = self.ownership.lock().expect("restart ownership lock");
        let stored = ownership.results.get(&request.request_id)?;
        if stored.fingerprint == *request {
            tracing::info!(
                request_id = %request.request_id,
                provider = %request.provider,
                session_id = %request.session_id,
                kind = ?request.kind,
                "agent.restart.replayed"
            );
            return Some(RestartOutcome {
                messages: vec![stored.terminal.clone()],
                replayed: true,
            });
        }
        drop(ownership);
        Some(self.request_conflict(request))
    }

    fn store_failure(
        &self,
        request: AgentRestart,
        descriptor: RuntimeDescriptor,
        failure: RestartFailure,
        replayed: bool,
    ) -> RestartOutcome {
        let terminal = self.failure_message(&request, descriptor.clone(), &failure);
        tracing::warn!(
            request_id = %request.request_id,
            provider = %request.provider,
            session_id = %request.session_id,
            code = ?failure.code,
            retryable = failure.retryable,
            "agent.restart.failed"
        );
        match self.try_update_ownership("store_terminal_failure", |ownership| {
            self.insert_result_locked(ownership, &request, terminal.clone());
        }) {
            Ok(()) => RestartOutcome {
                messages: vec![terminal],
                replayed,
            },
            Err(error) => self.persistence_failure(&request, descriptor, error),
        }
    }
}

#[derive(Clone)]
struct ProductionResumePlan {
    context: RestartResumeContext,
    retirement_fence: RestartRetirementFence,
    fresh_preflight_reservation: Option<String>,
}

/// Exact fresh-agent creation inputs captured while the selected runtime is
/// still live. The production implementation reads every field from the live
/// provider manager and only cross-checks the pane ledger; a nonfatal ledger
/// write failure can therefore never reset restart settings. Test adapters
/// provide the same contract without launching external providers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductionFreshResumePlan {
    pub session_type: freshell_protocol::SessionType,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox: Option<freshell_protocol::Sandbox>,
}

pub struct ProductionFreshPreflight {
    pub plan: ProductionFreshResumePlan,
    pub actions: Vec<RestartRetirementAction>,
    pub reservation_token: Option<String>,
}

/// Narrow production seam over the three fresh-agent runtime managers.
///
/// Keeping this seam at the adapter boundary lets integration tests exercise
/// the real [`ProductionRestartRuntime`] ordering and broadcast correlation
/// without launching external Claude, Codex, or OpenCode binaries.
#[async_trait::async_trait]
pub trait ProductionFreshRuntime: Send + Sync {
    async fn has_live_session(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
    ) -> bool;

    async fn shutdown_for_restart(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> bool;

    async fn shutdown_for_restart_detailed(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        if self
            .shutdown_for_restart(provider, session_id, expected_runtime_id)
            .await
        {
            freshell_freshagent::RestartShutdownOutcome::Stopped
        } else {
            freshell_freshagent::RestartShutdownOutcome::Stale
        }
    }

    async fn shutdown_reserved_for_restart_detailed(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        _reservation_token: Option<&str>,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        self.shutdown_for_restart_detailed(provider, session_id, expected_runtime_id)
            .await
    }

    async fn capture_resume_plan(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> Option<ProductionFreshResumePlan>;

    /// Atomically reserve a provider runtime for restart and capture every
    /// resume/retirement input that a mutating control could otherwise change.
    /// Providers without mutable cross-call capture state use the default.
    async fn reserve_restart_preflight(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        _reservation_token: &str,
    ) -> Result<ProductionFreshPreflight, String> {
        let plan = self
            .capture_resume_plan(provider, session_id, expected_runtime_id)
            .await
            .ok_or_else(|| "selected fresh-agent runtime settings are unavailable".to_string())?;
        let actions = self
            .capture_restart_actions(provider, session_id, expected_runtime_id)
            .await?;
        Ok(ProductionFreshPreflight {
            plan,
            actions,
            reservation_token: None,
        })
    }

    async fn release_restart_preflight(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
        _reservation_token: &str,
    ) {
    }

    /// Capture provider-specific retirement work while the exact runtime is
    /// still live. Test seams without an external writer default to an empty
    /// action set; the real WS state overrides every supported provider.
    async fn capture_restart_actions(
        &self,
        _provider: freshell_protocol::AgentProvider,
        _session_id: &str,
        _expected_runtime_id: &str,
    ) -> Result<Vec<RestartRetirementAction>, String> {
        Ok(Vec::new())
    }

    /// Cross-boot OpenCode recovery cannot consult the originating process's
    /// sessions map. Abort the exact persisted remote id through the shared
    /// serve manager instead.
    async fn recover_opencode_remote_abort(
        &self,
        _session_id: &str,
        _cwd: Option<&str>,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete {
            message: "OpenCode boot-recovery abort is unavailable".to_string(),
        }
    }

    async fn handle_create(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
    );

    async fn handle_create_fenced(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
        _replacement_ownership_id: Option<&str>,
    ) {
        self.handle_create(provider, create).await;
    }
}

struct WsStateFreshRuntime {
    state: crate::WsState,
}

fn provider_name(provider: freshell_protocol::AgentProvider) -> &'static str {
    match provider {
        freshell_protocol::AgentProvider::Claude => "claude",
        freshell_protocol::AgentProvider::Codex => "codex",
        freshell_protocol::AgentProvider::Opencode => "opencode",
        freshell_protocol::AgentProvider::Amplifier => "amplifier",
    }
}

fn session_type_name(session_type: freshell_protocol::SessionType) -> &'static str {
    match session_type {
        freshell_protocol::SessionType::Freshclaude => "freshclaude",
        freshell_protocol::SessionType::Freshcodex => "freshcodex",
        freshell_protocol::SessionType::Kilroy => "kilroy",
        freshell_protocol::SessionType::Freshopencode => "freshopencode",
    }
}

#[async_trait::async_trait]
impl ProductionFreshRuntime for WsStateFreshRuntime {
    async fn has_live_session(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
    ) -> bool {
        match provider {
            freshell_protocol::AgentProvider::Claude => {
                self.state.fresh_claude.has_live_session(session_id).await
            }
            freshell_protocol::AgentProvider::Codex => {
                self.state.fresh_codex.has_live_session(session_id).await
            }
            freshell_protocol::AgentProvider::Opencode => {
                self.state.fresh_opencode.has_live_session(session_id).await
            }
            freshell_protocol::AgentProvider::Amplifier => false,
        }
    }

    async fn shutdown_for_restart(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> bool {
        self.shutdown_for_restart_detailed(provider, session_id, expected_runtime_id)
            .await
            == freshell_freshagent::RestartShutdownOutcome::Stopped
    }

    async fn shutdown_for_restart_detailed(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        match provider {
            freshell_protocol::AgentProvider::Claude => {
                self.state
                    .fresh_claude
                    .shutdown_for_restart_detailed(session_id, expected_runtime_id)
                    .await
            }
            freshell_protocol::AgentProvider::Codex => {
                self.state
                    .fresh_codex
                    .shutdown_for_restart_detailed(session_id, expected_runtime_id)
                    .await
            }
            freshell_protocol::AgentProvider::Opencode => {
                self.state
                    .fresh_opencode
                    .shutdown_for_restart_detailed(session_id, expected_runtime_id)
                    .await
            }
            freshell_protocol::AgentProvider::Amplifier => {
                freshell_freshagent::RestartShutdownOutcome::Stale
            }
        }
    }

    async fn shutdown_reserved_for_restart_detailed(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        reservation_token: Option<&str>,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        match (provider, reservation_token) {
            (freshell_protocol::AgentProvider::Opencode, Some(token)) => {
                self.state
                    .fresh_opencode
                    .shutdown_reserved_for_restart_detailed(session_id, expected_runtime_id, token)
                    .await
            }
            _ => {
                self.shutdown_for_restart_detailed(provider, session_id, expected_runtime_id)
                    .await
            }
        }
    }

    async fn capture_resume_plan(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> Option<ProductionFreshResumePlan> {
        // The live provider manager is authoritative. Pane-ledger writes are
        // intentionally nonfatal at create/send time, so reconstructing from a
        // missing row would silently replace a real model/cwd/security policy
        // with defaults during restart.
        let live = match provider {
            freshell_protocol::AgentProvider::Claude => {
                self.state
                    .fresh_claude
                    .capture_restart_resume_plan(session_id, expected_runtime_id)
                    .await?
            }
            freshell_protocol::AgentProvider::Codex => {
                self.state
                    .fresh_codex
                    .capture_restart_resume_plan(session_id, expected_runtime_id)
                    .await?
            }
            freshell_protocol::AgentProvider::Opencode => {
                self.state
                    .fresh_opencode
                    .capture_restart_resume_plan(session_id, expected_runtime_id)
                    .await?
            }
            freshell_protocol::AgentProvider::Amplifier => return None,
        };
        let binding = self
            .state
            .pane_ledger
            .load_binding(provider_name(provider), session_id);
        if let Some(binding) = binding.as_ref() {
            let settings = &live.settings;
            if binding.mode != session_type_name(live.session_type)
                || binding.cwd != settings.cwd
                || binding.model != settings.model
                || binding.effort != settings.effort
                || binding.permission_mode != settings.permission_mode
                || binding.sandbox != settings.sandbox
            {
                tracing::warn!(
                    provider = provider_name(provider),
                    session_id,
                    live_session_type = session_type_name(live.session_type),
                    ledger_mode = %binding.mode,
                    "agent.restart.preflight.ledger_settings_stale"
                );
            }
        } else {
            tracing::warn!(
                provider = provider_name(provider),
                session_id,
                "agent.restart.preflight.ledger_settings_missing_using_live_authority"
            );
        }
        let sandbox = match live.settings.sandbox.as_deref() {
            None => None,
            Some("read-only") => Some(freshell_protocol::Sandbox::ReadOnly),
            Some("workspace-write") => Some(freshell_protocol::Sandbox::WorkspaceWrite),
            Some("danger-full-access") => Some(freshell_protocol::Sandbox::DangerFullAccess),
            Some(value) => {
                tracing::error!(
                    provider = provider_name(provider),
                    session_id,
                    sandbox = value,
                    "agent.restart.preflight.invalid_fresh_sandbox"
                );
                return None;
            }
        };
        Some(ProductionFreshResumePlan {
            session_type: live.session_type,
            cwd: live.settings.cwd,
            model: live.settings.model,
            effort: live.settings.effort,
            permission_mode: live.settings.permission_mode,
            sandbox,
        })
    }

    async fn reserve_restart_preflight(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        reservation_token: &str,
    ) -> Result<ProductionFreshPreflight, String> {
        if provider != freshell_protocol::AgentProvider::Opencode {
            let plan = self
                .capture_resume_plan(provider, session_id, expected_runtime_id)
                .await
                .ok_or_else(|| {
                    "selected fresh-agent runtime settings are unavailable".to_string()
                })?;
            let actions = self
                .capture_restart_actions(provider, session_id, expected_runtime_id)
                .await?;
            return Ok(ProductionFreshPreflight {
                plan,
                actions,
                reservation_token: None,
            });
        }

        let (live, remote) = self
            .state
            .fresh_opencode
            .reserve_restart_preflight(session_id, expected_runtime_id, reservation_token)
            .await?;
        Ok(ProductionFreshPreflight {
            plan: ProductionFreshResumePlan {
                session_type: live.session_type,
                cwd: live.settings.cwd,
                model: live.settings.model,
                effort: live.settings.effort,
                permission_mode: live.settings.permission_mode,
                sandbox: None,
            },
            actions: remote
                .map(|(session_id, cwd)| {
                    vec![RestartRetirementAction::OpenCodeRemoteAbort { session_id, cwd }]
                })
                .unwrap_or_default(),
            reservation_token: Some(reservation_token.to_string()),
        })
    }

    async fn release_restart_preflight(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
        reservation_token: &str,
    ) {
        if provider == freshell_protocol::AgentProvider::Opencode {
            self.state
                .fresh_opencode
                .release_restart_preflight(session_id, expected_runtime_id, reservation_token)
                .await;
        }
    }

    async fn capture_restart_actions(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
        expected_runtime_id: &str,
    ) -> Result<Vec<RestartRetirementAction>, String> {
        match provider {
            freshell_protocol::AgentProvider::Claude => self
                .state
                .fresh_claude
                .capture_restart_process_barrier(session_id, expected_runtime_id)
                .await
                .map(|barrier| vec![RestartRetirementAction::ProcessTree { barrier }])
                .ok_or_else(|| {
                    "selected Claude runtime disappeared before retirement fence capture"
                        .to_string()
                }),
            freshell_protocol::AgentProvider::Codex => self
                .state
                .fresh_codex
                .capture_restart_process_barrier(session_id, expected_runtime_id)
                .await
                .map(|barrier| vec![RestartRetirementAction::ProcessTree { barrier }])
                .ok_or_else(|| {
                    "selected Codex runtime disappeared before retirement fence capture".to_string()
                }),
            freshell_protocol::AgentProvider::Opencode => {
                let remote = self
                    .state
                    .fresh_opencode
                    .capture_restart_remote_abort(session_id, expected_runtime_id)
                    .await?;
                Ok(remote
                    .map(|(session_id, cwd)| {
                        vec![RestartRetirementAction::OpenCodeRemoteAbort { session_id, cwd }]
                    })
                    .unwrap_or_default())
            }
            freshell_protocol::AgentProvider::Amplifier => {
                Err("Amplifier has no fresh-agent restart runtime".to_string())
            }
        }
    }

    async fn recover_opencode_remote_abort(
        &self,
        session_id: &str,
        cwd: Option<&str>,
    ) -> freshell_freshagent::RestartShutdownOutcome {
        self.state
            .fresh_opencode
            .recover_restart_remote_abort(session_id, cwd)
            .await
    }

    async fn handle_create(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
    ) {
        match provider {
            freshell_protocol::AgentProvider::Claude => {
                self.state.fresh_claude.handle_create(create).await
            }
            freshell_protocol::AgentProvider::Codex => {
                self.state.fresh_codex.handle_create(create).await
            }
            freshell_protocol::AgentProvider::Opencode => {
                self.state.fresh_opencode.handle_create(create).await
            }
            freshell_protocol::AgentProvider::Amplifier => {}
        }
    }

    async fn handle_create_fenced(
        &self,
        provider: freshell_protocol::AgentProvider,
        create: freshell_protocol::FreshAgentCreate,
        replacement_ownership_id: Option<&str>,
    ) {
        match (provider, replacement_ownership_id) {
            (freshell_protocol::AgentProvider::Claude, Some(ownership_id)) => {
                self.state
                    .fresh_claude
                    .handle_create_for_restart(create, ownership_id)
                    .await
            }
            (freshell_protocol::AgentProvider::Codex, Some(ownership_id)) => {
                self.state
                    .fresh_codex
                    .handle_create_for_restart(create, ownership_id)
                    .await
            }
            _ => self.handle_create(provider, create).await,
        }
    }
}

/// Production adapter that deliberately delegates to the same built-in
/// terminal restore and fresh-agent resume paths used by ordinary clients.
pub struct ProductionRestartRuntime {
    state: crate::WsState,
    plans: Mutex<HashMap<String, ProductionResumePlan>>,
    fresh_runtime: Arc<dyn ProductionFreshRuntime>,
}

impl ProductionRestartRuntime {
    pub fn new(state: crate::WsState) -> Self {
        let fresh_runtime = Arc::new(WsStateFreshRuntime {
            state: state.clone(),
        });
        Self::with_fresh_runtime(state, fresh_runtime)
    }

    /// Construct the production adapter around a faithful fresh-runtime seam.
    /// Production uses [`Self::new`]; integration tests inject deterministic
    /// managers while preserving the adapter's real preflight, teardown,
    /// resume request, broadcast correlation, and generation commit paths.
    pub fn with_fresh_runtime(
        state: crate::WsState,
        fresh_runtime: Arc<dyn ProductionFreshRuntime>,
    ) -> Self {
        Self {
            state,
            plans: Mutex::new(HashMap::new()),
            fresh_runtime,
        }
    }

    fn provider(
        request: &AgentRestart,
    ) -> Result<
        (
            freshell_protocol::AgentProvider,
            freshell_protocol::SessionType,
        ),
        RestartFailure,
    > {
        match request.provider.as_str() {
            "claude" => Ok((
                freshell_protocol::AgentProvider::Claude,
                freshell_protocol::SessionType::Freshclaude,
            )),
            "codex" => Ok((
                freshell_protocol::AgentProvider::Codex,
                freshell_protocol::SessionType::Freshcodex,
            )),
            "opencode" => Ok((
                freshell_protocol::AgentProvider::Opencode,
                freshell_protocol::SessionType::Freshopencode,
            )),
            "amplifier" if request.kind == AgentRuntimeKind::Terminal => Ok((
                freshell_protocol::AgentProvider::Amplifier,
                freshell_protocol::SessionType::Freshclaude,
            )),
            _ => Err(RestartFailure::new(
                AgentRestartFailureCode::Unresumable,
                format!(
                    "{} is not an approved built-in provider for {:?} restart",
                    request.provider, request.kind
                ),
                false,
            )),
        }
    }

    fn validate_durable(&self, request: &AgentRestart) -> Result<(), RestartFailure> {
        use crate::existence::SessionExistence;
        match self
            .state
            .session_existence
            .exists(&request.provider, &request.session_id)
        {
            SessionExistence::Present => Ok(()),
            SessionExistence::Unknown => Err(RestartFailure::new(
                AgentRestartFailureCode::PreflightFailed,
                "session index is still warming; retry restart shortly",
                true,
            )),
            SessionExistence::Absent | SessionExistence::ProviderUnavailable => {
                Err(RestartFailure::new(
                    AgentRestartFailureCode::Unresumable,
                    "durable session is unavailable",
                    false,
                ))
            }
        }
    }

    async fn fresh_is_live(
        &self,
        provider: freshell_protocol::AgentProvider,
        session_id: &str,
    ) -> bool {
        self.fresh_runtime
            .has_live_session(provider, session_id)
            .await
    }

    async fn create_fresh_replacement(
        &self,
        request: &AgentRestart,
        provider: freshell_protocol::AgentProvider,
        plan: &RestartResumeContext,
        replacement_fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        let create_request_id = format!("agent-restart:{}", request.request_id);
        let mut receiver = self.state.broadcast_tx.subscribe();
        let create = freshell_protocol::FreshAgentCreate {
            request_id: create_request_id.clone(),
            session_type: plan.fresh_session_type.ok_or_else(|| {
                RestartFailure::new(
                    AgentRestartFailureCode::ReplacementFailed,
                    "fresh-agent restart plan omitted its runtime flavour",
                    false,
                )
            })?,
            cwd: plan.fresh_cwd.clone(),
            effort: plan.fresh_effort.clone(),
            legacy_restore_context: None,
            model: plan.fresh_model.clone(),
            model_selection: None,
            permission_mode: plan.fresh_permission_mode.clone(),
            plugins: None,
            provider: Some(provider),
            resume_session_id: Some(request.session_id.clone()),
            sandbox: plan.fresh_sandbox,
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: request.provider.clone(),
                session_id: request.session_id.clone(),
            }),
        };
        self.fresh_runtime
            .handle_create_fenced(
                provider,
                create,
                replacement_fence.map(|fence| fence.ownership_id.as_str()),
            )
            .await;
        let result_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let frame = tokio::time::timeout_at(result_deadline, receiver.recv())
                .await
                .map_err(|_| {
                    RestartFailure::new(
                        AgentRestartFailureCode::ReplacementFailed,
                        "fresh-agent replacement did not report a result",
                        true,
                    )
                })?
                .map_err(|error| {
                    RestartFailure::new(
                        AgentRestartFailureCode::ReplacementFailed,
                        format!("fresh-agent replacement result was lost: {error}"),
                        true,
                    )
                })?;
            let Ok(message) = serde_json::from_str::<ServerMessage>(&frame) else {
                continue;
            };
            match message {
                ServerMessage::FreshAgentCreated(created)
                    if created.request_id == create_request_id =>
                {
                    let runtime_id = created
                        .runtime
                        .map(|runtime| runtime.runtime_id)
                        .ok_or_else(|| {
                            RestartFailure::new(
                                AgentRestartFailureCode::ReplacementFailed,
                                "fresh-agent replacement omitted its runtime descriptor",
                                true,
                            )
                        })?;
                    if runtime_id == request.live_id
                        || !self.fresh_is_live(provider, &request.session_id).await
                    {
                        return Err(RestartFailure::new(
                            AgentRestartFailureCode::ReplacementFailed,
                            "fresh-agent replacement did not become a distinct live runtime",
                            true,
                        ));
                    }
                    return Ok(runtime_id);
                }
                ServerMessage::FreshAgentCreateFailed(failed)
                    if failed.request_id == create_request_id =>
                {
                    return Err(RestartFailure::new(
                        AgentRestartFailureCode::ReplacementFailed,
                        failed.message,
                        failed.retryable.unwrap_or(false),
                    ));
                }
                _ => {}
            }
        }
    }

    async fn create_from_builtin_path(
        &self,
        request: &AgentRestart,
        context: RestartResumeContext,
        replacement_fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        let (provider, _) = Self::provider(request)?;
        match request.kind {
            AgentRuntimeKind::Terminal => crate::terminal::create_terminal_replacement(
                &self.state,
                request,
                context.terminal_cwd.clone(),
                freshell_terminal::TerminalRestartLaunch {
                    shell: context
                        .terminal_shell
                        .unwrap_or(freshell_protocol::Shell::System),
                    permission_mode: context.terminal_permission_mode.clone(),
                    model: context.terminal_model.clone(),
                    sandbox: context.terminal_sandbox.clone(),
                    codex_managed: context.terminal_codex_managed,
                },
                replacement_fence.map(|fence| fence.ownership_id.clone()),
            )
            .await
            .map_err(|message| {
                RestartFailure::new(AgentRestartFailureCode::ReplacementFailed, message, true)
            }),
            AgentRuntimeKind::FreshAgent => {
                self.create_fresh_replacement(request, provider, &context, replacement_fence)
                    .await
            }
        }
    }
}

#[async_trait::async_trait]
impl RestartRuntime for ProductionRestartRuntime {
    type ResumePlan = ();

    async fn preflight(&self, request: &AgentRestart) -> Result<(), RestartFailure> {
        let (provider, _) = Self::provider(request)?;
        self.validate_durable(request)?;
        let (context, actions, fresh_preflight_reservation) = match request.kind {
            AgentRuntimeKind::Terminal => {
                let probe = self.state.registry.probe(&request.live_id).ok_or_else(|| {
                    RestartFailure::new(
                        AgentRestartFailureCode::RuntimeNotFound,
                        "selected terminal is no longer live",
                        false,
                    )
                })?;
                let root_pid = self
                    .state
                    .registry
                    .pid_of(&request.live_id)
                    .ok_or_else(|| {
                        RestartFailure::new(
                            AgentRestartFailureCode::RuntimeNotFound,
                            "selected terminal no longer owns a live process",
                            false,
                        )
                    })?;
                if probe.mode != request.provider {
                    return Err(RestartFailure::new(
                        AgentRestartFailureCode::StaleGeneration,
                        "selected terminal provider does not match restart request",
                        false,
                    ));
                }
                if !self
                    .state
                    .cli_commands
                    .iter()
                    .any(|spec| spec.name == request.provider)
                {
                    return Err(RestartFailure::new(
                        AgentRestartFailureCode::Unresumable,
                        "built-in terminal provider is not installed",
                        false,
                    ));
                }
                let launch = probe.restart_launch.ok_or_else(|| {
                    RestartFailure::new(
                        AgentRestartFailureCode::PreflightFailed,
                        "selected terminal is missing its authoritative restart settings",
                        false,
                    )
                })?;
                let mut actions = vec![RestartRetirementAction::ProcessTree {
                    barrier:
                        freshell_codex::transport::OwnedProcessTreeBarrier::capture_process_group(
                            root_pid,
                        ),
                }];
                if launch.codex_managed == Some(true) {
                    let managed_barrier =
                        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                            .capture_terminal_restart_barrier(&request.live_id)
                            .await
                            .map_err(|message| {
                                RestartFailure::new(
                                    AgentRestartFailureCode::PreflightFailed,
                                    format!(
                                        "managed Codex retirement fence capture failed: {message}"
                                    ),
                                    true,
                                )
                            })?
                            .ok_or_else(|| {
                                RestartFailure::new(
                                    AgentRestartFailureCode::PreflightFailed,
                                    "managed Codex app-server ownership is unavailable",
                                    true,
                                )
                            })?;
                    actions.push(RestartRetirementAction::ProcessTree {
                        barrier: managed_barrier,
                    });
                }
                (
                    RestartResumeContext {
                        terminal_cwd: probe.cwd,
                        terminal_shell: Some(launch.shell),
                        terminal_permission_mode: launch.permission_mode,
                        terminal_model: launch.model,
                        terminal_sandbox: launch.sandbox,
                        terminal_codex_managed: launch.codex_managed,
                        ..RestartResumeContext::default()
                    },
                    actions,
                    None,
                )
            }
            AgentRuntimeKind::FreshAgent => {
                if !self.fresh_is_live(provider, &request.session_id).await {
                    return Err(RestartFailure::new(
                        AgentRestartFailureCode::RuntimeNotFound,
                        "selected fresh-agent runtime is no longer live",
                        false,
                    ));
                }
                let reservation_token = format!("restart-preflight:{}", request.request_id);
                let preflight = self
                    .fresh_runtime
                    .reserve_restart_preflight(
                        provider,
                        &request.session_id,
                        &request.live_id,
                        &reservation_token,
                    )
                    .await
                    .map_err(|message| {
                        RestartFailure::new(AgentRestartFailureCode::PreflightFailed, message, true)
                    })?;
                let plan = preflight.plan;
                (
                    RestartResumeContext {
                        fresh_session_type: Some(plan.session_type),
                        fresh_cwd: plan.cwd,
                        fresh_model: plan.model,
                        fresh_effort: plan.effort,
                        fresh_permission_mode: plan.permission_mode,
                        fresh_sandbox: plan.sandbox,
                        ..RestartResumeContext::default()
                    },
                    preflight.actions,
                    preflight.reservation_token,
                )
            }
        };
        let retirement_fence = RestartRetirementFence {
            origin_boot_id: self.state.boot_id.as_ref().clone(),
            actions,
        };
        let inserted = {
            let mut plans = self.plans.lock().expect("production restart plans");
            if plans.len() >= DEFAULT_RESTART_LOCK_LIMIT {
                let evictable = plans
                    .iter()
                    .find(|(_, plan)| plan.fresh_preflight_reservation.is_none())
                    .map(|(request_id, _)| request_id.clone());
                if let Some(request_id) = evictable {
                    plans.remove(&request_id);
                }
            }
            if plans.len() >= DEFAULT_RESTART_LOCK_LIMIT {
                false
            } else {
                plans.insert(
                    request.request_id.clone(),
                    ProductionResumePlan {
                        context,
                        retirement_fence,
                        fresh_preflight_reservation: fresh_preflight_reservation.clone(),
                    },
                );
                true
            }
        };
        if !inserted {
            if let Some(token) = fresh_preflight_reservation.as_deref() {
                self.fresh_runtime
                    .release_restart_preflight(
                        provider,
                        &request.session_id,
                        &request.live_id,
                        token,
                    )
                    .await;
            }
            return Err(RestartFailure::new(
                AgentRestartFailureCode::PreflightFailed,
                "restart preflight capacity is exhausted",
                true,
            ));
        }
        Ok(())
    }

    async fn abort_preflight(&self, request: &AgentRestart, _plan: &()) {
        let reservation = self
            .plans
            .lock()
            .expect("production restart plans")
            .remove(&request.request_id)
            .and_then(|plan| plan.fresh_preflight_reservation);
        let Some(token) = reservation else {
            return;
        };
        let Ok((provider, _)) = Self::provider(request) else {
            return;
        };
        self.fresh_runtime
            .release_restart_preflight(provider, &request.session_id, &request.live_id, &token)
            .await;
    }

    async fn shutdown_for_restart(
        &self,
        request: &AgentRestart,
        _plan: &(),
    ) -> Result<(), RestartFailure> {
        let (provider, _) = Self::provider(request)?;
        match request.kind {
            AgentRuntimeKind::Terminal => {
                match crate::terminal::shutdown_terminal_for_restart(&self.state, &request.live_id)
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        return Err(RestartFailure::new(
                            AgentRestartFailureCode::StaleGeneration,
                            "selected terminal disappeared before shutdown",
                            false,
                        ));
                    }
                    Err(message) => {
                        return Err(RestartFailure::new(
                            AgentRestartFailureCode::ShutdownFailed,
                            message,
                            true,
                        ));
                    }
                }
            }
            AgentRuntimeKind::FreshAgent => {
                let reservation = self
                    .plans
                    .lock()
                    .expect("production restart plans")
                    .get(&request.request_id)
                    .and_then(|plan| plan.fresh_preflight_reservation.clone());
                let outcome = self
                    .fresh_runtime
                    .shutdown_reserved_for_restart_detailed(
                        provider,
                        &request.session_id,
                        &request.live_id,
                        reservation.as_deref(),
                    )
                    .await;
                match outcome {
                    freshell_freshagent::RestartShutdownOutcome::Stopped => {}
                    freshell_freshagent::RestartShutdownOutcome::Stale => {
                        return Err(RestartFailure::new(
                            AgentRestartFailureCode::StaleGeneration,
                            "selected fresh-agent runtime changed before shutdown",
                            false,
                        ));
                    }
                    freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete {
                        message,
                    } => {
                        return Err(RestartFailure::new(
                            AgentRestartFailureCode::ShutdownFailed,
                            message,
                            true,
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    async fn create_replacement(
        &self,
        request: &AgentRestart,
        _plan: (),
    ) -> Result<String, RestartFailure> {
        let plan = self
            .plans
            .lock()
            .expect("production restart plans")
            .remove(&request.request_id)
            .ok_or_else(|| {
                RestartFailure::new(
                    AgentRestartFailureCode::ReplacementFailed,
                    "restart resume plan disappeared before replacement",
                    true,
                )
            })?;
        self.create_from_builtin_path(request, plan.context, None)
            .await
    }

    fn requires_replacement_fence(&self) -> bool {
        true
    }

    async fn create_replacement_fenced(
        &self,
        request: &AgentRestart,
        _plan: (),
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        let fence = fence.ok_or_else(|| {
            RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "durable replacement ownership fence is unavailable",
                true,
            )
        })?;
        let plan = self
            .plans
            .lock()
            .expect("production restart plans")
            .remove(&request.request_id)
            .ok_or_else(|| {
                RestartFailure::new(
                    AgentRestartFailureCode::ReplacementFailed,
                    "restart resume plan disappeared before replacement",
                    true,
                )
            })?;
        self.create_from_builtin_path(request, plan.context, Some(fence))
            .await
    }

    fn persisted_resume_context(
        &self,
        request: &AgentRestart,
        _plan: &(),
    ) -> Option<RestartResumeContext> {
        self.plans
            .lock()
            .expect("production restart plans")
            .get(&request.request_id)
            .map(|plan| plan.context.clone())
    }

    fn persisted_retirement_fence(
        &self,
        request: &AgentRestart,
        _plan: &(),
    ) -> Option<RestartRetirementFence> {
        self.plans
            .lock()
            .expect("production restart plans")
            .get(&request.request_id)
            .map(|plan| plan.retirement_fence.clone())
    }

    async fn recover_replacement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
    ) -> Result<String, RestartFailure> {
        Self::provider(request)?;
        self.validate_durable(request)?;
        self.create_from_builtin_path(
            request,
            context.cloned().ok_or_else(|| {
                RestartFailure::new(
                    AgentRestartFailureCode::ReplacementFailed,
                    "persisted restart resume plan is unavailable",
                    false,
                )
            })?,
            None,
        )
        .await
    }

    async fn recover_ambiguous_replacement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: &RestartReplacementFence,
    ) -> Result<(), RestartFailure> {
        Self::provider(request)?;
        match request.kind {
            AgentRuntimeKind::Terminal => {
                let mut barrier =
                    freshell_codex::transport::OwnedProcessTreeBarrier::capture_by_ownership(
                        RESTART_REPLACEMENT_OWNERSHIP_ENV,
                        &fence.ownership_id,
                    );
                if barrier.terminate_and_confirm().await {
                    Ok(())
                } else {
                    Err(RestartFailure::new(
                        AgentRestartFailureCode::ShutdownFailed,
                        "ambiguous terminal replacement process tree is not confirmed quiescent",
                        true,
                    ))
                }
            }
            AgentRuntimeKind::FreshAgent if request.provider == "opencode" => {
                match self
                    .fresh_runtime
                    .recover_opencode_remote_abort(
                        &request.session_id,
                        context.and_then(|context| context.fresh_cwd.as_deref()),
                    )
                    .await
                {
                    freshell_freshagent::RestartShutdownOutcome::Stopped => Ok(()),
                    freshell_freshagent::RestartShutdownOutcome::Stale => Err(RestartFailure::new(
                        AgentRestartFailureCode::ShutdownFailed,
                        "ambiguous OpenCode replacement could not be confirmed aborted",
                        true,
                    )),
                    freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete {
                        message,
                    } => Err(RestartFailure::new(
                        AgentRestartFailureCode::ShutdownFailed,
                        message,
                        true,
                    )),
                }
            }
            AgentRuntimeKind::FreshAgent => {
                let mut barrier =
                    freshell_codex::transport::OwnedProcessTreeBarrier::capture_by_ownership(
                        RESTART_REPLACEMENT_OWNERSHIP_ENV,
                        &fence.ownership_id,
                    );
                if barrier.terminate_and_confirm().await {
                    Ok(())
                } else {
                    Err(RestartFailure::new(
                        AgentRestartFailureCode::ShutdownFailed,
                        "ambiguous fresh-agent replacement process tree is not confirmed quiescent",
                        true,
                    ))
                }
            }
        }
    }

    async fn recover_replacement_fenced(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: Option<&RestartReplacementFence>,
    ) -> Result<String, RestartFailure> {
        Self::provider(request)?;
        self.validate_durable(request)?;
        let fence = fence.ok_or_else(|| {
            RestartFailure::new(
                AgentRestartFailureCode::ReplacementFailed,
                "durable replacement ownership fence is unavailable",
                true,
            )
        })?;
        self.create_from_builtin_path(
            request,
            context.cloned().ok_or_else(|| {
                RestartFailure::new(
                    AgentRestartFailureCode::ReplacementFailed,
                    "persisted restart resume plan is unavailable",
                    false,
                )
            })?,
            Some(fence),
        )
        .await
    }

    async fn recover_retirement(
        &self,
        request: &AgentRestart,
        _context: Option<&RestartResumeContext>,
    ) -> Result<(), RestartFailure> {
        // Production teardown owns a quarantined, runtime-fenced retirement;
        // it does not need to re-run live preflight after destructive removal.
        self.shutdown_for_restart(request, &()).await
    }

    async fn recover_persisted_retirement(
        &self,
        request: &AgentRestart,
        context: Option<&RestartResumeContext>,
        fence: Option<&RestartRetirementFence>,
    ) -> Result<(), RestartFailure> {
        let fence = fence.ok_or_else(|| {
            RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                "persisted predecessor retirement fence is unavailable; refusing to create a competing writer",
                true,
            )
        })?;
        if fence.origin_boot_id == self.state.boot_id.as_ref().as_str() {
            return self.recover_retirement(request, context).await;
        }

        let process_action_count = fence
            .actions
            .iter()
            .filter(|action| matches!(action, RestartRetirementAction::ProcessTree { .. }))
            .count();
        let required_process_actions = match request.kind {
            AgentRuntimeKind::Terminal => {
                if context.and_then(|context| context.terminal_codex_managed) == Some(true) {
                    2
                } else {
                    1
                }
            }
            AgentRuntimeKind::FreshAgent if request.provider == "claude" => 1,
            AgentRuntimeKind::FreshAgent if request.provider == "codex" => 1,
            AgentRuntimeKind::FreshAgent if request.provider == "opencode" => 0,
            AgentRuntimeKind::FreshAgent => 1,
        };
        if process_action_count < required_process_actions {
            return Err(RestartFailure::new(
                AgentRestartFailureCode::ShutdownFailed,
                format!(
                    "persisted predecessor retirement fence is incomplete \
                     (expected at least {required_process_actions} local process barriers, \
                     found {process_action_count}); refusing replacement"
                ),
                true,
            ));
        }

        for action in &fence.actions {
            match action {
                RestartRetirementAction::ProcessTree { barrier } => {
                    let mut barrier = barrier.clone();
                    if !barrier.terminate_and_confirm().await {
                        return Err(RestartFailure::new(
                            AgentRestartFailureCode::ShutdownFailed,
                            "persisted predecessor process tree is not yet confirmed quiescent",
                            true,
                        ));
                    }
                }
                RestartRetirementAction::OpenCodeRemoteAbort { session_id, cwd } => {
                    match self
                        .fresh_runtime
                        .recover_opencode_remote_abort(session_id, cwd.as_deref())
                        .await
                    {
                        freshell_freshagent::RestartShutdownOutcome::Stopped => {}
                        freshell_freshagent::RestartShutdownOutcome::Stale => {
                            return Err(RestartFailure::new(
                                AgentRestartFailureCode::ShutdownFailed,
                                format!(
                                    "persisted OpenCode predecessor {session_id} could not be \
                                     confirmed aborted"
                                ),
                                true,
                            ));
                        }
                        freshell_freshagent::RestartShutdownOutcome::RetirementIncomplete {
                            message,
                        } => {
                            return Err(RestartFailure::new(
                                AgentRestartFailureCode::ShutdownFailed,
                                message,
                                true,
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

impl freshell_freshagent::FreshRuntimeRegistry for RestartCoordinator {
    fn register_runtime(
        &self,
        provider: &str,
        durable_session_id: &str,
        live_runtime_id: &str,
    ) -> RuntimeDescriptor {
        self.register_initial(
            RuntimeLocator::new(AgentRuntimeKind::FreshAgent, provider, durable_session_id),
            live_runtime_id,
        )
    }
}

fn atomic_write_restart_journal(
    destination: &Path,
    temporary: &Path,
    bytes: &[u8],
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        atomic_write_restart_journal_with_parent_sync(destination, temporary, bytes, |parent| {
            std::fs::File::open(parent)?.sync_all()
        })
    }
    #[cfg(not(unix))]
    {
        atomic_write_restart_journal_with_parent_sync(destination, temporary, bytes, |_parent| {
            Ok(())
        })
    }
}

fn atomic_write_restart_journal_with_parent_sync(
    destination: &Path,
    temporary: &Path,
    bytes: &[u8],
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::io::Write;

    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "restart journal destination has no parent: {}",
                destination.display()
            ),
        )
    })?;
    if temporary.parent() != Some(parent) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "restart journal temporary file must be a sibling of the destination",
        ));
    }
    std::fs::create_dir_all(parent)?;

    let write_result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(temporary, destination)?;
        sync_parent(parent)
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    write_result
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn parent_directory_sync_failure_after_rename_is_propagated() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("restart-transactions.json");
        let temporary = temp.path().join("restart-transactions.test-tmp");

        let error = atomic_write_restart_journal_with_parent_sync(
            &destination,
            &temporary,
            br#"{"generations":[],"results":[],"pendingRecoveries":[]}"#,
            |_parent| Err(std::io::Error::other("injected directory sync failure")),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "injected directory sync failure");
        assert!(
            destination.exists(),
            "the injected failure occurs after the atomic rename"
        );
        assert!(
            !temporary.exists(),
            "no staging file survives a post-rename directory sync failure"
        );
    }

    struct HistoricalRecoveryRuntime {
        retirements: std::sync::Mutex<Vec<String>>,
        replacements: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl RestartRuntime for HistoricalRecoveryRuntime {
        type ResumePlan = ();

        async fn preflight(&self, _request: &AgentRestart) -> Result<(), RestartFailure> {
            panic!("boot recovery must use its persisted recovery seams")
        }

        async fn shutdown_for_restart(
            &self,
            _request: &AgentRestart,
            _plan: &(),
        ) -> Result<(), RestartFailure> {
            panic!("boot recovery must not use ordinary shutdown")
        }

        async fn create_replacement(
            &self,
            _request: &AgentRestart,
            _plan: (),
        ) -> Result<String, RestartFailure> {
            panic!("boot recovery must use recover_replacement")
        }

        async fn recover_persisted_retirement(
            &self,
            request: &AgentRestart,
            _context: Option<&RestartResumeContext>,
            _fence: Option<&RestartRetirementFence>,
        ) -> Result<(), RestartFailure> {
            self.retirements
                .lock()
                .unwrap()
                .push(request.live_id.clone());
            Ok(())
        }

        async fn recover_replacement(
            &self,
            request: &AgentRestart,
            _context: Option<&RestartResumeContext>,
        ) -> Result<String, RestartFailure> {
            self.replacements.fetch_add(1, Ordering::SeqCst);
            Ok(format!("replacement-for-{}", request.live_id))
        }
    }

    fn historical_request(
        request_id: &str,
        kind: AgentRuntimeKind,
        live_id: &str,
        generation: u64,
    ) -> AgentRestart {
        AgentRestart {
            request_id: request_id.to_string(),
            provider: "claude".to_string(),
            session_id: "durable-shared".to_string(),
            kind,
            live_id: live_id.to_string(),
            expected_generation: generation,
        }
    }

    #[tokio::test]
    async fn historical_cross_kind_pending_rows_retire_all_predecessors_before_one_replacement() {
        let coordinator = RestartCoordinator::new();
        let older = historical_request("historical-a", AgentRuntimeKind::Terminal, "term-a", 1);
        let newer = historical_request("historical-b", AgentRuntimeKind::FreshAgent, "fresh-b", 2);
        {
            let mut ownership = coordinator.ownership.lock().unwrap();
            for request in [&older, &newer] {
                ownership.pending_recoveries.insert(
                    request.request_id.clone(),
                    PendingRestartRecovery {
                        request_id: request.request_id.clone(),
                        request: request.clone(),
                        followers: Vec::new(),
                        old_runtime: RuntimeDescriptor {
                            runtime_id: request.live_id.clone(),
                            generation: request.expected_generation,
                        },
                        retirement_pending: true,
                        resume_context: None,
                        retirement_fence: None,
                        replacement_fence: None,
                        last_failure: None,
                    },
                );
            }
        }
        let runtime = Arc::new(HistoricalRecoveryRuntime {
            retirements: std::sync::Mutex::new(Vec::new()),
            replacements: AtomicUsize::new(0),
        });
        let _registration = coordinator.set_runtime(runtime.clone());

        coordinator.recover_pending_registered(|_| {}).await;

        let mut retired = runtime.retirements.lock().unwrap().clone();
        retired.sort();
        assert_eq!(retired, vec!["fresh-b", "term-a"]);
        assert_eq!(runtime.replacements.load(Ordering::SeqCst), 1);
        assert!(coordinator.pending_recoveries().is_empty());

        let older_replay = coordinator.execute(older.clone(), runtime.as_ref()).await;
        assert!(older_replay.replayed);
        assert!(matches!(
            older_replay.messages.as_slice(),
            [ServerMessage::AgentRestartFailed(failed)]
                if failed.request_id == older.request_id
                    && failed.kind == AgentRuntimeKind::Terminal
                    && failed.runtime.runtime_id == older.live_id
                    && failed.code == AgentRestartFailureCode::ReplacementFailed
                    && !failed.retryable
                    && !failed.recovery_pending
        ));

        let newer_replay = coordinator.execute(newer.clone(), runtime.as_ref()).await;
        assert!(newer_replay.replayed);
        assert!(matches!(
            newer_replay.messages.as_slice(),
            [ServerMessage::AgentRestartReplaced(replaced)]
                if replaced.request_id == newer.request_id
                    && replaced.old_runtime.old_runtime_id == newer.live_id
                    && replaced.runtime.runtime_id == "replacement-for-fresh-b"
        ));
    }
}

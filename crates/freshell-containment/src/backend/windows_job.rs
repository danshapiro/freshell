//! Windows Job Object backend (`windows-job`, full).
//!
//! One Job Object per unit (`Local\freshell-unit-<id>`) with
//! `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`: the design-decision run (GitHub
//! Actions run 38013473744, `tests/windows_decisions.rs`) showed that a
//! non-detached Node grandchild stays in such a job, so everything a Node
//! launcher (`codex.js`) starts is contained, while Codex's managed daemon
//! and its updater, which Codex starts with explicit breakaway, leave it and
//! are never members. Members are placed race-free by the self-assigning
//! `__unit-exec --job <name>` shim, which joins the job before it starts
//! anything. A server that dies without its graceful shutdown closes its job
//! handles, and kill-on-close ends every member.
//!
//! One completion port serves every unit, read by one `freshell-job-port`
//! thread blocked in `GetQueuedCompletionStatus` (event-driven, no polling).
//! Its messages are hints whose delivery is not guaranteed, so Gone rests on
//! the screen and main process handles. Microsoft documents that nested jobs
//! (libuv's per-`node.exe` job, Codex's per-command jobs) post their zero
//! messages to every port up their job chain, under the unit's own key
//! (the `windows-2022` runner showed none, see
//! `tests/windows_job.rs`), so a zero message counts as "unit empty" only
//! when the unit job's own active process count reads 0.
//!
//! A stop that spares Codex daemon-family members (each judged by its own
//! command line, plus their descendants) clears kill-on-close, so the spared
//! outlive the unit's job handle, and ends the other members one by one.
//! From then on every non-spared member is recorded as a root in the unit
//! record (the job's members at the clearing, then each new member; exited
//! ones are dropped), so a server that crashes before Gone leaves a record
//! through which the next boot reaches them by identity.
//!
//! A unit reopened from its record (a stop a crashed server left
//! unfinished) has no job: its members are the record's identity-verified
//! roots that still run plus their descendants, reached by handle.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use tokio::sync::watch;
use windows_sys::Win32::Foundation::{
    SetLastError, BOOL, ERROR_ALREADY_EXISTS, ERROR_MORE_DATA, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::SystemServices::{
    JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS, JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO,
    JOB_OBJECT_MSG_EXIT_PROCESS, JOB_OBJECT_MSG_NEW_PROCESS,
};
use windows_sys::Win32::System::Threading::{
    TerminateProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatus, PostQueuedCompletionStatus, OVERLAPPED,
};

use super::{
    spared_closure, Backend, BackendKind, Capability, KillSummary, MemberList, UnitBackend,
    UnitObserver,
};
use crate::containment::ShimCommand;
use crate::proc_watch::{ProcWatch, Sig};
use crate::process::{self, ProcIdentity};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

/// The unit job's limits (branch A of the design decision).
const UNIT_JOB_LIMITS: u32 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
/// The completion key that tells the port thread to end (units use 1..).
const QUIT_KEY: usize = 0;

fn job_name(id: &UnitId) -> String {
    format!("Local\\freshell-unit-{}", id.as_str())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Locks ignoring poisoning (a panicking caller never disables a unit).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) struct JobBackend {
    /// The member exec shim; `Err` when no shim was given and this
    /// executable's path cannot be read (placement then fails).
    shim: Result<ShimCommand, String>,
    /// `None` when the completion port or its thread could not be created:
    /// units then have no emptiness event (the sweep's bound still holds).
    port: Option<Arc<PortOwner>>,
    port_error: Option<String>,
}

impl JobBackend {
    /// `shim = None` places members through this executable's own
    /// `__unit-exec` (the server's production shim).
    pub(crate) fn new(shim: Option<&ShimCommand>) -> Self {
        let shim = match shim {
            Some(shim) => Ok(shim.clone()),
            None => std::env::current_exe()
                .map(|exe| ShimCommand {
                    exe,
                    leading_args: vec!["__unit-exec".to_string()],
                })
                .map_err(|err| format!("cannot find this executable for the unit shim: {err}")),
        };
        let (port, port_error) = match Port::start() {
            Ok(port) => (Some(port), None),
            Err(err) => (None, Some(format!("no job completion port: {err}"))),
        };
        Self {
            shim,
            port,
            port_error,
        }
    }
}

impl Backend for JobBackend {
    fn capability(&self) -> Capability {
        Capability {
            kind: BackendKind::WindowsJob,
            full: true,
            reason: self.port_error.clone(),
        }
    }

    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(JobUnit::create(
            id,
            self.shim.clone(),
            self.port.clone(),
        )?))
    }

    fn reopen(&self, _id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(RecordedUnit))
    }
}

/// The completion port every unit job posts to.
struct Port {
    handle: OwnedHandle,
    units: Mutex<HashMap<usize, Weak<UnitShared>>>,
    next_key: AtomicUsize,
}

/// Owners of the port (the backend and every unit): the last one to go
/// tells the port thread to end; the port closes when the thread lets go.
struct PortOwner(Arc<Port>);

impl Drop for PortOwner {
    fn drop(&mut self) {
        // SAFETY: a live port; a message with no OVERLAPPED.
        unsafe {
            PostQueuedCompletionStatus(
                self.0.handle.as_raw_handle(),
                0,
                QUIT_KEY,
                std::ptr::null_mut(),
            )
        };
    }
}

impl Port {
    fn start() -> io::Result<Arc<PortOwner>> {
        // SAFETY: a new completion port not tied to any file.
        let raw =
            unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh handle this call owns exclusively.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let port = Arc::new(Port {
            handle,
            units: Mutex::new(HashMap::new()),
            next_key: AtomicUsize::new(QUIT_KEY + 1),
        });
        let for_thread = port.clone();
        std::thread::Builder::new()
            .name("freshell-job-port".into())
            .spawn(move || for_thread.run())?;
        Ok(Arc::new(PortOwner(port)))
    }

    /// The port thread: one blocking `GetQueuedCompletionStatus` per message.
    fn run(&self) {
        loop {
            let (mut msg, mut key) = (0u32, 0usize);
            let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
            // SAFETY: a live port and valid out-pointers.
            let ok = unsafe {
                GetQueuedCompletionStatus(
                    self.handle.as_raw_handle(),
                    &mut msg,
                    &mut key,
                    &mut overlapped,
                    INFINITE,
                )
            };
            if ok == 0 {
                tracing::error!(target: "freshell_unit",
                    event = "containment.job_port_failed",
                    error = %io::Error::last_os_error(),
                    "the job completion port failed: units have no emptiness event from now on");
                return;
            }
            if key == QUIT_KEY {
                return;
            }
            let unit = lock(&self.units).get(&key).and_then(Weak::upgrade);
            let Some(unit) = unit else {
                continue; // a unit already released
            };
            // Process messages carry the pid in the OVERLAPPED pointer.
            let pid = overlapped as usize as u32;
            match msg {
                JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO => unit.confirm_zero(),
                JOB_OBJECT_MSG_NEW_PROCESS => unit.joined(pid),
                JOB_OBJECT_MSG_EXIT_PROCESS | JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS => {
                    unit.left(pid)
                }
                _ => {}
            }
        }
    }
}

/// The part of a unit the port thread works on.
struct UnitShared {
    /// The unit's job; `None` once `remove` closed it.
    job: Mutex<Option<OwnedHandle>>,
    /// Bumped each time a zero message is confirmed by an active process
    /// count of 0.
    empty: watch::Sender<u64>,
    state: Mutex<MemberState>,
}

#[derive(Default)]
struct MemberState {
    /// Kill-on-close was cleared: members are recorded and ended one by one.
    per_member: bool,
    /// Daemon-family members (and their descendants) known to be spared.
    spared: HashSet<u32>,
    observer: Option<Arc<dyn UnitObserver>>,
}

impl UnitShared {
    fn with_job<T>(&self, f: impl FnOnce(HANDLE) -> io::Result<T>) -> io::Result<T> {
        match lock(&self.job).as_ref() {
            Some(job) => f(job.as_raw_handle()),
            None => Err(io::Error::other("the unit's job was released")),
        }
    }

    fn active_processes(&self) -> io::Result<u32> {
        self.with_job(|job| {
            // SAFETY: an all-zero accounting block is valid.
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            // SAFETY: a live job and a correctly sized information block.
            let ok = unsafe {
                QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    std::ptr::from_mut(&mut info).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(info.ActiveProcesses)
        })
    }

    /// A zero message under this unit's key: the unit is empty only when its
    /// own job's active process count reads 0 (nested jobs post theirs here
    /// too).
    fn confirm_zero(&self) {
        if matches!(self.active_processes(), Ok(0)) {
            self.empty.send_modify(|n| *n += 1);
        }
    }

    /// A process joined the job. Once kill-on-close is cleared, a
    /// daemon-family process (by its own command line) or a child of a
    /// spared one is spared, and any other is recorded as a root.
    fn joined(&self, pid: u32) {
        if !lock(&self.state).per_member {
            return;
        }
        let family = process::argv(pid).is_ok_and(|argv| process::is_codex_daemon_family(&argv));
        let parent = process::parent(pid);
        let observer = {
            let mut state = lock(&self.state);
            if family || parent.is_some_and(|p| state.spared.contains(&p)) {
                state.spared.insert(pid);
                return;
            }
            state.observer.clone()
        };
        if let (Some(observer), Ok(start)) = (observer, process::start_time(pid)) {
            observer.record_root(pid, start);
        }
    }

    /// A process left the job (it exited): its recorded root goes.
    fn left(&self, pid: u32) {
        let observer = {
            let mut state = lock(&self.state);
            if !state.per_member {
                return;
            }
            state.spared.remove(&pid);
            state.observer.clone()
        };
        if let Some(observer) = observer {
            observer.forget_root(pid);
        }
    }
}

pub(crate) struct JobUnit {
    name: String,
    unit_id: String,
    shim: Result<ShimCommand, String>,
    shared: Arc<UnitShared>,
    port: Option<(Arc<PortOwner>, usize)>,
}

impl JobUnit {
    fn create(
        id: &UnitId,
        shim: Result<ShimCommand, String>,
        port: Option<Arc<PortOwner>>,
    ) -> io::Result<Self> {
        let name = job_name(id);
        let name_w = wide(&name);
        // SAFETY: default security and a NUL-terminated name. The last error
        // is cleared first: it reports ERROR_ALREADY_EXISTS on success when
        // the name was taken.
        let raw = unsafe {
            SetLastError(0);
            CreateJobObjectW(std::ptr::null(), name_w.as_ptr())
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let existed =
            io::Error::last_os_error().raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32);
        // SAFETY: a fresh handle this call owns exclusively.
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        if existed {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("job {name} already exists"),
            ));
        }
        // SAFETY: an all-zero limit block is valid; only the flags are set.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = UNIT_JOB_LIMITS;
        set_information(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits,
        )?;
        let shared = Arc::new(UnitShared {
            job: Mutex::new(Some(job)),
            empty: watch::channel(0).0,
            state: Mutex::new(MemberState::default()),
        });
        let port = match port {
            Some(owner) => {
                let key = owner.0.next_key.fetch_add(1, Ordering::SeqCst);
                let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                    CompletionKey: key as *mut c_void,
                    CompletionPort: owner.0.handle.as_raw_handle(),
                };
                shared.with_job(|job| {
                    set_information(
                        job,
                        JobObjectAssociateCompletionPortInformation,
                        &association,
                    )
                })?;
                lock(&owner.0.units).insert(key, Arc::downgrade(&shared));
                Some((owner, key))
            }
            None => None,
        };
        Ok(Self {
            name,
            unit_id: id.as_str().to_string(),
            shim,
            shared,
            port,
        })
    }

    /// The pids in the job now.
    fn pids(&self) -> io::Result<Vec<u32>> {
        self.shared.with_job(|job| {
            let mut capacity = 64usize;
            loop {
                // Two header words, then the ids.
                let mut buf = vec![0usize; 2 + capacity];
                // SAFETY: a live job and a buffer of the stated size.
                let ok = unsafe {
                    QueryInformationJobObject(
                        job,
                        JobObjectBasicProcessIdList,
                        buf.as_mut_ptr().cast(),
                        (buf.len() * std::mem::size_of::<usize>()) as u32,
                        std::ptr::null_mut(),
                    )
                };
                // SAFETY: the buffer starts with the list's header.
                let list = unsafe { &*buf.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
                if ok == 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() == Some(ERROR_MORE_DATA as i32) {
                        capacity = (list.NumberOfAssignedProcesses as usize + 16).max(capacity * 2);
                        continue;
                    }
                    return Err(err);
                }
                // SAFETY: the list holds `NumberOfProcessIdsInList` ids.
                let ids = unsafe {
                    std::slice::from_raw_parts(
                        list.ProcessIdList.as_ptr(),
                        list.NumberOfProcessIdsInList as usize,
                    )
                };
                return Ok(ids.iter().map(|p| *p as u32).collect());
            }
        })
    }

    /// Whether `handle`'s process is in this unit's job.
    fn holds(&self, handle: HANDLE) -> io::Result<bool> {
        self.shared.with_job(|job| {
            let mut result: BOOL = 0;
            // SAFETY: two live handles and a valid out-pointer.
            if unsafe { IsProcessInJob(handle, job, &mut result) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(result != 0)
        })
    }

    fn kill_blocking(&self) -> io::Result<KillSummary> {
        let pids = self.pids()?;
        let spared = spared_closure(pids.iter().copied());
        if spared.is_empty() && !lock(&self.shared.state).per_member {
            self.shared.with_job(|job| {
                // SAFETY: a live job handle.
                if unsafe { TerminateJobObject(job, 1) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            })?;
            return Ok(KillSummary {
                killed: pids.len(),
                ..KillSummary::default()
            });
        }
        // Member by member. From here the port thread records (and spares)
        // every process that joins; the snapshot below is authoritative.
        let observer = {
            let mut state = lock(&self.shared.state);
            state.per_member = true;
            state.spared.extend(spared.iter().copied());
            state.observer.clone()
        };
        self.clear_kill_on_close()?;
        let pids = self.pids()?;
        let mut spared = spared_closure(pids.iter().copied());
        {
            let state = lock(&self.shared.state);
            spared.extend(pids.iter().filter(|p| state.spared.contains(p)));
        }
        let doomed: Vec<u32> = pids.into_iter().filter(|p| !spared.contains(p)).collect();
        if let Some(observer) = &observer {
            for pid in &doomed {
                if let Ok(start) = process::start_time(*pid) {
                    observer.record_root(*pid, start);
                }
            }
        }
        let killed = doomed
            .iter()
            .filter(|pid| self.terminate_member(**pid))
            .count();
        Ok(KillSummary {
            killed,
            spared: spared
                .into_iter()
                .filter_map(|pid| process::identity(pid).ok())
                .collect(),
            ..KillSummary::default()
        })
    }

    /// Clears `KILL_ON_JOB_CLOSE` (other limits unchanged), so spared
    /// members outlive the job handle.
    fn clear_kill_on_close(&self) -> io::Result<()> {
        self.shared.with_job(|job| {
            // SAFETY: an all-zero limit block is valid.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            // SAFETY: a live job and a correctly sized information block.
            let ok = unsafe {
                QueryInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_mut(&mut limits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
                return Ok(());
            }
            limits.BasicLimitInformation.LimitFlags &= !JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            set_information(job, JobObjectExtendedLimitInformation, &limits)
        })
    }

    /// Terminates `pid` only while it is still in this job (a pid reused
    /// since the snapshot names a process outside it). Returns whether it
    /// was terminated.
    fn terminate_member(&self, pid: u32) -> bool {
        let Ok(handle) =
            process::open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE)
        else {
            return false;
        };
        if !matches!(self.holds(handle.as_raw_handle()), Ok(true)) {
            return false;
        }
        // SAFETY: a live handle with PROCESS_TERMINATE.
        unsafe { TerminateProcess(handle.as_raw_handle(), 1) != 0 }
    }

    fn release(&self) {
        drop(lock(&self.shared.job).take());
        if let Some((owner, key)) = &self.port {
            lock(&owner.0.units).remove(key);
        }
    }
}

impl Drop for JobUnit {
    fn drop(&mut self) {
        if let Some((owner, key)) = &self.port {
            lock(&owner.0.units).remove(key);
        }
    }
}

impl UnitBackend for JobUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        let shim = self
            .shim
            .as_ref()
            .map_err(|err| io::Error::other(err.clone()))?;
        let mut wrapper = vec![shim.exe.display().to_string()];
        wrapper.extend(shim.leading_args.iter().cloned());
        wrapper.extend(["--job".to_string(), self.name.clone(), "--".to_string()]);
        Ok(Placement {
            wrapper: Some(wrapper),
            env: vec![(UNIT_ENV.to_string(), self.unit_id.clone())],
        })
    }

    fn kill_all(
        self: Arc<Self>,
        _roots: Vec<(u32, u64)>,
    ) -> BoxFuture<'static, io::Result<KillSummary>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || self.kill_blocking())
                .await
                .map_err(io::Error::other)?
        })
    }

    fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
        let pids = self.pids()?;
        let spared = spared_closure(pids.iter().copied());
        Ok(MemberList {
            members: pids
                .into_iter()
                .filter(|pid| !spared.contains(pid))
                .filter_map(|pid| process::identity(pid).ok())
                .collect(),
            withheld: 0,
        })
    }

    fn confirm_placement(&self, pid: u32, _roots: &[(u32, u64)]) -> io::Result<()> {
        let handle =
            process::open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?;
        // SAFETY: a live handle with SYNCHRONIZE; zero timeout.
        if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("process {pid} is gone"),
            ));
        }
        if self.holds(handle.as_raw_handle())? {
            return Ok(());
        }
        Err(io::Error::other(format!(
            "process {pid} runs outside unit job {}",
            self.name
        )))
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
        self.port.as_ref()?;
        let mut confirmed = self.shared.empty.subscribe();
        // One read now covers a unit that is already empty; every later
        // zero message is confirmed by the port thread.
        let now = self.shared.active_processes();
        Some(Box::pin(async move {
            if now? == 0 {
                return Ok(());
            }
            confirmed
                .changed()
                .await
                .map_err(|_| io::Error::other("the unit was released"))
        }))
    }

    /// Closes the unit's job handle (kill-on-close ends any member still
    /// in it; with kill-on-close cleared, the spared run on).
    fn remove(&self, _emptied: bool) -> io::Result<()> {
        self.release();
        Ok(())
    }

    fn set_observer(&self, observer: Arc<dyn UnitObserver>) {
        lock(&self.shared.state).observer = Some(observer);
    }
}

fn set_information<T>(
    job: HANDLE,
    class: windows_sys::Win32::System::JobObjects::JOBOBJECTINFOCLASS,
    info: &T,
) -> io::Result<()> {
    // SAFETY: a live job and an information block of the class's type.
    let ok = unsafe {
        SetInformationJobObject(
            job,
            class,
            std::ptr::from_ref(info).cast(),
            std::mem::size_of::<T>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A unit reopened from its record, or a legacy sidecar: no job. Its
/// members are its identity-verified roots that still run plus their
/// descendants by parent link (a child never starts before its parent, so a
/// reused parent pid is never followed), reached by handle.
pub(crate) struct RecordedUnit;

impl RecordedUnit {
    /// `(pid, start)` of every live root and descendant.
    fn tree(roots: &[(u32, u64)]) -> Vec<(u32, u64)> {
        let links = process::parent_links();
        let mut out: Vec<(u32, u64)> = roots
            .iter()
            .copied()
            .filter(|(pid, start)| process::start_time(*pid).ok() == Some(*start))
            .collect();
        let mut next = 0;
        while next < out.len() {
            let (parent, parent_start) = out[next];
            next += 1;
            for (pid, _) in links.iter().filter(|(_, pp)| *pp == parent) {
                if out.iter().any(|(p, _)| p == pid) {
                    continue;
                }
                if let Ok(start) = process::start_time(*pid) {
                    if start >= parent_start {
                        out.push((*pid, start));
                    }
                }
            }
        }
        out
    }
}

impl UnitBackend for RecordedUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        Err(io::Error::other(
            "a unit reopened from its record has no job and takes no new members",
        ))
    }

    fn kill_all(
        self: Arc<Self>,
        roots: Vec<(u32, u64)>,
    ) -> BoxFuture<'static, io::Result<KillSummary>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let tree = RecordedUnit::tree(&roots);
                let pids: Vec<u32> = tree.iter().map(|(pid, _)| *pid).collect();
                let spared = spared_closure(pids.iter().copied());
                let mut summary = KillSummary::default();
                for (pid, start) in tree {
                    if spared.contains(&pid) {
                        continue;
                    }
                    if let Ok(watch) = ProcWatch::open_expecting(pid, start) {
                        if watch.signal(Sig::Kill).is_ok() {
                            summary.killed += 1;
                        }
                    }
                }
                summary.spared = spared
                    .into_iter()
                    .filter_map(|pid| process::identity(pid).ok())
                    .collect();
                summary
            })
            .await
            .map_err(io::Error::other)
        })
    }

    fn members(&self, roots: &[(u32, u64)]) -> io::Result<MemberList> {
        let tree = RecordedUnit::tree(roots);
        let pids: Vec<u32> = tree.iter().map(|(pid, _)| *pid).collect();
        let spared = spared_closure(pids.iter().copied());
        Ok(MemberList {
            members: tree
                .into_iter()
                .filter(|(pid, _)| !spared.contains(pid))
                .filter_map(|(pid, start)| {
                    process::identity(pid).ok().filter(|id| id.start == start)
                })
                .collect::<Vec<ProcIdentity>>(),
            withheld: 0,
        })
    }

    fn confirm_placement(&self, _pid: u32, _roots: &[(u32, u64)]) -> io::Result<()> {
        Err(io::Error::other(
            "a unit reopened from its record has no job to place members in",
        ))
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
        None
    }

    fn remove(&self, _emptied: bool) -> io::Result<()> {
        Ok(())
    }
}

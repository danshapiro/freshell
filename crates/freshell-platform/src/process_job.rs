//! Windows kill-on-close Job Object, shared by every caller that must own a
//! whole child process tree on native Windows (checkpoint Git children and
//! their filters/hooks; the Claude sidecar and its SDK-spawned CLI).
//!
//! A child is spawned suspended, assigned to the job, and only then resumed,
//! so every process it later starts is born inside the job. Closing the last
//! job handle (dropping [`KillOnCloseJob`]) terminates every process still in
//! the job (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
//!
//! A job stops counting a process as active the moment the process starts
//! to exit (and stops listing it around then), but Windows signals the
//! process (it has exited) only once that exit is done: on windows-2022 about 4 ms later
//! for an idle node and 25-30 ms later for one holding 768 MB, every time.
//! An owner that must know the whole tree has exited therefore watches the
//! members' own handles too ([`JobMembers`]), learning of each member from
//! the job's list and from the job's completion port, which reports every
//! process that joins the job, even one that has started to exit by the
//! time the report is read.
//!
//! This crate is tokio-free and does no logging: the blocking wait
//! ([`KillOnCloseJob::wait_signaled`]) is meant to run on a blocking thread,
//! and errors are returned for the caller to log under its own event names.

use std::io;
use std::time::Duration;

use windows_sys::Win32::Foundation::HANDLE;

/// The process-creation flag a job-owned child is spawned with: it starts
/// suspended, is assigned to the job, and only then resumed.
pub const CREATE_SUSPENDED: u32 = windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

/// An owned Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
pub struct KillOnCloseJob {
    handle: HANDLE,
}

// SAFETY: a job handle is a kernel object handle; every Win32 call made on it
// here is thread-safe, and the handle is closed exactly once (in `Drop`).
unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl KillOnCloseJob {
    pub fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
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
            let error = io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self { handle })
    }

    /// Assign a process that was created with `CREATE_SUSPENDED`, then resume
    /// its main thread. On an assignment error the process is NOT resumed;
    /// the caller decides whether to kill it or resume it unguarded.
    pub fn assign_suspended_process(&self, process_id: u32) -> io::Result<()> {
        self.assign_process(process_id)?;
        resume_suspended_process(process_id)
    }

    /// Assign a process to this job without touching its threads.
    pub fn assign_process(&self, process_id: u32) -> io::Result<()> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
        let assign_error = (assigned == 0).then(io::Error::last_os_error);
        unsafe { CloseHandle(process) };
        match assign_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The number of processes currently alive in the job.
    pub fn active_processes(&self) -> io::Result<u32> {
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
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    /// The ids of the processes the job counts as active, those in jobs
    /// nested in it included.
    pub fn process_ids(&self) -> io::Result<Vec<u32>> {
        use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
        };

        // A header, then the ids; `usize` storage keeps both aligned.
        let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
            / std::mem::size_of::<usize>();
        let mut capacity = 16;
        loop {
            let mut buffer = vec![0usize; header + capacity];
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    u32::try_from(std::mem::size_of_val(buffer.as_slice())).unwrap_or(u32::MAX),
                    std::ptr::null_mut(),
                )
            };
            let error = (queried == 0).then(io::Error::last_os_error);
            // SAFETY: the buffer is `usize`-aligned and longer than the
            // header, which the query filled in.
            let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let assigned = list.NumberOfAssignedProcesses as usize;
            let listed = (list.NumberOfProcessIdsInList as usize).min(capacity);
            let more = match error {
                Some(error) if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) => true,
                Some(error) => return Err(error),
                None => listed == capacity && assigned > listed,
            };
            if !more {
                return Ok(buffer[header..header + listed]
                    .iter()
                    .map(|&id| id as u32)
                    .collect());
            }
            // More processes than room: ask again with room for them.
            capacity = assigned.max(capacity) * 2;
        }
    }

    /// Terminate every process in the job (exit code 1).
    pub fn terminate(&self) -> io::Result<()> {
        let terminated =
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) };
        if terminated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Block until the job object is signaled (after [`Self::terminate`]) or
    /// `timeout` elapses (`ErrorKind::TimedOut`). Run it on a blocking thread.
    pub fn wait_signaled(&self, timeout: Duration) -> io::Result<()> {
        use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        let wait_result = unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(self.handle, millis)
        };
        match wait_result {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "job object was not signaled within the timeout",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            status => Err(io::Error::other(format!(
                "job object wait returned unexpected status {status}"
            ))),
        }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

/// Resume the main thread of a process created with `CREATE_SUSPENDED`.
pub fn resume_suspended_process(process_id: u32) -> io::Result<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let thread_id = find_process_thread(process_id)?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let resumed = unsafe { ResumeThread(thread) };
    unsafe { CloseHandle(thread) };
    if resumed == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn find_process_thread(process_id: u32) -> io::Result<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
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
    found.ok_or_else(|| io::Error::other("suspended process thread was not found"))
}

/// A synchronization handle on a process, opened while it is known to be
/// running, so a later wait observes THAT process's exit even if its id is
/// reused afterwards.
pub struct ProcessExitWatch {
    handle: HANDLE,
}

// SAFETY: a process handle is a kernel object handle; waiting on it is
// thread-safe, and it is closed exactly once (in `Drop`).
unsafe impl Send for ProcessExitWatch {}
unsafe impl Sync for ProcessExitWatch {}

impl ProcessExitWatch {
    pub fn open(process_id: u32) -> io::Result<Self> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    /// Watch `process_id` only if it is a member of `job` (directly or
    /// through a job nested in it), so an id reused by a process outside the
    /// job is never watched in its place. `Ok(None)` when no member has that
    /// id any more.
    pub fn open_member(process_id: u32, job: &KillOnCloseJob) -> io::Result<Option<Self>> {
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };

        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                process_id,
            )
        };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            // The id names no process any more: that member is long gone.
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(None);
            }
            return Err(error);
        }
        let watch = Self { handle };
        let mut in_job = 0;
        if unsafe { IsProcessInJob(watch.handle, job.handle, &mut in_job) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((in_job != 0).then_some(watch))
    }

    /// Whether the process has exited, waiting at most `timeout` for it.
    pub fn wait(&self, timeout: Duration) -> io::Result<bool> {
        use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        match unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(self.handle, millis)
        } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            status => Err(io::Error::other(format!(
                "process wait returned unexpected status {status}"
            ))),
        }
    }
}

impl Drop for ProcessExitWatch {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

/// Handles on the processes in a job, for an owner that must know when
/// every one of them has exited, not just stopped being counted (see the
/// module docs).
///
/// The first [`Self::record`] watches the processes the job lists and
/// subscribes to the job's reports of every process that joins it from
/// then on. A process that started to exit before that first call may not
/// be listed any more, so the first call belongs before anything that ends
/// the members (a shutdown request, [`KillOnCloseJob::terminate`]); each
/// later call, at every check, also watches every process that joined
/// since, including one already exiting.
#[derive(Default)]
pub struct JobMembers {
    watched: Vec<(u32, ProcessExitWatch)>,
    joined: Option<JoinedProcesses>,
}

impl JobMembers {
    /// Start watching every process in `job` that is not watched yet: those
    /// it lists and those it reported joining.
    pub fn record(&mut self, job: &KillOnCloseJob) -> io::Result<()> {
        // A watched member keeps its id taken until its watch is closed, so
        // once the exited ones are forgotten an id seen again is new.
        self.forget_exited()?;
        let joined = match &self.joined {
            Some(joined) => joined,
            None => self.joined.insert(JoinedProcesses::subscribe(job)?),
        };
        let mut process_ids = joined.take()?;
        process_ids.extend(job.process_ids()?);
        for process_id in process_ids {
            if self
                .watched
                .iter()
                .any(|(watched, _)| *watched == process_id)
            {
                continue;
            }
            if let Some(watch) = ProcessExitWatch::open_member(process_id, job)? {
                self.watched.push((process_id, watch));
            }
        }
        Ok(())
    }

    /// Whether a recorded member has not exited yet.
    pub fn any_running(&mut self) -> io::Result<bool> {
        self.forget_exited()?;
        Ok(!self.watched.is_empty())
    }

    fn forget_exited(&mut self) -> io::Result<()> {
        let mut failure = None;
        self.watched
            .retain(|(_, watch)| match watch.wait(Duration::ZERO) {
                Ok(exited) => !exited,
                Err(error) => {
                    failure.get_or_insert(error);
                    true
                }
            });
        failure.map_or(Ok(()), Err)
    }
}

/// A job's completion port, which the job posts a report to for every
/// process that joins it (and, when the port is attached, for every process
/// already in it). Unlike the job's process list, a report stays readable
/// after its process has started to exit.
struct JoinedProcesses {
    port: HANDLE,
}

// SAFETY: a completion port handle is a kernel object handle; dequeuing from
// it is thread-safe, and it is closed exactly once (in `Drop`).
unsafe impl Send for JoinedProcesses {}
unsafe impl Sync for JoinedProcesses {}

impl JoinedProcesses {
    /// Attach a new completion port to `job` (a job takes only one).
    fn subscribe(job: &KillOnCloseJob) -> io::Result<Self> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::JobObjects::{
            JobObjectAssociateCompletionPortInformation, SetInformationJobObject,
            JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
        };
        use windows_sys::Win32::System::IO::CreateIoCompletionPort;

        let port =
            unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
        if port.is_null() {
            return Err(io::Error::last_os_error());
        }
        let joined = Self { port };
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: std::ptr::null_mut(),
            CompletionPort: joined.port,
        };
        let associated = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectAssociateCompletionPortInformation,
                std::ptr::addr_of!(association).cast(),
                std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
            )
        };
        if associated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(joined)
    }

    /// The ids of the processes reported joining since the last call. Other
    /// reports (a process exiting, the job emptying) are dropped.
    fn take(&self) -> io::Result<Vec<u32>> {
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_NEW_PROCESS;
        use windows_sys::Win32::System::IO::{GetQueuedCompletionStatus, OVERLAPPED};

        let mut joined = Vec::new();
        loop {
            let mut message = 0u32;
            let mut key = 0usize;
            // A job report carries its process id in place of an OVERLAPPED.
            let mut process_id: *mut OVERLAPPED = std::ptr::null_mut();
            let dequeued = unsafe {
                GetQueuedCompletionStatus(self.port, &mut message, &mut key, &mut process_id, 0)
            };
            if dequeued == 0 {
                let error = io::Error::last_os_error();
                if process_id.is_null() && error.raw_os_error() == Some(WAIT_TIMEOUT as i32) {
                    return Ok(joined);
                }
                return Err(error);
            }
            if message == JOB_OBJECT_MSG_NEW_PROCESS {
                joined.push(process_id as usize as u32);
            }
        }
    }
}

impl Drop for JoinedProcesses {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.port) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// A `cmd` that starts a long-lived `ping` grandchild and then waits on
    /// its own long `ping`, spawned suspended into `job`. Returns the child.
    fn spawn_tree_in(job: &KillOnCloseJob) -> std::process::Child {
        use std::os::windows::process::CommandExt;
        // cmd.exe does not follow CommandLineToArgvW quoting, so the command
        // line is passed verbatim (an escaped `\"` would break `start`).
        let mut child = Command::new("cmd.exe")
            .raw_arg("/C")
            .raw_arg("start \"\" /B ping -n 120 127.0.0.1 > nul & ping -n 120 127.0.0.1 > nul")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .expect("spawn cmd suspended");
        job.assign_suspended_process(child.id())
            .expect("assign the suspended child and resume it");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while job.active_processes().unwrap() < 3 {
            assert!(
                std::time::Instant::now() < deadline,
                "the child never started its descendants inside the job"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.try_wait();
        child
    }

    #[test]
    fn terminate_empties_the_job_including_descendants() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut child = spawn_tree_in(&job);

        job.terminate().expect("terminate the job");
        job.wait_signaled(Duration::from_secs(5))
            .expect("the job signals once terminated");

        assert_eq!(job.active_processes().unwrap(), 0);
        child.wait().expect("reap the child");
    }

    #[test]
    fn the_job_lists_the_child_and_its_descendants() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut child = spawn_tree_in(&job);

        let ids = job.process_ids().expect("list the job's processes");

        assert!(ids.contains(&child.id()), "the child is listed: {ids:?}");
        assert!(ids.len() >= 3, "so are its descendants: {ids:?}");
        job.terminate().expect("terminate the job");
        child.wait().expect("reap the child");
    }

    #[test]
    fn a_member_watch_opens_only_on_a_process_in_the_job() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut member = spawn_tree_in(&job);
        let mut outsider = Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a process outside the job");

        let watched_member = ProcessExitWatch::open_member(member.id(), &job);
        let watched_outsider = ProcessExitWatch::open_member(outsider.id(), &job);

        outsider.kill().expect("kill the outsider");
        outsider.wait().expect("reap the outsider");
        job.terminate().expect("terminate the job");
        member.wait().expect("reap the member");
        assert!(
            watched_member.expect("open the member").is_some(),
            "the job's member is watched"
        );
        assert!(
            watched_outsider.expect("open the outsider").is_none(),
            "a process outside the job is not"
        );
    }

    #[test]
    fn recorded_members_run_until_every_one_has_exited() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut child = spawn_tree_in(&job);
        let separately: Vec<ProcessExitWatch> = job
            .process_ids()
            .expect("list the job's processes")
            .into_iter()
            .map(|id| ProcessExitWatch::open(id).expect("watch a member"))
            .collect();
        let mut members = JobMembers::default();
        members.record(&job).expect("record the members");
        assert!(members.any_running().unwrap(), "the members run");

        job.terminate().expect("terminate the job");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while members.any_running().expect("check the members") {
            assert!(
                std::time::Instant::now() < deadline,
                "the terminated members exit"
            );
            std::thread::sleep(Duration::from_millis(1));
        }

        for watch in &separately {
            assert!(
                watch.wait(Duration::ZERO).unwrap(),
                "every member had exited when none was reported running"
            );
        }
        child.wait().expect("reap the child");
    }

    /// A long `ping`, spawned suspended into `job` and then resumed.
    fn spawn_ping_in(job: &KillOnCloseJob) -> std::process::Child {
        use std::os::windows::process::CommandExt;
        let child = Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .expect("spawn ping suspended");
        job.assign_suspended_process(child.id())
            .expect("assign the suspended ping and resume it");
        child
    }

    #[test]
    fn the_job_reports_the_processes_in_it_and_every_one_that_joins() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut tree = spawn_tree_in(&job);
        let listed = job.process_ids().expect("list the job's processes");

        let joined = JoinedProcesses::subscribe(&job).expect("subscribe to the job");
        let present = joined.take().expect("read the reports");
        let mut later = spawn_ping_in(&job);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let reported_later = loop {
            let reported = joined.take().expect("read the reports");
            if !reported.is_empty() || std::time::Instant::now() >= deadline {
                break reported;
            }
            std::thread::sleep(Duration::from_millis(10));
        };

        job.terminate().expect("terminate the job");
        tree.wait().expect("reap the tree's root");
        later.wait().expect("reap the later process");
        for id in &listed {
            assert!(
                present.contains(id),
                "a process already in the job is reported: {id} of {listed:?}, reported {present:?}"
            );
        }
        assert_eq!(
            reported_later,
            [later.id()],
            "a process that joins later is reported once"
        );
    }

    #[test]
    fn a_member_the_job_no_longer_lists_is_still_watched_once_it_was_reported() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut members = JobMembers::default();
        members.record(&job).expect("record the (empty) job");
        let mut member = spawn_ping_in(&job);
        // Kept open, this keeps the exited process (and its id) around, as
        // a process still finishing its exit is.
        let watch = ProcessExitWatch::open(member.id()).expect("watch the member");
        member.kill().expect("kill the member");
        assert!(
            watch
                .wait(Duration::from_secs(5))
                .expect("wait on the member"),
            "the member exits"
        );
        // The job drops an exiting process from its list, sometimes only
        // just after the process is signaled.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while job
            .process_ids()
            .expect("list the job's processes")
            .contains(&member.id())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the job stops listing a member that has exited"
            );
            std::thread::sleep(Duration::from_millis(1));
        }

        members.record(&job).expect("record the members");

        assert!(
            members.watched.iter().any(|(id, _)| *id == member.id()),
            "the member the job reported joining is watched"
        );
        assert!(
            !members.any_running().expect("check the members"),
            "and it has exited"
        );
        member.wait().expect("reap the member");
    }

    #[test]
    fn closing_the_job_kills_every_process_in_it() {
        let job = KillOnCloseJob::new().expect("create the job");
        let mut child = spawn_tree_in(&job);
        let watch = ProcessExitWatch::open(child.id()).expect("watch the child");

        drop(job);

        assert!(
            watch
                .wait(Duration::from_secs(5))
                .expect("wait on the child"),
            "closing the last job handle killed the child"
        );
        child.wait().expect("reap the child");
    }
}

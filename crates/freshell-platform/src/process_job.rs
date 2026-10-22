//! Windows kill-on-close Job Object, shared by every caller that must own a
//! whole child process tree on native Windows (checkpoint Git children and
//! their filters/hooks; the Claude sidecar and its SDK-spawned CLI).
//!
//! A child is spawned suspended, assigned to the job, and only then resumed,
//! so every process it later starts is born inside the job. Closing the last
//! job handle (dropping [`KillOnCloseJob`]) terminates every process still in
//! the job (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
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

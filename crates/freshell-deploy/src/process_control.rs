use std::os::fd::RawFd;
use std::time::Duration;

use crate::error::{DeployError, Result};
use crate::paths::DeployPort;
use crate::process_identity::{
    LinuxPidFd, LinuxProcfs, ListenerIdentity, ProcessIdentity, ProcessInspector,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

impl Signal {
    fn libc_value(self) -> libc::c_int {
        match self {
            Self::Term => libc::SIGTERM,
            Self::Kill => libc::SIGKILL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopPolicy {
    pub term_timeout: Duration,
    pub kill_timeout: Duration,
}

impl StopPolicy {
    pub fn new(term_timeout: Duration, kill_timeout: Duration) -> Self {
        Self {
            term_timeout,
            kill_timeout,
        }
    }
}

impl Default for StopPolicy {
    fn default() -> Self {
        Self::new(Duration::from_secs(10), Duration::from_secs(5))
    }
}

/// Kernel-pinned process operations.
///
/// Implementations must make `Pidfd` an opaque handle tied to the process
/// instance opened by `open_pidfd`. There is deliberately no PID-based signal
/// operation in this interface.
pub trait PidfdBackend {
    type Pidfd;

    fn resolve_listener(&self, port: DeployPort) -> Result<ListenerIdentity>;
    fn resolve_listener_for_pid(
        &self,
        port: DeployPort,
        expected_pid: u32,
    ) -> Result<ListenerIdentity> {
        let listener = self.resolve_listener(port)?;
        if listener.owner_pid != expected_pid {
            return Err(DeployError::ProcessControl(format!(
                "listener owner pid {} does not match expected pid {expected_pid}",
                listener.owner_pid
            )));
        }
        Ok(listener)
    }
    fn resolve_recorded_listener(&self, expected: &ListenerIdentity) -> Result<ListenerIdentity> {
        let listener = self.resolve_listener(expected.port)?;
        if &listener != expected {
            return Err(DeployError::ProcessControl(
                "listener identity does not match the authoritative receipt".to_string(),
            ));
        }
        Ok(listener)
    }
    fn open_pidfd(&self, pid: u32) -> Result<Self::Pidfd>;
    fn snapshot(&self, pidfd: &Self::Pidfd, listener: &ListenerIdentity)
        -> Result<ProcessIdentity>;
    fn signal_pidfd(&self, pidfd: &Self::Pidfd, signal: Signal) -> Result<()>;
    fn wait_exited(&self, pidfd: &Self::Pidfd, timeout: Duration) -> Result<bool>;
}

/// An exact receipt-bound process plus the same pidfd used to prove it.
pub struct VerifiedProcess<'a, Backend: PidfdBackend> {
    backend: &'a Backend,
    pidfd: Backend::Pidfd,
    expected: ProcessIdentity,
}

impl<'a, Backend: PidfdBackend> VerifiedProcess<'a, Backend> {
    pub fn bind(backend: &'a Backend, expected: &ProcessIdentity) -> Result<Self> {
        expected.validate()?;
        let listener = backend.resolve_recorded_listener(&expected.listener)?;
        if listener != expected.listener {
            return Err(DeployError::ProcessControl(
                "listener identity does not match the authoritative receipt".to_string(),
            ));
        }
        let pidfd = backend.open_pidfd(expected.pid)?;
        let process = Self {
            backend,
            pidfd,
            expected: expected.clone(),
        };
        process.revalidate()?;
        Ok(process)
    }

    pub fn identity(&self) -> &ProcessIdentity {
        &self.expected
    }

    pub fn revalidate(&self) -> Result<()> {
        self.revalidate_process()?;
        let listener = self
            .backend
            .resolve_recorded_listener(&self.expected.listener)?;
        if listener != self.expected.listener {
            return Err(DeployError::ProcessControl(
                "listener ownership changed after pidfd pinning".to_string(),
            ));
        }
        Ok(())
    }

    fn revalidate_process(&self) -> Result<()> {
        let current = self
            .backend
            .snapshot(&self.pidfd, &self.expected.listener)?;
        if current != self.expected {
            return Err(DeployError::ProcessControl(
                "boot/process/executable/socket/runtime identity changed".to_string(),
            ));
        }
        Ok(())
    }

    pub fn terminate(&self, policy: StopPolicy) -> Result<()> {
        self.revalidate()?;
        self.backend.signal_pidfd(&self.pidfd, Signal::Term)?;
        if self.backend.wait_exited(&self.pidfd, policy.term_timeout)? {
            return Ok(());
        }

        // Once TERM has been sent, closing the listener is expected. Re-prove
        // the process identity through the retained pidfd without requiring
        // the drained listener to remain present, then escalate through that
        // same kernel-pinned handle.
        self.revalidate_process()?;
        self.backend.signal_pidfd(&self.pidfd, Signal::Kill)?;
        if self.backend.wait_exited(&self.pidfd, policy.kill_timeout)? {
            Ok(())
        } else {
            Err(DeployError::ProcessControl(
                "process remained alive after pidfd-bound SIGKILL".to_string(),
            ))
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LinuxPidfdBackend {
    procfs: LinuxProcfs,
}

impl LinuxPidfdBackend {
    pub fn new(procfs: LinuxProcfs) -> Self {
        Self { procfs }
    }
}

impl PidfdBackend for LinuxPidfdBackend {
    type Pidfd = LinuxPidFd;

    fn resolve_listener(&self, port: DeployPort) -> Result<ListenerIdentity> {
        self.procfs.resolve_listener(port)
    }

    fn resolve_listener_for_pid(
        &self,
        port: DeployPort,
        expected_pid: u32,
    ) -> Result<ListenerIdentity> {
        self.procfs.resolve_listener_for_pid(port, expected_pid)
    }

    fn resolve_recorded_listener(&self, expected: &ListenerIdentity) -> Result<ListenerIdentity> {
        self.procfs.resolve_recorded_listener(expected)
    }

    fn open_pidfd(&self, pid: u32) -> Result<Self::Pidfd> {
        self.procfs.open_pidfd(pid)
    }

    fn snapshot(
        &self,
        pidfd: &Self::Pidfd,
        listener: &ListenerIdentity,
    ) -> Result<ProcessIdentity> {
        self.procfs.snapshot(pidfd, listener)
    }

    fn signal_pidfd(&self, pidfd: &Self::Pidfd, signal: Signal) -> Result<()> {
        pidfd_send_signal(pidfd.raw_fd(), signal)
    }

    fn wait_exited(&self, pidfd: &Self::Pidfd, timeout: Duration) -> Result<bool> {
        wait_pidfd(pidfd.raw_fd(), timeout)
    }
}

fn pidfd_send_signal(pidfd: RawFd, signal: Signal) -> Result<()> {
    // SAFETY: `pidfd` is an open pidfd owned by the backend. The siginfo
    // pointer is null and flags are zero, as required by pidfd_send_signal.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd,
            signal.libc_value(),
            std::ptr::null::<libc::siginfo_t>(),
            0_u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(DeployError::ProcessControl(format!(
            "pidfd_send_signal failed: {}",
            std::io::Error::last_os_error()
        )))
    }
}

fn wait_pidfd(pidfd: RawFd, timeout: Duration) -> Result<bool> {
    let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
    let mut descriptor = libc::pollfd {
        fd: pidfd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll receives one initialized descriptor for the duration of the
    // call; the pidfd remains owned by the caller.
    let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
    if result < 0 {
        return Err(DeployError::ProcessControl(format!(
            "pidfd poll failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    if result == 0 {
        return Ok(false);
    }
    let exited = descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0;
    let invalid = descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0;
    if invalid {
        return Err(DeployError::ProcessControl(format!(
            "pidfd poll returned invalid events {}",
            descriptor.revents
        )));
    }
    Ok(exited)
}

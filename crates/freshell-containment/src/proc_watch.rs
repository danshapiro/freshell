//! `ProcWatch`: an event-driven exit watch on ONE process incarnation, and
//! signals that can only ever reach that incarnation.
//!
//! Linux uses a pidfd: it pins the incarnation at open (a recycled pid is a
//! different process the pidfd never names), it becomes readable exactly when
//! the process exits (zombies count), and `pidfd_send_signal` through it can
//! never reach a recycled pid. No polling anywhere: `exited` waits on the
//! pidfd's readiness in the tokio reactor.
//!
//! Windows uses a process handle: Windows never reuses a pid while a handle
//! to its process is open, the handle is signalled exactly when the process
//! exits, and `TerminateProcess` through it reaches only that process.
//! `exited` registers one thread-pool wait on the handle
//! (`RegisterWaitForSingleObject`), so nothing polls and no thread is held
//! per watch. Only `Sig::Kill` exists there (`TerminateProcess`); the soft
//! signals answer `ErrorKind::Unsupported`.
//!
//! The macOS body lands in a later task behind the same API (until then
//! `open` answers `ErrorKind::Unsupported`).

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::process::ProcIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    Interrupt,
    Terminate,
    Kill,
}

#[derive(Clone)]
pub struct ProcWatch {
    inner: Arc<Inner>,
}

struct Inner {
    identity: ProcIdentity,
    exited: AtomicBool,
    #[cfg(target_os = "linux")]
    fd: std::os::fd::OwnedFd,
    /// The pidfd's reactor registration (a duplicate fd), made by the first
    /// `exited` await and shared by every later one. A failed registration
    /// is returned to that caller and never cached.
    #[cfg(target_os = "linux")]
    registered: tokio::sync::OnceCell<tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>>,
    /// The process handle that pins this incarnation.
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    /// Set to `true` by the thread-pool wait when the handle is signalled.
    #[cfg(windows)]
    exit_tx: tokio::sync::watch::Sender<bool>,
    /// The thread-pool wait, registered by the first `exited` await and
    /// unregistered (waiting for a running callback) before the rest of
    /// `Inner` drops. A failed registration is returned and never cached.
    #[cfg(windows)]
    wait: std::sync::Mutex<Option<WaitRegistration>>,
}

impl std::fmt::Debug for ProcWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcWatch")
            .field("identity", &self.inner.identity)
            .finish()
    }
}

impl ProcWatch {
    /// Watch the process `pid` is now, pinning that incarnation.
    pub fn open(pid: u32) -> io::Result<Self> {
        Self::open_inner(pid, None)
    }

    /// Watch `pid` only if it is still the incarnation that started at
    /// `start`; `ErrorKind::NotFound` when it differs or is gone.
    pub fn open_expecting(pid: u32, start: u64) -> io::Result<Self> {
        Self::open_inner(pid, Some(start))
    }

    pub fn identity(&self) -> &ProcIdentity {
        &self.inner.identity
    }

    pub fn pid(&self) -> u32 {
        self.inner.identity.pid
    }
}

#[cfg(target_os = "linux")]
impl ProcWatch {
    fn open_inner(pid: u32, expect_start: Option<u64>) -> io::Result<Self> {
        use std::os::fd::FromRawFd;
        // SAFETY: pidfd_open takes a pid and flags and returns a new fd or -1.
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if raw < 0 {
            let err = io::Error::last_os_error();
            return Err(if err.raw_os_error() == Some(libc::ESRCH) {
                io::Error::new(io::ErrorKind::NotFound, "process gone")
            } else {
                err
            });
        }
        // SAFETY: `raw` is a fresh pidfd this call owns exclusively.
        let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(raw as i32) };
        // Identity is read AFTER the pidfd pins the incarnation: a pid recycled
        // before pidfd_open shows a different start time and is refused.
        let identity = crate::process::identity(pid)
            .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "process gone"))?;
        if expect_start.is_some_and(|s| s != identity.start) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "different incarnation",
            ));
        }
        Ok(Self {
            inner: Arc::new(Inner {
                identity,
                exited: AtomicBool::new(false),
                fd,
                registered: tokio::sync::OnceCell::new(),
            }),
        })
    }

    /// Non-blocking: has the process exited (zombies count as exited)?
    pub fn has_exited(&self) -> bool {
        if self.inner.exited.load(Ordering::SeqCst) {
            return true;
        }
        let ready = pidfd_readable(&self.inner.fd);
        if ready {
            self.inner.exited.store(true, Ordering::SeqCst);
        }
        ready
    }

    /// Resolves when the process exits. Event-driven (pidfd readiness in the
    /// tokio reactor).
    ///
    /// Precondition: awaited inside a tokio runtime with IO enabled, and one
    /// watch is awaited within one runtime (its registration belongs to the
    /// runtime of its first await). Awaited outside such a runtime, tokio
    /// panics while registering. Within it, a watch that cannot be registered
    /// (for example when no file descriptor is left) answers `Err` instead of
    /// panicking, the caller treats it as a stop error, and a later await
    /// tries the registration again.
    pub async fn exited(&self) -> io::Result<()> {
        use tokio::io::unix::AsyncFd;
        use tokio::io::Interest;
        if self.has_exited() {
            return Ok(());
        }
        let registered = self
            .inner
            .registered
            .get_or_try_init(|| async {
                AsyncFd::with_interest(self.inner.fd.try_clone()?, Interest::READABLE)
            })
            .await?;
        loop {
            let mut guard = registered.readable().await?;
            if self.has_exited() {
                return Ok(());
            }
            // Readiness the pidfd does not confirm: wait for the next event.
            guard.clear_ready();
        }
    }

    /// Blocks the calling thread until the process exits or `limit` passes:
    /// one `poll` of the pidfd armed with the deadline (re-armed with the
    /// time left only when a signal interrupts it). `Ok(true)` once it has
    /// exited, `Ok(false)` at the deadline. For blocking threads only.
    pub(crate) fn wait_exited_blocking(&self, limit: std::time::Duration) -> io::Result<bool> {
        use std::os::fd::AsRawFd;
        let deadline = std::time::Instant::now() + limit;
        loop {
            if self.has_exited() {
                return Ok(true);
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Ok(false);
            }
            let mut pfd = libc::pollfd {
                fd: self.inner.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // Round up, so the wait never ends just before the deadline.
            let ms = left.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32;
            // SAFETY: one valid pollfd and a finite timeout.
            let ready = unsafe { libc::poll(&mut pfd, 1, ms) };
            if ready < 0 {
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::Interrupted {
                    return Err(err);
                }
            }
        }
    }

    /// Send a signal to THIS incarnation. An already-exited process is Ok(()).
    pub fn signal(&self, sig: Sig) -> io::Result<()> {
        self.send(match sig {
            Sig::Interrupt => libc::SIGINT,
            Sig::Terminate => libc::SIGTERM,
            Sig::Kill => libc::SIGKILL,
        })
    }

    /// Any signal number, to THIS incarnation (the stop-the-world sweep's
    /// SIGSTOP and SIGCONT). An already-exited process is Ok(()).
    pub(crate) fn send(&self, signum: i32) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        // SAFETY: a valid pidfd, a valid signal number, no siginfo, no flags.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.inner.fd.as_raw_fd(),
                signum,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(err);
        }
        Ok(())
    }
}

/// One zero-timeout `poll` of the pidfd: readable exactly once the process
/// has exited.
#[cfg(target_os = "linux")]
fn pidfd_readable(fd: &std::os::fd::OwnedFd) -> bool {
    use std::os::fd::AsRawFd;
    let mut pfd = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid pollfd, zero timeout.
    let ready = unsafe { libc::poll(&mut pfd, 1, 0) };
    ready > 0 && (pfd.revents & libc::POLLIN) != 0
}

#[cfg(windows)]
impl ProcWatch {
    fn open_inner(pid: u32, expect_start: Option<u64>) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Threading::{
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };
        let handle = crate::process::open_process(
            pid,
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
        )?;
        // Read from the handle itself, which pins the incarnation.
        let start = crate::process::start_time_of(handle.as_raw_handle())
            .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "process gone"))?;
        if expect_start.is_some_and(|s| s != start) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "different incarnation",
            ));
        }
        let identity = ProcIdentity {
            pid,
            start,
            name: crate::process::name(pid).unwrap_or_default(),
        };
        Ok(Self {
            inner: Arc::new(Inner {
                identity,
                exited: AtomicBool::new(false),
                handle,
                exit_tx: tokio::sync::watch::channel(false).0,
                wait: std::sync::Mutex::new(None),
            }),
        })
    }

    /// Non-blocking: has the process exited?
    pub fn has_exited(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        if self.inner.exited.load(Ordering::SeqCst) {
            return true;
        }
        // SAFETY: a live handle with SYNCHRONIZE; zero timeout.
        let signalled =
            unsafe { WaitForSingleObject(self.inner.handle.as_raw_handle(), 0) } == WAIT_OBJECT_0;
        if signalled {
            self.inner.exited.store(true, Ordering::SeqCst);
        }
        signalled
    }

    /// Resolves when the process exits: one thread-pool wait on the process
    /// handle, registered by the first call and shared by every later one.
    /// A wait that cannot be registered answers `Err`, and a later call
    /// tries again. Needs no particular runtime.
    pub async fn exited(&self) -> io::Result<()> {
        if self.has_exited() {
            return Ok(());
        }
        let mut rx = self.inner.exit_tx.subscribe();
        self.register_wait()?;
        // The sender lives in `Inner`, which `self` keeps alive.
        let _ = rx.wait_for(|exited| *exited).await;
        self.inner.exited.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn register_wait(&self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Threading::{
            RegisterWaitForSingleObject, INFINITE, WT_EXECUTEONLYONCE,
        };
        let mut slot = self
            .inner
            .wait
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot.is_some() {
            return Ok(());
        }
        let mut wait: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
        let context: *const tokio::sync::watch::Sender<bool> = &self.inner.exit_tx;
        // SAFETY: `context` points into `Inner`, which outlives the wait:
        // `Inner`'s drop unregisters it (waiting for a running callback)
        // before the sender is dropped.
        let ok = unsafe {
            RegisterWaitForSingleObject(
                &mut wait,
                self.inner.handle.as_raw_handle(),
                Some(on_process_exit),
                context.cast(),
                INFINITE,
                WT_EXECUTEONLYONCE,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        *slot = Some(WaitRegistration(wait));
        Ok(())
    }

    /// End THIS incarnation: `Sig::Kill` is `TerminateProcess` (an
    /// already-exited process is Ok(())); the soft signals do not exist for
    /// a Windows process and answer `ErrorKind::Unsupported`.
    pub fn signal(&self, sig: Sig) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Threading::TerminateProcess;
        match sig {
            Sig::Kill => {
                // SAFETY: a live handle with PROCESS_TERMINATE.
                if unsafe { TerminateProcess(self.inner.handle.as_raw_handle(), 1) } != 0 {
                    return Ok(());
                }
                let err = io::Error::last_os_error();
                // Terminating a process that already exited is refused.
                if self.has_exited() {
                    Ok(())
                } else {
                    Err(err)
                }
            }
            Sig::Interrupt | Sig::Terminate => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Windows processes take no soft signal",
            )),
        }
    }
}

/// One registered thread-pool wait; unregistering waits for a callback
/// that is already running.
#[cfg(windows)]
struct WaitRegistration(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a wait handle is a plain kernel handle, usable from any thread.
#[cfg(windows)]
unsafe impl Send for WaitRegistration {}

#[cfg(windows)]
impl Drop for WaitRegistration {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Threading::UnregisterWaitEx;
        // SAFETY: our registration, unregistered once; INVALID_HANDLE_VALUE
        // waits for a callback in progress to finish.
        unsafe { UnregisterWaitEx(self.0, INVALID_HANDLE_VALUE) };
    }
}

#[cfg(windows)]
impl Drop for Inner {
    fn drop(&mut self) {
        // Before `exit_tx` (the callback's context) is dropped.
        drop(
            self.wait
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take(),
        );
    }
}

/// The thread-pool callback: the process handle is signalled.
#[cfg(windows)]
unsafe extern "system" fn on_process_exit(
    context: *mut std::ffi::c_void,
    _timed_out: windows_sys::Win32::Foundation::BOOLEAN,
) {
    // SAFETY: `context` is the `exit_tx` of a live `Inner` (see
    // `register_wait`).
    let tx = unsafe { &*context.cast::<tokio::sync::watch::Sender<bool>>() };
    tx.send_replace(true);
}

#[cfg(all(unix, not(target_os = "linux")))]
impl ProcWatch {
    fn open_inner(_pid: u32, _expect_start: Option<u64>) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ProcWatch is not implemented on this OS yet",
        ))
    }

    pub fn has_exited(&self) -> bool {
        self.inner.exited.load(Ordering::SeqCst)
    }

    pub async fn exited(&self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ProcWatch is not implemented on this OS yet",
        ))
    }

    pub fn signal(&self, _sig: Sig) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ProcWatch is not implemented on this OS yet",
        ))
    }

    #[allow(dead_code)] // the Unix tag backend's sweep; macOS fills it in (Task 7)
    pub(crate) fn send(&self, _signum: i32) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ProcWatch is not implemented on this OS yet",
        ))
    }
}

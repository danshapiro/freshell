//! `ProcWatch`: an event-driven exit watch on ONE process incarnation, and
//! signals that can only ever reach that incarnation.
//!
//! Linux uses a pidfd: it pins the incarnation at open (a recycled pid is a
//! different process the pidfd never names), it becomes readable exactly when
//! the process exits (zombies count), and `pidfd_send_signal` through it can
//! never reach a recycled pid. No polling anywhere: `exited` waits on the
//! pidfd's readiness in the tokio reactor. Windows and macOS bodies land in
//! later tasks behind the same API (until then `open` answers
//! `ErrorKind::Unsupported`).

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

#[cfg(not(target_os = "linux"))]
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

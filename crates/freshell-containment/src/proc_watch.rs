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
//! macOS uses a kqueue `EVFILT_PROC`/`NOTE_EXIT` registration made at
//! `open`, with one blocking `kevent` thread per awaited watch publishing to
//! a `tokio::sync::watch` (started by the first `exited` await). macOS has
//! no pinning handle, and a process that has begun exiting is already
//! invisible to a late registration and to a plain lookup while its
//! descriptors (and any `flock` it holds) may still be open. So "exited" is
//! concluded only from a `NOTE_EXIT` on a registration made before the exit
//! began, from the zombie-aware lookup showing it a zombie (`SZOMB`, set
//! after `NOTE_EXIT`), or from that lookup answering that it was reaped;
//! never from a refused registration alone. A watch opened on an exiting
//! process re-reads it 1 s and 5 s after each waiter starts and on each
//! unlock of the unit's lock files (`watch_lock_paths`); when the 5 s read
//! still finds no proof, `exited()` answers an error instead of waiting
//! forever (no event marks the end of such an exit), and a later await
//! waits again. `signal` re-checks the start time through the zombie-aware
//! lookup, then sends with `kill(2)`.

use std::io;
use std::path::PathBuf;
#[cfg(any(target_os = "linux", windows))]
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
    #[cfg(any(target_os = "linux", windows))]
    exited: AtomicBool,
    /// The kqueue registration, its waiter thread and its published state.
    #[cfg(target_os = "macos")]
    mac: Arc<mac::Shared>,
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

    /// Hands the unit's lock files to this watch: on macOS a watch opened
    /// while its process was already exiting re-reads the process on each
    /// unlock of one of them (the release it waits for). Elsewhere an exit
    /// watch needs no help.
    #[cfg(not(target_os = "macos"))]
    pub(crate) fn watch_lock_paths(&self, _paths: &[PathBuf]) {}
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

#[cfg(target_os = "macos")]
impl ProcWatch {
    fn open_inner(pid: u32, expect_start: Option<u64>) -> io::Result<Self> {
        use crate::darwin::{self, Kqueue};
        let gone = || io::Error::new(io::ErrorKind::NotFound, "process gone");
        let kq = Kqueue::new()?;
        let registered = kq.change(
            pid as usize,
            libc::EVFILT_PROC,
            libc::EV_ADD | libc::EV_ONESHOT,
            libc::NOTE_EXIT,
        );
        let (info, opened) = match registered {
            Ok(()) => {
                // Read after the registration pinned an incarnation. An exit
                // event already pending means the registered process has
                // exited: `info` names it only if this pid now shows that
                // incarnation as a zombie, or no process at all.
                let info = darwin::bsdinfo(pid).map_err(|_| gone())?;
                if mac::exit_event(&kq.wait(Some(std::time::Duration::ZERO))?) {
                    match darwin::bsdinfo(pid) {
                        Ok(now)
                            if darwin::start_of(&now) == darwin::start_of(&info)
                                && darwin::is_zombie(&now) => {}
                        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                        _ => return Err(gone()),
                    }
                    (info, mac::Opened::Exited)
                } else {
                    (info, mac::Opened::Live)
                }
            }
            // A zombie, or a process that has begun exiting (its descriptors
            // may still be open): refused registration alone proves nothing.
            Err(err) if err.raw_os_error() == Some(libc::ESRCH) => {
                let info = darwin::bsdinfo(pid).map_err(|_| gone())?;
                let opened = if darwin::is_zombie(&info) {
                    mac::Opened::Exited
                } else {
                    mac::Opened::Exiting
                };
                (info, opened)
            }
            Err(err) => return Err(err),
        };
        let identity = ProcIdentity {
            pid,
            start: darwin::start_of(&info),
            name: darwin::name_of(&info),
        };
        if expect_start.is_some_and(|s| s != identity.start) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "different incarnation",
            ));
        }
        let shared = Arc::new(mac::Shared::new(kq, &identity, opened));
        Ok(Self {
            inner: Arc::new(Inner {
                identity,
                mac: shared,
            }),
        })
    }

    /// Test support: a watch in the state `open` gives a process whose exit
    /// had already begun (no exit registration), here on a process that may
    /// still run, so the exiting state's waiting can be tested on a process
    /// that never proves its exit.
    #[cfg(test)]
    pub(crate) fn open_as_exiting_for_test(pid: u32) -> io::Result<Self> {
        use crate::darwin::{self, Kqueue};
        let info = darwin::bsdinfo(pid)?;
        let identity = ProcIdentity {
            pid,
            start: darwin::start_of(&info),
            name: darwin::name_of(&info),
        };
        let shared = Arc::new(mac::Shared::new(
            Kqueue::new()?,
            &identity,
            mac::Opened::Exiting,
        ));
        Ok(Self {
            inner: Arc::new(Inner {
                identity,
                mac: shared,
            }),
        })
    }

    /// Non-blocking: is the process proven to have exited (zombies count)?
    /// A pending exit event is collected; a watch opened while its process
    /// was already exiting re-reads it (one zombie-aware lookup).
    pub fn has_exited(&self) -> bool {
        self.inner.mac.has_exited()
    }

    /// Resolves when the process has exited, by one of the proofs in the
    /// module docs. The first await starts the watch's waiter thread; a
    /// thread that cannot be started, a wait that fails, or (for a watch
    /// opened on an exiting process) an exit still unproven at the last
    /// deadline answers `Err`, and a later await starts a new one. Needs no
    /// particular runtime.
    pub async fn exited(&self) -> io::Result<()> {
        let shared = &self.inner.mac;
        if shared.has_exited() {
            return Ok(());
        }
        let mut rx = shared.subscribe();
        mac::Shared::start_waiter(shared)?;
        let outcome = rx
            .wait_for(Option::is_some)
            .await
            .map_err(|_| io::Error::other("exit watch closed"))?
            .clone();
        match outcome {
            Some(Err(msg)) => Err(io::Error::other(msg)),
            _ => Ok(()),
        }
    }

    /// See the cross-platform declaration: on macOS the files are registered
    /// for `NOTE_FUNLOCK` only on a watch opened while its process was
    /// exiting.
    pub(crate) fn watch_lock_paths(&self, paths: &[PathBuf]) {
        self.inner.mac.watch_lock_paths(paths);
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
    /// SIGSTOP and SIGCONT): the pid is re-checked to be this incarnation,
    /// alive, right before `kill(2)`. An exited process is Ok(()).
    pub(crate) fn send(&self, signum: i32) -> io::Result<()> {
        use crate::darwin;
        if self.has_exited() {
            return Ok(());
        }
        match darwin::bsdinfo(self.pid()) {
            Ok(info)
                if darwin::start_of(&info) == self.inner.identity.start
                    && !darwin::is_zombie(&info) => {}
            _ => return Ok(()),
        }
        // SAFETY: plain kill(2) of a pid just verified to be this
        // incarnation (pids are handed out in order, so one exiting and
        // being reused in between is not a practical concern).
        if unsafe { libc::kill(self.pid() as libc::pid_t, signum) } != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                return Err(err);
            }
        }
        Ok(())
    }
}

/// The macOS watch state shared by a `ProcWatch` and its waiter thread.
#[cfg(target_os = "macos")]
mod mac {
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::{Duration, Instant};

    use crate::darwin::{self, Kqueue};
    use crate::process::ProcIdentity;

    /// A watch opened on a process that had already begun exiting has no
    /// exit event to wait for: each waiter re-reads it at these deadlines
    /// after it starts (one-shot reads at deadlines, not an interval), and
    /// when the last one passes without a proof the wait answers an error
    /// instead of waiting forever (a later await starts a new waiter).
    const EXITING_RECHECKS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(5)];

    /// What `open` found.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum Opened {
        /// Registered before any exit: its `NOTE_EXIT` will come.
        Live,
        /// Refused because the process had begun exiting.
        Exiting,
        /// Already proven exited.
        Exited,
    }

    /// `None` while waiting; `Some(Ok)` once exited; `Some(Err)` when the
    /// waiter thread stopped on an error (the next await starts another).
    type State = Option<Result<(), String>>;

    pub(super) struct Shared {
        kq: Kqueue,
        pid: u32,
        start: u64,
        exiting: bool,
        exited: AtomicBool,
        state: tokio::sync::watch::Sender<State>,
        /// Whether a waiter thread is running.
        waiter: Mutex<bool>,
        /// The watch was dropped: the waiter thread returns.
        shutdown: AtomicBool,
        /// Lock files registered for `NOTE_FUNLOCK` (kept open while
        /// registered).
        lock_files: Mutex<Vec<std::fs::File>>,
    }

    fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        m.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether `events` hold the registered process's exit.
    pub(super) fn exit_event(events: &[libc::kevent]) -> bool {
        events
            .iter()
            .any(|e| e.filter == libc::EVFILT_PROC && e.fflags & libc::NOTE_EXIT != 0)
    }

    impl Shared {
        pub(super) fn new(kq: Kqueue, identity: &ProcIdentity, opened: Opened) -> Self {
            let exited = opened == Opened::Exited;
            Self {
                kq,
                pid: identity.pid,
                start: identity.start,
                exiting: opened == Opened::Exiting,
                exited: AtomicBool::new(exited),
                state: tokio::sync::watch::channel(exited.then_some(Ok(()))).0,
                waiter: Mutex::new(false),
                shutdown: AtomicBool::new(false),
                lock_files: Mutex::new(Vec::new()),
            }
        }

        pub(super) fn subscribe(&self) -> tokio::sync::watch::Receiver<State> {
            self.state.subscribe()
        }

        pub(super) fn has_exited(&self) -> bool {
            if self.exited.load(Ordering::SeqCst) {
                return true;
            }
            let proven = if self.exiting {
                darwin::proven_exited(self.pid, self.start)
            } else {
                self.kq
                    .wait(Some(Duration::ZERO))
                    .is_ok_and(|events| exit_event(&events))
            };
            if proven {
                self.mark_exited();
            }
            proven
        }

        fn mark_exited(&self) {
            if !self.exited.swap(true, Ordering::SeqCst) {
                self.state.send_replace(Some(Ok(())));
            }
            // A waiter thread, if one runs, has nothing left to wait for.
            let _ = self.kq.wake();
        }

        /// Starts the waiter thread unless one runs (clearing the error of
        /// one that stopped).
        pub(super) fn start_waiter(shared: &Arc<Self>) -> io::Result<()> {
            let mut running = lock(&shared.waiter);
            if *running {
                return Ok(());
            }
            shared.state.send_if_modified(|state| {
                let failed = matches!(state, Some(Err(_)));
                if failed {
                    *state = None;
                }
                failed
            });
            let thread_shared = shared.clone();
            std::thread::Builder::new()
                .name("freshell-procwatch".into())
                .stack_size(64 * 1024)
                .spawn(move || thread_shared.wait_for_exit())?;
            *running = true;
            Ok(())
        }

        /// The waiter thread: blocks in `kevent` until the exit event, the
        /// watch's drop, or (for a watch opened on an exiting process) a
        /// moment to re-read the process: one of its deadlines, or an
        /// unlock event. Such a watch's wait ends with an error at its last
        /// deadline when the exit is still unproven.
        fn wait_for_exit(&self) {
            let started = Instant::now();
            let mut rechecks: Vec<Instant> = if self.exiting {
                EXITING_RECHECKS
                    .iter()
                    .rev()
                    .map(|after| started + *after)
                    .collect()
            } else {
                Vec::new()
            };
            loop {
                if self.shutdown.load(Ordering::SeqCst) || self.exited.load(Ordering::SeqCst) {
                    return;
                }
                let timeout = rechecks
                    .last()
                    .map(|at| at.saturating_duration_since(Instant::now()));
                let events = match self.kq.wait(timeout) {
                    Ok(events) => events,
                    Err(err) => return self.stop_waiting(format!("exit watch failed: {err}")),
                };
                let now = Instant::now();
                let mut deadline_passed = false;
                while rechecks.last().is_some_and(|at| now >= *at) {
                    rechecks.pop();
                    deadline_passed = true;
                }
                if exit_event(&events)
                    || (self.exiting && darwin::proven_exited(self.pid, self.start))
                {
                    self.mark_exited();
                    return;
                }
                if self.exiting && deadline_passed && rechecks.is_empty() {
                    return self.stop_waiting(format!(
                        "exit not proven: process {} had begun exiting when it was watched and was still exiting {}s later",
                        self.pid,
                        EXITING_RECHECKS[EXITING_RECHECKS.len() - 1].as_secs()
                    ));
                }
            }
        }

        /// Ends this waiter with an error; the next await starts another.
        /// An exit another thread proved meanwhile (`has_exited()`) wins:
        /// it is never replaced by the error, published or about to be.
        fn stop_waiting(&self, error: String) {
            let mut running = lock(&self.waiter);
            *running = false;
            self.state.send_if_modified(|state| {
                if self.exited.load(Ordering::SeqCst) || matches!(state, Some(Ok(()))) {
                    return false;
                }
                *state = Some(Err(error));
                true
            });
        }

        /// Registers `NOTE_FUNLOCK` on each lock file, on a watch opened
        /// while its process was exiting (the only one that needs it).
        pub(super) fn watch_lock_paths(&self, paths: &[PathBuf]) {
            if !self.exiting || self.exited.load(Ordering::SeqCst) {
                return;
            }
            let mut files = lock(&self.lock_files);
            for path in paths {
                let Ok(file) = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_EVTONLY)
                    .open(path)
                else {
                    continue;
                };
                let registered = self.kq.change(
                    file.as_raw_fd() as usize,
                    libc::EVFILT_VNODE,
                    libc::EV_ADD | libc::EV_CLEAR,
                    darwin::NOTE_FUNLOCK,
                );
                if registered.is_ok() {
                    files.push(file);
                }
            }
        }
    }

    /// The last `ProcWatch` clone is gone: its waiter thread returns.
    impl Drop for super::Inner {
        fn drop(&mut self) {
            self.mac.shutdown.store(true, Ordering::SeqCst);
            let _ = self.mac.kq.wake();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// An exiting watch's state, as its awaiters see it, of the test
        /// process itself (nothing is signalled).
        fn exiting_watch() -> Shared {
            let identity = ProcIdentity {
                pid: std::process::id(),
                start: 0,
                name: String::new(),
            };
            Shared::new(Kqueue::new().unwrap(), &identity, Opened::Exiting)
        }

        /// A waiter giving up at its last deadline never replaces an exit
        /// that another thread's `has_exited()` proved at the same moment,
        /// published or about to be: its awaiters see the exit, not an
        /// error. With no proof, giving up answers the error.
        #[test]
        fn a_waiter_giving_up_never_replaces_a_proven_exit() {
            let published = exiting_watch();
            published.mark_exited();
            published.stop_waiting("exit not proven".into());
            assert_eq!(*published.subscribe().borrow(), Some(Ok(())));

            let proving = exiting_watch();
            // `mark_exited` sets the flag before it publishes.
            proving.exited.store(true, Ordering::SeqCst);
            proving.stop_waiting("exit not proven".into());
            assert_eq!(*proving.subscribe().borrow(), None);

            let unproven = exiting_watch();
            unproven.stop_waiting("exit not proven".into());
            assert_eq!(
                *unproven.subscribe().borrow(),
                Some(Err("exit not proven".into()))
            );
        }
    }
}

/// macOS: the waiting of a watch opened while its process was exiting.
#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    use super::{ProcWatch, Sig};

    /// A `/bin/sleep 600` child of the test, killed through a watch opened
    /// while it runs (so its pid names it) and reaped on drop.
    struct Sleeper {
        child: Child,
        pin: ProcWatch,
    }

    impl Sleeper {
        fn start() -> Self {
            let child = Command::new("/bin/sleep").arg("600").spawn().unwrap();
            let pin = ProcWatch::open(child.id()).unwrap();
            Self { child, pin }
        }
    }

    impl Drop for Sleeper {
        fn drop(&mut self) {
            let _ = self.pin.signal(Sig::Kill);
            let _ = self.child.wait();
        }
    }

    /// No event marks the end of an exit that had begun before the watch
    /// was opened (the kernel refuses the registration then), so such a
    /// watch re-reads its process only at its deadlines and at unlocks of
    /// its lock files. When its last deadline passes with no proof of the
    /// exit, `exited()` answers an error instead of waiting forever, and
    /// never a false "exited". A later await waits again, and proves the
    /// exit once the process is a zombie.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_exiting_watch_answers_at_its_last_deadline_instead_of_waiting_forever() {
        let sleeper = Sleeper::start();
        let watch = ProcWatch::open_as_exiting_for_test(sleeper.child.id()).unwrap();
        let started = Instant::now();
        let answer = tokio::time::timeout(Duration::from_secs(20), watch.exited())
            .await
            .expect("a watch on an exiting process waited past its last deadline");
        assert!(
            answer.is_err(),
            "a running process was reported exited after {:?}",
            started.elapsed()
        );
        assert!(!watch.has_exited(), "a running process was reported exited");
        sleeper.pin.signal(Sig::Kill).unwrap();
        tokio::time::timeout(Duration::from_secs(5), sleeper.pin.exited())
            .await
            .expect("the kill ended the sleeper")
            .unwrap();
        // The unreaped child is a zombie now: the exiting watch proves it.
        tokio::time::timeout(Duration::from_secs(10), watch.exited())
            .await
            .expect("a later await proves the exit")
            .unwrap();
        assert!(watch.has_exited());
    }
}

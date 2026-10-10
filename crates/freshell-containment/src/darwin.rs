//! macOS kernel interfaces the crate reads: libproc process and descriptor
//! facts, `KERN_PROCARGS2`, code-signing status, the responsible process,
//! and kqueue. Structures and constants that `libc` lacks for this target
//! are declared here exactly as in `<sys/proc_info.h>`, `<sys/event.h>`
//! and `<sys/codesign.h>`.
//!
//! Every process lookup is zombie-aware (`proc_pidinfo(.., PROC_PIDTBSDINFO,
//! 1, ..)`): with `arg` 0 the kernel already answers ESRCH for a process
//! that has begun exiting, while its descriptors (and any `flock` it holds)
//! may still be open; with `arg` 1 it also searches its zombie list.

use std::ffi::{c_int, c_void};
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// `<sys/proc_info.h>`: `proc_pidfdinfo` flavors.
const PROC_PIDFDVNODEINFO: c_int = 1;
const PROC_PIDFDSOCKETINFO: c_int = 3;
/// `fi_openflags`: the open file holds (or held) a `flock` lock
/// (`FWASLOCKED`).
pub(crate) const FHASLOCK: u32 = 0x4000;
/// `soi_kind` of a TCP socket.
pub(crate) const SOCKINFO_TCP: c_int = 2;
/// `tcpsi_state` of a listening TCP socket.
pub(crate) const TSI_S_LISTEN: c_int = 1;

/// `<sys/event.h>`: the file was unlocked by `flock(2)` or `close(2)`.
pub(crate) const NOTE_FUNLOCK: u32 = 0x0000_0100;

/// `<sys/codesign.h>`.
const CS_OPS_STATUS: libc::c_uint = 0;
/// The program is restricted (signed with entitlements): with System
/// Integrity Protection on, the kernel withholds its environment from
/// every other process.
pub(crate) const CS_RESTRICT: u32 = 0x0000_0800;

/// `struct proc_fileinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct ProcFileInfo {
    pub fi_openflags: u32,
    pub fi_status: u32,
    pub fi_offset: libc::off_t,
    pub fi_type: i32,
    pub fi_guardflags: u32,
}

/// `struct vnode_fdinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct VnodeFdInfo {
    pub pfi: ProcFileInfo,
    pub pvi: libc::vnode_info,
}

/// `struct sockbuf_info`.
#[repr(C)]
#[derive(Clone, Copy)]
struct SockbufInfo {
    sbi_cc: u32,
    sbi_hiwat: u32,
    sbi_mbcnt: u32,
    sbi_mbmax: u32,
    sbi_lowat: u32,
    sbi_flags: i16,
    sbi_timeo: i16,
}

/// `struct in4in6_addr`.
#[repr(C)]
#[derive(Clone, Copy)]
struct In4In6Addr {
    i46a_pad32: [u32; 3],
    i46a_addr4: u32,
}

/// The `insi_faddr` / `insi_laddr` union (`struct in6_addr` is 16 bytes
/// aligned to 4).
#[repr(C)]
#[derive(Clone, Copy)]
union InAddr46 {
    ina_46: In4In6Addr,
    ina_6: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InsiV4 {
    in4_tos: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InsiV6 {
    in6_hlim: u8,
    in6_cksum: i32,
    in6_ifindex: u16,
    in6_hops: i16,
}

/// `struct in_sockinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct InSockInfo {
    insi_fport: i32,
    /// The local port, in network byte order in the low 16 bits.
    pub insi_lport: i32,
    insi_gencnt: u64,
    insi_flags: u32,
    insi_flow: u32,
    insi_vflag: u8,
    insi_ip_ttl: u8,
    rfu_1: u32,
    insi_faddr: InAddr46,
    insi_laddr: InAddr46,
    insi_v4: InsiV4,
    insi_v6: InsiV6,
}

/// `struct tcp_sockinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct TcpSockInfo {
    pub tcpsi_ini: InSockInfo,
    pub tcpsi_state: i32,
    tcpsi_timer: [i32; 4],
    tcpsi_mss: i32,
    tcpsi_flags: u32,
    rfu_1: u32,
    tcpsi_tp: u64,
}

/// `soi_proto`: only the TCP member is read; `largest` gives the union the
/// size of its largest member (`struct un_sockinfo`, 528 bytes).
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) union SoiProto {
    pub pri_tcp: TcpSockInfo,
    largest: [u64; 66],
}

/// `struct socket_info`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct SocketInfo {
    soi_stat: libc::vinfo_stat,
    soi_so: u64,
    soi_pcb: u64,
    soi_type: i32,
    soi_protocol: i32,
    soi_family: i32,
    soi_options: i16,
    soi_linger: i16,
    soi_state: i16,
    soi_qlen: i16,
    soi_incqlen: i16,
    soi_qlimit: i16,
    soi_timeo: i16,
    soi_error: u16,
    soi_oobmark: u32,
    soi_rcv: SockbufInfo,
    soi_snd: SockbufInfo,
    pub soi_kind: i32,
    rfu_1: u32,
    pub soi_proto: SoiProto,
}

/// `struct socket_fdinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct SocketFdInfo {
    pfi: ProcFileInfo,
    pub psi: SocketInfo,
}

// The kernel answers with exactly these sizes (`PROC_PIDFDVNODEINFO_SIZE`,
// `PROC_PIDFDSOCKETINFO_SIZE`); a wrong field list would misplace the
// fields read.
const _: () = assert!(size_of::<VnodeFdInfo>() == 176);
const _: () = assert!(size_of::<SocketFdInfo>() == 792);

extern "C" {
    fn csops(
        pid: libc::pid_t,
        ops: libc::c_uint,
        useraddr: *mut c_void,
        usersize: libc::size_t,
    ) -> c_int;
}

fn last_error() -> io::Error {
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        io::Error::new(io::ErrorKind::NotFound, "process gone")
    } else {
        err
    }
}

/// The BSD facts of `pid`, zombies included (see the module docs).
/// `ErrorKind::NotFound` once it has been reaped.
pub(crate) fn bsdinfo(pid: u32) -> io::Result<libc::proc_bsdinfo> {
    let size = size_of::<libc::proc_bsdinfo>() as c_int;
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: a writable buffer of `size` bytes.
    let got = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDTBSDINFO,
            1,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if got <= 0 {
        return Err(last_error());
    }
    if got != size {
        return Err(io::Error::other("short proc_bsdinfo"));
    }
    // SAFETY: the kernel filled all `size` bytes of the zeroed buffer.
    Ok(unsafe { info.assume_init() })
}

/// The start time of a process, in microseconds since the epoch.
pub(crate) fn start_of(info: &libc::proc_bsdinfo) -> u64 {
    info.pbi_start_tvsec
        .saturating_mul(1_000_000)
        .saturating_add(info.pbi_start_tvusec)
}

/// Whether the kernel has finished this process's exit (`SZOMB`: it posts
/// `NOTE_EXIT` before setting it, after closing every descriptor).
pub(crate) fn is_zombie(info: &libc::proc_bsdinfo) -> bool {
    info.pbi_status == libc::SZOMB
}

/// The process name: `pbi_name`, or `pbi_comm` when that is empty.
pub(crate) fn name_of(info: &libc::proc_bsdinfo) -> String {
    let text = |raw: &[libc::c_char]| {
        let bytes: Vec<u8> = raw
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let name = text(&info.pbi_name);
    if name.is_empty() {
        text(&info.pbi_comm)
    } else {
        name
    }
}

/// Whether the zombie-aware lookup proves that the incarnation `(pid,
/// start)` has finished exiting: it is a zombie, it was reaped, or the pid
/// names a later process now.
pub(crate) fn proven_exited(pid: u32, start: u64) -> bool {
    match bsdinfo(pid) {
        Ok(info) => start_of(&info) != start || is_zombie(&info),
        Err(err) => err.kind() == io::ErrorKind::NotFound,
    }
}

/// Every pid the kernel lists (live, exiting and zombie processes).
pub(crate) fn all_pids() -> Vec<u32> {
    // SAFETY: a buffer of the size passed (or none, for the estimate).
    list_pids(|buf, size| unsafe { libc::proc_listallpids(buf, size) })
}

/// The pids whose parent is `ppid`.
pub(crate) fn child_pids(ppid: u32) -> Vec<u32> {
    // SAFETY: a buffer of the size passed (or none, for the estimate).
    list_pids(|buf, size| unsafe { libc::proc_listchildpids(ppid as libc::pid_t, buf, size) })
}

/// One libproc pid listing. `call(NULL, 0)` estimates the count; a list
/// that filled the whole buffer may have been cut short and is read again
/// into a larger one.
fn list_pids(call: impl Fn(*mut c_void, c_int) -> c_int) -> Vec<u32> {
    let estimate = call(std::ptr::null_mut(), 0);
    let mut capacity = usize::try_from(estimate).unwrap_or(0).max(64) + 64;
    for _ in 0..8 {
        let mut buf: Vec<libc::pid_t> = vec![0; capacity];
        let bytes = c_int::try_from(capacity * size_of::<libc::pid_t>()).unwrap_or(c_int::MAX);
        let count = call(buf.as_mut_ptr().cast(), bytes);
        let Ok(count) = usize::try_from(count) else {
            return Vec::new();
        };
        if count < capacity {
            buf.truncate(count);
            return buf
                .into_iter()
                .filter(|pid| *pid > 0)
                .map(|pid| pid as u32)
                .collect();
        }
        capacity *= 2;
    }
    Vec::new()
}

/// The open descriptors of `pid` (`PROC_PIDLISTFDS`). `NotFound` when the
/// process is gone or has begun exiting (its table is no longer readable).
pub(crate) fn fds(pid: u32) -> io::Result<Vec<libc::proc_fdinfo>> {
    let entry = size_of::<libc::proc_fdinfo>();
    // SAFETY: no buffer: the kernel answers the size it needs.
    let needed = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return Err(last_error());
    }
    let capacity = needed as usize / entry + 32;
    let mut buf = vec![
        libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0,
        };
        capacity
    ];
    // SAFETY: a writable buffer of the size passed.
    let got = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDLISTFDS,
            0,
            buf.as_mut_ptr().cast(),
            (capacity * entry) as c_int,
        )
    };
    if got <= 0 {
        return Err(last_error());
    }
    buf.truncate(got as usize / entry);
    Ok(buf)
}

/// The vnode facts of descriptor `fd` of `pid` (open flags and the file's
/// stat). The kernel fills the stat from the filesystem for every vnode
/// descriptor it is asked about (macOS has no cached-only stat).
pub(crate) fn vnode_fd_info(pid: u32, fd: i32) -> Option<VnodeFdInfo> {
    fd_info(pid, fd, PROC_PIDFDVNODEINFO)
}

/// The socket facts of descriptor `fd` of `pid`.
pub(crate) fn socket_fd_info(pid: u32, fd: i32) -> Option<SocketFdInfo> {
    fd_info(pid, fd, PROC_PIDFDSOCKETINFO)
}

fn fd_info<T: Copy>(pid: u32, fd: i32, flavor: c_int) -> Option<T> {
    let size = size_of::<T>() as c_int;
    let mut info = MaybeUninit::<T>::zeroed();
    // SAFETY: a writable buffer of `size` bytes.
    let got =
        unsafe { libc::proc_pidfdinfo(pid as c_int, fd, flavor, info.as_mut_ptr().cast(), size) };
    // SAFETY: the kernel filled all `size` bytes of the zeroed buffer.
    (got == size).then(|| unsafe { info.assume_init() })
}

/// The code-signing status flags of `pid` (`csops(CS_OPS_STATUS)`, which
/// needs no privilege), or `None` when they cannot be read.
pub(crate) fn cs_flags(pid: u32) -> Option<u32> {
    let mut flags: u32 = 0;
    // SAFETY: a valid out-pointer of the size passed.
    let rc = unsafe {
        csops(
            pid as libc::pid_t,
            CS_OPS_STATUS,
            (&mut flags as *mut u32).cast(),
            size_of::<u32>(),
        )
    };
    (rc == 0).then_some(flags)
}

/// `kern.argmax`: the largest argument area `KERN_PROCARGS2` can return.
fn argmax() -> usize {
    static ARGMAX: OnceLock<usize> = OnceLock::new();
    *ARGMAX.get_or_init(|| {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut value: c_int = 0;
        let mut size = size_of::<c_int>();
        // SAFETY: a two-entry name and an out-buffer of the size passed.
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&mut value as *mut c_int).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && value > 0 {
            value as usize
        } else {
            1 << 20
        }
    })
}

/// The raw `KERN_PROCARGS2` area of `pid`. Read into a buffer of
/// `kern.argmax` bytes: a smaller one would receive only the tail of the
/// area. EINVAL when the process is gone, is exiting, or belongs to
/// another user.
pub(crate) fn procargs(pid: u32) -> io::Result<Vec<u8>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as c_int];
    let mut buf = vec![0u8; argmax()];
    let mut size = buf.len();
    // SAFETY: a three-entry name and an out-buffer of the size passed.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(size);
    Ok(buf)
}

/// The responsible-process functions are private libSystem symbols,
/// resolved at run time (as LLDB and Chromium resolve the disclaim one).
type GetResponsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
pub(crate) type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

fn symbol(name: &std::ffi::CStr) -> Option<*mut c_void> {
    // SAFETY: a NUL-terminated name looked up in every loaded image.
    let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!found.is_null()).then_some(found)
}

/// `responsibility_get_pid_responsible_for_pid`, when this macOS has it.
fn get_responsible() -> Option<GetResponsible> {
    static FOUND: OnceLock<Option<usize>> = OnceLock::new();
    let address = (*FOUND.get_or_init(|| {
        symbol(c"responsibility_get_pid_responsible_for_pid").map(|p| p as usize)
    }))?;
    // SAFETY: the libSystem function of this exact signature.
    Some(unsafe { std::mem::transmute::<usize, GetResponsible>(address) })
}

/// `responsibility_spawnattrs_setdisclaim`, when this macOS has it.
pub(crate) fn set_disclaim() -> Option<SetDisclaim> {
    let address = symbol(c"responsibility_spawnattrs_setdisclaim")? as usize;
    // SAFETY: the libSystem function of this exact signature.
    Some(unsafe { std::mem::transmute::<usize, SetDisclaim>(address) })
}

/// The responsible process of `pid` (the process the system holds
/// responsible for it: itself after a disclaimed spawn, else inherited from
/// its parent at fork and kept through `setsid`, exec and reparenting).
/// `None` when it cannot be read or the function does not exist here.
pub(crate) fn responsible_pid(pid: u32) -> Option<u32> {
    let get = get_responsible()?;
    // SAFETY: a plain pid argument.
    let responsible = unsafe { get(pid as libc::pid_t) };
    u32::try_from(responsible).ok().filter(|r| *r > 0)
}

/// A kqueue (closed on drop, never inherited by a child).
pub(crate) struct Kqueue(OwnedFd);

/// The `EVFILT_USER` identifier every crate kqueue registers to be woken.
pub(crate) const WAKE: usize = 1;

impl Kqueue {
    /// A new kqueue with the `WAKE` user event registered.
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: plain kqueue(2).
        let raw = unsafe { libc::kqueue() };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh descriptor this call owns exclusively.
        let kq = Self(unsafe { OwnedFd::from_raw_fd(raw) });
        // SAFETY: setting FD_CLOEXEC on our own descriptor.
        unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) };
        kq.change(WAKE, libc::EVFILT_USER, libc::EV_ADD | libc::EV_CLEAR, 0)?;
        Ok(kq)
    }

    /// Applies one change; the kernel's refusal (for example ESRCH for a
    /// process that is gone or exiting) is returned as the error.
    pub(crate) fn change(
        &self,
        ident: usize,
        filter: i16,
        flags: u16,
        fflags: u32,
    ) -> io::Result<()> {
        let change = libc::kevent {
            ident,
            filter,
            flags,
            fflags,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: one valid change and no event buffer.
        let rc = unsafe {
            libc::kevent(
                self.0.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Wakes a thread blocked in [`Kqueue::wait`].
    pub(crate) fn wake(&self) -> io::Result<()> {
        self.change(WAKE, libc::EVFILT_USER, 0, libc::NOTE_TRIGGER)
    }

    /// Blocks until at least one event is pending or `timeout` passes
    /// (`None`: no deadline; zero: only collect what is pending). A signal
    /// interruption waits again for the time left.
    pub(crate) fn wait(&self, timeout: Option<Duration>) -> io::Result<Vec<libc::kevent>> {
        let deadline = timeout.map(|t| Instant::now() + t);
        let mut events = vec![
            libc::kevent {
                ident: 0,
                filter: 0,
                flags: 0,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            8
        ];
        loop {
            let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
            let spec = left.map(|left| libc::timespec {
                tv_sec: left.as_secs() as libc::time_t,
                tv_nsec: left.subsec_nanos() as libc::c_long,
            });
            let spec_ptr = spec
                .as_ref()
                .map_or(std::ptr::null(), |s| s as *const libc::timespec);
            // SAFETY: no changes and a writable event buffer of the size passed.
            let n = unsafe {
                libc::kevent(
                    self.0.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    events.len() as c_int,
                    spec_ptr,
                )
            };
            if n >= 0 {
                events.truncate(n as usize);
                return Ok(events);
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
    }
}

//! `ProcWatch::exited` answers `Err` instead of panicking when it cannot
//! register the watch because this process has no file descriptor left
//! (a panic there would poison every waiter of a stop), and a failed
//! registration is not cached: once descriptors are available again, the
//! same watch confirms the exit.
//!
//! This is its own test binary because it lowers this process's soft
//! `RLIMIT_NOFILE`, which every thread of the process shares; its tests
//! take [`LIMIT`] in turn. Every process signalled here was spawned here,
//! and only through its own pidfd.
#![cfg(target_os = "linux")]

use std::time::Duration;

use freshell_containment::{
    is_process_gone, Containment, ProcWatch, SelectOptions, Sig, UnitId, UnitLabel, UNIT_ENV,
};

/// Held by each test while it lowers the limit, so no other test's thread
/// opens a descriptor meanwhile (a tokio lock: one test holds it across
/// awaits).
static LIMIT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn own_limits() -> libc::rlimit {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    lim
}

fn set_own_limits(lim: &libc::rlimit) {
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, lim) }, 0);
}

/// The lowest file descriptor number this process could open next (a new
/// descriptor always gets the lowest free number; this one is closed again).
fn lowest_free_fd() -> libc::c_int {
    use std::os::fd::AsRawFd;
    let probe = std::fs::File::open("/dev/null").expect("open /dev/null");
    probe.as_raw_fd()
}

/// Start `sleep` as a grandchild (its `sh` parent exits at once), so the test
/// process is never its parent.
fn spawn_grandchild_sleep() -> u32 {
    let out = std::process::Command::new("sh")
        .args(["-c", "sleep 600 >/dev/null 2>&1 & echo $!"])
        .output()
        .expect("spawn sh");
    String::from_utf8(out.stdout)
        .expect("utf8 pid")
        .trim()
        .parse()
        .expect("numeric pid")
}

/// Kills the watched grandchild through its pidfd when dropped, so a failing
/// (even panicking) run leaves nothing behind.
struct KillOnDrop(ProcWatch);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.signal(Sig::Kill);
    }
}

// current_thread: no worker thread can open a descriptor while the limit is
// lowered.
#[tokio::test(flavor = "current_thread")]
async fn exited_returns_an_error_instead_of_panicking_when_no_fd_is_left() {
    let _limit = LIMIT.lock().await;
    let pid = spawn_grandchild_sleep();
    let guard = KillOnDrop(ProcWatch::open(pid).expect("open the watch"));
    let watch = guard.0.clone();
    assert!(!watch.has_exited());

    // Every descriptor below the soft limit is now in use: the duplicate
    // pidfd the registration needs cannot be opened.
    let original = own_limits();
    let exhausted = libc::rlimit {
        rlim_cur: lowest_free_fd() as libc::rlim_t,
        rlim_max: original.rlim_max,
    };
    set_own_limits(&exhausted);
    let starved = tokio::time::timeout(Duration::from_secs(5), watch.exited()).await;
    set_own_limits(&original);

    let err = starved
        .expect("an exhausted registration answers at once")
        .expect_err("no descriptor left: the watch cannot be registered");
    assert_eq!(err.raw_os_error(), Some(libc::EMFILE), "{err}");

    // The failure was not cached: with descriptors available again the same
    // watch registers and confirms the exit.
    watch.signal(Sig::Kill).expect("kill through the pidfd");
    tokio::time::timeout(Duration::from_secs(5), watch.exited())
        .await
        .expect("the exit is confirmed in time")
        .expect("the watch registers once descriptors are available");
    assert!(watch.has_exited());
}

/// Once the pidfd pins the process, a failed read of its start time means
/// "process gone" only when the process is gone. A live process whose
/// `/proc/<pid>/stat` cannot be opened for want of a descriptor passes the
/// error through: a caller that skips a gone member (the stop's member
/// pinning, the kill passes) must never skip this live one.
#[test]
fn a_live_process_whose_start_time_cannot_be_read_is_not_process_gone() {
    let _limit = LIMIT.blocking_lock();
    let pid = spawn_grandchild_sleep();
    let guard = KillOnDrop(ProcWatch::open(pid).expect("open the watch"));

    // One descriptor left: the pidfd takes it, so the read of the start
    // time that follows finds none.
    let original = own_limits();
    let one_left = libc::rlimit {
        rlim_cur: lowest_free_fd() as libc::rlim_t + 1,
        rlim_max: original.rlim_max,
    };
    set_own_limits(&one_left);
    let opened = ProcWatch::open(pid);
    set_own_limits(&original);

    let err = opened.expect_err("the start time cannot be read without a descriptor");
    assert!(
        !is_process_gone(&err),
        "a live process was reported gone: {err}"
    );
    assert_eq!(err.raw_os_error(), Some(libc::EMFILE), "{err}");
    assert!(!guard.0.has_exited(), "the process still runs");
}

/// The tag backend finds a unit's members with one-shot `/proc` reads (the
/// process listing, then each process's environment, state and children).
/// A read that fails for any reason but the process being gone (here: no
/// descriptor left) is "could not check": the member list is an error,
/// never a list without the members it could not read, which would let a
/// stop's Gone wait and its lock check pass while a member runs.
#[test]
fn a_tag_units_member_list_that_cannot_be_read_is_an_error() {
    let _limit = LIMIT.blocking_lock();
    let unit = Containment::tag_backend(SelectOptions::default())
        .create_unit(UnitId::mint(), UnitLabel::default())
        .unwrap();
    let mut member = std::process::Command::new("sleep")
        .arg("600")
        .env(UNIT_ENV, unit.id().as_str())
        .spawn()
        .expect("spawn the member");
    // The test's own unreaped child: its pid names it.
    let guard = KillOnDrop(ProcWatch::open(member.id()).expect("pin the member"));
    let pid = member.id();
    let listed =
        |members: &[freshell_containment::ProcIdentity]| members.iter().any(|m| m.pid == pid);
    assert!(listed(&unit.members().unwrap()), "the member is listed");

    let original = own_limits();
    let free = lowest_free_fd();
    // None left: `/proc` cannot be listed. One left: the listing and each
    // process's own files are read one descriptor at a time, but the
    // member's descendants cannot be listed (its thread list holds the
    // descriptor while each thread's `children` file is read).
    for left in [0, 1] {
        let starved = libc::rlimit {
            rlim_cur: (free + left) as libc::rlim_t,
            rlim_max: original.rlim_max,
        };
        set_own_limits(&starved);
        let read = unit.members();
        set_own_limits(&original);
        if let Ok(members) = read {
            panic!("{left} descriptor(s) left: a member list that could not be read was answered {members:?}");
        }
    }
    assert!(
        listed(&unit.members().unwrap()),
        "listed again once descriptors are available"
    );
    drop(guard);
    member.wait().expect("reap the member");
}

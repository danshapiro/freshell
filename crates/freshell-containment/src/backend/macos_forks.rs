//! macOS per-unit fork tracker: the kernel-tracked half of the macOS tag
//! backend's membership.
//!
//! macOS gives a process nothing that follows it through a detach: a job
//! the agent backgrounds with `nohup` or a `setsid` double fork is
//! reparented to launchd, the kernel withholds the environment (and so the
//! unit tag) of restricted programs (Apple's own binaries among them), and
//! the responsible process is reset when a separately signed program such
//! as the official `node` is exec'd (Task 7's T5, run 38024127146). So each
//! unit runs one kqueue thread with `EVFILT_PROC` `NOTE_FORK | NOTE_EXEC |
//! NOTE_EXIT` registered on every tracked process. Each batch of fork
//! events triggers one one-shot scan (`proc_listallpids` plus the
//! zombie-aware lookup) that tracks every process of this server's uid
//! whose parent, process group or session is a tracked process (to a fixed
//! point over that snapshot), registers it the same way, and records it as
//! a root in the unit record, so a server crash keeps it reachable; each
//! batch writes the record at most once. A tracked process stays tracked
//! until its exit event. Every root starts as its own session leader (the
//! `--setsid` shim), so a descendant that never calls `setsid` stays
//! linked to it by its session after its parent exits.
//!
//! Codex's daemon family (judged by its own argv or an ancestor's) is never
//! tracked, and so never recorded as a root: a tracked process that execs
//! into it is dropped at its exec event.
//!
//! The contract: a process is tracked when, at the scan that follows its
//! parent's fork event, its parent, its process-group leader or its session
//! leader is tracked; once tracked it stays a member until it exits. Within
//! a batch, the scan runs before exits are applied, so a parent that forks
//! and exits at once still links its child. Residual (the platform's limit:
//! kqueue refuses `NOTE_TRACK` with ENOTSUP, and Endpoint Security needs a
//! restricted entitlement and root): a session leader inside the unit (a
//! `setsid` intermediate, or a command run in its own terminal session)
//! that exits before the scan following its own creation leaves its
//! session's processes linked to nothing tracked, so they are found only by
//! their tag, which a restricted program withholds.
//!
//! No polling: the thread blocks in `kevent` until an event or its drop.

use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::UnitObserver;
use crate::darwin::{self, Kqueue};
use crate::process;

/// The per-unit tracker; its thread stops when this is dropped.
pub(crate) struct ForkTracker {
    shared: Arc<Shared>,
}

struct Shared {
    kq: Kqueue,
    unit_id: String,
    /// Tracked processes (pid to start time), each registered for its fork,
    /// exec and exit events.
    tracked: Mutex<BTreeMap<u32, u64>>,
    observer: Mutex<Option<Arc<dyn UnitObserver>>>,
    /// A root was tracked: the thread scans for what it started before its
    /// registration.
    scan_requested: AtomicBool,
    shutdown: AtomicBool,
    #[cfg(test)]
    hold: test_hold::Hold,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Test support: stops the tracker's thread at the top of its loop, before
/// it collects events, so the events one process raises meanwhile arrive
/// in one batch (as when the thread is slow to run).
#[cfg(test)]
mod test_hold {
    use std::sync::{Condvar, Mutex, PoisonError};

    #[derive(Default)]
    struct State {
        requested: bool,
        held: bool,
    }

    #[derive(Default)]
    pub(super) struct Hold {
        state: Mutex<State>,
        changed: Condvar,
    }

    impl Hold {
        /// The thread's side: waits here while a hold is requested.
        pub(super) fn pass(&self) {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if !state.requested {
                return;
            }
            state.held = true;
            self.changed.notify_all();
            while state.requested {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            state.held = false;
        }

        /// Returns once the thread waits in `pass`; `wake` makes it leave
        /// a blocked wait for events.
        pub(super) fn hold(&self, wake: impl FnOnce()) {
            self.state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .requested = true;
            wake();
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            drop(
                self.changed
                    .wait_while(state, |state| !state.held)
                    .unwrap_or_else(PoisonError::into_inner),
            );
        }

        pub(super) fn release(&self) {
            self.state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .requested = false;
            self.changed.notify_all();
        }
    }
}

/// Test support: the tracker's thread is held (see `test_hold`) until this
/// is dropped.
#[cfg(test)]
pub(crate) struct HeldForTest<'a>(&'a Shared);

#[cfg(test)]
impl Drop for HeldForTest<'_> {
    fn drop(&mut self) {
        self.0.hold.release();
    }
}

/// One process of a scan's snapshot.
struct Seen {
    pid: u32,
    links: [u32; 3],
    start: u64,
}

impl ForkTracker {
    /// A tracker for `unit_id` with its thread running.
    pub(crate) fn new(unit_id: &str) -> io::Result<Self> {
        let shared = Arc::new(Shared {
            kq: Kqueue::new()?,
            unit_id: unit_id.to_string(),
            tracked: Mutex::new(BTreeMap::new()),
            observer: Mutex::new(None),
            scan_requested: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            #[cfg(test)]
            hold: test_hold::Hold::default(),
        });
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("freshell-forks".into())
            .stack_size(128 * 1024)
            .spawn(move || thread_shared.run())?;
        Ok(Self { shared })
    }

    /// Where tracked processes are recorded as roots (and forgotten at their
    /// exit).
    pub(crate) fn set_observer(&self, observer: Arc<dyn UnitObserver>) {
        *lock(&self.shared.observer) = Some(observer);
    }

    /// Tracks a unit root, when it still runs as the incarnation that
    /// started at `start` (and is not in Codex's daemon family), records it,
    /// and has the thread scan for what it started before this
    /// registration.
    pub(crate) fn track_root(&self, pid: u32, start: u64) {
        if self.shared.track(pid, start) {
            self.shared.report(&[(pid, start)], &[]);
            self.shared.scan_requested.store(true, Ordering::SeqCst);
            let _ = self.shared.kq.wake();
        }
    }

    /// The tracked processes as `(pid, start time)`. After the tracker's
    /// thread stopped they are never updated again: callers admit each only
    /// while its pid still names that incarnation.
    pub(crate) fn tracked(&self) -> Vec<(u32, u64)> {
        lock(&self.shared.tracked)
            .iter()
            .map(|(pid, start)| (*pid, *start))
            .collect()
    }

    /// Whether the incarnation `(pid, start)` is tracked.
    pub(crate) fn tracks(&self, pid: u32, start: u64) -> bool {
        lock(&self.shared.tracked).get(&pid) == Some(&start)
    }

    /// Test support: counts `(pid, start)` as tracked with no registration,
    /// as an entry left behind once the tracker's thread has stopped.
    #[cfg(test)]
    pub(crate) fn insert_for_test(&self, pid: u32, start: u64) {
        lock(&self.shared.tracked).insert(pid, start);
    }

    /// Test support: holds the tracker's thread before it collects events
    /// until the result is dropped.
    #[cfg(test)]
    pub(crate) fn hold_for_test(&self) -> HeldForTest<'_> {
        self.shared.hold.hold(|| {
            let _ = self.shared.kq.wake();
        });
        HeldForTest(&self.shared)
    }
}

impl Drop for ForkTracker {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        let _ = self.shared.kq.wake();
    }
}

impl Shared {
    /// Registers `(pid, start)` for its fork, exec and exit events. False
    /// when it is already tracked, in Codex's daemon family, gone, exiting,
    /// or no longer that incarnation.
    fn track(&self, pid: u32, start: u64) -> bool {
        let already = lock(&self.tracked).contains_key(&pid);
        if already
            || process::in_codex_daemon_family_unless(pid, |up, start| {
                lock(&self.tracked).get(&up) == Some(&start)
            })
        {
            return false;
        }
        let mut tracked = lock(&self.tracked);
        if tracked.contains_key(&pid) {
            return false;
        }
        // Registered first, then checked: the registration attaches to the
        // process the pid names now.
        let registered = self.kq.change(
            pid as usize,
            libc::EVFILT_PROC,
            libc::EV_ADD | libc::EV_CLEAR,
            libc::NOTE_FORK | libc::NOTE_EXEC | libc::NOTE_EXIT,
        );
        if registered.is_err() {
            return false; // gone, or already exiting
        }
        match darwin::bsdinfo(pid) {
            Ok(info) if darwin::start_of(&info) == start && !darwin::is_zombie(&info) => {}
            _ => {
                self.unregister(pid);
                return false;
            }
        }
        tracked.insert(pid, start);
        true
    }

    /// Stops following `pid`. True when it was tracked.
    fn untrack(&self, pid: u32) -> bool {
        lock(&self.tracked).remove(&pid).is_some()
    }

    fn unregister(&self, pid: u32) {
        let _ = self
            .kq
            .change(pid as usize, libc::EVFILT_PROC, libc::EV_DELETE, 0);
    }

    /// One record update for a batch: one write, when anything changed.
    fn report(&self, added: &[(u32, u64)], removed: &[u32]) {
        if added.is_empty() && removed.is_empty() {
            return;
        }
        if let Some(observer) = lock(&self.observer).clone() {
            observer.roots_changed(added, removed);
        }
    }

    /// The thread: each batch of events runs one scan when a tracked
    /// process forked (or a root was added), drops a tracked process that
    /// exec'd into Codex's daemon family, applies the exits, and records
    /// the batch's changes at once.
    fn run(&self) {
        loop {
            #[cfg(test)]
            self.hold.pass();
            if self.shutdown.load(Ordering::SeqCst) {
                return;
            }
            let events = match self.kq.wait(None) {
                Ok(events) => events,
                Err(err) => {
                    tracing::warn!(target: "freshell_unit",
                        event = "containment.fork_tracker_failed",
                        unit_id = %self.unit_id,
                        error = %err,
                        "the unit's fork tracker stopped: the processes it follows stay members while they run, and new ones are found only by tags, roots and descendants");
                    return;
                }
            };
            if self.shutdown.load(Ordering::SeqCst) {
                return;
            }
            let proc_events = || events.iter().filter(|e| e.filter == libc::EVFILT_PROC);
            let forked = proc_events().any(|e| e.fflags & libc::NOTE_FORK != 0);
            let mut added = Vec::new();
            if self.scan_requested.swap(false, Ordering::SeqCst) || forked {
                added = self.scan();
            }
            let mut removed = Vec::new();
            for event in proc_events() {
                let pid = event.ident as u32;
                let exited = event.fflags & libc::NOTE_EXIT != 0;
                let joined_daemon = !exited
                    && event.fflags & libc::NOTE_EXEC != 0
                    && process::argv(pid).is_ok_and(|argv| process::is_codex_daemon_family(&argv));
                if joined_daemon {
                    self.unregister(pid);
                }
                if (exited || joined_daemon) && self.untrack(pid) {
                    removed.push(pid);
                }
            }
            added.retain(|(pid, _)| !removed.contains(pid));
            self.report(&added, &removed);
        }
    }

    /// One one-shot scan: tracks, to a fixed point over one snapshot, every
    /// live process of this server's uid whose parent, process group or
    /// session is tracked (and started no earlier than that process).
    /// Returns the processes it started tracking.
    fn scan(&self) -> Vec<(u32, u64)> {
        // SAFETY: getuid has no preconditions and cannot fail.
        let my_uid = unsafe { libc::getuid() };
        let me = std::process::id();
        let snapshot: Vec<Seen> = darwin::all_pids()
            .into_iter()
            .filter(|pid| *pid != me)
            .filter_map(|pid| {
                let info = darwin::bsdinfo(pid).ok()?;
                if darwin::is_zombie(&info) || info.pbi_ruid != my_uid {
                    return None;
                }
                // SAFETY: getsid of a pid; -1 when it cannot be read.
                let sid = unsafe { libc::getsid(pid as libc::pid_t) };
                Some(Seen {
                    pid,
                    links: [
                        info.pbi_ppid,
                        info.pbi_pgid,
                        u32::try_from(sid).unwrap_or(0),
                    ],
                    start: darwin::start_of(&info),
                })
            })
            .collect();
        let mut added = Vec::new();
        loop {
            let known = lock(&self.tracked).clone();
            let mut grew = false;
            for seen in snapshot.iter().filter(|s| !known.contains_key(&s.pid)) {
                let linked = seen
                    .links
                    .iter()
                    .any(|id| *id > 1 && known.get(id).is_some_and(|start| seen.start >= *start));
                if linked && self.track(seen.pid, seen.start) {
                    added.push((seen.pid, seen.start));
                    grew = true;
                }
            }
            if !grew {
                return added;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::ForkTracker;
    use crate::backend::UnitObserver;
    use crate::proc_watch::{ProcWatch, Sig};
    use crate::process;

    /// One report: the roots added and the pids removed.
    type Report = (Vec<(u32, u64)>, Vec<u32>);

    /// Every report the tracker makes, one entry per call.
    #[derive(Default)]
    struct Reports(Mutex<Vec<Report>>);

    impl UnitObserver for Reports {
        fn record_root(&self, pid: u32, start: u64) {
            self.0
                .lock()
                .unwrap()
                .push((vec![(pid, start)], Vec::new()));
        }
        fn forget_root(&self, pid: u32) {
            self.0.lock().unwrap().push((Vec::new(), vec![pid]));
        }
        fn roots_changed(&self, added: &[(u32, u64)], removed: &[u32]) {
            self.0
                .lock()
                .unwrap()
                .push((added.to_vec(), removed.to_vec()));
        }
    }

    /// The test's processes: each pin killed, and the root reaped, on drop.
    struct Tree {
        root: Child,
        pins: Vec<ProcWatch>,
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            for pin in &self.pins {
                let _ = pin.signal(Sig::Kill);
            }
            let _ = self.root.wait();
        }
    }

    /// The tracker writes the unit record at most once per batch of its
    /// events: the scan that follows a root's registration finds the three
    /// jobs the root started before it, and reports all of them in one call
    /// (one record write).
    #[test]
    fn one_batch_reports_every_process_it_starts_following_at_once() {
        let mut root = Command::new("/bin/sh")
            .args([
                "-c",
                "/bin/sleep 600 & /bin/sleep 600 & /bin/sleep 600 & echo ready; wait",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let out = root.stdout.take().unwrap();
        let root_pin = ProcWatch::open(root.id()).unwrap();
        let mut tree = Tree {
            root,
            pins: vec![root_pin.clone()],
        };
        let mut line = String::new();
        BufReader::new(out).read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        let jobs = process::children(tree.root.id());
        assert_eq!(jobs.len(), 3, "{jobs:?}");
        // Pinned while their parent, the root, waits for them.
        tree.pins
            .extend(jobs.iter().map(|pid| ProcWatch::open(*pid).unwrap()));

        let reports = Arc::new(Reports::default());
        let tracker = ForkTracker::new("u-test").unwrap();
        tracker.set_observer(reports.clone());
        tracker.track_root(root_pin.pid(), root_pin.identity().start);
        let reported = |pid: u32| {
            reports
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(added, _)| added.iter().any(|(p, _)| *p == pid))
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !jobs.iter().all(|pid| reported(*pid)) {
            assert!(
                Instant::now() < deadline,
                "the tracker never reported every job: {:?}",
                reports.0.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let calls: Vec<_> = reports
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(added, _)| added.iter().any(|(p, _)| jobs.contains(p)))
            .cloned()
            .collect();
        assert_eq!(
            calls.len(),
            1,
            "the jobs were reported in separate calls: {calls:?}"
        );
        drop(tracker);
    }

    /// Waits (bounded, 10 s) until `done`, failing the test with `what`.
    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The pid on the next line of `out`, which must be `<prefix> <pid>`.
    fn pid_after(out: &mut impl BufRead, prefix: &str) -> u32 {
        let mut line = String::new();
        out.read_line(&mut line).unwrap();
        line.trim()
            .strip_prefix(prefix)
            .unwrap_or_else(|| panic!("expected {prefix:?}: {line:?}"))
            .trim()
            .parse()
            .unwrap()
    }

    /// A tracked process that execs into Codex's daemon family and starts a
    /// child before the tracker collects its events (the tracker's thread
    /// is held meanwhile, so its exec and its fork arrive in one batch):
    /// the tracker drops it before it looks for new processes, so neither
    /// it nor the child, which by then runs an ordinary program, is tracked
    /// or recorded. The child shares the root's session and process group,
    /// so the scan still links it: only its parent's family keeps it out.
    #[test]
    fn a_process_that_execs_into_the_daemon_family_and_forks_in_one_batch_leaves_nothing_tracked() {
        use std::io::Write;
        const ROOT: &str = r#"use POSIX ();
POSIX::setsid() or die "setsid: $!";
$| = 1;
my $t = fork() // die "fork: $!";
if ($t == 0) {
    my $cue = <STDIN>;
    exec("/bin/sh", "-c", '/bin/sleep 600 & echo "child $!"; wait', "sh", "app-server", "--managed-daemon") or die "exec: $!";
}
print "t $t\n";
waitpid($t, 0);"#;
        let mut root = Command::new("perl")
            .args(["-e", ROOT])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut cue = root.stdin.take().unwrap();
        let mut out = BufReader::new(root.stdout.take().unwrap());
        let root_pin = ProcWatch::open(root.id()).unwrap();
        let mut tree = Tree {
            root,
            pins: vec![root_pin.clone()],
        };
        let t = pid_after(&mut out, "t");
        // Pinned while its parent, the root, waits for it.
        let t_pin = ProcWatch::open(t).unwrap();
        tree.pins.push(t_pin.clone());
        let t_start = t_pin.identity().start;

        let reports = Arc::new(Reports::default());
        let tracker = ForkTracker::new("u-test").unwrap();
        tracker.set_observer(reports.clone());
        tracker.track_root(root_pin.pid(), root_pin.identity().start);
        wait_until("the tracker follows the root's child", || {
            tracker.tracks(t, t_start)
        });

        let held = tracker.hold_for_test();
        writeln!(cue, "go").unwrap();
        let child = pid_after(&mut out, "child");
        // Pinned while its parent, the shell, waits for it.
        tree.pins.push(ProcWatch::open(child).unwrap());
        wait_until("the child runs /bin/sleep", || {
            process::argv(child).is_ok_and(|argv| argv == ["/bin/sleep", "600"])
        });
        assert!(
            process::argv(t).is_ok_and(|argv| process::is_codex_daemon_family(&argv)),
            "the tracked process exec'd into the daemon family"
        );
        assert!(
            tracker.tracks(t, t_start),
            "the held tracker has not collected the exec yet"
        );
        drop(held);

        wait_until("the tracker reports the process it drops", || {
            reports
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|(_, removed)| removed.contains(&t))
        });
        let added: Vec<u32> = reports
            .0
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(added, _)| added.iter().map(|(pid, _)| *pid))
            .collect();
        assert!(
            !added.contains(&child),
            "the daemon-family process's child was recorded: {:?}",
            reports.0.lock().unwrap()
        );
        let tracked: Vec<u32> = tracker.tracked().iter().map(|(pid, _)| *pid).collect();
        assert!(
            !tracked.contains(&t) && !tracked.contains(&child),
            "still tracked: {tracked:?} (the process {t}, its child {child})"
        );
        drop(tracker);
    }
}

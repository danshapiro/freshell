//! Tag backend (Linux without a user systemd manager; macOS until Task 7
//! fills in its facts). A unit's members are the processes carrying its
//! environment tag, the live pinned roots (each admitted only while its pid
//! still names the incarnation that started at its recorded start time), and
//! every descendant of those, computed fresh at each call from one-shot
//! `/proc` reads, never by polling.
//!
//! On Linux every member the unit spawns starts under the `__unit-exec
//! --reaper` shim (`crate::reaper`), a child subreaper: the kernel reparents
//! every orphaned descendant (a `setsid` or double-forked job, whatever it
//! does to its environment) to it, so the shim's tree holds everything the
//! pane started and the tag only matters for a shim killed from outside.
//!
//! Kill is a stop-the-world sweep that never signals a bare pid: each new
//! candidate is pinned with a `ProcWatch`, re-verified as a member, and
//! stopped (a stopped process cannot fork, exit or exec, so the set
//! converges); then every stopped process is killed through its watch. The
//! Codex daemon family (each process judged by its own argv, plus its
//! descendants) is spared and reported, never signalled.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::Arc;

use super::{Backend, BackendKind, Capability, KillSummary, MemberList, UnitBackend};
use crate::proc_watch::ProcWatch;
use crate::process::{self, is_codex_daemon_family};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

/// The sweep's bound: rounds end as soon as one finds no new candidate.
const MAX_ROUNDS: usize = 64;
/// How far up the parent chain `confirm_placement` looks for a root.
const MAX_ANCESTRY: usize = 4096;

pub(crate) struct TagBackend {
    kind: BackendKind,
    reason: String,
    /// `[<shim exe>, <shim leading args...>, "--reaper", "--"]` on Linux
    /// when the backend has a shim; `None` otherwise.
    wrapper: Option<Vec<String>>,
}

impl TagBackend {
    pub(crate) fn new(
        kind: BackendKind,
        reason: &str,
        shim: Option<&crate::containment::ShimCommand>,
    ) -> Self {
        let wrapper = reaper_wrapper(shim);
        let mut reason = reason.to_string();
        if cfg!(target_os = "linux") && wrapper.is_none() {
            reason.push_str("; no reaper shim");
        }
        Self {
            kind,
            reason,
            wrapper,
        }
    }
}

#[cfg(target_os = "linux")]
fn reaper_wrapper(shim: Option<&crate::containment::ShimCommand>) -> Option<Vec<String>> {
    let shim = shim?;
    let mut wrapper = vec![shim.exe.to_string_lossy().into_owned()];
    wrapper.extend(shim.leading_args.iter().cloned());
    wrapper.extend(["--reaper".to_string(), "--".to_string()]);
    Some(wrapper)
}

/// macOS placement is Task 7's.
#[cfg(not(target_os = "linux"))]
fn reaper_wrapper(_shim: Option<&crate::containment::ShimCommand>) -> Option<Vec<String>> {
    None
}

impl Backend for TagBackend {
    fn capability(&self) -> Capability {
        Capability {
            kind: self.kind,
            full: false,
            reason: Some(self.reason.clone()),
        }
    }

    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(TagUnit::new(
            UNIT_ENV,
            id.as_str(),
            id,
            self.wrapper.clone(),
        )))
    }

    fn reopen(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        // The caller holds this server's own record for `id`: nothing is
        // looked up first, and tags carry no per-server namespace because
        // every lookup is by a recorded, unique unit id.
        self.create(id)
    }
}

/// One unit found by `key=value` in the environment (the unit tag, or the
/// legacy Codex sidecar tag for v1 records).
pub(crate) struct TagUnit {
    key: String,
    value: String,
    /// The unit id its errors name (a legacy unit's minted id).
    unit_id: String,
    wrapper: Option<Vec<String>>,
}

/// One one-shot reading of a unit's processes.
struct Scan {
    /// Tag carriers, live roots and every descendant of those.
    candidates: BTreeSet<u32>,
    /// Daemon-family candidates and every descendant of them.
    spared: BTreeSet<u32>,
    /// Same-uid processes whose environment could not be read.
    withheld: u64,
}

impl TagUnit {
    pub(crate) fn new(
        key: &str,
        value: &str,
        unit_id: &UnitId,
        wrapper: Option<Vec<String>>,
    ) -> Self {
        Self {
            key: key.to_string(),
            value: value.to_string(),
            unit_id: unit_id.as_str().to_string(),
            wrapper,
        }
    }

    fn carries_tag(&self, pid: u32) -> bool {
        matches!(process::environ_entry(pid, &self.key), Ok(Some(v)) if v == self.value)
    }

    /// One reading of the unit. `count_withheld` also counts the same-uid
    /// processes whose environment is unreadable (one extra read each), which
    /// each call does once.
    fn scan(&self, roots: &[(u32, u64)], count_withheld: bool) -> Scan {
        let me = std::process::id();
        // SAFETY: getuid has no preconditions and cannot fail.
        let my_uid = unsafe { libc::getuid() };
        let mut candidates = BTreeSet::new();
        let mut withheld = 0;
        for pid in process::all_pids() {
            if pid == me {
                continue;
            }
            match process::environ_entry(pid, &self.key) {
                Ok(Some(v)) if v == self.value => {
                    candidates.insert(pid);
                }
                Ok(_) => {}
                Err(_) => {
                    if count_withheld && process::real_uid(pid) == Some(my_uid) {
                        withheld += 1;
                    }
                }
            }
        }
        candidates.extend(
            roots
                .iter()
                .filter(|(pid, start)| *pid != me && is_live_root(*pid, *start))
                .map(|(pid, _)| *pid),
        );
        let mut candidates = with_descendants(candidates, me);
        // A zombie can be neither signalled nor a parent any more.
        candidates.retain(|pid| process::is_running(*pid));
        let spared = daemon_family_within(&candidates);
        Scan {
            candidates,
            spared,
            withheld,
        }
    }

    fn kill_all_now(&self, roots: &[(u32, u64)]) -> io::Result<KillSummary> {
        let mut withheld = None;
        let summary = stop_the_world(
            || {
                let scan = self.scan(roots, withheld.is_none());
                withheld.get_or_insert(scan.withheld);
                (scan.candidates, scan.spared)
            },
            |watch, candidates| {
                let pid = watch.pid();
                self.carries_tag(pid)
                    || roots.contains(&(pid, watch.identity().start))
                    || process::parent(pid).is_some_and(|pp| candidates.contains(&pp))
            },
        )?;
        Ok(KillSummary {
            withheld: withheld.unwrap_or(0),
            ..summary
        })
    }
}

impl UnitBackend for TagUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        Ok(Placement {
            wrapper: self.wrapper.clone(),
            env: vec![(self.key.clone(), self.value.clone())],
        })
    }

    fn kill_all(
        self: Arc<Self>,
        roots: Vec<(u32, u64)>,
    ) -> BoxFuture<'static, io::Result<KillSummary>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || self.kill_all_now(&roots))
                .await
                .map_err(io::Error::other)?
        })
    }

    fn members(&self, roots: &[(u32, u64)]) -> io::Result<MemberList> {
        let scan = self.scan(roots, true);
        Ok(MemberList {
            members: scan
                .candidates
                .difference(&scan.spared)
                .filter_map(|pid| process::identity(*pid).ok())
                .collect(),
            withheld: scan.withheld,
        })
    }

    fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()> {
        if !process::is_running(pid) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("process {pid} is gone"),
            ));
        }
        let is_root = |pid: u32| {
            roots
                .iter()
                .any(|(root, start)| *root == pid && is_live_root(pid, *start))
        };
        if self.carries_tag(pid) || is_root(pid) {
            return Ok(());
        }
        let mut at = pid;
        for _ in 0..MAX_ANCESTRY {
            match process::parent(at) {
                Some(up) if up > 1 => {
                    if is_root(up) {
                        return Ok(());
                    }
                    at = up;
                }
                _ => break,
            }
        }
        Err(io::Error::other(format!(
            "process {pid} is not in unit {}",
            self.unit_id
        )))
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
        None
    }

    fn remove(&self, _emptied: bool) -> io::Result<()> {
        Ok(())
    }
}

/// Whether `pid` is running and is still the incarnation that started at
/// `start` (a root that exited and whose pid was reused is not).
fn is_live_root(pid: u32, start: u64) -> bool {
    process::is_running(pid) && process::start_time(pid).is_ok_and(|now| now == start)
}

/// `set` plus every descendant of its processes (one-shot child reads),
/// never including `exclude` (the caller itself).
pub(crate) fn with_descendants(mut set: BTreeSet<u32>, exclude: u32) -> BTreeSet<u32> {
    let mut frontier: Vec<u32> = set.iter().copied().collect();
    while let Some(pid) = frontier.pop() {
        for child in process::children(pid) {
            if child != exclude && set.insert(child) {
                frontier.push(child);
            }
        }
    }
    set
}

/// The processes in `set` whose OWN argv is Codex's daemon family, plus every
/// descendant of each (the only argv inspection in the kill path; it can only
/// spare a process, never select one).
pub(crate) fn daemon_family_within(set: &BTreeSet<u32>) -> BTreeSet<u32> {
    let family = set
        .iter()
        .copied()
        .filter(|pid| process::argv(*pid).is_ok_and(|argv| is_codex_daemon_family(&argv)))
        .collect();
    with_descendants(family, std::process::id())
}

/// The stop-the-world sweep shared by the tag backend and the reaper shim.
///
/// `find` is one one-shot reading: (candidates, spared). `belongs` re-checks
/// a pinned candidate (given its watch, whose identity names the pinned
/// incarnation) against the round's candidates, so a pid recycled between the
/// reading and the pin is never stopped. In rounds (at most
/// [`MAX_ROUNDS`], ending when a round finds nothing new) every new
/// non-spared candidate is pinned, re-verified, confirmed not yet exited and
/// stopped with SIGSTOP through its watch. Then each stopped process's argv
/// is read again: one that exec'd into the daemon family between the check
/// and the stop (and its stopped descendants) is resumed with SIGCONT and
/// spared, before anything is killed; every other one then gets SIGKILL
/// through its watch, descendants before ancestors ([`kill_order`]), so no
/// exit orphans a process group that still has a stopped member (the kernel
/// would SIGHUP that whole group, spared members included). Nothing waits
/// for the killed processes to exit.
pub(crate) fn stop_the_world(
    mut find: impl FnMut() -> (BTreeSet<u32>, BTreeSet<u32>),
    belongs: impl Fn(&ProcWatch, &BTreeSet<u32>) -> bool,
) -> io::Result<KillSummary> {
    let mut stopped: BTreeMap<u32, ProcWatch> = BTreeMap::new();
    // Every pid already handled: stopped, gone, or refused as not a member.
    let mut handled: BTreeSet<u32> = BTreeSet::new();
    let mut spared: BTreeSet<u32> = BTreeSet::new();
    let mut pin_error: Option<io::Error> = None;
    for _ in 0..MAX_ROUNDS {
        let (candidates, round_spared) = find();
        spared.extend(&round_spared);
        let fresh: Vec<u32> = candidates
            .iter()
            .copied()
            .filter(|pid| !round_spared.contains(pid) && !handled.contains(pid))
            .collect();
        if fresh.is_empty() {
            break;
        }
        for pid in fresh {
            handled.insert(pid);
            let watch = match ProcWatch::open(pid) {
                Ok(watch) => watch,
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => {
                    pin_error.get_or_insert(err);
                    continue;
                }
            };
            // The membership read must refer to the pinned incarnation: it
            // still has not exited after the read.
            if !belongs(&watch, &candidates) || watch.has_exited() {
                continue;
            }
            if watch.send(libc::SIGSTOP).is_ok() {
                stopped.insert(pid, watch);
            }
        }
    }
    let stopped_set: BTreeSet<u32> = stopped.keys().copied().collect();
    let resumed: BTreeSet<u32> = daemon_family_within(&stopped_set)
        .intersection(&stopped_set)
        .copied()
        .collect();
    // The spared resume first: a process still stopped when its process
    // group is orphaned would bring the kernel's SIGHUP down on the group.
    for pid in &resumed {
        let _ = stopped[pid].send(libc::SIGCONT);
    }
    let doomed: BTreeSet<u32> = stopped_set.difference(&resumed).copied().collect();
    let mut killed = 0;
    for pid in kill_order(&doomed, process::parent) {
        if stopped[&pid].send(libc::SIGKILL).is_ok() {
            killed += 1;
        }
    }
    spared.extend(&resumed);
    if let Some(err) = pin_error {
        return Err(err);
    }
    Ok(KillSummary {
        killed,
        spared: spared
            .iter()
            .filter_map(|pid| process::identity(*pid).ok())
            .collect(),
        withheld: 0,
        not_frozen: None,
    })
}

/// The order in which the sweep SIGKILLs its stopped processes: deepest in
/// the process tree first, so every process is killed after all of its
/// descendants (ties: higher pids first).
///
/// When a process exits, the kernel checks whether that orphans a process
/// group (no member left with a parent in another group of the same session)
/// that still has a stopped member, and if so sends SIGHUP and SIGCONT to the
/// whole group, spared daemon-family members included. A SIGKILL already
/// sent clears a process's stopped state, so when no process exits before
/// everything below it has been sent its SIGKILL, no group it links is ever
/// orphaned with a stopped member. Depth is counted over the whole parent
/// chain (one-shot reads), not only within `doomed`, so an ancestor reached
/// through a spared process is still killed after its descendants.
pub(crate) fn kill_order(doomed: &BTreeSet<u32>, parent: impl Fn(u32) -> Option<u32>) -> Vec<u32> {
    let depth = |pid: u32| {
        let mut depth = 0;
        let mut at = pid;
        while depth < MAX_ANCESTRY {
            match parent(at) {
                Some(up) if up > 0 && up != at => {
                    depth += 1;
                    at = up;
                }
                _ => break,
            }
        }
        depth
    };
    let mut order: Vec<(usize, u32)> = doomed.iter().map(|pid| (depth(*pid), *pid)).collect();
    order.sort_unstable_by(|a, b| b.cmp(a));
    order.into_iter().map(|(_, pid)| pid).collect()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::proc_watch::Sig;
    use std::time::Duration;

    /// A plain `sleep 600` child of the test (no tag), pinned while it is
    /// our own unreaped child, killed through that pin and reaped on drop.
    struct Sleep {
        child: std::process::Child,
        watch: ProcWatch,
    }

    impl Sleep {
        fn start() -> Self {
            let child = std::process::Command::new("sleep")
                .arg("600")
                .spawn()
                .unwrap();
            let watch = ProcWatch::open(child.id()).unwrap();
            Self { child, watch }
        }
    }

    impl Drop for Sleep {
        fn drop(&mut self) {
            let _ = self.watch.signal(Sig::Kill);
            let _ = self.child.wait();
        }
    }

    /// A process exiting while a member of a process group it links to the
    /// rest of its session is still stopped makes the kernel send SIGHUP and
    /// SIGCONT to that whole group, spared daemon-family members included. So
    /// every process is killed only after all of its descendants: when it
    /// exits, nothing below it is still stopped.
    #[test]
    fn the_sweep_kills_every_process_after_all_of_its_descendants() {
        // 10 is the reaper shim (lowest pid), 20 its agent, 30/31 the
        // agent's children, 40 a grandchild, 25 an orphan the shim adopted;
        // 15 runs outside the set under 1 (another tree).
        let parents: BTreeMap<u32, u32> = [
            (10, 1),
            (20, 10),
            (25, 10),
            (30, 20),
            (31, 20),
            (40, 30),
            (15, 1),
        ]
        .into_iter()
        .collect();
        let parent = |pid: u32| parents.get(&pid).copied();
        let doomed: BTreeSet<u32> = parents.keys().copied().collect();
        let order = kill_order(&doomed, parent);
        assert_eq!(
            order.iter().copied().collect::<BTreeSet<u32>>(),
            doomed,
            "every doomed process is killed exactly once: {order:?}"
        );
        let at = |pid: u32| order.iter().position(|p| *p == pid).unwrap();
        for pid in parents.keys() {
            let mut ancestor = parent(*pid);
            while let Some(up) = ancestor {
                if doomed.contains(&up) {
                    assert!(
                        at(*pid) < at(up),
                        "{pid} must be killed before its ancestor {up}: {order:?}"
                    );
                }
                ancestor = parent(up);
            }
        }
    }

    /// The kernel side of the rule above. The test's child Q (the lowest
    /// pid, in the test's process group) starts R, which starts 250 sleepers,
    /// and then L, which leads its own process group with a spared
    /// daemon-family process S in it; so the pids run Q < R < sleepers < L <
    /// S, and Q has only two children (its exit is quick). The sweep stops Q,
    /// R, the sleepers and L, spares S, and kills the stopped ones: if Q
    /// exited while L was still stopped, L's group would be orphaned with a
    /// stopped member and the kernel would SIGHUP S.
    #[test]
    fn a_spared_process_survives_the_sweep_of_its_process_groups_parent() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let script = format!(
            r#"pipe(my $ready, my $done) or die;
my $r = fork();
if ($r == 0) {{
  close $ready;
  for (1..250) {{ my $c = fork(); if ($c == 0) {{ exec "sleep", "600"; }} }}
  close $done;
  sleep 600; exit 0;
}}
close $done;
my $eof = <$ready>;
my $l = fork();
if ($l == 0) {{
  setpgrp(0, 0);
  my $s = fork();
  if ($s == 0) {{ exec "perl", "-e", "sleep 600", "app-server", "--managed-daemon"; }}
  open(my $f, ">", "{0}.tmp") or die; print $f "$$ $s"; close $f; rename("{0}.tmp", "{0}");
  sleep 600; exit 0;
}}
sleep 600;"#,
            pids.display()
        );
        let mut q = std::process::Command::new("perl")
            .args(["-e", &script])
            .spawn()
            .unwrap();
        // Our own unreaped child: its pid names it.
        let q_watch = ProcWatch::open(q.id()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let (l, s) = loop {
            if let Ok(raw) = std::fs::read_to_string(&pids) {
                let v: Vec<u32> = raw.split_whitespace().map(|p| p.parse().unwrap()).collect();
                break (v[0], v[1]);
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the tree never started"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        let s_watch = ProcWatch::open(s).unwrap();
        // Pinned while S is certainly still S (L, its parent, sleeps 600 s).
        let s_start = s_watch.identity().start;
        struct KillOnDrop(Vec<ProcWatch>);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                for watch in &self.0 {
                    let _ = watch.signal(Sig::Kill);
                }
            }
        }
        let _cleanup = KillOnDrop(vec![s_watch.clone(), q_watch.clone()]);
        // S runs its daemon-family argv only once it has exec'd.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !process::argv(s).is_ok_and(|argv| is_codex_daemon_family(&argv)) {
            assert!(std::time::Instant::now() < deadline, "S never exec'd");
            std::thread::sleep(Duration::from_millis(20));
        }

        let me = std::process::id();
        let root = q.id();
        let doomed = std::cell::RefCell::new(Vec::new());
        stop_the_world(
            || {
                let mut candidates = with_descendants(BTreeSet::from([root]), me);
                candidates.retain(|pid| process::is_running(*pid));
                let spared = daemon_family_within(&candidates);
                (candidates, spared)
            },
            |watch, candidates| {
                let pid = watch.pid();
                let member =
                    pid == root || process::parent(pid).is_some_and(|pp| candidates.contains(&pp));
                if member {
                    doomed.borrow_mut().push(watch.clone());
                }
                member
            },
        )
        .unwrap();
        let doomed = doomed.into_inner();
        assert!(
            doomed.iter().any(|w| w.pid() == l),
            "L was stopped and killed"
        );
        for watch in &doomed {
            let start = std::time::Instant::now();
            while !watch.has_exited() {
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "{} survived",
                    watch.pid()
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        // Any orphaned-group SIGHUP was sent during those exits; give it time
        // to land.
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !s_watch.has_exited() && process::start_time(s).ok() == Some(s_start),
            "the spared daemon-family process was killed"
        );
        let _ = q.wait();
    }

    fn fresh_unit() -> TagUnit {
        let id = UnitId::mint();
        TagUnit::new(UNIT_ENV, id.as_str(), &id, None)
    }

    /// A root whose pid now names another process (the root exited and its
    /// pid was reused) must never be treated as a member: not listed, not
    /// confirmed, not signalled.
    #[test]
    fn a_root_whose_start_time_no_longer_matches_is_not_a_member() {
        let mut sleep = Sleep::start();
        let (pid, start) = (sleep.watch.pid(), sleep.watch.identity().start);
        let unit = fresh_unit();
        let stale = [(pid, start + 1)];
        assert!(
            unit.members(&stale)
                .unwrap()
                .members
                .iter()
                .all(|m| m.pid != pid),
            "a root with another start time was listed as a member"
        );
        let refused = unit.confirm_placement(pid, &stale).unwrap_err();
        assert_ne!(refused.kind(), io::ErrorKind::NotFound, "{refused}");
        unit.kill_all_now(&stale).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !sleep.watch.has_exited(),
            "a root with another start time was killed"
        );

        // The same process recorded with its own start time is a root.
        let current = [(pid, start)];
        assert!(unit
            .members(&current)
            .unwrap()
            .members
            .iter()
            .any(|m| m.pid == pid));
        unit.confirm_placement(pid, &current).unwrap();
        unit.kill_all_now(&current).unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(sleep.child.wait().unwrap().signal(), Some(libc::SIGKILL));
    }
}

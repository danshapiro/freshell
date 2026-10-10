//! Containment backends: how one OS groups a unit's processes, places new
//! members, kills the whole set and confirms membership. The unit (`unit.rs`)
//! drives every stop through these two traits; backends hold no lifecycle
//! state and never enumerate units beyond a recorded unit id.

use std::io;
use std::sync::Arc;

use crate::process::ProcIdentity;
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId};

#[cfg(target_os = "linux")]
pub(crate) mod inotify;
#[cfg(target_os = "macos")]
pub(crate) mod macos_forks;
#[cfg(target_os = "linux")]
pub(crate) mod systemd;
#[cfg(unix)]
pub(crate) mod tag;
#[cfg(windows)]
pub(crate) mod windows_job;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    SystemdScope,
    LinuxTag,
    WindowsJob,
    MacosTag,
}

impl BackendKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SystemdScope => "systemd-scope",
            Self::LinuxTag => "linux-tag",
            Self::WindowsJob => "windows-job",
            Self::MacosTag => "macos-tag",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Capability {
    pub kind: BackendKind,
    /// true = membership is kernel-tracked (cgroup / job); false = tag + tree.
    pub full: bool,
    pub reason: Option<String>,
}

/// The Codex daemon-family processes among `pids`, each judged by its OWN
/// command line (`is_codex_daemon_family`), plus every process of `pids`
/// whose parent is spared, to a fixed point over this one snapshot
/// (siblings are covered because each family member matches on its own
/// argv). It can only spare a process, never select one for a signal. The
/// tag backend keeps its own, because it builds membership from the tag.
#[cfg(any(target_os = "linux", windows))]
pub(crate) fn spared_closure(
    pids: impl IntoIterator<Item = u32>,
) -> std::collections::BTreeSet<u32> {
    use crate::process;
    let pids: Vec<u32> = pids.into_iter().collect();
    let mut spared: std::collections::BTreeSet<u32> = pids
        .iter()
        .copied()
        .filter(|pid| process::argv(*pid).is_ok_and(|argv| process::is_codex_daemon_family(&argv)))
        .collect();
    if spared.is_empty() {
        return spared;
    }
    let parents: Vec<(u32, Option<u32>)> = pids
        .iter()
        .map(|pid| (*pid, process::parent(*pid)))
        .collect();
    loop {
        let before = spared.len();
        for (pid, parent) in &parents {
            if parent.is_some_and(|pp| spared.contains(&pp)) {
                spared.insert(*pid);
            }
        }
        if spared.len() == before {
            return spared;
        }
    }
}

/// What one whole-unit kill did. `spared` lists the Codex daemon-family
/// processes it left alone (each judged by its own argv, plus their
/// descendants); the unit logs them with its keys.
#[derive(Debug, Default)]
pub(crate) struct KillSummary {
    /// How many processes the kill signalled (not read by the unit yet).
    #[allow(dead_code)]
    pub killed: usize,
    pub spared: Vec<ProcIdentity>,
    /// See [`MemberList::withheld`].
    pub withheld: u64,
    /// Why the kill could not confirm its container frozen first (cgroup
    /// backends; `None` elsewhere): no frozen event within the deadline, or
    /// the error of the freeze write or of its watch. The kill still ran,
    /// one snapshot process at a time; the unit logs it with its keys
    /// (`unit.stop.freeze_timeout`).
    pub not_frozen: Option<String>,
}

/// One one-shot reading of a unit's live, non-spared members.
#[derive(Debug, Default)]
pub(crate) struct MemberList {
    pub members: Vec<ProcIdentity>,
    /// Same-uid processes whose environment could not be read while looking
    /// for the unit's tag (tag backends; 0 elsewhere). They can still be
    /// members as a root's descendants. The unit logs the count with its keys
    /// (`unit.members.environ_withheld`); backends never log it.
    pub withheld: u64,
}

/// What a backend reports back to its unit, which owns the unit record. A
/// backend whose container no longer ends its members when the server dies
/// (Windows: kill-on-close cleared; macOS: there is no container, so every
/// process the fork tracker follows) has each member recorded as a root, so
/// a restarted server can reach it by identity. Codex's daemon family is
/// never recorded (each backend spares it before it reports a member).
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub(crate) trait UnitObserver: Send + Sync {
    /// Adds `(pid, start)` to the record's roots (nothing when present).
    fn record_root(&self, pid: u32, start: u64);
    /// Drops every recorded root with `pid` (that process exited).
    fn forget_root(&self, pid: u32);
    /// One batch of changes (the macOS fork tracker reports each batch of
    /// its events at once): drops every recorded root with a `removed` pid,
    /// then adds `added` (each unless present).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn roots_changed(&self, added: &[(u32, u64)], removed: &[u32]) {
        for pid in removed {
            self.forget_root(*pid);
        }
        for (pid, start) in added {
            self.record_root(*pid, *start);
        }
    }
}

/// One containment mechanism (selected once per server).
pub(crate) trait Backend: Send + Sync {
    fn capability(&self) -> Capability;
    /// A new, empty unit for a freshly minted id.
    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>>;
    /// The unit of a recorded id. Never probes for processes first: the
    /// caller holds this server's own record for it.
    fn reopen(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>>;
}

/// One unit's process set on its backend.
pub(crate) trait UnitBackend: Send + Sync {
    /// How a member is started (`seq` numbers the unit's member spawns).
    fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement>;
    /// Kill every member (and every live root plus their descendants),
    /// sparing the Codex daemon family. Never signals a bare pid: every
    /// signal goes through a pinned `ProcWatch`.
    ///
    /// `roots` (here and below) are the unit's pinned processes as
    /// `(pid, start time)`. A root counts only while its pid still names the
    /// process that started at that time, so a root that exited and whose
    /// pid was reused is never treated as a member.
    fn kill_all(
        self: Arc<Self>,
        roots: Vec<(u32, u64)>,
    ) -> BoxFuture<'static, io::Result<KillSummary>>;
    /// The live, non-spared members right now (one-shot reads).
    fn members(&self, roots: &[(u32, u64)]) -> io::Result<MemberList>;
    /// One-shot: `Ok` when `pid` is in the unit, `ErrorKind::NotFound` when
    /// it is gone, another error when it lives outside the unit.
    fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()>;
    /// The kernel's "unit is empty" event, when the backend has one. An
    /// error means the wait could not watch the unit: never "empty".
    fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>>;
    /// Release the unit's OS container after the post-Gone sweep;
    /// `emptied` says whether the emptiness event arrived.
    fn remove(&self, emptied: bool) -> io::Result<()>;
    /// The unit's observer, given once when the unit is built. Backends that
    /// never record members ignore it.
    fn set_observer(&self, _observer: Arc<dyn UnitObserver>) {}
    /// A process the unit pinned as a root, or a root its record names at a
    /// restart (which may have exited already). A backend that follows what
    /// its roots start (macOS: the fork tracker) starts following it; the
    /// others ignore it.
    fn root_pinned(&self, _pid: u32, _start: u64) {}
}

//! Containment backends: how one OS groups a unit's processes, places new
//! members, kills the whole set and confirms membership. The unit (`unit.rs`)
//! drives every stop through these two traits; backends hold no lifecycle
//! state and never enumerate units beyond a recorded unit id.

use std::io;
use std::sync::Arc;

use crate::process::ProcIdentity;
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId};

#[cfg(windows)]
pub(crate) mod roots;
#[cfg(unix)]
pub(crate) mod tag;

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

/// What one whole-unit kill did. `spared` lists the Codex daemon-family
/// processes it left alone (each judged by its own argv, plus their
/// descendants); the unit logs them with its keys.
#[derive(Debug, Default)]
pub(crate) struct KillSummary {
    /// How many processes the kill signalled (not read by the unit yet).
    #[allow(dead_code)]
    pub killed: usize,
    pub spared: Vec<ProcIdentity>,
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
    fn members(&self, roots: &[(u32, u64)]) -> io::Result<Vec<ProcIdentity>>;
    /// One-shot: `Ok` when `pid` is in the unit, `ErrorKind::NotFound` when
    /// it is gone, another error when it lives outside the unit.
    fn confirm_placement(&self, pid: u32, roots: &[(u32, u64)]) -> io::Result<()>;
    /// The kernel's "unit is empty" event, when the backend has one.
    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>>;
    /// Release the unit's OS container after the post-Gone sweep;
    /// `emptied` says whether the emptiness event arrived.
    fn remove(&self, emptied: bool) -> io::Result<()>;
}

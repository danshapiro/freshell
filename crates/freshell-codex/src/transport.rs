//! Real production backend for the injected [`WsTransport`](crate::app_server::WsTransport)
//! seam (behind the default-off `real-transport` feature): the `ws` client from
//! `server/coding-cli/codex-app-server/client.ts:1`, in Rust via `tokio-tungstenite`, plus
//! the Linux `/proc` ownership reaper (`runtime.ts:452-586`).
//!
//! - [`TungsteniteTransport`] — connects to `ws://127.0.0.1:<port>` (the app-server listener,
//!   `runtime.ts:1246-1261`); one JSON message per text frame.
//! - [`reap_owned_codex_sidecars`] — SIGTERM any process carrying our
//!   `FRESHELL_CODEX_SIDECAR_ID` tag (`runtime.ts:494`), the codex analog of
//!   `freshell-opencode`'s `/proc` reaper — the "ownership-safe, no-orphans" machinery the
//!   oracle's `ownership.cleanup` invariant demands.
//!
//! This module is NOT exercised live in this step (no live API calls); it is verified to
//! compile under the feature and wired live in the next step (T2-over-rust, 3.8b). The CORE
//! and the completion gating are graded via the fake-injected tests, independent of this.

use futures_util::{SinkExt, StreamExt};
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
use tokio::net::TcpStream;
use tokio::sync::Mutex as TokioMutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::app_server::{BoxFuture, WsTransport};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsSink = futures_util::stream::SplitSink<WsStream, Message>;
type WsSource = futures_util::stream::SplitStream<WsStream>;

/// The real WebSocket transport backed by `tokio-tungstenite`. Loopback plain-WS only (no
/// TLS features pulled).
pub struct TungsteniteTransport {
    write: TokioMutex<WsSink>,
    read: TokioMutex<WsSource>,
}

impl TungsteniteTransport {
    /// Connect to the app-server WS endpoint (`ensureSocket`, `client.ts:521-556`).
    pub async fn connect(ws_url: &str) -> Result<Self, String> {
        let (stream, _response) = connect_async(ws_url).await.map_err(|e| e.to_string())?;
        let (write, read) = stream.split();
        Ok(Self {
            write: TokioMutex::new(write),
            read: TokioMutex::new(read),
        })
    }
}

impl WsTransport for TungsteniteTransport {
    fn send(&self, text: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.write
                .lock()
                .await
                .send(Message::Text(text))
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn recv(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let mut read = self.read.lock().await;
            loop {
                match read.next().await {
                    Some(Ok(Message::Text(text))) => return Some(text),
                    // Codex uses text frames; tolerate a binary frame as UTF-8 for robustness.
                    Some(Ok(Message::Binary(bytes))) => {
                        return Some(String::from_utf8_lossy(&bytes).into_owned())
                    }
                    // Ping/Pong/Frame are transport-level noise — keep reading.
                    Some(Ok(_)) => continue,
                    // A protocol error or a close frame ends the stream (→ fail pending).
                    Some(Err(_)) | None => return None,
                }
            }
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.write.lock().await.close().await;
        })
    }
}

/// A capture-before-kill ownership barrier for one process tree.
///
/// A descendant's `/proc/<pid>/environ` can become unreadable as soon as its
/// direct parent exits and it reparents outside Freshell's ancestry.
/// Current yama scopes only `PTRACE_MODE_ATTACH`, so environ reads of a
/// same-uid/gid dumpable process stay allowed at any `ptrace_scope` (see
/// [`scan_owned_pids_in`]); the unreadable class is non-dumpable transitions
/// (`PR_SET_DUMPABLE=0`, LSM confinement) and kernels/LSM policies that scope
/// `PTRACE_MODE_READ`. The capture-before-kill design covers every class:
/// callers capture ownership-tagged `(pid, starttime)` pairs before
/// closing transports or signaling the direct child, retain that exact set
/// across retries, and confirm death through world-readable `/proc/<pid>/stat`.
/// The start-time fence prevents a recycled PID from being mistaken for the
/// predecessor. The snapshot is serializable so a newly-booted server can
/// finish a retirement whose coordinator journal crossed the destructive
/// boundary immediately before the old server process exited.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedProcessTreeBarrier {
    #[cfg(target_os = "linux")]
    ownership_env: String,
    #[cfg(target_os = "linux")]
    ownership_id: String,
    #[cfg(target_os = "linux")]
    members: Vec<(i32, u64)>,
    /// PTY runtimes do not carry a sidecar ownership environment tag. Capture
    /// their process group while the registry still owns the leader and fold
    /// newly-visible members in on every confirmation round.
    #[cfg(target_os = "linux")]
    #[serde(default)]
    process_group_id: Option<i32>,
    /// Poison latch: the last ownership scan round was Indeterminate (an owned
    /// `/proc/<pid>/environ` entry could not be read), so an empty member list
    /// must NEVER be read as "quiescent". The first fully-`Complete` scan round
    /// clears it (a Complete round rediscovers any live tagged writer, so
    /// clearing is fail-safe). Persisted so poison survives a boot; rows
    /// written before this field existed deserialize `false` — they were only
    /// ever written by healthy scanners, so that default is exact.
    #[cfg(target_os = "linux")]
    #[serde(default)]
    scan_incomplete: bool,
    /// Test-only `/proc` root override — the unit-test seam behind
    /// `scan_owned_pids_in` (never set in production, never persisted).
    #[cfg(target_os = "linux")]
    #[serde(skip)]
    test_proc_root: Option<PathBuf>,
    #[cfg(not(target_os = "linux"))]
    _root_pid: u32,
    #[cfg(not(target_os = "linux"))]
    #[serde(default)]
    confirmed_empty: bool,
}

impl OwnedProcessTreeBarrier {
    /// Create an ownership-scan barrier before the tagged process exists.
    ///
    /// Restart transactions persist this empty fence before spawning. A later
    /// boot can then discover any child that inherited the tag even when the
    /// originating server crashed before it captured a PID.
    #[cfg(target_os = "linux")]
    pub fn capture_by_ownership(ownership_env: &str, ownership_id: &str) -> Self {
        Self {
            ownership_env: ownership_env.to_string(),
            ownership_id: ownership_id.to_string(),
            members: Vec::new(),
            process_group_id: None,
            scan_incomplete: false,
            test_proc_root: None,
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn capture_by_ownership(_ownership_env: &str, _ownership_id: &str) -> Self {
        Self {
            _root_pid: 0,
            confirmed_empty: false,
        }
    }

    /// Capture every currently-readable tagged process plus the known direct
    /// child. This performs no signaling and is safe to call while sidecar
    /// transports are still live. An Indeterminate initial scan poisons the
    /// barrier (fail closed): nothing is signaled that the scan could not see,
    /// and quiescence can never be confirmed off an incomplete round.
    #[cfg(target_os = "linux")]
    pub fn capture(root_pid: u32, ownership_env: &str, ownership_id: &str) -> Self {
        let (scanned, scan_incomplete) = match scan_owned_pids(ownership_env, ownership_id) {
            OwnershipScan::Complete(pids) => (pids, false),
            OwnershipScan::Indeterminate(gap) => {
                warn_scan_incomplete(&gap);
                (Vec::new(), true)
            }
        };
        let mut members: Vec<(i32, u64)> = scanned
            .into_iter()
            .filter_map(|pid| proc_starttime(pid).map(|start| (pid, start)))
            .collect();
        if !members.iter().any(|(pid, _)| *pid == root_pid as i32) {
            if let Some(start) = proc_starttime(root_pid as i32) {
                members.push((root_pid as i32, start));
            }
        }
        Self {
            ownership_env: ownership_env.to_string(),
            ownership_id: ownership_id.to_string(),
            members,
            process_group_id: None,
            scan_incomplete,
            test_proc_root: None,
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn capture(root_pid: u32, _ownership_env: &str, _ownership_id: &str) -> Self {
        Self {
            _root_pid: root_pid,
            confirmed_empty: false,
        }
    }

    /// Capture a PTY's whole process group with `(pid,starttime)` recycling
    /// fences. Unlike signaling `-pgid` after a reboot, this never risks a
    /// newly-reused process-group id: only exact captured incarnations are
    /// signaled, while new members are accepted only while a verified-live
    /// captured incarnation keeps the original group observable (never off
    /// the naked pgrp once the last captured incarnation is gone).
    #[cfg(target_os = "linux")]
    pub fn capture_process_group(root_pid: u32) -> Self {
        let process_group_id = proc_info(root_pid as i32).map(|(_, pgrp, _)| pgrp);
        let (scanned, scan_incomplete) = match process_group_id.map(scan_process_group) {
            Some(OwnershipScan::Complete(pids)) => (pids, false),
            Some(OwnershipScan::Indeterminate(gap)) => {
                warn_scan_incomplete(&gap);
                (Vec::new(), true)
            }
            None => (Vec::new(), false),
        };
        let members = scanned
            .into_iter()
            .filter_map(|pid| proc_starttime(pid).map(|start| (pid, start)))
            .collect();
        Self {
            ownership_env: String::new(),
            ownership_id: String::new(),
            members,
            process_group_id,
            scan_incomplete,
            test_proc_root: None,
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn capture_process_group(root_pid: u32) -> Self {
        Self {
            _root_pid: root_pid,
            confirmed_empty: false,
        }
    }

    /// Explicit empty proof for injected runtimes that own no local process
    /// for the selected durable session. Production process owners use
    /// [`Self::capture`] or [`Self::capture_process_group`] instead.
    pub fn already_quiescent() -> Self {
        #[cfg(target_os = "linux")]
        {
            Self {
                ownership_env: String::new(),
                ownership_id: String::new(),
                members: Vec::new(),
                process_group_id: None,
                scan_incomplete: false,
                test_proc_root: None,
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self {
                _root_pid: 0,
                confirmed_empty: true,
            }
        }
    }

    /// Signal and confirm the entire captured tree is dead.
    ///
    /// New tagged descendants are folded in before every signal round while
    /// `/proc/<pid>/environ` remains readable. Twenty graceful SIGTERM rounds
    /// are followed by four SIGKILL rounds. A member counts as dead only when
    /// its captured `(pid,starttime)` incarnation is gone or is a zombie.
    /// Failed attempts retain the captured members, so a later retry never
    /// depends on re-reading an environment that YAMA may now hide.
    ///
    /// Fail closed (fix 5): a poisoned barrier — any scan round ended
    /// Indeterminate — reports `false` even with zero known members, and an
    /// ownership-Indeterminate round never shrinks membership (a process-group
    /// gap still poisons its round, but the retain preceding it pruned only
    /// stat-proven-dead incarnations). The first fully-Complete round clears
    /// the poison, so a barrier wedged on an unreadable `/proc` recovers as
    /// soon as the host is readable again.
    #[cfg(target_os = "linux")]
    pub async fn terminate_and_confirm(&mut self) -> bool {
        for round in 0..24u8 {
            self.refresh_members();
            // Quiescence is provable ONLY as empty-members on a Complete round.
            if self.members.is_empty() && !self.scan_incomplete {
                return true;
            }
            let signal = if round < 20 {
                libc::SIGTERM
            } else {
                libc::SIGKILL
            };
            for (pid, _) in &self.members {
                unsafe {
                    libc::kill(*pid, signal);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        self.refresh_members();
        self.members.is_empty() && !self.scan_incomplete
    }

    #[cfg(not(target_os = "linux"))]
    pub async fn terminate_and_confirm(&mut self) -> bool {
        // Without a portable descendant enumeration + start-time fence there
        // is no proof that the durable writer tree is gone. Hold ownership
        // closed rather than reporting a false success.
        self.confirmed_empty
    }

    /// The `/proc` root this barrier scans: the real root in production; the
    /// test override only ever lands here from unit tests.
    #[cfg(target_os = "linux")]
    fn proc_root(&self) -> &Path {
        self.test_proc_root
            .as_deref()
            .unwrap_or_else(|| Path::new("/proc"))
    }

    /// Fold newly-visible members in. An ownership-Indeterminate round never
    /// shrinks membership: when the ownership leg cannot prove the owned set,
    /// BOTH the retain and the process-group sub-scan are skipped and the
    /// round ends poisoned (a `/proc` gap can hide a live writer, so retaining
    /// a stale member is the fail-closed direction). Only a Complete ownership
    /// leg runs the retain — each prune is an exact `(pid,starttime)` stat
    /// proof of a gone incarnation — and the process-group sub-scan runs only
    /// after it, gated on post-retain (verified-live) membership. A
    /// process-group gap still poisons its round (quiescence is unprovable
    /// off an incomplete scan) but never blocks the retain: it can hide an
    /// unseen fork, while the members the retain pruned were stat-proven dead.
    #[cfg(target_os = "linux")]
    fn refresh_members(&mut self) {
        let mut discovered = Vec::new();
        let mut gap: Option<ScanGap> = None;
        if !self.ownership_env.is_empty() {
            match scan_owned_pids_in(self.proc_root(), &self.ownership_env, &self.ownership_id) {
                OwnershipScan::Complete(pids) => discovered = pids,
                OwnershipScan::Indeterminate(g) => gap = Some(g),
            }
        }
        // An ownership-Indeterminate round never shrinks membership AND never
        // consults the group: pre-retain membership may be all-dead
        // incarnations, which is no authority to adopt into a possibly
        // recycled process-group id (fix-5 fix-review B.1).
        if gap.is_none() {
            self.members
                .retain(|(pid, start)| proc_starttime(*pid) == Some(*start));
            // A numeric process-group id can be recycled. Discover forks only
            // while at least one post-retain — hence verified-live — exact
            // `(pid,starttime)` incarnation keeps the captured group
            // observable. Once the last captured incarnation is gone, never
            // use the naked pgrp as authority to adopt or signal a
            // newly-reused group.
            if !self.members.is_empty() {
                if let Some(process_group_id) = self.process_group_id {
                    match scan_process_group_in(self.proc_root(), process_group_id) {
                        OwnershipScan::Complete(pids) => discovered.extend(pids),
                        OwnershipScan::Indeterminate(g) => gap = Some(g),
                    }
                }
            }
        }
        if let Some(gap) = &gap {
            warn_scan_incomplete(gap);
        }
        self.scan_incomplete = gap.is_some();
        for pid in discovered {
            if !self.members.iter().any(|(known, _)| *known == pid) {
                if let Some(start) = proc_starttime(pid) {
                    self.members.push((pid, start));
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn proc_starttime(pid: i32) -> Option<u64> {
    proc_info(pid).map(|(_, _, starttime)| starttime)
}

#[cfg(target_os = "linux")]
fn proc_info(pid: i32) -> Option<(String, i32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.rsplit(')').next()?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    match fields.first() {
        Some(&"Z") | Some(&"X") | None => return None,
        Some(_) => {}
    }
    Some((
        fields.first()?.to_string(),
        fields.get(2)?.parse().ok()?,
        fields.get(19)?.parse().ok()?,
    ))
}

/// The outcome of one `/proc` ownership scan round. `Complete` proves every
/// entry owned by our euid+egid was inspected; `Indeterminate` carries the gap
/// and must never be read as "the owned set is known" (fail closed).
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(crate) enum OwnershipScan {
    Complete(Vec<i32>),
    Indeterminate(ScanGap),
}

/// Why a scan round is Indeterminate: the `/proc` root itself could not be
/// listed, and/or this many entries owned by our euid AND egid had an
/// `environ` unreadable for a reason other than the pid-gone race (`ENOENT`).
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(crate) struct ScanGap {
    pub read_dir_failed: bool,
    pub unusable_owned_entries: usize,
}

/// Loud poison notification for the barrier path; the same event key drives
/// the "an incomplete scan blocked a quiesce proof" observability.
#[cfg(target_os = "linux")]
fn warn_scan_incomplete(gap: &ScanGap) {
    tracing::warn!(
        read_dir_failed = gap.read_dir_failed,
        unusable_owned_entries = gap.unusable_owned_entries,
        "agent.restart.ownership_scan_incomplete"
    );
}

/// The `KEY=value` environ-entry match (`\0`-separated) every ownership scan
/// and reaper keys on.
#[cfg(target_os = "linux")]
fn env_tag_matches(environ: &[u8], ownership_env: &str, ownership_id: &str) -> bool {
    let needle = format!("{ownership_env}={ownership_id}");
    environ
        .split(|byte| *byte == 0)
        .any(|variable| variable == needle.as_bytes())
}

/// One process-group membership round (`/proc/<pid>/stat` is world-readable,
/// so only the root listing itself can fail; pid-gone stat races skip).
#[cfg(target_os = "linux")]
fn scan_process_group(process_group_id: i32) -> OwnershipScan {
    scan_process_group_in(Path::new("/proc"), process_group_id)
}

/// One process-group round against `root` — the per-barrier test seam matching
/// [`scan_owned_pids_in`]; production callers go through [`scan_process_group`]
/// (the real `/proc`) or [`OwnedProcessTreeBarrier::proc_root`].
#[cfg(target_os = "linux")]
fn scan_process_group_in(root: &Path, process_group_id: i32) -> OwnershipScan {
    let mut found = Vec::new();
    let mut unusable_entries = 0usize;
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            return OwnershipScan::Indeterminate(ScanGap {
                read_dir_failed: true,
                unusable_owned_entries: 0,
            })
        }
    };
    for entry in entries {
        // fix-5's letter ("must not silently skip unreadable entries"): a
        // per-entry readdir error means the process group was never fully
        // inspected — count it as a gap, never silently drop it.
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                unusable_entries += 1;
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        if proc_info(pid).is_some_and(|(_, pgrp, _)| pgrp == process_group_id) {
            found.push(pid);
        }
    }
    if unusable_entries > 0 {
        OwnershipScan::Indeterminate(ScanGap {
            read_dir_failed: false,
            unusable_owned_entries: unusable_entries,
        })
    } else {
        OwnershipScan::Complete(found)
    }
}

/// One ownership round against the real `/proc` (no test override). Production
/// callers that can carry the per-barrier seam use [`scan_owned_pids_in`]
/// through [`OwnedProcessTreeBarrier::proc_root`] instead.
#[cfg(target_os = "linux")]
fn scan_owned_pids(ownership_env: &str, ownership_id: &str) -> OwnershipScan {
    scan_owned_pids_in(Path::new("/proc"), ownership_env, ownership_id)
}

/// One ownership round against `root`, tri-state so an incomplete scan can
/// never be read as "quiescent".
///
/// Ownership screen (validated live on garageserver, Ubuntu 24.04 + yama=1):
/// only an entry whose `/proc/<pid>` directory is owned by our euid AND egid
/// can carry one of our tags — other-uid/gid entries (e.g. sandboxed browsers)
/// are skipped, and pid-gone races (`ENOENT` on `environ`) are skips, not
/// gaps. A same-owner `EACCES` is the *non-dumpable* signature: with yama at
/// any scope, `PTRACE_MODE_READ` on a same-uid/gid dumpable process is never
/// denied, so a persistent same-owner read denial means the target called
/// `prctl(PR_SET_DUMPABLE, 0)`-family (e.g. ambient `gpg-agent`, `sd-pam`,
/// `systemd --user`) — the already-recorded LB-05 residual class that no
/// freshell spawn path can produce (grep-verified), hence a skip rather than
/// a permanently self-wedging gap. Any OTHER failure to read the `environ`
/// of an OWNED entry is genuinely anomalous ⇒ `Indeterminate`.
#[cfg(target_os = "linux")]
fn scan_owned_pids_in(root: &Path, ownership_env: &str, ownership_id: &str) -> OwnershipScan {
    use std::os::unix::fs::MetadataExt;
    let mut pids = Vec::new();
    let mut unusable_owned_entries = 0usize;
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            return OwnershipScan::Indeterminate(ScanGap {
                read_dir_failed: true,
                unusable_owned_entries: 0,
            })
        }
    };
    // geteuid/getegid are plain id reads with no preconditions (always sound).
    let (euid, egid) = unsafe { (libc::geteuid(), libc::getegid()) };
    for entry in entries {
        // fix-5's letter ("must not silently skip unreadable entries"): a
        // per-entry readdir error means the owned set was never fully
        // inspected — count it as a gap, never silently drop it. The entry's
        // name/ownership are unknowable, so it goes to `unusable_owned_entries`
        // (the worst case is a hidden OWNED entry, which is exactly the class
        // the fail-closed contract exists for).
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                unusable_owned_entries += 1;
                continue;
            }
        };
        let name = entry.file_name();
        let Some(text) = name.to_str() else { continue };
        let Ok(pid) = text.parse::<i32>() else {
            continue;
        };
        // The pid-gone race between listing and stat is a skip, not a gap.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.uid() != euid || meta.gid() != egid {
            continue;
        }
        match std::fs::read(entry.path().join("environ")) {
            Ok(contents) => {
                if env_tag_matches(&contents, ownership_env, ownership_id) {
                    pids.push(pid);
                }
            }
            // pid gone: a race skip, not a gap.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            // Non-dumpable (LB-05 residual) / LSM-confined ambient process: a
            // same-owner read can never be denied for a dumpable peer, so this
            // cannot be one of our writers — a skip, not a gap.
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
            // Owned but unreadable for any other reason: a real gap.
            Err(_) => unusable_owned_entries += 1,
        }
    }
    if unusable_owned_entries > 0 {
        OwnershipScan::Indeterminate(ScanGap {
            read_dir_failed: false,
            unusable_owned_entries,
        })
    } else {
        OwnershipScan::Complete(pids)
    }
}

/// Fail-closed ownership scan shared by every provider's `/proc` reaper (the
/// `killOwnedProcesses` analogs). `Some(pids)` is a COMPLETE scan: the exact
/// set of pids carrying `ownership_env=ownership_id`. `None` is INDETERMINATE:
/// an owned entry could not be read, so the caller must skip signaling — a
/// partial candidate list can never be trusted as the full owned set, and the
/// fail-closed direction is to leave the hidden writer for a later complete
/// round rather than pretend the tree is quiesced.
#[cfg(target_os = "linux")]
pub fn scan_owned_pids_fail_closed(ownership_env: &str, ownership_id: &str) -> Option<Vec<i32>> {
    match scan_owned_pids(ownership_env, ownership_id) {
        OwnershipScan::Complete(pids) => Some(pids),
        OwnershipScan::Indeterminate(gap) => {
            tracing::warn!(
                ownership_env,
                read_dir_failed = gap.read_dir_failed,
                unusable_owned_entries = gap.unusable_owned_entries,
                "agent.ownership_scan.incomplete_reapers_skip"
            );
            None
        }
    }
}

/// `killOwnedProcesses` analog for codex (`runtime.ts:452-586`): SIGTERM any process whose
/// `/proc/<pid>/environ` carries our `FRESHELL_CODEX_SIDECAR_ID=<ownership_id>` tag — the
/// detached app-server sidecar we own. Linux `/proc`-based, platform-guarded;
/// we only signal processes carrying OUR unique tag, so no unrelated process is touched.
/// An Indeterminate scan skips signaling entirely (fail closed).
#[cfg(target_os = "linux")]
pub fn reap_owned_codex_sidecars(ownership_id: &str) {
    let Some(pids) =
        scan_owned_pids_fail_closed(crate::durability::CODEX_SIDECAR_OWNERSHIP_ENV, ownership_id)
    else {
        return;
    };
    for pid in pids {
        // SIGTERM (15). Safe: only processes carrying OUR tag are signaled.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn reap_owned_codex_sidecars(_ownership_id: &str) {
    // Non-Linux: the direct child is reaped via the spawner's kill-on-drop; the `/proc`
    // environ scan is Linux-only (matches the reference's platform guard, runtime.ts:361-367).
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn persisted_tree_barrier_survives_owner_process_reopen_and_kills_exact_writer() {
        let ownership_id = format!("persisted-restart-barrier-{}", uuid::Uuid::new_v4());
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
            .env("FRESHELL_TEST_RESTART_OWNER", &ownership_id)
            .spawn()
            .expect("spawn ownership-tagged writer");
        let pid = child.id().expect("writer pid");
        let captured =
            OwnedProcessTreeBarrier::capture(pid, "FRESHELL_TEST_RESTART_OWNER", &ownership_id);
        let bytes = serde_json::to_vec(&captured).expect("serialize pre-kill ownership barrier");
        drop(captured);

        let mut reopened: OwnedProcessTreeBarrier =
            serde_json::from_slice(&bytes).expect("reopen persisted ownership barrier");
        assert!(
            reopened.terminate_and_confirm().await,
            "a new server process must be able to confirm the predecessor writer dead"
        );
        let _ = child.wait().await;
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "the exact captured process incarnation must be gone"
        );
    }

    #[tokio::test]
    async fn pre_spawn_ownership_fence_discovers_writer_created_after_persistence() {
        let ownership_id = format!("pre-spawn-restart-fence-{}", uuid::Uuid::new_v4());
        let fence = OwnedProcessTreeBarrier::capture_by_ownership(
            "FRESHELL_TEST_RESTART_REPLACEMENT",
            &ownership_id,
        );
        let bytes = serde_json::to_vec(&fence).expect("persist fence before child spawn");

        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
            .env("FRESHELL_TEST_RESTART_REPLACEMENT", &ownership_id)
            .spawn()
            .expect("spawn crash-ambiguous replacement");
        let pid = child.id().expect("writer pid");

        let mut reopened: OwnedProcessTreeBarrier =
            serde_json::from_slice(&bytes).expect("reopen pre-spawn ownership fence");
        assert!(
            reopened.terminate_and_confirm().await,
            "boot recovery must discover and quiesce a child spawned after fence persistence"
        );
        let _ = child.wait().await;
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }

    // ── fix-5: fail-closed ownership scanning ─────────────────────────────────

    /// A fake `/proc` entry under `root`: a numeric dir whose `environ` file
    /// carries `contents` verbatim (`None` simulates the pid-gone read race).
    fn fake_proc_entry(
        root: &std::path::Path,
        pid: i32,
        contents: Option<&[u8]>,
    ) -> std::path::PathBuf {
        let pid_dir = root.join(pid.to_string());
        std::fs::create_dir(&pid_dir).unwrap();
        let environ = pid_dir.join("environ");
        if let Some(contents) = contents {
            std::fs::write(&environ, contents).unwrap();
        }
        environ
    }

    /// A fake `/proc` entry whose `environ` is unreadable for a reason that is
    /// NEITHER pid-gone (`ENOENT`) nor the non-dumpable class (`EACCES`): the
    /// `environ` name is a directory, so every read fails `EISDIR` — a
    /// deterministic, root-safe stand-in for an anomalous owned-entry gap.
    fn fake_proc_gap_entry(root: &std::path::Path, pid: i32) {
        let pid_dir = root.join(pid.to_string());
        std::fs::create_dir(&pid_dir).unwrap();
        std::fs::create_dir(pid_dir.join("environ")).unwrap();
    }

    /// The validated live predicate: an entry owned by our euid AND egid whose
    /// environ read fails with anything other than pid-gone (`ENOENT`) or the
    /// non-dumpable class (`EACCES`) is a real gap — the scan must fail closed,
    /// never read as "no writer".
    #[test]
    fn unreadable_owned_environ_makes_scan_indeterminate_not_empty() {
        let root = tempfile::tempdir().unwrap();
        fake_proc_gap_entry(root.path(), 4242);
        let scan = scan_owned_pids_in(root.path(), "FRESHELL_RESTART_REPLACEMENT_ID", "fence-x");
        assert!(
            matches!(scan, OwnershipScan::Indeterminate(_)),
            "an owned-but-unreadable entry must be a scan gap, got {scan:?}"
        );
        // The ambient non-dumpable class (same-owner EACCES) must stay a skip:
        // mode-0o000 denies the owner EACCES exactly like the ambient daemons.
        let root2 = tempfile::tempdir().unwrap();
        let environ = fake_proc_entry(root2.path(), 4242, Some(b"X=1\0"));
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&environ, std::fs::Permissions::from_mode(0o000)).unwrap();
        let scan2 = scan_owned_pids_in(root2.path(), "ANY_ENV", "any-id");
        if std::fs::read(&environ).is_err() {
            // Only meaningful where mode-0o000 actually denies reads (non-root):
            // as root the file reads fine and the round is trivially Complete.
            assert!(
                matches!(scan2, OwnershipScan::Complete(_)),
                "a same-owner EACCES entry is the non-dumpable residual class: skip, got {scan2:?}"
            );
        }
    }

    /// A clean fake root: the tagged pid is discovered, a pid-gone entry (no
    /// environ file) is a race skip — NOT a gap — garbage and other-tag entries
    /// are ignored, and the whole round is `Complete`.
    #[test]
    fn complete_clean_scan_reports_complete_with_tagged_pid() {
        let root = tempfile::tempdir().unwrap();
        fake_proc_entry(
            root.path(),
            4242,
            Some(b"LANG=C\0FRESHELL_RESTART_REPLACEMENT_ID=fence-x\0"),
        );
        fake_proc_entry(root.path(), 5555, None); // pid-gone race
        std::fs::create_dir(root.path().join("self-not-numeric")).unwrap();
        fake_proc_entry(
            root.path(),
            6666,
            Some(b"FRESHELL_RESTART_REPLACEMENT_ID=other\0"),
        );
        let scan = scan_owned_pids_in(root.path(), "FRESHELL_RESTART_REPLACEMENT_ID", "fence-x");
        let OwnershipScan::Complete(pids) = scan else {
            panic!("a fully readable fake root must be Complete, got {scan:?}")
        };
        assert_eq!(pids, vec![4242]);
    }

    /// Poison lifecycle (a): a poisoned barrier NEVER reports confirmed
    /// termination while every round stays Indeterminate — even with zero
    /// known members, which an unpoisoned barrier would confirm immediately.
    #[tokio::test]
    async fn indeterminate_scan_blocks_confirmed_termination() {
        let root = tempfile::tempdir().unwrap();
        fake_proc_gap_entry(root.path(), 4242);
        let mut barrier = OwnedProcessTreeBarrier {
            ownership_env: "FRESHELL_TEST_POISON_A".to_string(),
            ownership_id: "irrelevant".to_string(),
            members: Vec::new(),
            process_group_id: None,
            scan_incomplete: true,
            test_proc_root: Some(root.path().to_path_buf()),
        };
        assert!(
            !barrier.terminate_and_confirm().await,
            "an empty-but-poisoned barrier must fail closed, never confirm quiescence"
        );
        assert!(barrier.scan_incomplete, "no Complete round ever cleared it");
    }

    /// Poison lifecycle (b): the first fully-Complete scan round CLEARS the
    /// poison (a Complete round rediscovers any live tagged writer, so
    /// clearing is fail-safe), letting a quiesced tree confirm.
    #[tokio::test]
    async fn complete_round_clears_poison_and_confirms_quiescence() {
        let root = tempfile::tempdir().unwrap();
        // Readable entry carrying a NON-matching tag: a clean Complete round.
        fake_proc_entry(root.path(), 4242, Some(b"FRESHELL_TEST_POISON_B=other\0"));
        let mut barrier = OwnedProcessTreeBarrier {
            ownership_env: "FRESHELL_TEST_POISON_B".to_string(),
            ownership_id: "fence".to_string(),
            members: Vec::new(),
            process_group_id: None,
            scan_incomplete: true, // poisoned at capture; this round is clean
            test_proc_root: Some(root.path().to_path_buf()),
        };
        assert!(
            barrier.terminate_and_confirm().await,
            "a Complete round clears the poison, so an empty tree may confirm"
        );
        assert!(
            !barrier.scan_incomplete,
            "the Complete round cleared the poison"
        );
    }

    /// Poison lifecycle (c): poison persists across boots via a serde
    /// round-trip; legacy rows written before this field existed deserialize
    /// un-poisoned (`#[serde(default)]`) — they were only ever written by
    /// healthy scanners, so `false` is exact for them.
    #[test]
    fn poison_survives_persisted_barrier_reopen() {
        let barrier = OwnedProcessTreeBarrier {
            ownership_env: "E".to_string(),
            ownership_id: "i".to_string(),
            members: vec![(123, 45)],
            process_group_id: None,
            scan_incomplete: true,
            test_proc_root: None,
        };
        let bytes = serde_json::to_vec(&barrier).expect("serialize poisoned barrier");
        let reopened: OwnedProcessTreeBarrier =
            serde_json::from_slice(&bytes).expect("reopen persisted barrier");
        assert!(
            reopened.scan_incomplete,
            "poison must survive a persisted barrier reopen"
        );

        let legacy: OwnedProcessTreeBarrier =
            serde_json::from_str(r#"{"ownershipEnv":"E","ownershipId":"i","members":[[123,45]]}"#)
                .expect("pre-fix rows remain readable");
        assert!(
            !legacy.scan_incomplete,
            "pre-fix rows default to un-poisoned"
        );
    }

    /// Poison lifecycle (d): an Indeterminate round NEVER shrinks membership —
    /// a stale-looking member is retained until a Complete round can prove its
    /// incarnation gone.
    #[test]
    fn indeterminate_round_never_shrinks_membership() {
        let root = tempfile::tempdir().unwrap();
        fake_proc_gap_entry(root.path(), 4242);
        // A member whose incarnation looks long gone under /proc/<pid>/stat.
        let mut barrier = OwnedProcessTreeBarrier {
            ownership_env: "FRESHELL_TEST_POISON_D".to_string(),
            ownership_id: "i".to_string(),
            members: vec![(i32::MAX - 1, 1)],
            process_group_id: None,
            scan_incomplete: false,
            test_proc_root: Some(root.path().to_path_buf()),
        };
        barrier.refresh_members();
        assert!(
            barrier.members.contains(&(i32::MAX - 1, 1)),
            "an Indeterminate round must keep every member: {:?}",
            barrier.members
        );
        assert!(
            barrier.scan_incomplete,
            "the Indeterminate round re-poisons the barrier"
        );
    }

    /// fix-5 fix-review (B.1): an ownership-Indeterminate round must skip BOTH
    /// the retain AND the process-group sub-scan — pre-retain membership may
    /// consist entirely of dead incarnations, which is no authority to adopt
    /// into a possibly recycled process-group id. The dead member stays
    /// retained (fail closed), the unrelated live process standing in the
    /// captured group id is NOT adopted, and the round ends poisoned.
    #[test]
    fn ownership_indeterminate_round_skips_retain_and_process_group_adoption() {
        let root = tempfile::tempdir().unwrap();
        // The ownership leg cannot decide the owned set (owned EISDIR environ).
        fake_proc_gap_entry(root.path(), i32::MAX - 2);
        // Bait for any code that consults the naked pgrp off unproven
        // membership: a live, unrelated process inside the captured group id,
        // named under the fake root so a wrongly-run pgrp scan would adopt it.
        // Its fake entry carries no `environ`, so the ownership leg skips it.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stand-in live group member");
        let pid = child.id() as i32;
        let pgrp = proc_info(pid).expect("live child").1;
        std::fs::create_dir(root.path().join(pid.to_string())).unwrap();
        let mut barrier = OwnedProcessTreeBarrier {
            ownership_env: "FRESHELL_TEST_B1_OWNERSHIP".to_string(),
            ownership_id: "i".to_string(),
            members: vec![(i32::MAX - 1, 1)], // long-dead captured leader
            process_group_id: Some(pgrp),
            scan_incomplete: false,
            test_proc_root: Some(root.path().to_path_buf()),
        };
        barrier.refresh_members();
        assert!(
            barrier.members.contains(&(i32::MAX - 1, 1)),
            "an ownership-Indeterminate round never shrinks membership: {:?}",
            barrier.members
        );
        assert!(
            !barrier.members.iter().any(|(known, _)| *known == pid),
            "never adopt off the naked pgrp without a verified-live incarnation: {:?}",
            barrier.members
        );
        assert!(barrier.scan_incomplete, "the round must end poisoned");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// fix-5 fix-review (B.1): a process-group gap discovered AFTER the
    /// stat-proven retain still poisons the round (quiescence is unprovable
    /// off an incomplete scan), but it neither revives a stat-proven-dead
    /// member nor drops the verified-live one the retain kept.
    #[test]
    fn process_group_gap_poisons_round_but_retain_stays_stat_proven() {
        let root = tempfile::tempdir().unwrap();
        // A proc root that cannot be listed: read_dir fails ⇒ Indeterminate.
        let gone_root = root.path().join("no-such-dir");
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn verified-live member");
        let pid = child.id() as i32;
        let start = proc_starttime(pid).expect("live child starttime");
        let mut barrier = OwnedProcessTreeBarrier {
            ownership_env: String::new(), // PTY-style: no ownership scan leg
            ownership_id: String::new(),
            members: vec![(i32::MAX - 1, 1), (pid, start)],
            process_group_id: Some(i32::MAX - 3),
            scan_incomplete: false,
            test_proc_root: Some(gone_root),
        };
        barrier.refresh_members();
        assert!(
            !barrier.members.contains(&(i32::MAX - 1, 1)),
            "the retain ran before the gap and pruned the stat-proven-dead member: {:?}",
            barrier.members
        );
        assert!(
            barrier.members.contains(&(pid, start)),
            "the verified-live member survives: {:?}",
            barrier.members
        );
        assert!(
            barrier.scan_incomplete,
            "a process-group gap still poisons the round"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// fix-5 fix-review (B.1) regression pin — the persisted-fence recovery
    /// scenario: every captured incarnation is dead (the captured tree died
    /// while the server was down) and the numeric group id has been recycled
    /// by an unrelated process. The retain prunes the stale incarnations, the
    /// process-group sub-scan never runs against a bare pgrp, the recycler is
    /// NOT adopted (hence never signaled), and the round confirms quiescence
    /// unpoisoned.
    #[test]
    fn recycled_process_group_id_is_never_adopted_after_last_incarnation_dies() {
        let root = tempfile::tempdir().unwrap();
        // The unrelated recycler: a live process currently holding the
        // captured group id, listed by the (listable) fake proc root.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stand-in group recycler");
        let pid = child.id() as i32;
        let pgrp = proc_info(pid).expect("live child").1;
        std::fs::create_dir(root.path().join(pid.to_string())).unwrap();
        let mut barrier = OwnedProcessTreeBarrier {
            ownership_env: String::new(), // PTY-style: capture_process_group
            ownership_id: String::new(),
            members: vec![(i32::MAX - 1, 1)], // the whole captured set, all dead
            process_group_id: Some(pgrp),
            scan_incomplete: false,
            test_proc_root: Some(root.path().to_path_buf()),
        };
        barrier.refresh_members();
        assert!(
            !barrier.members.iter().any(|(known, _)| *known == pid),
            "a recycled group id must never be adopted once every captured incarnation is gone: {:?}",
            barrier.members
        );
        assert!(
            barrier.members.is_empty(),
            "the stale all-dead capture is pruned on stat proof: {:?}",
            barrier.members
        );
        assert!(
            !barrier.scan_incomplete,
            "a fully-Complete round confirms quiescence — zero signals sent"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// fix-pass-2 review nit: the ownership scanner's root-level `read_dir`
    /// failure arm gets its own pin — an unlistable proc root is a
    /// `read_dir_failed` gap (barrier poison), never an empty scan.
    #[test]
    fn unlistable_root_makes_ownership_scan_indeterminate() {
        let root = std::path::Path::new("/no/such/proc-root-z06a");
        let scan = scan_owned_pids_in(root, "FRESHELL_TEST_ANY", "any-id");
        assert!(
            matches!(scan, OwnershipScan::Indeterminate(ref gap) if gap.read_dir_failed),
            "an unlistable root must be a read_dir gap, got {scan:?}"
        );
    }
}

//! Linux with a reachable user systemd manager: one transient SLICE per unit
//! and one SCOPE per member spawn, so every pane gets its own cgroup
//! (kernel-tracked membership: a `setsid`, double-forked or env-cleared job
//! stays in it whatever it does).
//!
//! `systemd-run --user --scope` places itself and then execs the command in
//! place (same pid, same PTY session, clean signal state), which also works
//! for PTY children that offer no pre-exec hook. The slices are siblings of
//! the server's own unit, so units survive a stop or restart of a
//! `KillMode=control-group` server unit (Stage 2: LB-03, LB-04).
//!
//! Layout (Stage 2: LB-01, LB-27): every server has its own namespace
//! `<ns>` (a hash of its state root), so servers with different state roots
//! never share a slice:
//! `freshell.slice/freshell-n<ns>.slice/freshell-n<ns>-<unit id>.slice/`
//! holds one `freshell-n<ns>-<unit id>-<role>-<boot>-<seq>.scope` per member
//! spawn, where `<boot>` is a nonce minted at selection (a scope started
//! after a restart never collides with a pre-restart scope a detached job
//! still populates). Implicit slices are never collected, so each unit slice
//! is stopped explicitly once it has emptied.
//!
//! The whole-unit kill freezes the slice, then either `cgroup.kill`s it or,
//! when Codex's own daemon family runs in it, SIGKILLs every other member
//! through a pidfd while the slice is frozen and thaws it: the daemon family
//! is spared in place and never moved or signalled (Stage 2: LB-49). Every
//! wait watches the unit SLICE's `cgroup.events` (never a scope directory,
//! which systemd can remove before its notification fires) and has a
//! deadline (Stage 2: LB-05).

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::{inotify, Backend, BackendKind, Capability, KillSummary, MemberList, UnitBackend};
use crate::containment::SelectOptions;
use crate::proc_watch::{ProcWatch, Sig};
use crate::process::{
    self, is_codex_daemon_family, run_capture_with_deadline, CommandOutput, ProcIdentity,
};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
/// The deadline of every systemd command this backend runs (a stalled user
/// bus blocks a command for 90 s otherwise; Stage 2: LB-27(d)).
const COMMAND_DEADLINE: Duration = Duration::from_secs(10);
/// How long the kill waits for the slice to report `frozen 1`.
const FREEZE_DEADLINE: Duration = Duration::from_secs(1);
/// The first systemd version whose `systemd-run` expands `$VAR` in command
/// arguments by default (and accepts `--expand-environment=no`).
const EXPANDS_ARGUMENTS_FROM: u32 = 254;

fn procs_recursive(dir: &Path, out: &mut Vec<u32>) {
    if let Ok(raw) = std::fs::read_to_string(dir.join("cgroup.procs")) {
        out.extend(raw.split_whitespace().filter_map(|p| p.parse::<u32>().ok()));
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                procs_recursive(&e.path(), out);
            }
        }
    }
}

/// The per-server namespace: the first 16 lowercase hex digits of the
/// SHA-256 of the canonicalized state root (an empty root hashes the empty
/// string; a root that cannot be canonicalized hashes as given).
fn namespace(state_root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let canonical = std::fs::canonicalize(state_root).unwrap_or_else(|_| state_root.to_path_buf());
    Sha256::digest(canonical.as_os_str().as_encoded_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 8 lowercase hex digits, fresh at every selection.
fn boot_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// The number on `systemd-run --version`'s first line (`systemd 255 (…)`).
fn systemd_version(first_line: &str) -> Option<u32> {
    first_line
        .strip_prefix("systemd ")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// What the backend learned at its probe; shared by every unit.
struct Shared {
    systemd_run: PathBuf,
    systemctl: PathBuf,
    /// `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, as captured.
    bus_env: Vec<(String, String)>,
    /// Add `--expand-environment=no` (systemd 254 or newer).
    no_expand: bool,
    /// The user manager's cgroup (`/user.slice/…/user@1000.service`).
    manager_cgroup: String,
    ns: String,
    boot: String,
}

impl Shared {
    /// `systemctl --user <args…>` under the command deadline; an error names
    /// what failed (the exit status and the first line of stderr).
    fn systemctl(&self, args: &[&str]) -> io::Result<CommandOutput> {
        let mut cmd = std::process::Command::new(&self.systemctl);
        cmd.arg("--user")
            .args(args)
            .envs(self.bus_env.iter().cloned());
        checked(run_capture_with_deadline(&mut cmd, COMMAND_DEADLINE)?)
    }

    /// The `systemd-run --user --scope …` prefix up to (and without) `--`.
    fn scope_args(&self, slice: &str, unit: Option<&str>) -> Vec<String> {
        let mut args = vec![
            self.systemd_run.to_string_lossy().into_owned(),
            "--user".into(),
            "--scope".into(),
            "--quiet".into(),
            "--collect".into(),
        ];
        if self.no_expand {
            args.push("--expand-environment=no".into());
        }
        args.push(format!("--slice={slice}"));
        if let Some(unit) = unit {
            args.push(format!("--unit={unit}"));
        }
        args
    }

    /// The cgroup path (relative to the cgroup root) of `slice`, a direct
    /// child of `freshell-n<ns>.slice`.
    fn slice_cgroup(&self, slice: &str) -> String {
        format!(
            "{}/freshell.slice/freshell-n{}.slice/{slice}",
            self.manager_cgroup.trim_end_matches('/'),
            self.ns
        )
    }
}

/// `Ok` for a zero exit; otherwise an error naming the status and the first
/// line of stderr.
fn checked(out: CommandOutput) -> io::Result<CommandOutput> {
    if out.status.success() {
        return Ok(out);
    }
    let detail = out.stderr.lines().next().unwrap_or("").trim().to_string();
    Err(io::Error::other(format!("{}: {detail}", out.status)))
}

pub(crate) struct SystemdBackend {
    shared: Arc<Shared>,
}

impl SystemdBackend {
    /// Checks, once at selection, that this process can place members in
    /// transient scopes of the user manager. Each step runs under a 10 s
    /// deadline; the whole probe is retried once, and a second failure
    /// returns the step and its error (or `timed out`).
    pub(crate) fn probe(opts: &SelectOptions) -> Result<Self, String> {
        match Self::probe_once(opts) {
            Ok(backend) => Ok(backend),
            Err(first) => Self::probe_once(opts).map_err(|second| {
                if second == first {
                    second
                } else {
                    format!("{second} (first attempt: {first})")
                }
            }),
        }
    }

    fn probe_once(opts: &SelectOptions) -> Result<Self, String> {
        if !Path::new(CGROUP_ROOT).join("cgroup.controllers").is_file() {
            return Err(format!("cgroup v2 is not mounted at {CGROUP_ROOT}"));
        }
        let systemd_run =
            process::find_on_path("systemd-run").ok_or("systemd-run is not on PATH")?;
        let systemctl = process::find_on_path("systemctl").ok_or("systemctl is not on PATH")?;
        let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
            .ok()
            .filter(|v| !v.is_empty())
            .ok_or("XDG_RUNTIME_DIR is not set")?;
        let bus = std::env::var("DBUS_SESSION_BUS_ADDRESS")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| format!("unix:path={runtime_dir}/bus"));
        let bus_env = vec![
            ("XDG_RUNTIME_DIR".to_string(), runtime_dir),
            ("DBUS_SESSION_BUS_ADDRESS".to_string(), bus),
        ];

        let step = |what: &str, err: io::Error| format!("{what}: {err}");
        let mut version = std::process::Command::new(&systemd_run);
        version.arg("--version");
        let version = run_capture_with_deadline(&mut version, COMMAND_DEADLINE)
            .and_then(checked)
            .map_err(|e| step("systemd-run --version", e))?;
        let first_line = version.stdout.lines().next().unwrap_or("");
        let version = systemd_version(first_line)
            .ok_or_else(|| format!("systemd-run --version: no version number in {first_line:?}"))?;

        let mut shared = Shared {
            systemd_run,
            systemctl,
            bus_env,
            no_expand: version >= EXPANDS_ARGUMENTS_FROM,
            manager_cgroup: String::new(),
            ns: namespace(&opts.state_root),
            boot: boot_nonce(),
        };
        let shown = shared
            .systemctl(&["show", "-p", "ControlGroup", "--value"])
            .map_err(|e| step("systemctl --user show", e))?;
        shared.manager_cgroup = shown.stdout.trim().to_string();
        if shared.manager_cgroup.is_empty() {
            return Err("systemctl --user show: the user manager has no cgroup".into());
        }

        // A throwaway scope in a probe slice of our own (named with this
        // probe's nonce, so concurrent probes never stop each other's).
        let probe_slice = format!("freshell-n{}-probe{}.slice", shared.ns, shared.boot);
        let mut place = std::process::Command::new(&shared.systemd_run);
        place
            .args(&shared.scope_args(&probe_slice, None)[1..])
            .args(["--", "cat", "/proc/self/cgroup"])
            .envs(shared.bus_env.iter().cloned());
        let placed = run_capture_with_deadline(&mut place, COMMAND_DEADLINE)
            .map_err(|e| step("systemd-run --user --scope", e))?;
        let expected = format!("{}/", shared.slice_cgroup(&probe_slice));
        let slice_dir = Path::new(CGROUP_ROOT).join(expected.trim_start_matches('/'));
        let landed = checked(placed)
            .map_err(|e| step("systemd-run --user --scope", e))
            .and_then(|out| {
                let cgroup = out
                    .stdout
                    .lines()
                    .find_map(|l| l.strip_prefix("0::"))
                    .unwrap_or("")
                    .to_string();
                if cgroup.starts_with(&expected) && slice_dir.is_dir() {
                    Ok(())
                } else {
                    Err(format!(
                        "systemd-run --user --scope: the probe ran in {cgroup:?}, not under {expected:?}"
                    ))
                }
            });
        // Implicit slices are never collected: stop the probe slice.
        if let Err(err) = shared.systemctl(&["stop", &probe_slice]) {
            tracing::warn!(target: "freshell_unit",
                event = "containment.probe_slice_stop_failed",
                slice = %probe_slice,
                error = %err,
                "systemd probe slice could not be stopped");
        }
        landed?;
        Ok(Self {
            shared: Arc::new(shared),
        })
    }

    fn unit(&self, id: &UnitId) -> SystemdUnit {
        let slice = format!("freshell-n{}-{}.slice", self.shared.ns, id.as_str());
        let cgroup = self.shared.slice_cgroup(&slice);
        let dir = Path::new(CGROUP_ROOT).join(cgroup.trim_start_matches('/'));
        SystemdUnit {
            shared: self.shared.clone(),
            unit_id: id.as_str().to_string(),
            slice,
            cgroup,
            dir,
        }
    }
}

impl Backend for SystemdBackend {
    fn capability(&self) -> Capability {
        Capability {
            kind: BackendKind::SystemdScope,
            full: true,
            reason: None,
        }
    }

    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(self.unit(id)))
    }

    /// The same slice, unchecked: a unit already gone simply stops at once.
    fn reopen(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        self.create(id)
    }
}

/// One unit: its slice and the slice's cgroup directory.
pub(crate) struct SystemdUnit {
    shared: Arc<Shared>,
    unit_id: String,
    /// `freshell-n<ns>-<unit id>.slice`
    slice: String,
    /// The slice's cgroup path relative to the cgroup root.
    cgroup: String,
    /// The slice's cgroup directory.
    dir: PathBuf,
}

impl SystemdUnit {
    /// The live (non-zombie) processes of the slice and of every scope in it.
    fn pids(&self) -> BTreeSet<u32> {
        let mut out = Vec::new();
        procs_recursive(&self.dir, &mut out);
        out.into_iter()
            .filter(|pid| process::is_running(*pid))
            .collect()
    }

    /// Whether the cgroup path `cgroup` lies in this unit's slice.
    fn contains(&self, cgroup: &str) -> bool {
        cgroup == self.cgroup
            || cgroup
                .strip_prefix(&self.cgroup)
                .is_some_and(|rest| rest.starts_with('/'))
    }

    /// The kill's work once the slice is frozen (or could not be): one
    /// snapshot, the spared set, the kill, and always the thaw.
    fn kill_frozen(&self) -> io::Result<KillSummary> {
        let pids = self.pids();
        let spared = spared_within(&pids);
        let killed = self.kill_all_but(&pids, &spared);
        // Thawed whatever the kill did, so spared processes resume in place.
        let thawed = std::fs::write(self.dir.join("cgroup.freeze"), "0");
        let killed = killed?;
        if let Err(err) = thawed {
            // A slice systemd removed meanwhile has nothing left to thaw.
            if self.dir.is_dir() {
                return Err(io::Error::other(format!("cgroup.freeze (thaw): {err}")));
            }
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

    /// SIGKILLs every process of `pids` outside `spared`; returns how many.
    /// With nothing spared, the kernel kills the whole slice (`cgroup.kill`,
    /// race-free against forks), else `systemctl --user kill`. With spared
    /// processes, each other pid is pinned and re-checked as a slice member
    /// before its SIGKILL (frozen tasks cannot fork, exit or exec, and a
    /// fatal signal still kills them), so no recycled pid is ever signalled;
    /// a pid that cannot be pinned for another reason than being gone (for
    /// example, no descriptor left) fails the kill after the others.
    fn kill_all_but(&self, pids: &BTreeSet<u32>, spared: &BTreeSet<u32>) -> io::Result<usize> {
        if !spared.is_empty() {
            let mut killed = 0;
            let mut pin_error = None;
            for pid in pids.difference(spared) {
                let watch = match ProcWatch::open(*pid) {
                    Ok(watch) => watch,
                    Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                    Err(err) => {
                        pin_error.get_or_insert(err);
                        continue;
                    }
                };
                let member = cgroup_of(watch.pid()).is_some_and(|cg| self.contains(&cg));
                if member && !watch.has_exited() && watch.signal(Sig::Kill).is_ok() {
                    killed += 1;
                }
            }
            return pin_error.map_or(Ok(killed), Err);
        }
        if let Err(err) = std::fs::write(self.dir.join("cgroup.kill"), "1") {
            // A slice systemd removed meanwhile has nothing left to kill.
            if self.dir.is_dir() {
                self.shared
                    .systemctl(&["kill", "--signal=SIGKILL", &self.slice])
                    .map_err(|fallback| {
                        io::Error::other(format!("cgroup.kill: {err}; systemctl kill: {fallback}"))
                    })?;
            }
        }
        Ok(pids.len())
    }
}

/// `pid`'s cgroup v2 path (one read of `/proc/<pid>/cgroup`); `None` when it
/// cannot be read (the process is gone).
fn cgroup_of(pid: u32) -> Option<String> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    Some(
        raw.lines()
            .find_map(|l| l.strip_prefix("0::"))
            .unwrap_or("")
            .to_string(),
    )
}

/// The daemon-family processes among `pids` (each judged by its own argv)
/// plus every process of `pids` whose parent is spared, iterating to a fixed
/// point over the snapshot. It can only spare a process, never select one.
fn spared_within(pids: &BTreeSet<u32>) -> BTreeSet<u32> {
    let mut spared: BTreeSet<u32> = pids
        .iter()
        .copied()
        .filter(|pid| process::argv(*pid).is_ok_and(|argv| is_codex_daemon_family(&argv)))
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

impl UnitBackend for SystemdUnit {
    fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
        let role = match role {
            MemberRole::Screen => "screen",
            MemberRole::Agent => "agent",
        };
        let scope = format!(
            "freshell-n{}-{}-{role}-{}-{seq}.scope",
            self.shared.ns, self.unit_id, self.shared.boot
        );
        let mut wrapper = self.shared.scope_args(&self.slice, Some(&scope));
        wrapper.push("--".into());
        let mut env = self.shared.bus_env.clone();
        env.push((UNIT_ENV.to_string(), self.unit_id.clone()));
        Ok(Placement {
            wrapper: Some(wrapper),
            env,
        })
    }

    fn kill_all(
        self: Arc<Self>,
        _roots: Vec<(u32, u64)>,
    ) -> BoxFuture<'static, io::Result<KillSummary>> {
        Box::pin(async move {
            // No slice yet: the unit kills its pinned roots itself.
            if !self.dir.is_dir() {
                return Ok(KillSummary::default());
            }
            let not_frozen = match std::fs::write(self.dir.join("cgroup.freeze"), "1") {
                Ok(()) => tokio::time::timeout(
                    FREEZE_DEADLINE,
                    inotify::wait_flag(self.dir.clone(), "frozen ", 1),
                )
                .await
                .err()
                .map(|_| format!("no frozen event within {} ms", FREEZE_DEADLINE.as_millis())),
                Err(_) if !self.dir.is_dir() => return Ok(KillSummary::default()),
                Err(err) => Some(format!("cgroup.freeze: {err}")),
            };
            let unit = self.clone();
            let summary = tokio::task::spawn_blocking(move || unit.kill_frozen())
                .await
                .map_err(io::Error::other)??;
            Ok(KillSummary {
                not_frozen,
                ..summary
            })
        })
    }

    fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
        let pids = self.pids();
        let spared = spared_within(&pids);
        Ok(MemberList {
            members: pids
                .difference(&spared)
                .filter_map(|pid| process::identity(*pid).ok())
                .collect::<Vec<ProcIdentity>>(),
            withheld: 0,
        })
    }

    fn confirm_placement(&self, pid: u32, _roots: &[(u32, u64)]) -> io::Result<()> {
        let cgroup = process::is_running(pid)
            .then(|| cgroup_of(pid))
            .flatten()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, format!("process {pid} is gone"))
            })?;
        if self.contains(&cgroup) {
            return Ok(());
        }
        Err(io::Error::other(format!(
            "process {pid} runs in cgroup {cgroup}, not in unit slice {}",
            self.cgroup
        )))
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>> {
        Some(Box::pin(inotify::wait_flag(
            self.dir.clone(),
            "populated ",
            0,
        )))
    }

    /// Stops the emptied slice (implicit slices are never collected). A slice
    /// that did not empty (a spared daemon or survivors, already logged by
    /// the unit) is left running.
    fn remove(&self, emptied: bool) -> io::Result<()> {
        if emptied && self.dir.is_dir() {
            self.shared.systemctl(&["stop", &self.slice])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only systemd 254 and newer expand `$VAR` in `systemd-run` arguments
    /// (and know `--expand-environment=no`); an older one refuses the flag,
    /// which would fail every placement.
    #[test]
    fn the_version_decides_the_no_expand_flag() {
        let expands = |line: &str| systemd_version(line).map(|v| v >= EXPANDS_ARGUMENTS_FROM);
        assert_eq!(expands("systemd 255 (255.4-1ubuntu8.17)"), Some(true));
        assert_eq!(expands("systemd 254 (254.5-1)"), Some(true));
        assert_eq!(expands("systemd 249 (249.11-0ubuntu3.12)"), Some(false));
        assert_eq!(expands("systemd-run 255"), None);
        assert_eq!(expands(""), None);
    }
}

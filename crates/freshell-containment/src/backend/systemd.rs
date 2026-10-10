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
//! when Codex's own daemon family runs in it (or the freeze cannot be
//! confirmed), SIGKILLs every other member through a pidfd and thaws it: the
//! daemon family is spared in place and never moved or signalled (Stage 2:
//! LB-49). The thaw is armed as soon as the freeze is written, so a kill
//! dropped mid-way still thaws the slice. Every wait watches the unit
//! SLICE's `cgroup.events` (never a scope directory, which systemd can
//! remove before its notification fires) and has a deadline (Stage 2:
//! LB-05); a wait that cannot watch it never counts as frozen or empty, and
//! a slice is stopped only when it reads empty.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::{
    inotify, spared_closure, Backend, BackendKind, Capability, KillSummary, MemberList, UnitBackend,
};
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

/// The number on `systemd-run --version`'s first line (`systemd 255 (…)`;
/// a pre-release `systemd 256~rc3 (…)` counts as 256).
fn systemd_version(first_line: &str) -> Option<u32> {
    let token = first_line
        .strip_prefix("systemd ")?
        .split_whitespace()
        .next()?;
    let digits = token
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(token.len());
    token[..digits].parse().ok()
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

    /// The kill's work once the slice is frozen (`frozen`) or could not be
    /// confirmed so: one snapshot, the spared set, the kill, and the thaw.
    fn kill_frozen(&self, thaw: Option<Thaw>, frozen: bool) -> io::Result<KillSummary> {
        let pids = self.pids();
        let spared = spared_closure(pids.iter().copied());
        let killed = self.kill_all_but(&pids, &spared, frozen);
        // Thawed whatever the kill did, so spared processes resume in place.
        let thawed = thaw.map_or(Ok(()), Thaw::now);
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
    ///
    /// Only a slice confirmed `frozen` with nothing spared is killed whole by
    /// the kernel (`cgroup.kill`, race-free against forks; else `systemctl
    /// --user kill`). A slice that may still be running can start a
    /// daemon-family process after the snapshot, which a whole-slice kill
    /// would kill too; so then, as when processes are spared, each other pid
    /// is pinned and re-checked before its SIGKILL: still a slice member (no
    /// recycled pid is ever signalled) and, by its own argv, still not of the
    /// daemon family. Frozen tasks cannot fork, exit or exec, and a fatal
    /// signal still kills them; what an unfrozen slice forks after the
    /// snapshot is left to the post-Gone sweep. A pid that cannot be pinned
    /// for another reason than being gone (for example, no descriptor left)
    /// fails the kill after the others.
    fn kill_all_but(
        &self,
        pids: &BTreeSet<u32>,
        spared: &BTreeSet<u32>,
        frozen: bool,
    ) -> io::Result<usize> {
        if !spared.is_empty() || !frozen {
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
                let daemon = process::argv(watch.pid()).is_ok_and(|a| is_codex_daemon_family(&a));
                if member && !daemon && !watch.has_exited() && watch.signal(Sig::Kill).is_ok() {
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

/// Thaws a slice it was made for when dropped, unless thawed already: made
/// right after the slice's `cgroup.freeze` is set, it moves with the kill,
/// so a kill dropped mid-way (its stop cancelled, or its blocking task
/// cancelled before it ran, as at a runtime shutdown) still thaws the slice
/// and a spared daemon family in it runs on.
struct Thaw(Option<PathBuf>);

impl Thaw {
    fn armed(slice_dir: &Path) -> Self {
        Self(Some(slice_dir.join("cgroup.freeze")))
    }

    /// Thaws now, returning the write's error.
    fn now(mut self) -> io::Result<()> {
        self.0
            .take()
            .map_or(Ok(()), |freeze| std::fs::write(freeze, "0"))
    }
}

impl Drop for Thaw {
    fn drop(&mut self) {
        if let Some(freeze) = self.0.take() {
            let _ = std::fs::write(freeze, "0");
        }
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
            let (thaw, not_frozen) = match std::fs::write(self.dir.join("cgroup.freeze"), "1") {
                Ok(()) => {
                    // From here on the slice is thawed whatever happens.
                    let thaw = Thaw::armed(&self.dir);
                    let frozen = tokio::time::timeout(
                        FREEZE_DEADLINE,
                        inotify::wait_flag(self.dir.clone(), "frozen ", 1),
                    )
                    .await;
                    let not_frozen = match frozen {
                        Ok(Ok(())) => None,
                        Ok(Err(err)) => Some(format!("cgroup.events watch: {err}")),
                        Err(_) => Some(format!(
                            "no frozen event within {} ms",
                            FREEZE_DEADLINE.as_millis()
                        )),
                    };
                    (Some(thaw), not_frozen)
                }
                Err(_) if !self.dir.is_dir() => return Ok(KillSummary::default()),
                Err(err) => (None, Some(format!("cgroup.freeze: {err}"))),
            };
            let unit = self.clone();
            let frozen = not_frozen.is_none();
            let summary = tokio::task::spawn_blocking(move || unit.kill_frozen(thaw, frozen))
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
        let spared = spared_closure(pids.iter().copied());
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

    fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
        Some(Box::pin(inotify::wait_flag(
            self.dir.clone(),
            "populated ",
            0,
        )))
    }

    /// Stops the emptied slice (implicit slices are never collected). A slice
    /// that did not empty (a spared daemon or survivors, already logged by
    /// the unit) is left running.
    ///
    /// Stopping a slice kills everything in it, so `emptied` alone is not
    /// enough: one read of `cgroup.events` must show it empty now (a read
    /// that fails or shows it populated keeps it, with an error for the
    /// unit to log). A slice that does not exist is stopped all the same: a
    /// placement killed mid-way may still have it created, and the user
    /// manager handles that earlier start request first.
    fn remove(&self, emptied: bool) -> io::Result<()> {
        if !emptied {
            return Ok(());
        }
        match std::fs::read_to_string(self.dir.join("cgroup.events")) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(io::Error::other(format!(
                    "{} kept: cgroup.events: {err}",
                    self.slice
                )))
            }
            Ok(events) if events.lines().any(|l| l.trim() == "populated 0") => {}
            Ok(_) => {
                return Err(io::Error::other(format!(
                    "{} kept: it holds processes again",
                    self.slice
                )))
            }
        }
        self.shared.systemctl(&["stop", &self.slice])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_capture::{capture, CapturedEvent, FieldValue};
    use crate::record::RecordStore;
    use crate::unit::{AgentUnit, StopMode, StopReason, StopRequest, UnitLabel};

    /// A process of the test's own, pinned while it is the test's unreaped
    /// child, killed through that pin and reaped when dropped.
    struct Own {
        child: std::process::Child,
        watch: ProcWatch,
    }

    impl Own {
        fn start(command: &mut std::process::Command) -> Self {
            let child = command.stdin(std::process::Stdio::null()).spawn().unwrap();
            let watch = ProcWatch::open(child.id()).unwrap();
            Self { child, watch }
        }

        /// A stand-in for Codex's managed daemon (judged by its argv),
        /// returned once it runs as one. `spawn` returns before the child's
        /// exec has finished: until then its `/proc/<pid>/cmdline` reads this
        /// test's own argv, then nothing, and neither is the daemon family.
        /// So the stand-in prints a line from its own program, and this
        /// waits for that line.
        fn daemon() -> Self {
            use std::io::{BufRead, BufReader};
            let mut own = Self::start(
                std::process::Command::new("perl")
                    .args(["-e", r#"$| = 1; print "running\n"; sleep 600"#])
                    .args(["app-server", "--managed-daemon"])
                    .stdout(std::process::Stdio::piped()),
            );
            let mut line = String::new();
            BufReader::new(own.child.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(line, "running\n", "the daemon stand-in did not start");
            own
        }

        fn sleep() -> Self {
            Self::start(std::process::Command::new("sleep").arg("600"))
        }

        fn pid(&self) -> u32 {
            self.watch.pid()
        }

        /// Whether it exits within 5 s (it was killed).
        fn dies(&self) -> bool {
            self.watch
                .wait_exited_blocking(Duration::from_secs(5))
                .unwrap()
        }
    }

    impl Drop for Own {
        fn drop(&mut self) {
            let _ = self.watch.signal(Sig::Kill);
            let _ = self.child.wait();
        }
    }

    /// Writes an executable script without this multi-threaded process ever
    /// holding a write descriptor to it: a child another test forked
    /// meanwhile would hold it open, and running the script would then fail
    /// with ETXTBSY.
    fn write_script(path: &Path, body: &str) {
        let status = std::process::Command::new("sh")
            .args([
                "-c",
                "printf '%s' \"$2\" > \"$1\" && chmod 755 \"$1\"",
                "sh",
            ])
            .arg(path)
            .arg(body)
            .status()
            .unwrap();
        assert!(status.success(), "{status:?}");
    }

    /// A stand-in for one unit slice: a directory holding the cgroup files
    /// the backend reads and writes (the test plays the kernel's part), and a
    /// `systemctl` that only records its arguments. Its processes are the
    /// test's own children, so the slice's cgroup is the test's own.
    struct FakeSlice {
        root: tempfile::TempDir,
        unit: Arc<SystemdUnit>,
    }

    impl FakeSlice {
        /// Populated, not frozen, and it never freezes by itself (as when a
        /// member sleeps uninterruptibly).
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("slice");
            std::fs::create_dir(&dir).unwrap();
            let systemctl = root.path().join("systemctl");
            write_script(
                &systemctl,
                &format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n",
                    root.path().join("systemctl.log").display()
                ),
            );
            let id = UnitId::mint();
            let unit = Arc::new(SystemdUnit {
                shared: Arc::new(Shared {
                    systemd_run: PathBuf::from("/nonexistent/systemd-run"),
                    systemctl,
                    bus_env: Vec::new(),
                    no_expand: true,
                    manager_cgroup: "/user.slice/user-1000.slice/user@1000.service".into(),
                    ns: "0123456789abcdef".into(),
                    boot: "01234567".into(),
                }),
                unit_id: id.as_str().to_string(),
                slice: format!("freshell-n0123456789abcdef-{}.slice", id.as_str()),
                cgroup: cgroup_of(std::process::id()).unwrap(),
                dir,
            });
            let slice = Self { root, unit };
            slice.write("cgroup.procs", "");
            slice.set_events(1, 0);
            slice.write("cgroup.freeze", "0\n");
            slice
        }

        fn dir(&self) -> &Path {
            &self.unit.dir
        }

        fn write(&self, file: &str, content: &str) {
            std::fs::write(self.dir().join(file), content).unwrap();
        }

        fn read(&self, file: &str) -> String {
            std::fs::read_to_string(self.dir().join(file))
                .unwrap()
                .trim()
                .to_string()
        }

        fn set_events(&self, populated: u8, frozen: u8) {
            self.write(
                "cgroup.events",
                &format!("populated {populated}\nfrozen {frozen}\n"),
            );
        }

        fn set_procs(&self, procs: &[&Own]) {
            let pids: Vec<String> = procs.iter().map(|p| p.pid().to_string()).collect();
            self.write("cgroup.procs", &pids.join("\n"));
        }

        /// Makes every watch and read of `cgroup.events` fail (a symlink
        /// loop: ELOOP), as when no inotify instance or watch can be had.
        fn break_events(&self) {
            let events = self.dir().join("cgroup.events");
            std::fs::remove_file(&events).unwrap();
            std::os::unix::fs::symlink("cgroup.events", &events).unwrap();
        }

        /// The argument lists `systemctl` was run with.
        fn systemctl_calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.root.path().join("systemctl.log"))
                .map(|log| log.lines().map(str::to_string).collect())
                .unwrap_or_default()
        }

        /// A Codex unit on this slice (keys `s-1` / `t-1`).
        fn agent_unit(&self) -> AgentUnit {
            AgentUnit::new(
                UnitId::parse(&self.unit.unit_id).unwrap(),
                self.unit.clone(),
                Capability {
                    kind: BackendKind::SystemdScope,
                    full: true,
                    reason: None,
                },
                Arc::new(RecordStore::open(Path::new(""))),
                UnitLabel {
                    provider: "codex".into(),
                    session_id: Some("s-1".into()),
                    terminal_id: Some("t-1".into()),
                    mode: "codex".into(),
                    create_request_id: None,
                },
                None,
            )
        }
    }

    fn current_thread() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn named<'a>(events: &'a [CapturedEvent], name: &str) -> Vec<&'a CapturedEvent> {
        events
            .iter()
            .filter(|e| e.fields.get("event") == Some(&FieldValue::Text(name.into())))
            .collect()
    }

    /// A stop whose cgroup watches cannot be set up never takes the failure
    /// for "frozen" or "emptied": it logs the unconfirmed freeze with the
    /// unit's keys, still spares the daemon-family process, and never stops
    /// the slice (stopping it would kill the spared daemon family with it).
    #[test]
    fn a_stop_whose_cgroup_watch_fails_logs_the_unconfirmed_freeze_and_keeps_the_slice() {
        let slice = FakeSlice::new();
        slice.break_events();
        let doomed = Own::sleep();
        let daemon = Own::daemon();
        slice.set_procs(&[&doomed, &daemon]);
        let unit = slice.agent_unit();
        let events = capture(|| {
            current_thread().block_on(async {
                unit.stop(
                    StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws").operation("op-1"),
                )
                .wait_swept()
                .await;
            })
        });
        assert!(doomed.dies(), "the slice's other process survived");
        assert!(
            !daemon.watch.has_exited(),
            "the daemon-family process was killed"
        );
        assert_eq!(
            slice.systemctl_calls(),
            Vec::<String>::new(),
            "a slice never seen empty was stopped"
        );
        assert_eq!(
            slice.read("cgroup.freeze"),
            "0",
            "the slice was left frozen"
        );
        let unconfirmed = named(&events, "unit.stop.freeze_timeout");
        assert!(!unconfirmed.is_empty(), "the missed freeze was not logged");
        for event in unconfirmed {
            assert_eq!(event.level, tracing::Level::WARN);
            assert_eq!(event.str("unit_id"), unit.id().as_str());
            assert_eq!(event.str("provider"), "codex");
            assert_eq!(event.str("session_id"), "s-1");
            assert_eq!(event.str("terminal_id"), "t-1");
            assert_eq!(event.str("operation_id"), "op-1");
            assert!(event.str("detail").contains("cgroup.events"), "{event:?}");
        }
    }

    /// The slice is stopped only when one read of its `cgroup.events` shows
    /// it empty, whatever the caller says about the empty event (a populated
    /// slice can hold a spared Codex daemon family, which would die with
    /// it), or when it does not exist yet: a placement still under way can
    /// create it later, and the stop then removes it.
    #[test]
    fn only_a_slice_that_reads_empty_or_absent_is_stopped() {
        let slice = FakeSlice::new();
        let stop = format!("--user stop {}", slice.unit.slice);
        assert!(slice.unit.remove(true).is_err(), "a populated slice");
        assert_eq!(slice.systemctl_calls(), Vec::<String>::new());

        slice.set_events(0, 0);
        slice.unit.remove(false).unwrap();
        assert_eq!(slice.systemctl_calls(), Vec::<String>::new());
        slice.unit.remove(true).unwrap();
        assert_eq!(slice.systemctl_calls(), std::slice::from_ref(&stop));

        std::fs::remove_dir_all(slice.dir()).unwrap();
        slice.unit.remove(true).unwrap();
        assert_eq!(slice.systemctl_calls(), [stop.clone(), stop]);
    }

    /// The thaw does not depend on the kill finishing: a stop dropped while
    /// its kill waits for the slice to freeze (as at a server shutdown)
    /// leaves the slice thawed, so a spared daemon family in it runs on.
    #[test]
    fn a_stop_dropped_while_the_slice_freezes_leaves_it_thawed() {
        let slice = FakeSlice::new();
        let unit = slice.agent_unit();
        let runtime = current_thread();
        runtime.block_on(async {
            let _ = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "ws"));
            // The kill freezes the slice, then waits up to a second for a
            // "frozen 1" that never comes.
            let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
            while slice.read("cgroup.freeze") != "1" {
                assert!(tokio::time::Instant::now() < deadline, "never froze");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        drop(runtime);
        assert_eq!(
            slice.read("cgroup.freeze"),
            "0",
            "the slice was left frozen"
        );
    }

    /// A kill that cannot confirm the slice frozen never uses the kernel's
    /// whole-slice kill: a running slice can start a daemon-family process
    /// after the snapshot, and `cgroup.kill` would kill it too. It kills each
    /// process of its snapshot through a pin instead.
    #[test]
    fn an_unconfirmed_freeze_kills_the_snapshot_one_by_one() {
        let slice = FakeSlice::new();
        let doomed = Own::sleep();
        slice.set_procs(&[&doomed]);
        let summary = current_thread()
            .block_on(slice.unit.clone().kill_all(Vec::new()))
            .unwrap();
        assert_eq!(
            summary.not_frozen.as_deref(),
            Some("no frozen event within 1000 ms")
        );
        assert!(
            !slice.dir().join("cgroup.kill").exists(),
            "the whole-slice kill ran on a slice that was not frozen"
        );
        assert!(doomed.dies(), "the snapshot's process survived");
        assert_eq!(
            slice.read("cgroup.freeze"),
            "0",
            "the slice was left frozen"
        );
    }

    /// An unfrozen slice's processes can still exec: each is judged again by
    /// its own argv once pinned, so one that became a daemon-family process
    /// after the snapshot is never killed. Only a frozen slice with nothing
    /// spared is killed whole.
    #[test]
    fn an_unfrozen_kill_judges_each_process_again_before_its_signal() {
        let slice = FakeSlice::new();
        let daemon = Own::daemon();
        let doomed = Own::sleep();
        let pids = BTreeSet::from([daemon.pid(), doomed.pid()]);
        // The snapshot judged neither of the daemon family (as before an exec).
        let killed = slice
            .unit
            .kill_all_but(&pids, &BTreeSet::new(), false)
            .unwrap();
        assert_eq!(killed, 1);
        assert!(doomed.dies(), "the other process survived");
        assert!(
            !daemon.watch.has_exited(),
            "the daemon-family process was killed"
        );
        assert!(!slice.dir().join("cgroup.kill").exists());

        let killed = slice
            .unit
            .kill_all_but(&BTreeSet::from([daemon.pid()]), &BTreeSet::new(), true)
            .unwrap();
        assert_eq!(killed, 1);
        assert_eq!(
            slice.read("cgroup.kill"),
            "1",
            "a frozen slice is killed whole"
        );
    }

    /// A cgroup wait resolves on the flag (already shown, or shown later:
    /// the change wakes it) or on a removed cgroup, and is an error whenever
    /// it cannot watch or read the file: never the flag.
    #[test]
    fn a_cgroup_wait_resolves_only_on_the_flag_or_a_removed_cgroup() {
        let slice = FakeSlice::new();
        let dir = slice.dir().to_path_buf();
        current_thread().block_on(async {
            inotify::wait_flag(dir.clone(), "populated ", 1)
                .await
                .unwrap();
            let waiter = tokio::spawn(inotify::wait_flag(dir.clone(), "frozen ", 1));
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!waiter.is_finished(), "resolved before the flag was shown");
            slice.set_events(1, 1);
            tokio::time::timeout(Duration::from_secs(5), waiter)
                .await
                .expect("the change did not wake the wait")
                .unwrap()
                .unwrap();

            let removed = slice.root.path().join("removed");
            inotify::wait_flag(removed, "populated ", 0).await.unwrap();

            // No watch can be set up on a path through a regular file.
            let file = slice.root.path().join("file");
            std::fs::write(&file, "").unwrap();
            let err = inotify::wait_flag(file, "populated ", 0).await.unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::NotADirectory, "{err}");

            slice.write("cgroup.events", "populated 1\n");
            let err = inotify::wait_flag(dir.clone(), "frozen ", 1)
                .await
                .unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{err}");

            slice.break_events();
            inotify::wait_flag(dir.clone(), "populated ", 0)
                .await
                .unwrap_err();
        });
    }

    /// Only systemd 254 and newer expand `$VAR` in `systemd-run` arguments
    /// (and know `--expand-environment=no`); an older one refuses the flag,
    /// which would fail every placement.
    #[test]
    fn the_version_decides_the_no_expand_flag() {
        let expands = |line: &str| systemd_version(line).map(|v| v >= EXPANDS_ARGUMENTS_FROM);
        assert_eq!(expands("systemd 255 (255.4-1ubuntu8.17)"), Some(true));
        assert_eq!(expands("systemd 254 (254.5-1)"), Some(true));
        assert_eq!(expands("systemd 249 (249.11-0ubuntu3.12)"), Some(false));
        // A pre-release build is the version it leads up to.
        assert_eq!(expands("systemd 256~rc3 (256~rc3-1)"), Some(true));
        assert_eq!(expands("systemd 253~rc1 (253~rc1-2)"), Some(false));
        assert_eq!(expands("systemd-run 255"), None);
        assert_eq!(expands("systemd ~rc3"), None);
        assert_eq!(expands(""), None);
    }
}

#![allow(dead_code)]
pub mod capture;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use freshell_containment::{
    process, AgentUnit, BackendKind, Containment, MemberRole, ProcWatch, SelectOptions,
    ShimCommand, Sig,
};

/// The test build of the `__unit-exec` shim (the server passes its own exe).
pub fn test_shim() -> ShimCommand {
    ShimCommand {
        exe: env!("CARGO_BIN_EXE_freshell-unit-exec").into(),
        leading_args: Vec::new(),
    }
}

/// The backends this host must pass the conformance suite on: always the tag
/// backend; plus the selected backend when it is a full one. With
/// FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 (garageserver) the
/// selected backend MUST be the systemd one.
pub fn backends() -> Vec<(&'static str, Containment)> {
    let opts = SelectOptions {
        shim: Some(test_shim()),
        ..Default::default()
    };
    let mut out = vec![("tag", Containment::tag_backend(opts.clone()))];
    let selected = Containment::select(opts);
    let kind = selected.capability().kind;
    if std::env::var("FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT").as_deref() == Ok("1") {
        assert_eq!(
            kind,
            BackendKind::SystemdScope,
            "systemd containment required on this host"
        );
    }
    if selected.capability().full {
        out.push(("selected", selected));
    }
    out
}

/// The same selection as [`backends`], each built with its own state root
/// (`<root>/<name>`), for tests that exercise unit records.
pub fn backends_with_state(root: &Path) -> Vec<(&'static str, Containment)> {
    let mut out = vec![("tag", rebuild("tag", root))];
    let selected = rebuild("selected", root);
    if std::env::var("FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT").as_deref() == Ok("1") {
        assert_eq!(
            selected.capability().kind,
            BackendKind::SystemdScope,
            "systemd containment required on this host"
        );
    }
    if selected.capability().full {
        out.push(("selected", selected));
    }
    out
}

/// A fresh `Containment` of the named kind (`tag` or `selected`) on the
/// state root `backends_with_state(root)` gave it: a "restarted server".
pub fn rebuild(name: &str, root: &Path) -> Containment {
    let opts = SelectOptions {
        shim: Some(test_shim()),
        state_root: root.join(name),
    };
    match name {
        "tag" => Containment::tag_backend(opts),
        "selected" => Containment::select(opts),
        other => panic!("unknown backend {other}"),
    }
}

/// `<state root>/units/<unit id>.json` for a backend from `backends_with_state(root)`.
pub fn record_path(root: &Path, name: &str, unit: &AgentUnit) -> PathBuf {
    root.join(name)
        .join("units")
        .join(format!("{}.json", unit.id().as_str()))
}

#[derive(Default, Clone)]
pub struct AgentOpts {
    pub exit_on_int: bool,
    pub exit_on_term: bool,
    pub managed_daemon_child: bool,
    pub lock_child: Option<PathBuf>,
    /// Also start the rest of the Codex daemon family as direct children: an
    /// updater stand-in (`… app-server daemon pid-update-loop`) with one
    /// plain `sleep` child (the installer stand-in), and a legacy launch
    /// stand-in (`… app-server --listen unix://`).
    pub daemon_family: bool,
    /// A child that ignores SIGINT and runs without the unit tag (an MCP
    /// server Codex starts with an environment allow-list).
    pub untagged_child: bool,
    /// The INT trap first copies this file to `<dir>/at-signal.json`.
    pub on_int_copy: Option<PathBuf>,
    /// A detached job: an own-session intermediate starts it and exits; the
    /// job waits until the intermediate is gone and then execs
    /// `env -i /bin/sleep 600` (no tag, own session, parent link lost).
    pub envless_job: bool,
}

pub struct AgentScript {
    pub dir: tempfile::TempDir,
    pub script: PathBuf,
    pub pids: PathBuf,
    pub marker: PathBuf,
    /// The unit main `spawn_main` started (the reaper shim on the tag
    /// backend), pinned while it is the test's own unreaped child.
    main: Mutex<Option<ProcWatch>>,
    /// The script's own bash, pinned as soon as it reports its pid.
    agent: Mutex<Option<ProcWatch>>,
    /// Everything else the script reported starting, pinned while alive.
    pins: Mutex<Vec<ProcWatch>>,
}

/// A test that fails at any point leaves nothing running. The agent is
/// killed first: a reaper shim main then kills the whole tree it holds,
/// including what the script started before it reported its pids, and exits
/// (bounded wait); then every pin, the main included, is killed.
impl Drop for AgentScript {
    fn drop(&mut self) {
        let main = take(&mut self.main);
        let agent = take(&mut self.agent);
        if let Some(agent) = &agent {
            let _ = agent.signal(Sig::Kill);
            if let Some(main) = main.as_ref().filter(|m| m.pid() != agent.pid()) {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !main.has_exited() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        let pins = self.pins.get_mut().unwrap_or_else(PoisonError::into_inner);
        for watch in main.iter().chain(pins.iter()) {
            let _ = watch.signal(Sig::Kill);
        }
    }
}

fn take(slot: &mut Mutex<Option<ProcWatch>>) -> Option<ProcWatch> {
    slot.get_mut()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

impl AgentScript {
    fn pin(&self, pid: u32) {
        if let Ok(watch) = ProcWatch::open(pid) {
            self.pins.lock().unwrap().push(watch);
        }
    }

    /// Pins the script's bash as soon as it reports its pid. The pinned
    /// process is the bash only while it is the main itself or the main's
    /// child (under the reaper shim); that is checked after the pin, and the
    /// pin has not exited since, so the check refers to the pinned process.
    async fn pin_agent(&self, main: &ProcWatch) {
        let reported = self.dir.path().join("agent.pid");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let pid = loop {
            let read = std::fs::read_to_string(&reported).ok();
            if let Some(pid) = read.and_then(|raw| raw.trim().parse::<u32>().ok()) {
                break pid;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the agent script never reported its pid"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let agent =
            ProcWatch::open(pid).unwrap_or_else(|e| panic!("agent {pid} is not running: {e}"));
        let ours = pid == main.pid() || process::parent(pid) == Some(main.pid());
        assert!(
            ours && !agent.has_exited(),
            "process {pid} is not the agent this test started"
        );
        *self.agent.lock().unwrap() = Some(agent);
    }

    /// The copy the INT trap made of `AgentOpts::on_int_copy`.
    pub fn at_signal(&self) -> PathBuf {
        self.dir.path().join("at-signal.json")
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Pids {
    pub main: u32,
    pub setsid: u32,
    pub pgrp: u32,
    pub nohup: u32,
    pub daemon: u32,
    pub locker: u32,
    pub updater: u32,
    pub installer: u32,
    pub legacy: u32,
    pub untagged: u32,
    pub envless: u32,
    /// The envless job's own-session intermediate (gone once the job runs).
    pub envless_intermediate: u32,
}

pub fn agent_script(opts: &AgentOpts) -> AgentScript {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("agent.sh");
    let pids = dir.path().join("pids");
    let marker = dir.path().join("marker");
    let copy = opts
        .on_int_copy
        .as_ref()
        .map(|p| {
            format!(
                "cp \"{}\" \"{}/at-signal.json\" 2>/dev/null; ",
                p.display(),
                dir.path().display()
            )
        })
        .unwrap_or_default();
    let body = format!(
        r#"#!/bin/bash
trap '{copy}echo INT >> "{marker}"; [ "{ei}" = 1 ] && exit 0' INT
trap 'echo TERM >> "{marker}"; [ "{et}" = 1 ] && exit 0' TERM
echo $$ > "{dir}/agent.pid.tmp" && mv "{dir}/agent.pid.tmp" "{dir}/agent.pid"
perl -e 'use POSIX; POSIX::setsid(); exec "sleep", "600"' & S=$!
perl -e 'setpgrp(0,0); sleep 600' & P=$!
nohup sh -c 'sleep 600 & echo $! > "{dir}/nohup.pid"' >/dev/null 2>&1 &
D=0; [ "{daemon}" = 1 ] && {{ perl -e 'sleep 600' app-server --managed-daemon & D=$!; }}
L=0; [ -n "{lock}" ] && {{ perl -e 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; sleep 600' "{lock}" & L=$!; }}
U=0; I=0; G=0
if [ "{family}" = 1 ]; then
  perl -e 'my $c = fork(); if ($c == 0) {{ exec "sleep", "600"; }} open(my $f, ">", "$ARGV[0].tmp") or die; print $f $c; close $f; rename("$ARGV[0].tmp", $ARGV[0]); sleep 600' "{dir}/installer.pid" app-server daemon pid-update-loop & U=$!
  perl -e 'sleep 600' app-server --listen unix:// & G=$!
  while [ ! -s "{dir}/installer.pid" ]; do sleep 0.05; done
  I=$(cat "{dir}/installer.pid")
fi
N=0; [ "{untagged}" = 1 ] && {{ env -u FRESHELL_UNIT_ID perl -e '$SIG{{INT}} = "IGNORE"; sleep 600' & N=$!; }}
E=0; EI=0
if [ "{envless}" = 1 ]; then
  setsid sh -c 'echo $$ > "$0/envless-intermediate.pid"; p=$$; sh -c "while kill -0 $p 2>/dev/null; do sleep 0.05; done; exec env -i /bin/sleep 600" & echo $! > "$0/envless.pid.tmp"; mv "$0/envless.pid.tmp" "$0/envless.pid"; exit 0' "{dir}"
  while [ ! -s "{dir}/envless.pid" ]; do sleep 0.05; done
  E=$(cat "{dir}/envless.pid"); EI=$(cat "{dir}/envless-intermediate.pid")
fi
while [ ! -s "{dir}/nohup.pid" ]; do sleep 0.05; done
echo "$$ $S $P $(cat "{dir}/nohup.pid") $D $L $U $I $G $N $E $EI" > "{pids}.tmp" && mv "{pids}.tmp" "{pids}"
while true; do sleep 1 & wait $!; done
"#,
        copy = copy,
        marker = marker.display(),
        ei = u8::from(opts.exit_on_int),
        et = u8::from(opts.exit_on_term),
        dir = dir.path().display(),
        daemon = u8::from(opts.managed_daemon_child),
        lock = opts
            .lock_child
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        family = u8::from(opts.daemon_family),
        untagged = u8::from(opts.untagged_child),
        envless = u8::from(opts.envless_job),
        pids = pids.display(),
    );
    std::fs::write(&script, body).unwrap();
    AgentScript {
        dir,
        script,
        pids,
        marker,
        main: Default::default(),
        agent: Default::default(),
        pins: Default::default(),
    }
}

pub async fn spawn_main(unit: &AgentUnit, s: &AgentScript) -> tokio::process::Child {
    let mut cmd = unit
        .tokio_command("bash", &[s.script.display().to_string()], MemberRole::Agent)
        .unwrap();
    cmd.kill_on_drop(false).stdin(std::process::Stdio::null());
    let child = cmd.spawn().unwrap();
    // The test's own unreaped child: its pid names it until it is reaped.
    let main = ProcWatch::open(child.id().unwrap()).unwrap();
    *s.main.lock().unwrap() = Some(main.clone());
    unit.set_main(main.clone());
    s.pin_agent(&main).await;
    child
}

pub async fn read_pids(s: &AgentScript) -> Pids {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&s.pids) {
            let v: Vec<u32> = raw.split_whitespace().map(|x| x.parse().unwrap()).collect();
            // Index 0 is the agent (pinned by `spawn_main`); index 11, the
            // envless job's intermediate, has exited by design, so its pid
            // may name another process by now.
            for (_, pid) in v
                .iter()
                .copied()
                .enumerate()
                .filter(|(i, pid)| *pid != 0 && *i != 0 && *i != 11)
            {
                s.pin(pid);
            }
            return Pids {
                main: v[0],
                setsid: v[1],
                pgrp: v[2],
                nohup: v[3],
                daemon: v[4],
                locker: v[5],
                updater: v[6],
                installer: v[7],
                legacy: v[8],
                untagged: v[9],
                envless: v[10],
                envless_intermediate: v[11],
            };
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "agent script never wrote its pids"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A plain child of the test (no unit placement), pinned while it is the
/// test's own unreaped child, killed through that pin and reaped when
/// dropped, so a failed assertion leaves nothing running.
pub struct OwnChild {
    child: std::process::Child,
    watch: ProcWatch,
}

impl OwnChild {
    pub fn spawn(cmd: &mut std::process::Command) -> Self {
        let mut child = cmd.spawn().unwrap();
        match ProcWatch::open(child.id()) {
            Ok(watch) => Self { child, watch },
            Err(err) => {
                // Unreaped, so its pid still names it.
                let _ = child.kill();
                let _ = child.wait();
                panic!("cannot pin the test's own child: {err}");
            }
        }
    }

    /// `sleep 600`.
    pub fn sleep() -> Self {
        Self::spawn(std::process::Command::new("sleep").arg("600"))
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn watch(&self) -> &ProcWatch {
        &self.watch
    }

    pub fn wait(&mut self) -> std::process::ExitStatus {
        self.child.wait().unwrap()
    }

    /// Kills it through its pin and reaps it.
    pub fn kill_and_wait(&mut self) -> std::process::ExitStatus {
        self.watch.signal(Sig::Kill).unwrap();
        self.wait()
    }
}

impl Drop for OwnChild {
    fn drop(&mut self) {
        let _ = self.watch.signal(Sig::Kill);
        let _ = self.child.wait();
    }
}

pub fn alive(pid: u32) -> bool {
    pid != 0 && freshell_containment::process::is_running(pid)
}

/// Linux: whether `pid`'s environment is empty (it exec'd under `env -i`).
pub fn environ_is_empty(pid: u32) -> bool {
    std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|raw| raw.is_empty())
}

/// Bounded wait (test helper) for a condition the test cannot observe by event.
pub async fn eventually(limit: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + limit;
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The systemd backend's per-server namespace, computed here from the
/// documented rule (an independent oracle): the first 16 lowercase hex
/// digits of the SHA-256 of the canonicalized state root (an empty root
/// hashes the empty string).
pub fn systemd_namespace(state_root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let canonical = std::fs::canonicalize(state_root).unwrap_or_else(|_| state_root.to_path_buf());
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Linux: the cgroup v2 path (`0::` line of `/proc/<pid>/cgroup`).
pub fn cgroup_path_of(pid: u32) -> String {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .unwrap_or_else(|e| panic!("cannot read the cgroup of {pid}: {e}"));
    raw.lines()
        .find_map(|l| l.strip_prefix("0::"))
        .unwrap_or_else(|| panic!("no cgroup v2 line for {pid}: {raw}"))
        .to_string()
}

/// The systemd unit slice holding `pid` (`freshell-n<ns>-<unit id>.slice`)
/// and its cgroup directory, or `None` when `pid` is not in one (the tag
/// backend) or is gone.
pub fn unit_slice_of(pid: u32) -> Option<(String, PathBuf)> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    let path = raw.lines().find_map(|l| l.strip_prefix("0::"))?;
    let mut dir = PathBuf::from("/sys/fs/cgroup");
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    for part in parts.by_ref() {
        dir.push(part);
        if part == "freshell.slice" {
            break;
        }
    }
    let ns_slice = parts.next()?;
    dir.push(ns_slice);
    let unit_slice = parts.next()?;
    let ns = ns_slice.strip_suffix(".slice")?;
    if !ns.starts_with("freshell-n") || !unit_slice.starts_with(&format!("{ns}-u")) {
        return None;
    }
    dir.push(unit_slice);
    Some((unit_slice.to_string(), dir))
}

/// `systemctl --user stop <unit>`, ignoring every failure (cleanup of the
/// test's own slices only; "not loaded" is fine).
pub fn stop_user_unit(unit: &str) {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "stop", unit])
        .stdin(std::process::Stdio::null())
        .output();
}

/// Stops one of the test's own systemd slices when dropped (a slice the
/// product leaves running on purpose, or one a failed test left behind).
pub struct StopSliceOnDrop(Option<String>);

impl StopSliceOnDrop {
    /// The unit slice holding `pid` now (nothing on the tag backend).
    pub fn holding(pid: u32) -> Self {
        Self(unit_slice_of(pid).map(|(name, _)| name))
    }

    pub fn named(name: impl Into<String>) -> Self {
        Self(Some(name.into()))
    }
}

impl Drop for StopSliceOnDrop {
    fn drop(&mut self) {
        if let Some(name) = &self.0 {
            stop_user_unit(name);
        }
    }
}

/// A temporary state root. Implicit systemd slices are never collected, so
/// on drop it stops the namespace slices (`freshell-n<ns>.slice`) of the
/// root itself and of its `selected` backend root, with every unit slice
/// the test left in them (all of them the test's own).
pub struct StateRoot(tempfile::TempDir);

impl StateRoot {
    pub fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }

    pub fn path(&self) -> &Path {
        self.0.path()
    }
}

impl Drop for StateRoot {
    fn drop(&mut self) {
        for root in [self.0.path().join("selected"), self.0.path().to_path_buf()] {
            if root.is_dir() {
                stop_user_unit(&format!("freshell-n{}.slice", systemd_namespace(&root)));
            }
        }
    }
}

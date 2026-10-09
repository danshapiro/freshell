#![allow(dead_code)]
pub mod capture;

use std::path::{Path, PathBuf};
use std::time::Duration;

use freshell_containment::{
    AgentUnit, BackendKind, Containment, MemberRole, ProcWatch, SelectOptions, ShimCommand,
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
    /// Every process this script's run started, pinned while it was alive:
    /// a test that fails before its stop leaves nothing running.
    pins: std::sync::Mutex<Vec<ProcWatch>>,
}

impl Drop for AgentScript {
    fn drop(&mut self) {
        for watch in self.pins.lock().unwrap().iter() {
            let _ = watch.signal(freshell_containment::Sig::Kill);
        }
    }
}

impl AgentScript {
    fn pin(&self, pid: u32) {
        if let Ok(watch) = ProcWatch::open(pid) {
            self.pins.lock().unwrap().push(watch);
        }
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
        pins: Default::default(),
    }
}

pub async fn spawn_main(unit: &AgentUnit, s: &AgentScript) -> tokio::process::Child {
    let mut cmd = unit
        .tokio_command("bash", &[s.script.display().to_string()], MemberRole::Agent)
        .unwrap();
    cmd.kill_on_drop(false).stdin(std::process::Stdio::null());
    let child = cmd.spawn().unwrap();
    let main = ProcWatch::open(child.id().unwrap()).unwrap();
    s.pins.lock().unwrap().push(main.clone());
    unit.set_main(main);
    child
}

pub async fn read_pids(s: &AgentScript) -> Pids {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&s.pids) {
            let v: Vec<u32> = raw.split_whitespace().map(|x| x.parse().unwrap()).collect();
            for pid in v.iter().copied().filter(|p| *p != 0) {
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

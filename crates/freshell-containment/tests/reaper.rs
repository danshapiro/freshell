#![cfg(target_os = "linux")]
//! The `__unit-exec --reaper` shim (the Linux fallback's member root), run
//! under a real PTY set up as Freshell's screens are (`setsid` +
//! `TIOCSCTTY`, by portable-pty). Every process signalled here was started by
//! the test, through a start-time-pinned `ProcWatch`.
mod support;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use freshell_containment::{process, ProcWatch, Sig};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use support::{alive, environ_is_empty, test_shim};

#[derive(Default)]
struct ScriptOpts {
    envless_job: bool,
    daemon_stand_in: bool,
    exit_at_once: bool,
}

/// What the agent script recorded about itself and what it started.
#[derive(Debug)]
struct Info {
    agent: u32,
    pgid: u32,
    tpgid: u32,
    sid: u32,
    nohup: u32,
    envless: u32,
    envless_intermediate: u32,
    daemon: u32,
}

struct Pane {
    dir: tempfile::TempDir,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Box<dyn Child + Send + Sync>,
    shim: ProcWatch,
    /// What the agent reported starting, pinned while alive: a failing test
    /// leaves nothing running.
    pins: std::cell::RefCell<Vec<ProcWatch>>,
}

impl Drop for Pane {
    fn drop(&mut self) {
        for watch in self.pins.borrow().iter().chain([&self.shim]) {
            let _ = watch.signal(Sig::Kill);
        }
    }
}

fn script(dir: &Path, opts: &ScriptOpts) -> PathBuf {
    let path = dir.join("agent.sh");
    let body = format!(
        r#"#!/bin/bash
dir="$1"
trap 'echo INT >> "$dir/marker"; [ "$(wc -l < "$dir/marker")" -ge 2 ] && exit 0' INT
E=0; EI=0
if [ "{envless}" = 1 ]; then
  setsid sh -c 'echo $$ > "$0/ei.pid"; p=$$; sh -c "while kill -0 $p 2>/dev/null; do sleep 0.05; done; exec env -i /bin/sleep 600" & echo $! > "$0/e.pid.tmp"; mv "$0/e.pid.tmp" "$0/e.pid"; exit 0' "$dir"
  while [ ! -s "$dir/e.pid" ]; do sleep 0.05; done
  E=$(cat "$dir/e.pid"); EI=$(cat "$dir/ei.pid")
fi
nohup sleep 600 >/dev/null 2>&1 & NH=$!
D=0
if [ "{daemon}" = 1 ]; then
  setsid perl -e 'sleep 600' app-server --managed-daemon & D=$!
  # Report it only once it runs as the daemon (exec'd, with its own argv).
  until tr '\0' ' ' < /proc/$D/cmdline 2>/dev/null | grep -q -- --managed-daemon; do sleep 0.02; done
fi
echo "$$ $(ps -o pgid=,tpgid=,sid= -p $$) $NH $E $EI $D" > "$dir/info.tmp" && mv "$dir/info.tmp" "$dir/info"
[ "{exit}" = 1 ] && exit 0
while true; do sleep 1 & wait $!; done
"#,
        envless = u8::from(opts.envless_job),
        daemon = u8::from(opts.daemon_stand_in),
        exit = u8::from(opts.exit_at_once),
    );
    std::fs::write(&path, body).unwrap();
    path
}

/// Starts `<shim> --reaper -- bash <script> <dir>` on a fresh PTY.
fn start(opts: ScriptOpts) -> Pane {
    let dir = tempfile::tempdir().unwrap();
    let script = script(dir.path(), &opts);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = CommandBuilder::new(test_shim().exe);
    cmd.args(["--reaper", "--", "bash"]);
    cmd.arg(&script);
    cmd.arg(dir.path());
    let child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    // The shim is our own unreaped child, so its pid names it until we wait.
    let shim = ProcWatch::open(child.process_id().unwrap()).unwrap();
    Pane {
        dir,
        master: Some(pair.master),
        writer: None,
        child,
        shim,
        pins: Default::default(),
    }
}

impl Pane {
    fn info(&self) -> Info {
        let path = self.dir.path().join("info");
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let v: Vec<u32> = raw.split_whitespace().map(|x| x.parse().unwrap()).collect();
                for pid in [v[0], v[4], v[5], v[7]].into_iter().filter(|p| *p != 0) {
                    if let Ok(watch) = ProcWatch::open(pid) {
                        self.pins.borrow_mut().push(watch);
                    }
                }
                return Info {
                    agent: v[0],
                    pgid: v[1],
                    tpgid: v[2],
                    sid: v[3],
                    nohup: v[4],
                    envless: v[5],
                    envless_intermediate: v[6],
                    daemon: v[7],
                };
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the agent never wrote its info"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn marker_lines(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("marker"))
            .map(|m| m.lines().count())
            .unwrap_or(0)
    }

    fn type_ctrl_c(&mut self) {
        // The writer is kept for the pane's lifetime: dropping it types EOF.
        let master = self.master.as_ref().unwrap();
        let writer = self
            .writer
            .get_or_insert_with(|| master.take_writer().unwrap());
        writer.write_all(b"\x03").unwrap();
        writer.flush().unwrap();
    }

    fn wait_exit(&mut self) -> portable_pty::ExitStatus {
        self.child.wait().unwrap()
    }
}

fn eventually(limit: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + limit;
    while !cond() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Pins a process the test's script started (read while it is certainly
/// alive), so a later signal can never reach a recycled pid.
fn pin(pid: u32) -> ProcWatch {
    ProcWatch::open(pid).unwrap_or_else(|e| panic!("process {pid} is not running: {e}"))
}

#[test]
fn ctrl_c_typed_into_the_pane_reaches_only_the_agent() {
    let mut pane = start(ScriptOpts::default());
    let info = pane.info();
    let agent = pin(info.agent);
    let nohup = pin(info.nohup);
    assert_eq!(
        info.pgid, info.agent,
        "the agent leads its own process group"
    );
    assert_eq!(
        info.tpgid, info.pgid,
        "the agent's group is the terminal's foreground group"
    );
    assert_eq!(
        info.sid,
        pane.shim.pid(),
        "the agent stays in the shim's session"
    );

    pane.type_ctrl_c();
    eventually(Duration::from_secs(5), "the agent saw the Ctrl+C", || {
        pane.marker_lines() >= 1
    });
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(pane.marker_lines(), 1, "exactly one INT reached the agent");
    assert!(!pane.shim.has_exited(), "the Ctrl+C did not reach the shim");

    // Finish the agent the way a stop does: SIGINT to the shim is forwarded.
    pane.shim.signal(Sig::Interrupt).unwrap();
    let status = pane.wait_exit();
    assert!(status.success(), "{status}");
    assert!(agent.has_exited());
    // The shim SIGKILLs what the agent left and exits without waiting for it.
    eventually(
        Duration::from_secs(5),
        "the shim killed what the agent left",
        || nohup.has_exited(),
    );
}

#[test]
fn the_shim_keeps_a_detached_job_that_cleared_its_environment_and_kills_it_when_the_agent_ends() {
    let mut pane = start(ScriptOpts {
        envless_job: true,
        ..Default::default()
    });
    let info = pane.info();
    eventually(
        Duration::from_secs(10),
        "the detached job cleared its environment and was adopted",
        || environ_is_empty(info.envless) && process::parent(info.envless) == Some(pane.shim.pid()),
    );
    assert_ne!(
        process::parent(info.envless),
        Some(info.envless_intermediate)
    );
    let job = pin(info.envless);
    let nohup = pin(info.nohup);

    pane.type_ctrl_c();
    eventually(Duration::from_secs(5), "the first INT", || {
        pane.marker_lines() >= 1
    });
    // The stop's soft signal to a screen main: the agent's second INT ends it.
    pane.shim.signal(Sig::Interrupt).unwrap();
    let status = pane.wait_exit();
    assert!(
        status.success(),
        "the shim exits with the agent's code 0: {status}"
    );
    eventually(
        Duration::from_secs(5),
        "the detached and nohup jobs are gone",
        || job.has_exited() && nohup.has_exited(),
    );
}

#[test]
fn a_pty_hangup_ends_the_agent_and_the_shim_reports_its_signal() {
    let mut pane = start(ScriptOpts {
        envless_job: true,
        ..Default::default()
    });
    let info = pane.info();
    eventually(
        Duration::from_secs(10),
        "the detached job was adopted",
        || environ_is_empty(info.envless) && process::parent(info.envless) == Some(pane.shim.pid()),
    );
    let agent = pin(info.agent);
    let job = pin(info.envless);

    drop(pane.master.take());
    let status = pane.wait_exit();
    assert!(
        status.to_string().contains("Hangup"),
        "the shim died by the agent's SIGHUP: {status}"
    );
    assert!(agent.has_exited());
    eventually(Duration::from_secs(5), "the detached job is gone", || {
        job.has_exited()
    });
}

#[test]
fn the_shim_spares_the_codex_daemon_family() {
    let mut pane = start(ScriptOpts {
        daemon_stand_in: true,
        exit_at_once: true,
        ..Default::default()
    });
    let info = pane.info();
    let daemon = pin(info.daemon);
    let start = daemon.identity().start;
    let status = pane.wait_exit();
    assert!(status.success(), "{status}");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !daemon.has_exited(),
        "the shim killed the managed daemon stand-in"
    );
    assert_eq!(process::start_time(info.daemon).unwrap(), start);
    // The agent exits at once, so what it left may be gone before it can be
    // pinned: its pid is checked instead.
    eventually(
        Duration::from_secs(5),
        "everything else the agent left is killed",
        || !alive(info.nohup),
    );
    daemon.signal(Sig::Kill).unwrap();
}

#[test]
fn the_shim_starts_the_agent_with_the_open_file_soft_limit_its_spawner_passes() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("soft");
    let status = std::process::Command::new(test_shim().exe)
        .args(["--nofile-soft=256", "--reaper", "--", "sh", "-c"])
        .arg(format!("ulimit -Sn > '{}'", out.display()))
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "256");
}

#[test]
fn a_command_ended_by_a_core_dumping_signal_ends_the_shim_with_that_signal_without_a_core_dump() {
    use std::os::unix::process::ExitStatusExt;
    // The command makes itself non-dumpable before it aborts, so this test
    // never produces a core dump of its own.
    let status = std::process::Command::new(test_shim().exe)
        .args(["--reaper", "--", "perl", "-e"])
        .arg(r#"require "syscall.ph"; syscall(&SYS_prctl, 4, 0, 0, 0, 0) == 0 or die "prctl: $!"; kill "ABRT", $$; sleep 5"#)
        .status()
        .unwrap();
    assert_eq!(
        status.signal(),
        Some(libc::SIGABRT),
        "the shim ends with the command's signal: {status:?}"
    );
    assert!(
        !status.core_dumped(),
        "the shim dumped core in the command's place: {status:?}"
    );
}

#[test]
fn a_malformed_open_file_limit_is_noted_on_stderr_and_the_command_still_runs() {
    let out = std::process::Command::new(test_shim().exe)
        .args(["--nofile-soft=lots", "--reaper", "--", "true"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(stderr.lines().count(), 1, "one line: {stderr:?}");
    assert!(
        stderr.contains("--nofile-soft") && stderr.contains("lots"),
        "{stderr:?}"
    );
}

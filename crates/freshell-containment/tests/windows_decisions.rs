#![cfg(windows)]
//! Windows design-decision tests, run on the `windows-2022` runner BEFORE
//! the Job Object backend exists (Stage 2: LB-08, LB-09, LB-10, LB-11;
//! `load-bearing-validator-V5.md` §3.2, §4, §5, §6). Their outcome picks the
//! unit job's limit flags (Task 6 Step 4):
//!
//! - whether a NON-detached Node grandchild (libuv puts every non-detached
//!   child into a per-`node.exe` job with `SILENT_BREAKAWAY_OK`) stays in a
//!   unit job that has `BREAKAWAY_OK`, and in one that has only
//!   `KILL_ON_JOB_CLOSE`;
//! - whether Codex's managed daemon, launched from a Node-started process
//!   with `DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`, leaves such a unit;
//! - whether a `LockFileEx` lock (Codex's thread-writer lock) is free by the
//!   time its holder's process handle is signalled;
//! - whether the `__unit-exec` shim survives a Ctrl-C written to its
//!   pseudoconsole while the command it runs gets it.
//!
//! Every test creates its own named job with the flag set under test (the
//! test holds the only lasting handle), starts its first process through
//! the `freshell-unit-exec` shim with `--job <that name>`, and first asserts
//! (precondition) that this process is in the job. It finds descendants by
//! parent pid, opens a handle to every process it waits on before acting,
//! synchronises only on lines its children print, and terminates by handle
//! everything it opened that is still running when it ends (a process that
//! escapes the unit job also escapes cargo's own job on the runner).

mod windows_support;

use std::ffi::c_void;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows_support::{child_named, js, wide, Lines, Proc, EXIT_WAIT, HELPER, LINE_WAIT, SHIM};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const KILL_ON_CLOSE: u32 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
const KILL_ON_CLOSE_BREAKAWAY_OK: u32 =
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;

/// A named job the test creates and holds; closing it (drop) ends every
/// member still in it (each job here has `KILL_ON_JOB_CLOSE`).
struct Job {
    handle: HANDLE,
    name: String,
}

impl Job {
    fn new(flags: u32) -> Self {
        let name = format!("Local\\freshell-decision-{}", uuid::Uuid::new_v4().simple());
        let name_w = wide(&name);
        // SAFETY: default security, a NUL-terminated name.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), name_w.as_ptr()) };
        assert!(
            !handle.is_null(),
            "CreateJobObjectW: {}",
            std::io::Error::last_os_error()
        );
        let job = Self { handle, name };
        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is valid.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = flags;
        // SAFETY: a live job handle and a correctly sized information block.
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        assert!(
            ok != 0,
            "SetInformationJobObject: {}",
            std::io::Error::last_os_error()
        );
        job
    }

    fn contains(&self, proc: &Proc) -> bool {
        let mut result: BOOL = 0;
        // SAFETY: two live handles and a valid out-pointer.
        let ok = unsafe { IsProcessInJob(proc.handle, self.handle, &mut result) };
        assert!(
            ok != 0,
            "IsProcessInJob: {}",
            std::io::Error::last_os_error()
        );
        result != 0
    }

    fn terminate(&self) {
        // SAFETY: a live job handle.
        let ok = unsafe { TerminateJobObject(self.handle, 1) };
        assert!(
            ok != 0,
            "TerminateJobObject: {}",
            std::io::Error::last_os_error()
        );
    }

    /// The pids in the job now.
    fn pids(&self) -> Vec<u32> {
        let mut buf = vec![0usize; 2 + 4096];
        // SAFETY: a live job handle and a buffer of the stated size.
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<usize>()) as u32,
                std::ptr::null_mut(),
            )
        };
        assert!(
            ok != 0,
            "QueryInformationJobObject: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: the call filled a JOBOBJECT_BASIC_PROCESS_ID_LIST.
        let list = unsafe { &*buf.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
        // SAFETY: the list holds `NumberOfProcessIdsInList` entries.
        let ids = unsafe {
            std::slice::from_raw_parts(
                list.ProcessIdList.as_ptr(),
                list.NumberOfProcessIdsInList as usize,
            )
        };
        ids.iter().map(|p| *p as u32).collect()
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and closed once.
        unsafe { CloseHandle(self.handle) };
    }
}

/// A process the test started through the shim, with its stdout read as
/// lines. Dropping it terminates the shim (and the job's kill-on-close
/// takes the rest when the job is dropped).
struct Started {
    child: Child,
    shim: Proc,
    stdin: Option<ChildStdin>,
    lines: Lines,
}

impl Started {
    fn through_shim(job: &Job, command: &[&str]) -> Self {
        let mut child = Command::new(SHIM)
            .args(["--job", &job.name, "--"])
            .args(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the shim");
        // Our unreaped child: its handle keeps the pid from being reused.
        let shim = Proc::open(child.id());
        let lines = Lines::new(child.stdout.take().unwrap());
        Self {
            stdin: child.stdin.take(),
            child,
            shim,
            lines,
        }
    }

    /// The precondition of every test: the process started through the shim
    /// placed itself in the unit's job. Checked after the first line, which
    /// the command prints only once the shim has started it.
    fn assert_placed(&self, job: &Job) {
        assert!(
            job.contains(&self.shim),
            "precondition: the process started through the shim ({}) is not in job {}",
            self.shim.pid,
            job.name
        );
    }
}

impl Drop for Started {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Node code that starts `cmd.exe /d /c ping -n 600 127.0.0.1` as a
/// non-detached child with inherited stdio (cmd models the native
/// `codex.exe`, ping a shell command it runs) and prints `ready <cmd pid>`.
fn cmd_ping_js() -> String {
    "const c=require('child_process').spawn('cmd.exe',['/d','/c','ping','-n','600','127.0.0.1'],{stdio:'inherit'});console.log('ready '+c.pid);setInterval(()=>{},1e9);".to_string()
}

/// Node code that starts `node -e <code>` as a non-detached child with
/// inherited stdio and stays alive.
fn node_wrapping_js(code: &str) -> String {
    format!(
        "require('child_process').spawn(process.execPath,['-e',{}],{{stdio:'inherit'}});setInterval(()=>{{}},1e9);",
        js(code)
    )
}

/// One case of the Node-grandchild membership question: through the shim,
/// node (and, when `nested`, a second node under it) starts cmd, which
/// starts ping. Returns whether cmd and ping are in the job, after checking
/// that `TerminateJobObject` ends whichever of them are.
fn node_grandchild_membership(flags: u32, nested: bool) -> (bool, bool) {
    let job = Job::new(flags);
    let code = if nested {
        node_wrapping_js(&cmd_ping_js())
    } else {
        cmd_ping_js()
    };
    let mut started = Started::through_shim(&job, &["node", "-e", &code]);
    let cmd_pid = started.lines.expect_pid("ready ");
    started.assert_placed(&job);
    let cmd = Proc::open(cmd_pid);
    // ping's own output proves it runs (replies carry the address).
    started
        .lines
        .expect("ping output", |l| l.contains("127.0.0.1"));
    let ping = Proc::open(child_named(cmd_pid, "ping.exe").expect("ping.exe under cmd.exe"));
    let membership = (job.contains(&cmd), job.contains(&ping));
    job.terminate();
    if membership.0 {
        assert!(cmd.wait(EXIT_WAIT), "cmd.exe outlived TerminateJobObject");
    }
    if membership.1 {
        assert!(ping.wait(EXIT_WAIT), "ping.exe outlived TerminateJobObject");
    }
    membership
}

/// LB-09 (V5 §4), job = `KILL_ON_JOB_CLOSE` only: a non-detached Node
/// grandchild stays in the unit job, one and two Node levels deep, and
/// `TerminateJobObject` ends it.
#[test]
fn node_grandchild_stays_in_unit_job() {
    for nested in [false, true] {
        let (cmd_in, ping_in) = node_grandchild_membership(KILL_ON_CLOSE, nested);
        assert!(
            cmd_in && ping_in,
            "nested={nested}: cmd.exe in the unit job: {cmd_in}, ping.exe: {ping_in}"
        );
    }
}

/// LB-09's open question (V5 §4, F3-F4), job = `KILL_ON_JOB_CLOSE |
/// BREAKAWAY_OK`: does a child silently breaking away from libuv's
/// `SILENT_BREAKAWAY_OK` job also leave a parent job that has only
/// `BREAKAWAY_OK`?
#[test]
fn node_grandchild_stays_in_unit_job_with_breakaway_ok() {
    for nested in [false, true] {
        let (cmd_in, ping_in) = node_grandchild_membership(KILL_ON_CLOSE_BREAKAWAY_OK, nested);
        assert!(
            cmd_in && ping_in,
            "nested={nested}: cmd.exe in the unit job: {cmd_in}, ping.exe: {ping_in}"
        );
    }
}

/// What a `breakaway-daemon` start printed.
enum DaemonStart {
    Daemon(Proc),
    SpawnError(i64),
}

/// Starts `freshell-test-helper breakaway-daemon` through the shim, either
/// directly or behind a non-detached node (as Codex's launcher runs
/// `codex.exe`), and returns the job, the started tree and what it printed.
fn start_breakaway_daemon(flags: u32, via_node: bool) -> (Job, Started, DaemonStart) {
    let job = Job::new(flags);
    let code = format!(
        "require('child_process').spawn({},['breakaway-daemon'],{{stdio:'inherit'}});setInterval(()=>{{}},1e9);",
        js(HELPER)
    );
    let mut started = if via_node {
        Started::through_shim(&job, &["node", "-e", &code])
    } else {
        Started::through_shim(&job, &[HELPER, "breakaway-daemon"])
    };
    let line = started.lines.expect("daemon or spawn-error", |l| {
        l.starts_with("daemon ") || l.starts_with("spawn-error ")
    });
    started.assert_placed(&job);
    let outcome = if let Some(pid) = line.strip_prefix("daemon ") {
        DaemonStart::Daemon(Proc::open(pid.trim().parse().unwrap()))
    } else {
        DaemonStart::SpawnError(line["spawn-error ".len()..].trim().parse().unwrap())
    };
    (job, started, outcome)
}

/// Ends every process in `job` with `TerminateJobObject` and waits for each
/// (handles opened before the termination).
fn terminate_and_wait(job: &Job) {
    let members: Vec<Proc> = job.pids().into_iter().map(Proc::open).collect();
    job.terminate();
    for member in &members {
        assert!(
            member.wait(EXIT_WAIT),
            "job member {} outlived TerminateJobObject",
            member.pid
        );
    }
}

/// LB-10 (V5 §5), job = `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`: Codex's managed
/// daemon launch (explicit breakaway) leaves the unit, whether its launcher
/// runs behind node or directly, and survives both `TerminateJobObject` and
/// the job's last handle closing.
#[test]
fn a_node_launched_breakaway_daemon_leaves_a_breakaway_ok_unit() {
    for via_node in [true, false] {
        let (job, started, outcome) = start_breakaway_daemon(KILL_ON_CLOSE_BREAKAWAY_OK, via_node);
        let daemon = match outcome {
            DaemonStart::Daemon(daemon) => daemon,
            DaemonStart::SpawnError(code) => {
                panic!("via_node={via_node}: the breakaway spawn failed with {code}")
            }
        };
        assert!(
            !job.contains(&daemon),
            "via_node={via_node}: the breakaway daemon {} is in the unit job",
            daemon.pid
        );
        terminate_and_wait(&job);
        assert!(
            daemon.running(),
            "via_node={via_node}: the daemon died with TerminateJobObject"
        );
        drop(started);
        drop(job);
        assert!(
            !daemon.wait(Duration::from_secs(1)),
            "via_node={via_node}: the daemon died when the job's last handle closed"
        );
        // `daemon` is terminated through its handle on drop.
    }
}

/// V5 §5 NEW ASSUMPTIONS, job = `KILL_ON_JOB_CLOSE` only: started directly
/// in the unit job, the breakaway spawn is refused (`ERROR_ACCESS_DENIED`);
/// behind node it succeeds (it breaks away from libuv's job only) and the
/// daemon stays in the unit job. Branch B relies on this.
#[test]
fn a_node_launched_breakaway_daemon_stays_in_a_kill_on_close_only_unit() {
    let (_job, _started, outcome) = start_breakaway_daemon(KILL_ON_CLOSE, false);
    match outcome {
        DaemonStart::SpawnError(code) => assert_eq!(code, 5, "the direct spawn's error"),
        DaemonStart::Daemon(daemon) => panic!(
            "the direct breakaway spawn succeeded (daemon {}) in a job without BREAKAWAY_OK",
            daemon.pid
        ),
    }
    let (job, _started, outcome) = start_breakaway_daemon(KILL_ON_CLOSE, true);
    let daemon = match outcome {
        DaemonStart::Daemon(daemon) => daemon,
        DaemonStart::SpawnError(code) => panic!("the spawn behind node failed with {code}"),
    };
    assert!(
        job.contains(&daemon),
        "the daemon {} launched behind node left a KILL_ON_JOB_CLOSE-only unit job",
        daemon.pid
    );
    job.terminate();
    assert!(
        daemon.wait(EXIT_WAIT),
        "the daemon outlived TerminateJobObject"
    );
}

/// Our own non-blocking attempt at the lock, as Codex takes it.
fn try_lock(path: &Path) -> Result<std::fs::File, std::fs::TryLockError> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(std::fs::TryLockError::Error)?;
    file.try_lock()?;
    Ok(file)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockEnding {
    /// `TerminateJobObject` on the unit job.
    TerminateJob,
    /// The holder's normal exit (its stdin closed).
    NormalExit,
    /// `TerminateProcess` of the holder alone.
    TerminateHolder,
    /// `TerminateProcess` of a holder that has a live child.
    TerminateHolderWithLiveChild,
}

/// LB-11 (V5 §6), job = `KILL_ON_JOB_CLOSE` only, 200 repetitions: a holder
/// behind a non-detached node (as `codex.js` runs `codex.exe`) takes the
/// lock; once its process handle is signalled, the lock is free at once for
/// this process and for a freshly started holder.
fn lock_release_repetitions(ending: LockEnding) {
    const REPETITIONS: usize = 200;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.lock");
    let path_str = path.to_str().unwrap();
    for rep in 0..REPETITIONS {
        let job = Job::new(KILL_ON_CLOSE);
        let mut holder_args = vec!["hold-lock".to_string(), path_str.to_string()];
        if ending == LockEnding::TerminateHolderWithLiveChild {
            holder_args.push("--child".into());
        }
        let code = format!(
            "const c=require('child_process').spawn({},{},{{stdio:'inherit'}});c.on('exit',(code)=>process.exit(code===null?1:code));",
            js(HELPER),
            serde_json::to_string(&holder_args).unwrap()
        );
        let mut started = Started::through_shim(&job, &["node", "-e", &code]);
        let holder_pid = started.lines.expect_pid("locked ");
        started.assert_placed(&job);
        let holder = Proc::open(holder_pid);
        let live_child = (ending == LockEnding::TerminateHolderWithLiveChild).then(|| {
            Proc::open(
                child_named(holder_pid, "freshell-test-helper.exe")
                    .expect("the holder's idle child"),
            )
        });
        assert!(
            matches!(try_lock(&path), Err(std::fs::TryLockError::WouldBlock)),
            "{ending:?} rep {rep}: the holder's lock is not visible"
        );
        match ending {
            LockEnding::TerminateJob => job.terminate(),
            LockEnding::NormalExit => drop(started.stdin.take()),
            LockEnding::TerminateHolder | LockEnding::TerminateHolderWithLiveChild => {
                holder.terminate()
            }
        }
        assert!(
            holder.wait(EXIT_WAIT),
            "{ending:?} rep {rep}: the holder did not end"
        );
        // No delay from here on.
        match try_lock(&path) {
            Ok(own) => drop(own),
            Err(err) => panic!(
                "{ending:?} rep {rep}: the lock outlived its holder's signalled handle: {err:?}"
            ),
        }
        let mut fresh = Command::new(HELPER)
            .args(["hold-lock", path_str])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut fresh_lines = Lines::new(fresh.stdout.take().unwrap());
        let locked = fresh_lines.next_matching("locked", |l| l.starts_with("locked "));
        drop(fresh.stdin.take());
        let status = fresh.wait().unwrap();
        assert!(
            locked.is_some() && status.success(),
            "{ending:?} rep {rep}: a fresh holder could not take the lock ({status})"
        );
        if let Some(child) = &live_child {
            assert!(
                child.running(),
                "{ending:?} rep {rep}: the holder's child was not alive for the check"
            );
        }
        // `job` (kill-on-close) ends node and any live child; `started`
        // ends the shim.
    }
}

mod lockfileex_released_when_holder_handle_signals {
    use super::*;

    #[test]
    fn after_terminate_job_object() {
        lock_release_repetitions(LockEnding::TerminateJob);
    }

    #[test]
    fn after_the_holders_normal_exit() {
        lock_release_repetitions(LockEnding::NormalExit);
    }

    #[test]
    fn after_terminate_process_of_the_holder_alone() {
        lock_release_repetitions(LockEnding::TerminateHolder);
    }

    #[test]
    fn after_terminate_process_of_a_holder_with_a_live_child() {
        lock_release_repetitions(LockEnding::TerminateHolderWithLiveChild);
    }
}

/// The PTY's output, read on its own thread (a pseudoconsole whose output is
/// not drained stalls its processes).
struct PtyOutput {
    rx: mpsc::Receiver<Vec<u8>>,
    text: String,
}

impl PtyOutput {
    fn new(mut reader: Box<dyn Read + Send>) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Self {
            rx,
            text: String::new(),
        }
    }

    /// Waits until the output after byte offset `from` contains `needle`.
    fn wait_for(&mut self, from: usize, needle: &str) {
        let deadline = Instant::now() + LINE_WAIT;
        while !self.text.get(from..).is_some_and(|t| t.contains(needle)) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(bytes) => self.text.push_str(&String::from_utf8_lossy(&bytes)),
                Err(_) => panic!(
                    "no {needle:?} in the PTY output within {LINE_WAIT:?}: {:?}",
                    self.text
                ),
            }
        }
    }
}

/// LB-08 (V5 §3.2): a Ctrl-C written to the pseudoconsole reaches the
/// command the shim runs and never ends the shim. With the default console
/// control handler (`ExitProcess`) the shim would die, and Freshell would
/// see a screen exit while the agent runs on.
#[test]
fn the_shim_survives_ctrl_c_and_its_child_ends() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let job = Job::new(KILL_ON_CLOSE);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(SHIM);
    command.args(["--job", &job.name, "--", "cmd.exe", "/d", "/k"]);
    command.args(["ping", "-n", "600", "127.0.0.1"]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut output = PtyOutput::new(pair.master.try_clone_reader().unwrap());
    let mut writer = pair.master.take_writer().unwrap();
    let shim = Proc::open(child.process_id().unwrap());
    // A ping reply (it carries "TTL=") proves ping runs.
    output.wait_for(0, "TTL=");
    assert!(
        job.contains(&shim),
        "precondition: the process started through the shim ({}) is not in job {}",
        shim.pid,
        job.name
    );
    let cmd_pid = child_named(shim.pid, "cmd.exe").expect("cmd.exe under the shim");
    let cmd = Proc::open(cmd_pid);
    let ping = Proc::open(child_named(cmd_pid, "ping.exe").expect("ping.exe under cmd.exe"));
    writer.write_all(b"\x03").unwrap();
    writer.flush().unwrap();
    assert!(ping.wait(EXIT_WAIT), "ping.exe did not end on Ctrl-C");
    // cmd answers a new command, so the Ctrl-C was handled everywhere by
    // now; its result (24690) is not in the typed text.
    let mark = output.text.len();
    writer.write_all(b"set /a 12345*2\r").unwrap();
    writer.flush().unwrap();
    output.wait_for(mark, "24690");
    assert!(cmd.running(), "cmd.exe ended on Ctrl-C");
    assert!(shim.running(), "the shim ended on Ctrl-C");
    job.terminate();
    assert!(shim.wait(EXIT_WAIT) && cmd.wait(EXIT_WAIT));
    let _ = child.wait();
}

#![cfg(windows)]
//! The Windows Job Object backend. The design-decision run (GitHub Actions
//! run 38013473744, `windows_decisions.rs`) chose branch A: a unit job is
//! `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`, because a non-detached Node grandchild
//! stays in such a job while Codex's explicit-breakaway daemon leaves it.
//!
//! Every test uses `Containment::select` with the test shim and its own state
//! root, spawns only through the unit under test (or, for the outside-process
//! checks, through std directly), opens handles before acting, synchronises
//! on printed lines, and cleans up spared or outside processes by handle.
mod windows_support;

use std::ffi::c_void;
use std::process::Stdio;
use std::time::Duration;

use freshell_containment::{
    listening_socket_owner, lock_holders, testing, AgentUnit, BackendKind, Containment, MemberRole,
    ProcIdentity, ProcWatch, SelectOptions, Sig, StopMode, StopReason, StopReport, StopRequest,
    UnitId, UnitLabel, UnitRecord, UnitRecordState, POST_GONE_EMPTY_WAIT,
};
use windows_support::{
    captured, child_named, js, test_shim, wide, AsyncLines, Proc, EXIT_WAIT, HELPER, SHIM,
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO;
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED,
};

fn containment(state: &std::path::Path) -> Containment {
    Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.to_path_buf(),
    })
}

fn label() -> UnitLabel {
    UnitLabel {
        provider: "codex".into(),
        session_id: Some(format!("s-{}", UnitId::mint().as_str())),
        terminal_id: Some("t-windows-job".into()),
        mode: "codex".into(),
        create_request_id: None,
    }
}

/// A member started through a unit: the shim (its first process) and the
/// lines it and its descendants print.
struct Member {
    child: tokio::process::Child,
    shim: Proc,
    lines: AsyncLines,
}

fn start(unit: &AgentUnit, program: &str, args: &[&str]) -> Member {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut command = unit
        .tokio_command(program, &args, MemberRole::Agent)
        .expect("placement");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().expect("start a unit member");
    // Our unreaped child: its handle keeps the pid from being reused.
    let shim = Proc::open(child.id().expect("a running child"));
    let lines = AsyncLines::new(child.stdout.take().unwrap());
    Member { child, shim, lines }
}

/// A Force (Shift-X) stop: its Gone report and the post-Gone sweep's
/// survivors (the sweep ends after the unit released its job handle).
async fn force_stop(unit: &AgentUnit, reason: StopReason) -> (StopReport, Vec<ProcIdentity>) {
    let handle = unit.stop(StopRequest::new(StopMode::Force, reason, "test"));
    let report = handle
        .wait_for(Duration::from_secs(30))
        .await
        .expect("Gone within 30 s");
    let survivors = tokio::time::timeout(Duration::from_secs(30), handle.wait_swept())
        .await
        .expect("the post-Gone sweep finished");
    (report, survivors)
}

fn member_pids(unit: &AgentUnit) -> Vec<u32> {
    unit.members()
        .expect("members")
        .iter()
        .map(|m| m.pid)
        .collect()
}

/// LB-09: everything a non-detached node tree starts is a unit member, and a
/// Force stop ends all of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_unit_contains_a_non_detached_node_tree_and_stop_ends_all_of_it() {
    let state = tempfile::tempdir().unwrap();
    let containment = containment(state.path());
    let capability = containment.capability();
    assert_eq!(capability.kind, BackendKind::WindowsJob, "{capability:?}");
    assert!(capability.full, "{capability:?}");
    let unit = containment.create_unit(UnitId::mint(), label()).unwrap();
    let code = "const cp=require('child_process');\
        const c=cp.spawn('cmd.exe',['/d','/c','ping','-n','600','127.0.0.1'],{stdio:'inherit'});\
        const n=cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'inherit'});\
        console.log('ready '+c.pid+' '+n.pid);setInterval(()=>{},1e9);";
    let mut member = start(&unit, "node", &["-e", code]);
    let ready = member
        .lines
        .expect("ready", |l| l.starts_with("ready "))
        .await;
    let pids: Vec<u32> = ready["ready ".len()..]
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    let (cmd_pid, node2_pid) = (pids[0], pids[1]);
    member
        .lines
        .expect("ping output", |l| l.contains("127.0.0.1"))
        .await;
    let node1_pid = child_named(member.shim.pid, "node.exe").expect("node under the shim");
    unit.set_main(ProcWatch::open(node1_pid).unwrap());
    let ping_pid = child_named(cmd_pid, "ping.exe").expect("ping under cmd");
    let tree: Vec<Proc> = [node1_pid, node2_pid, cmd_pid, ping_pid]
        .into_iter()
        .map(Proc::open)
        .collect();
    let members = member_pids(&unit);
    for pid in std::iter::once(member.shim.pid).chain(tree.iter().map(|p| p.pid)) {
        assert!(members.contains(&pid), "{pid} is not a member: {members:?}");
        unit.confirm_placement(pid)
            .unwrap_or_else(|err| panic!("{pid} is not confirmed placed: {err}"));
    }
    let outside = OwnChild(
        std::process::Command::new("node")
            .args(["-e", "setInterval(()=>{},1e9)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let err = unit
        .confirm_placement(outside.0.id())
        .expect_err("a node started outside the unit is not placed");
    assert_ne!(err.kind(), std::io::ErrorKind::NotFound, "{err}");
    drop(outside);

    let (report, survivors) = force_stop(&unit, StopReason::ShiftX).await;
    assert!(report.lock_released, "{report:?}");
    assert!(survivors.is_empty(), "{survivors:?}");
    for process in std::iter::once(&member.shim).chain(tree.iter()) {
        assert!(
            process.wait(EXIT_WAIT),
            "member {} outlived the stop",
            process.pid
        );
    }
    let _ = member.child.wait().await;
}

/// LB-10: Codex's managed daemon, started with explicit breakaway behind a
/// node launcher, leaves the unit job: it is never a member, and neither the
/// stop nor the unit releasing its job (kill-on-close) ends it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_codex_breakaway_daemon_is_never_a_member() {
    let state = tempfile::tempdir().unwrap();
    let containment = containment(state.path());
    let unit = containment.create_unit(UnitId::mint(), label()).unwrap();
    let code = format!(
        "require('child_process').spawn({},['breakaway-daemon'],{{stdio:'inherit'}});setInterval(()=>{{}},1e9);",
        js(HELPER)
    );
    let mut member = start(&unit, "node", &["-e", &code]);
    let line = member
        .lines
        .expect("daemon or spawn-error", |l| {
            l.starts_with("daemon ") || l.starts_with("spawn-error ")
        })
        .await;
    let daemon_pid: u32 = line
        .strip_prefix("daemon ")
        .unwrap_or_else(|| panic!("the breakaway spawn failed: {line}"))
        .trim()
        .parse()
        .unwrap();
    let daemon = Proc::open(daemon_pid);
    let node_pid = child_named(member.shim.pid, "node.exe").expect("node under the shim");
    unit.set_main(ProcWatch::open(node_pid).unwrap());
    let members = member_pids(&unit);
    assert!(
        members.contains(&member.shim.pid) && members.contains(&node_pid),
        "the launcher is not a member: {members:?}"
    );
    assert!(
        !members.contains(&daemon_pid),
        "the daemon {daemon_pid} is a member: {members:?}"
    );

    let (_report, survivors) = force_stop(&unit, StopReason::ShiftX).await;
    assert!(survivors.is_empty(), "{survivors:?}");
    assert!(daemon.running(), "the daemon died with the unit");
    // The sweep released the job handle before `wait_swept` returned.
    assert!(
        !daemon.wait(Duration::from_secs(1)),
        "the daemon died when the unit released its job"
    );
    // `daemon` is terminated through its handle on drop.
}

/// R7: every Codex daemon-family member (the daemon, its updater, the
/// legacy launch) is judged by its OWN command line and spared, with its
/// descendants; the rest of the unit dies; the spared run on after the unit
/// releases its job, and each is logged by pid and name.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_family_members_are_spared_by_their_own_argv() {
    let captured = captured();
    let state = tempfile::tempdir().unwrap();
    let containment = containment(state.path());
    let unit = containment.create_unit(UnitId::mint(), label()).unwrap();
    let mut family = Vec::new();
    for args in [
        &["idle", "app-server", "--managed-daemon"][..],
        &["idle", "app-server", "daemon", "pid-update-loop"][..],
        &["idle", "app-server", "--listen", "unix://"][..],
    ] {
        let mut member = start(&unit, HELPER, args);
        let pid = member.lines.expect_pid("idle ").await;
        family.push((member, Proc::open(pid)));
    }
    let mut plain = start(&unit, HELPER, &["idle"]);
    let plain_pid = plain.lines.expect_pid("idle ").await;
    let plain_proc = Proc::open(plain_pid);
    unit.set_main(ProcWatch::open(plain_pid).unwrap());
    // Every one is in the unit's job; the family is spared only at the kill.
    let placed: Vec<u32> = family
        .iter()
        .map(|(_, p)| p.pid)
        .chain([plain_pid])
        .collect();
    for pid in placed {
        unit.confirm_placement(pid)
            .unwrap_or_else(|err| panic!("{pid} is not confirmed placed: {err}"));
    }

    let (report, survivors) = force_stop(&unit, StopReason::ShiftX).await;
    assert!(report.lock_released, "{report:?}");
    assert!(survivors.is_empty(), "{survivors:?}");
    assert!(
        plain_proc.wait(EXIT_WAIT),
        "the plain member outlived the stop"
    );
    assert!(
        plain.shim.wait(EXIT_WAIT),
        "the plain member's shim outlived the stop"
    );
    let spared = captured.of_unit(unit.id().as_str(), "unit.stop.spared");
    for (_, process) in &family {
        assert!(
            process.running(),
            "family member {} was killed",
            process.pid
        );
        let pid = process.pid.to_string();
        assert!(
            spared.iter().any(|e| e.fields.get("pid") == Some(&pid)
                && e.fields
                    .get("name")
                    .is_some_and(|n| n.eq_ignore_ascii_case("freshell-test-helper.exe"))),
            "family member {pid} was not logged as spared by name: {spared:?}"
        );
    }
    // The sweep released the job handle before `wait_swept` returned.
    for (_, process) in &family {
        assert!(
            !process.wait(Duration::from_secs(1)),
            "family member {} died when the unit released its job",
            process.pid
        );
    }
    // Spared shims and family members are terminated through their handles
    // on drop.
}

/// A test-owned job with its own completion port, to show that a scenario
/// really posts a nested job's zero message.
struct PortJob {
    job: HANDLE,
    port: HANDLE,
    name: String,
}

impl PortJob {
    fn new() -> Self {
        let name = format!("Local\\freshell-port-check-{}", UnitId::mint().as_str());
        let name_w = wide(&name);
        // SAFETY: plain creations; every result is checked.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), name_w.as_ptr());
            assert!(!job.is_null(), "CreateJobObjectW");
            let port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1);
            assert!(!port.is_null(), "CreateIoCompletionPort");
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            assert_ne!(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast::<c_void>(),
                    std::mem::size_of_val(&limits) as u32,
                ),
                0
            );
            let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                CompletionKey: 7usize as *mut c_void,
                CompletionPort: port,
            };
            assert_ne!(
                SetInformationJobObject(
                    job,
                    JobObjectAssociateCompletionPortInformation,
                    std::ptr::from_ref(&assoc).cast::<c_void>(),
                    std::mem::size_of_val(&assoc) as u32,
                ),
                0
            );
            Self { job, port, name }
        }
    }

    fn active_processes(&self) -> u32 {
        // SAFETY: a live job and a correctly sized information block.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            assert_ne!(
                QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    std::ptr::from_mut(&mut info).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ),
                0
            );
            info.ActiveProcesses
        }
    }

    /// Whether a zero message arrives on the port within `limit`.
    fn zero_message_within(&self, limit: Duration) -> bool {
        let deadline = std::time::Instant::now() + limit;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let (mut msg, mut key, mut overlapped) =
                (0u32, 0usize, std::ptr::null_mut::<OVERLAPPED>());
            // SAFETY: a live port and valid out-pointers.
            let ok = unsafe {
                GetQueuedCompletionStatus(
                    self.port,
                    &mut msg,
                    &mut key,
                    &mut overlapped,
                    left.as_millis() as u32,
                )
            };
            if ok == 0 {
                return false; // the deadline passed
            }
            if msg == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO {
                return true;
            }
        }
    }
}

impl Drop for PortJob {
    fn drop(&mut self) {
        // SAFETY: our handles, closed once (kill-on-close ends the members).
        unsafe {
            CloseHandle(self.job);
            CloseHandle(self.port);
        }
    }
}

/// LB-08 (V5 §3.7): nested jobs post their zero messages under the unit's
/// own key, so the unit's empty wait must confirm each one against the unit
/// job's active process count. The member runs a child in a nested
/// kill-on-close job that has its own completion port; when that child
/// exits, the nested job empties while the member still runs. (On the
/// runner, neither a Node grandchild's libuv job nor a nested job without a
/// port of its own posted a zero message to the parent's port: runs
/// 38014321238 and 38015212020.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_unit_empty_wait_ignores_nested_job_zero_messages() {
    // Precondition: this scenario really posts a nested zero message while
    // its job still has members (shown on a job and port the test owns).
    {
        let job = PortJob::new();
        let mut child = std::process::Command::new(SHIM)
            .args(["--job", &job.name, "--", HELPER, "job-child"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let shim = Proc::open(child.id());
        let mut lines = windows_support::Lines::new(child.stdout.take().unwrap());
        lines.expect_pid("job-child ");
        assert!(
            !job.zero_message_within(Duration::from_millis(200)),
            "precondition: a zero message before the nested job's child ended"
        );
        drop(child.stdin.take());
        lines.expect("child-exited", |l| l == "child-exited");
        assert!(
            job.zero_message_within(Duration::from_secs(10)),
            "precondition: no zero message after the nested job emptied"
        );
        assert!(
            job.active_processes() > 0,
            "precondition: the job itself emptied"
        );
        drop(shim);
        let _ = child.kill();
        let _ = child.wait();
    }

    let state = tempfile::tempdir().unwrap();
    let containment = containment(state.path());
    let unit = containment.create_unit(UnitId::mint(), label()).unwrap();
    let mut member = start(&unit, HELPER, &["job-child"]);
    member.lines.expect_pid("job-child ").await;
    let helper = child_named(member.shim.pid, "freshell-test-helper.exe")
        .expect("the helper under the shim");
    unit.set_main(ProcWatch::open(helper).unwrap());
    let empty = testing::unit_empty_wait(&unit).expect("the job backend has an empty event");
    tokio::pin!(empty);
    drop(member.child.stdin.take());
    member
        .lines
        .expect("child-exited", |l| l == "child-exited")
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(500), &mut empty)
            .await
            .is_err(),
        "the unit's empty wait completed while its shim and helper still run"
    );
    let (_report, survivors) = force_stop(&unit, StopReason::ShiftX).await;
    assert!(survivors.is_empty(), "{survivors:?}");
    tokio::time::timeout(POST_GONE_EMPTY_WAIT, &mut empty)
        .await
        .expect("the empty wait completes once the unit is empty")
        .expect("the empty wait watched the unit");
}

/// A test child terminated through its handle when the test ends.
struct OwnChild(std::process::Child);

impl Drop for OwnChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lock_holders_and_listener_owner_are_found() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.lock");
    std::fs::write(&file, b"").unwrap();
    let holder = OwnChild(
        std::process::Command::new("node")
            .args([
                "-e",
                &format!(
                    "require('fs').openSync({:?}, 'r+'); setTimeout(()=>{{}},600000)",
                    file.display().to_string()
                ),
            ])
            .spawn()
            .unwrap(),
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(lock_holders(std::slice::from_ref(&file))
        .iter()
        .any(|h| h.pid == holder.0.id()));
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let listener = OwnChild(
        std::process::Command::new("node")
            .args([
                "-e",
                &format!("require('net').createServer().listen({port}, '127.0.0.1')"),
            ])
            .spawn()
            .unwrap(),
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        listening_socket_owner(port, &[listener.0.id()]),
        Some(listener.0.id())
    );
    for pid in [holder.0.id(), listener.0.id()] {
        ProcWatch::open(pid).unwrap().signal(Sig::Kill).unwrap();
    }
}

/// Our own non-blocking attempt at the lock, as Codex takes it.
fn try_lock(path: &std::path::Path) -> Result<std::fs::File, std::fs::TryLockError> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(std::fs::TryLockError::Error)?;
    file.try_lock()?;
    Ok(file)
}

/// LB-11, LB-46: a real writer-lock holder (the unit's main, behind a node
/// launcher as `codex.exe` is) is reported by its process name, never its
/// command line, and its lock is free the moment the stop reaches Gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_writer_lock_holder_is_reported_by_name_and_released_at_gone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.lock");
    let state = tempfile::tempdir().unwrap();
    let containment = containment(state.path());
    let unit = containment.create_unit(UnitId::mint(), label()).unwrap();
    let code = format!(
        "const c=require('child_process').spawn({},['hold-lock',{}],{{stdio:'inherit'}});\
         c.on('exit',(code)=>process.exit(code===null?1:code));",
        js(HELPER),
        js(path.to_str().unwrap())
    );
    let mut member = start(&unit, "node", &["-e", &code]);
    let holder_pid = member.lines.expect_pid("locked ").await;
    unit.set_main(ProcWatch::open(holder_pid).unwrap());
    unit.set_lock_paths(vec![path.clone()]);
    let holders = lock_holders(std::slice::from_ref(&path));
    let holder = holders
        .iter()
        .find(|h| h.pid == holder_pid)
        .unwrap_or_else(|| panic!("the holder {holder_pid} is not reported: {holders:?}"));
    assert_eq!(holder.name, "freshell-test-helper.exe");
    assert_eq!(holder.path, path);

    let (report, _survivors) = force_stop(&unit, StopReason::ShiftX).await;
    assert!(report.lock_released, "{report:?}");
    let holders = lock_holders(std::slice::from_ref(&path));
    assert!(holders.is_empty(), "holders after Gone: {holders:?}");
    match try_lock(&path) {
        Ok(own) => drop(own),
        Err(err) => panic!("the lock outlived Gone: {err:?}"),
    }
    let _ = member.child.wait().await;
}

/// R1, R3: a unit reopened from a record (a stop a crashed server left
/// unfinished) has no job; its stop reaches the record's identity-verified
/// roots and their descendants by handle, sparing the daemon family. The
/// root's children are detached, so libuv's own kill-on-close job (which
/// ends a node's non-detached children with it) never reaches them: only
/// the stop can (run 38015596259 showed a non-detached daemon-shaped child
/// dying with its node).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reopened_unit_stops_its_recorded_roots_and_their_descendants() {
    let code = format!(
        "const cp=require('child_process');\
         const a=cp.spawn({h},['idle'],{{stdio:'inherit',detached:true}});\
         const d=cp.spawn({h},['idle','app-server','--managed-daemon'],{{stdio:'inherit',detached:true}});\
         console.log('kids '+a.pid+' '+d.pid);setInterval(()=>{{}},1e9);",
        h = js(HELPER)
    );
    let mut root = std::process::Command::new("node")
        .args(["-e", &code])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let root_proc = Proc::open(root.id());
    let mut lines = windows_support::Lines::new(root.stdout.take().unwrap());
    let kids = lines.expect("kids", |l| l.starts_with("kids "));
    let kids: Vec<u32> = kids["kids ".len()..]
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    lines.expect("idle", |l| l.starts_with("idle "));
    lines.expect("idle", |l| l.starts_with("idle "));
    let (plain, daemon) = (Proc::open(kids[0]), Proc::open(kids[1]));
    let root_start = freshell_containment::process::start_time(root_proc.pid).unwrap();

    let state = tempfile::tempdir().unwrap();
    let containment = containment(state.path());
    let record = UnitRecord {
        unit_id: UnitId::mint(),
        provider: "codex".into(),
        mode: "codex".into(),
        terminal_id: Some("t-reopened".into()),
        create_request_id: None,
        conversation_keys: Vec::new(),
        roots: vec![(root_proc.pid, root_start)],
        state: UnitRecordState::Stopping {
            reason: "shift-x".into(),
            operation_id: None,
            since_ms: 0,
        },
    };
    let unit = containment.reopen_unit(&record, label()).unwrap();
    assert!(
        unit.placement(MemberRole::Agent).is_err(),
        "a reopened unit never gains members"
    );
    let members = member_pids(&unit);
    assert!(
        members.contains(&root_proc.pid) && members.contains(&plain.pid),
        "{members:?}"
    );
    assert!(!members.contains(&daemon.pid), "{members:?}");

    let (_report, survivors) = force_stop(&unit, StopReason::BootFinish).await;
    assert!(survivors.is_empty(), "{survivors:?}");
    assert!(
        root_proc.wait(EXIT_WAIT),
        "the recorded root outlived the stop"
    );
    assert!(plain.wait(EXIT_WAIT), "the root's child outlived the stop");
    assert!(daemon.running(), "the daemon-family child was killed");
    let _ = root.wait();
}

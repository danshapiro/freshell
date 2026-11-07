//! Native Windows recovery must not authorize a replacement while any member
//! of the failed Codex app-server's process tree is still running.
#![cfg(all(windows, feature = "test-support"))]

use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use freshell_freshagent::codex::{
    CodexCreateOutcome, FreshCodexState, NATIVE_READINESS_RESUME_NOT_FOUND,
};
use freshell_protocol::{
    AgentProvider, FreshAgentAttach, FreshAgentCreate, SessionLocator, SessionType,
};
use serde_json::{json, Value};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    },
};

static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const THREAD: &str = "thread-recovery-source";

// Handles pin the actual processes, so checking or cleaning up a failed test
// can never accidentally inspect or terminate a process that reused the PID.
struct TestProcess(HANDLE);

impl TestProcess {
    fn open(state: &FreshCodexState, pid: u32) -> Self {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(
            !handle.is_null(),
            "open owned process {pid}: {}",
            std::io::Error::last_os_error()
        );
        if !state.windows_test_handle_is_owned(handle as usize) {
            unsafe { CloseHandle(handle) };
            panic!("process {pid} was not a member of this test's Codex job");
        }
        Self(handle)
    }

    fn exited(&self) -> bool {
        match unsafe { WaitForSingleObject(self.0, 0) } {
            WAIT_OBJECT_0 => true,
            WAIT_TIMEOUT => false,
            other => panic!("waiting on test process returned {other}"),
        }
    }

    fn terminate(&self) {
        assert_ne!(
            unsafe { TerminateProcess(self.0, 1) },
            0,
            "terminate owned fixture process: {}",
            std::io::Error::last_os_error()
        );
    }
}

impl Drop for TestProcess {
    fn drop(&mut self) {
        unsafe {
            if WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT {
                TerminateProcess(self.0, 1);
                WaitForSingleObject(self.0, 5000);
            }
            CloseHandle(self.0);
        }
    }
}

struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Environment {
    fn set(values: &[(&'static str, std::ffi::OsString)]) -> Self {
        let previous = values
            .iter()
            .map(|(key, _)| (*key, std::env::var_os(key)))
            .collect();
        for (key, value) in values {
            std::env::set_var(key, value);
        }
        Self(previous)
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}

fn request(cwd: &Path) -> FreshAgentCreate {
    FreshAgentCreate {
        collaboration_mode: None,
        pane_id: None,
        naming_handle: None,
        observed_epoch: None,
        observed_generation: None,
        request_id: "windows-recovery".into(),
        view_id: None,
        session_type: SessionType::Freshcodex,
        provider: Some(AgentProvider::Codex),
        cwd: Some(cwd.to_string_lossy().into_owned()),
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: Some(SessionLocator {
            provider: "codex".into(),
            session_id: THREAD.into(),
        }),
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
        tab_id: None,
    }
}

async fn read_pid(path: &Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Ok(contents) = std::fs::read_to_string(path) {
                if let Ok(pid) = contents.trim().parse() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {}", path.display()))
}

async fn read_changed_pid(path: &Path, previous: u32) -> u32 {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let pid = read_pid(path).await;
            if pid != previous {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for a new PID in {}", path.display()))
}

async fn wait_exited_status(rx: &mut tokio::sync::broadcast::Receiver<String>) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let raw = rx.recv().await.expect("broadcast bus remains open");
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.status"
                && frame["event"]["status"] == "exited"
            {
                break;
            }
        }
    })
    .await
    .expect("the watcher reports the provider exit");
}

fn fixture_environment(cwd: &Path, behavior: &Value) -> Environment {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    // CODEX_CMD is intentionally parsed as separate whitespace-delimited words.
    assert!(
        !fixture.to_string_lossy().contains(char::is_whitespace),
        "fixture path contains spaces: {}",
        fixture.display()
    );
    Environment::set(&[
        ("CODEX_CMD", format!("node {}", fixture.display()).into()),
        ("CODEX_HOME", cwd.join("codex-home").into_os_string()),
        (
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            behavior.to_string().into(),
        ),
    ])
}

async fn run_case(error: Option<Value>, unconfirmed: bool, cancel_resume: bool) {
    let _lock = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_pid = dir.path().join("app-server.pid");
    let child_pid = dir.path().join("native-child.pid");
    let child_ready = dir.path().join("native-ready.pid");
    let waiting = dir.path().join("resume-waiting.pid");
    let release = dir.path().join("resume-release");
    let request_log = dir.path().join("requests.jsonl");
    let mut behavior = json!({
        "spawnNativeChild": true,
        "sidecarPidFile": root_pid,
        "nativePidFile": child_pid,
        "nativeChildReadyFile": child_ready,
        "appendRequestLogPath": request_log,
    });
    if let Some(error) = error.as_ref() {
        behavior["overrides"] = json!({"thread/resume": {"error": error}});
        behavior["waitForResumeReleasePath"] = json!(release);
        behavior["resumeWaitingPath"] = json!(waiting);
    }
    let _environment = fixture_environment(dir.path(), &behavior);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshCodexState::new(
        Arc::new("token".into()),
        Arc::new(tx),
        json!({"freshAgent":{"enabled":true}}),
    );
    if unconfirmed {
        state.set_sidecar_cleanup_probe(Arc::new(|_| Box::pin(async { Ok(false) })));
    }
    let task = {
        let state = state.clone();
        let request = request(dir.path());
        tokio::spawn(async move {
            state
                .handle_create_for_native_readiness(request, None)
                .await
        })
    };

    let root_id = read_pid(&root_pid).await;
    let root = TestProcess::open(&state, root_id);
    assert_eq!(
        state.windows_test_spawn_count(),
        1,
        "the initial provider launch must be observed"
    );
    let child_id = read_pid(&child_pid).await;
    let child = TestProcess::open(&state, child_id);
    assert_eq!(read_pid(&child_ready).await, child_id);
    if error.is_some() {
        assert_eq!(read_pid(&waiting).await, read_pid(&root_pid).await);
        assert!(
            !root.exited() && !child.exited(),
            "both fixture processes must be alive before the response"
        );
        if cancel_resume {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert_retry_fenced(&state, dir.path(), &root_pid, root_id).await;
            assert_attach_fenced(&state, &mut rx, dir.path(), &root_pid, root_id).await;
            state.shutdown().await;
            return;
        }
        std::fs::write(&release, b"release").unwrap();
    }
    let outcome = tokio::time::timeout(Duration::from_secs(60), task)
        .await
        .expect("recovery completed")
        .expect("recovery task");

    if error.is_none() {
        assert!(
            matches!(outcome, CodexCreateOutcome::Created { ref session_id, .. } if session_id == THREAD),
            "{outcome:?}"
        );
        assert!(
            !root.exited() && !child.exited(),
            "a successful resume must retain the process tree"
        );
        state.shutdown().await;
        assert!(
            root.exited() && child.exited(),
            "shutdown must settle both processes"
        );
    } else {
        let code = match outcome {
            CodexCreateOutcome::Failed { ref code, .. } => code,
            ref other => panic!("unexpected result {other:?}"),
        };
        if unconfirmed
            || error.as_ref().unwrap()["message"]
                != "no rollout found for thread id thread-recovery-source"
        {
            assert_ne!(
                code, NATIVE_READINESS_RESUME_NOT_FOUND,
                "unconfirmed or ambiguous errors must not authorize replacement"
            );
        } else {
            assert_eq!(code, NATIVE_READINESS_RESUME_NOT_FOUND);
            assert!(
                root.exited() && child.exited(),
                "both processes must already be gone when exact NotFound is returned"
            );
        }
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(frame["type"], "freshAgent.created", "{frame}");
        }
        let operations = std::fs::read_to_string(&request_log).unwrap();
        assert!(
            operations.lines().all(
                |line| serde_json::from_str::<Value>(line).unwrap()["method"] != "thread/start"
            ),
            "failed resume must not start a replacement"
        );
        if unconfirmed {
            assert_retry_fenced(&state, dir.path(), &root_pid, root_id).await;
            assert_attach_fenced(&state, &mut rx, dir.path(), &root_pid, root_id).await;
        }
        state.shutdown().await;
    }
}

async fn attach_with_replies(state: &FreshCodexState, mut attach: FreshAgentAttach) -> Vec<Value> {
    attach.request_id = Some("windows-recovery-attach".into());
    attach.view_id = Some("windows-recovery-view".into());
    let replies = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = replies.clone();
    state
        .handle_attach(
            attach,
            Arc::new(move |frame| {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(frame).unwrap());
            }),
        )
        .await;
    let frames = replies.lock().unwrap().clone();
    assert!(
        frames
            .iter()
            .any(|frame| frame["requestId"] == "windows-recovery-attach"
                && frame["viewId"] == "windows-recovery-view"),
        "requester receives its correlated attach reply: {frames:?}"
    );
    frames
}

async fn assert_attach_fenced(
    state: &FreshCodexState,
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    cwd: &Path,
    root_pid: &Path,
    root_id: u32,
) {
    while rx.try_recv().is_ok() {}
    let spawn_count = state.windows_test_spawn_count();
    let attach = serde_json::from_value(json!({
        "sessionId": THREAD,
        "provider": "codex",
        "sessionType": "freshcodex",
        "cwd": cwd,
    }))
    .unwrap();
    let frames = tokio::time::timeout(Duration::from_secs(30), attach_with_replies(state, attach))
        .await
        .expect("a fenced attach returns");
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "freshAgent.attach.failed"
                && frame["code"] == "SESSION_RESERVED"),
        "attach must report the fenced prior runtime: {frames:?}"
    );
    assert_eq!(
        read_pid(root_pid).await,
        root_id,
        "attach must not spawn another app-server while the prior tree is unconfirmed"
    );
    assert_eq!(
        state.windows_test_spawn_count(),
        spawn_count,
        "attach must not launch a provider even if it exits before writing its PID"
    );
}

async fn assert_retry_fenced(state: &FreshCodexState, cwd: &Path, root_pid: &Path, root_id: u32) {
    let spawn_count = state.windows_test_spawn_count();
    let replay_outcome = tokio::time::timeout(
        Duration::from_secs(30),
        state.handle_create_for_native_readiness(request(cwd), None),
    )
    .await
    .expect("a replayed request returns");
    assert!(
        matches!(replay_outcome, CodexCreateOutcome::Failed { .. }),
        "a replay must not report the unconfirmed prior as live: {replay_outcome:?}"
    );
    assert_eq!(
        state.windows_test_spawn_count(),
        spawn_count,
        "replaying the original request must not launch a provider"
    );
    let mut retry = request(cwd);
    retry.request_id = "windows-recovery-retry".into();
    let retry_outcome = tokio::time::timeout(
        Duration::from_secs(30),
        state.handle_create_for_native_readiness(retry, None),
    )
    .await
    .expect("a fenced retry returns");
    assert!(
        matches!(retry_outcome, CodexCreateOutcome::Failed { .. }),
        "retry while cleanup is unconfirmed must fail: {retry_outcome:?}"
    );
    assert_eq!(
        read_pid(root_pid).await,
        root_id,
        "a retry must not spawn another app-server while the prior tree is unconfirmed"
    );
    assert_eq!(
        state.windows_test_spawn_count(),
        spawn_count,
        "retry must not launch a provider even if it exits before writing its PID"
    );
}

fn install_switchable_unconfirmed_probe(
    state: &FreshCodexState,
) -> (Arc<AtomicBool>, Arc<AtomicUsize>, Arc<AtomicBool>) {
    let armed = Arc::new(AtomicBool::new(false));
    let attempts = Arc::new(AtomicUsize::new(0));
    let confirmed = Arc::new(AtomicBool::new(false));
    state.set_sidecar_cleanup_probe(Arc::new({
        let armed = armed.clone();
        let attempts = attempts.clone();
        let confirmed = confirmed.clone();
        move |_| {
            let armed = armed.clone();
            let attempts = attempts.clone();
            let confirmed = confirmed.clone();
            Box::pin(async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                if armed.load(Ordering::SeqCst) {
                    Ok(confirmed.load(Ordering::SeqCst))
                } else {
                    Err("test probe used before it was armed".to_string())
                }
            })
        }
    }));
    (armed, attempts, confirmed)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HelperChurn {
    None,
    Synchronized,
    Immediate,
}

async fn run_unexpected_exit(unconfirmed: bool, helper_churn: HelperChurn) {
    let _lock = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_pid = dir.path().join("app-server.pid");
    let child_pid = dir.path().join("native-child.pid");
    let child_ready = dir.path().join("native-ready.pid");
    let mut behavior = json!({
        "spawnNativeChild": true,
        "sidecarPidFile": root_pid,
        "nativePidFile": child_pid,
        "nativeChildReadyFile": child_ready,
    });
    if helper_churn == HelperChurn::Synchronized {
        behavior["nativeChurnDir"] = json!(dir.path());
        behavior["nativeChurnCount"] = json!(8);
    } else if helper_churn == HelperChurn::Immediate {
        behavior["nativeImmediateChurnDir"] = json!(dir.path());
        behavior["nativeImmediateChurnCount"] = json!(8);
    }
    let _environment = fixture_environment(dir.path(), &behavior);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshCodexState::new(
        Arc::new("token".into()),
        Arc::new(tx),
        json!({"freshAgent":{"enabled":true}}),
    );
    let (probe_armed, probes, _) = if unconfirmed {
        install_switchable_unconfirmed_probe(&state)
    } else {
        (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        )
    };
    let outcome = state
        .handle_create_for_native_readiness(request(dir.path()), None)
        .await;
    assert!(
        matches!(outcome, CodexCreateOutcome::Created { .. }),
        "{outcome:?}"
    );
    let root_id = read_pid(&root_pid).await;
    let root = TestProcess::open(&state, root_id);
    assert_eq!(
        state.windows_test_spawn_count(),
        1,
        "the initial provider launch must be observed"
    );
    let child_id = read_pid(&child_pid).await;
    let child = TestProcess::open(&state, child_id);
    assert_eq!(read_pid(&child_ready).await, child_id);
    assert!(!root.exited() && !child.exited());
    let replay = state
        .handle_create_for_native_readiness(request(dir.path()), None)
        .await;
    assert!(
        matches!(replay, CodexCreateOutcome::Created { .. }),
        "a healthy cached request must still replay: {replay:?}"
    );
    let mut healthy_adoption = request(dir.path());
    healthy_adoption.request_id = "windows-healthy-adoption".into();
    let adopted = state
        .handle_create_for_native_readiness(healthy_adoption, None)
        .await;
    assert!(
        matches!(adopted, CodexCreateOutcome::Created { .. }),
        "a healthy live session must remain adoptable: {adopted:?}"
    );
    assert_eq!(
        state.windows_test_spawn_count(),
        1,
        "adopting the live session must not start a new provider"
    );
    if helper_churn == HelperChurn::Synchronized {
        let mut helpers = Vec::new();
        let mut helper_ids = std::collections::HashSet::new();
        for index in 0..8 {
            let pid = read_pid(&dir.path().join(format!("helper-{index}.pid"))).await;
            assert!(
                helper_ids.insert(pid),
                "each helper must be a distinct process"
            );
            let helper = TestProcess::open(&state, pid);
            assert!(
                !helper.exited(),
                "helper {index} started inside the Codex job"
            );
            helpers.push(helper);
        }
        std::fs::write(dir.path().join("release"), b"release").unwrap();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if helpers.iter().all(TestProcess::exited) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("all short-lived helpers exit");
        // Do not keep the test's handles open during recovery: only the
        // production guard's observations can establish what it saw.
        drop(helpers);
        behavior.as_object_mut().unwrap().remove("nativeChurnDir");
        behavior.as_object_mut().unwrap().remove("nativeChurnCount");
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
    } else if helper_churn == HelperChurn::Immediate {
        let complete = dir.path().join("immediate-churn-complete.json");
        let outcomes: Value = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Ok(contents) = std::fs::read_to_string(&complete) {
                    if let Ok(value) = serde_json::from_str(&contents) {
                        break value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("all immediately exiting helpers reported completion");
        let outcomes = outcomes.as_array().expect("helper completion records");
        assert_eq!(outcomes.len(), 8, "all helpers must be accounted for");
        assert!(
            outcomes
                .iter()
                .all(|outcome| outcome["pid"].as_u64().is_some()
                    && outcome["code"] == 0
                    && outcome["signal"].is_null()),
            "all helpers must actually start and exit successfully: {outcomes:?}"
        );
        // Helpers exit on their own, before this completion marker. The test
        // never opens their process handles, so it cannot keep them observable.
        behavior
            .as_object_mut()
            .unwrap()
            .remove("nativeImmediateChurnDir");
        behavior
            .as_object_mut()
            .unwrap()
            .remove("nativeImmediateChurnCount");
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
    }
    if unconfirmed {
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        probe_armed.store(true, Ordering::SeqCst);
    }
    // Simulate an unexpected exit of the actual app-server, keeping the
    // test-owned process handle open to prevent PID reuse.
    root.terminate();
    wait_exited_status(&mut rx).await;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if root.exited()
                && state.live_session_incarnation(THREAD).await.is_none()
                && !state.windows_test_notification_drain_pending(THREAD).await
                && (!unconfirmed || probes.load(Ordering::SeqCst) > 0)
                && (unconfirmed || child.exited())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the watcher observed the unexpected exit");

    if unconfirmed {
        assert_retry_fenced(&state, dir.path(), &root_pid, root_id).await;
        assert_attach_fenced(&state, &mut rx, dir.path(), &root_pid, root_id).await;
    } else {
        let spawn_count = state.windows_test_spawn_count();
        let attach = serde_json::from_value(json!({
            "sessionId": THREAD,
            "provider": "codex",
            "sessionType": "freshcodex",
            "cwd": dir.path(),
        }))
        .unwrap();
        tokio::time::timeout(Duration::from_secs(30), attach_with_replies(&state, attach))
            .await
            .expect("recovery attach returns");
        let replacement_id = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let pid = read_pid(&root_pid).await;
                if pid != root_id {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("a confirmed exit permits a replacement");
        let replacement = TestProcess::open(&state, replacement_id);
        assert_eq!(
            state.windows_test_spawn_count(),
            spawn_count + 1,
            "the confirmed-exit attach must launch exactly one replacement"
        );
        let replacement_child_id = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let pid = read_pid(&child_pid).await;
                if pid != child_id {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the replacement spawned its native child");
        let replacement_child = TestProcess::open(&state, replacement_child_id);
        assert!(!replacement.exited(), "the replacement stays alive");
        state.shutdown().await;
        assert!(
            replacement.exited() && replacement_child.exited(),
            "shutdown settles the replacement tree"
        );
    }
    state.shutdown().await;
}

async fn run_handoff(unconfirmed: bool, confirm_after: bool) {
    let _lock = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_pid = dir.path().join("app-server.pid");
    let child_pid = dir.path().join("native-child.pid");
    let child_ready = dir.path().join("native-ready.pid");
    let behavior = json!({
        "spawnNativeChild": true,
        "sidecarPidFile": root_pid,
        "nativePidFile": child_pid,
        "nativeChildReadyFile": child_ready,
    });
    let _environment = fixture_environment(dir.path(), &behavior);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshCodexState::new(
        Arc::new("token".into()),
        Arc::new(tx),
        json!({"freshAgent":{"enabled":true}}),
    );
    let (probe_armed, probes, probe_confirmed) = if unconfirmed {
        install_switchable_unconfirmed_probe(&state)
    } else {
        (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        )
    };
    let outcome = state
        .handle_create_for_native_readiness(request(dir.path()), None)
        .await;
    assert!(
        matches!(outcome, CodexCreateOutcome::Created { .. }),
        "{outcome:?}"
    );
    let root_id = read_pid(&root_pid).await;
    let root = TestProcess::open(&state, root_id);
    let child_id = read_pid(&child_pid).await;
    let child = TestProcess::open(&state, child_id);
    assert_eq!(read_pid(&child_ready).await, child_id);
    assert!(!root.exited() && !child.exited());
    assert_eq!(state.windows_test_spawn_count(), 1);
    let escalation_gate = confirm_after.then(|| state.windows_test_pause_next_escalation());
    if unconfirmed {
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        probe_armed.store(true, Ordering::SeqCst);
    }
    let reaped = tokio::time::timeout(
        Duration::from_secs(30),
        state.windows_test_kill_for_handoff(THREAD),
    )
    .await
    .expect("handoff stop returns");
    if unconfirmed {
        assert!(
            !reaped,
            "handoff must not claim unconfirmed cleanup succeeded"
        );
        assert!(
            probes.load(Ordering::SeqCst) > 0,
            "handoff used the preinstalled probe"
        );
        assert_retry_fenced(&state, dir.path(), &root_pid, root_id).await;
        assert_attach_fenced(&state, &mut rx, dir.path(), &root_pid, root_id).await;
        if confirm_after {
            let (reached, release) = escalation_gate.expect("escalation gate installed");
            tokio::time::timeout(Duration::from_secs(30), reached.notified())
                .await
                .expect("detached cleanup is paused");
            tokio::time::timeout(Duration::from_secs(30), async {
                while !root.exited() || !child.exited() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the verified prior processes stop before confirmation");
            probe_confirmed.store(true, Ordering::SeqCst);
            let mut stale = request(dir.path());
            stale.request_id = "windows-stale-binding".into();
            let outcome = state.handle_create_for_native_readiness(stale, None).await;
            assert!(
                matches!(outcome, CodexCreateOutcome::Failed { ref code, .. } if code == "SESSION_RESERVED"),
                "a confirmed prior must not make a stale binding look live: {outcome:?}"
            );
            assert_eq!(state.windows_test_spawn_count(), 1);
            for _ in 0..2 {
                let replay = state
                    .handle_create_for_native_readiness(request(dir.path()), None)
                    .await;
                assert!(
                    matches!(replay, CodexCreateOutcome::Failed { ref code, .. } if code == "SESSION_RESERVED"),
                    "a cached request cannot report a stopped prior as live: {replay:?}"
                );
                assert_eq!(state.windows_test_spawn_count(), 1);
            }
            let mut retry = request(dir.path());
            retry.request_id = "windows-after-confirmation".into();
            let outcome = state.handle_create_for_native_readiness(retry, None).await;
            assert!(
                matches!(outcome, CodexCreateOutcome::Created { .. }),
                "a new attempt must resume after the stale binding is cleared: {outcome:?}"
            );
            assert_eq!(state.windows_test_spawn_count(), 2);
            let replacement_id = read_changed_pid(&root_pid, root_id).await;
            let replacement = TestProcess::open(&state, replacement_id);
            let replacement_child_id = read_changed_pid(&child_pid, child_id).await;
            let replacement_child = TestProcess::open(&state, replacement_child_id);
            replacement.terminate();
            replacement_child.terminate();
            tokio::time::timeout(Duration::from_secs(30), async {
                while !replacement.exited() || !replacement_child.exited() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the replacement processes stop");
            release.notify_one();
        }
    } else {
        assert!(reaped, "handoff must confirm the owned tree stopped");
        assert!(
            root.exited() && child.exited(),
            "both processes must exit before a successful handoff"
        );
    }
    state.shutdown().await;
}

#[tokio::test]
async fn attach_rechecks_the_fence_after_a_competing_resume_is_cancelled() {
    let _lock = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_pid = dir.path().join("app-server.pid");
    let child_pid = dir.path().join("native-child.pid");
    let child_ready = dir.path().join("native-ready.pid");
    let waiting = dir.path().join("resume-waiting.pid");
    let release_resume = dir.path().join("resume-release");
    let behavior = json!({
        "spawnNativeChild": true,
        "sidecarPidFile": root_pid,
        "nativePidFile": child_pid,
        "nativeChildReadyFile": child_ready,
        "overrides": {"thread/resume": {"error": {
            "code": -32600,
            "message": "no rollout found for thread id thread-recovery-source"
        }}},
        "waitForResumeReleasePath": release_resume,
        "resumeWaitingPath": waiting,
    });
    let _environment = fixture_environment(dir.path(), &behavior);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshCodexState::new(
        Arc::new("token".into()),
        Arc::new(tx),
        json!({"freshAgent":{"enabled":true}}),
    );
    let (probe_armed, probes, _) = install_switchable_unconfirmed_probe(&state);
    let (reached, release) = state.windows_test_pause_next_attach_before_lease();
    let attach = serde_json::from_value(json!({
        "sessionId": THREAD,
        "provider": "codex",
        "sessionType": "freshcodex",
        "cwd": dir.path(),
    }))
    .unwrap();
    let attach_task = {
        let state = state.clone();
        tokio::spawn(async move { attach_with_replies(&state, attach).await })
    };
    tokio::time::timeout(Duration::from_secs(30), reached.notified())
        .await
        .expect("attach reaches its pre-lease pause");
    assert_eq!(
        state.windows_test_spawn_count(),
        0,
        "paused attach has not launched a provider"
    );
    let create_task = {
        let state = state.clone();
        let create = request(dir.path());
        tokio::spawn(async move { state.handle_create_for_native_readiness(create, None).await })
    };
    let root_id = read_pid(&root_pid).await;
    let root = TestProcess::open(&state, root_id);
    let child_id = read_pid(&child_pid).await;
    let child = TestProcess::open(&state, child_id);
    assert_eq!(read_pid(&child_ready).await, child_id);
    assert_eq!(read_pid(&waiting).await, root_id);
    assert!(!root.exited() && !child.exited());
    assert_eq!(state.windows_test_spawn_count(), 1);
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    probe_armed.store(true, Ordering::SeqCst);
    create_task.abort();
    assert!(create_task.await.unwrap_err().is_cancelled());
    while rx.try_recv().is_ok() {}
    release.notify_one();
    let frames = tokio::time::timeout(Duration::from_secs(30), attach_task)
        .await
        .expect("attach returns after cancellation")
        .expect("attach task");
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "freshAgent.attach.failed"
                && frame["code"] == "SESSION_RESERVED"),
        "attach must observe the newly installed fence: {frames:?}"
    );
    assert_eq!(
        state.windows_test_spawn_count(),
        1,
        "attach must not launch a second provider"
    );
    assert_eq!(read_pid(&root_pid).await, root_id);
    state.shutdown().await;
}

#[tokio::test]
async fn crash_recovery_rechecks_the_fence_after_a_competing_resume_is_cancelled() {
    let _lock = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_pid = dir.path().join("app-server.pid");
    let child_pid = dir.path().join("native-child.pid");
    let child_ready = dir.path().join("native-ready.pid");
    let waiting = dir.path().join("resume-waiting.pid");
    let release_resume = dir.path().join("resume-release");
    let behavior = json!({
        "spawnNativeChild": true,
        "sidecarPidFile": root_pid,
        "nativePidFile": child_pid,
        "nativeChildReadyFile": child_ready,
    });
    let _environment = fixture_environment(dir.path(), &behavior);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshCodexState::new(
        Arc::new("token".into()),
        Arc::new(tx),
        json!({"freshAgent":{"enabled":true}}),
    );
    let initial = state
        .handle_create_for_native_readiness(request(dir.path()), None)
        .await;
    assert!(
        matches!(initial, CodexCreateOutcome::Created { .. }),
        "{initial:?}"
    );
    let original_root_id = read_pid(&root_pid).await;
    let original_root = TestProcess::open(&state, original_root_id);
    let original_child_id = read_pid(&child_pid).await;
    let original_child = TestProcess::open(&state, original_child_id);
    assert_eq!(read_pid(&child_ready).await, original_child_id);
    assert!(!original_root.exited() && !original_child.exited());
    original_root.terminate();
    wait_exited_status(&mut rx).await;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if original_root.exited()
                && original_child.exited()
                && state.live_session_incarnation(THREAD).await.is_none()
                && !state.windows_test_notification_drain_pending(THREAD).await
                && !state.windows_test_handle_is_owned(original_root.0 as usize)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the original process tree and notification drain settle");

    let (probe_armed, probes, _) = install_switchable_unconfirmed_probe(&state);
    let competing_behavior = json!({
        "spawnNativeChild": true,
        "sidecarPidFile": root_pid,
        "nativePidFile": child_pid,
        "nativeChildReadyFile": child_ready,
        "overrides": {"thread/resume": {"error": {
            "code": -32600,
            "message": "no rollout found for thread id thread-recovery-source"
        }}},
        "waitForResumeReleasePath": release_resume,
        "resumeWaitingPath": waiting,
    });
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        competing_behavior.to_string(),
    );
    let (reached, release) = state.windows_test_pause_next_recovery_before_lease();
    let attach = serde_json::from_value(json!({
        "sessionId": THREAD,
        "provider": "codex",
        "sessionType": "freshcodex",
        "cwd": dir.path(),
    }))
    .unwrap();
    let attach_task = {
        let state = state.clone();
        tokio::spawn(async move { attach_with_replies(&state, attach).await })
    };
    tokio::time::timeout(Duration::from_secs(30), reached.notified())
        .await
        .expect("crash recovery reaches its pre-lease pause");
    assert_eq!(state.windows_test_spawn_count(), 1);
    let create_task = {
        let state = state.clone();
        let mut create = request(dir.path());
        create.request_id = "competing-create".into();
        tokio::spawn(async move { state.handle_create_for_native_readiness(create, None).await })
    };
    let competing_root_id = read_changed_pid(&root_pid, original_root_id).await;
    let competing_root = TestProcess::open(&state, competing_root_id);
    let competing_child_id = read_changed_pid(&child_pid, original_child_id).await;
    let competing_child = TestProcess::open(&state, competing_child_id);
    assert_eq!(
        read_changed_pid(&child_ready, original_child_id).await,
        competing_child_id
    );
    assert_eq!(read_pid(&waiting).await, competing_root_id);
    assert!(!competing_root.exited() && !competing_child.exited());
    assert_eq!(state.windows_test_spawn_count(), 2);
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    probe_armed.store(true, Ordering::SeqCst);
    create_task.abort();
    assert!(create_task.await.unwrap_err().is_cancelled());
    while rx.try_recv().is_ok() {}
    release.notify_one();
    let frames = tokio::time::timeout(Duration::from_secs(30), attach_task)
        .await
        .expect("crash recovery returns after cancellation")
        .expect("attach task");
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "freshAgent.attach.failed"
                && frame["code"] == "SESSION_RESERVED"),
        "crash recovery must observe the newly installed fence: {frames:?}"
    );
    assert_eq!(
        state.windows_test_spawn_count(),
        2,
        "crash recovery must not launch a third provider"
    );
    assert_eq!(read_pid(&root_pid).await, competing_root_id);
    state.shutdown().await;
}

#[tokio::test]
async fn exact_not_found_confirms_the_whole_tree_before_returning() {
    run_case(Some(json!({"code":-32600,"message":"no rollout found for thread id thread-recovery-source"})), false, false).await;
}

#[tokio::test]
async fn crash_not_found_uses_job_proof_before_minting_the_replacement() {
    let _lock = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("app-server.pid");
    let child_path = dir.path().join("native-child.pid");
    let child_ready = dir.path().join("native-ready.pid");
    let waiting = dir.path().join("resume-waiting.pid");
    let release = dir.path().join("resume-release");
    let behavior = json!({"spawnNativeChild":true, "sidecarPidFile":root_path,
        "nativePidFile":child_path, "nativeChildReadyFile":child_ready});
    let _environment = fixture_environment(dir.path(), &behavior);
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshCodexState::new(
        Arc::new("token".into()),
        Arc::new(tx),
        json!({"freshAgent":{"enabled":true}}),
    );
    assert!(matches!(
        state
            .handle_create_for_native_readiness(request(dir.path()), None)
            .await,
        CodexCreateOutcome::Created { .. }
    ));
    let original_pid = read_pid(&root_path).await;
    let original = TestProcess::open(&state, original_pid);
    let original_child_pid = read_pid(&child_path).await;
    let original_child = TestProcess::open(&state, original_child_pid);
    assert_eq!(read_pid(&child_ready).await, original_child_pid);
    original.terminate();
    wait_exited_status(&mut rx).await;
    tokio::time::timeout(Duration::from_secs(30), async {
        while !original_child.exited()
            || state.windows_test_notification_drain_pending(THREAD).await
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("crashed original tree and its notification drain settle");
    let behavior = json!({"spawnNativeChild":true, "sidecarPidFile":root_path,
        "nativePidFile":child_path, "nativeChildReadyFile":child_ready,
        "threadStartThreadId":"windows-minted-after-job-proof",
        "overrides":{"thread/resume":{"error":{"code":-32600,
            "message":"no rollout found for thread id thread-recovery-source"}}},
        "waitForResumeReleasePath":release, "resumeWaitingPath":waiting});
    std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
    let recovering = state.clone();
    let recovery = tokio::spawn(async move { recovering.prepare_native_readiness(THREAD).await });
    let resume_pid = read_changed_pid(&root_path, original_pid).await;
    let resume = TestProcess::open(&state, resume_pid);
    let resume_child_pid = read_changed_pid(&child_path, original_child_pid).await;
    let resume_child = TestProcess::open(&state, resume_child_pid);
    assert_eq!(
        read_changed_pid(&child_ready, original_child_pid).await,
        resume_child_pid
    );
    assert_eq!(read_pid(&waiting).await, resume_pid);
    assert!(!resume.exited() && !resume_child.exited());
    std::fs::write(&release, b"release").unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(30), recovery)
        .await
        .expect("job proof and replacement complete within a bounded recovery")
        .unwrap();
    let replacement_live = state
        .live_session_incarnation("windows-minted-after-job-proof")
        .await
        .is_some();
    let resumed_tree_dead = resume.exited() && resume_child.exited();
    let launches = state.windows_test_spawn_count();
    state.shutdown().await;
    assert_eq!(
        outcome.unwrap().native_session_id,
        "windows-minted-after-job-proof"
    );
    assert!(
        resumed_tree_dead,
        "the rejected resume's exact job, including descendants, is confirmed dead"
    );
    assert!(replacement_live);
    assert_eq!(
        launches, 3,
        "original, one failed resume, and one replacement"
    );
}

#[tokio::test]
async fn an_unconfirmed_tree_does_not_authorize_replacement() {
    run_case(Some(json!({"code":-32600,"message":"no rollout found for thread id thread-recovery-source"})), true, false).await;
}

#[tokio::test]
async fn cancelling_an_in_flight_resume_keeps_the_prior_tree_fenced() {
    run_case(Some(json!({"code":-32600,"message":"no rollout found for thread id thread-recovery-source"})), true, true).await;
}

#[tokio::test]
async fn unexpected_exit_recovers_after_the_old_tree_is_confirmed_gone() {
    run_unexpected_exit(false, HelperChurn::None).await;
}

#[tokio::test]
async fn unexpected_exit_with_unconfirmed_cleanup_fences_recovery() {
    run_unexpected_exit(true, HelperChurn::None).await;
}

#[tokio::test]
async fn recovery_succeeds_after_short_lived_helper_churn() {
    run_unexpected_exit(false, HelperChurn::Synchronized).await;
}

#[tokio::test]
async fn recovery_succeeds_after_immediately_exiting_helper_churn() {
    run_unexpected_exit(false, HelperChurn::Immediate).await;
}

#[tokio::test]
async fn handoff_confirms_the_old_tree_before_proceeding() {
    run_handoff(false, false).await;
}

#[tokio::test]
async fn handoff_with_unconfirmed_cleanup_keeps_recovery_fenced() {
    run_handoff(true, false).await;
}

#[tokio::test]
async fn confirmed_prior_does_not_adopt_a_stale_binding() {
    run_handoff(true, true).await;
}

#[tokio::test]
async fn an_ambiguous_resume_failure_does_not_authorize_replacement() {
    run_case(
        Some(json!({"code":-32600,"message":"temporary provider failure"})),
        false,
        false,
    )
    .await;
}

#[tokio::test]
async fn successful_resume_keeps_the_tree_until_shutdown() {
    run_case(None, false, false).await;
}

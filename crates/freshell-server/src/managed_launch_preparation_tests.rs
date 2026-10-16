use super::*;
use crate::managed_runtime::ServerManagedRuntimeController;
use freshell_runtime_protocol::RuntimeError;
use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot, Notify};

struct LaunchHarness {
    root: tempfile::TempDir,
    proxy: Arc<HostedFreshAgentProxy>,
    terminal: Arc<ServerManagedRuntimeController>,
    launches: Arc<AtomicUsize>,
    observed: mpsc::UnboundedReceiver<()>,
    settled: mpsc::UnboundedReceiver<()>,
    release: Arc<Notify>,
    stop: oneshot::Sender<()>,
    server: tokio::task::JoinHandle<()>,
}

impl LaunchHarness {
    async fn new(hold_launch: bool, accept_launch: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("supervisor.sock");
        let secret = root.path().join("control-secret");
        std::fs::write(&secret, "0123456789abcdef").unwrap();
        crate::managed_mcp_capability::configure("0.0.0.0", 39480, &socket, &secret).unwrap();
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        std::fs::create_dir_all(home.join(".config/opencode/plugins")).unwrap();
        std::fs::write(home.join(".config/opencode/opencode.json"), "{}").unwrap();
        std::fs::write(
            home.join(".config/opencode/plugins/owned.js"),
            "export default async () => ({})",
        )
        .unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let (stop, mut stopped) = oneshot::channel();
        let (send_observed, observed) = mpsc::unbounded_channel();
        let (send_settled, settled) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let released = release.clone();
        let launches = Arc::new(AtomicUsize::new(0));
        let calls = launches.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                assert_eq!(request.role, ControlRole::Web);
                assert_eq!(request.auth.as_deref(), Some("0123456789abcdef"));
                let result = match request.body {
                    AdminCommand::Health => Ok(AdminResult::Health {
                        control_epoch: 77,
                        installation_id: InstallationId::new(),
                    }),
                    AdminCommand::Inventory => Ok(AdminResult::Inventory(vec![])),
                    AdminCommand::Launch(launch) => {
                        calls.fetch_add(1, Ordering::SeqCst);
                        send_observed.send(()).unwrap();
                        if hold_launch {
                            tokio::select! {
                                _ = &mut stopped => break,
                                _ = released.notified() => {},
                            }
                        }
                        if accept_launch {
                            Ok(AdminResult::Launch(serde_json::from_value(serde_json::json!({
                                "view": {
                                    "soulId":launch.soul_id, "incarnationId":"accepted-incarnation",
                                    "launchState":"running", "cleanupState":"none",
                                    "intentRevision":1, "executionGeneration":1,
                                    "provider":launch.provider,
                                },
                                "workerPid":42, "workerLaunchCount":1,
                                "hostBootId":"accepted-boot", "effectiveLimits":launch.limits,
                            })).unwrap()))
                        } else {
                            Err(RuntimeError::new(
                                RuntimeErrorCode::BackendUnavailable,
                                "owned launch rejection without a provider process",
                            ))
                        }
                    }
                    other => panic!("unexpected preparation request {other:?}"),
                };
                let _ = write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result,
                    },
                )
                .await;
                // EOF means RuntimeClient consumed the reply and released its
                // connection; on this current-thread test runtime its result
                // handling has run before we observe settlement.
                let mut tail = Vec::new();
                stream.read_to_end(&mut tail).await.unwrap();
                send_settled.send(()).unwrap();
            }
        });
        std::env::set_var("FRESHELL_MANAGED_RUNTIME_V1", "1");
        std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
        std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret);
        let terminal = ServerManagedRuntimeController::from_env()
            .await
            .unwrap()
            .unwrap();
        let mut proxy = snapshot_outage_proxy(&socket);
        Arc::get_mut(&mut proxy)
            .unwrap()
            .fixture_modes
            .insert("freshopencode".into());
        Self {
            root,
            proxy,
            terminal,
            launches,
            observed,
            settled,
            release,
            stop,
            server,
        }
    }

    async fn close(self) {
        self.stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), self.server)
            .await
            .unwrap()
            .unwrap();
    }

    async fn wait_for_settlement(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), self.settled.recv())
            .await
            .unwrap()
            .unwrap();
    }
}

async fn attempt_launch(
    proxy: &Arc<HostedFreshAgentProxy>,
    terminal: &ServerManagedRuntimeController,
    boundary: &str,
    cwd: &Path,
    request_id: &str,
) -> bool {
    if boundary == "fresh" {
        proxy
            .create(
                serde_json::from_value(serde_json::json!({
                    "requestId":request_id, "provider":"opencode",
                    "sessionType":"freshopencode", "cwd":cwd,
                }))
                .unwrap(),
            )
            .await
            .is_err()
    } else {
        terminal
            .launch(ManagedTerminalLaunch {
                spec: freshell_platform::spawn::SpawnSpec {
                    program: "opencode".into(),
                    args: vec![],
                    env_overrides: Default::default(),
                    cwd: Some(cwd.to_string_lossy().into_owned()),
                    cols: 80,
                    rows: 24,
                },
                env: Default::default(),
                terminal_id: format!("terminal-{request_id}"),
                stream_id: format!("stream-{request_id}"),
                mode: "opencode".into(),
                resume_session_id: None,
                provider_model: None,
                provider_reasoning_effort: None,
                provider_sandbox: None,
                provider_permission_mode: None,
                view_tab_id: None,
                view_pane_id: None,
                create_request_id: Some(request_id.into()),
            })
            .await
            .is_err()
    }
}

fn resources() -> (usize, usize, usize) {
    let grants = PathBuf::from(std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR").unwrap());
    let stages = grants.parent().unwrap().join("provider-roots");
    let entries = |path: &Path| match std::fs::read_dir(path) {
        Ok(entries) => entries.fold(0, |count, entry| {
            entry.unwrap();
            count + 1
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => panic!("cannot inspect owned launch resources: {error}"),
    };
    (
        crate::managed_mcp_capability::grant_count_for_test(),
        entries(&grants),
        entries(&stages),
    )
}

async fn repeated_preparation_refusals(boundary: &str) {
    let harness = LaunchHarness::new(false, false).await;
    let mut observations = Vec::new();
    for fault in ["dangling", "directory", "outside"] {
        let workspace = harness.root.path().join(fault);
        std::fs::create_dir(&workspace).unwrap();
        let selected = workspace.join("opencode.json");
        match fault {
            "dangling" => std::os::unix::fs::symlink("missing.json", selected).unwrap(),
            "directory" => std::fs::create_dir(selected).unwrap(),
            "outside" => {
                let outside = harness.root.path().join("outside.json");
                std::fs::write(&outside, "{\"apiKey\":\"owned-private-sentinel\"}").unwrap();
                std::os::unix::fs::symlink(outside, selected).unwrap();
            }
            _ => unreachable!(),
        }
        for retry in 0..3 {
            let failed = attempt_launch(
                &harness.proxy,
                &harness.terminal,
                boundary,
                &workspace,
                &format!("preparation-{fault}-{retry}"),
            )
            .await;
            observations.push((fault, retry, failed, resources()));
        }
    }
    let launches = harness.launches.load(Ordering::SeqCst);
    harness.close().await;
    assert_eq!(launches, 0, "configuration refusal must precede Launch");
    for (fault, retry, failed, resources) in observations {
        assert!(failed, "{boundary} {fault} retry {retry}");
        assert_eq!(resources, (0, 0, 0), "{boundary} {fault} retry {retry}");
    }
}

async fn cancelled_launch(boundary: &str, accepted: bool) {
    let mut harness = LaunchHarness::new(true, accepted).await;
    // Drain the constructor's Health reply before waiting for Launch.
    harness.wait_for_settlement().await;
    let mut launch = Box::pin(attempt_launch(
        &harness.proxy,
        &harness.terminal,
        boundary,
        harness.root.path(),
        "cancelled-preparation",
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            observed = harness.observed.recv() => observed.unwrap(),
            result = &mut launch => panic!("launch returned before cancellation: {result}"),
        }
    })
    .await
    .unwrap();
    let pending = resources();
    drop(launch);
    harness.release.notify_one();
    // The fresh client reads Health before dispatch; the terminal client
    // reads Inventory. The second settlement is the held Launch result.
    harness.wait_for_settlement().await;
    harness.wait_for_settlement().await;
    let settled = resources();
    if accepted {
        let grants = PathBuf::from(std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR").unwrap());
        let grant = std::fs::read_dir(&grants)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let grant_id = grant.file_stem().unwrap().to_str().unwrap();
        crate::managed_mcp_capability::revoke_mcp_capability(grant_id).unwrap();
    }
    harness.close().await;
    assert_eq!(
        pending,
        (1, 1, 1),
        "the real Launch path must allocate resources"
    );
    let expected = if accepted { (1, 1, 1) } else { (0, 0, 0) };
    assert_eq!(
        settled, expected,
        "{boundary} cancelled launch accepted={accepted}"
    );
}

async fn cancelled_rejected_launch(boundary: &str) {
    cancelled_launch(boundary, false).await;
}

async fn cancelled_accepted_launch(boundary: &str) {
    cancelled_launch(boundary, true).await;
}

macro_rules! isolated_launch_test {
    ($name:ident, $body:ident, $boundary:literal) => {
        #[tokio::test]
        async fn $name() {
            if !create_failure_trace_child(
                stringify!($name),
                concat!(
                    "fresh_agent_proxy::tests::launch_preparation::",
                    stringify!($name)
                ),
            ) {
                $body($boundary).await;
            }
        }
    };
}

isolated_launch_test!(
    fresh_opencode_preparation_refusal_cleanup,
    repeated_preparation_refusals,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_preparation_refusal_cleanup,
    repeated_preparation_refusals,
    "terminal"
);
isolated_launch_test!(
    fresh_opencode_cancelled_launch_cleanup,
    cancelled_rejected_launch,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_cancelled_launch_cleanup,
    cancelled_rejected_launch,
    "terminal"
);
isolated_launch_test!(
    fresh_opencode_cancelled_accepted_launch_retains_capability,
    cancelled_accepted_launch,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_cancelled_accepted_launch_retains_capability,
    cancelled_accepted_launch,
    "terminal"
);

#[tokio::test]
async fn fresh_opencode_discovery_diagnostics_identify_resources_without_contents() {
    if create_failure_trace_child(
        "discovery-diagnostics",
        "fresh_agent_proxy::tests::launch_preparation::fresh_opencode_discovery_diagnostics_identify_resources_without_contents",
    ) {
        return;
    }
    let events = crate::test_trace_capture::captured_trace_events();
    let workspace = tempfile::tempdir().unwrap();
    let mut unavailable_proxy = snapshot_outage_proxy(&workspace.path().join("unopened.sock"));
    Arc::get_mut(&mut unavailable_proxy)
        .unwrap()
        .fixture_modes
        .insert("freshopencode".into());
    let create = |request_id: &str, cwd: &Path| {
        serde_json::from_value(serde_json::json!({
            "requestId":request_id, "provider":"opencode",
            "sessionType":"freshopencode", "cwd":cwd,
        }))
        .unwrap()
    };
    assert!(unavailable_proxy
        .create(create("capability-service-unconfigured", workspace.path()))
        .await
        .is_err());
    let before_discovery = events.snapshot();
    assert!(before_discovery.iter().any(|event| {
        event.fields.get("reason").map(String::as_str) == Some("capability_unavailable")
    }));
    assert!(!before_discovery.iter().any(|event| {
        event.fields.get("event").map(String::as_str)
            == Some("provider.environment.discovery.failed")
    }));

    let harness = LaunchHarness::new(false, false).await;
    let project = harness.root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let outside = harness.root.path().join("outside.json");
    std::fs::write(&outside, "{\"apiKey\":\"owned-private-sentinel\"}").unwrap();
    std::os::unix::fs::symlink(&outside, project.join("opencode.json")).unwrap();
    assert!(harness
        .proxy
        .create(create("project-link-refusal", &project))
        .await
        .is_err());

    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let selected = home.join(".config/opencode/opencode.json");
    assert_eq!(std::fs::read_to_string(&selected).unwrap(), "{}");
    std::fs::remove_file(&selected).unwrap();
    std::os::unix::fs::symlink("missing-private-resource.json", &selected).unwrap();
    assert!(harness
        .proxy
        .create(create("user-link-refusal", workspace.path()))
        .await
        .is_err());
    let launches = harness.launches.load(Ordering::SeqCst);
    harness.close().await;

    assert_eq!(launches, 0);
    let captured = events.snapshot();
    let discovery = captured
        .iter()
        .filter(|event| {
            event.fields.get("event").map(String::as_str)
                == Some("provider.environment.discovery.failed")
        })
        .collect::<Vec<_>>();
    for (resource_root, cause) in [
        ("workspace", "outside_workspace"),
        ("user_provider", "NotFound"),
    ] {
        let diagnostic = discovery
            .iter()
            .find(|event| {
                event.fields.get("resource_root").map(String::as_str) == Some(resource_root)
                    && event.fields.get("relative_path").map(String::as_str)
                        == Some("opencode.json")
                    && event.fields.get("cause").map(String::as_str) == Some(cause)
            })
            .unwrap_or_else(|| panic!("missing {resource_root}/{cause} diagnostic: {captured:?}"));
        assert_eq!(diagnostic.level, tracing::Level::WARN);
        assert!(!diagnostic
            .fields
            .get("corrective_message")
            .unwrap()
            .is_empty());
    }
    let serialized = format!("{captured:?}");
    assert!(!serialized.contains("owned-private-sentinel"));
    assert!(!serialized.contains(outside.to_str().unwrap()));
    assert!(!serialized.contains("missing-private-resource.json"));
}

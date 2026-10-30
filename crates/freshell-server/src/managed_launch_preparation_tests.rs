use super::*;
use crate::managed_runtime::ServerManagedRuntimeController;
use freshell_runtime_protocol::{
    DockerDaemonId, InitialAuthVolumeObservation, NativeAuthValues, ProviderInputReservation,
    RuntimeError,
};
use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot, Notify};

#[derive(Clone, Copy, Debug)]
enum LaunchReply {
    Accepted,
    Unavailable,
    Disconnected,
}

#[derive(Debug, PartialEq, Eq)]
enum StageEntry {
    Directory,
    File(Vec<u8>),
    Symlink(PathBuf),
}

#[derive(Debug, PartialEq, Eq)]
struct PreparedLaunchResources {
    grant_id: String,
    grant_bytes: Vec<u8>,
    stage: BTreeMap<PathBuf, StageEntry>,
}

fn stage_entries(root: &Path) -> BTreeMap<PathBuf, StageEntry> {
    fn visit(root: &Path, directory: &Path, entries: &mut BTreeMap<PathBuf, StageEntry>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_symlink() {
                entries.insert(
                    relative,
                    StageEntry::Symlink(std::fs::read_link(path).unwrap()),
                );
            } else if metadata.is_dir() {
                entries.insert(relative, StageEntry::Directory);
                visit(root, &path, entries);
            } else {
                assert!(metadata.is_file(), "unexpected owned stage entry: {path:?}");
                entries.insert(relative, StageEntry::File(std::fs::read(path).unwrap()));
            }
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

fn prepared_resources(grant_id: &str) -> PreparedLaunchResources {
    let grants = PathBuf::from(std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR").unwrap());
    let stage = grants
        .parent()
        .unwrap()
        .join("provider-roots")
        .join(grant_id);
    PreparedLaunchResources {
        grant_id: grant_id.into(),
        grant_bytes: std::fs::read(grants.join(format!("{grant_id}.json"))).unwrap(),
        stage: stage_entries(&stage),
    }
}

struct LaunchHarness {
    root: tempfile::TempDir,
    proxy: Arc<HostedFreshAgentProxy>,
    terminal: Arc<ServerManagedRuntimeController>,
    launches: Arc<AtomicUsize>,
    reservations: Arc<AtomicUsize>,
    observed: mpsc::UnboundedReceiver<PreparedLaunchResources>,
    settled: mpsc::UnboundedReceiver<()>,
    release: Arc<Notify>,
    stop: oneshot::Sender<()>,
    server: tokio::task::JoinHandle<()>,
}

impl LaunchHarness {
    async fn new(hold_launch: bool, reply: LaunchReply) -> Self {
        Self::with_capability_service(hold_launch, reply, true).await
    }

    async fn with_capability_service(
        hold_launch: bool,
        reply: LaunchReply,
        configure_capability: bool,
    ) -> Self {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("supervisor.sock");
        let secret = root.path().join("control-secret");
        std::fs::write(&secret, "0123456789abcdef").unwrap();
        if configure_capability {
            crate::managed_mcp_capability::configure("0.0.0.0", 39480, &socket, &secret).unwrap();
        }
        // These tests run in their existing isolated child process. Select
        // only its owned fixture, not a developer's optional native selectors.
        for name in [
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_TUI_CONFIG",
        ] {
            std::env::remove_var(name);
        }
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        std::fs::create_dir_all(home.join(".config/opencode/plugins")).unwrap();
        std::fs::write(home.join(".config/opencode/opencode.json"), "{}").unwrap();
        std::fs::write(
            home.join(".config/opencode/plugins/owned.js"),
            "export default async () => ({})",
        )
        .unwrap();
        let selected_plugin = home.join(".config/opencode/plugins/owned.js");
        let listener = UnixListener::bind(&socket).unwrap();
        let (stop, mut stopped) = oneshot::channel();
        let (send_observed, observed) = mpsc::unbounded_channel();
        let (send_settled, settled) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let released = release.clone();
        let launches = Arc::new(AtomicUsize::new(0));
        let calls = launches.clone();
        let reservations = Arc::new(AtomicUsize::new(0));
        let reservation_calls = reservations.clone();
        let server = tokio::spawn(async move {
            let installation = InstallationId::parse("launch-custody-installation").unwrap();
            let mut authorities = BTreeMap::new();
            loop {
                let (mut stream, _) = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                assert_eq!(request.role, ControlRole::Web);
                assert_eq!(request.auth.as_deref(), Some("0123456789abcdef"));
                let mut launch_reply = false;
                let result = match request.body {
                    AdminCommand::Health => Ok(AdminResult::Health {
                        control_epoch: 77,
                        installation_id: installation.clone(),
                    }),
                    AdminCommand::Inventory => Ok(AdminResult::Inventory(vec![])),
                    AdminCommand::ReserveProviderInputs(reservation) => {
                        assert_eq!(reservation.expected_control_epoch, Some(77));
                        assert_eq!(reservation.provider, "opencode");
                        assert!(!reservation.creation_seed_ref.is_empty());
                        reservation_calls.fetch_add(1, Ordering::SeqCst);
                        if reservation
                            .creation_seed_ref
                            .starts_with("preparation-late-resource-")
                        {
                            // The caller already selected its sources. Make
                            // this child's selected resource fail during real
                            // publication, before any Launch can be sent.
                            std::fs::remove_file(&selected_plugin).unwrap();
                            std::os::unix::fs::symlink("missing-owned-plugin.js", &selected_plugin)
                                .unwrap();
                        }
                        let id = uuid::Uuid::new_v4().to_string();
                        authorities.insert(reservation.soul_id.clone(), id.clone());
                        Ok(AdminResult::ProviderInputReservation(
                            ProviderInputReservation {
                                reservation_id: id,
                                installation_id: installation.clone(),
                                soul_id: reservation.soul_id,
                                provider: reservation.provider,
                                creation_seed_ref: reservation.creation_seed_ref,
                                intent_revision: 1,
                                provider_volume_name: "owned-launch-volume".into(),
                                image_ref: "owned-launch-image".into(),
                                host_binary_path: "/owned/fixture/session-host".into(),
                                host_binary_sha256: "a".repeat(64),
                                observation: InitialAuthVolumeObservation::Absent {
                                    daemon_id: DockerDaemonId::parse("owned-launch-daemon")
                                        .unwrap(),
                                },
                            },
                        ))
                    }
                    AdminCommand::NativeAuthLookup(lookup) => {
                        assert_eq!(lookup.expected_control_epoch, Some(77));
                        assert_eq!(
                            authorities.get(&lookup.soul_id),
                            Some(&lookup.attempt_authority)
                        );
                        // Owned fixtures have no native credentials. Selected
                        // ambient path inputs remain the real preparer's job.
                        Ok(AdminResult::NativeAuthLookup(NativeAuthValues(
                            BTreeMap::new(),
                        )))
                    }
                    AdminCommand::BindProviderPathInputs(binding) => {
                        assert_eq!(binding.expected_control_epoch, Some(77));
                        assert!(authorities.contains_key(&binding.soul_id));
                        let prepared = prepared_resources(&binding.generation_id);
                        assert!(!prepared.stage.is_empty());
                        Ok(AdminResult::ProviderPathInputsBound)
                    }
                    AdminCommand::Launch(launch) => {
                        launch_reply = true;
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(launch.expected_control_epoch, Some(77));
                        assert!(authorities.contains_key(&launch.soul_id));
                        let context = launch
                            .terminal
                            .as_ref()
                            .and_then(|value| value.provider_launch_context.as_ref())
                            .or_else(|| {
                                launch
                                    .fresh_agent
                                    .as_ref()
                                    .and_then(|value| value.provider_launch_context.as_ref())
                            })
                            .expect("actual caller must supply selected provider context");
                        assert!(
                            context.prepared_inputs.is_some(),
                            "must exercise main prepared-context route"
                        );
                        let capability = context.mcp_capability.as_ref().unwrap();
                        let prepared = prepared_resources(&capability.grant_id);
                        let StageEntry::File(stored_context) = prepared
                            .stage
                            .get(Path::new(".freshell/prepared-context.json"))
                            .expect("prepared metadata must be durably staged")
                        else {
                            panic!("prepared context must be a physical file");
                        };
                        assert_eq!(
                            serde_json::from_slice::<serde_json::Value>(stored_context).unwrap(),
                            serde_json::to_value(context).unwrap()
                        );
                        assert!(prepared
                            .stage
                            .contains_key(Path::new(".freshell/input-manifest.json")));
                        send_observed.send(prepared).unwrap();
                        if hold_launch {
                            tokio::select! {
                                _ = &mut stopped => break,
                                _ = released.notified() => {},
                            }
                        }
                        match reply {
                            LaunchReply::Accepted => Ok(AdminResult::Launch(serde_json::from_value(serde_json::json!({
                                "view": {
                                    "soulId":launch.soul_id, "incarnationId":"accepted-incarnation",
                                    "launchState":"running", "cleanupState":"none",
                                    "intentRevision":1, "executionGeneration":1,
                                    "provider":launch.provider,
                                },
                                "workerPid":42, "workerLaunchCount":1,
                                "hostBootId":"accepted-boot", "effectiveLimits":launch.limits,
                            })).unwrap())),
                            LaunchReply::Unavailable => Err(RuntimeError::new(
                                RuntimeErrorCode::BackendUnavailable,
                                "launch handling began but its dispatch outcome is unconfirmed",
                            )),
                            LaunchReply::Disconnected => {
                                // The complete Launch request was received;
                                // losing its reply does not establish rejection.
                                drop(stream);
                                send_settled.send(()).unwrap();
                                continue;
                            }
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
                let mut tail = Vec::new();
                // A cancelled request may reset the socket. Either EOF or a
                // reset settles this one owned reply; neither proves nondispatch.
                let _ = stream.read_to_end(&mut tail).await;
                if launch_reply {
                    send_settled.send(()).unwrap();
                }
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
            reservations,
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
    let trace = crate::test_trace_capture::captured_trace_events();
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
            .inspect_err(|error| {
                eprintln!(
                    "owned {boundary} launch returned: {error:?}; events={:?}",
                    trace.snapshot()
                )
            })
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
            .inspect_err(|error| {
                eprintln!(
                    "owned {boundary} launch returned: {error:?}; events={:?}",
                    trace.snapshot()
                )
            })
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
    let harness = LaunchHarness::new(false, LaunchReply::Unavailable).await;
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

async fn repeated_late_source_refusals(boundary: &str) {
    let harness = LaunchHarness::new(false, LaunchReply::Unavailable).await;
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let selected = home.join(".config/opencode/plugins/owned.js");
    let mut observations = Vec::new();
    for retry in 0..3 {
        std::fs::remove_file(&selected).unwrap();
        std::fs::write(&selected, "export default async () => ({})").unwrap();
        let failed = attempt_launch(
            &harness.proxy,
            &harness.terminal,
            boundary,
            harness.root.path(),
            &format!("preparation-late-resource-{retry}"),
        )
        .await;
        observations.push((failed, resources()));
    }
    let launches = harness.launches.load(Ordering::SeqCst);
    let reservations = harness.reservations.load(Ordering::SeqCst);
    harness.close().await;
    assert_eq!(
        reservations, 3,
        "each local failure must reach real prepared-input authority"
    );
    assert_eq!(
        launches, 0,
        "source publication failure must precede dispatch"
    );
    for (retry, (failed, remaining)) in observations.into_iter().enumerate() {
        assert!(failed, "{boundary} late source retry {retry}");
        assert_eq!(
            remaining,
            (0, 0, 0),
            "failed selected resource must leave no grant or stage"
        );
    }
}

async fn cancelled_launch(boundary: &str, reply: LaunchReply) {
    let mut harness = LaunchHarness::new(true, reply).await;
    let mut launch = Box::pin(attempt_launch(
        &harness.proxy,
        &harness.terminal,
        boundary,
        harness.root.path(),
        "cancelled-preparation",
    ));
    let prepared = tokio::time::timeout(Duration::from_secs(5), async {
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
    // Count only the held Launch, independent of preparer authority traffic.
    harness.wait_for_settlement().await;
    let retained = prepared_resources(&prepared.grant_id);
    let settled = resources();
    let launches = harness.launches.load(Ordering::SeqCst);
    let reservations = harness.reservations.load(Ordering::SeqCst);
    crate::managed_mcp_capability::revoke_mcp_capability(&prepared.grant_id).unwrap();
    assert_eq!(
        resources(),
        (0, 0, 0),
        "fixture cleanup must remove its exact grant"
    );
    harness.close().await;
    assert_eq!(
        pending,
        (1, 1, 1),
        "the actual prepared Launch must allocate resources"
    );
    assert_eq!(
        settled, pending,
        "{boundary} cancelled launch reply={reply:?}"
    );
    assert_eq!(
        retained, prepared,
        "cancelled dispatch must retain exact approved input bytes"
    );
    assert_eq!(launches, 1);
    assert_eq!(reservations, 1);
}

async fn cancelled_uncertain_launch(boundary: &str) {
    cancelled_launch(boundary, LaunchReply::Unavailable).await;
}

async fn cancelled_accepted_launch(boundary: &str) {
    cancelled_launch(boundary, LaunchReply::Accepted).await;
}

async fn uncertain_launch_reply(boundary: &str, reply: LaunchReply) {
    let mut harness = LaunchHarness::new(false, reply).await;
    let failed = attempt_launch(
        &harness.proxy,
        &harness.terminal,
        boundary,
        harness.root.path(),
        "uncertain-reply",
    )
    .await;
    let prepared = tokio::time::timeout(Duration::from_secs(5), harness.observed.recv())
        .await
        .unwrap()
        .unwrap();
    harness.wait_for_settlement().await;
    let retained = prepared_resources(&prepared.grant_id);
    let settled = resources();
    let launches = harness.launches.load(Ordering::SeqCst);
    let reservations = harness.reservations.load(Ordering::SeqCst);
    crate::managed_mcp_capability::revoke_mcp_capability(&prepared.grant_id).unwrap();
    assert_eq!(resources(), (0, 0, 0));
    harness.close().await;
    assert!(failed, "the real caller must surface the unavailable reply");
    assert_eq!(settled, (1, 1, 1), "{boundary} uncertain reply={reply:?}");
    assert_eq!(
        retained, prepared,
        "an unconfirmed reply cannot revoke selected input bytes"
    );
    assert_eq!(
        launches, 1,
        "uncertainty must not replan/re-dispatch the creation"
    );
    assert_eq!(reservations, 1);
}

async fn unavailable_launch_reply(boundary: &str) {
    uncertain_launch_reply(boundary, LaunchReply::Unavailable).await;
}

async fn disconnected_launch_reply(boundary: &str) {
    uncertain_launch_reply(boundary, LaunchReply::Disconnected).await;
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
    fresh_opencode_cancelled_uncertain_launch_retains_capability,
    cancelled_uncertain_launch,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_cancelled_uncertain_launch_retains_capability,
    cancelled_uncertain_launch,
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

isolated_launch_test!(
    fresh_opencode_late_source_refusal_cleanup,
    repeated_late_source_refusals,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_late_source_refusal_cleanup,
    repeated_late_source_refusals,
    "terminal"
);
isolated_launch_test!(
    fresh_opencode_unavailable_launch_reply_retains_capability,
    unavailable_launch_reply,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_unavailable_launch_reply_retains_capability,
    unavailable_launch_reply,
    "terminal"
);
isolated_launch_test!(
    fresh_opencode_disconnected_launch_reply_retains_capability,
    disconnected_launch_reply,
    "fresh"
);
isolated_launch_test!(
    terminal_opencode_disconnected_launch_reply_retains_capability,
    disconnected_launch_reply,
    "terminal"
);

async fn assert_unconfigured_capability_diagnostic(workspace: &Path) {
    let events = crate::test_trace_capture::captured_trace_events();
    // Prepared launch first obtains creation authority. Supply that real
    // protocol exchange while leaving the MCP publisher unconfigured.
    let harness =
        LaunchHarness::with_capability_service(false, LaunchReply::Unavailable, false).await;
    assert!(harness
        .proxy
        .create(
            serde_json::from_value(serde_json::json!({
                "requestId":"capability-service-unconfigured", "provider":"opencode",
                "sessionType":"freshopencode", "cwd":workspace,
            }))
            .unwrap()
        )
        .await
        .is_err());
    assert_eq!(harness.reservations.load(Ordering::SeqCst), 1);
    assert_eq!(harness.launches.load(Ordering::SeqCst), 0);
    assert_eq!(resources(), (0, 0, 0));
    harness.close().await;
    let before_discovery = events.snapshot();
    assert!(
        before_discovery.iter().any(|event| {
            event.fields.get("event").map(String::as_str)
                == Some("fresh_agent.create.provider_inputs_failed")
                && event.fields.get("error").is_some_and(|message| {
                    message.contains("managed MCP controller is unconfigured")
                })
        }),
        "prepared capability failure must identify the unavailable publisher: {before_discovery:?}"
    );
    assert!(!before_discovery.iter().any(|event| {
        event.fields.get("event").map(String::as_str)
            == Some("provider.environment.discovery.failed")
    }));
}

async fn provider_root_discovery_diagnostics(fault: &str) {
    use std::os::unix::fs::PermissionsExt;

    let events = crate::test_trace_capture::captured_trace_events();
    let workspace = tempfile::tempdir().unwrap();
    assert_unconfigured_capability_diagnostic(workspace.path()).await;
    let harness = LaunchHarness::new(false, LaunchReply::Unavailable).await;
    assert_eq!(resources(), (0, 0, 0));
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let provider_root = home.join(".config/opencode");
    // Keep the healthy fixture intact, and break only this child's owned root.
    let private_root = home.join("private-provider-root");
    std::fs::rename(&provider_root, &private_root).unwrap();
    let private_target = home.join("private-missing-provider-root");
    let cause = match fault {
        "dangling" => {
            std::os::unix::fs::symlink(&private_target, &provider_root).unwrap();
            "NotFound"
        }
        "file" => {
            std::fs::write(
                &provider_root,
                "{\"apiKey\":\"owned-private-root-sentinel\"}",
            )
            .unwrap();
            "NotADirectory"
        }
        "unreadable" => {
            std::fs::create_dir(&provider_root).unwrap();
            std::fs::set_permissions(&provider_root, std::fs::Permissions::from_mode(0o0)).unwrap();
            "PermissionDenied"
        }
        _ => unreachable!(),
    };
    let refused = attempt_launch(
        &harness.proxy,
        &harness.terminal,
        "fresh",
        workspace.path(),
        &format!("provider-root-{fault}"),
    )
    .await;
    if fault == "unreadable" {
        std::fs::set_permissions(&provider_root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let remaining_resources = resources();
    let launches = harness.launches.load(Ordering::SeqCst);
    harness.close().await;
    assert!(
        refused,
        "broken provider root must refuse FreshOpenCode create"
    );
    assert_eq!(launches, 0, "root discovery refusal must precede Launch");
    assert_eq!(remaining_resources, (0, 0, 0));

    let captured = events.snapshot();
    let diagnostic = captured
        .iter()
        .find(|event| {
            event.fields.get("event").map(String::as_str)
                == Some("provider.environment.discovery.failed")
                && event.fields.get("resource_root").map(String::as_str) == Some("user_provider")
                && event.fields.get("relative_path").map(String::as_str) == Some(".")
                && event.fields.get("cause").map(String::as_str) == Some(cause)
        })
        .unwrap_or_else(|| {
            panic!("missing provider-root {fault}/{cause} diagnostic: {captured:?}")
        });
    assert_eq!(diagnostic.level, tracing::Level::WARN);
    let corrective = diagnostic.fields.get("corrective_message").unwrap();
    assert!(corrective.contains("provider root"), "{corrective}");
    assert!(corrective.contains("retry"), "{corrective}");
    let serialized = format!("{captured:?}");
    for private in [
        "owned-private-root-sentinel",
        "private-missing-provider-root",
        private_target.to_str().unwrap(),
        private_root.to_str().unwrap(),
        provider_root.to_str().unwrap(),
    ] {
        assert!(
            !serialized.contains(private),
            "diagnostic disclosed {private}"
        );
    }
}

isolated_launch_test!(
    fresh_opencode_provider_root_dangling_diagnostics,
    provider_root_discovery_diagnostics,
    "dangling"
);
isolated_launch_test!(
    fresh_opencode_provider_root_file_diagnostics,
    provider_root_discovery_diagnostics,
    "file"
);
isolated_launch_test!(
    fresh_opencode_provider_root_unreadable_diagnostics,
    provider_root_discovery_diagnostics,
    "unreadable"
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
    assert_unconfigured_capability_diagnostic(workspace.path()).await;
    let create = |request_id: &str, cwd: &Path| {
        serde_json::from_value(serde_json::json!({
            "requestId":request_id, "provider":"opencode",
            "sessionType":"freshopencode", "cwd":cwd,
        }))
        .unwrap()
    };
    let harness = LaunchHarness::new(false, LaunchReply::Unavailable).await;
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

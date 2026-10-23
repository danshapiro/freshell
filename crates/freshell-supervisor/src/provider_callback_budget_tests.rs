//! How long the supervisor waits for a provider-preparation callback to the
//! web server, and how long the recovery scope that callback carries lives.

use super::*;
use crate::registry::*;
use freshell_runtime_protocol::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct RecoveryFixture {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    soul: SoulId,
    start: RecoveryStart,
    context: ProviderLaunchContext,
}

/// A retained Claude terminal with one accepted prepared-input generation,
/// and a recovery attempt that begins from it.
async fn claude_recovery(budgets: ProviderCallbackBudgets) -> RecoveryFixture {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("host");
    std::fs::write(&binary, b"synthetic helper artifact").unwrap();
    let registry = Registry::open(root.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let generation = format!("grant-{}", uuid::Uuid::new_v4());
    let context: ProviderLaunchContext = serde_json::from_value(serde_json::json!({
        "preparation":{"claude":{"mcp_args":[]}},"config":[],
        "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
        "preparedInputs":{"generationId":generation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":0,"aliasCount":0,"recipeCount":0}}
    }))
    .unwrap();
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"callback-budget","streamId":"callback-budget-stream","mode":"claude","program":"claude","args":[],
        "cwd":root.path(),"workspacePath":root.path(),"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,
        "projectKey":"callback-budget-workspace","providerLaunchContext":&context
    }))
    .unwrap();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "claude".into(),
            provider_store_id: "synthetic-store".into(),
            native_session_id: None,
            creation_seed_ref: "synthetic-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "synthetic-digest".into(),
            requested_limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 64 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            profile: RuntimeProfile::Custom,
            project_key: "callback-budget-workspace".into(),
            fixture: None,
            terminal: Some(terminal),
            fresh_agent: None,
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let image = format!("sha256:{}", "a".repeat(64));
    registry
        .commit_created(
            prepared.incarnation_id,
            BackendCreatedRecord {
                daemon_id: DockerDaemonId::new(),
                container_id: "callback-budget-container".into(),
                image_ref: image.clone(),
                runtime_dir: root.path().into(),
                host_binary_path: binary.clone(),
                immutable_config_digest: "synthetic-digest".into(),
            },
        )
        .await
        .unwrap();
    let start = registry
        .begin_recovery(
            soul.clone(),
            RecoveryTrigger::ManualRetry,
            RecoveryPath::NativeResume,
        )
        .await
        .unwrap();
    let mut supervisor = Supervisor::new(
        registry,
        default_backend(root.path().join("absent-docker.sock")),
        SupervisorConfig {
            runtime_root: root.path().join("runtime"),
            control_socket_path: root.path().join("control.sock"),
            host_binary_path: binary,
            image_ref: image,
            test_run_id: "provider-callback-budget".into(),
            control_secret: "synthetic-control-secret".into(),
            lifecycle_log: root.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    supervisor.provider_callback_budgets = budgets;
    RecoveryFixture {
        _root: root,
        supervisor,
        soul,
        start,
        context,
    }
}

/// A synthetic web server callback socket: it reads one callback, holds it
/// for `delay`, runs `inspect` on the request and the instant it arrived,
/// then answers `reply`.
fn slow_callback_server(
    supervisor: &Supervisor,
    delay: Duration,
    reply: &'static [u8],
    inspect: impl FnOnce(&serde_json::Value, Instant) + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let listener = tokio::net::UnixListener::bind(
        supervisor
            .config
            .control_socket_path
            .with_file_name("mcp.sock"),
    )
    .unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let received = Instant::now();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        tokio::time::sleep(delay).await;
        inspect(&serde_json::from_slice(&bytes).unwrap(), received);
        let _ = stream.write_all(reply).await;
    })
}

fn budgets(ordinary_ms: u64, claude_recovery_ms: u64) -> ProviderCallbackBudgets {
    ProviderCallbackBudgets {
        ordinary: Duration::from_millis(ordinary_ms),
        claude_recovery: Duration::from_millis(claude_recovery_ms),
    }
}

/// The Claude recovery callback makes two source observations back to back
/// through this supervisor before it answers. It may take longer than an
/// ordinary callback, and the recovery scope those observations present must
/// still be live when they finish.
#[tokio::test]
async fn claude_recovery_callback_outlasts_an_ordinary_callback_with_a_live_scope() {
    // Longer than the old fixed 30-second scope; the test never waits it out.
    let claude_wait = Duration::from_secs(40);
    let fixture = claude_recovery(budgets(200, claude_wait.as_millis() as u64)).await;
    let lock = fixture.supervisor.lifecycle_lock(&fixture.soul).await;
    let _held = lock.lock().await;
    let authorities = fixture.supervisor.auth_lookup_authorities.clone();
    let server = slow_callback_server(
        &fixture.supervisor,
        Duration::from_millis(600),
        b"not a prepared context",
        move |request, received| {
            assert!(
                request["claudeRecoverySource"].is_object(),
                "the callback carries the Claude recovery source binding"
            );
            let key = request["authLookupAuthority"].as_str().unwrap();
            let expires = authorities
                .lock()
                .unwrap()
                .get(key)
                .map(|authority| authority.expires)
                .expect("the recovery scope is still registered");
            // The scope is created just before the callback starts, so it
            // may end a moment before the wait does, never sooner.
            assert!(
                expires + Duration::from_secs(1) >= received + claude_wait,
                "the scope lives as long as the supervisor waits for this callback"
            );
        },
    );

    let error = fixture
        .supervisor
        .issue_replacement_mcp_capability(
            &fixture.start,
            "claude",
            &fixture.context,
            &[],
            "/fixture/instance",
            "/fixture/workspace",
        )
        .await
        .unwrap_err();

    server.await.expect("the server saw a live scope");
    assert!(
        error.message.contains("invalid scoped grant reference"),
        "the callback was answered, not timed out: {}",
        error.message
    );
}

/// Every other callback keeps the ordinary wait.
#[tokio::test]
async fn ordinary_callback_keeps_the_ordinary_wait() {
    let fixture = claude_recovery(budgets(200, 5_000)).await;
    let server = slow_callback_server(
        &fixture.supervisor,
        Duration::from_millis(600),
        b"ok",
        |_, _| {},
    );

    let error = fixture
        .supervisor
        .notify_mcp_capability(
            "activate",
            "http://host.docker.internal:4000",
            &fixture.soul,
            &IncarnationId::new(),
            "grant-callback-budget",
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
    assert!(
        error
            .message
            .contains("server callback timed out after 200ms"),
        "{}",
        error.message
    );
    server.abort();
}

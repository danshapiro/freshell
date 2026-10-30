//! Name reliability (Task 10, V3 + LB-B2): a server that RESTARTED while the
//! supervisor kept a managed soul alive must bind the soul's saved name on
//! EVERY entry a restarted process can use to reconstruct the terminal row —
//! reconcile adoption, compatibility adoption, a resume create, and a
//! negotiated managed create. Which one production takes after a real managed
//! restart is not known today (the pre-existing P2-G01 reattach bug), so each
//! entry is proven here on a FRESH server state (the "restarted" process):
//! its registry has no row, and its naming store already holds the soul's
//! session record "Survivor". Every case asserts the resulting row is bound
//! to the session ref, caches "Survivor", and is never titled "Shell".
//!
//! Raw-WS integration against an in-process axum server on an ephemeral
//! loopback port (the shared `common` harness convention). A fake
//! `ManagedTerminalController` stands in for the supervisor (the in-crate
//! `LookupOnlyController` pattern, `terminal.rs` `managed_runtime_id_tests`).
//! Only the resume create spawns a local OpenCode TUI, so only it runs under
//! `common::opencode_home`'s isolated home (whose contract asserts the TUI
//! plugin install that a local spawn performs); the managed entries spawn
//! nothing locally.
//!
//! The last case pins the other side of the managed descriptor: a FRESH
//! managed Claude create's own server-preallocated `--session-id`, which a
//! supervisor echoes back, is prospective and never binds as durable.
//! Managed Claude exists only in a `provider-qualification` build with the
//! qualification policy naming claude, so that case is feature-gated and
//! re-runs itself alone in a child process with the policy set.

mod common;

use std::sync::Arc;
use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_protocol::session_names::{
    NameSource, NamedProvider, SessionNameRecord, SessionNameRef,
};
use freshell_terminal::registry::{
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
    ManagedTerminalLaunch, ManagedTerminalLaunchError,
};

const SAVED_NAME: &str = "Survivor";

/// The supervisor after a web-server restart: it still owns the soul (lookup
/// answers it by its durable create request id) and launches idempotently
/// (a managed create for the soul's request answers the soul's descriptor).
struct RestartedSupervisor {
    soul_create_request_id: String,
    soul_session_id: String,
    mode: String,
    cwd: String,
}

impl RestartedSupervisor {
    fn descriptor(&self, terminal_id: &str, stream_id: &str) -> ManagedTerminalDescriptor {
        ManagedTerminalDescriptor {
            soul_id: format!("soul-{}", self.soul_create_request_id),
            incarnation_id: format!("incarnation-{}", self.soul_create_request_id),
            terminal_id: terminal_id.to_string(),
            stream_id: stream_id.to_string(),
            mode: self.mode.clone(),
            cwd: self.cwd.clone(),
            resume_session_id: Some(self.soul_session_id.clone()),
            create_request_id: Some(self.soul_create_request_id.clone()),
        }
    }
}

impl ManagedTerminalController for RestartedSupervisor {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async move {
            Ok(
                (create_request_id.as_deref() == Some(self.soul_create_request_id.as_str()))
                    .then(|| self.descriptor(terminal_id, &format!("stream-{terminal_id}"))),
            )
        })
    }

    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        Box::pin(async move { Ok(self.descriptor(&request.terminal_id, &request.stream_id)) })
    }

    fn input<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), freshell_terminal::registry::ManagedTerminalInputError>>
    {
        Box::pin(async { Ok(()) })
    }

    fn resize<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _cols: u16,
        _rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn stop<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn read_output<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _after_seq: i64,
        _max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async {
            Ok(ManagedOutputRead {
                lifecycle: None,
                completion: None,
                stream_epoch: None,
                incarnation_id: None,
                reset_required: false,
                truncated: false,
                retained_from_seq: 0,
                head_seq: 0,
                exit_code: None,
                native_session_id: None,
                codex_activity: None,
                opencode_activity: None,
                chunks: Vec::new(),
            })
        })
    }
}

fn session_ref(session_id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Opencode,
        session_id: session_id.to_string(),
    }
}

/// The restarted process: a fresh server (empty registry) whose naming store
/// already holds the soul's saved record, with the supervisor installed. The
/// soul's folder is a per-case temp dir (any create-time provider config
/// lands there, never in a shared directory).
async fn restarted_server(
    case: &str,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<common::NamingProbeSink>,
    Arc<RestartedSupervisor>,
    tempfile::TempDir,
) {
    let restarted = boot_restarted(case, "opencode").await;
    let (_, _, sink, supervisor, _) = &restarted;
    sink.seed_record(saved_record(
        session_ref(&supervisor.soul_session_id),
        SAVED_NAME,
    ));
    restarted
}

/// A fresh server (empty registry, empty naming store) whose supervisor
/// still owns a `mode` soul.
async fn boot_restarted(
    case: &str,
    mode: &str,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<common::NamingProbeSink>,
    Arc<RestartedSupervisor>,
    tempfile::TempDir,
) {
    let soul_dir = tempfile::tempdir().expect("soul folder");
    let (url, registry, sink) =
        common::spawn_server_with_specs_and_naming(vec![common::sleeper_cli_spec(mode)]).await;
    let supervisor = Arc::new(RestartedSupervisor {
        soul_create_request_id: format!("crid-{case}"),
        soul_session_id: format!("ses_{case}"),
        mode: mode.to_string(),
        cwd: soul_dir.path().to_string_lossy().into_owned(),
    });
    registry.set_managed_controller(Some(supervisor.clone()));
    assert!(
        registry.directory().is_empty(),
        "the restarted process starts with no terminal rows"
    );
    (url, registry, sink, supervisor, soul_dir)
}

/// A user-named saved record (the store a restarted server reopens).
fn saved_record(name_ref: SessionNameRef, name: &str) -> SessionNameRecord {
    SessionNameRecord {
        name_ref,
        name: name.to_string(),
        source: NameSource::Manual,
        revision: 4,
        manual_revision: Some(4),
        renamed_at: None,
        legacy_origin: None,
    }
}

async fn connect(url: &str, capabilities: serde_json::Value) -> common::TestWs {
    let (ws, _inventory) = common::connect_with_hello(
        url,
        serde_json::json!({
            "type": "hello",
            "token": common::AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": capabilities,
        }),
    )
    .await;
    ws
}

/// Poll the registry row until it carries the soul's binding and saved name
/// (bounded), then pin the three contract facts.
async fn assert_row_bound_to_saved_name(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
    session_id: &str,
    entry: &str,
) {
    assert_row_bound(
        registry,
        terminal_id,
        &session_ref(session_id),
        SAVED_NAME,
        entry,
    )
    .await;
}

/// Poll the registry row until it caches `name` (bounded), then pin that it
/// is bound to `bound_to`, caches `name`, and is titled `name` (never
/// "Shell").
async fn assert_row_bound(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
    bound_to: &SessionNameRef,
    name: &str,
    entry: &str,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if registry.exists(terminal_id)
            && registry
                .session_name_of(terminal_id)
                .is_some_and(|record| record.name == name)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        registry.exists(terminal_id),
        "{entry}: the restarted server must reconstruct the soul's row"
    );
    assert_eq!(
        registry.name_ref_of(terminal_id).as_ref(),
        Some(bound_to),
        "{entry}: the row must be bound to {bound_to:?}"
    );
    assert_eq!(
        registry
            .session_name_of(terminal_id)
            .map(|record| record.name),
        Some(name.to_string()),
        "{entry}: the row must cache the saved name"
    );
    let title = registry.title_of(terminal_id).unwrap_or_default();
    assert_ne!(
        title, "Shell",
        "{entry}: an agent row is never titled Shell"
    );
    assert_eq!(title, name, "{entry}: the row presents the saved name");
}

/// A negotiated `pane.reconcile.request` for the soul's terminal id reaches
/// `adopt_managed_for_reconcile` (`terminal.rs` handle_pane_reconcile).
#[tokio::test(flavor = "multi_thread")]
async fn restart_reconcile_adopt_binds_the_saved_name() {
    let (url, registry, _sink, supervisor, _soul_dir) = restarted_server("reconcile-adopt").await;
    let mut ws = connect(
        &url,
        serde_json::json!({ "paneReconcileV1": true, "managedRuntimeV1": true }),
    )
    .await;
    let terminal_id = "t-soul-reconcile-adopt";
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "rec-restart-1",
            "panes": [{
                "paneKey": "pk-soul",
                "kind": "terminal",
                "mode": "opencode",
                "createRequestId": supervisor.soul_create_request_id,
                "terminalId": terminal_id,
            }],
        })
        .to_string(),
    ))
    .await
    .expect("send pane.reconcile.request");

    assert_row_bound_to_saved_name(
        &registry,
        terminal_id,
        &supervisor.soul_session_id,
        "reconcile adopt",
    )
    .await;
}

/// A ZERO-TURN soul: the descriptor's native session is Claude's
/// preallocated `--session-id`, which has no transcript and no record yet,
/// and the pane's name ("Billing", renamed before the first message) lives
/// under the pane's pending handle. The reconcile entry carries that
/// persisted `namingHandle`, so the adopted row rejoins the pending record —
/// the binding the verified bind lane transfers at the first message —
/// instead of binding the record-less prospective session and orphaning the
/// name.
#[tokio::test(flavor = "multi_thread")]
async fn restart_reconcile_adopt_of_a_zero_turn_soul_keeps_its_pending_name() {
    let (url, registry, sink, supervisor, _soul_dir) =
        boot_restarted("reconcile-zero-turn", "claude").await;
    let handle = "nh-zero-turn-soul";
    let pending = SessionNameRef::Pending {
        id: handle.to_string(),
    };
    sink.seed_record(saved_record(pending.clone(), "Billing"));
    let mut ws = connect(
        &url,
        serde_json::json!({ "paneReconcileV1": true, "managedRuntimeV1": true }),
    )
    .await;
    let terminal_id = "t-soul-reconcile-zero-turn";
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "rec-restart-zero-turn",
            "panes": [{
                "paneKey": "pk-zero-turn",
                "kind": "terminal",
                "mode": "claude",
                "createRequestId": supervisor.soul_create_request_id,
                "terminalId": terminal_id,
                "sessionRef": { "provider": "claude", "sessionId": supervisor.soul_session_id },
                "namingHandle": handle,
            }],
        })
        .to_string(),
    ))
    .await
    .expect("send pane.reconcile.request");

    assert_row_bound(
        &registry,
        terminal_id,
        &pending,
        "Billing",
        "zero-turn reconcile adopt",
    )
    .await;
}

/// A NON-negotiated `terminal.create` replaying the soul's create request id
/// reaches `adopt_existing_managed_for_compat` (`terminal.rs` handle_create's
/// compatibility fence); the created frame carries the saved name too.
#[tokio::test(flavor = "multi_thread")]
async fn restart_compat_adopt_binds_the_saved_name() {
    let (url, registry, _sink, supervisor, _soul_dir) = restarted_server("compat-adopt").await;
    let mut ws = connect(&url, serde_json::json!({})).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": supervisor.soul_create_request_id,
            "mode": "opencode",
            "shell": "system",
            "cwd": supervisor.cwd,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string();
    assert!(
        created["notice"]
            .as_str()
            .is_some_and(|notice| notice.contains("Reattached")),
        "the create must take the compatibility adoption entry: {created}"
    );
    assert_eq!(
        created["sessionName"]["name"],
        serde_json::json!(SAVED_NAME),
        "the adoption's created frame carries the saved name: {created}"
    );
    assert_row_bound_to_saved_name(
        &registry,
        &terminal_id,
        &supervisor.soul_session_id,
        "compat adopt",
    )
    .await;
}

/// A `terminal.create` resuming the soul's session id reaches the durable
/// branch of `admit_create_naming`.
#[tokio::test(flavor = "multi_thread")]
async fn restart_resume_create_binds_the_saved_name() {
    if common::opencode_home::run_with_opencode_home("restart_resume_create_binds_the_saved_name") {
        return;
    }
    let (url, registry, _sink, supervisor, _soul_dir) = restarted_server("resume-create").await;
    let mut ws = connect(&url, serde_json::json!({})).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-resume-after-restart",
            "mode": "opencode",
            "shell": "system",
            "cwd": supervisor.cwd,
            "sessionRef": { "provider": "opencode", "sessionId": supervisor.soul_session_id },
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string();
    assert_row_bound_to_saved_name(
        &registry,
        &terminal_id,
        &supervisor.soul_session_id,
        "resume create",
    )
    .await;
    registry.kill(&terminal_id);
}

/// A negotiated managed create launches through the supervisor and reaches
/// `register_managed` (`terminal.rs` handle_create's managed door).
#[tokio::test(flavor = "multi_thread")]
async fn restart_managed_create_binds_the_saved_name() {
    let (url, registry, _sink, supervisor, _soul_dir) = restarted_server("managed-create").await;
    let mut ws = connect(&url, serde_json::json!({ "managedRuntimeV1": true })).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": supervisor.soul_create_request_id,
            "mode": "opencode",
            "shell": "system",
            "cwd": supervisor.cwd,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string();
    assert!(
        registry.is_managed(&terminal_id),
        "the create must take the managed door"
    );
    assert_row_bound_to_saved_name(
        &registry,
        &terminal_id,
        &supervisor.soul_session_id,
        "managed create",
    )
    .await;
}

/// The qualification policy is a process-wide env var, so the case re-runs
/// itself alone in a child process with it set (and a throwaway HOME) —
/// never `set_var` in the shared test process. Answers true in the parent,
/// after the child passed.
#[cfg(feature = "provider-qualification")]
fn run_with_claude_qualification(test: &str) -> bool {
    const CHILD: &str = "FRESHELL_TEST_CLAUDE_QUALIFICATION_CHILD";
    if let Ok(child) = std::env::var(CHILD) {
        assert_eq!(child, test, "the qualification child ran the wrong case");
        return false;
    }
    let home = tempfile::tempdir().expect("child home");
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", test, "--nocapture"])
        .env(CHILD, test)
        .env("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "claude")
        .env("HOME", home.path())
        .output()
        .expect("run the qualification child");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed"),
        "the qualification child failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

/// A supervisor launching fresh souls the way the production controller
/// does: the descriptor echoes the create's own launch session id.
#[cfg(feature = "provider-qualification")]
struct FreshLaunchSupervisor;

#[cfg(feature = "provider-qualification")]
impl ManagedTerminalController for FreshLaunchSupervisor {
    fn lookup_terminal<'a>(
        &'a self,
        _terminal_id: &'a str,
        _create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async { Ok(None) })
    }

    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        Box::pin(async move {
            Ok(ManagedTerminalDescriptor {
                soul_id: format!("soul-{}", request.terminal_id),
                incarnation_id: format!("incarnation-{}", request.terminal_id),
                terminal_id: request.terminal_id,
                stream_id: request.stream_id,
                mode: request.mode,
                cwd: request.spec.cwd.unwrap_or_else(|| "/workspace".into()),
                resume_session_id: request.resume_session_id,
                create_request_id: request.create_request_id,
            })
        })
    }

    fn input<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn resize<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _cols: u16,
        _rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn stop<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn read_output<'a>(
        &'a self,
        _terminal: ManagedTerminalDescriptor,
        _after_seq: i64,
        _max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async { Err("no output in the naming test".into()) })
    }
}

/// A negotiated, handle-less FRESH managed Claude create: the server
/// preallocates a `--session-id` and the supervisor echoes it in the
/// descriptor. That id is prospective (no transcript, no record), so the row
/// binds to a server-minted PENDING handle — the only binding the verified
/// bind lane can transfer at materialization — never to the bare session.
#[cfg(feature = "provider-qualification")]
#[tokio::test(flavor = "multi_thread")]
async fn fresh_managed_claude_create_binds_a_pending_handle_not_its_preallocated_id() {
    if run_with_claude_qualification(
        "fresh_managed_claude_create_binds_a_pending_handle_not_its_preallocated_id",
    ) {
        return;
    }
    let soul_dir = tempfile::tempdir().expect("soul folder");
    let (url, registry, _sink) =
        common::spawn_server_with_specs_and_naming(vec![common::sleeper_cli_spec("claude")]).await;
    registry.set_managed_controller(Some(Arc::new(FreshLaunchSupervisor)));
    let mut ws = connect(&url, serde_json::json!({ "managedRuntimeV1": true })).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-fresh-managed-claude",
            "mode": "claude",
            "shell": "system",
            "cwd": soul_dir.path().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string();

    assert!(
        registry.is_managed(&terminal_id),
        "the create must take the managed door"
    );
    let preallocated = registry
        .managed_descriptor(&terminal_id)
        .and_then(|descriptor| descriptor.resume_session_id)
        .expect("a fresh claude create preallocates its --session-id");
    let bound = registry
        .name_ref_of(&terminal_id)
        .expect("the row is bound before the created frame");
    assert!(
        matches!(bound, SessionNameRef::Pending { .. }),
        "the row must bind a pending handle, not the prospective session {preallocated}: {bound:?}"
    );
    assert_eq!(
        created["nameRef"]["kind"],
        serde_json::json!("pending"),
        "the created frame projects the pending binding: {created}"
    );
}

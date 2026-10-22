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
    cwd: String,
}

impl RestartedSupervisor {
    fn descriptor(&self, terminal_id: &str, stream_id: &str) -> ManagedTerminalDescriptor {
        ManagedTerminalDescriptor {
            soul_id: format!("soul-{}", self.soul_create_request_id),
            incarnation_id: format!("incarnation-{}", self.soul_create_request_id),
            terminal_id: terminal_id.to_string(),
            stream_id: stream_id.to_string(),
            mode: "opencode".to_string(),
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
    let soul_dir = tempfile::tempdir().expect("soul folder");
    let (url, registry, sink) =
        common::spawn_server_with_specs_and_naming(vec![common::sleeper_cli_spec("opencode")])
            .await;
    let supervisor = Arc::new(RestartedSupervisor {
        soul_create_request_id: format!("crid-{case}"),
        soul_session_id: format!("ses_{case}"),
        cwd: soul_dir.path().to_string_lossy().into_owned(),
    });
    registry.set_managed_controller(Some(supervisor.clone()));
    sink.seed_record(SessionNameRecord {
        name_ref: session_ref(&supervisor.soul_session_id),
        name: SAVED_NAME.to_string(),
        source: NameSource::Manual,
        revision: 4,
        manual_revision: Some(4),
        renamed_at: None,
        legacy_origin: None,
    });
    assert!(
        registry.directory().is_empty(),
        "the restarted process starts with no terminal rows"
    );
    (url, registry, sink, supervisor, soul_dir)
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if registry.exists(terminal_id)
            && registry
                .session_name_of(terminal_id)
                .is_some_and(|record| record.name == SAVED_NAME)
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
        registry.name_ref_of(terminal_id),
        Some(session_ref(session_id)),
        "{entry}: the row must be bound to the soul's durable session ref"
    );
    assert_eq!(
        registry
            .session_name_of(terminal_id)
            .map(|record| record.name),
        Some(SAVED_NAME.to_string()),
        "{entry}: the row must cache the soul's saved name"
    );
    let title = registry.title_of(terminal_id).unwrap_or_default();
    assert_ne!(
        title, "Shell",
        "{entry}: an agent row is never titled Shell"
    );
    assert_eq!(
        title, SAVED_NAME,
        "{entry}: the row presents the saved name"
    );
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

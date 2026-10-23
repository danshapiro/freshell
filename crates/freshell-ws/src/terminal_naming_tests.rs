//! Name reliability (Task 10): every WebSocket-side terminal row path binds
//! its saved name — managed reconcile adoption, compatibility adoption, the
//! auto-resume respawn — and a conversation switch moves the row's binding
//! to the new session (through the follow-up the upsert callers run, and
//! through the reconcile tick when that follow-up is skipped).
//!
//! A child of `terminal` so the cases drive the real `handle_create` /
//! `handle_pane_reconcile` / `respawn_agent_terminal` entries over the
//! module's own test state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use freshell_freshagent::naming::{
    BindNameInput, NameActivity, NameError, NameFuture, NativeNameObservation, PendingNameInput,
    RenameNameInput, SessionNaming,
};
use freshell_protocol::native_location::NativeAcquisition;
use freshell_protocol::session_names::{
    NameSource, NamedProvider, SessionNameRecord, SessionNameRef, SessionNameUpdate,
};
use freshell_terminal::registry::{
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
    ManagedTerminalLaunch, ManagedTerminalLaunchError,
};

use super::ServerMessage;

// ── fakes ────────────────────────────────────────────────────────────────

/// A record map behind the naming surface: `get` answers seeded or admitted
/// records, `ensure_pending` admits a directory-fallback record. Every
/// admission is counted so a test can prove no record was created.
#[derive(Default)]
struct MapSink {
    records: Mutex<HashMap<String, SessionNameRecord>>,
    ensures: Mutex<Vec<String>>,
}

fn key(target: &SessionNameRef) -> String {
    freshell_freshagent::naming::name_ref_debug_key(target)
}

impl MapSink {
    fn seed(&self, target: SessionNameRef, name: &str) {
        self.records.lock().unwrap().insert(
            key(&target),
            SessionNameRecord {
                name_ref: target,
                name: name.to_string(),
                source: NameSource::Manual,
                revision: 3,
                manual_revision: Some(3),
                renamed_at: None,
                legacy_origin: None,
            },
        );
    }

    fn name_of(&self, target: &SessionNameRef) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .get(&key(target))
            .map(|record| record.name.clone())
    }

    fn update(record: SessionNameRecord) -> SessionNameUpdate {
        SessionNameUpdate {
            redirects: Vec::new(),
            record,
            document_generation: 1,
            changed: false,
            native_sync: None,
            outcome: None,
        }
    }
}

fn unsupported<T: Send + 'static>() -> NameFuture<T> {
    Box::pin(async { Err(NameError::NotFound("not needed here".into())) })
}

impl SessionNaming for MapSink {
    fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>> {
        let records = self.records.lock().unwrap();
        let updates = refs
            .iter()
            .filter_map(|target| records.get(&key(target)).cloned())
            .map(MapSink::update)
            .collect();
        Box::pin(async move { Ok(updates) })
    }

    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate> {
        self.ensures.lock().unwrap().push(input.handle.clone());
        let target = SessionNameRef::Pending {
            id: input.handle.clone(),
        };
        let mut records = self.records.lock().unwrap();
        let record = records
            .entry(key(&target))
            .or_insert_with(|| SessionNameRecord {
                name_ref: target,
                name: input.provider.display_label().to_string(),
                source: NameSource::Directory,
                revision: 1,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            })
            .clone();
        Box::pin(async move { Ok(MapSink::update(record)) })
    }

    fn bind_pending(&self, _input: BindNameInput) -> NameFuture<SessionNameUpdate> {
        unsupported()
    }

    fn rename(&self, _input: RenameNameInput) -> NameFuture<SessionNameUpdate> {
        unsupported()
    }

    fn activity(&self, _input: NameActivity) -> NameFuture<SessionNameUpdate> {
        unsupported()
    }

    fn observe_native(&self, _input: NativeNameObservation) -> NameFuture<SessionNameUpdate> {
        unsupported()
    }

    fn record_acquisition(
        &self,
        _target: SessionNameRef,
        _acquisition: NativeAcquisition,
    ) -> NameFuture<SessionNameUpdate> {
        unsupported()
    }
}

/// The supervisor's inventory after a web restart: lookup answers the soul
/// for its own terminal id; nothing else is ever called.
struct SoulInventory {
    soul: ManagedTerminalDescriptor,
}

impl ManagedTerminalController for SoulInventory {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        _create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        let found = (terminal_id == self.soul.terminal_id).then(|| self.soul.clone());
        Box::pin(async move { Ok(found) })
    }

    fn launch<'a>(
        &'a self,
        _request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        Box::pin(async { Err("adoption must never launch".into()) })
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
        Box::pin(async { Err("adoption must never read output".into()) })
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

fn opencode(session_id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Opencode,
        session_id: session_id.to_string(),
    }
}

fn claude(session_id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: session_id.to_string(),
    }
}

fn opencode_spec() -> freshell_platform::CliCommandSpec {
    freshell_platform::CliCommandSpec {
        name: "opencode".into(),
        label: "OpenCode".into(),
        default_cmd: "opencode".into(),
        ..Default::default()
    }
}

/// The module's test state with naming wired and the given CLI specs.
fn named_state(specs: Vec<freshell_platform::CliCommandSpec>) -> (crate::WsState, Arc<MapSink>) {
    let mut state = super::pane_reconcile_gate_tests::state();
    let sink = Arc::new(MapSink::default());
    state.identity.set_session_naming(sink.clone());
    state.cli_commands = Arc::new(specs);
    (state, sink)
}

fn soul(terminal_id: &str, create_request_id: &str, session_id: &str) -> ManagedTerminalDescriptor {
    ManagedTerminalDescriptor {
        soul_id: format!("soul-{terminal_id}"),
        incarnation_id: format!("incarnation-{terminal_id}"),
        terminal_id: terminal_id.to_string(),
        stream_id: format!("stream-{terminal_id}"),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: Some(session_id.to_string()),
        create_request_id: Some(create_request_id.to_string()),
    }
}

fn assert_bound_to(state: &crate::WsState, terminal_id: &str, target: &SessionNameRef, name: &str) {
    assert_eq!(
        state.registry.name_ref_of(terminal_id).as_ref(),
        Some(target),
        "the registry row carries the expected binding"
    );
    assert_eq!(
        state.identity.name_ref_for(terminal_id).as_ref(),
        Some(target),
        "the identity table carries the same binding"
    );
    assert_eq!(
        state
            .registry
            .session_name_of(terminal_id)
            .map(|record| record.name),
        Some(name.to_string()),
        "the row caches the saved name"
    );
    assert_eq!(
        state.registry.title_of(terminal_id).as_deref(),
        Some(name),
        "the row presents the saved name, never Shell"
    );
}

// ── adoption ─────────────────────────────────────────────────────────────

/// A negotiated reconcile for a soul the restarted server has no row for
/// reconstructs the facade AND binds the soul's saved name.
#[tokio::test]
async fn adopt_managed_for_reconcile_binds_naming() {
    let (state, sink) = named_state(vec![opencode_spec()]);
    sink.seed(opencode("ses_reconciled"), "Survivor");
    state
        .registry
        .set_managed_controller(Some(Arc::new(SoulInventory {
            soul: soul("T-reconciled", "crid-reconciled", "ses_reconciled"),
        })));
    let (mut ws_tx, _client) = super::pane_reconcile_gate_tests::loopback_sink_and_client().await;
    let request: freshell_protocol::PaneReconcileRequest =
        serde_json::from_value(serde_json::json!({
            "reconcileId": "rec-adopt",
            "panes": [{
                "paneKey": "pk-soul",
                "kind": "terminal",
                "mode": "opencode",
                "createRequestId": "crid-reconciled",
                "terminalId": "T-reconciled",
            }],
        }))
        .expect("reconcile request");

    assert!(super::handle_pane_reconcile(request, &mut ws_tx, &state, false, true).await);

    assert!(state.registry.is_managed("T-reconciled"));
    assert_bound_to(
        &state,
        "T-reconciled",
        &opencode("ses_reconciled"),
        "Survivor",
    );
}

/// A legacy client's replayed create adopts the supervisor's facade through
/// the compatibility fence AND binds the soul's saved name; the created
/// frame projects it.
#[tokio::test]
async fn compat_adoption_binds_naming() {
    let (state, sink) = named_state(vec![opencode_spec()]);
    sink.seed(opencode("ses_compat_named"), "Survivor");
    let create_request_id = "crid-compat-named";
    let terminal_id = super::stable_managed_uuid(create_request_id, b"terminal")
        .simple()
        .to_string();
    state
        .registry
        .set_managed_controller(Some(Arc::new(SoulInventory {
            soul: soul(&terminal_id, create_request_id, "ses_compat_named"),
        })));
    let frames = Arc::new(Mutex::new(Vec::<ServerMessage>::new()));
    let collector = Arc::clone(&frames);
    let frame_sink: freshell_terminal::FrameSink = Arc::new(move |message| {
        collector.lock().expect("frames lock").push(message);
    });
    let mut output = crate::create_gate::CreateOutput::Channel(&frame_sink);
    let create: freshell_protocol::TerminalCreate = serde_json::from_value(serde_json::json!({
        "requestId": create_request_id,
        "mode": "opencode",
        "shell": "system",
        "restore": true,
    }))
    .expect("terminal create");
    let mut limiter = crate::create_limit::CreateRateLimiter::new(100, 1000);

    assert!(
        super::handle_create(
            create,
            None,
            &mut output,
            &state,
            17,
            true,
            &mut limiter,
            &super::ConnectionIdentity::default(),
            super::now_ms(),
        )
        .await
    );

    assert_bound_to(
        &state,
        &terminal_id,
        &opencode("ses_compat_named"),
        "Survivor",
    );
    let frames = frames.lock().expect("frames lock");
    let created = frames
        .iter()
        .find_map(|frame| match frame {
            ServerMessage::TerminalCreated(created) if created.terminal_id == terminal_id => {
                Some(created.clone())
            }
            _ => None,
        })
        .expect("the adoption answers terminal.created");
    assert_eq!(
        created.session_name.map(|record| record.name).as_deref(),
        Some("Survivor")
    );
    assert_eq!(created.name_ref, Some(opencode("ses_compat_named")));
}

// ── create admission ─────────────────────────────────────────────────────

fn claude_create(request_id: &str) -> freshell_protocol::TerminalCreate {
    serde_json::from_value(serde_json::json!({
        "requestId": request_id,
        "mode": "claude",
        "shell": "system",
    }))
    .expect("terminal create")
}

fn managed_claude_row(state: &crate::WsState, terminal_id: &str, descriptor_session: &str) {
    let mut descriptor = soul(
        terminal_id,
        &format!("crid-{terminal_id}"),
        descriptor_session,
    );
    descriptor.mode = "claude".into();
    state
        .registry
        .register_managed(descriptor, "Claude CLI".to_string());
}

/// A handle-less fresh managed Claude create: the supervisor echoed the
/// create's own server-preallocated `--session-id` into the descriptor. That
/// id is prospective, so the admission binds a server-minted PENDING handle
/// (the only binding the verified bind lane can transfer at
/// materialization) — never the bare, record-less session.
#[tokio::test]
async fn fresh_managed_create_never_binds_its_own_preallocated_session() {
    let (state, sink) = named_state(Vec::new());
    managed_claude_row(&state, "T-fresh-claude", "s-prealloc");

    let projection = super::admit_create_naming(
        &state,
        &claude_create("crid-T-fresh-claude"),
        "T-fresh-claude",
        "claude",
        Some("/workspace"),
        None,
        "Claude CLI".to_string(),
        Some("s-prealloc"),
    )
    .await;

    let bound = state
        .registry
        .name_ref_of("T-fresh-claude")
        .expect("the row is bound");
    assert!(
        matches!(bound, SessionNameRef::Pending { .. }),
        "a prospective session never binds as durable: {bound:?}"
    );
    assert_eq!(
        state.identity.name_ref_for("T-fresh-claude"),
        Some(bound.clone())
    );
    assert_eq!(
        sink.ensures.lock().unwrap().len(),
        1,
        "the pending record was admitted"
    );
    assert_eq!(projection.map(|(name_ref, _)| name_ref), Some(bound));
}

/// A managed create the supervisor answered with an EXISTING soul (its
/// native session differs from this create's own preallocation) binds that
/// soul's durable session and its saved name.
#[tokio::test]
async fn managed_create_reusing_a_soul_binds_the_souls_saved_name() {
    let (state, sink) = named_state(Vec::new());
    sink.seed(claude("s-soul"), "Survivor");
    managed_claude_row(&state, "T-reused-claude", "s-soul");

    let projection = super::admit_create_naming(
        &state,
        &claude_create("crid-T-reused-claude"),
        "T-reused-claude",
        "claude",
        Some("/workspace"),
        None,
        "Claude CLI".to_string(),
        Some("s-this-create"),
    )
    .await;

    assert_bound_to(&state, "T-reused-claude", &claude("s-soul"), "Survivor");
    assert_eq!(
        projection.map(|(_, record)| record.name).as_deref(),
        Some("Survivor")
    );
    assert!(sink.ensures.lock().unwrap().is_empty());
}

// ── auto-resume ──────────────────────────────────────────────────────────

/// A sleeper claude CLI the auto-resume respawn can spawn (removed on drop).
#[cfg(unix)]
struct SleeperClaude {
    script: std::path::PathBuf,
}

#[cfg(unix)]
impl SleeperClaude {
    fn new(case: &str) -> Self {
        let script = std::env::temp_dir().join(format!(
            "freshell-terminal-naming-respawn-{case}-{}.sh",
            std::process::id()
        ));
        std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").expect("write sleeper");
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { script }
    }

    fn spec(&self) -> freshell_platform::CliCommandSpec {
        freshell_platform::CliCommandSpec {
            name: "claude".into(),
            label: "Claude CLI".into(),
            default_cmd: self.script.to_string_lossy().into_owned(),
            resume_args: Some(vec!["--resume".into(), "{{sessionId}}".into()]),
            create_session_args: Some(vec!["--session-id".into(), "{{sessionId}}".into()]),
            ..Default::default()
        }
    }
}

#[cfg(unix)]
impl Drop for SleeperClaude {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.script);
    }
}

#[cfg(unix)]
fn respawn_request(session_id: &str, replaces: Option<&str>) -> super::AgentRespawnRequest {
    super::AgentRespawnRequest {
        mode: "claude".into(),
        provider: "claude".into(),
        session_id: session_id.into(),
        create_request_id: format!("crid-{session_id}"),
        cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        replaces_terminal_id: replaces.map(str::to_string),
    }
}

/// The auto-resume respawn's replacement row carries the session binding
/// and the saved name (it was titled "<Mode> (auto-resumed)" and unbound).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn respawned_agent_row_carries_binding_and_saved_name() {
    let cli = SleeperClaude::new("survivor");
    let (state, sink) = named_state(vec![cli.spec()]);
    sink.seed(claude("s-survivor"), "Survivor");

    let terminal_id = super::respawn_agent_terminal(&state, &respawn_request("s-survivor", None))
        .await
        .expect("respawn spawns a replacement");

    assert_bound_to(&state, &terminal_id, &claude("s-survivor"), "Survivor");
    state.registry.kill(&terminal_id);
}

/// The CLI crashed before its row's pending handle transferred onto the
/// durable session (a rename before the first message): the replacement
/// inherits that STILL-PENDING handle, so it shows the pre-durable name and
/// the bind lane can still transfer it — it neither binds the record-less
/// session nor mints a new handle.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn respawn_inherits_the_crashed_rows_still_pending_handle() {
    let cli = SleeperClaude::new("pending");
    let (state, sink) = named_state(vec![cli.spec()]);
    let pending = SessionNameRef::Pending {
        id: "nh-before-first-message".into(),
    };
    sink.seed(pending.clone(), "Early name");
    state
        .identity
        .upsert("T-crashed", Some("claude"), Some("s-early"), None, 1);
    state.identity.set_name_binding(
        "T-crashed",
        Some(pending.clone()),
        Some("nh-before-first-message".into()),
    );
    state.identity.retire("T-crashed");

    let terminal_id =
        super::respawn_agent_terminal(&state, &respawn_request("s-early", Some("T-crashed")))
            .await
            .expect("respawn spawns a replacement");

    assert_bound_to(&state, &terminal_id, &pending, "Early name");
    assert_eq!(
        state.identity.naming_handle_of(&terminal_id).as_deref(),
        Some("nh-before-first-message"),
        "the replacement retains the handle the bind lane transfers"
    );
    assert_eq!(
        *sink.ensures.lock().unwrap(),
        vec!["nh-before-first-message".to_string()],
        "no new handle was minted"
    );
    state.registry.kill(&terminal_id);
}

/// A crashed row whose handle ALREADY transferred onto a durable session
/// passes nothing on: that spent handle resolves to the old session's
/// record, so inheriting it would show the wrong conversation's name.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn respawn_never_inherits_a_transferred_handle() {
    let cli = SleeperClaude::new("transferred");
    let (state, sink) = named_state(vec![cli.spec()]);
    state.identity.upsert(
        "T-crashed-durable",
        Some("claude"),
        Some("s-moved-on"),
        None,
        1,
    );
    state.identity.set_name_binding(
        "T-crashed-durable",
        Some(claude("s-moved-on")),
        Some("nh-spent".into()),
    );
    state.identity.retire("T-crashed-durable");

    let terminal_id = super::respawn_agent_terminal(
        &state,
        &respawn_request("s-moved-on", Some("T-crashed-durable")),
    )
    .await
    .expect("respawn spawns a replacement");

    assert_eq!(
        state.registry.name_ref_of(&terminal_id),
        Some(claude("s-moved-on"))
    );
    assert!(sink.ensures.lock().unwrap().is_empty());
    state.registry.kill(&terminal_id);
}

// ── conversation switch ──────────────────────────────────────────────────

/// A durable claude row bound to session A whose record is "LotL".
fn row_on_session_a(state: &crate::WsState, sink: &MapSink, terminal_id: &str) {
    state
        .registry
        .register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: terminal_id.to_string(),
            stream_id: format!("S-{terminal_id}"),
            mode: "claude".into(),
            resume_session_id: Some("s-a".into()),
            create_request_id: None,
            created_at: None,
        });
    state
        .identity
        .upsert(terminal_id, Some("claude"), Some("s-a"), None, 1);
    state
        .identity
        .set_name_binding(terminal_id, Some(claude("s-a")), None);
    state
        .registry
        .set_naming(terminal_id, Some(claude("s-a")), None);
    let record = sink
        .records
        .lock()
        .unwrap()
        .get(&key(&claude("s-a")))
        .cloned()
        .expect("A's record is seeded");
    state.registry.update_session_name(terminal_id, &record);
}

/// Switching the terminal to session B (B has its own record) moves the
/// registry binding to B and shows B's name; A's record is untouched.
/// Covered twice: through the upsert callers' follow-up, and through the
/// reconcile tick when that follow-up is skipped.
#[tokio::test]
async fn conversation_switch_adopts_the_new_sessions_record() {
    let (state, sink) = named_state(Vec::new());
    sink.seed(claude("s-a"), "LotL");
    sink.seed(claude("s-b"), "Billing bug");
    row_on_session_a(&state, &sink, "T-helper");
    row_on_session_a(&state, &sink, "T-tick");

    state
        .identity
        .upsert("T-helper", Some("claude"), Some("s-b"), None, 2);
    crate::terminal_naming::follow_identity_switch(&state, "T-helper").await;
    state
        .identity
        .upsert("T-tick", Some("claude"), Some("s-b"), None, 2);
    crate::terminal_naming::reconcile_terminal_naming(&state, &Default::default()).await;

    for terminal_id in ["T-helper", "T-tick"] {
        assert_bound_to(&state, terminal_id, &claude("s-b"), "Billing bug");
    }
    assert_eq!(sink.name_of(&claude("s-a")).as_deref(), Some("LotL"));
}

/// Switching to a session with no record: the row moves to B (never back to
/// a pending handle that redirects to A), no record is created, and the row
/// shows the mode label; the naming publisher, which refreshes every row
/// bound to a record, reaches it once B is named.
#[tokio::test]
async fn conversation_switch_to_a_session_without_a_record_shows_the_fallback() {
    let (state, sink) = named_state(Vec::new());
    sink.seed(claude("s-a"), "LotL");
    row_on_session_a(&state, &sink, "T-bare");
    state
        .identity
        .set_name_binding("T-bare", None, Some("nh-was-bound-to-a".into()));
    let records_before = sink.records.lock().unwrap().len();

    state
        .identity
        .upsert("T-bare", Some("claude"), Some("s-b"), None, 2);
    crate::terminal_naming::follow_identity_switch(&state, "T-bare").await;
    crate::terminal_naming::reconcile_terminal_naming(&state, &Default::default()).await;

    assert_eq!(state.registry.name_ref_of("T-bare"), Some(claude("s-b")));
    assert!(state.registry.session_name_of("T-bare").is_none());
    assert_eq!(state.registry.title_of("T-bare").as_deref(), Some("Claude"));
    assert!(sink.ensures.lock().unwrap().is_empty());
    assert_eq!(
        sink.records.lock().unwrap().len(),
        records_before,
        "a switch creates no record"
    );
    assert_eq!(
        state.registry.terminals_bound_to(&claude("s-b")),
        vec!["T-bare".to_string()],
        "the publisher's refresh set for B now includes the row"
    );
    // B is named by the normal paths (hydrate / first message); the publisher
    // folds the committed record into every row bound to it.
    sink.seed(claude("s-b"), "Fix the login flow");
    let named = sink
        .records
        .lock()
        .unwrap()
        .get(&key(&claude("s-b")))
        .cloned()
        .unwrap();
    for terminal_id in state.registry.terminals_bound_to(&claude("s-b")) {
        state.registry.update_session_name(&terminal_id, &named);
    }
    assert_eq!(
        state.registry.title_of("T-bare").as_deref(),
        Some("Fix the login flow")
    );
    assert_eq!(sink.name_of(&claude("s-a")).as_deref(), Some("LotL"));
}

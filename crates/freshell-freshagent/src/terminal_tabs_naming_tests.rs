//! Name reliability (Task 10): the REST door's terminal naming bind. A REST
//! managed create binds its row through the shared helper in BOTH homes (the
//! registry row and the shared identity table) and presents the saved name;
//! a fresh managed Claude create's own server-preallocated `--session-id`
//! (which the supervisor echoes back) is prospective, so the row binds to a
//! pending handle instead of the bare, record-less session.
//!
//! A sibling of `terminal_tabs::tests`, reusing its REST harness. Managed
//! Claude exists only in a `provider-qualification` build with the
//! qualification policy naming claude, so that case is feature-gated and
//! re-runs itself alone in a child process with the policy set.

use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::json;

use super::tests::{app, post, state_with_registry};

/// A supervisor that launches whatever it is asked to (the REST managed
/// door's controller for the naming tests).
struct LaunchingManagedController;

impl freshell_terminal::registry::ManagedTerminalController for LaunchingManagedController {
    fn lookup_terminal<'a>(
        &'a self,
        _: &'a str,
        _: Option<String>,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<Option<freshell_terminal::registry::ManagedTerminalDescriptor>, String>,
    > {
        Box::pin(async { Ok(None) })
    }

    fn launch<'a>(
        &'a self,
        request: freshell_terminal::registry::ManagedTerminalLaunch,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<
            freshell_terminal::registry::ManagedTerminalDescriptor,
            freshell_terminal::registry::ManagedTerminalLaunchError,
        >,
    > {
        Box::pin(async move {
            Ok(freshell_terminal::registry::ManagedTerminalDescriptor {
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
        _: freshell_terminal::registry::ManagedTerminalDescriptor,
        _: String,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn resize<'a>(
        &'a self,
        _: freshell_terminal::registry::ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn stop<'a>(
        &'a self,
        _: freshell_terminal::registry::ManagedTerminalDescriptor,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn read_output<'a>(
        &'a self,
        _: freshell_terminal::registry::ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<freshell_terminal::registry::ManagedOutputRead, String>,
    > {
        Box::pin(async { Err("no output in the naming test".into()) })
    }
}

/// The shared identity table `freshell-server` injects into the REST
/// door, as a recording fake.
#[derive(Default)]
struct RecordingNameBinder {
    bindings: std::sync::Mutex<
        std::collections::HashMap<String, freshell_protocol::session_names::SessionNameRef>,
    >,
}

impl crate::terminal_name_binding::TerminalNameBinder for RecordingNameBinder {
    fn set_name_binding(
        &self,
        terminal_id: &str,
        name_ref: &freshell_protocol::session_names::SessionNameRef,
        _naming_handle: Option<&str>,
    ) {
        self.bindings
            .lock()
            .unwrap()
            .insert(terminal_id.to_string(), name_ref.clone());
    }

    fn name_ref_of(
        &self,
        terminal_id: &str,
    ) -> Option<freshell_protocol::session_names::SessionNameRef> {
        self.bindings.lock().unwrap().get(terminal_id).cloned()
    }

    fn naming_handle_of(&self, _terminal_id: &str) -> Option<String> {
        None
    }

    fn durable_session_of(&self, _terminal_id: &str) -> Option<(String, String)> {
        None
    }
}

/// Name reliability (Task 10): a REST managed create resuming a soul's
/// session binds the row to that session — in the registry AND the
/// shared identity table — and presents its saved name (the row was
/// titled "Shell" and its name cache stayed empty).
#[tokio::test]
async fn rest_managed_create_binds_naming() {
    use freshell_protocol::session_names::{NamedProvider, SessionNameRef};

    let binder = Arc::new(RecordingNameBinder::default());
    let state = state_with_registry()
        .with_cli_commands(Arc::new(vec![freshell_platform::CliCommandSpec {
            name: "opencode".into(),
            label: "OpenCode".into(),
            default_cmd: "opencode".into(),
            ..Default::default()
        }]))
        .with_terminal_name_binder(binder.clone());
    let sink = crate::naming::test_support::RecordingSink::new();
    state.set_session_naming(sink.clone());
    let durable = SessionNameRef::Session {
        provider: NamedProvider::Opencode,
        session_id: "ses_rest_soul".into(),
    };
    seed_saved_name(&sink, &durable, "seed-rest-soul", "Survivor").await;
    let registry = state.terminal_registry.clone().expect("registry wired");
    registry.set_managed_controller(Some(Arc::new(LaunchingManagedController)));

    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "mode": "opencode",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "opencode", "sessionId": "ses_rest_soul" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let terminal_id = body["data"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    assert!(registry.is_managed(&terminal_id), "the managed door ran");
    assert_eq!(registry.name_ref_of(&terminal_id), Some(durable.clone()));
    assert_eq!(
        binder.bindings.lock().unwrap().get(&terminal_id),
        Some(&durable),
        "the shared identity table carries the same binding"
    );
    assert_eq!(
        registry.session_name_of(&terminal_id).map(|r| r.name),
        Some("Survivor".to_string())
    );
    assert_eq!(registry.title_of(&terminal_id).as_deref(), Some("Survivor"));
}

/// Seed `target` with a saved name through the public naming surface (admit
/// a handle, verify-bind it, then a user rename).
async fn seed_saved_name(
    sink: &crate::naming::test_support::RecordingSink,
    target: &freshell_protocol::session_names::SessionNameRef,
    handle: &str,
    name: &str,
) {
    use crate::naming::SessionNaming as _;
    use freshell_protocol::session_names::{NameIntent, NamedProvider, SessionNameRef};

    let provider = match target {
        SessionNameRef::Session { provider, .. } => *provider,
        SessionNameRef::Pending { .. } => NamedProvider::Claude,
    };
    sink.ensure_pending(crate::naming::PendingNameInput {
        handle: handle.into(),
        provider,
        cwd: None,
    })
    .await
    .unwrap();
    sink.bind_pending(crate::naming::BindNameInput {
        pending: SessionNameRef::Pending { id: handle.into() },
        target: target.clone(),
        acquisition: crate::naming::test_support::verified_claude_acquisition("seed"),
    })
    .await
    .unwrap();
    sink.rename(crate::naming::RenameNameInput {
        target: target.clone(),
        name: name.into(),
        intent: NameIntent::User,
        if_revision: None,
    })
    .await
    .unwrap();
}

/// The qualification policy is a process-wide env var, so the case re-runs
/// itself alone in a child process with it set (and a throwaway HOME) —
/// never `set_var` in the shared test process. Answers true in the parent,
/// after the child passed.
#[cfg(feature = "provider-qualification")]
fn run_with_claude_qualification(test: &str) -> bool {
    const CHILD: &str = "FRESHELL_TEST_CLAUDE_QUALIFICATION_CHILD";
    let exact = format!(
        "{}::{test}",
        module_path!()
            .split_once("::")
            .map_or(module_path!(), |(_, path)| path)
    );
    if let Ok(child) = std::env::var(CHILD) {
        assert_eq!(child, exact, "the qualification child ran the wrong case");
        return false;
    }
    let home = tempfile::tempdir().expect("child home");
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", exact.as_str(), "--nocapture"])
        .env(CHILD, &exact)
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

/// A handle-less REST fresh managed Claude create: the supervisor echoes the
/// create's own server-preallocated `--session-id` back in its descriptor.
/// That id is prospective (no transcript, no record), so the row binds to a
/// pending handle — admitted, retained, and carried in the pane content —
/// never to the bare session, which would leave no pending record for the
/// verified bind lane to transfer at materialization.
#[cfg(feature = "provider-qualification")]
#[tokio::test]
async fn rest_fresh_managed_claude_create_binds_a_pending_handle_not_its_preallocated_id() {
    use freshell_protocol::session_names::SessionNameRef;

    if run_with_claude_qualification(
        "rest_fresh_managed_claude_create_binds_a_pending_handle_not_its_preallocated_id",
    ) {
        return;
    }

    let binder = Arc::new(RecordingNameBinder::default());
    let state = state_with_registry()
        .with_cli_commands(Arc::new(vec![freshell_platform::CliCommandSpec {
            name: "claude".into(),
            label: "Claude CLI".into(),
            default_cmd: "claude".into(),
            resume_args: Some(vec!["--resume".into(), "{{sessionId}}".into()]),
            create_session_args: Some(vec!["--session-id".into(), "{{sessionId}}".into()]),
            ..Default::default()
        }]))
        .with_terminal_name_binder(binder.clone());
    let sink = crate::naming::test_support::RecordingSink::new();
    state.set_session_naming(sink.clone());
    let registry = state.terminal_registry.clone().expect("registry wired");
    registry.set_managed_controller(Some(Arc::new(LaunchingManagedController)));

    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "mode": "claude",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let terminal_id = body["data"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    assert!(registry.is_managed(&terminal_id), "the managed door ran");
    let preallocated = registry
        .managed_descriptor(&terminal_id)
        .and_then(|descriptor| descriptor.resume_session_id)
        .expect("the fresh create preallocated a --session-id");
    let bound = registry
        .name_ref_of(&terminal_id)
        .expect("the row is bound");
    let SessionNameRef::Pending { id: handle } = &bound else {
        panic!("the row must bind a pending handle, not the prospective session {preallocated}: {bound:?}");
    };
    assert_eq!(
        binder.bindings.lock().unwrap().get(&terminal_id),
        Some(&bound),
        "the shared identity table carries the same pending binding"
    );
    assert!(
        registry.session_name_of(&terminal_id).is_some(),
        "the admitted pending record is cached"
    );
    assert_eq!(
        state.peek_naming_handle(&terminal_id).as_deref(),
        Some(handle.as_str()),
        "the REST door retains the handle for the bind lane"
    );
}

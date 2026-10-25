//! Name reliability (Task 10): a managed facade row presents its MODE label —
//! never the hard-coded "Shell" — until the naming bind overwrites it with
//! the saved name, and a binding that moves away from its cached record can
//! drop that cache. Headless: no PTY, no async runtime.
use super::*;
use std::task::{Context, Poll, Waker};

fn immediate<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("headless test future unexpectedly waited"),
    }
}

fn opencode_soul(terminal_id: &str) -> ManagedTerminalDescriptor {
    ManagedTerminalDescriptor {
        soul_id: format!("soul-{terminal_id}"),
        incarnation_id: format!("incarnation-{terminal_id}"),
        terminal_id: terminal_id.to_string(),
        stream_id: format!("S-{terminal_id}"),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: Some("ses_soul".into()),
        create_request_id: Some(format!("req-{terminal_id}")),
    }
}

/// The supervisor's inventory after a web restart: lookup answers the soul.
struct InventoryController {
    soul: ManagedTerminalDescriptor,
}

impl ManagedTerminalController for InventoryController {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        let found = (terminal_id == self.soul.terminal_id).then(|| self.soul.clone());
        Box::pin(std::future::ready(Ok(found)))
    }
    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        panic!("adoption must never launch a provider")
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("adoption must never replay input")
    }
    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("adoption must never resize")
    }
    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("adoption must never stop a provider")
    }
    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        panic!("adoption must never read output")
    }
}

#[test]
fn register_managed_titles_an_agent_row_with_the_passed_mode_label() {
    let registry = TerminalRegistry::new();
    registry.register_managed(opencode_soul("T-label"), "OpenCode".to_string());
    assert_eq!(
        registry.title_of("T-label").as_deref(),
        Some("OpenCode"),
        "an agent facade presents its mode label, never Shell"
    );
}

#[test]
fn register_managed_through_reconcile_adoption_titles_from_the_mode_label() {
    let registry = TerminalRegistry::new();
    registry.set_managed_controller(Some(Arc::new(InventoryController {
        soul: opencode_soul("T-adopted"),
    })));
    let mut labelled_modes = Vec::new();
    let adopted = immediate(registry.adopt_managed_for_reconcile(
        "T-adopted",
        Some("req-T-adopted".into()),
        |mode| {
            labelled_modes.push(mode.to_string());
            "OpenCode".to_string()
        },
    ))
    .expect("lookup succeeds");
    assert!(adopted, "the soul is reconstructed");
    assert_eq!(labelled_modes, vec!["opencode".to_string()]);
    assert_eq!(registry.title_of("T-adopted").as_deref(), Some("OpenCode"));
}

#[test]
fn register_managed_row_drops_a_moved_binding_cache_back_to_the_fallback_title() {
    let registry = TerminalRegistry::new();
    registry.register_managed(opencode_soul("T-moved"), "OpenCode".to_string());
    let record = freshell_protocol::session_names::SessionNameRecord {
        name_ref: freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Opencode,
            session_id: "ses_old".into(),
        },
        name: "Old conversation".into(),
        source: freshell_protocol::session_names::NameSource::Manual,
        revision: 2,
        manual_revision: Some(2),
        renamed_at: None,
        legacy_origin: None,
    };
    registry.update_session_name("T-moved", &record);
    assert_eq!(
        registry.title_of("T-moved").as_deref(),
        Some("Old conversation")
    );

    registry.clear_session_name("T-moved", "OpenCode");

    assert!(
        registry.session_name_of("T-moved").is_none(),
        "the moved row no longer advertises the old session's record"
    );
    assert_eq!(registry.title_of("T-moved").as_deref(), Some("OpenCode"));
}

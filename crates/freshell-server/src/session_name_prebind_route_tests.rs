//! Real-store twins of the legacy pre-bind rename compatibility cases.

use super::*;

const PROSPECTIVE: &str = "88888888-9999-4aaa-8bbb-cccccccc0071";

fn prebind_router(names: &Arc<SessionNames>, pending: Option<&str>) -> Router {
    let registry = freshell_terminal::TerminalRegistry::new();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "prebind".into(),
        stream_id: "prebind-stream".into(),
        mode: "claude".into(),
        resume_session_id: Some(PROSPECTIVE.into()),
        create_request_id: None,
        created_at: None,
    });
    if let Some(handle) = pending {
        registry.set_naming(
            "prebind",
            Some(SessionNameRef::Pending { id: handle.into() }),
            Some(handle.into()),
        );
    }
    fresh_router_with_registry(
        names,
        json!({
            "kind": "terminal", "mode": "claude", "terminalId": "prebind",
            "sessionRef": { "provider": "claude", "sessionId": PROSPECTIVE },
        }),
        Some(registry),
    )
}

fn prospective_ref() -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: PROSPECTIVE.into(),
    }
}

#[tokio::test]
async fn legacy_session_capture_renames_its_unspent_pending_record_before_materialization() {
    let home = temp_home();
    let names = names_state(&home).names;
    let pending = admit_pending(
        &names,
        "legacy-prebind",
        NamedProvider::Claude,
        Some("/work/prebind"),
    )
    .await;
    let (status, body) = patch(
        prebind_router(&names, Some("legacy-prebind")),
        "/api/panes/p1",
        json!({
            "name": "Keep before materialization", "nameIntent": "user",
            "expectedNameRef": prospective_ref(), "ifRevision": pending.record.revision,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let update: SessionNameUpdate =
        serde_json::from_value(body["data"]["sessionName"].clone()).unwrap();
    assert_eq!(update.record.name_ref, pending.record.name_ref);
    assert_eq!(update.record.name, "Keep before materialization");
    assert_eq!(update.record.source, NameSource::Manual);
    assert!(
        names.get(vec![prospective_ref()]).await.unwrap().is_empty(),
        "a prospective id must not be admitted durably"
    );
    let bound = bind_verified(&names, "legacy-prebind", NamedProvider::Claude, PROSPECTIVE).await;
    assert_eq!(bound.record.name, update.record.name);
    assert_eq!(bound.record.source, NameSource::Manual);
    std::fs::remove_dir_all(home).ok();
}

#[tokio::test]
async fn an_unbound_prospective_pane_never_admits_a_durable_name_on_rename() {
    let home = temp_home();
    let names = names_state(&home).names;
    for uri in ["/api/panes/p1", "/api/tabs/t1"] {
        let (status, body) = patch(
            prebind_router(&names, None),
            uri,
            json!({"name": "Nothing to name", "nameIntent": "user"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"], "NAME_NOT_FOUND");
        assert!(names.get(vec![prospective_ref()]).await.unwrap().is_empty());
    }
    std::fs::remove_dir_all(home).ok();
}

#[tokio::test]
async fn a_legacy_prebind_shape_never_renames_a_handle_spent_on_another_session() {
    let home = temp_home();
    let names = names_state(&home).names;
    admit_pending(
        &names,
        "spent-legacy",
        NamedProvider::Claude,
        Some("/work/prebind"),
    )
    .await;
    let old = bind_verified(
        &names,
        "spent-legacy",
        NamedProvider::Claude,
        "previous-conversation",
    )
    .await;
    let (status, body) = patch(
        prebind_router(&names, Some("spent-legacy")),
        "/api/panes/p1",
        json!({
            "name": "Must not name the ancestor", "nameIntent": "user",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        names.get(vec![old.record.name_ref.clone()]).await.unwrap()[0].record,
        old.record
    );
    assert!(names.get(vec![prospective_ref()]).await.unwrap().is_empty());
    std::fs::remove_dir_all(home).ok();
}

#[tokio::test]
async fn modern_pending_capture_keeps_registry_authority_while_legacy_layout_lags() {
    let home = temp_home();
    let names = names_state(&home).names;
    let pending = admit_pending(
        &names,
        "modern-prebind",
        NamedProvider::Claude,
        Some("/work/prebind"),
    )
    .await;
    // The transcript can be indexed before its pending bind. The modern
    // editor still names its own pending record, preserving the CAS target.
    let indexed = names
        .ensure_session(prospective_ref(), Some("/work/indexed".into()))
        .await
        .unwrap();
    let (status, body) = patch(
        prebind_router(&names, Some("modern-prebind")),
        "/api/panes/p1",
        json!({
            "name": "Modern prebind name", "nameIntent": "user",
            "expectedNameRef": pending.record.name_ref, "ifRevision": pending.record.revision,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let actual_pending = names
        .get(vec![pending.record.name_ref.clone()])
        .await
        .unwrap();
    assert_eq!(actual_pending[0].record.name, "Modern prebind name");
    assert_eq!(actual_pending[0].record.source, NameSource::Manual);
    assert_eq!(
        names.get(vec![prospective_ref()]).await.unwrap()[0].record,
        indexed.record,
        "a modern pending capture must not rename the indexed session before the bind"
    );
    std::fs::remove_dir_all(home).ok();
}

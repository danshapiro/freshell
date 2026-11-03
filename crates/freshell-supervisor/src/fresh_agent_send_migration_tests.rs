#[tokio::test]
async fn send_refusal_journal_migration_preserves_older_queued_input_and_reopens() {
    let root = tempfile::tempdir().unwrap();
    let registry_path = root.path().join("registry");
    let registry = Registry::open(&registry_path, None).unwrap();
    let soul = SoulId::new();
    let prepared = materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let request = RequestId::parse("pre-migration-input").unwrap();
    let (before, _) = registry
        .begin_fresh_input(soul.clone(), request.clone(), b"owned input", b"null", None)
        .await
        .unwrap();
    assert_eq!(before, InputJournalDisposition::Dispatch);
    let database = registry.database_path().to_owned();
    drop(registry);
    let old = Connection::open(&database).unwrap();
    old.execute_batch("ALTER TABLE input_commands DROP COLUMN fresh_agent_send_refusal; UPDATE installation SET schema_version=19 WHERE singleton=1;").unwrap();
    drop(old);

    let migrated = Registry::open(&registry_path, None).unwrap();
    let (after, incarnation) = migrated
        .begin_fresh_input(soul.clone(), request.clone(), b"owned input", b"null", None)
        .await
        .unwrap();
    assert_eq!(after, InputJournalDisposition::Dispatch);
    assert_eq!(incarnation, prepared.incarnation_id);
    let connection = Connection::open(&database).unwrap();
    let rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            params![soul.as_str(), request.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "migration must not duplicate the queued input");
    let version: u32 = connection
        .query_row(
            "SELECT schema_version FROM installation WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
}

#[tokio::test]
async fn send_refusal_remains_exact_after_registry_reopen_without_reissuing_input() {
    use freshell_runtime_protocol::{FreshAgentSendDiagnostic, FreshAgentSendDiagnosticOutcome};
    let root = tempfile::tempdir().unwrap();
    let registry_path = root.path().join("registry");
    let registry = Registry::open(&registry_path, None).unwrap();
    let soul = SoulId::new();
    materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let request = RequestId::parse("durably-refused-input").unwrap();
    registry
        .begin_fresh_input(soul.clone(), request.clone(), b"owned input", b"null", None)
        .await
        .unwrap();
    registry
        .mark_input_dispatching(soul.clone(), request.clone())
        .await
        .unwrap();
    let diagnostic = FreshAgentSendDiagnostic {
        outcome: FreshAgentSendDiagnosticOutcome::Refused,
        message: Some("already-published provider refusal".into()),
    };
    registry
        .mark_fresh_input_refused(soul.clone(), request.clone(), diagnostic.clone())
        .await
        .unwrap();
    drop(registry);
    let reopened = Registry::open(&registry_path, None).unwrap();
    assert_eq!(
        reopened
            .recorded_input_outcome(soul.clone(), request.clone(), b"owned input", Some(b"null"))
            .await
            .unwrap(),
        Some(InputJournalDisposition::Refused(diagnostic.clone()))
    );
    let (replayed, _) = reopened
        .begin_fresh_input(soul.clone(), request.clone(), b"owned input", b"null", None)
        .await
        .unwrap();
    assert_eq!(replayed, InputJournalDisposition::Refused(diagnostic));
    assert!(matches!(
        reopened
            .recorded_input_outcome(soul, request, b"changed input", Some(b"null"))
            .await,
        Err(RegistryError::InputConflict)
    ));
}

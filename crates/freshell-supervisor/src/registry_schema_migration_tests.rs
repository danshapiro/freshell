use crate::registry::{
    tests::materialize_fresh_runtime, InputJournalDisposition, Registry, SCHEMA_VERSION,
};
use freshell_runtime_protocol::{
    FreshAgentSendDiagnostic, FreshAgentSendDiagnosticOutcome, RequestId, SoulId,
};
use rusqlite::{params, Connection};

fn has_column(connection: &Connection, table: &str, column: &str) -> bool {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let found = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|name| name.unwrap() == column);
    found
}

fn assert_merged_schema_columns(connection: &Connection) {
    assert!(has_column(
        connection,
        "incarnations",
        "native_readiness_receipt"
    ));
    assert!(has_column(
        connection,
        "input_commands",
        "fresh_agent_send_refusal"
    ));
    assert!(has_column(
        connection,
        "input_commands",
        "codex_dispatch_recovery_receipt"
    ));
}

fn assert_current_schema(connection: &Connection) {
    let version: u32 = connection
        .query_row(
            "SELECT schema_version FROM installation WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(SCHEMA_VERSION, 22);
    assert_eq!(version, SCHEMA_VERSION);
    assert_merged_schema_columns(connection);
}

#[tokio::test]
async fn schema_19_migrates_through_both_columns_without_losing_rows() {
    let root = tempfile::tempdir().unwrap();
    let registry_path = root.path().join("registry");
    let registry = Registry::open(&registry_path, None).unwrap();
    let soul = SoulId::new();
    let prepared = materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let request = RequestId::parse("schema-19-layout").unwrap();
    let (disposition, _) = registry
        .begin_fresh_input(
            soul.clone(),
            request.clone(),
            b"preserved schema-19 input",
            b"null",
            None,
        )
        .await
        .unwrap();
    assert_eq!(disposition, InputJournalDisposition::Dispatch);
    let database = registry.database_path().to_owned();
    drop(registry);

    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let installation_id: String = connection
        .query_row(
            "SELECT installation_id FROM installation WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute_batch(
            "ALTER TABLE incarnations DROP COLUMN native_readiness_receipt;
             ALTER TABLE input_commands DROP COLUMN fresh_agent_send_refusal;
             UPDATE installation SET schema_version=19 WHERE singleton=1;",
        )
        .unwrap();
    drop(connection);

    let migrated = Registry::open(&registry_path, None).unwrap();
    drop(migrated);
    let reopened = Registry::open(&registry_path, None).unwrap();
    drop(reopened);

    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let (persisted_installation_id, soul_count, incarnation_count, payload): (
        String,
        i64,
        i64,
        Vec<u8>,
    ) = connection
        .query_row(
            "SELECT installation_id,
                    (SELECT COUNT(*) FROM souls WHERE soul_id=?1),
                    (SELECT COUNT(*) FROM incarnations WHERE incarnation_id=?2 AND soul_id=?1),
                    (SELECT protected_payload FROM input_commands WHERE soul_id=?1 AND request_id=?3)
             FROM installation WHERE singleton=1",
            params![soul.as_str(), prepared.incarnation_id.as_str(), request.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(persisted_installation_id, installation_id);
    assert_eq!(soul_count, 1);
    assert_eq!(incarnation_count, 1);
    assert_eq!(payload, b"preserved schema-19 input");
}

#[tokio::test]
async fn schema_20_receipt_layout_migrates_without_losing_receipt_or_queued_input() {
    let root = tempfile::tempdir().unwrap();
    let registry_path = root.path().join("registry");
    let registry = Registry::open(&registry_path, None).unwrap();
    let soul = SoulId::new();
    let prepared = materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let request = RequestId::parse("schema-20-receipt-layout").unwrap();
    let (disposition, _) = registry
        .begin_fresh_input(
            soul.clone(),
            request.clone(),
            b"preserved queued input",
            b"null",
            None,
        )
        .await
        .unwrap();
    assert_eq!(disposition, InputJournalDisposition::Dispatch);
    let database = registry.database_path().to_owned();
    drop(registry);

    // A schema-20 database produced by the feature branch has the receipt
    // column but predates the refusal column.
    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let installation_id: String = connection
        .query_row(
            "SELECT installation_id FROM installation WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let receipt = r#"{"savedFrom":"schema-20-receipt-layout"}"#;
    connection
        .execute(
            "UPDATE incarnations SET native_readiness_receipt=?1 WHERE incarnation_id=?2",
            params![receipt, prepared.incarnation_id.as_str()],
        )
        .unwrap();
    connection
        .execute_batch(
            "ALTER TABLE input_commands DROP COLUMN fresh_agent_send_refusal;
             UPDATE installation SET schema_version=20 WHERE singleton=1;",
        )
        .unwrap();
    drop(connection);

    let migrated = Registry::open(&registry_path, None).unwrap();
    drop(migrated);
    let reopened = Registry::open(&registry_path, None).unwrap();
    drop(reopened);
    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let (version, persisted_installation_id): (u32, String) = connection
        .query_row(
            "SELECT schema_version,installation_id FROM installation WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    assert_eq!(persisted_installation_id, installation_id);

    let persisted_receipt: String = connection
        .query_row(
            "SELECT native_readiness_receipt FROM incarnations WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted_receipt, receipt);
    let (saved_soul, payload, command_count): (String, Vec<u8>, i64) = connection
        .query_row(
            "SELECT soul_id,protected_payload,(SELECT COUNT(*) FROM input_commands WHERE soul_id=?1) FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            params![soul.as_str(), request.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(saved_soul, soul.as_str());
    assert_eq!(payload, b"preserved queued input");
    assert_eq!(command_count, 1, "migration must not duplicate input rows");
}

#[tokio::test]
async fn schema_20_refusal_layout_migrates_without_losing_refusal_or_existing_rows() {
    let root = tempfile::tempdir().unwrap();
    let registry_path = root.path().join("registry");
    let registry = Registry::open(&registry_path, None).unwrap();
    let soul = SoulId::new();
    let prepared = materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let request = RequestId::parse("schema-20-refusal-layout").unwrap();
    let (disposition, _) = registry
        .begin_fresh_input(
            soul.clone(),
            request.clone(),
            b"preserved refused input",
            b"null",
            None,
        )
        .await
        .unwrap();
    assert_eq!(disposition, InputJournalDisposition::Dispatch);
    registry
        .mark_input_dispatching(soul.clone(), request.clone())
        .await
        .unwrap();
    let diagnostic = FreshAgentSendDiagnostic {
        outcome: FreshAgentSendDiagnosticOutcome::Refused,
        message: Some("existing schema-20 refusal".into()),
    };
    registry
        .mark_fresh_input_refused(soul.clone(), request.clone(), diagnostic.clone())
        .await
        .unwrap();
    let database = registry.database_path().to_owned();
    drop(registry);

    // An upstream schema-20 database has the refusal column but predates the
    // native-readiness receipt column.
    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let installation_id: String = connection
        .query_row(
            "SELECT installation_id FROM installation WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute_batch(
            "ALTER TABLE incarnations DROP COLUMN native_readiness_receipt;
             UPDATE installation SET schema_version=20 WHERE singleton=1;",
        )
        .unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_schema_21_upgrade
             BEFORE UPDATE OF schema_version ON installation
             WHEN NEW.schema_version=21
             BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;",
        )
        .unwrap();
    drop(connection);

    // The schema update failure must roll back the column addition too, so a
    // later open can retry the complete migration from version 20.
    assert!(Registry::open(&registry_path, None).is_err());
    let connection = Connection::open(&database).unwrap();
    let version: u32 = connection
        .query_row(
            "SELECT schema_version FROM installation WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 20);
    assert!(!has_column(
        &connection,
        "incarnations",
        "native_readiness_receipt"
    ));
    assert!(has_column(
        &connection,
        "input_commands",
        "fresh_agent_send_refusal"
    ));
    connection
        .execute_batch("DROP TRIGGER fail_schema_21_upgrade;")
        .unwrap();
    drop(connection);

    let migrated = Registry::open(&registry_path, None).unwrap();
    assert_eq!(
        migrated
            .recorded_input_outcome(
                soul.clone(),
                request.clone(),
                b"preserved refused input",
                Some(b"null"),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Refused(diagnostic.clone()))
    );
    drop(migrated);
    let reopened = Registry::open(&registry_path, None).unwrap();
    drop(reopened);
    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let (version, persisted_installation_id): (u32, String) = connection
        .query_row(
            "SELECT schema_version,installation_id FROM installation WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    assert_eq!(persisted_installation_id, installation_id);

    let (saved_soul, payload, state, refusal): (String, Vec<u8>, String, String) = connection
        .query_row(
            "SELECT soul_id,protected_payload,state,fresh_agent_send_refusal FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            params![soul.as_str(), request.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(saved_soul, soul.as_str());
    assert_eq!(payload, b"preserved refused input");
    assert_eq!(state, "refused");
    assert_eq!(
        serde_json::from_str::<FreshAgentSendDiagnostic>(&refusal).unwrap(),
        diagnostic
    );
    let incarnation_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM incarnations WHERE incarnation_id=?1 AND soul_id=?2",
            params![prepared.incarnation_id.as_str(), soul.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        incarnation_count, 1,
        "migration must preserve incarnation rows"
    );
}

#[tokio::test]
async fn schema_21_adds_receipt_marker_without_reclassifying_existing_inputs() {
    let root = tempfile::tempdir().unwrap();
    let registry_path = root.path().join("registry");
    let registry = Registry::open(&registry_path, None).unwrap();
    let soul = SoulId::new();
    let prepared = materialize_fresh_runtime(&registry, soul.clone(), root.path()).await;
    let request = RequestId::parse("schema-21-receipt-marker").unwrap();
    let (disposition, _) = registry
        .begin_fresh_input(
            soul.clone(),
            request.clone(),
            b"previously ambiguous ordinary input",
            b"null",
            None,
        )
        .await
        .unwrap();
    assert_eq!(disposition, InputJournalDisposition::Dispatch);
    registry
        .mark_input_dispatching(soul.clone(), request.clone())
        .await
        .unwrap();
    let database = registry.database_path().to_owned();
    drop(registry);

    // Schema 21 predates source-bound receipt tracking. Preserve the old
    // ambiguous row, but default it to untracked so it cannot block recovery.
    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    connection
        .execute(
            "UPDATE input_commands SET state='ambiguous' WHERE soul_id=?1 AND request_id=?2",
            params![soul.as_str(), request.as_str()],
        )
        .unwrap();
    connection
        .execute_batch(
            "ALTER TABLE input_commands DROP COLUMN codex_dispatch_recovery_receipt;
             UPDATE installation SET schema_version=21 WHERE singleton=1;",
        )
        .unwrap();
    drop(connection);

    let migrated = Registry::open(&registry_path, None).unwrap();
    assert_eq!(
        migrated
            .unresolved_codex_dispatch_recovery_receipt_count(
                soul.clone(),
                prepared.incarnation_id.clone(),
            )
            .await
            .unwrap(),
        0,
        "preexisting ambiguous rows must not be treated as receipt-bearing sends"
    );
    drop(migrated);

    let connection = Connection::open(&database).unwrap();
    assert_current_schema(&connection);
    let marker: i64 = connection
        .query_row(
            "SELECT codex_dispatch_recovery_receipt FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            params![soul.as_str(), request.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, 0);
}

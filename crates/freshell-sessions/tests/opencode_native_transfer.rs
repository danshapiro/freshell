//! Synthetic compatibility tests for lossless, exact-session OpenCode exports.
//!
//! These fixtures model the pinned OpenCode schema without opening a user's
//! provider database. The bundle is decoded in-test so its actual serialized
//! rows, rather than only manifest metadata, are checked for exact scope.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use freshell_sessions::opencode_transfer::{
    export_exact_session, recover_interrupted_extractions, ExportOptions, HostOpenCodeInventory,
    TransferError,
};
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

const TEST_MIGRATIONS: &[&str] = &[
    "20260127222353_familiar_lady_ursula",
    "20260211171708_add_project_commands",
    "20260213144116_wakeful_the_professor",
    "20260225215848_workspace",
    "20260227213759_add_session_workspace_id",
    "20260228203230_blue_harpoon",
    "20260303231226_add_workspace_fields",
    "20260309230000_move_org_to_state",
    "20260312043431_session_message_cursor",
    "20260323234822_events",
    "20260410174513_workspace-name",
    "20260413175956_chief_energizer",
    "20260423070820_add_icon_url_override",
    "20260427172553_slow_nightmare",
    "20260428004200_add_session_path",
    "20260501142318_next_venus",
    "20260504145000_add_sync_owner",
    "20260507164347_add_workspace_time",
    "20260510033149_session_usage",
    "20260511000411_data_migration_state",
    "20260511173437_session-metadata",
    "20260601010001_normalize_storage_paths",
    "20260601202201_amazing_prowler",
    "20260602002951_lowly_union_jack",
    "20260602182828_add_project_directories",
    "20260603001617_session_message_projection_indexes",
    "20260603040000_session_message_projection_order",
    "20260603141458_session_input_inbox",
    "20260603160727_jittery_ezekiel_stane",
    "20260604172448_event_sourced_session_input",
    "20260605003541_add_session_context_snapshot",
    "20260605042240_add_context_epoch_agent",
    "20260611035744_credential",
    "20260611192811_lush_chimera",
    "20260612174303_project_dir_strategy",
    "20260622142730_simplify_session_context_epoch",
    "20260622170816_reset_v2_session_state",
    "20260622202450_simplify_session_input",
];

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "freshell-opencode-native-transfer-{label}-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&path).expect("create synthetic fixture directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn create_synthetic_source(database: &Path) -> Connection {
    let connection = Connection::open(database).expect("open synthetic source");
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .expect("configure synthetic provider database");
    connection
        .execute_batch(include_str!("../src/opencode_schema_v1_18_21.sql"))
        .expect("create pinned OpenCode v1.18.21 schema");
    connection
        .execute_batch(
            "-- Test-fixture helpers outside upstream OpenCode's schema.
             CREATE TABLE message_seq (session_id TEXT PRIMARY KEY, next INTEGER NOT NULL);
             CREATE TABLE provider_config (id TEXT PRIMARY KEY, value TEXT);",
        )
        .expect("create synthetic provider schema");

    for (index, migration) in TEST_MIGRATIONS.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO migration (id, time_completed) VALUES (?1, ?2)",
                params![migration, index as i64 + 100],
            )
            .unwrap();
    }

    connection
        .execute(
            "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
             VALUES ('prj_kept', '/synthetic/worktree', 1, 1, '[]')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO workspace (id, type, name, project_id, time_used)
             VALUES ('wrk_kept', 'directory', 'workspace', 'prj_kept', 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO project_directory (project_id, directory, time_created)
             VALUES ('prj_kept', '/synthetic/worktree', 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO permission
             (id, project_id, action, resource, time_created, time_updated)
             VALUES ('perm_kept', 'prj_kept', 'read', '*', 1, 1)",
            [],
        )
        .unwrap();

    for (id, parent, title, created) in [
        ("ses_root", None, "root title", 1_i64),
        ("ses_child", Some("ses_root"), "child title", 2_i64),
        (
            "ses_grandchild",
            Some("ses_child"),
            "grandchild title",
            3_i64,
        ),
        ("ses_unrelated", None, "UNRELATED_SESSION_SENTINEL", 4_i64),
    ] {
        connection
            .execute(
                "INSERT INTO session
                 (id, project_id, workspace_id, parent_id, slug, directory, title, version,
                  time_created, time_updated, metadata, revert, permission)
                 VALUES (?1, 'prj_kept', 'wrk_kept', ?2, 'slug', '/synthetic/worktree', ?3,
                         '1.18.21', ?4, ?4, '{\"opaque\":\"OPAQUE_ROW_SENTINEL\"}', NULL, NULL)",
                params![id, parent, title, created],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data)
                 VALUES (?1, ?2, ?3, ?3, ?4)",
                params![
                    format!("msg_{id}"),
                    id,
                    created,
                    format!("{{\"role\":\"user\",\"opaque\":\"{id}_MESSAGE_SENTINEL\"}}"),
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                params![
                    format!("part_{id}"),
                    format!("msg_{id}"),
                    id,
                    created,
                    format!("{{\"type\":\"text\",\"text\":\"{id}_PART_SENTINEL\"}}"),
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message_seq (session_id, next) VALUES (?1, 17)",
                [id],
            )
            .unwrap();
    }

    connection
        .execute(
            "INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES ('ses_root', 1, 'root-owner')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO event (id, aggregate_id, seq, type, data)
             VALUES ('evt_root', 'ses_root', 1, 'session.created', '{\"opaque\":\"EVENT_SENTINEL\"}')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_message
             (id, session_id, type, seq, time_created, time_updated, data)
             VALUES ('v2_root', 'ses_root', 'user', 1, 10, 10, '{\"opaque\":\"V2_MESSAGE_SENTINEL\"}')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_input
             (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
             VALUES ('input_root', 'ses_root', '{\"parts\":[]}', 'pending', 2, NULL, 11)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq)
             VALUES ('ses_root', 'baseline', '{\"opaque\":\"CONTEXT_SENTINEL\"}', 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
             VALUES ('ses_root', 'todo sentinel', 'pending', 'high', 1, 12, 12)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO account
             (id, email, url, access_token, refresh_token, time_created, time_updated)
             VALUES ('account_1', 'account@example.invalid', 'https://account.invalid',
                     'ACCOUNT_TOKEN_SENTINEL', 'ACCOUNT_REFRESH_SENTINEL', 1, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO credential
             (id, label, value, time_created, time_updated)
             VALUES ('credential_1', 'credential', 'CREDENTIAL_VALUE_SENTINEL', 1, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO provider_config VALUES ('provider_1', 'PROVIDER_CONFIG_SENTINEL')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO control_account
             (email, url, access_token, refresh_token, active, time_created, time_updated)
             VALUES ('control@example.invalid', 'https://control.invalid',
                     'CONTROL_ACCOUNT_SENTINEL', 'CONTROL_REFRESH_SENTINEL', 1, 1, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_share
             (session_id, id, secret, url, time_created, time_updated)
             VALUES ('ses_unrelated', 'share_1', 'SESSION_SHARE_SENTINEL',
                     'https://share.invalid', 1, 1)",
            [],
        )
        .unwrap();

    connection
}

#[test]
fn exports_exact_recursive_native_closure_and_omits_account_and_derived_rows() {
    let fixture = TestDir::new("exact-closure");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let original_session_count: i64 = source
        .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
        .unwrap();
    let original_account_token: String = source
        .query_row("SELECT access_token FROM account", [], |row| row.get(0))
        .unwrap();

    let inventory = HostOpenCodeInventory::new(fixture.path().join("default.db"))
        .with_channel_database(database.clone());
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("complete native root can be exported");
    let mut payload = String::new();
    snapshot
        .open_payload()
        .expect("open exact serialized payload")
        .read_to_string(&mut payload)
        .expect("read synthetic payload");
    let decoded: Value = serde_json::from_str(&payload).expect("decode serialized bundle");

    let sessions: Vec<&str> = decoded["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["table"] == "session")
        .map(|row| row["values"]["id"]["value"].as_str().unwrap())
        .collect();
    assert_eq!(sessions, ["ses_root", "ses_child", "ses_grandchild"]);
    let message_ids: Vec<&str> = decoded["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["table"] == "message")
        .map(|row| row["values"]["id"]["value"].as_str().unwrap())
        .collect();
    assert_eq!(
        message_ids,
        ["msg_ses_root", "msg_ses_child", "msg_ses_grandchild"]
    );
    for sentinel in [
        "UNRELATED_SESSION_SENTINEL",
        "ses_unrelated_MESSAGE_SENTINEL",
        "ses_unrelated_PART_SENTINEL",
        "ACCOUNT_TOKEN_SENTINEL",
        "ACCOUNT_REFRESH_SENTINEL",
        "CREDENTIAL_VALUE_SENTINEL",
        "CONTROL_ACCOUNT_SENTINEL",
        "CONTROL_REFRESH_SENTINEL",
        "SESSION_SHARE_SENTINEL",
        "PROVIDER_CONFIG_SENTINEL",
        "message_seq",
    ] {
        assert!(
            !payload.contains(sentinel),
            "serialized transfer payload must exclude {sentinel}"
        );
    }
    for sentinel in [
        "ses_root_MESSAGE_SENTINEL",
        "ses_child_PART_SENTINEL",
        "OPAQUE_ROW_SENTINEL",
        "EVENT_SENTINEL",
        "V2_MESSAGE_SENTINEL",
        "CONTEXT_SENTINEL",
    ] {
        assert!(
            payload.contains(sentinel),
            "native opaque data {sentinel} is preserved"
        );
    }
    assert_eq!(snapshot.manifest().root_session_id, "ses_root");
    assert_eq!(
        snapshot.manifest().row_count(),
        decoded["rows"].as_array().unwrap().len()
    );
    let table_counts: std::collections::BTreeMap<String, usize> = decoded["rows"]
        .as_array()
        .unwrap()
        .iter()
        .fold(std::collections::BTreeMap::new(), |mut counts, row| {
            *counts
                .entry(row["table"].as_str().unwrap().to_string())
                .or_default() += 1;
            counts
        });
    assert_eq!(
        table_counts,
        [
            ("event".to_string(), 1),
            ("event_sequence".to_string(), 1),
            ("message".to_string(), 3),
            ("part".to_string(), 3),
            ("permission".to_string(), 1),
            ("project".to_string(), 1),
            ("project_directory".to_string(), 1),
            ("session".to_string(), 3),
            ("session_context_epoch".to_string(), 1),
            ("session_input".to_string(), 1),
            ("session_message".to_string(), 1),
            ("todo".to_string(), 1),
            ("workspace".to_string(), 1),
        ]
        .into_iter()
        .collect()
    );
    let manifest = serde_json::to_value(snapshot.manifest()).unwrap();
    for (index, row) in decoded["rows"].as_array().unwrap().iter().enumerate() {
        let row_bytes = serde_json::to_vec(row).unwrap();
        let expected_hash = format!("{:x}", Sha256::digest(row_bytes));
        assert_eq!(manifest["rows"][index]["table"], row["table"]);
        assert_eq!(manifest["rows"][index]["key"], row["key"]);
        assert_eq!(manifest["rows"][index]["sha256"], expected_hash);
    }
    assert_eq!(manifest["payload_bytes"], payload.len() as u64);
    assert_eq!(
        manifest["payload_sha256"],
        format!("{:x}", Sha256::digest(payload.as_bytes()))
    );
    let mut generation_input = manifest.clone();
    generation_input["generation"] = Value::String(String::new());
    assert_eq!(
        manifest["generation"],
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&generation_input).unwrap())
        )
    );
    assert_eq!(
        source
            .query_row("SELECT COUNT(*) FROM session", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        original_session_count,
        "export does not logically change the host database"
    );
    assert_eq!(
        source
            .query_row("SELECT access_token FROM account", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        original_account_token,
        "export leaves host credentials unchanged"
    );
    let credential_value: String = source
        .query_row("SELECT value FROM credential", [], |row| row.get(0))
        .unwrap();
    assert_eq!(credential_value, "CREDENTIAL_VALUE_SENTINEL");
}

#[test]
fn exports_distinct_manifest_keys_for_each_selected_context_epoch() {
    let fixture = TestDir::new("context-epoch-keys");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    for session_id in ["ses_child", "ses_grandchild"] {
        source
            .execute(
                "INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq)
                 VALUES (?1, 'baseline', ?2, 1)",
                params![session_id, format!("{{\"session\":\"{session_id}\"}}")],
            )
            .unwrap();
    }
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("context epochs for selected descendants are exported");

    let keys = snapshot
        .manifest()
        .row_digests()
        .iter()
        .filter(|row| row.table == "session_context_epoch")
        .map(|row| serde_json::to_value(&row.key).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        [
            serde_json::json!([{"type":"text","value":"ses_root"}]),
            serde_json::json!([{"type":"text","value":"ses_child"}]),
            serde_json::json!([{"type":"text","value":"ses_grandchild"}]),
        ]
    );
}

#[test]
fn blocks_selected_rows_with_incomplete_primary_keys_without_publishing_a_bundle() {
    let fixture = TestDir::new("missing-selected-primary-key");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "INSERT INTO permission
             (id, project_id, action, resource, time_created, time_updated)
             VALUES (NULL, 'prj_kept', 'read', 'missing-key', 2, 2)",
            [],
        )
        .unwrap();
    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a selected row without its complete primary key must remain unresolved"
    );
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
}

fn assert_non_text_selected_json_value_blocks_without_mutating_source(
    label: &str,
    invalid_value: rusqlite::types::Value,
    expected_storage_class: &str,
) {
    let fixture = TestDir::new(label);
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let source = if expected_storage_class == "integer" {
        drop(source);
        set_part_data_to_integer_storage_class(&database);
        Connection::open(&database).unwrap()
    } else {
        source
            .execute(
                "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
                [invalid_value],
            )
            .unwrap();
        source
    };
    let before: (String, String) = source
        .query_row(
            "SELECT typeof(data), quote(data) FROM part WHERE id = 'part_ses_root'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before.0, expected_storage_class);

    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "selected JSON columns stored as {expected_storage_class} must remain unresolved"
    );
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
    let after: (String, String) = source
        .query_row(
            "SELECT typeof(data), quote(data) FROM part WHERE id = 'part_ses_root'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(after, before, "export leaves the source row unchanged");
}

fn set_part_data_to_integer_storage_class(database: &Path) {
    // SQLite applies TEXT affinity on assignment, so create this synthetic
    // malformed row while the fixture schema temporarily has BLOB affinity.
    // Restore the exact pinned schema before the exporter opens the source.
    let change_part_data_affinity = |from: &str, to: &str| {
        let connection = Connection::open(database).unwrap();
        connection
            .execute_batch("PRAGMA writable_schema = ON;")
            .unwrap();
        let changed = connection
            .execute(
                "UPDATE sqlite_master SET sql = replace(sql, ?1, ?2)
                 WHERE type = 'table' AND name = 'part'",
                params![from, to],
            )
            .unwrap();
        assert_eq!(changed, 1, "the synthetic part schema is present");
        drop(connection);
    };

    change_part_data_affinity("`data` text NOT NULL", "`data` BLOB NOT NULL");
    let connection = Connection::open(database).unwrap();
    connection
        .execute("UPDATE part SET data = 42 WHERE id = 'part_ses_root'", [])
        .unwrap();
    let storage_class: String = connection
        .query_row(
            "SELECT typeof(data) FROM part WHERE id = 'part_ses_root'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(storage_class, "integer");
    drop(connection);
    change_part_data_affinity("`data` BLOB NOT NULL", "`data` text NOT NULL");
}

#[test]
fn blocks_blob_values_in_selected_json_columns() {
    assert_non_text_selected_json_value_blocks_without_mutating_source(
        "blob-json-column",
        rusqlite::types::Value::Blob(b"{}".to_vec()),
        "blob",
    );
}

#[test]
fn blocks_integer_values_in_selected_json_columns() {
    assert_non_text_selected_json_value_blocks_without_mutating_source(
        "integer-json-column",
        rusqlite::types::Value::Integer(42),
        "integer",
    );
}

#[test]
fn blocks_sources_without_a_pinned_migration_journal() {
    let fixture = TestDir::new("missing-migration-journal");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source.execute_batch("DROP TABLE migration;").unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("default.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a database with no recognized migration journal must stay unresolved"
    );
}

#[test]
fn accepts_the_pinned_empty_data_migration_registry() {
    let fixture = TestDir::new("empty-data-migration-registry");
    let database = fixture.path().join("opencode.db");
    let _source = create_synthetic_source(&database);
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("pinned v1.18.21 has no registered data migrations");

    assert_eq!(snapshot.manifest().assets.len(), 0);
}

#[test]
fn blocks_unregistered_data_migration_rows() {
    let fixture = TestDir::new("unknown-data-migration");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "INSERT INTO data_migration (name, time_completed) VALUES ('future-session-rewrite', 999)",
            [],
        )
        .unwrap();
    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "unknown data migration state must not be certified as the pinned version"
    );
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
}

#[test]
fn blocks_an_incomplete_pinned_database_migration_set() {
    let fixture = TestDir::new("incomplete-migration-set");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "DELETE FROM migration WHERE id = ?1",
            [TEST_MIGRATIONS[TEST_MIGRATIONS.len() - 1]],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "missing one required v1.18.21 migration must block the snapshot"
    );
}

#[test]
fn blocks_unclassified_external_uris_in_native_file_parts() {
    let fixture = TestDir::new("unsupported-file-uri");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [r#"{"type":"file","url":"https://example.invalid/session-file"}"#],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("default.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "an external URI must not be silently carried as if its bytes were available"
    );
}

#[test]
fn blocks_missing_write_once_assets_without_publishing_a_bundle() {
    let fixture = TestDir::new("missing-tool-output");
    let data_home = fixture.path().join("provider");
    let tool_output_directory = data_home.join("tool-output");
    fs::create_dir_all(&tool_output_directory).unwrap();
    let missing_output = tool_output_directory.join("tool_missing");
    let database = data_home.join("opencode.db");
    let source = create_synthetic_source(&database);
    let data = serde_json::json!({
        "type":"file",
        "mime":"text/plain",
        "url":format!("file://{}", missing_output.display())
    })
    .to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [data],
        )
        .unwrap();
    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(matches!(result, Err(TransferError::Blocked(_))));
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
}

#[test]
fn blocks_unknown_sqlite_schema_tables() {
    let fixture = TestDir::new("unknown-schema");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute_batch("CREATE TABLE plugin_state (id TEXT PRIMARY KEY, body TEXT NOT NULL);")
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("default.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "plugin-owned tables must block until the closure resolver supports them"
    );
}

#[test]
fn blocks_unrecognized_columns_and_migration_ids() {
    let fixture = TestDir::new("unrecognized-ddl");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute_batch("ALTER TABLE session ADD COLUMN plugin_private TEXT;")
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("default.db"))
        .with_channel_database(database.clone());
    let schema_result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract-schema")),
    );
    assert!(matches!(schema_result, Err(TransferError::Blocked(_))));

    source
        .execute(
            "INSERT INTO migration (id, time_completed) VALUES ('20990101000000_future', 999)",
            [],
        )
        .unwrap();
    let migration_result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract-migration")),
    );
    assert!(matches!(migration_result, Err(TransferError::Blocked(_))));
}

#[test]
fn blocks_cross_owned_parts_and_session_workspace_links() {
    let fixture = TestDir::new("cross-owned-edges");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES ('part_cross_owned', 'msg_ses_root', 'ses_unrelated', 50, 50, '{}')",
            [],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database.clone());
    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("cross-part-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));

    source
        .execute_batch(
            "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
             VALUES ('prj_other', '/synthetic/other', 2, 2, '[]');
             INSERT INTO workspace (id, type, name, project_id, time_used)
             VALUES ('wrk_other', 'directory', 'other', 'prj_other', 2);
             UPDATE session SET project_id = 'prj_other', workspace_id = 'wrk_kept'
             WHERE id = 'ses_child';",
        )
        .unwrap();
    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("cross-workspace-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));
}

#[test]
fn blocks_unclassified_snapshot_shapes_in_revert_state() {
    let fixture = TestDir::new("unsupported-revert");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE session SET revert = ?1 WHERE id = 'ses_root'",
            [r#"{"snapshot":{"path":".git/objects/future"}}"#],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("extract")),
        ),
        Err(TransferError::Blocked(_))
    ));
}

#[test]
fn message_seq_is_omitted_only_for_its_pinned_derived_shape() {
    let fixture = TestDir::new("message-seq-shape");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database.clone());
    let valid = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("valid-extract")),
    )
    .unwrap();
    let mut valid_payload = String::new();
    valid
        .open_payload()
        .unwrap()
        .read_to_string(&mut valid_payload)
        .unwrap();
    assert!(!valid_payload.contains("message_seq"));

    source.execute_batch("DROP TABLE message_seq;").unwrap();
    source
        .execute_batch(
            "CREATE TABLE message_seq (
                session_id TEXT PRIMARY KEY, next INTEGER NOT NULL, provider_secret TEXT
             );",
        )
        .unwrap();
    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("invalid-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));
}

#[test]
fn source_paths_are_unresolved_for_broken_links_and_malformed_sqlite() {
    let fixture = TestDir::new("bad-sources");
    let valid_database = fixture.path().join("valid.db");
    let _source = create_synthetic_source(&valid_database);
    let malformed_database = fixture.path().join("malformed.db");
    fs::write(&malformed_database, b"not a SQLite database").unwrap();
    let malformed = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(malformed_database);
    assert!(matches!(
        export_exact_session(
            &malformed,
            "ses_root",
            ExportOptions::new(fixture.path().join("malformed-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let broken_link = fixture.path().join("broken.db");
        symlink(fixture.path().join("missing-target.db"), &broken_link).unwrap();
        let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(broken_link);
        assert!(matches!(
            export_exact_session(
                &inventory,
                "ses_root",
                ExportOptions::new(fixture.path().join("broken-extract")),
            ),
            Err(TransferError::Blocked(_))
        ));
    }
}

#[cfg(unix)]
#[test]
fn permission_denied_sources_are_blocked_without_publishing_an_extraction() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = TestDir::new("permission-denied-source");
    let database = fixture.path().join("opencode.db");
    let _source = create_synthetic_source(&database);
    fs::set_permissions(&database, fs::Permissions::from_mode(0o000)).unwrap();
    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database.clone());

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(matches!(result, Err(TransferError::Blocked(_))));
    assert!(!extraction_root.exists());
}

#[cfg(unix)]
#[test]
fn existing_extraction_directory_must_already_be_private_and_is_not_changed() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = TestDir::new("shared-extraction-root");
    let database = fixture.path().join("opencode.db");
    let _source = create_synthetic_source(&database);
    let extraction_root = fixture.path().join("extract");
    fs::create_dir(&extraction_root).unwrap();
    fs::set_permissions(&extraction_root, fs::Permissions::from_mode(0o750)).unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(matches!(result, Err(TransferError::Blocked(_))));
    assert_eq!(
        fs::metadata(extraction_root).unwrap().permissions().mode() & 0o777,
        0o750
    );
}

#[test]
fn online_backup_includes_committed_wal_and_excludes_an_open_write() {
    let fixture = TestDir::new("wal-snapshot");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute_batch("PRAGMA wal_autocheckpoint = 0;")
        .unwrap();
    source
        .execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES ('msg_committed_wal', 'ses_root', 99, 99, ?1)",
            [r#"{"opaque":"COMMITTED_WAL_SENTINEL"}"#],
        )
        .unwrap();

    let writer = Connection::open(&database).expect("open synthetic concurrent writer");
    let transaction = writer
        .unchecked_transaction()
        .expect("begin uncommitted synthetic write");
    transaction
        .execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES ('msg_uncommitted', 'ses_root', 100, 100, ?1)",
            [r#"{"opaque":"UNCOMMITTED_WAL_SENTINEL"}"#],
        )
        .unwrap();

    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("read one committed WAL snapshot");
    let mut payload = String::new();
    snapshot
        .open_payload()
        .unwrap()
        .read_to_string(&mut payload)
        .unwrap();

    assert!(payload.contains("COMMITTED_WAL_SENTINEL"));
    assert!(!payload.contains("UNCOMMITTED_WAL_SENTINEL"));
    transaction
        .rollback()
        .expect("discard uncommitted synthetic write");
}

#[test]
fn resolves_effective_override_and_blocks_duplicate_source_ownership() {
    let fixture = TestDir::new("source-resolution");
    let override_database = fixture.path().join("override.db");
    let _source = create_synthetic_source(&override_database);
    let inventory = HostOpenCodeInventory::new(fixture.path().join("missing-default.db"))
        .with_effective_database_override("override.db", fixture.path().to_path_buf());
    assert!(export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("override-extract")),
    )
    .is_ok());

    let second_database = fixture.path().join("second-channel.db");
    let _second_source = create_synthetic_source(&second_database);
    let ambiguous = HostOpenCodeInventory::new(fixture.path().join("missing-default.db"))
        .with_channel_database(override_database)
        .with_channel_database(second_database);
    assert!(matches!(
        export_exact_session(
            &ambiguous,
            "ses_root",
            ExportOptions::new(fixture.path().join("ambiguous-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));
}

#[test]
fn removes_private_backup_intermediates_and_recovers_only_abandoned_exports() {
    let fixture = TestDir::new("extraction-cleanup");
    let database = fixture.path().join("opencode.db");
    let _source = create_synthetic_source(&database);
    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    )
    .expect("export succeeds");
    let export_directory = fs::read_dir(&extraction_root)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let filenames: Vec<_> = fs::read_dir(&export_directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(filenames.iter().any(|name| name == "bundle.json"));
    assert!(!filenames
        .iter()
        .any(|name| name.starts_with("snapshot.sqlite")));
    drop(snapshot);
    assert_eq!(fs::read_dir(&extraction_root).unwrap().count(), 0);

    let abandoned = extraction_root.join("opencode-extract-12345-interrupted");
    fs::create_dir_all(&abandoned).unwrap();
    fs::write(abandoned.join(".owner-pid"), u32::MAX.to_string()).unwrap();
    for suffix in ["", "-wal", "-shm"] {
        fs::write(
            PathBuf::from(format!(
                "{}{}",
                abandoned.join("snapshot.sqlite").display(),
                suffix
            )),
            b"synthetic abandoned backup",
        )
        .unwrap();
    }
    let active = extraction_root.join(format!("opencode-extract-{}-active", std::process::id()));
    fs::create_dir_all(&active).unwrap();
    fs::write(active.join(".owner-pid"), std::process::id().to_string()).unwrap();
    let active_before_owner_record = extraction_root.join(format!(
        "opencode-extract-{}-owner-race",
        std::process::id()
    ));
    fs::create_dir_all(&active_before_owner_record).unwrap();
    let unrelated = extraction_root.join("keep-this-file");
    fs::write(&unrelated, b"unrelated").unwrap();

    assert_eq!(
        recover_interrupted_extractions(&extraction_root).unwrap(),
        1
    );
    assert!(!abandoned.exists());
    assert!(active.exists());
    assert!(active_before_owner_record.exists());
    assert!(unrelated.exists());
}

#[test]
fn preserves_inline_data_file_parts_without_external_assets() {
    let fixture = TestDir::new("inline-data");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [r#"{"type":"file","mime":"text/plain","url":"data:text/plain;base64,aGVsbG8="}"#],
        )
        .unwrap();
    source
        .execute(
            "UPDATE session_message SET data = ?1 WHERE id = 'v2_root'",
            [r#"{"parts":[{"type":"file","mime":"image/png","url":"data:image/png;base64,aW1hZ2U="}]}"#],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .unwrap();
    let mut payload = String::new();
    snapshot
        .open_payload()
        .unwrap()
        .read_to_string(&mut payload)
        .unwrap();
    assert!(payload.contains("data:text/plain;base64,aGVsbG8="));
    assert!(payload.contains("data:image/png;base64,aW1hZ2U="));
    assert!(snapshot.manifest().assets.is_empty());
}

#[test]
fn blocks_tool_output_files_even_after_same_length_rewrite_with_restored_timestamp() {
    let fixture = TestDir::new("mutable-tool-output");
    let data_home = fixture.path().join("provider");
    let tool_output_directory = data_home.join("tool-output");
    fs::create_dir_all(&tool_output_directory).unwrap();
    let output_path = tool_output_directory.join("tool_123456789");
    fs::write(&output_path, b"OLD_TOOL_BYTES").unwrap();
    let original_modified = fs::metadata(&output_path).unwrap().modified().unwrap();
    fs::write(&output_path, b"NEW_TOOL_BYTES").unwrap();
    fs::File::open(&output_path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(original_modified))
        .unwrap();
    assert_eq!(
        fs::metadata(&output_path).unwrap().modified().unwrap(),
        original_modified,
        "the synthetic rewrite preserves length and timestamp"
    );
    let database = data_home.join("opencode.db");
    let source = create_synthetic_source(&database);
    let data = serde_json::json!({
        "type":"file",
        "mime":"text/plain",
        "url":format!("file://{}", output_path.display())
    })
    .to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [data],
        )
        .unwrap();
    let extraction_root = fixture.path().join("extract");
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);

    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "the pinned writer's path and unchanged metadata do not prove immutable bytes"
    );
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
    assert_eq!(fs::read(output_path).unwrap(), b"NEW_TOOL_BYTES");
}

#[test]
fn opencode_db_override_keeps_tool_output_resolution_at_the_provider_data_home() {
    let fixture = TestDir::new("override-tool-output");
    let provider_data_home = fixture.path().join("provider-data");
    let tool_output_directory = provider_data_home.join("tool-output");
    fs::create_dir_all(&tool_output_directory).unwrap();
    let output_path = tool_output_directory.join("tool_override_123");
    fs::write(&output_path, b"OVERRIDE_TOOL_OUTPUT_BYTES").unwrap();

    let overridden_database_directory = fixture.path().join("custom-database");
    fs::create_dir_all(&overridden_database_directory).unwrap();
    let database = overridden_database_directory.join("opencode.db");
    let source = create_synthetic_source(&database);
    let data = serde_json::json!({
        "type":"file",
        "mime":"text/plain",
        "url":format!("file://{}", output_path.display())
    })
    .to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [data],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(provider_data_home.join("opencode.db"))
        .with_effective_database_override(database.as_os_str(), fixture.path().to_path_buf());

    let extraction_root = fixture.path().join("extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone())
            .with_workspace_mount(provider_data_home.clone()),
    );

    assert!(
        matches!(
            result,
            Err(TransferError::Blocked(reason))
                if reason.contains("no write-once retention contract")
        ),
        "the provider-home tool-output path must be blocked even when OPENCODE_DB is overridden"
    );
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
    assert_eq!(
        fs::read(output_path).unwrap(),
        b"OVERRIDE_TOOL_OUTPUT_BYTES"
    );
}

#[test]
fn keeps_a_file_reference_only_under_the_exact_workspace_mount() {
    let fixture = TestDir::new("workspace-file");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let workspace_mount = fixture.path().join("workspace");
    fs::create_dir_all(&workspace_mount).unwrap();
    let file = workspace_mount.join("prompt.txt");
    fs::write(&file, b"verified workspace bytes").unwrap();
    let data = serde_json::json!({
        "type":"file",
        "mime":"text/plain",
        "url":format!("file://{}", file.display())
    })
    .to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [data],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract"))
            .with_workspace_mount(workspace_mount.clone()),
    )
    .unwrap();
    let [asset] = snapshot.manifest().assets.as_slice() else {
        panic!("workspace file reference is recorded");
    };
    assert_eq!(asset.kind, "workspace_path_reference");
    assert_eq!(asset.source_relative_path, "prompt.txt");
    assert_eq!(asset.target_relative_path, "prompt.txt");

    let outside = fixture.path().join("outside.txt");
    fs::write(&outside, b"must not be referenced").unwrap();
    let outside_data = serde_json::json!({
        "type":"file",
        "mime":"text/plain",
        "url":format!("file://{}", outside.display())
    })
    .to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [outside_data],
        )
        .unwrap();
    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("outside-extract"))
                .with_workspace_mount(workspace_mount),
        ),
        Err(TransferError::Blocked(_))
    ));
}

#[test]
fn verifies_snapshot_trees_through_an_accessible_alternate_store_and_blocks_missing_objects() {
    let fixture = TestDir::new("git-snapshot");
    let workspace_mount = fixture.path().join("workspace");
    let alternate = workspace_mount.join(".alternate-objects");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", alternate.to_str().unwrap()],
        None,
    );
    let objects = alternate.join("objects");
    let alternates = workspace_mount.join(".git/objects/info/alternates");
    fs::write(&alternates, format!("{}\n", objects.display())).unwrap();

    let blob = run_git_command(
        &workspace_mount,
        &[
            "--git-dir",
            alternate.to_str().unwrap(),
            "hash-object",
            "-w",
            "--stdin",
        ],
        Some(b"snapshot tree blob"),
    );
    let tree = run_git_command(
        &workspace_mount,
        &["--git-dir", alternate.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let data = serde_json::json!({"type":"snapshot", "snapshot":tree.trim()}).to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [data],
        )
        .unwrap();
    source
        .execute(
            "UPDATE session SET revert = ?1 WHERE id = 'ses_root'",
            [serde_json::json!({"snapshot":tree.trim()}).to_string()],
        )
        .unwrap();
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database.clone());
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract"))
            .with_workspace_mount(workspace_mount.clone()),
    )
    .expect("alternate object store under the exact mounted path is available");
    let git_assets: Vec<_> = snapshot
        .manifest()
        .assets
        .iter()
        .filter(|asset| asset.kind == "git_tree_reference")
        .collect();
    assert_eq!(
        git_assets.len(),
        1,
        "the same snapshot tree is recorded once"
    );
    assert!(git_assets[0].source_relative_path.ends_with(tree.trim()));
    assert!(
        !serde_json::to_string(snapshot.manifest())
            .unwrap()
            .contains(&workspace_mount.to_string_lossy().to_string()),
        "the exact-session bundle does not publish the host workspace path"
    );

    let external_alternate = fixture.path().join("external-objects");
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", external_alternate.to_str().unwrap()],
        None,
    );
    let external_blob = run_git_command(
        &workspace_mount,
        &[
            "--git-dir",
            external_alternate.to_str().unwrap(),
            "hash-object",
            "-w",
            "--stdin",
        ],
        Some(b"snapshot tree blob"),
    );
    let external_tree = run_git_command(
        &workspace_mount,
        &["--git-dir", external_alternate.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", external_blob.trim()).as_bytes()),
    );
    assert_eq!(external_tree.trim(), tree.trim());
    fs::write(
        &alternates,
        format!("{}/objects\n", external_alternate.display()),
    )
    .unwrap();
    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("external-alternate-extract"))
                .with_workspace_mount(workspace_mount.clone()),
        ),
        Err(TransferError::Blocked(_))
    ));

    fs::write(&alternates, format!("{}\n", objects.display())).unwrap();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [r#"{"type":"snapshot","snapshot":"0000000000000000000000000000000000000000"}"#],
        )
        .unwrap();
    assert!(matches!(
        export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("missing-tree-extract"))
                .with_workspace_mount(workspace_mount),
        ),
        Err(TransferError::Blocked(_))
    ));
}

fn run_git_command(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> String {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

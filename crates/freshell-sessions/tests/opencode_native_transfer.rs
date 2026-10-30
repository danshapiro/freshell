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
    SavedSnapshotAvailability, TransferError,
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

fn with_selected_workspace_mount(
    inventory: HostOpenCodeInventory,
    managed_mount: PathBuf,
) -> HostOpenCodeInventory {
    inventory.with_trusted_workspace_mount(
        "prj_kept",
        Some("wrk_kept".into()),
        "/synthetic/worktree",
        managed_mount,
    )
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
    assert_eq!(manifest["version"], 2);
    assert!(manifest.get("rows").is_none());
    assert!(manifest.get("native_cleanup_baselines").is_none());
    assert_eq!(decoded["version"], 2);
    assert_eq!(decoded["saved_snapshots"], serde_json::json!([]));
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
fn blocks_reachable_session_descendant_with_null_primary_key() {
    let fixture = TestDir::new("null-id-session-descendant");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "INSERT INTO session
             (id, project_id, workspace_id, parent_id, slug, directory, title, version,
              time_created, time_updated, metadata, revert, permission)
             VALUES (NULL, 'prj_kept', 'wrk_kept', 'ses_root', 'null-id',
                     '/synthetic/worktree', 'NULL_ID_DESCENDANT', '1.18.21',
                     5, 5, '{}', NULL, NULL)",
            [],
        )
        .expect("the pinned SQLite schema permits a NULL text primary key");
    drop(source);

    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    let extraction_root = fixture.path().join("extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a reachable malformed session row must block exact export instead of disappearing"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked NULL-ID descendant must not publish a bundle"
    );
}

#[test]
fn exports_distinct_bulk_keys_for_each_selected_context_epoch() {
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

    let payload: Value = serde_json::from_reader(snapshot.open_payload().unwrap()).unwrap();
    let keys = payload["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["table"] == "session_context_epoch")
        .map(|row| row["key"].clone())
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

fn assert_one_defect_blocks_export(label: &str, mutation: &str) {
    let fixture = TestDir::new(label);
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database);
    export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("valid-extract")),
    )
    .expect("fresh fixture exports before its one-defect mutation");

    source.execute_batch(mutation).unwrap();
    assert!(
        matches!(
            export_exact_session(
                &inventory,
                "ses_root",
                ExportOptions::new(fixture.path().join("invalid-extract")),
            ),
            Err(TransferError::Blocked(_))
        ),
        "{label} must independently block export"
    );
}

#[test]
fn blocks_unrecognized_columns_and_migration_ids() {
    for (label, mutation) in [
        (
            "unrecognized-column",
            "ALTER TABLE session ADD COLUMN plugin_private TEXT;",
        ),
        (
            "unrecognized-migration",
            "INSERT INTO migration (id, time_completed) VALUES ('20990101000000_future', 999);",
        ),
    ] {
        assert_one_defect_blocks_export(label, mutation);
    }
}

#[test]
fn blocks_cross_owned_parts_and_session_workspace_links() {
    for (label, mutation) in [
        (
            "cross-owned-part",
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES ('part_cross_owned', 'msg_ses_root', 'ses_unrelated', 50, 50, '{}');",
        ),
        (
            "cross-owned-workspace",
            "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
             VALUES ('prj_other', '/synthetic/other', 2, 2, '[]');
             INSERT INTO workspace (id, type, name, project_id, time_used)
             VALUES ('wrk_other', 'directory', 'other', 'prj_other', 2);
             UPDATE session SET project_id = 'prj_other', workspace_id = 'wrk_kept'
             WHERE id = 'ses_child';",
        ),
    ] {
        assert_one_defect_blocks_export(label, mutation);
    }
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
fn durable_souls_semantic_schema_admits_equivalent_message_seq_types_and_whitespace() {
    let fixture = TestDir::new("durable-semantic-schema");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source.execute_batch("DROP TABLE message_seq; CREATE TABLE message_seq (\n session_id text PRIMARY KEY,\n next integer NOT NULL\n);").unwrap();
    let snapshot = export_exact_session(
        &HostOpenCodeInventory::new(database),
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .unwrap();
    assert!(snapshot.manifest().row_count > 0);
    let mut payload = String::new();
    snapshot
        .open_payload()
        .unwrap()
        .read_to_string(&mut payload)
        .unwrap();
    assert!(payload.contains("ses_root"));
    assert!(!payload.contains("message_seq"));
}

#[test]
fn durable_souls_semantic_schema_refuses_changed_relationships_and_migrations() {
    for (label, sql) in [
        ("column-type", "DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY,next TEXT NOT NULL);"),
        ("key", "DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT,next INTEGER NOT NULL);"),
        ("nullability", "DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY,next INTEGER);"),
        ("foreign-key", "DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY REFERENCES session(id),next INTEGER NOT NULL);"),
        ("index", "CREATE INDEX unsupported_projection ON message(data);"),
        ("trigger", "CREATE TRIGGER unsupported_projection AFTER INSERT ON message BEGIN SELECT 1; END;"),
        ("migration", "DELETE FROM migration WHERE id=(SELECT id FROM migration LIMIT 1);"),
        ("check", "DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY,next INTEGER NOT NULL CHECK(next>0));"),
    ] {
        let fixture = TestDir::new(label);
        let database = fixture.path().join("opencode.db");
        let source = create_synthetic_source(&database);
        source.execute_batch(sql).unwrap();
        let before = fs::read(&database).unwrap();
        let extraction = fixture.path().join("extract");
        assert!(matches!(export_exact_session(&HostOpenCodeInventory::new(database.clone()), "ses_root", ExportOptions::new(extraction)), Err(TransferError::Blocked(_))), "{label}");
        assert_eq!(fs::read(database).unwrap(), before, "{label}: source bytes unchanged");
    }
}

#[test]
fn durable_souls_attachment_authority_preserves_metadata_and_file_source() {
    let fixture = TestDir::new("durable-attachment-authority");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let file = serde_json::json!({"type":"file","mime":"text/plain","url":"data:text/plain;base64,YXNzZXQ=","source":{"type":"file","path":"fictional/source.txt","text":{"value":"asset","start":0,"end":5}}});
    let tool = serde_json::json!({"type":"tool","tool":"read","callID":"call_fixture","state":{"status":"completed","input":{},"output":"fixture output","title":"Fixture","time":{"start":1,"end":2},"metadata":{"arbitrary":{"type":"file","noUrl":true}},"attachments":[file.clone()]}});
    for (id, data) in [
        ("part_file_authority", &file),
        ("part_tool_metadata", &tool),
    ] {
        source.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?1,'msg_ses_root','ses_root',1,1,?2)",params![id,data.to_string()]).unwrap();
    }
    source.execute("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES ('evt_fixture_part','ses_root',2,'message.part.updated.1',?1)", [serde_json::json!({"sessionID":"ses_root","part":tool.clone(),"time":2}).to_string()]).unwrap();
    source
        .execute(
            "UPDATE event_sequence SET seq=2 WHERE aggregate_id='ses_root'",
            [],
        )
        .unwrap();
    let snapshot = export_exact_session(
        &HostOpenCodeInventory::new(database),
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .unwrap();
    let payload: Value = serde_json::from_reader(snapshot.open_payload().unwrap()).unwrap();
    for expected in [file.to_string(), tool.to_string()] {
        assert!(payload["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["table"] == "part" && row["values"]["data"]["value"] == expected));
    }
    assert!(payload["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["table"] == "event"
            && row["values"]["data"]["value"]
                .as_str()
                .unwrap()
                .contains("noUrl")));
}

#[test]
fn durable_souls_attachment_authority_rejects_missing_authoritative_urls() {
    for (label, data) in [
        (
            "file",
            serde_json::json!({"type":"file","mime":"text/plain"}),
        ),
        (
            "tool",
            serde_json::json!({"type":"tool","state":{"status":"completed","attachments":[{"type":"file","mime":"text/plain"}]}}),
        ),
    ] {
        let fixture = TestDir::new(label);
        let database = fixture.path().join("opencode.db");
        let source = create_synthetic_source(&database);
        source
            .execute(
                "UPDATE part SET data=?1 WHERE id='part_ses_root'",
                [data.to_string()],
            )
            .unwrap();
        assert!(matches!(
            export_exact_session(
                &HostOpenCodeInventory::new(database),
                "ses_root",
                ExportOptions::new(fixture.path().join("extract"))
            ),
            Err(TransferError::Blocked(_))
        ));
    }
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
fn trusted_process_inventory_discovers_installation_channel_databases() {
    let fixture = TestDir::new("channel-inventory");
    let channel_data_home = fixture.path().join("data").join("opencode");
    fs::create_dir_all(&channel_data_home).unwrap();
    let channel_database = channel_data_home.join("opencode-beta.db");
    let _channel_source = create_synthetic_source(&channel_database);

    let inventory = HostOpenCodeInventory::discover_in_data_home(&channel_data_home).unwrap();
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("channel-extract")),
    )
    .expect("trusted installation-channel database is in the production inventory");
    assert!(snapshot.manifest().source_store_id.len() == 64);

    let default_database = channel_data_home.join("opencode.db");
    let _default_source = create_synthetic_source(&default_database);
    assert!(matches!(
        export_exact_session(
            &HostOpenCodeInventory::discover_in_data_home(&channel_data_home).unwrap(),
            "ses_root",
            ExportOptions::new(fixture.path().join("ambiguous-extract")),
        ),
        Err(TransferError::Blocked(message))
            if message.contains("multiple trusted source stores")
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
        ExportOptions::new(extraction_root.clone()),
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
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount.clone(),
    );
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
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
            ExportOptions::new(fixture.path().join("outside-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));
}

#[test]
fn selected_session_workspace_mount_binds_only_exact_native_directory() {
    let fixture = TestDir::new("selected-session-workspace-binding");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let workspace_mount = fixture.path().join("workspace");
    fs::create_dir_all(&workspace_mount).unwrap();
    let file = workspace_mount.join("prompt.txt");
    fs::write(&file, b"selected session workspace bytes").unwrap();
    source
        .execute(
            "UPDATE session SET directory = ?1 WHERE id = 'ses_root'",
            [workspace_mount.to_string_lossy().as_ref()],
        )
        .unwrap();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({
                "type":"file",
                "mime":"text/plain",
                "url":format!("file://{}", file.display())
            })
            .to_string()],
        )
        .unwrap();
    drop(source);

    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database)
        .with_trusted_mount_for_selected_session(workspace_mount.clone());
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("exact source directory binds the trusted workspace mount");
    assert_eq!(snapshot.manifest().assets.len(), 1);
    assert_eq!(
        snapshot.manifest().assets[0].target_relative_path,
        "prompt.txt"
    );
}

#[test]
fn selected_session_workspace_mount_rejects_no_match_and_ambiguous_match() {
    let fixture = TestDir::new("selected-session-workspace-binding-failures");
    let workspace_mount = fixture.path().join("workspace");
    fs::create_dir_all(&workspace_mount).unwrap();
    let file = workspace_mount.join("prompt.txt");
    fs::write(&file, b"selected session workspace bytes").unwrap();
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({
                "type":"file",
                "mime":"text/plain",
                "url":format!("file://{}", file.display())
            })
            .to_string()],
        )
        .unwrap();
    drop(source);

    let no_match = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database.clone())
        .with_trusted_mount_for_selected_session(workspace_mount.clone());
    assert!(matches!(
        export_exact_session(
            &no_match,
            "ses_root",
            ExportOptions::new(fixture.path().join("no-match-extract")),
        ),
        Err(TransferError::Blocked(_))
    ));

    let source = Connection::open(&database).unwrap();
    source
        .execute(
            "UPDATE session SET directory = ?1 WHERE id = 'ses_root'",
            [workspace_mount.to_string_lossy().as_ref()],
        )
        .unwrap();
    drop(source);
    let repeated = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database.clone())
        .with_trusted_mount_for_selected_session(workspace_mount.clone())
        .with_trusted_mount_for_selected_session(workspace_mount.clone());
    assert!(
        export_exact_session(
            &repeated,
            "ses_root",
            ExportOptions::new(fixture.path().join("repeated-extract"))
        )
        .is_ok(),
        "duplicate owners can share one exact workspace without inventing a second mapping"
    );
    let second_mount = fixture.path().join("second-workspace");
    fs::create_dir(&second_mount).unwrap();
    let ambiguous = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database)
        .with_trusted_workspace_mount(
            "prj_kept",
            Some("wrk_kept".into()),
            workspace_mount.to_string_lossy(),
            workspace_mount.clone(),
        )
        .with_trusted_workspace_mount(
            "prj_kept",
            Some("wrk_kept".into()),
            workspace_mount.to_string_lossy(),
            second_mount,
        );
    assert!(matches!(
        export_exact_session(
            &ambiguous,
            "ses_root",
            ExportOptions::new(fixture.path().join("ambiguous-extract")),
        ),
        Err(TransferError::Blocked(reason)) if reason.contains("ambiguous")
    ));
}

#[test]
fn blocks_workspace_file_from_a_different_session_workspace_mapping() {
    let fixture = TestDir::new("workspace-file-mismatch");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let selected_workspace = fixture.path().join("selected-workspace");
    let other_workspace = fixture.path().join("other-workspace");
    fs::create_dir_all(&selected_workspace).unwrap();
    fs::create_dir_all(&other_workspace).unwrap();
    let foreign_file = other_workspace.join("prompt.txt");
    fs::write(&foreign_file, b"belongs to a different workspace").unwrap();
    let data = serde_json::json!({
        "type":"file",
        "mime":"text/plain",
        "url":format!("file://{}", foreign_file.display())
    })
    .to_string();
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [data],
        )
        .unwrap();
    drop(source);

    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        selected_workspace,
    );
    let extraction_root = fixture.path().join("mismatched-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a path from a different workspace must not be certified through the selected session's trusted mount"
    );
    assert_eq!(fs::read_dir(extraction_root).unwrap().count(), 0);
}

#[test]
fn refuses_git_object_authority_from_process_environment() {
    const FIXTURE_ENV: &str = "FRESHELL_OPENCODE_TEST_EXTERNAL_OBJECT_STORE_FIXTURE";
    if let Some(fixture_path) = std::env::var_os(FIXTURE_ENV) {
        let fixture = PathBuf::from(fixture_path);
        let database = fixture.join("opencode.db");
        let inventory = with_selected_workspace_mount(
            HostOpenCodeInventory::new(fixture.join("unused.db")).with_channel_database(database),
            fixture.join("workspace"),
        );
        let extraction_root = fixture.join("external-environment-extract");
        let result = export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(extraction_root.clone()),
        );
        let exported =
            result.expect("ambient Git objects do not block otherwise preserved history");
        assert_eq!(exported.manifest().row_count(), 19);
        let [reference] = exported.manifest().saved_snapshots.as_slice() else {
            panic!("the exact native part keeps its saved reference");
        };
        assert_eq!(reference.availability, SavedSnapshotAvailability::UnavailableInQualifiedLocations,
            "an external object store from GIT_ALTERNATE_OBJECT_DIRECTORIES must not certify the snapshot");
        assert!(reference.objects.is_empty());
        assert!(exported.manifest().assets.is_empty());
        let payload: Value = serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
        assert!(payload["snapshot_objects"].as_array().unwrap().is_empty());
        let part = payload["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["table"] == "part" && row["values"]["id"]["value"] == "part_ses_root")
            .unwrap();
        let original: String = Connection::open_with_flags(
            fixture.join("opencode.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap()
        .query_row(
            "SELECT data FROM part WHERE id='part_ses_root'",
            [],
            |row| row.get(0),
        )
        .unwrap();
        assert_eq!(part["values"]["data"]["value"].as_str().unwrap(), original);
        let decoded: Value = serde_json::from_str(&original).unwrap();
        assert_eq!(reference.tree, decoded["snapshot"].as_str().unwrap());
        return;
    }

    let fixture = TestDir::new("git-env-alternate");
    let workspace_mount = fixture.path().join("workspace");
    let external_store = fixture.path().join("external-objects.git");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", external_store.to_str().unwrap()],
        None,
    );
    let blob = run_git_command(
        &workspace_mount,
        &[
            "--git-dir",
            external_store.to_str().unwrap(),
            "hash-object",
            "-w",
            "--stdin",
        ],
        Some(b"environment-only snapshot blob"),
    );
    let tree = run_git_command(
        &workspace_mount,
        &["--git-dir", external_store.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":tree.trim()}).to_string()],
        )
        .unwrap();
    drop(source);

    let executable = std::env::current_exe().unwrap();
    let mut child = Command::new(executable);
    child
        .args([
            "--exact",
            "refuses_git_object_authority_from_process_environment",
            "--nocapture",
        ])
        .env(FIXTURE_ENV, fixture.path());
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            child.env_remove(key);
        }
    }
    child.env(
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        external_store.join("objects"),
    );
    let output = child.output().expect("run isolated regression child");
    assert!(
        output.status.success(),
        "child regression failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn blocks_git_object_directory_symlinked_outside_the_workspace_mount() {
    use std::os::unix::fs::symlink;

    let fixture = TestDir::new("git-object-directory-symlink");
    let workspace_mount = fixture.path().join("workspace");
    let external_store = fixture.path().join("external-objects.git");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", external_store.to_str().unwrap()],
        None,
    );
    let blob = run_git_command(
        &workspace_mount,
        &[
            "--git-dir",
            external_store.to_str().unwrap(),
            "hash-object",
            "-w",
            "--stdin",
        ],
        Some(b"outside object-directory blob"),
    );
    let tree = run_git_command(
        &workspace_mount,
        &["--git-dir", external_store.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );
    let local_objects = workspace_mount.join(".git/objects");
    fs::remove_dir_all(&local_objects).unwrap();
    symlink(external_store.join("objects"), &local_objects).unwrap();
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", tree.trim()], None).trim(),
        "tree",
        "the fixture must expose the tree only through the external object-directory symlink"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":tree.trim()}).to_string()],
        )
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let extraction_root = fixture.path().join("object-directory-symlink-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "Git object storage redirected outside the mount must block transfer"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked object-directory symlink must not publish a bundle"
    );
}

#[cfg(unix)]
#[test]
fn blocks_git_packed_objects_symlinked_outside_the_workspace_mount() {
    use std::os::unix::fs::symlink;

    let fixture = TestDir::new("git-pack-directory-symlink");
    let workspace_mount = fixture.path().join("workspace");
    let external_pack = fixture.path().join("external-pack");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    fs::write(workspace_mount.join("snapshot.txt"), "packed snapshot\n").unwrap();
    run_git_command(&workspace_mount, &["add", "snapshot.txt"], None);
    run_git_command(
        &workspace_mount,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "snapshot",
        ],
        None,
    );
    let tree = run_git_command(&workspace_mount, &["rev-parse", "HEAD^{tree}"], None);
    run_git_command(&workspace_mount, &["repack", "-a", "-d"], None);
    let local_pack = workspace_mount.join(".git/objects/pack");
    assert!(
        fs::read_dir(&local_pack).unwrap().next().is_some(),
        "the fixture needs a real pack and index"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":tree.trim()}).to_string()],
        )
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount.clone(),
    );
    export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("regular-packed-store-extract")),
    )
    .expect("ordinary in-mount packed objects remain supported");

    fs::rename(&local_pack, &external_pack).unwrap();
    fs::create_dir_all(&local_pack).unwrap();
    for entry in fs::read_dir(&external_pack).unwrap() {
        let entry = entry.unwrap();
        symlink(entry.path(), local_pack.join(entry.file_name())).unwrap();
    }
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", tree.trim()], None).trim(),
        "tree",
        "the fixture must expose packed objects through external pack/index file symlinks"
    );
    let extraction_root = fixture.path().join("pack-file-symlink-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );
    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "Git pack and index files redirected outside the mount must block transfer"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked pack-file symlink must not publish a bundle"
    );

    fs::remove_dir_all(&local_pack).unwrap();
    symlink(&external_pack, &local_pack).unwrap();
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", tree.trim()], None).trim(),
        "tree",
        "the fixture must expose the tree only through the external pack-directory symlink"
    );
    let extraction_root = fixture.path().join("pack-directory-symlink-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "Git packed objects redirected outside the mount must block transfer"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked pack-directory symlink must not publish a bundle"
    );
}

#[cfg(unix)]
#[test]
fn blocks_git_loose_object_fanout_symlinked_outside_the_workspace_mount() {
    use std::os::unix::fs::symlink;

    let fixture = TestDir::new("git-loose-fanout-symlink");
    let workspace_mount = fixture.path().join("workspace");
    let external_store = fixture.path().join("external-objects.git");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", external_store.to_str().unwrap()],
        None,
    );
    let blob = run_git_command(
        &workspace_mount,
        &["hash-object", "-w", "--stdin"],
        Some(b"local loose blob for external tree"),
    );
    let external_blob = run_git_command(
        &workspace_mount,
        &[
            "--git-dir",
            external_store.to_str().unwrap(),
            "hash-object",
            "-w",
            "--stdin",
        ],
        Some(b"local loose blob for external tree"),
    );
    assert_eq!(blob.trim(), external_blob.trim());
    let tree = run_git_command(
        &workspace_mount,
        &["--git-dir", external_store.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );
    let tree_oid = tree.trim();
    let local_fanout = workspace_mount.join(".git/objects").join(&tree_oid[..2]);
    let external_fanout = external_store.join("objects").join(&tree_oid[..2]);
    assert!(local_fanout != external_fanout);
    symlink(&external_fanout, &local_fanout).unwrap();
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", tree_oid], None).trim(),
        "tree",
        "the fixture must expose the tree through the external loose-object fanout symlink"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":tree_oid}).to_string()],
        )
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let extraction_root = fixture.path().join("loose-fanout-symlink-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "Git loose objects redirected outside the mount must block transfer"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked loose fanout symlink must not publish a bundle"
    );
}

#[cfg(unix)]
#[test]
fn blocks_git_loose_object_file_symlinked_outside_the_workspace_mount() {
    use std::os::unix::fs::symlink;

    let fixture = TestDir::new("git-loose-file-symlink");
    let workspace_mount = fixture.path().join("workspace");
    let external_store = fixture.path().join("external-objects.git");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", external_store.to_str().unwrap()],
        None,
    );
    let blob = run_git_command(
        &workspace_mount,
        &["hash-object", "-w", "--stdin"],
        Some(b"local loose blob for external tree"),
    );
    let external_blob = run_git_command(
        &workspace_mount,
        &[
            "--git-dir",
            external_store.to_str().unwrap(),
            "hash-object",
            "-w",
            "--stdin",
        ],
        Some(b"local loose blob for external tree"),
    );
    assert_eq!(blob.trim(), external_blob.trim());
    let tree = run_git_command(
        &workspace_mount,
        &["--git-dir", external_store.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );
    let tree_oid = tree.trim();
    let local_object = workspace_mount
        .join(".git/objects")
        .join(&tree_oid[..2])
        .join(&tree_oid[2..]);
    let external_object = external_store
        .join("objects")
        .join(&tree_oid[..2])
        .join(&tree_oid[2..]);
    fs::create_dir_all(local_object.parent().unwrap()).unwrap();
    symlink(&external_object, &local_object).unwrap();
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", tree_oid], None).trim(),
        "tree",
        "the fixture must expose the tree through the external loose-object file symlink"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":tree_oid}).to_string()],
        )
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let extraction_root = fixture.path().join("loose-file-symlink-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "Git loose object files redirected outside the mount must block transfer"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked loose object symlink must not publish a bundle"
    );
}

#[cfg(unix)]
#[test]
fn blocks_nested_git_tree_symlinked_outside_the_workspace_mount() {
    use std::os::unix::fs::symlink;

    let fixture = TestDir::new("git-nested-tree-symlink");
    let workspace_mount = fixture.path().join("workspace");
    let external_objects = fixture.path().join("external-objects");
    fs::create_dir_all(workspace_mount.join("nested")).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    fs::write(
        workspace_mount.join("nested/snapshot.txt"),
        "nested snapshot\n",
    )
    .unwrap();
    run_git_command(&workspace_mount, &["add", "nested/snapshot.txt"], None);
    run_git_command(
        &workspace_mount,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "snapshot",
        ],
        None,
    );
    let root_tree = run_git_command(&workspace_mount, &["rev-parse", "HEAD^{tree}"], None);
    let nested_tree = run_git_command(&workspace_mount, &["rev-parse", "HEAD:nested"], None);
    let nested_oid = nested_tree.trim();
    let local_object = workspace_mount
        .join(".git/objects")
        .join(&nested_oid[..2])
        .join(&nested_oid[2..]);
    let external_object = external_objects
        .join(&nested_oid[..2])
        .join(&nested_oid[2..]);
    fs::create_dir_all(external_object.parent().unwrap()).unwrap();
    fs::copy(&local_object, &external_object).unwrap();
    fs::remove_file(&local_object).unwrap();
    symlink(&external_object, &local_object).unwrap();
    assert_eq!(
        run_git_command(
            &workspace_mount,
            &["cat-file", "-t", root_tree.trim()],
            None
        )
        .trim(),
        "tree",
        "the root tree remains local in this fixture"
    );
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", nested_oid], None).trim(),
        "tree",
        "the nested tree must be readable through the external loose-object symlink"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":root_tree.trim()}).to_string()],
        )
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let extraction_root = fixture.path().join("nested-tree-symlink-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a nested tree object redirected outside the mount must block transfer"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked nested-tree symlink must not publish a bundle"
    );
}

#[test]
fn malformed_json_blocks_every_reference_traversal_field() {
    let cases = [
        (
            "message",
            "UPDATE message SET data = ?1 WHERE id = 'msg_ses_root'",
        ),
        (
            "part",
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
        ),
        (
            "session_message",
            "UPDATE session_message SET data = ?1 WHERE id = 'v2_root'",
        ),
        (
            "session_input",
            "UPDATE session_input SET prompt = ?1 WHERE id = 'input_root'",
        ),
        (
            "session",
            "UPDATE session SET revert = ?1 WHERE id = 'ses_root'",
        ),
        ("event", "UPDATE event SET data = ?1 WHERE id = 'evt_root'"),
        (
            "session_context_epoch",
            "UPDATE session_context_epoch SET snapshot = ?1 WHERE session_id = 'ses_root'",
        ),
    ];

    for (table, update) in cases {
        let fixture = TestDir::new(&format!("malformed-json-{table}"));
        let database = fixture.path().join("opencode.db");
        let source = create_synthetic_source(&database);
        source.execute(update, [r#"{"truncated":"#]).unwrap();
        drop(source);

        let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database);
        let extraction_root = fixture.path().join("extract");
        let result = export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(extraction_root.clone()),
        );
        assert!(
            matches!(result, Err(TransferError::Blocked(_))),
            "malformed JSON in {table} must block the transfer"
        );
        assert_eq!(
            fs::read_dir(extraction_root).unwrap().count(),
            0,
            "malformed JSON in {table} must not publish a bundle"
        );
    }
}

#[test]
fn verifies_a_repeated_git_tree_in_each_selected_session_workspace() {
    let fixture = TestDir::new("git-tree-cross-workspace");
    let root_workspace = fixture.path().join("root-workspace");
    let child_workspace = fixture.path().join("child-workspace");
    fs::create_dir_all(&root_workspace).unwrap();
    fs::create_dir_all(&child_workspace).unwrap();
    run_git_command(&root_workspace, &["init", "-q"], None);
    run_git_command(&child_workspace, &["init", "-q"], None);
    let blob = run_git_command(
        &root_workspace,
        &["hash-object", "-w", "--stdin"],
        Some(b"root workspace only snapshot blob"),
    );
    let tree = run_git_command(
        &root_workspace,
        &["mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute_batch(
            "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
             VALUES ('prj_other', '/synthetic/other', 2, 2, '[]');
             INSERT INTO workspace (id, type, name, project_id, time_used)
             VALUES ('wrk_other', 'directory', 'other', 'prj_other', 2);
             INSERT INTO project_directory (project_id, directory, time_created)
             VALUES ('prj_other', '/synthetic/other', 2);
             UPDATE session
             SET project_id = 'prj_other', workspace_id = 'wrk_other',
                 directory = '/synthetic/other'
             WHERE id = 'ses_child';",
        )
        .unwrap();
    let revert = serde_json::json!({"snapshot":tree.trim()}).to_string();
    source
        .execute(
            "UPDATE session SET revert = ?1 WHERE id IN ('ses_root', 'ses_child')",
            [revert],
        )
        .unwrap();
    source
        .execute(
            "UPDATE part SET data=?1 WHERE session_id IN ('ses_root','ses_child')",
            [serde_json::json!({"type":"step-start","snapshot":tree.trim()}).to_string()],
        )
        .unwrap();
    drop(source);

    let inventory = HostOpenCodeInventory::new(fixture.path().join("unused.db"))
        .with_channel_database(database)
        .with_trusted_workspace_mount(
            "prj_kept",
            Some("wrk_kept".into()),
            "/synthetic/worktree",
            root_workspace,
        )
        .with_trusted_workspace_mount(
            "prj_other",
            Some("wrk_other".into()),
            "/synthetic/other",
            child_workspace,
        );
    let extraction_root = fixture.path().join("extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    let exported = result.expect("a missing saved undo reference does not block preserved history");
    let root = exported
        .manifest()
        .saved_snapshots
        .iter()
        .find(|reference| reference.session_id == "ses_root")
        .unwrap();
    let child = exported
        .manifest()
        .saved_snapshots
        .iter()
        .find(|reference| reference.session_id == "ses_child")
        .unwrap();
    assert_eq!(
        root.availability,
        SavedSnapshotAvailability::RetainedClosure
    );
    assert_eq!(
        child.availability,
        SavedSnapshotAvailability::UnavailableInQualifiedLocations,
        "the child's own qualified store cannot borrow the root workspace's authority"
    );
    assert_eq!(root.tree, child.tree);
    assert_eq!(root.objects.len(), 2);
    assert!(child.objects.is_empty());
}

#[test]
fn blocks_snapshot_objects_available_only_through_a_nested_external_alternate() {
    let fixture = TestDir::new("git-nested-alternate");
    let workspace_mount = fixture.path().join("workspace");
    let direct_alternate = workspace_mount.join(".alternate-objects.git");
    let external_alternate = fixture.path().join("external-objects.git");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    run_git_command(
        &workspace_mount,
        &["init", "--bare", "-q", direct_alternate.to_str().unwrap()],
        None,
    );
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
        Some(b"nested external snapshot blob"),
    );
    let tree = run_git_command(
        &workspace_mount,
        &["--git-dir", external_alternate.to_str().unwrap(), "mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", external_blob.trim()).as_bytes()),
    );

    let direct_objects = direct_alternate.join("objects");
    fs::write(
        workspace_mount.join(".git/objects/info/alternates"),
        format!("{}\n", direct_objects.display()),
    )
    .unwrap();
    fs::write(
        direct_objects.join("info/alternates"),
        format!("{}/objects\n", external_alternate.display()),
    )
    .unwrap();
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", tree.trim()], None).trim(),
        "tree",
        "the fixture must expose the tree only through the nested external store"
    );
    let tree_object_path = |objects: &Path| objects.join(&tree.trim()[..2]).join(&tree.trim()[2..]);
    assert!(
        !tree_object_path(&direct_objects).exists()
            && !tree_object_path(&workspace_mount.join(".git/objects")).exists(),
        "the referenced tree must exist only in the outside nested store"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":tree.trim()}).to_string()],
        )
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let extraction_root = fixture.path().join("nested-alternate-extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a nested alternate may not supply Git objects from outside the workspace mount"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a blocked nested alternate must not publish a bundle"
    );
}

#[test]
fn verifies_snapshot_trees_through_accessible_alternates_and_preserves_absent_references() {
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
    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database.clone()),
        workspace_mount.clone(),
    );
    let progress = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = progress.clone();
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")).with_progress_observer(move |event| {
            observed.lock().unwrap().push(event);
        }),
    )
    .expect("alternate object store under the exact mounted path is available");
    let events = progress.lock().unwrap();
    let object_events = events
        .iter()
        .filter(|event| event.phase == "saved_objects")
        .collect::<Vec<_>>();
    assert_eq!(object_events.first().unwrap().state, "started");
    let completed = object_events.last().unwrap();
    assert_eq!(completed.state, "completed");
    assert_eq!(completed.count_unit, "object_reads");
    assert!(
        completed.completed_count >= 4,
        "both references keep their own qualified root/blob checks"
    );
    assert!(object_events
        .iter()
        .any(|event| event.state == "progress" && event.completed_count > 0));
    drop(events);
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
            ExportOptions::new(fixture.path().join("external-alternate-extract")),
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
    progress.lock().unwrap().clear();
    let observed = progress.clone();
    let absent = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("missing-tree-extract")).with_progress_observer(
            move |event| {
                observed.lock().unwrap().push(event);
            },
        ),
    )
    .expect("an absent tree remains saved history without fabricated assets");
    assert!(
        progress
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.phase == "saved_objects"
                && event.state == "completed"
                && event.completed_count >= 3),
        "diagnostics must count unavailable-root lookups as well as retained objects"
    );
    assert_eq!(absent.manifest().saved_snapshots.len(), 2);
    let reference = absent
        .manifest()
        .saved_snapshots
        .iter()
        .find(|reference| reference.tree == "0000000000000000000000000000000000000000")
        .unwrap();
    assert_eq!(
        reference.availability,
        SavedSnapshotAvailability::UnavailableInQualifiedLocations
    );
    assert!(reference.objects.is_empty());
    assert_eq!(
        freshell_sessions::opencode_transfer::saved_snapshot_summary(absent.manifest()),
        freshell_sessions::opencode_transfer::SavedSnapshotSummary::QualifiedReferences {
            retained_closure_count: 1,
            unavailable_reference_count: 1,
        }
    );
}

#[test]
fn blocks_commit_oid_used_as_revert_snapshot_tree() {
    let fixture = TestDir::new("commit-as-snapshot-tree");
    let workspace_mount = fixture.path().join("workspace");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    fs::write(workspace_mount.join("snapshot.txt"), "synthetic snapshot\n").unwrap();
    run_git_command(&workspace_mount, &["add", "snapshot.txt"], None);
    run_git_command(
        &workspace_mount,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "synthetic snapshot",
        ],
        None,
    );
    let commit = run_git_command(&workspace_mount, &["rev-parse", "HEAD"], None);
    assert_eq!(
        run_git_command(&workspace_mount, &["cat-file", "-t", commit.trim()], None).trim(),
        "commit",
        "fixture reference must be a commit object, not a tree"
    );

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE session SET revert = ?1 WHERE id = 'ses_root'",
            [serde_json::json!({"snapshot":commit.trim()}).to_string()],
        )
        .unwrap();
    drop(source);

    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let extraction_root = fixture.path().join("extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction_root.clone()),
    );

    assert!(
        matches!(result, Err(TransferError::Blocked(_))),
        "a commit object must not be accepted as a snapshot tree"
    );
    assert_eq!(
        fs::read_dir(extraction_root).unwrap().count(),
        0,
        "a non-tree snapshot reference must not publish a bundle"
    );
}

#[test]
fn exports_snapshot_from_ordinary_primary_loose_git_objects() {
    let fixture = TestDir::new("git-primary-loose-snapshot");
    let workspace_mount = fixture.path().join("workspace");
    fs::create_dir_all(&workspace_mount).unwrap();
    run_git_command(&workspace_mount, &["init", "-q"], None);
    let blob = run_git_command(
        &workspace_mount,
        &["hash-object", "-w", "--stdin"],
        Some(b"ordinary primary loose snapshot blob"),
    );
    let nested_tree = run_git_command(
        &workspace_mount,
        &["mktree"],
        Some(format!("100644 blob {}\tsnapshot.txt\n", blob.trim()).as_bytes()),
    );
    let root_tree = run_git_command(
        &workspace_mount,
        &["mktree"],
        Some(format!("040000 tree {}\tnested\n", nested_tree.trim()).as_bytes()),
    );
    let blob_oid = blob.trim();
    let nested_tree_oid = nested_tree.trim();
    let root_tree_oid = root_tree.trim();
    for oid in [blob_oid, nested_tree_oid, root_tree_oid] {
        let object_path = workspace_mount
            .join(".git/objects")
            .join(&oid[..2])
            .join(&oid[2..]);
        assert!(
            object_path.is_file(),
            "fixture object {oid} must be a primary loose object"
        );
    }

    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    source
        .execute(
            "UPDATE part SET data = ?1 WHERE id = 'part_ses_root'",
            [serde_json::json!({"type":"snapshot", "snapshot":root_tree_oid}).to_string()],
        )
        .unwrap();
    drop(source);

    let inventory = with_selected_workspace_mount(
        HostOpenCodeInventory::new(fixture.path().join("unused.db"))
            .with_channel_database(database),
        workspace_mount,
    );
    let snapshot = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("ordinary primary loose objects form a complete snapshot closure");
    let [asset] = snapshot.manifest().assets.as_slice() else {
        panic!("the primary loose snapshot closure is represented by one Git asset");
    };
    assert_eq!(asset.kind, "git_tree_reference");
    assert!(asset.source_relative_path.ends_with(root_tree_oid));
    assert_eq!(asset.target_relative_path, asset.source_relative_path);
    assert!(asset.size_bytes > 0);
    assert_eq!(asset.sha256.len(), 64);
}

fn run_git_command(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> String {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
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

#[test]
fn native_export_preserves_snapshot_gitlinks_without_copying_submodule_commits() {
    for native_store in [false, true] {
        let fixture = TestDir::new("snapshot-gitlink");
        let workspace = fixture.path().join("workspace");
        let child = fixture.path().join("child");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&child).unwrap();
        for root in [&workspace, &child] {
            run_git_command(root, &["init", "-q"], None);
            fs::write(root.join("ordinary.txt"), "ordinary tracked file\n").unwrap();
            run_git_command(root, &["add", "ordinary.txt"], None);
            run_git_command(
                root,
                &[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "-qm",
                    "initial",
                ],
                None,
            );
        }
        run_git_command(
            &workspace,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                child.to_str().unwrap(),
                "sub",
            ],
            None,
        );
        let child_commit = run_git_command(&child, &["rev-parse", "HEAD"], None)
            .trim()
            .to_string();
        let tree = run_git_command(&workspace, &["write-tree"], None)
            .trim()
            .to_string();
        assert!(run_git_command(&workspace, &["ls-tree", &tree], None).contains("160000 commit"));
        let database = fixture.path().join("provider/opencode.db");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let source = create_synthetic_source(&database);
        source
            .execute(
                "UPDATE part SET data=?1 WHERE id='part_ses_root'",
                [serde_json::json!({"type":"step-start","snapshot":tree}).to_string()],
            )
            .unwrap();
        if native_store {
            // The pinned native snapshot seeds its index and alternates from the workspace.
            let bucket = database
                .parent()
                .unwrap()
                .join("snapshot/prj_kept")
                .join(format!(
                    "{:x}",
                    sha1::Sha1::digest(workspace.to_string_lossy().as_bytes())
                ));
            fs::create_dir_all(&bucket).unwrap();
            run_git_command(
                &workspace,
                &["--git-dir", bucket.to_str().unwrap(), "init", "-q"],
                None,
            );
            fs::copy(workspace.join(".git/index"), bucket.join("index")).unwrap();
            fs::create_dir_all(bucket.join("objects/info")).unwrap();
            fs::write(
                bucket.join("objects/info/alternates"),
                format!("{}\n", workspace.join(".git/objects").display()),
            )
            .unwrap();
        }
        let inventory =
            with_selected_workspace_mount(HostOpenCodeInventory::new(database), workspace);
        let exported = export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("extract")),
        )
        .expect("valid Gitlinks do not require objects from a separate repository");
        let payload: Value = serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
        let objects = payload["snapshot_objects"].as_array().unwrap();
        assert!(objects.iter().any(|object| object["object_id"] == tree));
        assert!(!objects
            .iter()
            .any(|object| object["object_id"] == child_commit));
        let saved_tree = objects
            .iter()
            .find(|object| object["object_id"] == tree)
            .unwrap();
        let compressed = hex::decode(saved_tree["compressed_hex"].as_str().unwrap()).unwrap();
        let mut native_tree = Vec::new();
        flate2::read::ZlibDecoder::new(compressed.as_slice())
            .read_to_end(&mut native_tree)
            .unwrap();
        let mut gitlink = b"160000 sub\0".to_vec();
        gitlink.extend(hex::decode(&child_commit).unwrap());
        assert!(
            native_tree
                .windows(gitlink.len())
                .any(|bytes| bytes == gitlink),
            "the exported tree retains its exact submodule identity"
        );
    }
}

#[test]
fn large_native_export_keeps_control_metadata_bounded_and_all_bulk_rows() {
    let fixture = TestDir::new("large-control-manifest");
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    for index in 0..300 {
        let message_id = format!("msg_large_{index:06}");
        source.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?1,'ses_root',?2,?2,?3)",
            params![message_id, index + 100, serde_json::json!({"role":"assistant","time":{"created":index+100},"modelID":"example","providerID":"example","mode":"build","cost":0,"tokens":{"input":100,"output":100,"reasoning":0,"cache":{"read":0,"write":0}}}).to_string()]).unwrap();
        for part in 0..2 {
            source.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?1,?2,'ses_root',?3,?3,?4)",
                params![format!("part_large_{index:06}_{part}"), message_id, index+100, serde_json::json!({"type":"text","text":"ordinary short assistant output"}).to_string()]).unwrap();
        }
    }
    let exported = export_exact_session(
        &HostOpenCodeInventory::new(database),
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .unwrap();
    let payload: Value = serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
    assert_eq!(payload["rows"].as_array().unwrap().len(), 919);
    assert!(payload["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["table"] == "part" && row["key"][0]["value"] == "part_large_000299_1"));
    let wire = serde_json::to_vec(exported.manifest()).unwrap();
    assert!(
        wire.len() < 16 * 1024,
        "growing bulk metadata must not consume the control frame: {} bytes",
        wire.len()
    );
    assert_eq!(exported.manifest().row_count, 919);
    let mut payload_bytes = Vec::new();
    exported
        .open_payload()
        .unwrap()
        .read_to_end(&mut payload_bytes)
        .unwrap();
    assert_eq!(
        exported.manifest().payload_sha256,
        format!("{:x}", Sha256::digest(&payload_bytes))
    );
}

#[test]
fn blocks_invalid_corrupt_and_incomplete_native_snapshot_parts() {
    for kind in ["snapshot", "step-start", "step-finish"] {
        let fixture = TestDir::new("invalid-native-snapshot-parts");
        let workspace = fixture.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        run_git_command(&workspace, &["init", "-q"], None);
        let blob = run_git_command(
            &workspace,
            &["hash-object", "-w", "--stdin"],
            Some(b"retained blob"),
        );
        let tree = run_git_command(
            &workspace,
            &["mktree"],
            Some(format!("100644 blob {}\tasset.txt\n", blob.trim()).as_bytes()),
        );
        let object_path = |id: &str| workspace.join(".git/objects").join(&id[..2]).join(&id[2..]);
        let blob_path = object_path(blob.trim());
        let tree_path = object_path(tree.trim());
        let blob_bytes = fs::read(&blob_path).unwrap();
        let tree_bytes = fs::read(&tree_path).unwrap();
        let database = fixture.path().join("opencode.db");
        let source = create_synthetic_source(&database);
        let set_reference = |reference: Value| {
            source
                .execute(
                    "UPDATE part SET data=?1 WHERE id='part_ses_root'",
                    [serde_json::json!({"type":kind,"snapshot":reference}).to_string()],
                )
                .unwrap();
        };
        set_reference(serde_json::json!(tree.trim()));
        let inventory =
            with_selected_workspace_mount(HostOpenCodeInventory::new(database), workspace.clone());
        let retained = export_exact_session(
            &inventory,
            "ses_root",
            ExportOptions::new(fixture.path().join("retained")),
        )
        .unwrap();
        let [reference] = retained.manifest().saved_snapshots.as_slice() else {
            panic!("one native snapshot reference has a complete retained closure");
        };
        assert_eq!(
            reference.availability,
            SavedSnapshotAvailability::RetainedClosure
        );
        assert_eq!(reference.objects.len(), 2);
        for fault in [
            "invalid-id",
            "nonstring",
            "wrong-kind",
            "corrupt",
            "incomplete",
        ] {
            match fault {
                "invalid-id" => set_reference(serde_json::json!("not-a-tree-id")),
                "nonstring" => set_reference(serde_json::json!(false)),
                "wrong-kind" => set_reference(serde_json::json!(blob.trim())),
                "corrupt" => {
                    fs::write(&tree_path, &blob_bytes).unwrap();
                }
                "incomplete" => {
                    fs::remove_file(&blob_path).unwrap();
                }
                _ => unreachable!(),
            }
            let extraction = fixture.path().join(fault);
            let result = export_exact_session(
                &inventory,
                "ses_root",
                ExportOptions::new(extraction.clone()),
            );
            assert!(
                matches!(result, Err(TransferError::Blocked(_))),
                "{kind} {fault} must refuse rather than qualify unavailable history"
            );
            assert_eq!(fs::read_dir(extraction).unwrap().count(), 0);
            fs::remove_file(&tree_path).unwrap();
            fs::write(&tree_path, &tree_bytes).unwrap();
            if blob_path.exists() {
                fs::remove_file(&blob_path).unwrap();
            }
            fs::write(&blob_path, &blob_bytes).unwrap();
            set_reference(serde_json::json!(tree.trim()));
        }
    }
}

#[cfg(unix)]
fn assert_missing_snapshot_with_pack_location(state: &str, blocked: bool) {
    use std::os::unix::fs::symlink;

    let fixture = TestDir::new("missing-snapshot-pack-location");
    let workspace = fixture.path().join("workspace");
    let objects = workspace.join(".git/objects");
    fs::create_dir_all(&objects).unwrap();
    let pack = objects.join("pack");
    match state {
        "absent" => {}
        "empty" => fs::create_dir(&pack).unwrap(),
        "dangling-link" => symlink(fixture.path().join("missing-pack"), &pack).unwrap(),
        "empty-link" => {
            let target = fixture.path().join("empty-pack");
            fs::create_dir(&target).unwrap();
            symlink(target, &pack).unwrap();
        }
        _ => unreachable!(),
    }
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let part = serde_json::json!({
        "type":"snapshot", "snapshot":"1234567890abcdef1234567890abcdef12345678"
    })
    .to_string();
    source
        .execute("UPDATE part SET data=?1 WHERE id='part_ses_root'", [&part])
        .unwrap();
    drop(source);
    let inventory = with_selected_workspace_mount(HostOpenCodeInventory::new(database), workspace);
    let extraction = fixture.path().join("extract");
    let result = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(extraction.clone()),
    );
    if blocked {
        assert!(
            matches!(result, Err(TransferError::Blocked(_))),
            "{state} must refuse rather than certify qualified snapshot absence"
        );
        assert_eq!(fs::read_dir(extraction).unwrap().count(), 0);
    } else {
        let exported = result.expect("an absent snapshot in a valid pack location is preserved");
        let [reference] = exported.manifest().saved_snapshots.as_slice() else {
            panic!("one absent snapshot reference is preserved");
        };
        assert_eq!(reference.tree, "1234567890abcdef1234567890abcdef12345678");
        assert_eq!(
            reference.availability,
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        );
        assert!(reference.objects.is_empty());
        assert!(exported.manifest().assets.is_empty());
        let payload: Value = serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
        let row = payload["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["table"] == "part")
            .unwrap();
        assert_eq!(row["values"]["data"]["value"], part);
        assert!(payload["snapshot_objects"].as_array().unwrap().is_empty());
    }
}

#[cfg(unix)]
#[test]
fn blocks_missing_snapshot_with_dangling_redirected_pack() {
    assert_missing_snapshot_with_pack_location("dangling-link", true);
}

#[cfg(unix)]
#[test]
fn blocks_missing_snapshot_with_empty_redirected_pack() {
    assert_missing_snapshot_with_pack_location("empty-link", true);
}

#[cfg(unix)]
#[test]
fn preserves_missing_snapshot_with_absent_or_empty_regular_pack() {
    for state in ["absent", "empty"] {
        assert_missing_snapshot_with_pack_location(state, false);
    }
}

#[test]
fn preserves_unavailable_snapshot_parts_across_native_history_projections() {
    for part in [
        serde_json::json!({"type":"snapshot","snapshot":"1234567890abcdef1234567890abcdef12345678"}),
        serde_json::json!({"type":"snapshot","tree":"1234567890abcdef1234567890abcdef12345678"}),
        serde_json::json!({"type":"step-start","snapshot":"1234567890abcdef1234567890abcdef12345678"}),
        serde_json::json!({"type":"step-finish","snapshot":"1234567890abcdef1234567890abcdef12345678","reason":"stop","cost":0,"tokens":{"input":1,"output":1}}),
    ] {
        let fixture = TestDir::new("unavailable-native-snapshot-parts");
        let workspace = fixture.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let database = fixture.path().join("opencode.db");
        let source = create_synthetic_source(&database);
        let part_json = serde_json::to_string_pretty(&part).unwrap();
        let message_json =
            serde_json::to_string_pretty(&serde_json::json!({"parts":[part]})).unwrap();
        let event_json = serde_json::to_string_pretty(&serde_json::json!({"part":part})).unwrap();
        let context_json =
            serde_json::to_string_pretty(&serde_json::json!({"messages":[{"parts":[part]}]}))
                .unwrap();
        let expected = [
            (
                "part",
                "data",
                "UPDATE part SET data=?1 WHERE id='part_ses_root'",
                part_json,
            ),
            (
                "event",
                "data",
                "UPDATE event SET type='message.part.updated.1',data=?1 WHERE id='evt_root'",
                event_json,
            ),
            (
                "session_message",
                "data",
                "UPDATE session_message SET data=?1 WHERE id='v2_root'",
                message_json.clone(),
            ),
            (
                "session_input",
                "prompt",
                "UPDATE session_input SET prompt=?1 WHERE id='input_root'",
                message_json,
            ),
            (
                "session_context_epoch",
                "snapshot",
                "UPDATE session_context_epoch SET snapshot=?1 WHERE session_id='ses_root'",
                context_json,
            ),
        ];
        for (_, _, update, json) in &expected {
            assert_eq!(source.execute(update, [json]).unwrap(), 1);
        }
        drop(source);
        let inventory =
            with_selected_workspace_mount(HostOpenCodeInventory::new(database), workspace);
        let qualified = freshell_sessions::opencode_transfer::capture_qualified_batch(
            &inventory,
            &["ses_root".into()],
            ExportOptions::new(fixture.path().join("qualify")),
        )
        .expect("absent undo objects do not prevent source graph qualification");
        let exported = export_exact_session(
            &qualified.inventory(),
            "ses_root",
            ExportOptions::new(fixture.path().join("extract")),
        )
        .expect("native snapshot and step references remain readable history");
        let manifest = exported.manifest();
        assert_eq!(manifest.row_count(), 19);
        let [reference] = manifest.saved_snapshots.as_slice() else {
            panic!("repeated history projections qualify one exact saved reference");
        };
        assert_eq!(reference.session_id, "ses_root");
        assert_eq!(reference.tree, "1234567890abcdef1234567890abcdef12345678");
        assert_eq!(
            reference.availability,
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        );
        assert!(reference.objects.is_empty());
        assert!(manifest.assets.is_empty());
        assert_eq!(
            freshell_sessions::opencode_transfer::saved_snapshot_summary(manifest),
            freshell_sessions::opencode_transfer::SavedSnapshotSummary::QualifiedReferences {
                retained_closure_count: 0,
                unavailable_reference_count: 1,
            }
        );
        let payload: Value = serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
        let rows = payload["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 19);
        assert!(payload["snapshot_objects"].as_array().unwrap().is_empty());
        for (table, column, _, json) in &expected {
            let row = rows
                .iter()
                .find(|row| {
                    row["table"] == *table
                        && (row["values"]["session_id"]["value"] == "ses_root"
                            || row["values"]["aggregate_id"]["value"] == "ses_root")
                })
                .unwrap();
            assert_eq!(
                row["values"][column]["value"].as_str().unwrap(),
                json,
                "{table}.{column} remains byte exact"
            );
        }
    }
}

fn assert_empty_native_snapshot_result(kind: &str) {
    let fixture = TestDir::new("empty-native-snapshot-result");
    let workspace = fixture.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let values = if kind.starts_with("revert") {
        let mut revert = serde_json::json!({"messageID":"msg_root","snapshot":""});
        if kind == "revert-precedence" {
            revert["tree"] = serde_json::json!("not-a-tree-id");
        }
        vec![
            (
                "session",
                "revert",
                "UPDATE session SET revert=?1 WHERE id='ses_root'",
                revert.clone(),
            ),
            (
                "event",
                "data",
                "UPDATE event SET type='session.updated.1',data=?1 WHERE id='evt_root'",
                serde_json::json!({"info":{"revert":revert}}),
            ),
        ]
    } else {
        let part = serde_json::json!({"type":kind,"snapshot":""});
        vec![
            (
                "part",
                "data",
                "UPDATE part SET data=?1 WHERE id='part_ses_root'",
                part.clone(),
            ),
            (
                "event",
                "data",
                "UPDATE event SET type='message.part.updated.1',data=?1 WHERE id='evt_root'",
                serde_json::json!({"part":part}),
            ),
            (
                "session_message",
                "data",
                "UPDATE session_message SET data=?1 WHERE id='v2_root'",
                serde_json::json!({"parts":[part]}),
            ),
            (
                "session_input",
                "prompt",
                "UPDATE session_input SET prompt=?1 WHERE id='input_root'",
                serde_json::json!({"parts":[part]}),
            ),
            (
                "session_context_epoch",
                "snapshot",
                "UPDATE session_context_epoch SET snapshot=?1 WHERE session_id='ses_root'",
                serde_json::json!({"messages":[{"parts":[part]}]}),
            ),
        ]
    };
    let mut expected = Vec::new();
    for (table, column, update, value) in values {
        let exact = serde_json::to_string_pretty(&value).unwrap();
        assert_eq!(source.execute(update, [&exact]).unwrap(), 1);
        expected.push((table, column, exact));
    }
    drop(source);
    let inventory = with_selected_workspace_mount(HostOpenCodeInventory::new(database), workspace);
    let qualified = freshell_sessions::opencode_transfer::capture_qualified_batch(
        &inventory,
        &["ses_root".into()],
        ExportOptions::new(fixture.path().join("qualify")),
    )
    .expect("native empty snapshot result preserves the entire qualified graph");
    let exported = export_exact_session(
        &qualified.inventory(),
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("an empty native result has no Git object to resolve");
    assert_eq!(exported.manifest().row_count(), 19);
    assert!(exported.manifest().saved_snapshots.is_empty());
    assert!(exported.manifest().assets.is_empty());
    let payload: Value = serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
    assert!(payload["snapshot_objects"].as_array().unwrap().is_empty());
    for (table, column, exact) in expected {
        let row = payload["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| {
                row["table"] == table
                    && (row["values"]["session_id"]["value"] == "ses_root"
                        || row["values"]["aggregate_id"]["value"] == "ses_root"
                        || row["values"]["id"]["value"] == "ses_root")
            })
            .unwrap();
        assert_eq!(row["values"][column]["value"].as_str().unwrap(), exact);
    }
}

#[test]
fn preserves_empty_native_snapshot_step_start() {
    assert_empty_native_snapshot_result("step-start");
}

#[test]
fn preserves_empty_native_snapshot_step_finish() {
    assert_empty_native_snapshot_result("step-finish");
}

#[test]
fn preserves_empty_native_snapshot_revert() {
    assert_empty_native_snapshot_result("revert");
}

#[test]
fn preserves_empty_native_snapshot_revert_precedence() {
    assert_empty_native_snapshot_result("revert-precedence");
}

#[test]
fn blocks_empty_unproven_snapshot_slots_and_malformed_native_revert_references() {
    for (kind, value) in [
        ("snapshot", serde_json::json!("")),
        ("revert-tree", serde_json::json!("")),
        ("revert-snapshot", serde_json::json!("not-a-tree-id")),
        ("revert-snapshot", serde_json::json!(false)),
    ] {
        let fixture = TestDir::new("strict-snapshot-result");
        let workspace = fixture.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let database = fixture.path().join("opencode.db");
        let source = create_synthetic_source(&database);
        if kind == "snapshot" {
            source
                .execute(
                    "UPDATE part SET data=?1 WHERE id='part_ses_root'",
                    [serde_json::json!({"type":"snapshot","snapshot":value}).to_string()],
                )
                .unwrap();
        } else {
            let field = if kind == "revert-tree" {
                "tree"
            } else {
                "snapshot"
            };
            let mut revert = serde_json::json!({"messageID":"msg_root"});
            revert[field] = value;
            source
                .execute(
                    "UPDATE session SET revert=?1 WHERE id='ses_root'",
                    [revert.to_string()],
                )
                .unwrap();
        }
        drop(source);
        let inventory =
            with_selected_workspace_mount(HostOpenCodeInventory::new(database), workspace);
        let extraction = fixture.path().join("extract");
        assert!(
            matches!(
                export_exact_session(
                    &inventory,
                    "ses_root",
                    ExportOptions::new(extraction.clone())
                ),
                Err(TransferError::Blocked(_))
            ),
            "{kind} must remain strict"
        );
        assert_eq!(fs::read_dir(extraction).unwrap().count(), 0);
    }
}

#[test]
fn durable_souls_saved_unavailable_tree_preserves_reference_and_history() {
    let fixture = TestDir::new("saved-unavailable-tree");
    let workspace = fixture.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let database = fixture.path().join("opencode.db");
    let source = create_synthetic_source(&database);
    let reference = serde_json::json!({"messageID":"msg_root","snapshot":"1234567890abcdef1234567890abcdef12345678"});
    source
        .execute(
            "UPDATE session SET revert=?1 WHERE id='ses_root'",
            [reference.to_string()],
        )
        .unwrap();
    drop(source);
    let before = fs::read(&database).unwrap();
    let inventory =
        with_selected_workspace_mount(HostOpenCodeInventory::new(database.clone()), workspace);
    let exported = export_exact_session(
        &inventory,
        "ses_root",
        ExportOptions::new(fixture.path().join("extract")),
    )
    .expect("unavailable saved undo tree does not erase or block preserved native history");
    let mut payload = String::new();
    exported
        .open_payload()
        .unwrap()
        .read_to_string(&mut payload)
        .unwrap();
    let payload: Value = serde_json::from_str(&payload).unwrap();
    let session = payload["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["table"] == "session" && row["values"]["id"]["value"] == "ses_root")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(session["values"]["revert"]["value"].as_str().unwrap())
            .unwrap(),
        reference
    );
    assert!(exported
        .manifest()
        .assets
        .iter()
        .all(|asset| asset.kind != "git_tree_reference"));
    let references = &exported.manifest().saved_snapshots;
    assert_eq!(references.len(), 1);
    assert_eq!(references[0].availability,freshell_sessions::opencode_transfer::SavedSnapshotAvailability::UnavailableInQualifiedLocations);
    assert!(references[0].objects.is_empty());
    assert_eq!(fs::read(database).unwrap(), before);
}

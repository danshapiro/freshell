use super::*;
use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferDescriptor,
    OpenCodeTransferFile,
};
use freshell_sessions::opencode_transfer::{
    export_exact_session, ExportOptions, HostOpenCodeInventory,
};
use rusqlite::params;
use std::{fs, path::PathBuf};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    descriptor: OpenCodeTransferDescriptor,
    staged_directory: PathBuf,
    destination_database: PathBuf,
    workspace: PathBuf,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let connection = Connection::open(&source).unwrap();
    connection
        .execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
        .unwrap();
    for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
        connection
            .execute(
                "INSERT INTO migration (id,time_completed) VALUES (?1,0)",
                [migration],
            )
            .unwrap();
    }
    connection
        .execute(
            "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?1,?2,1,1,'{}')",
            params!["project-one", workspace.to_string_lossy()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,?2,?3,?4,?5,?6,1,1)",
            params![
                "ses_root",
                "project-one",
                "synthetic-slug",
                workspace.to_string_lossy(),
                "synthetic title",
                "1.18.21"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?1,?2,1,1,?3)",
            params!["msg_one", "ses_root", r#"{"text":"UNIQUE_SYNTHETIC_CONVERSATION_BODY"}"#],
        )
        .unwrap();
    drop(connection);

    let snapshot = export_exact_session(
        &HostOpenCodeInventory::new(source.clone())
            .with_trusted_mount_for_selected_session(workspace.clone()),
        "ses_root",
        ExportOptions::new(directory.path().join("extraction")),
    )
    .unwrap();
    let mut payload = snapshot.open_payload().unwrap();
    let payload_path = directory.path().join("payload.json");
    let mut output = File::create(&payload_path).unwrap();
    io::copy(&mut payload, &mut output).unwrap();
    output.sync_all().unwrap();
    let payload_bytes = fs::read(&payload_path).unwrap();
    let payload_sha256 = sha256(&payload_bytes);
    let manifest_json = serde_json::to_string(snapshot.manifest()).unwrap();
    let files = vec![OpenCodeTransferFile {
        index: 0,
        relative_path: "payload.json".into(),
        size_bytes: payload_bytes.len() as u64,
        sha256: payload_sha256,
    }];
    let target_image_ref = format!("sha256:{}", "a".repeat(64));
    let descriptor = OpenCodeTransferDescriptor {
        transfer_id: "transfer-test".into(),
        provider: "opencode".into(),
        source_store_id: snapshot.manifest().source_store_id.clone(),
        root_session_id: "ses_root".into(),
        source_generation: snapshot.manifest().generation.clone(),
        provider_schema: DESTINATION_SCHEMA.into(),
        source_schema_fingerprint: snapshot.manifest().source_schema_fingerprint.clone(),
        migration_journal_fingerprint: snapshot.manifest().migration_journal_fingerprint.clone(),
        destination_store_id: "soul-test".into(),
        destination_database_path: ".local/share/opencode/opencode.db".into(),
        target_build_receipt: opencode_target_build_receipt(&target_image_ref, DESTINATION_SCHEMA),
        target_image_ref,
        incarnation_id: "incarnation-test".into(),
        manifest_json,
        total_bytes: payload_bytes.len() as u64,
        bundle_sha256: String::new(),
        files,
    };
    let mut descriptor = descriptor;
    descriptor.bundle_sha256 =
        opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
    let staged_directory = directory.path().join("ready");
    fs::create_dir(&staged_directory).unwrap();
    fs::copy(payload_path, staged_directory.join("entry-0000.bin")).unwrap();
    fs::write(
        staged_directory.join("descriptor.json"),
        serde_json::to_vec(&StageMetadata {
            descriptor: descriptor.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    fs::write(
        staged_directory.join("READY"),
        descriptor.bundle_sha256.as_bytes(),
    )
    .unwrap();

    Fixture {
        _directory: directory,
        descriptor,
        staged_directory,
        destination_database: workspace
            .parent()
            .unwrap()
            .join("provider/.local/share/opencode/opencode.db"),
        workspace,
    }
}

#[test]
fn imports_exact_rows_idempotently_and_returns_a_body_free_receipt() {
    let fixture = fixture();
    let receipt = import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let second = import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    assert_eq!(receipt, second);
    assert_eq!(receipt.row_count, 3);
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("UNIQUE_SYNTHETIC_CONVERSATION_BODY"));

    let connection = Connection::open(&fixture.destination_database).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM message", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn streamed_provider_import_hashes_the_pipe_and_rolls_back_a_truncated_payload() {
    let fixture = fixture();
    let staged_payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    let truncated = &staged_payload[..staged_payload.len() - 1];
    assert!(import_bundle_payload(
        &fixture.descriptor,
        truncated,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
    if fixture.destination_database.exists() {
        let connection = Connection::open(&fixture.destination_database).unwrap();
        let tables: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0, "truncated import must roll back schema and rows");
    }

    let receipt = import_bundle_payload(
        &fixture.descriptor,
        staged_payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    assert_eq!(receipt.row_count, 3);
}

#[test]
fn destination_capacity_is_checked_before_parent_or_database_creation() {
    struct NoCapacity;
    impl DestinationCapacityProvider for NoCapacity {
        fn available_bytes(&self, _existing_directory: &Path) -> io::Result<u64> {
            Ok(0)
        }
    }

    let fixture = fixture();
    let payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    assert!(import_bundle_payload_with_capacity(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
        &NoCapacity,
    )
    .is_err());
    assert!(!fixture.destination_database.exists());
    assert!(!fixture.destination_database.parent().unwrap().exists());
}

#[test]
fn conflicting_primary_key_rolls_back_without_overwriting_destination_data() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection
        .execute(
            "UPDATE session SET title='different' WHERE id='ses_root'",
            [],
        )
        .unwrap();
    drop(connection);

    assert!(import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
    let connection = Connection::open(&fixture.destination_database).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT title FROM session WHERE id='ses_root'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "different"
    );
}

#[test]
fn installed_store_probe_reopens_exact_database_read_only_and_returns_no_body() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let home = fixture.destination_database.ancestors().nth(4).unwrap();
    let xdg_data_home = home.join(".local/share");
    let xdg_config_home = home.join(".config");
    fs::create_dir_all(&xdg_config_home).unwrap();
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    let reader = super::InstalledStoreReaderContext {
        database_path: &fixture.destination_database,
        workspace_root: &fixture.workspace,
        provider_uid: uid,
        provider_gid: gid,
        home,
        xdg_data_home: &xdg_data_home,
        xdg_config_home: &xdg_config_home,
        cwd: &fixture.workspace,
    };
    let receipt = verify_installed_store(&fixture.descriptor, &reader).unwrap();
    assert_eq!(receipt.provider_uid, uid);
    assert_eq!(
        receipt.opencode_db,
        fixture.destination_database.to_string_lossy()
    );
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("UNIQUE_SYNTHETIC_CONVERSATION_BODY"));
}

use super::*;
use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferDescriptor,
    OpenCodeTransferFile,
};
use freshell_sessions::opencode_transfer::{
    export_exact_session, ExportOptions, HostOpenCodeInventory,
};
use rusqlite::params;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

struct Fixture {
    _directory: Option<TempDir>,
    root: PathBuf,
    descriptor: OpenCodeTransferDescriptor,
    staged_directory: PathBuf,
    destination_database: PathBuf,
    workspace: PathBuf,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = fixture_in(directory.path());
    fixture._directory = Some(directory);
    fixture
}

fn fixture_in(root: &Path) -> Fixture {
    fs::create_dir_all(root).unwrap();
    let source = root.join("source.sqlite");
    let workspace = root.join("workspace");
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
    let referenced_file = workspace.join("prompt.txt");
    fs::write(&referenced_file, b"synthetic referenced workspace asset").unwrap();
    connection
        .execute(
            "INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?1,?2,?3,1,1,?4)",
            params![
                "part_one",
                "msg_one",
                "ses_root",
                serde_json::json!({
                    "type": "file",
                    "mime": "text/plain",
                    "url": format!("file://{}", referenced_file.display())
                })
                .to_string()
            ],
        )
        .unwrap();
    drop(connection);

    let snapshot = export_exact_session(
        &HostOpenCodeInventory::new(source.clone())
            .with_trusted_mount_for_selected_session(workspace.clone()),
        "ses_root",
        ExportOptions::new(root.join("extraction")),
    )
    .unwrap();
    let mut payload = snapshot.open_payload().unwrap();
    let payload_path = root.join("payload.json");
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
    let staged_directory = root.join("ready");
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
    fs::write(
        root.join("transfer-descriptor.json"),
        serde_json::to_vec(&descriptor).unwrap(),
    )
    .unwrap();

    Fixture {
        _directory: None,
        root: root.to_path_buf(),
        descriptor,
        staged_directory,
        destination_database: root.join("provider/.local/share/opencode/opencode.db"),
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
    assert_eq!(receipt.row_count, 4);
    assert_eq!(receipt.asset_count, 1);
    assert_eq!(fixture.descriptor.files.len(), 1);
    let manifest: OpenCodeTransferManifest =
        serde_json::from_str(&fixture.descriptor.manifest_json).unwrap();
    assert_eq!(manifest.assets.len(), 1);
    assert_eq!(manifest.assets[0].kind, "workspace_path_reference");
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
    assert_eq!(receipt.row_count, 4);
    assert_eq!(receipt.asset_count, 1);
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

#[cfg(unix)]
#[test]
#[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
fn opencode_importer_restarts_after_native_transaction_boundaries() {
    use std::{os::unix::process::ExitStatusExt, process::Command};

    const ROOT_ENV: &str = "FRESHELL_OPENCODE_IMPORT_CRASH_ROOT";
    const POINT_ENV: &str = "FRESHELL_OPENCODE_IMPORT_CRASH_POINT";
    let executable = std::env::current_exe().expect("resolve this test executable");

    for point in [
        "import.before_transaction_commit",
        "import.after_transaction_commit",
        "import.after_database_sync",
        "import.after_receipt_constructed",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let fixture = fixture_in(directory.path());
        assert_eq!(fixture.descriptor.files.len(), 1);
        let child = Command::new(&executable)
            .args([
                "--exact",
                "opencode_transfer::tests::opencode_importer_process_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env(ROOT_ENV, &fixture.root)
            .env(POINT_ENV, point)
            .status()
            .expect("spawn synthetic importer crash child");
        assert_eq!(
            child.signal(),
            Some(libc::SIGKILL),
            "child must be killed at native DB boundary {point}; exit={child:?}"
        );

        let descriptor: OpenCodeTransferDescriptor = serde_json::from_slice(
            &fs::read(fixture.root.join("transfer-descriptor.json")).unwrap(),
        )
        .unwrap();
        let destination = fixture
            .root
            .join("provider/.local/share/opencode/opencode.db");
        let workspace = fixture.root.join("workspace");
        if point == "import.before_transaction_commit" && destination.exists() {
            let connection = Connection::open(&destination).unwrap();
            let session_tables: i64 = connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                session_tables, 0,
                "an interrupted uncommitted schema and graph must not be visible after SQLite recovery"
            );
        }

        let receipt = import_bundle(
            &descriptor,
            &fixture.root.join("ready"),
            &destination,
            &workspace,
        )
        .expect("identical retry must reconstruct only the complete exact imported baseline");
        assert_eq!(receipt.row_count, 4);
        assert_eq!(receipt.asset_count, 1);
        assert!(!serde_json::to_string(&receipt)
            .unwrap()
            .contains("UNIQUE_SYNTHETIC_CONVERSATION_BODY"));

        let retry = import_bundle(
            &descriptor,
            &fixture.root.join("ready"),
            &destination,
            &workspace,
        )
        .expect("a complete same-generation retry is an identical no-op");
        assert_eq!(retry, receipt);

        let home = fixture.root.join("provider");
        let xdg_data_home = home.join(".local/share");
        let readable = verify_installed_store(
            &descriptor,
            &InstalledStoreReaderContext {
                database_path: &destination,
                workspace_root: &workspace,
                provider_uid: unsafe { libc::geteuid() },
                provider_gid: unsafe { libc::getegid() },
                home: &home,
                xdg_data_home: &xdg_data_home,
                xdg_config_home: &home.join(".config"),
                cwd: &workspace,
            },
        )
        .expect("restart must independently read the DB and referenced asset");
        assert_eq!(readable.asset_count, 1);
        assert_eq!(readable.structural_sha256, receipt.structural_sha256);

        let mut conflicting = descriptor.clone();
        conflicting.destination_store_id = "other-synthetic-soul".into();
        assert!(import_bundle(
            &conflicting,
            &fixture.root.join("ready"),
            &destination,
            &workspace,
        )
        .is_err());
        assert_eq!(
            verify_installed_store(
                &descriptor,
                &InstalledStoreReaderContext {
                    database_path: &destination,
                    workspace_root: &workspace,
                    provider_uid: unsafe { libc::geteuid() },
                    provider_gid: unsafe { libc::getegid() },
                    home: &home,
                    xdg_data_home: &xdg_data_home,
                    xdg_config_home: &home.join(".config"),
                    cwd: &workspace,
                },
            )
            .unwrap(),
            readable,
            "a stale/conflicting descriptor cannot overwrite or authorize the installed generation"
        );
    }
}

#[cfg(unix)]
#[test]
#[ignore = "child fixture for opencode_importer_restarts_after_native_transaction_boundaries"]
fn opencode_importer_process_crash_child() {
    const ROOT_ENV: &str = "FRESHELL_OPENCODE_IMPORT_CRASH_ROOT";
    let Some(root) = std::env::var_os(ROOT_ENV).map(PathBuf::from) else {
        return;
    };
    let descriptor: OpenCodeTransferDescriptor =
        serde_json::from_slice(&fs::read(root.join("transfer-descriptor.json")).unwrap()).unwrap();
    import_bundle(
        &descriptor,
        &root.join("ready"),
        &root.join("provider/.local/share/opencode/opencode.db"),
        &root.join("workspace"),
    )
    .unwrap();
    unreachable!("the selected importer failpoint must kill this child process");
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

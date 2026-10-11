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
    fixture_with_event_and_v2_context(root, false, false)
}

fn fixture_with_baseline_event() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = fixture_in_with_baseline_event(directory.path(), true);
    fixture._directory = Some(directory);
    fixture
}

fn fixture_with_baseline_event_workspace_id(workspace_id: &str) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = fixture_with_event_and_v2_context_and_workspace(
        directory.path(),
        true,
        false,
        Some(workspace_id),
        Some(workspace_id),
    );
    fixture._directory = Some(directory);
    fixture
}

fn fixture_with_baseline_workspace_id_without_event_field(workspace_id: &str) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = fixture_with_event_and_v2_context_and_workspace(
        directory.path(),
        true,
        false,
        Some(workspace_id),
        None,
    );
    fixture._directory = Some(directory);
    fixture
}

fn fixture_in_with_baseline_event(root: &Path, baseline_event: bool) -> Fixture {
    fixture_with_event_and_v2_context(root, baseline_event, false)
}

fn fixture_with_baseline_v2_context_message() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut fixture = fixture_with_event_and_v2_context(directory.path(), true, true);
    fixture._directory = Some(directory);
    fixture
}

fn fixture_with_event_and_v2_context(
    root: &Path,
    baseline_event: bool,
    baseline_v2_context: bool,
) -> Fixture {
    fixture_with_event_and_v2_context_and_workspace(
        root,
        baseline_event,
        baseline_v2_context,
        None,
        None,
    )
}

fn fixture_with_event_and_v2_context_and_workspace(
    root: &Path,
    baseline_event: bool,
    baseline_v2_context: bool,
    baseline_database_workspace_id: Option<&str>,
    baseline_event_workspace_id: Option<&str>,
) -> Fixture {
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
    if let Some(workspace_id) = baseline_database_workspace_id {
        connection
            .execute(
                "INSERT INTO workspace (id,type,name,project_id,time_used) VALUES (?1,'directory','workspace','project-one',1)",
                [workspace_id],
            )
            .unwrap();
    }
    connection
        .execute(
            "INSERT INTO session (id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,?2,?3,?4,?5,?6,?7,1,1)",
            params![
                "ses_root",
                "project-one",
                baseline_database_workspace_id,
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
    if baseline_event {
        connection
            .execute(
                "INSERT INTO event_sequence (aggregate_id,seq,owner_id) VALUES ('ses_root',0,'owner')",
                [],
            )
            .unwrap();
        let mut info = serde_json::json!({
            "id":"ses_root",
            "slug":"synthetic-slug",
            "projectID":"project-one",
            "directory":workspace.to_string_lossy(),
            "title":"synthetic title",
            "version":"1.18.21",
            "time":{"created":1,"updated":1}
        });
        if let Some(workspace_id) = baseline_event_workspace_id {
            info["workspaceID"] = serde_json::json!(workspace_id);
        }
        connection
            .execute(
                "INSERT INTO event (id,aggregate_id,seq,type,data) VALUES ('evt_base','ses_root',0,'session.created.1',?1)",
                [serde_json::json!({"sessionID":"ses_root","info":info}).to_string()],
        )
        .unwrap();
    }
    if baseline_v2_context {
        connection
            .execute(
                "INSERT INTO session_message
                 (id,session_id,type,seq,time_created,time_updated,data)
                 VALUES('msg_context','ses_root','system',0,20,25,?1)",
                [serde_json::json!({
                    "text":"baseline system context",
                    "time":{"created":20}
                })
                .to_string()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE event SET type='session.next.context.updated.1',data=?1 WHERE id='evt_base'",
                [serde_json::json!({
                    "sessionID":"ses_root",
                    "messageID":"msg_context",
                    "timestamp":20,
                    "text":"baseline system context"
                })
                .to_string()],
            )
            .unwrap();
    }
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
fn current_store_verification_accepts_complete_import_and_derives_current_tail() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let evidence = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("an exact imported baseline is verified");

    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_one".into()
        }
    );
    assert_eq!(
        evidence.import_generation,
        fixture.descriptor.source_generation
    );
    assert_eq!(evidence.evidence_generation.len(), 64);
    assert!(!format!("{evidence:?}").contains("UNIQUE_SYNTHETIC_CONVERSATION_BODY"));
}

#[test]
fn current_store_verification_accepts_fractional_v1_message_and_part_timestamps() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let connection = Connection::open(&fixture.destination_database).unwrap();
    let info = serde_json::json!({
        "id":"msg_fractional",
        "sessionID":"ses_root",
        "role":"user",
        "time":{"created":10.5},
        "agent":"build",
        "model":{"providerID":"provider-one","modelID":"model-one"}
    });
    let mut message_data = info.as_object().unwrap().clone();
    message_data.remove("id");
    message_data.remove("sessionID");
    append_durable_event(
        &connection,
        1,
        "evt_fractional_message",
        "message.updated.1",
        serde_json::json!({"sessionID":"ses_root","info":info}),
    );
    connection
        .execute(
            "INSERT INTO message(id,session_id,time_created,time_updated,data)
             VALUES('msg_fractional','ses_root',10.5,12,?1)",
            [serde_json::Value::Object(message_data).to_string()],
        )
        .unwrap();

    let part = serde_json::json!({
        "id":"prt_fractional",
        "sessionID":"ses_root",
        "messageID":"msg_fractional",
        "type":"text",
        "text":"fractional event time"
    });
    let mut part_data = part.as_object().unwrap().clone();
    part_data.remove("id");
    part_data.remove("sessionID");
    part_data.remove("messageID");
    append_durable_event(
        &connection,
        2,
        "evt_fractional_part",
        "message.part.updated.1",
        serde_json::json!({"sessionID":"ses_root","part":part,"time":11.5}),
    );
    connection
        .execute(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data)
             VALUES('prt_fractional','msg_fractional','ses_root',11.5,12,?1)",
            [serde_json::Value::Object(part_data).to_string()],
        )
        .unwrap();
    drop(connection);

    let evidence = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("the V1 finite timestamp fields project without integer coercion");
    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_fractional".into()
        }
    );
}

#[test]
fn current_store_verification_rejects_fractional_event_timestamp_matching_integer_row() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_v1_user_message(
        &connection,
        1,
        "evt_fractional_integer_mismatch",
        "msg_fractional_integer_mismatch",
        serde_json::json!(10.5),
        10,
        11,
    );
    drop(connection);

    assert!(
        verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .is_err(),
        "a fractional event timestamp must not match a truncated INTEGER row timestamp"
    );
}

#[test]
fn current_store_verification_rejects_adjacent_large_integer_message_timestamps() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_v1_user_message(
        &connection,
        1,
        "evt_large_timestamp",
        "msg_large_timestamp",
        serde_json::json!(9007199254740992i64),
        9007199254740993i64,
        9007199254740994i64,
    );
    drop(connection);

    assert!(
        verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .is_err(),
        "distinct INTEGER timestamps above 2^53 must not compare equal"
    );
}

#[test]
fn current_store_verification_rejects_adjacent_large_integer_part_timestamps() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_v1_user_message(
        &connection,
        1,
        "evt_large_parent_message",
        "msg_large_parent",
        serde_json::json!(9007199254740992i64),
        9007199254740992i64,
        9007199254740993i64,
    );
    let part = serde_json::json!({
        "id":"prt_large_timestamp",
        "sessionID":"ses_root",
        "messageID":"msg_large_parent",
        "type":"text",
        "text":"large integer timestamp"
    });
    let mut part_data = part.as_object().unwrap().clone();
    part_data.remove("id");
    part_data.remove("sessionID");
    part_data.remove("messageID");
    append_durable_event(
        &connection,
        2,
        "evt_large_part_timestamp",
        "message.part.updated.1",
        serde_json::json!({
            "sessionID":"ses_root",
            "part":part,
            "time":9007199254740992i64
        }),
    );
    connection
        .execute(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data)
             VALUES('prt_large_timestamp','msg_large_parent','ses_root',?1,?2,?3)",
            params![
                9007199254740993i64,
                9007199254740994i64,
                serde_json::Value::Object(part_data).to_string()
            ],
        )
        .unwrap();
    drop(connection);

    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_orders_large_integer_v1_timestamps_exactly() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_v1_user_message(
        &connection,
        1,
        "evt_large_early",
        "msg_z_early",
        serde_json::json!(9007199254740992i64),
        9007199254740992i64,
        9007199254740992i64,
    );
    append_v1_user_message(
        &connection,
        2,
        "evt_large_late",
        "msg_a_late",
        serde_json::json!(9007199254740993i64),
        9007199254740993i64,
        9007199254740993i64,
    );
    drop(connection);

    let evidence = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("both exact integer message timestamps are witnessed");
    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_a_late".into()
        }
    );
}

#[test]
fn current_store_verification_canonicalizes_fractional_v2_datetime_timestamps() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let event_data = serde_json::json!({
        "sessionID":"ses_root",
        "messageID":"msg_fractional_context",
        "timestamp":20.5,
        "text":"canonical millisecond projection"
    });
    validate_v2_event_payload("session.next.context.updated", &event_data, "ses_root")
        .expect("the pinned codec accepts finite fractional milliseconds");

    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_durable_event(
        &connection,
        1,
        "evt_fractional_context",
        "session.next.context.updated.1",
        event_data,
    );
    connection
        .execute(
            "INSERT INTO session_message
             (id,session_id,type,seq,time_created,time_updated,data)
             VALUES('msg_fractional_context','ses_root','system',1,20,20,?1)",
            [serde_json::json!({
                "text":"canonical millisecond projection",
                "time":{"created":20}
            })
            .to_string()],
        )
        .unwrap();
    drop(connection);

    let evidence = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("DateTime.makeUnsafe(20.5) encodes as epoch millisecond 20");
    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_fractional_context".into()
        }
    );
}

#[test]
fn current_store_verification_checks_v1_session_workspace_id_prefix() {
    for (workspace_id, should_verify) in [("wrk_valid", true), ("ws_invalid", false)] {
        let fixture = fixture_with_baseline_event_workspace_id(workspace_id);
        import_bundle(
            &fixture.descriptor,
            &fixture.staged_directory,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .unwrap();

        let result = verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        );
        assert_eq!(
            result.is_ok(),
            should_verify,
            "workspace ID {workspace_id}: {result:?}"
        );
    }
}

#[test]
fn current_store_verification_checks_v2_location_workspace_id_prefix() {
    for (workspace_id, should_verify) in [("wrk_valid", true), ("ws_invalid", false)] {
        let fixture = fixture_with_baseline_workspace_id_without_event_field(workspace_id);
        import_bundle(
            &fixture.descriptor,
            &fixture.staged_directory,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .unwrap();

        let moved = serde_json::json!({
            "sessionID":"ses_root",
            "timestamp":10.5,
            "location":{
                "directory":fixture.workspace.to_string_lossy(),
                "workspaceID":workspace_id
            },
            "subdirectory":"src"
        });
        let connection = Connection::open(&fixture.destination_database).unwrap();
        connection
            .execute(
                "UPDATE session SET path='src',workspace_id=?1,time_updated=10 WHERE id='ses_root'",
                [workspace_id],
            )
            .unwrap();
        append_durable_event(
            &connection,
            1,
            "evt_moved_workspace",
            "session.next.moved.1",
            moved,
        );
        drop(connection);

        let result = verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        );
        assert_eq!(
            result.is_ok(),
            should_verify,
            "workspace ID {workspace_id}: {result:?}"
        );
    }
}

#[test]
fn current_store_verification_uses_current_tail_after_more_than_hydration_window() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let initial = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    append_messages_with_events(&fixture, 105);

    let current = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("ordered appends with contiguous provider events are supported");
    assert_eq!(
        current.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_append_104".into()
        }
    );
    assert_ne!(current.evidence_generation, initial.evidence_generation);
}

#[test]
fn current_store_verification_recomputes_tail_at_supported_revert_boundary() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    append_messages_with_events(&fixture, 105);
    let before_revert = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();

    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection
        .execute(
            "UPDATE session SET revert=?1 WHERE id='ses_root'",
            [r#"{"messageID":"msg_append_030"}"#],
        )
        .unwrap();
    connection
        .execute("UPDATE session SET time_updated=2 WHERE id='ses_root'", [])
        .unwrap();
    connection
        .execute(
            "UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id='ses_root'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO event (id,aggregate_id,seq,type,data)
             VALUES ('evt_revert','ses_root',105,'session.next.revert.staged.1',?1)",
            [r#"{"sessionID":"ses_root","timestamp":2,"revert":{"messageID":"msg_append_030"}}"#],
        )
        .unwrap();
    drop(connection);

    let current = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("a boundary tied to a revert-staged event is supported");
    assert_eq!(
        current.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_append_029".into()
        }
    );
    assert_ne!(
        current.evidence_generation,
        before_revert.evidence_generation
    );
}

#[test]
fn current_store_verification_keeps_part_revert_boundary_as_current_tail() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    append_messages_with_events(&fixture, 35);
    let revert = serde_json::json!({
        "messageID":"msg_append_030",
        "partID":"prt_boundary"
    });
    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection
        .execute(
            "UPDATE session SET revert=?1,time_updated=2 WHERE id='ses_root'",
            [revert.to_string()],
        )
        .unwrap();
    append_durable_event(
        &connection,
        35,
        "evt_part_revert",
        "session.next.revert.staged.1",
        serde_json::json!({"sessionID":"ses_root","timestamp":2,"revert":revert}),
    );
    drop(connection);

    let evidence = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("the exact part-revert event preserves its boundary message");
    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_append_030".into()
        }
    );
}

#[test]
fn current_store_verification_replays_v2_revert_and_derives_boundary_tail() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_durable_event(
        &connection,
        1,
        "evt_context_boundary",
        "session.next.context.updated.1",
        serde_json::json!({
            "sessionID":"ses_root","messageID":"msg_v2_boundary","timestamp":20,"text":"boundary"
        }),
    );
    connection
        .execute(
            "INSERT INTO session_message
             (id,session_id,type,seq,time_created,time_updated,data)
             VALUES('msg_v2_boundary','ses_root','system',1,20,20,?1)",
            [serde_json::json!({"text":"boundary","time":{"created":20}}).to_string()],
        )
        .unwrap();
    append_durable_event(
        &connection,
        2,
        "evt_after_boundary",
        "session.next.synthetic.1",
        serde_json::json!({
            "sessionID":"ses_root","messageID":"msg_v2_after","timestamp":30,"text":"after boundary"
        }),
    );
    connection
        .execute(
            "INSERT INTO session_message
             (id,session_id,type,seq,time_created,time_updated,data)
             VALUES('msg_v2_after','ses_root','synthetic',2,30,30,?1)",
            [serde_json::json!({
                "sessionID":"ses_root","text":"after boundary","time":{"created":30}
            })
            .to_string()],
        )
        .unwrap();
    append_durable_event(
        &connection,
        3,
        "evt_v2_revert",
        "session.next.revert.committed.1",
        serde_json::json!({
            "sessionID":"ses_root","timestamp":40,"messageID":"msg_v2_boundary"
        }),
    );
    connection
        .execute("DELETE FROM session_message WHERE id='msg_v2_after'", [])
        .unwrap();
    drop(connection);

    let evidence = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("the durable V2 revert proves exact suffix removal");
    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_v2_boundary".into()
        }
    );
}

#[test]
fn current_store_verification_rejects_deleted_baseline_rows_and_event_gaps() {
    let deleted = fixture();
    import_bundle(
        &deleted.descriptor,
        &deleted.staged_directory,
        &deleted.destination_database,
        &deleted.workspace,
    )
    .unwrap();
    Connection::open(&deleted.destination_database)
        .unwrap()
        .execute("DELETE FROM part WHERE id='part_one'", [])
        .unwrap();
    assert!(verify_current_store(
        &deleted.descriptor,
        &deleted.destination_database,
        &deleted.workspace,
    )
    .is_err());

    let corrupted = fixture();
    import_bundle(
        &corrupted.descriptor,
        &corrupted.staged_directory,
        &corrupted.destination_database,
        &corrupted.workspace,
    )
    .unwrap();
    append_messages_with_events_starting_at(&corrupted, 2, 2);
    assert!(verify_current_store(
        &corrupted.descriptor,
        &corrupted.destination_database,
        &corrupted.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_blocks_unqualified_transcript_removal_events() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_durable_event(
        &connection,
        1,
        "evt_message_removed",
        "message.removed.1",
        serde_json::json!({"sessionID":"ses_root","messageID":"msg_one"}),
    );
    drop(connection);

    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_accepts_contiguous_advance_and_rejects_cursor_rollback() {
    let advanced = fixture_with_baseline_event();
    import_bundle(
        &advanced.descriptor,
        &advanced.staged_directory,
        &advanced.destination_database,
        &advanced.workspace,
    )
    .unwrap();
    append_messages_with_events_starting_at(&advanced, 2, 1);
    let evidence = verify_current_store(
        &advanced.descriptor,
        &advanced.destination_database,
        &advanced.workspace,
    )
    .expect("the provider may advance the imported cursor by contiguous events");
    assert_eq!(
        evidence.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_append_001".into()
        }
    );

    let rolled_back = fixture_with_baseline_event();
    import_bundle(
        &rolled_back.descriptor,
        &rolled_back.staged_directory,
        &rolled_back.destination_database,
        &rolled_back.workspace,
    )
    .unwrap();
    Connection::open(&rolled_back.destination_database)
        .unwrap()
        .execute(
            "UPDATE event_sequence SET seq=-1 WHERE aggregate_id='ses_root'",
            [],
        )
        .unwrap();
    assert!(verify_current_store(
        &rolled_back.descriptor,
        &rolled_back.destination_database,
        &rolled_back.workspace,
    )
    .is_err());

    let extreme = fixture();
    import_bundle(
        &extreme.descriptor,
        &extreme.staged_directory,
        &extreme.destination_database,
        &extreme.workspace,
    )
    .unwrap();
    Connection::open(&extreme.destination_database)
        .unwrap()
        .execute(
            "INSERT INTO event_sequence(aggregate_id,seq,owner_id) VALUES('ses_root',?1,'owner')",
            [i64::MAX],
        )
        .unwrap();
    assert!(verify_current_store(
        &extreme.descriptor,
        &extreme.destination_database,
        &extreme.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_rejects_row_changes_not_reflected_in_the_event_value() {
    let fixture = fixture();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    append_messages_with_events(&fixture, 1);
    Connection::open(&fixture.destination_database)
        .unwrap()
        .execute(
            "UPDATE message SET data=?1 WHERE id='msg_append_000'",
            [r#"{"role":"assistant","text":"unbound mutation","time":{"created":2,"updated":2}}"#],
        )
        .unwrap();
    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_rejects_a_row_matching_only_an_older_event() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    append_messages_with_events_starting_at(&fixture, 1, 1);
    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_durable_event(
        &connection,
        2,
        "evt_message_updated_again",
        "message.updated.1",
        serde_json::json!({
            "sessionID":"ses_root",
            "info":{
                "id":"msg_append_000",
                "sessionID":"ses_root",
                "role":"assistant",
                "time":{"created":2,"updated":3}
            }
        }),
    );
    drop(connection);

    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_rejects_a_part_matching_only_an_older_event() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    let baseline_data: serde_json::Value = connection
        .query_row("SELECT data FROM part WHERE id='part_one'", [], |row| {
            row.get::<_, String>(0)
        })
        .map(|data| serde_json::from_str(&data).unwrap())
        .unwrap();
    let mut current_data = baseline_data.as_object().unwrap().clone();
    current_data.insert("mime".into(), "text/markdown".into());
    let current_data = serde_json::Value::Object(current_data);
    connection
        .execute(
            "UPDATE part SET data=?1 WHERE id='part_one'",
            [current_data.to_string()],
        )
        .unwrap();
    for (sequence, event_id, data) in [
        (1, "evt_part_update_old", current_data.clone()),
        (2, "evt_part_update_new", baseline_data),
    ] {
        let mut part = data.as_object().unwrap().clone();
        part.insert("id".into(), "part_one".into());
        part.insert("sessionID".into(), "ses_root".into());
        part.insert("messageID".into(), "msg_one".into());
        append_durable_event(
            &connection,
            sequence,
            event_id,
            "message.part.updated.1",
            serde_json::json!({
                "sessionID":"ses_root",
                "part":serde_json::Value::Object(part),
                "time":1
            }),
        );
    }
    drop(connection);

    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

#[test]
fn session_snapshot_event_cannot_attest_usage_after_a_later_step_finish() {
    let make_event = |seq: i64, event_type: &str, data: serde_json::Value| SerializedRow {
        table: "event".into(),
        key: Vec::new(),
        values: BTreeMap::from([
            (
                "aggregate_id".into(),
                SerializedSqlValue::Text {
                    value: "ses_root".into(),
                },
            ),
            ("seq".into(), SerializedSqlValue::Integer { value: seq }),
            (
                "type".into(),
                SerializedSqlValue::Text {
                    value: format!("{event_type}.1"),
                },
            ),
            (
                "data".into(),
                SerializedSqlValue::Text {
                    value: data.to_string(),
                },
            ),
        ]),
    };
    let update = make_event(
        1,
        "session.updated",
        serde_json::json!({"sessionID":"ses_root","info":{"id":"ses_root"}}),
    );
    let finish = make_event(
        2,
        "message.part.updated",
        serde_json::json!({
            "sessionID":"ses_root",
            "part":{"id":"part_finish","sessionID":"ses_root","messageID":"msg","type":"step-finish"},
            "time":20
        }),
    );
    let current_update = make_event(
        3,
        "session.updated",
        serde_json::json!({"sessionID":"ses_root","info":{"id":"ses_root"}}),
    );
    let events = vec![update.clone(), finish.clone(), current_update.clone()];

    assert!(!session_snapshot_event_is_current(&update, &events, "ses_root").unwrap());
    assert!(session_snapshot_event_is_current(&current_update, &events, "ses_root").unwrap());
}

#[test]
fn current_store_verification_accepts_exact_admitted_and_promoted_input_projection() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let prompt = serde_json::json!({"text":"synthetic queued prompt","files":[],"agents":[]});
    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_durable_event(
        &connection,
        1,
        "evt_admitted",
        "session.next.prompt.admitted.1",
        serde_json::json!({
            "sessionID":"ses_root",
            "messageID":"msg_pending",
            "timestamp":20.5,
            "prompt":prompt,
            "delivery":"queue"
        }),
    );
    connection
        .execute(
            "INSERT INTO session_input
             (id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
             VALUES('msg_pending','ses_root',?1,'queue',1,NULL,20)",
            [prompt.to_string()],
        )
        .unwrap();
    append_durable_event(
        &connection,
        2,
        "evt_prompted",
        "session.next.prompted.1",
        serde_json::json!({
            "sessionID":"ses_root",
            "messageID":"msg_pending",
            "timestamp":20.5,
            "prompt":prompt,
            "delivery":"queue"
        }),
    );
    connection
        .execute(
            "UPDATE session_input SET promoted_seq=2 WHERE id='msg_pending'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_message
             (id,session_id,type,seq,time_created,time_updated,data)
             VALUES('msg_pending','ses_root','user',2,20,20,?1)",
            [serde_json::json!({
                "text":"synthetic queued prompt",
                "files":[],
                "agents":[],
                "time":{"created":20}
            })
            .to_string()],
        )
        .unwrap();
    drop(connection);

    verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("admission and promotion events bind the exact input projection");
}

#[test]
fn current_store_verification_accepts_todowrite_projection_only_when_payload_matches() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let todos = serde_json::json!([
        {"content":"inspect transfer","status":"completed","priority":"high"},
        {"content":"write tests","status":"in_progress","priority":"medium"}
    ]);
    let connection = Connection::open(&fixture.destination_database).unwrap();
    append_durable_event(
        &connection,
        1,
        "evt_todowrite_called",
        "session.next.tool.called.1",
        serde_json::json!({
            "sessionID":"ses_root",
            "timestamp":20.5,
            "assistantMessageID":"msg_assistant",
            "callID":"call_todo",
            "tool":"todowrite",
            "input":{"todos":todos},
            "provider":{"executed":false}
        }),
    );
    append_durable_event(
        &connection,
        2,
        "evt_todowrite_success",
        "session.next.tool.success.1",
        serde_json::json!({
            "sessionID":"ses_root",
            "timestamp":30.5,
            "assistantMessageID":"msg_assistant",
            "callID":"call_todo",
            "structured":{"todos":todos},
            "content":[{"type":"text","text":"2 todos"}],
            "provider":{"executed":false}
        }),
    );
    for (position, todo) in todos.as_array().unwrap().iter().enumerate() {
        connection
            .execute(
                "INSERT INTO todo(session_id,content,status,priority,position,time_created,time_updated)
                 VALUES('ses_root',?1,?2,?3,?4,25,25)",
                params![
                    todo["content"].as_str().unwrap(),
                    todo["status"].as_str().unwrap(),
                    todo["priority"].as_str().unwrap(),
                    position as i64,
                ],
            )
            .unwrap();
    }
    drop(connection);

    verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("a durable successful todowrite pair proves ordered todo values");

    Connection::open(&fixture.destination_database)
        .unwrap()
        .execute(
            "UPDATE todo SET content='unbound todo value' WHERE session_id='ses_root' AND position=1",
            [],
        )
        .unwrap();
    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

#[test]
fn current_store_verification_accepts_exact_context_and_compaction_messages() {
    for (event_type, event_data, message_id, message_type, message_data) in [
        (
            "session.next.context.updated.1",
            serde_json::json!({
                "sessionID":"ses_root","messageID":"msg_context","timestamp":20,"text":"new exact system context"
            }),
            "msg_context",
            "system",
            serde_json::json!({"text":"new exact system context","time":{"created":20}}),
        ),
        (
            "session.next.compaction.ended.1",
            serde_json::json!({
                "sessionID":"ses_root","messageID":"msg_compaction","timestamp":20,
                "reason":"auto","text":"synthetic summary","recent":"synthetic recent history"
            }),
            "msg_compaction",
            "compaction",
            serde_json::json!({
                "reason":"auto","summary":"synthetic summary","recent":"synthetic recent history","time":{"created":20}
            }),
        ),
    ] {
        let fixture = fixture_with_baseline_event();
        import_bundle(
            &fixture.descriptor,
            &fixture.staged_directory,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .unwrap();
        let connection = Connection::open(&fixture.destination_database).unwrap();
        append_durable_event(&connection, 1, "evt_projection", event_type, event_data);
        connection
            .execute(
                "INSERT INTO session_message
                 (id,session_id,type,seq,time_created,time_updated,data)
                 VALUES(?1,'ses_root',?2,1,20,20,?3)",
                params![message_id, message_type, message_data.to_string()],
            )
            .unwrap();
        drop(connection);

        let evidence = verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .unwrap_or_else(|error| panic!("exact `{event_type}` projection should verify: {error}"));
        assert_eq!(
            evidence.root_tail,
            VerifiedRootTail::Message {
                message_id: message_id.into()
            }
        );

        Connection::open(&fixture.destination_database)
            .unwrap()
            .execute(
                "UPDATE session_message SET time_updated=?1 WHERE id=?2",
                params![i64::MAX, message_id],
            )
            .unwrap();
        assert!(verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .is_err());
        Connection::open(&fixture.destination_database)
            .unwrap()
            .execute(
                "UPDATE session_message SET time_updated=20 WHERE id=?1",
                [message_id],
            )
            .unwrap();

        Connection::open(&fixture.destination_database)
            .unwrap()
            .execute(
                "UPDATE session_message SET data=?1 WHERE id=?2",
                params![serde_json::json!({"text":"wrong"}).to_string(), message_id],
            )
            .unwrap();
        assert!(verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .is_err());
    }
}

#[test]
fn current_store_verification_rejects_mutated_baseline_v2_projection_timestamp() {
    let fixture = fixture_with_baseline_v2_context_message();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("the exact baseline projection verifies");

    Connection::open(&fixture.destination_database)
        .unwrap()
        .execute(
            "UPDATE session_message SET time_updated=26 WHERE id='msg_context'",
            [],
        )
        .unwrap();
    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .is_err());
}

fn append_messages_with_events(fixture: &Fixture, count: u64) {
    append_messages_with_events_starting_at(fixture, count, 0);
}

fn append_durable_event(
    connection: &Connection,
    sequence: i64,
    event_id: &str,
    event_type: &str,
    data: serde_json::Value,
) {
    connection
        .execute(
            "UPDATE event_sequence SET seq=?1 WHERE aggregate_id='ses_root'",
            [sequence],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?1,'ses_root',?2,?3,?4)",
            params![event_id, sequence, event_type, data.to_string()],
        )
        .unwrap();
}

fn append_v1_user_message(
    connection: &Connection,
    sequence: i64,
    event_id: &str,
    message_id: &str,
    event_timestamp: serde_json::Value,
    row_time_created: i64,
    row_time_updated: i64,
) {
    let info = serde_json::json!({
        "id":message_id,
        "sessionID":"ses_root",
        "role":"user",
        "time":{"created":event_timestamp},
        "agent":"build",
        "model":{"providerID":"provider-one","modelID":"model-one"}
    });
    let mut message_data = info.as_object().unwrap().clone();
    message_data.remove("id");
    message_data.remove("sessionID");
    append_durable_event(
        connection,
        sequence,
        event_id,
        "message.updated.1",
        serde_json::json!({"sessionID":"ses_root","info":info}),
    );
    connection
        .execute(
            "INSERT INTO message(id,session_id,time_created,time_updated,data)
             VALUES(?1,'ses_root',?2,?3,?4)",
            params![
                message_id,
                row_time_created,
                row_time_updated,
                serde_json::Value::Object(message_data).to_string()
            ],
        )
        .unwrap();
}

fn append_messages_with_events_starting_at(fixture: &Fixture, count: u64, first_sequence: u64) {
    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection
        .execute(
            "INSERT INTO event_sequence(aggregate_id,seq,owner_id) VALUES('ses_root',?1,'owner')
             ON CONFLICT(aggregate_id) DO UPDATE SET seq=excluded.seq",
            [(first_sequence + count - 1) as i64],
        )
        .unwrap();
    for index in 0..count {
        let message_id = format!("msg_append_{index:03}");
        let sequence = first_sequence + index;
        let timestamp = index as i64 + 2;
        let info = serde_json::json!({
            "id":message_id.clone(),
            "sessionID":"ses_root",
            "role":"assistant",
            "time":{"created":timestamp,"completed":timestamp},
            "parentID":"msg_one",
            "modelID":"model-one",
            "providerID":"provider-one",
            "mode":"default",
            "agent":"build",
            "path":{
                "cwd":fixture.workspace.to_string_lossy(),
                "root":fixture.workspace.to_string_lossy()
            },
            "cost":0.0,
            "tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}
        });
        let mut message_data = info.as_object().unwrap().clone();
        message_data.remove("id");
        message_data.remove("sessionID");
        connection
            .execute(
                "INSERT INTO message(id,session_id,time_created,time_updated,data)
                 VALUES(?1,'ses_root',?2,?2,?3)",
                params![
                    message_id,
                    timestamp,
                    serde_json::Value::Object(message_data).to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO event(id,aggregate_id,seq,type,data) VALUES(?1,'ses_root',?2,'message.updated.1',?3)",
                params![
                    format!("evt_append_{index:03}"),
                    sequence as i64,
                    serde_json::json!({"sessionID":"ses_root","info":info}).to_string()
                ],
            )
            .unwrap();
    }
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

    let refusal = import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap_err();
    assert!(
        matches!(refusal,OpenCodeImportError::Blocked(reason) if reason=="destination has a conflicting native primary key")
    );
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

fn reexport_owned_fixture(fixture: &mut Fixture) {
    let snapshot = export_exact_session(
        &HostOpenCodeInventory::new(fixture.root.join("source.sqlite"))
            .with_trusted_mount_for_selected_session(fixture.workspace.clone()),
        "ses_root",
        ExportOptions::new(fixture.root.join("reexport")),
    )
    .unwrap();
    let mut bytes = Vec::new();
    snapshot
        .open_payload()
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    fixture.descriptor.manifest_json = serde_json::to_string(snapshot.manifest()).unwrap();
    fixture.descriptor.source_generation = snapshot.manifest().generation.clone();
    fixture.descriptor.total_bytes = bytes.len() as u64;
    fixture.descriptor.files[0].size_bytes = bytes.len() as u64;
    fixture.descriptor.files[0].sha256 = sha256(&bytes);
    fixture.descriptor.bundle_sha256 = opencode_transfer_bundle_digest(
        &fixture.descriptor.manifest_json,
        &fixture.descriptor.files,
    );
    fs::write(fixture.staged_directory.join("entry-0000.bin"), bytes).unwrap();
    fs::write(
        fixture.staged_directory.join("descriptor.json"),
        serde_json::to_vec(&StageMetadata {
            descriptor: fixture.descriptor.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.staged_directory.join("READY"),
        fixture.descriptor.bundle_sha256.as_bytes(),
    )
    .unwrap();
}

fn saved_revert_fixture(part: bool) -> Fixture {
    let mut fixture = fixture_with_baseline_event();
    let source = Connection::open(fixture.root.join("source.sqlite")).unwrap();
    for index in 1..4 {
        let message_id = format!("msg_cleanup_{index}");
        source.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES (?1,'ses_root',?2,?2,?3)", params![message_id,index+1,serde_json::json!({"role":"user","agent":"build","model":{"providerID":"provider-one","modelID":"model-one"},"time":{"created":index+1}}).to_string()]).unwrap();
        for suffix in ["a", "b"] {
            source.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?1,?2,'ses_root',?3,?3,?4)",params![format!("prt_cleanup_{index}_{suffix}"),message_id,index+1,serde_json::json!({"type":"text","text":"synthetic saved-boundary part"}).to_string()]).unwrap();
        }
    }
    let mut revert = serde_json::json!({"messageID":"msg_cleanup_2","snapshot":"1234567890abcdef1234567890abcdef12345678"});
    if part {
        revert["partID"] = serde_json::json!("prt_cleanup_2_b");
    }
    source
        .execute(
            "UPDATE session SET revert=?1 WHERE id='ses_root'",
            [revert.to_string()],
        )
        .unwrap();
    drop(source);
    reexport_owned_fixture(&mut fixture);
    fixture
}

fn run_saved_revert_cleanup(part: bool) -> Fixture {
    let fixture = saved_revert_fixture(part);
    let original_source = fs::read(fixture.root.join("source.sqlite")).unwrap();
    let original_manifest = fixture.descriptor.manifest_json.clone();
    let original_payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    import_bundle_payload(
        &fixture.descriptor,
        original_payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let mut seq = 1;
    for message_id in if part {
        vec!["msg_cleanup_3"]
    } else {
        vec!["msg_cleanup_2", "msg_cleanup_3"]
    } {
        append_durable_event(
            &connection,
            seq,
            &format!("evt_cleanup_{seq}"),
            "message.removed.1",
            serde_json::json!({"sessionID":"ses_root","messageID":message_id}),
        );
        connection
            .execute("DELETE FROM message WHERE id=?1", [message_id])
            .unwrap();
        seq += 1;
    }
    if part {
        append_durable_event(
            &connection,
            seq,
            &format!("evt_cleanup_{seq}"),
            "message.part.removed.1",
            serde_json::json!({"sessionID":"ses_root","messageID":"msg_cleanup_2","partID":"prt_cleanup_2_b"}),
        );
        connection
            .execute("DELETE FROM part WHERE id='prt_cleanup_2_b'", [])
            .unwrap();
        seq += 1;
    }
    let info = serde_json::json!({"id":"ses_root","slug":"synthetic-slug","projectID":"project-one","directory":fixture.workspace.to_string_lossy(),"title":"synthetic title","version":"1.18.21","agent":"build","model":{"providerID":"provider-one","id":"model-one"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1,"updated":10}});
    append_durable_event(
        &connection,
        seq,
        "evt_cleanup_cleared",
        "session.updated.1",
        serde_json::json!({"sessionID":"ses_root","info":info}),
    );
    connection.execute("UPDATE session SET revert=NULL,time_updated=10,agent='build',model='{\"providerID\":\"provider-one\",\"id\":\"model-one\"}' WHERE id='ses_root'",[]).unwrap();
    append_v1_user_message(
        &connection,
        seq + 1,
        "evt_cleanup_new_input",
        "msg_cleanup_continuation",
        serde_json::json!(20),
        20,
        20,
    );
    drop(connection);
    let current = verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    assert_eq!(
        current.root_tail,
        VerifiedRootTail::Message {
            message_id: "msg_cleanup_continuation".into()
        }
    );
    assert_eq!(fixture.descriptor.manifest_json, original_manifest);
    assert_eq!(
        fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap(),
        original_payload
    );
    assert_eq!(
        fs::read(fixture.root.join("source.sqlite")).unwrap(),
        original_source
    );
    fixture
}

#[test]
fn durable_souls_native_project_discovery_touch_preserves_identity() {
    let fixture = fixture_with_baseline_event();
    let payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection
        .execute("UPDATE project SET time_updated=20", [])
        .unwrap();
    verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .expect("pinned fromDirectory touches project time without altering history");
    connection
        .execute("UPDATE project SET worktree='/substituted-workspace'", [])
        .unwrap();
    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace
    )
    .is_err());
}

#[test]
fn durable_souls_saved_full_revert_cleanup_preserves_immutable_baseline() {
    let fixture = run_saved_revert_cleanup(false);
    let connection = Connection::open(&fixture.destination_database).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM message WHERE id IN ('msg_cleanup_2','msg_cleanup_3')",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
    connection
        .execute("DELETE FROM message WHERE id='msg_one'", [])
        .unwrap();
    assert!(
        verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace
        )
        .is_err(),
        "a deleted preserved prefix needs its own exact native authority"
    );
}

#[test]
fn durable_souls_saved_part_revert_cleanup_preserves_prefix_parts() {
    let fixture = run_saved_revert_cleanup(true);
    let connection = Connection::open(&fixture.destination_database).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM part WHERE id='prt_cleanup_2_a'",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
        1
    );
    connection
        .execute("DELETE FROM event WHERE id='evt_cleanup_cleared'", [])
        .unwrap();
    assert!(
        verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace
        )
        .is_err(),
        "missing native clear or sequence evidence refuses current qualification"
    );
}

#[test]
fn durable_souls_rehearsal_pipeline_refuses_unreceipted_extra_native_rows() {
    let fixture = fixture();
    let payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    connection.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg_unreceipted','ses_root',3,3,'{\"role\":\"user\",\"opaque\":\"unreceipted extra history\"}')",[]).unwrap();
    drop(connection);
    assert!(
        import_bundle_payload(
            &fixture.descriptor,
            payload.as_slice(),
            &fixture.destination_database,
            &fixture.workspace
        )
        .is_err(),
        "exact repair cannot certify an unreceipted extra graph as the imported baseline"
    );
    let connection = Connection::open(&fixture.destination_database).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT data FROM message WHERE id='msg_unreceipted'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "{\"role\":\"user\",\"opaque\":\"unreceipted extra history\"}"
    );
}

#[test]
fn durable_souls_rehearsal_pipeline_complete_native_rows_assets_and_reader_context() {
    let fixture = fixture();
    let source_before = fs::read(fixture.root.join("source.sqlite")).unwrap();
    let payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    let imported = import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let home = fixture.destination_database.ancestors().nth(4).unwrap();
    let data_home = home.join(".local/share");
    let config_home = home.join(".config");
    fs::create_dir_all(&config_home).unwrap();
    let reader = InstalledStoreReaderContext {
        database_path: &fixture.destination_database,
        workspace_root: &fixture.workspace,
        provider_uid: rehearsal_current_identity().0,
        provider_gid: rehearsal_current_identity().1,
        home,
        xdg_data_home: &data_home,
        xdg_config_home: &config_home,
        cwd: &fixture.workspace,
    };
    let read = verify_installed_store(&fixture.descriptor, &reader).unwrap();
    assert_eq!(read.structural_sha256, imported.structural_sha256);
    let native_payload: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    for expected in native_payload["rows"].as_array().unwrap() {
        let row: SerializedRow = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(
            read_row_by_key(&connection, &row.table, &row.key).unwrap(),
            row
        );
    }
    let mut wrong = reader;
    wrong.provider_uid += 1;
    wrong.xdg_data_home = &config_home;
    assert!(verify_installed_store(&fixture.descriptor, &wrong).is_err());
    assert_eq!(
        fs::read(fixture.root.join("source.sqlite")).unwrap(),
        source_before
    );
    streamed_provider_import_hashes_the_pipe_and_rolls_back_a_truncated_payload();
    destination_capacity_is_checked_before_parent_or_database_creation();
    conflicting_primary_key_rolls_back_without_overwriting_destination_data();
}

fn rehearsal_current_identity() -> (u32, u32) {
    #[cfg(unix)]
    {
        unsafe { (libc::geteuid(), libc::getegid()) }
    }
    #[cfg(not(unix))]
    {
        (0, 0)
    }
}

#[test]
fn durable_v1_event_payloads_reject_invalid_nested_pinned_schema_values() {
    let invalid_session = serde_json::json!({
        "sessionID":"ses_root",
        "info":{"id":"ses_root"}
    });
    assert!(validate_v1_event_envelope("session.updated", &invalid_session).is_err());

    let invalid_message = serde_json::json!({
        "sessionID":"ses_root",
        "info":{
            "id":"msg_new",
            "sessionID":"ses_root",
            "role":"assistant",
            "time":{"created":10}
        }
    });
    assert!(validate_v1_event_envelope("message.updated", &invalid_message).is_err());

    let invalid_part = serde_json::json!({
        "sessionID":"ses_root",
        "part":{"id":"prt_new","sessionID":"ses_root","messageID":"msg_new"},
        "time":10
    });
    assert!(validate_v1_event_envelope("message.part.updated", &invalid_part).is_err());
}

#[test]
fn durable_v1_nested_schemas_accept_valid_session_and_message_unions() {
    let session_info = serde_json::json!({
        "id":"ses_root",
        "slug":"root",
        "projectID":"project-one",
        "directory":"/workspace",
        "title":"Root",
        "version":"1.18.21",
        "time":{"created":1,"updated":2}
    });
    validate_v1_event_envelope(
        "session.updated",
        &serde_json::json!({"sessionID":"ses_root","info":session_info}),
    )
    .expect("the minimal pinned SessionInfo is valid");

    let invalid_optional_session = serde_json::json!({
        "sessionID":"ses_root",
        "info":{
            "id":"ses_root","slug":"root","projectID":"project-one",
            "directory":"/workspace","title":"Root","version":"1.18.21",
            "time":{"created":1,"updated":2},
            "tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":"4","write":5}}
        }
    });
    assert!(validate_v1_event_envelope("session.updated", &invalid_optional_session).is_err());

    let user = serde_json::json!({
        "id":"msg_user",
        "sessionID":"ses_root",
        "role":"user",
        "time":{"created":3.5},
        "agent":"build",
        "model":{"providerID":"provider-one","modelID":"model-one"},
        "format":{"type":"json_schema","schema":{"type":"object"},"retryCount":2},
        "summary":{"diffs":[]},
        "system":"system prompt",
        "tools":{"read":true}
    });
    validate_v1_event_envelope(
        "message.updated",
        &serde_json::json!({"sessionID":"ses_root","info":user.clone()}),
    )
    .expect("the pinned User message, including optional fields, is valid");
    let mut invalid_user = user.as_object().unwrap().clone();
    invalid_user.insert("tools".into(), serde_json::json!({"read":"yes"}));
    assert!(validate_v1_event_envelope(
        "message.updated",
        &serde_json::json!({"sessionID":"ses_root","info":invalid_user}),
    )
    .is_err());

    let assistant = serde_json::json!({
        "id":"msg_assistant",
        "sessionID":"ses_root",
        "role":"assistant",
        "time":{"created":4,"completed":5},
        "parentID":"msg_user",
        "modelID":"model-one",
        "providerID":"provider-one",
        "mode":"default",
        "agent":"build",
        "path":{"cwd":"/workspace","root":"/workspace"},
        "cost":0.0,
        "tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
        "structured":["schema-authorized arbitrary JSON"],
        "error":{"name":"UnknownError","data":{"message":"synthetic","ref":"ref"}}
    });
    validate_v1_event_envelope(
        "message.updated",
        &serde_json::json!({"sessionID":"ses_root","info":assistant.clone()}),
    )
    .expect("the pinned Assistant message and arbitrary structured value are valid");
    let mut invalid_assistant = assistant.as_object().unwrap().clone();
    invalid_assistant.insert("id".into(), serde_json::json!("not-a-message-id"));
    assert!(validate_v1_event_envelope(
        "message.updated",
        &serde_json::json!({"sessionID":"ses_root","info":invalid_assistant}),
    )
    .is_err());
}

#[test]
fn durable_v1_part_union_variants_validate_and_reject_missing_variant_fields() {
    let variants = [
        (
            "text",
            serde_json::json!({"text":"hello","metadata":{"provider":{"arbitrary":[1,true]}}}),
            "text",
        ),
        (
            "subtask",
            serde_json::json!({"prompt":"p","description":"d","agent":"a"}),
            "prompt",
        ),
        (
            "reasoning",
            serde_json::json!({"text":"thinking","time":{"start":1}}),
            "text",
        ),
        (
            "file",
            serde_json::json!({"mime":"text/plain","url":"file:///tmp/a"}),
            "mime",
        ),
        (
            "tool",
            serde_json::json!({"callID":"call-1","tool":"read","state":{"status":"pending","input":{"path":"a"},"raw":"{}"}}),
            "state",
        ),
        ("step-start", serde_json::json!({}), "type"),
        (
            "step-finish",
            serde_json::json!({"reason":"stop","cost":0.0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}),
            "cost",
        ),
        (
            "snapshot",
            serde_json::json!({"snapshot":"tree"}),
            "snapshot",
        ),
        (
            "patch",
            serde_json::json!({"hash":"hash","files":["a.rs"]}),
            "files",
        ),
        ("agent", serde_json::json!({"name":"explorer"}), "name"),
        (
            "retry",
            serde_json::json!({"attempt":1,"error":{"name":"APIError","data":{"message":"retry","isRetryable":true}},"time":{"created":5}}),
            "attempt",
        ),
        (
            "compaction",
            serde_json::json!({"auto":true,"tail_start_id":"msg_tail"}),
            "auto",
        ),
    ];
    for (index, (kind, fields, missing_key)) in variants.iter().enumerate() {
        let mut part = fields.as_object().unwrap().clone();
        part.extend(serde_json::Map::from_iter([
            ("id".into(), serde_json::json!(format!("prt_{index}"))),
            ("sessionID".into(), serde_json::json!("ses_root")),
            ("messageID".into(), serde_json::json!("msg_one")),
            ("type".into(), serde_json::json!(kind)),
        ]));
        let valid = serde_json::json!({
            "sessionID":"ses_root",
            "part":serde_json::Value::Object(part.clone()),
            "time":1.5
        });
        validate_v1_event_envelope("message.part.updated", &valid)
            .unwrap_or_else(|_| panic!("valid pinned V1 {kind} part was rejected"));

        part.remove(*missing_key);
        let invalid = serde_json::json!({
            "sessionID":"ses_root",
            "part":serde_json::Value::Object(part),
            "time":1.5
        });
        assert!(
            validate_v1_event_envelope("message.part.updated", &invalid).is_err(),
            "V1 {kind} part accepted without {missing_key}"
        );
    }

    let invalid_optional_part = serde_json::json!({
        "sessionID":"ses_root",
        "part":{
            "id":"prt_text","sessionID":"ses_root","messageID":"msg_one",
            "type":"text","text":"hello","time":{"start":0,"end":"later"}
        },
        "time":1.5
    });
    assert!(validate_v1_event_envelope("message.part.updated", &invalid_optional_part).is_err());
}

#[test]
fn immutable_baseline_events_are_schema_checked_and_unknown_types_block() {
    let fixture = fixture_with_baseline_event();
    import_bundle(
        &fixture.descriptor,
        &fixture.staged_directory,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let manifest = parse_manifest(&fixture.descriptor).unwrap();
    let baseline_event = manifest
        .rows
        .iter()
        .find(|row| row.table == "event")
        .unwrap();
    let baseline_sequence = manifest
        .rows
        .iter()
        .find(|row| row.table == "event_sequence")
        .unwrap();
    let connection = Connection::open(&fixture.destination_database).unwrap();
    let event = read_row_by_key(&connection, "event", &baseline_event.key).unwrap();
    let sequence = read_row_by_key(&connection, "event_sequence", &baseline_sequence.key).unwrap();
    let current = BTreeMap::from([
        ((event.table.clone(), event.key.clone()), event.clone()),
        ((sequence.table.clone(), sequence.key.clone()), sequence),
    ]);
    verify_current_event_chains(&manifest, &current, std::slice::from_ref(&event))
        .expect("the valid immutable V1 baseline event matches its pinned schema");

    let mut malformed_payload = event.clone();
    malformed_payload.values.insert(
        "data".into(),
        SerializedSqlValue::Text {
            value: serde_json::json!({
                "sessionID":"ses_root",
                "info":{"id":"ses_root"}
            })
            .to_string(),
        },
    );
    assert!(verify_current_event_chains(&manifest, &current, &[malformed_payload]).is_err());

    for invalid_type in [
        "session.created.2",
        "session.next.text.delta.1",
        "session.next.unknown.1",
        "unknown.event.1",
    ] {
        let mut invalid = event.clone();
        invalid.values.insert(
            "type".into(),
            SerializedSqlValue::Text {
                value: invalid_type.into(),
            },
        );
        assert!(
            verify_current_event_chains(&manifest, &current, &[invalid]).is_err(),
            "baseline event type {invalid_type} must not bypass durable schema validation"
        );
    }
}

#[test]
fn v2_datetime_timestamp_uses_timeclip_for_negative_fractions_and_range_boundaries() {
    for (input, expected) in [
        (serde_json::json!(20.5), Some(20)),
        (serde_json::json!(-20.5), Some(-20)),
        (
            serde_json::json!(8640000000000000i64),
            Some(8640000000000000i64),
        ),
        (
            serde_json::json!(-8640000000000000i64),
            Some(-8640000000000000i64),
        ),
        (serde_json::json!(8640000000000001i64), None),
        (serde_json::json!(-8640000000000001i64), None),
    ] {
        assert_eq!(canonical_v2_timestamp_millis(&input), expected, "{input}");
    }
}

#[test]
fn durable_v2_event_payloads_reject_invalid_nested_pinned_schema_values() {
    let timestamp_outside_javascript_date_range = serde_json::json!({
        "sessionID":"ses_root",
        "timestamp":8640000000000001i64,
        "messageID":"msg_new",
        "text":"invalid timestamp"
    });
    assert!(validate_v2_event_payload(
        "session.next.context.updated",
        &timestamp_outside_javascript_date_range,
        "ses_root"
    )
    .is_err());

    let invalid_prompt = serde_json::json!({
        "sessionID":"ses_root",
        "timestamp":10,
        "messageID":"msg_new",
        "prompt":{"text":42,"files":[]},
        "delivery":"queue"
    });
    assert!(
        validate_v2_event_payload("session.next.prompt.admitted", &invalid_prompt, "ses_root")
            .is_err()
    );

    let invalid_model = serde_json::json!({
        "sessionID":"ses_root",
        "timestamp":10,
        "messageID":"msg_new",
        "model":{"id":"model-one"}
    });
    assert!(
        validate_v2_event_payload("session.next.model.switched", &invalid_model, "ses_root")
            .is_err()
    );

    let invalid_step = serde_json::json!({
        "sessionID":"ses_root",
        "timestamp":10,
        "assistantMessageID":"msg_new",
        "finish":"stop",
        "cost":0.0,
        "tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0}}
    });
    assert!(
        validate_v2_event_payload("session.next.step.ended", &invalid_step, "ses_root").is_err()
    );

    let invalid_tool_content = serde_json::json!({
        "sessionID":"ses_root",
        "timestamp":10,
        "assistantMessageID":"msg_new",
        "callID":"call-1",
        "structured":{},
        "content":[{"type":"image","uri":"file://image"}],
        "provider":{"executed":false}
    });
    assert!(validate_v2_event_payload(
        "session.next.tool.success",
        &invalid_tool_content,
        "ses_root"
    )
    .is_err());

    let invalid_id = serde_json::json!({
        "sessionID":"ses_root",
        "timestamp":10.5,
        "messageID":"msgbad",
        "prompt":{"text":"bad id"},
        "delivery":"queue"
    });
    assert!(
        validate_v2_event_payload("session.next.prompt.admitted", &invalid_id, "ses_root").is_err()
    );
}

#[test]
fn durable_v2_event_schema_accepts_each_pinned_kind_and_schema_authorized_json() {
    let model = serde_json::json!({"id":"model-one","providerID":"provider-one","variant":"fast"});
    let payloads = [
        (
            "session.next.agent.switched",
            serde_json::json!({"messageID":"msg_one","agent":"build"}),
        ),
        (
            "session.next.model.switched",
            serde_json::json!({"messageID":"msg_one","model":model}),
        ),
        (
            "session.next.moved",
            serde_json::json!({"location":{"directory":"/workspace","workspaceID":"wrk_one"},"subdirectory":"src"}),
        ),
        (
            "session.next.prompt.admitted",
            serde_json::json!({"messageID":"msg_one","prompt":{"text":"hello","files":[{"uri":"file:///prompt","mime":"text/plain","source":{"start":0.5,"end":2.5,"text":"hello"}}],"agents":[{"name":"build"}]},"delivery":"queue"}),
        ),
        (
            "session.next.prompted",
            serde_json::json!({"messageID":"msg_two","prompt":{"text":"steer"},"delivery":"steer"}),
        ),
        (
            "session.next.context.updated",
            serde_json::json!({"messageID":"msg_three","text":"context"}),
        ),
        (
            "session.next.synthetic",
            serde_json::json!({"messageID":"msg_four","text":"synthetic"}),
        ),
        (
            "session.next.shell.started",
            serde_json::json!({"messageID":"msg_shell","callID":"call-shell","command":"pwd"}),
        ),
        (
            "session.next.shell.ended",
            serde_json::json!({"callID":"call-shell","output":"/workspace"}),
        ),
        (
            "session.next.step.started",
            serde_json::json!({"assistantMessageID":"msg_assistant","agent":"build","model":model,"snapshot":"tree"}),
        ),
        (
            "session.next.step.ended",
            serde_json::json!({"assistantMessageID":"msg_assistant","finish":"stop","cost":0.5,"tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}},"files":["src/main.rs"]}),
        ),
        (
            "session.next.step.failed",
            serde_json::json!({"assistantMessageID":"msg_assistant","error":{"type":"unknown","message":"failed"}}),
        ),
        (
            "session.next.text.started",
            serde_json::json!({"assistantMessageID":"msg_assistant","textID":"text-1"}),
        ),
        (
            "session.next.text.ended",
            serde_json::json!({"assistantMessageID":"msg_assistant","textID":"text-1","text":"complete"}),
        ),
        (
            "session.next.tool.input.started",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"call-tool","name":"read"}),
        ),
        (
            "session.next.tool.input.ended",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"call-tool","text":"{\"path\":\"x\"}"}),
        ),
        (
            "session.next.tool.called",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"call-tool","tool":"read","input":{"path":"x","providerData":[1,true]},"provider":{"executed":false,"metadata":{"provider-one":{"opaque":{"ok":true}}}}}),
        ),
        (
            "session.next.tool.progress",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"call-tool","structured":{"progress":{"items":[1,2]}},"content":[{"type":"text","text":"working"}]}),
        ),
        (
            "session.next.tool.success",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"call-tool","structured":{"count":1},"content":[{"type":"file","uri":"file:///result","mime":"text/plain","name":"result.txt"}],"outputPaths":["result.txt"],"result":["schema-authorized Any"],"provider":{"executed":true}}),
        ),
        (
            "session.next.tool.failed",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"call-tool","error":{"type":"unknown","message":"failed"},"result":{"unknown":true},"provider":{"executed":false}}),
        ),
        (
            "session.next.reasoning.started",
            serde_json::json!({"assistantMessageID":"msg_assistant","reasoningID":"reason-1","providerMetadata":{"provider-one":{"opaque":[1]}}}),
        ),
        (
            "session.next.reasoning.ended",
            serde_json::json!({"assistantMessageID":"msg_assistant","reasoningID":"reason-1","text":"reasoned"}),
        ),
        (
            "session.next.retried",
            serde_json::json!({"attempt":1.5,"error":{"message":"retry","isRetryable":true,"statusCode":503,"responseHeaders":{"retry-after":"1"},"responseBody":"body","metadata":{"trace":"opaque"}}}),
        ),
        (
            "session.next.compaction.started",
            serde_json::json!({"messageID":"msg_compact","reason":"manual"}),
        ),
        (
            "session.next.compaction.ended",
            serde_json::json!({"messageID":"msg_compact","reason":"auto","text":"summary","recent":"recent"}),
        ),
        (
            "session.next.revert.staged",
            serde_json::json!({"revert":{"messageID":"msg_one","partID":"prt_one","files":[{"path":"src/main.rs","status":"modified","additions":1,"deletions":0,"patch":"@@"}]}}),
        ),
        ("session.next.revert.cleared", serde_json::json!({})),
        (
            "session.next.revert.committed",
            serde_json::json!({"messageID":"msg_one"}),
        ),
    ];

    for (event_type, fields) in payloads {
        let mut data = fields.as_object().unwrap().clone();
        data.insert("sessionID".into(), serde_json::json!("ses_root"));
        // The pinned DateTimeUtcFromMillis codec is finite-number based.
        data.insert("timestamp".into(), serde_json::json!(1.5));
        validate_v2_event_payload(event_type, &serde_json::Value::Object(data), "ses_root")
            .unwrap_or_else(|_| panic!("valid pinned V2 event {event_type} was rejected"));
    }

    let bad_optional = [
        (
            "session.next.moved",
            serde_json::json!({"location":{"directory":"/workspace","workspaceID":7}}),
        ),
        (
            "session.next.tool.called",
            serde_json::json!({"assistantMessageID":"msg_assistant","callID":"c","tool":"read","input":{},"provider":{"executed":false,"metadata":{"provider-one":"not-a-record"}}}),
        ),
        (
            "session.next.retried",
            serde_json::json!({"attempt":1,"error":{"message":"retry","isRetryable":true,"responseHeaders":{"retry-after":3}}}),
        ),
        (
            "session.next.step.started",
            serde_json::json!({"assistantMessageID":"msg_assistant","agent":"build","model":{"id":"m","providerID":"p"},"snapshot":false}),
        ),
        (
            "session.next.revert.staged",
            serde_json::json!({"revert":{"messageID":"msg_one","files":[{"path":"a","status":"unknown","additions":0,"deletions":0,"patch":""}]}}),
        ),
    ];
    for (event_type, fields) in bad_optional {
        let mut data = fields.as_object().unwrap().clone();
        data.insert("sessionID".into(), serde_json::json!("ses_root"));
        data.insert("timestamp".into(), serde_json::json!(1.5));
        assert!(
            validate_v2_event_payload(event_type, &serde_json::Value::Object(data), "ses_root")
                .is_err(),
            "invalid nested or optional field accepted for {event_type}"
        );
    }
}

fn write_owned_git_object(store: &Path, kind: &str, bytes: &[u8]) -> String {
    use sha2::Digest;
    use std::io::Write;
    let mut raw = format!("{kind} {}\0", bytes.len()).into_bytes();
    raw.extend_from_slice(bytes);
    let oid = hex::encode(sha1::Sha1::digest(&raw));
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).unwrap();
    let directory = store.join(&oid[..2]);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(&oid[2..]), encoder.finish().unwrap()).unwrap();
    oid
}

#[test]
fn durable_souls_rehearsal_pipeline_preserves_unavailable_snapshot_parts() {
    use freshell_sessions::opencode_transfer::{SavedSnapshotAvailability, SavedSnapshotSummary};
    for kind in ["snapshot", "step-start", "step-finish"] {
        let mut fixture = fixture_with_baseline_event();
        let tree = "1234567890abcdef1234567890abcdef12345678";
        let mut part = serde_json::json!({
            "id":"prt_one","sessionID":"ses_root","messageID":"msg_one",
            "type":kind,"snapshot":tree
        });
        if kind == "step-finish" {
            part["reason"] = serde_json::json!("stop");
            part["cost"] = serde_json::json!(0);
            part["tokens"] = serde_json::json!({"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}});
        }
        let part_json = serde_json::to_string_pretty(&part).unwrap();
        let source = Connection::open(fixture.root.join("source.sqlite")).unwrap();
        source
            .execute(
                "UPDATE part SET id='prt_one',data=?1 WHERE id='part_one'",
                [&part_json],
            )
            .unwrap();
        // All three native part variants use the pinned V1 event schema.
        let event = serde_json::json!({
            "sessionID":"ses_root","part":part,"time":1
        });
        if kind == "snapshot" {
            let mut invalid_id_event = event.clone();
            invalid_id_event["part"]["id"] = serde_json::json!("part_one");
            assert!(validate_v1_event_envelope("message.part.updated", &invalid_id_event).is_err());
        }
        let event_json = serde_json::to_string_pretty(&event).unwrap();
        source
            .execute(
                "UPDATE event SET type='message.part.updated.1',data=?1 WHERE id='evt_base'",
                [&event_json],
            )
            .unwrap();
        drop(source);
        reexport_owned_fixture(&mut fixture);
        let manifest: OpenCodeTransferManifest =
            serde_json::from_str(&fixture.descriptor.manifest_json).unwrap();
        assert_eq!(manifest.row_count(), 6);
        let [reference] = manifest.saved_snapshots.as_slice() else {
            panic!("native part and event qualify the same exact saved reference");
        };
        assert_eq!(reference.tree, tree);
        assert_eq!(
            reference.availability,
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        );
        assert!(reference.objects.is_empty());
        assert!(manifest.assets.is_empty());
        let expected_summary = SavedSnapshotSummary::QualifiedReferences {
            retained_closure_count: 0,
            unavailable_reference_count: 1,
        };
        let imported = import_bundle(
            &fixture.descriptor,
            &fixture.staged_directory,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .unwrap();
        assert_eq!(imported.row_count, 6);
        assert_eq!(imported.asset_count, 0);
        assert_eq!(imported.saved_snapshot_summary, expected_summary);
        let current = verify_current_store(
            &fixture.descriptor,
            &fixture.destination_database,
            &fixture.workspace,
        )
        .unwrap();
        assert_eq!(current.row_count, 6);
        assert_eq!(current.saved_snapshot_summary, expected_summary);
        let home = fixture.destination_database.ancestors().nth(4).unwrap();
        let data_home = home.join(".local/share");
        let config_home = home.join(".config");
        fs::create_dir_all(&config_home).unwrap();
        let (uid, gid) = rehearsal_current_identity();
        let reader = InstalledStoreReaderContext {
            database_path: &fixture.destination_database,
            workspace_root: &fixture.workspace,
            provider_uid: uid,
            provider_gid: gid,
            home,
            xdg_data_home: &data_home,
            xdg_config_home: &config_home,
            cwd: &fixture.workspace,
        };
        let readable = verify_installed_store(&fixture.descriptor, &reader).unwrap();
        assert_eq!(readable.row_count, 6);
        assert_eq!(readable.saved_snapshot_summary, expected_summary);
        assert!(!fixture
            .destination_database
            .parent()
            .unwrap()
            .join("snapshot")
            .exists());
        let payload: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap(),
        )
        .unwrap();
        let installed = Connection::open(&fixture.destination_database).unwrap();
        for expected in payload["rows"].as_array().unwrap() {
            let row: SerializedRow = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(
                read_row_by_key(&installed, &row.table, &row.key).unwrap(),
                row
            );
        }
        let installed_part: String = installed
            .query_row("SELECT data FROM part WHERE id='prt_one'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(installed_part, part_json);
        let installed_event: String = installed
            .query_row("SELECT data FROM event WHERE id='evt_base'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(installed_event, event_json);
        let decoded: serde_json::Value = serde_json::from_str(&installed_part).unwrap();
        assert_eq!(decoded["type"], kind);
        assert_eq!(decoded["snapshot"], tree);
        let decoded_event: serde_json::Value = serde_json::from_str(&installed_event).unwrap();
        assert_eq!(decoded_event["part"], decoded);
    }
}

#[test]
fn durable_souls_rehearsal_pipeline_transfers_exact_native_snapshot_closure() {
    use sha2::Digest;
    let mut fixture = saved_revert_fixture(false);
    // Construct an ordinary repository without invoking an external CLI. Its
    // committed tree is deliberately different from the native snapshot tree.
    let git_dir = fixture.workspace.join(".git");
    fs::create_dir_all(git_dir.join("refs/heads")).unwrap();
    fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::write(
        git_dir.join("config"),
        "[core]\nrepositoryformatversion = 0\nbare = false\n",
    )
    .unwrap();
    let committed_tree = write_owned_git_object(&git_dir.join("objects"), "tree", b"");
    let commit = write_owned_git_object(
        &git_dir.join("objects"),
        "commit",
        format!("tree {committed_tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n").as_bytes(),
    );
    fs::write(git_dir.join("refs/heads/main"), format!("{commit}\n")).unwrap();
    let bucket_id = hex::encode(sha1::Sha1::digest(
        fixture
            .workspace
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .as_bytes(),
    ));
    let source_store = fixture
        .root
        .join("snapshot/project-one")
        .join(&bucket_id)
        .join("objects");
    let body = b"synthetic retained snapshot bytes";
    let blob = write_owned_git_object(&source_store, "blob", body);
    let mut entry = b"100644 asset.txt\0".to_vec();
    entry.extend(hex::decode(&blob).unwrap());
    let nested = write_owned_git_object(&source_store, "tree", &entry);
    let mut root_entry = b"40000 nested\0".to_vec();
    root_entry.extend(hex::decode(&nested).unwrap());
    let tree = write_owned_git_object(&source_store, "tree", &root_entry);
    assert_ne!(tree, committed_tree);
    assert!(!git_dir
        .join("objects")
        .join(&tree[..2])
        .join(&tree[2..])
        .exists());
    let source = Connection::open(fixture.root.join("source.sqlite")).unwrap();
    source
        .execute(
            "UPDATE session SET revert=?1 WHERE id='ses_root'",
            [serde_json::json!({"messageID":"msg_cleanup_2","snapshot":tree}).to_string()],
        )
        .unwrap();
    drop(source);
    let source = Connection::open(fixture.root.join("source.sqlite")).unwrap();
    source.execute("UPDATE part SET data=json_set(data,'$.type','step-start','$.snapshot',?1) WHERE id=(SELECT id FROM part LIMIT 1)",[&tree]).unwrap();
    drop(source);
    let before = fs::read(fixture.root.join("source.sqlite")).unwrap();
    reexport_owned_fixture(&mut fixture);
    let manifest: OpenCodeTransferManifest =
        serde_json::from_str(&fixture.descriptor.manifest_json).unwrap();
    assert_eq!(
        manifest.saved_snapshots[0].availability,
        freshell_sessions::opencode_transfer::SavedSnapshotAvailability::RetainedClosure
    );
    assert_eq!(manifest.saved_snapshots[0].objects.len(), 3);
    assert!(!manifest
        .assets
        .iter()
        .any(|asset| asset.kind == "git_tree_reference"));
    let payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let destination_store = fixture
        .destination_database
        .parent()
        .unwrap()
        .join("snapshot/project-one")
        .join(&bucket_id)
        .join("objects");
    for oid in [&tree, &nested, &blob] {
        assert_eq!(
            fs::read(destination_store.join(&oid[..2]).join(&oid[2..])).unwrap(),
            fs::read(source_store.join(&oid[..2]).join(&oid[2..])).unwrap()
        );
    }
    verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    let home = fixture.destination_database.ancestors().nth(4).unwrap();
    let xdg_data_home = home.join(".local/share");
    let xdg_config_home = home.join(".config");
    fs::create_dir_all(&xdg_config_home).unwrap();
    let reader = InstalledStoreReaderContext {
        database_path: &fixture.destination_database,
        workspace_root: &fixture.workspace,
        provider_uid: unsafe { libc::geteuid() },
        provider_gid: unsafe { libc::getegid() },
        home,
        xdg_data_home: &xdg_data_home,
        xdg_config_home: &xdg_config_home,
        cwd: &fixture.workspace,
    };
    verify_installed_store(&fixture.descriptor, &reader).unwrap();
    let conflict = destination_store.join(&blob[..2]).join(&blob[2..]);
    fs::write(&conflict, b"conflicting retained object").unwrap();
    assert!(import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace
    )
    .is_err());
    assert_eq!(fs::read(&conflict).unwrap(), b"conflicting retained object");
    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace
    )
    .is_err());
    assert_eq!(
        fs::read(fixture.root.join("source.sqlite")).unwrap(),
        before
    );
    fs::remove_file(source_store.join(&blob[..2]).join(&blob[2..])).unwrap();
    assert!(export_exact_session(
        &HostOpenCodeInventory::new(fixture.root.join("source.sqlite"))
            .with_trusted_mount_for_selected_session(fixture.workspace.clone()),
        "ses_root",
        ExportOptions::new(fixture.root.join("broken-closure"))
    )
    .is_err());
}

#[test]
#[cfg(target_os = "linux")]
fn durable_souls_rehearsal_pipeline_batch_reads_selected_graphs_without_rescanning_store() {
    use freshell_sessions::opencode_transfer::capture_qualified_batch;
    const CHILD: &str = "FRESHELL_TEST_QUALIFIED_BATCH_IO_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "opencode_transfer::tests::durable_souls_rehearsal_pipeline_batch_reads_selected_graphs_without_rescanning_store",
                "--exact",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    let fixture = fixture();
    let source_path = fixture.root.join("source.sqlite");
    let source = Connection::open(&source_path).unwrap();
    source.execute("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) SELECT 'ses_second',project_id,'second',directory,'second','1.18.21',1,1 FROM session WHERE id='ses_root'", []).unwrap();
    source.execute("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('msg_second','ses_second',1,1,'{\"text\":\"selected second root\"}')", []).unwrap();
    source.execute("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) SELECT 'ses_unselected',project_id,'unselected',directory,'unselected','1.18.21',1,1 FROM session WHERE id='ses_root'", []).unwrap();
    // A large unrelated native row exposes accidental complete-store scans,
    // even when the OS page cache makes their elapsed time look inexpensive.
    source.execute("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('msg_unselected','ses_unselected',1,1,?1)", [serde_json::json!({"text":"x".repeat(32 * 1024 * 1024)}).to_string()]).unwrap();
    drop(source);
    let before = fs::read(&source_path).unwrap();
    let inventory = HostOpenCodeInventory::new(source_path.clone())
        .with_trusted_mount_for_selected_session(fixture.workspace.clone());
    let roots = vec!["ses_root".to_string(), "ses_second".to_string()];
    let qualified = capture_qualified_batch(
        &inventory,
        &roots,
        ExportOptions::new(fixture.root.join("batch-capture")),
    )
    .unwrap();
    let read_bytes = || {
        fs::read_to_string("/proc/self/io")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("rchar: "))
            .unwrap()
            .parse::<u64>()
            .unwrap()
    };
    let start = read_bytes();
    for root in &roots {
        let exported = export_exact_session(
            &qualified.inventory(),
            root,
            ExportOptions::new(fixture.root.join("batch-exports")),
        )
        .unwrap();
        assert_eq!(
            exported.manifest().source_store_id,
            fixture.descriptor.source_store_id
        );
        let payload: serde_json::Value =
            serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
        assert_eq!(payload["root_session_id"], *root);
        assert!(!payload.to_string().contains("msg_unselected"));
        if root == "ses_root" {
            assert_eq!(
                exported.manifest().generation,
                fixture.descriptor.source_generation
            );
            assert_eq!(exported.manifest().assets.len(), 1);
        } else {
            assert!(payload.to_string().contains("selected second root"));
        }
    }
    let actual = read_bytes() - start;
    let budget = qualified.receipt().snapshot_bytes + 16 * 1024 * 1024;
    eprintln!("{{\"severity\":\"info\",\"event\":\"opencode.test.qualified_export_reads\",\"readBytes\":{actual},\"budgetBytes\":{budget}}}");
    assert!(actual < budget, "actual selected exports read {actual} bytes; budget {budget} bytes forbids repeated whole-store scans");
    assert_eq!(fs::read(&source_path).unwrap(), before);
}

#[test]
fn durable_souls_rehearsal_pipeline_qualified_batch_refuses_file_and_sidecar_changes() {
    use freshell_sessions::opencode_transfer::capture_qualified_snapshot;
    let fixture = fixture();
    let inventory = HostOpenCodeInventory::new(fixture.root.join("source.sqlite"))
        .with_trusted_mount_for_selected_session(fixture.workspace.clone());
    let roots = vec!["ses_root".to_string()];
    for fault in [
        "outside-root",
        "unselected-write",
        "replacement",
        "journal",
        "wal",
    ] {
        let path = fixture.root.join(format!("{fault}.sqlite"));
        let qualified = capture_qualified_snapshot(
            &inventory,
            &roots,
            &path,
            ExportOptions::new(fixture.root.join("file-capture")),
        )
        .unwrap();
        match fault {
            "outside-root" => {}
            "unselected-write" => {
                let copy = Connection::open(&path).unwrap();
                copy.execute("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) SELECT 'ses_unselected',project_id,'unselected',directory,'unselected','1.18.21',1,1 FROM session WHERE id='ses_root'", []).unwrap();
            }
            "replacement" => {
                let replacement = fixture.root.join("replacement-new.sqlite");
                fs::copy(&path, &replacement).unwrap();
                fs::rename(replacement, &path).unwrap();
            }
            "journal" | "wal" => {
                fs::write(
                    format!(
                        "{}{suffix}",
                        path.display(),
                        suffix = if fault == "wal" { "-wal" } else { "-journal" }
                    ),
                    b"accidental private snapshot writer",
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            export_exact_session(
                &qualified.inventory(),
                if fault == "outside-root" {
                    "ses_outside"
                } else {
                    "ses_root"
                },
                ExportOptions::new(fixture.root.join("file-exports"))
            )
            .is_err(),
            "must refuse {fault} before publishing an export"
        );
    }
}

#[test]
fn durable_souls_rehearsal_pipeline_qualified_copy_retains_original_source_authority() {
    use freshell_sessions::opencode_transfer::{
        capture_qualified_snapshot, qualify_existing_snapshot,
    };
    let fixture = fixture();
    let source_path = fixture.root.join("source.sqlite");
    let source_before = fs::read(&source_path).unwrap();
    let inventory = HostOpenCodeInventory::new(source_path.clone())
        .with_trusted_mount_for_selected_session(fixture.workspace.clone());
    let roots = vec!["ses_root".to_string()];
    let snapshot_path = fixture.root.join("qualified-source.sqlite");
    let qualified = capture_qualified_snapshot(
        &inventory,
        &roots,
        &snapshot_path,
        ExportOptions::new(fixture.root.join("capture-extractions")),
    )
    .unwrap();
    let ordinary = export_exact_session(
        &HostOpenCodeInventory::new(snapshot_path.clone())
            .with_trusted_mount_for_selected_session(fixture.workspace.clone()),
        "ses_root",
        ExportOptions::new(fixture.root.join("ordinary-copy-extractions")),
    )
    .unwrap();
    let exported = export_exact_session(
        &qualified.inventory(),
        "ses_root",
        ExportOptions::new(fixture.root.join("qualified-copy-extractions")),
    )
    .unwrap();
    assert_eq!(
        exported.manifest().source_store_id,
        fixture.descriptor.source_store_id,
        "a qualified consistent copy keeps the independently resolved original source identity"
    );
    assert_ne!(
        ordinary.manifest().source_store_id,
        exported.manifest().source_store_id,
        "an unqualified copy cannot inherit provenance from a path string"
    );
    assert_eq!(
        exported.manifest().generation,
        fixture.descriptor.source_generation
    );
    let verified = qualify_existing_snapshot(
        &inventory,
        &roots,
        &snapshot_path,
        ExportOptions::new(fixture.root.join("existing-copy-extractions")),
    )
    .unwrap();
    assert_eq!(
        verified.receipt().source_store_id,
        qualified.receipt().source_store_id
    );
    assert_eq!(fs::read(&source_path).unwrap(), source_before);
    let snapshot = Connection::open(&snapshot_path).unwrap();
    snapshot
        .execute(
            "UPDATE part SET data='{\"type\":\"text\",\"text\":\"substituted private copy\"}'",
            [],
        )
        .unwrap();
    drop(snapshot);
    assert!(export_exact_session(
        &qualified.inventory(),
        "ses_root",
        ExportOptions::new(fixture.root.join("changed-copy-extractions"))
    )
    .is_err());
    assert!(qualify_existing_snapshot(
        &inventory,
        &roots,
        &snapshot_path,
        ExportOptions::new(fixture.root.join("divergent-copy-extractions"))
    )
    .is_err());
    assert_eq!(fs::read(&source_path).unwrap(), source_before);
}

#[test]
fn durable_souls_rehearsal_pipeline_refuses_source_reference_digest_root_and_copy_faults() {
    let mut fixture = fixture();
    let asset = fixture.workspace.join("rehearsal-asset.txt");
    fs::write(&asset, b"synthetic immutable workspace asset").unwrap();
    let path = asset
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let url = if cfg!(windows) {
        format!("file:///{path}")
    } else {
        format!("file://{path}")
    };
    let source = Connection::open(fixture.root.join("source.sqlite")).unwrap();
    source.execute("UPDATE part SET data=?1",[serde_json::json!({"type":"file","mime":"text/plain","filename":"rehearsal-asset.txt","url":url}).to_string()]).unwrap();
    drop(source);
    reexport_owned_fixture(&mut fixture);
    let before = fs::read(fixture.root.join("source.sqlite")).unwrap();
    let payload = fs::read(fixture.staged_directory.join("entry-0000.bin")).unwrap();
    let manifest: OpenCodeTransferManifest =
        serde_json::from_str(&fixture.descriptor.manifest_json).unwrap();
    assert_eq!(manifest.assets.len(), 1);
    import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &fixture.destination_database,
        &fixture.workspace,
    )
    .unwrap();
    for (label, descriptor) in [
        ("root", {
            let mut d = fixture.descriptor.clone();
            d.root_session_id = "ses_substituted_root".into();
            d
        }),
        ("digest", {
            let mut d = fixture.descriptor.clone();
            d.files[0].sha256 = "0".repeat(64);
            d.bundle_sha256 = opencode_transfer_bundle_digest(&d.manifest_json, &d.files);
            d
        }),
        ("source", {
            let mut d = fixture.descriptor.clone();
            d.source_store_id = "f".repeat(64);
            d
        }),
    ] {
        let destination = fixture.root.join(format!("refused-{label}/opencode.db"));
        assert!(import_bundle_payload(
            &descriptor,
            payload.as_slice(),
            &destination,
            &fixture.workspace
        )
        .is_err());
        assert!(
            !destination.exists(),
            "binding refusal must precede destination writes"
        );
    }
    struct FailedCopy;
    impl std::io::Read for FailedCopy {
        fn read(&mut self, _bytes: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other(
                "deterministic owned input-copy failure",
            ))
        }
    }
    let destination = fixture.root.join("copy-failure/opencode.db");
    assert!(import_bundle_payload(
        &fixture.descriptor,
        FailedCopy,
        &destination,
        &fixture.workspace
    )
    .is_err());
    let connection = Connection::open(&destination).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
    fs::write(&asset, b"changed workspace reference after export").unwrap();
    let destination = fixture.root.join("asset-failure/opencode.db");
    assert!(import_bundle_payload(
        &fixture.descriptor,
        payload.as_slice(),
        &destination,
        &fixture.workspace
    )
    .is_err());
    assert!(verify_current_store(
        &fixture.descriptor,
        &fixture.destination_database,
        &fixture.workspace
    )
    .is_err());
    assert_eq!(
        fs::read(fixture.root.join("source.sqlite")).unwrap(),
        before
    );
}

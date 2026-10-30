use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferDescriptor,
    OpenCodeTransferFile, OPENCODE_TRANSFER_DESTINATION_DB,
};
use freshell_sessions::opencode_transfer::{
    export_exact_session, pinned_destination_migration_ids, pinned_destination_schema_sql,
    ExportOptions, HostOpenCodeInventory,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn exported_empty_workspace_file_reference_validates_for_resume() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let empty_file = workspace.join("empty.txt");
    fs::write(&empty_file, []).unwrap();
    let database = temporary.path().join("opencode.db");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(pinned_destination_schema_sql())
        .unwrap();
    for migration in pinned_destination_migration_ids() {
        connection
            .execute("INSERT INTO migration VALUES (?1,0)", [migration])
            .unwrap();
    }
    connection.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
    connection.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('ses_exact','slug','prj','/synthetic','saved','1.18.21',1,1)", []).unwrap();
    connection.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg','ses_exact',1,1,'{}')", []).unwrap();
    connection.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES ('file','msg','ses_exact',1,1,?1)", [serde_json::json!({"type":"file","mime":"text/plain","url":format!("file://{}",empty_file.display())}).to_string()]).unwrap();
    drop(connection);
    let inventory = HostOpenCodeInventory::new(database).with_trusted_workspace_mount(
        "prj",
        None,
        "/synthetic",
        workspace,
    );
    let snapshot = export_exact_session(
        &inventory,
        "ses_exact",
        ExportOptions::new(temporary.path().join("export")),
    )
    .unwrap();
    let manifest = snapshot.manifest();
    let [reference] = manifest.assets.as_slice() else {
        panic!("the real workspace file must be exported as one verified reference");
    };
    assert_eq!(reference.kind, "workspace_path_reference");
    assert_eq!(reference.source_relative_path, "empty.txt");
    assert_eq!(reference.target_relative_path, "empty.txt");
    assert_eq!(reference.size_bytes, 0);
    assert_eq!(reference.sha256, hex::encode(Sha256::digest([])));
    assert!(snapshot
        .open_asset(&reference.target_relative_path)
        .is_err());

    // Use the same manifest-to-descriptor boundary as managed native resume.
    let manifest_json = serde_json::to_string(manifest).unwrap();
    let files = vec![OpenCodeTransferFile {
        index: 0,
        relative_path: "payload.json".into(),
        size_bytes: manifest.payload_bytes,
        sha256: manifest.payload_sha256.clone(),
    }];
    let target_image_ref = format!("sha256:{}", "a".repeat(64));
    let descriptor = OpenCodeTransferDescriptor {
        transfer_id: "empty-file-resume".into(),
        provider: "opencode".into(),
        source_store_id: manifest.source_store_id.clone(),
        root_session_id: manifest.root_session_id.clone(),
        source_generation: manifest.generation.clone(),
        provider_schema: manifest.provider_schema.clone(),
        source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
        destination_store_id: "soul-empty-file".into(),
        destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
        target_build_receipt: opencode_target_build_receipt(
            &target_image_ref,
            &manifest.provider_schema,
        ),
        target_image_ref,
        incarnation_id: "incarnation-empty-file".into(),
        bundle_sha256: opencode_transfer_bundle_digest(&manifest_json, &files),
        manifest_json,
        files,
        total_bytes: manifest.payload_bytes,
    };
    descriptor
        .validate_launch_binding(
            "opencode",
            "ses_exact",
            "soul-empty-file",
            "incarnation-empty-file",
            &descriptor.target_image_ref,
        )
        .expect(
            "verified empty workspace references must survive native resume descriptor validation",
        );
    let restored: OpenCodeTransferDescriptor =
        serde_json::from_slice(&serde_json::to_vec(&descriptor).unwrap()).unwrap();
    restored.validate().unwrap();
    assert_eq!(restored, descriptor);
}

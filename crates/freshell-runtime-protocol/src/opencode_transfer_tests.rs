use super::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferAction,
    OpenCodeTransferChunk, OpenCodeTransferDescriptor, OpenCodeTransferFile,
    MAX_CONTROL_FRAME_BYTES, MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
};
use sha2::{Digest, Sha256};

fn descriptor() -> OpenCodeTransferDescriptor {
    let source_store_id = "b".repeat(64);
    let source_generation = "e".repeat(64);
    let source_schema_fingerprint = "c".repeat(64);
    let migration_journal_fingerprint = "d".repeat(64);
    let target_image_ref = format!("sha256:{}", "a".repeat(64));
    let payload_sha256 = hex::encode(Sha256::digest(b"hello"));
    let manifest_json = serde_json::json!({
        "version": 1,
        "provider_schema": "opencode-1.18.21",
        "root_session_id": "ses_exact",
        "source_store_id": source_store_id,
        "source_schema_fingerprint": source_schema_fingerprint,
        "migration_journal_fingerprint": migration_journal_fingerprint,
        "generation": source_generation,
        "assets": [],
        "payload_bytes": 5,
        "payload_sha256": payload_sha256,
        "rows": []
    })
    .to_string();
    let files = vec![OpenCodeTransferFile {
        index: 0,
        relative_path: "payload.json".into(),
        size_bytes: 5,
        sha256: payload_sha256,
    }];
    let bundle_sha256 = opencode_transfer_bundle_digest(&manifest_json, &files);
    OpenCodeTransferDescriptor {
        transfer_id: "transfer-test-1".into(),
        provider: "opencode".into(),
        source_store_id,
        root_session_id: "ses_exact".into(),
        source_generation,
        provider_schema: "opencode-1.18.21".into(),
        source_schema_fingerprint,
        migration_journal_fingerprint,
        destination_store_id: "soul-exact".into(),
        destination_database_path: ".local/share/opencode/opencode.db".into(),
        target_image_ref: target_image_ref.clone(),
        target_build_receipt: opencode_target_build_receipt(&target_image_ref, "opencode-1.18.21"),
        incarnation_id: "incarnation-test".into(),
        manifest_json,
        files,
        total_bytes: 5,
        bundle_sha256,
    }
}

#[test]
fn opencode_session_transfer_descriptor_is_bounded_and_identity_bound() {
    let descriptor = descriptor();
    assert!(descriptor.validate().is_ok());
    assert!(descriptor
        .validate_launch_binding(
            "opencode",
            "ses_exact",
            "soul-exact",
            "incarnation-test",
            &descriptor.target_image_ref,
        )
        .is_ok());

    let mut wrong_provider = descriptor.clone();
    wrong_provider.provider = "claude".into();
    assert!(wrong_provider.validate().is_err());

    assert!(descriptor
        .validate_launch_binding(
            "opencode",
            "ses_other",
            "soul-exact",
            "incarnation-test",
            &descriptor.target_image_ref,
        )
        .is_err());

    let mut unsafe_destination = descriptor.clone();
    unsafe_destination.destination_database_path = "../outside.db".into();
    assert!(unsafe_destination.validate().is_err());

    let mut oversized = descriptor;
    oversized.total_bytes = 8 * 1024 * 1024 * 1024 + 1;
    assert!(oversized.validate().is_err());
}

#[test]
fn opencode_control_manifest_uses_streamed_bulk_metadata() {
    let mut descriptor = descriptor();
    let mut manifest: serde_json::Value = serde_json::from_str(&descriptor.manifest_json).unwrap();
    manifest["version"] = serde_json::json!(2);
    manifest["row_count"] = serde_json::json!(1);
    manifest["asset_count"] = serde_json::json!(0);
    manifest["saved_snapshot_summary"] = serde_json::json!({
        "status":"qualified_references", "retained_closure_count":0,
        "unavailable_reference_count":0,
    });
    manifest.as_object_mut().unwrap().remove("rows");
    manifest.as_object_mut().unwrap().remove("assets");
    descriptor.manifest_json = manifest.to_string();
    descriptor.bundle_sha256 =
        opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
    descriptor
        .validate()
        .expect("the checksummed bulk stream carries the variable row and asset metadata");
    for field in ["row_count", "asset_count", "saved_snapshot_summary"] {
        let mut invalid = manifest.clone();
        invalid.as_object_mut().unwrap().remove(field);
        descriptor.manifest_json = invalid.to_string();
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        assert!(
            descriptor.validate().is_err(),
            "missing {field} must not form a valid transfer descriptor"
        );
    }
}

#[test]
fn opencode_begin_action_round_trips_descriptor_and_attempt_token() {
    let descriptor = descriptor();
    let wire_value = serde_json::json!({
        "action": "begin",
        "data": { "descriptor": descriptor, "attempt_id": "a".repeat(32) },
    });
    let action = OpenCodeTransferAction::Begin {
        descriptor: Box::new(descriptor.clone()),
        attempt_id: "a".repeat(32),
    };
    assert_eq!(serde_json::to_value(&action).unwrap(), wire_value);

    let restored: OpenCodeTransferAction = serde_json::from_value(wire_value).unwrap();
    match restored {
        OpenCodeTransferAction::Begin {
            descriptor: restored,
            attempt_id,
        } => {
            assert_eq!(*restored, descriptor);
            assert_eq!(attempt_id, "a".repeat(32));
        }
        _ => panic!("begin action must round-trip as begin"),
    }
}

#[test]
fn reference_only_workspace_and_git_assets_do_not_require_transferred_files() {
    let mut descriptor = descriptor();
    let mut manifest: serde_json::Value = serde_json::from_str(&descriptor.manifest_json).unwrap();
    manifest["assets"] = serde_json::json!([
        {
            "kind": "workspace_path_reference",
            "source_relative_path": "src/main.rs",
            "target_relative_path": "src/main.rs",
            "size_bytes": 12,
            "sha256": "a".repeat(64)
        },
        {
            "kind": "git_tree_reference",
            "source_relative_path": "workspace:identity:git:sha1:tree",
            "target_relative_path": "workspace:identity:git:sha1:tree",
            "size_bytes": 42,
            "sha256": "b".repeat(64)
        }
    ]);
    descriptor.manifest_json = serde_json::to_string(&manifest).unwrap();
    descriptor.bundle_sha256 =
        opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);

    assert!(descriptor.validate().is_ok());
}

#[test]
fn zero_byte_assets_require_an_empty_workspace_reference_and_no_transferred_file() {
    for (kind, sha256, transferred) in [
        ("workspace_path_reference", "a".repeat(64), false),
        ("git_tree_reference", hex::encode(Sha256::digest([])), false),
        (
            "workspace_path_reference",
            hex::encode(Sha256::digest([])),
            true,
        ),
    ] {
        let mut descriptor = descriptor();
        let mut manifest: serde_json::Value =
            serde_json::from_str(&descriptor.manifest_json).unwrap();
        manifest["assets"] = serde_json::json!([{
            "kind": kind,
            "source_relative_path": "empty.txt",
            "target_relative_path": "empty.txt",
            "size_bytes": 0,
            "sha256": sha256,
        }]);
        descriptor.manifest_json = manifest.to_string();
        if transferred {
            descriptor.files.push(OpenCodeTransferFile {
                index: 1,
                relative_path: "empty.txt".into(),
                size_bytes: 0,
                sha256,
            });
        }
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        assert!(
            descriptor.validate().is_err(),
            "{kind}/transferred={transferred}"
        );
    }
    let empty_chunk = OpenCodeTransferChunk {
        transfer_id: "transfer-test-1".into(),
        attempt_id: "a".repeat(32),
        sequence: 0,
        file_index: 0,
        offset: 0,
        data: Vec::new(),
        sha256: hex::encode(Sha256::digest([])),
    };
    assert!(empty_chunk.validate().is_err());
}

#[test]
fn opencode_session_transfer_chunk_is_bounded_and_fits_authenticated_control_frame() {
    let mut chunk = OpenCodeTransferChunk {
        transfer_id: "transfer-test-1".into(),
        attempt_id: "a".repeat(32),
        sequence: 0,
        file_index: 0,
        offset: 0,
        data: vec![0x5a; MAX_OPENCODE_TRANSFER_CHUNK_BYTES],
        sha256: String::new(),
    };
    chunk.sha256 = hex::encode(Sha256::digest(&chunk.data));
    assert!(chunk.validate().is_ok());
    let encoded = serde_json::to_vec(&chunk).unwrap();
    assert!(encoded.len() + 1024 < MAX_CONTROL_FRAME_BYTES);
    let restored: OpenCodeTransferChunk = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(restored.data, chunk.data);

    chunk.data.push(0);
    chunk.sha256 = hex::encode(Sha256::digest(&chunk.data));
    assert!(chunk.validate().is_err());
}

#[test]
fn opencode_attempt_id_requires_canonical_lowercase_uuid_bytes() {
    assert!(super::valid_opencode_transfer_attempt_id(&"0a".repeat(16)));
    assert!(!super::valid_opencode_transfer_attempt_id(&"A".repeat(32)));
    assert!(!super::valid_opencode_transfer_attempt_id(&"a".repeat(31)));
}

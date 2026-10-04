use super::{OpenCodeTransferStaging, StagingLimits, StagingStart};
use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferChunk,
    OpenCodeTransferDescriptor, OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;

fn descriptor(payload: &[u8], transfer_id: &str) -> OpenCodeTransferDescriptor {
    let source_store_id = "b".repeat(64);
    let source_generation = "e".repeat(64);
    let source_schema_fingerprint = "c".repeat(64);
    let migration_journal_fingerprint = "d".repeat(64);
    let target_image_ref = format!("sha256:{}", "a".repeat(64));
    let payload_sha256 = hex::encode(Sha256::digest(payload));
    let manifest_json = serde_json::json!({
        "version": 1,
        "provider_schema": "opencode-1.18.21",
        "root_session_id": "ses_exact",
        "source_store_id": source_store_id,
        "source_schema_fingerprint": source_schema_fingerprint,
        "migration_journal_fingerprint": migration_journal_fingerprint,
        "generation": source_generation,
        "assets": [],
        "payload_bytes": payload.len(),
        "payload_sha256": payload_sha256,
        "rows": []
    })
    .to_string();
    let payload_sha256 = hex::encode(Sha256::digest(payload));
    let files = vec![OpenCodeTransferFile {
        index: 0,
        relative_path: "payload.json".into(),
        size_bytes: payload.len() as u64,
        sha256: payload_sha256,
    }];
    OpenCodeTransferDescriptor {
        transfer_id: transfer_id.into(),
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
        manifest_json: manifest_json.clone(),
        files: files.clone(),
        total_bytes: payload.len() as u64,
        bundle_sha256: opencode_transfer_bundle_digest(&manifest_json, &files),
    }
}

fn chunk(
    descriptor: &OpenCodeTransferDescriptor,
    payload: &[u8],
    sequence: u64,
) -> OpenCodeTransferChunk {
    let offset = sequence as usize * MAX_OPENCODE_TRANSFER_CHUNK_BYTES;
    let data =
        payload[offset..(offset + MAX_OPENCODE_TRANSFER_CHUNK_BYTES).min(payload.len())].to_vec();
    OpenCodeTransferChunk {
        transfer_id: descriptor.transfer_id.clone(),
        sequence,
        file_index: 0,
        offset: offset as u64,
        sha256: hex::encode(Sha256::digest(&data)),
        data,
    }
}

#[test]
fn staged_transfer_enforces_order_retries_identical_chunks_and_verifies_final_digest() {
    let dir = tempfile::tempdir().unwrap();
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    let payload = vec![0x41; MAX_OPENCODE_TRANSFER_CHUNK_BYTES + 9];
    let descriptor = descriptor(&payload, "transfer-order");
    assert!(matches!(
        staging.begin(&descriptor, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 0,
            ..
        }
    ));

    let first = chunk(&descriptor, &payload, 0);
    let mut out_of_order = first.clone();
    out_of_order.sequence = 1;
    out_of_order.offset = MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64;
    assert!(staging.write_chunk(&out_of_order).is_err());

    staging.write_chunk(&first).unwrap();
    staging.write_chunk(&first).unwrap(); // response-loss retry is an exact no-op
    assert!(staging.finalize(&descriptor.transfer_id).is_err());
    staging
        .write_chunk(&chunk(&descriptor, &payload, 1))
        .unwrap();
    let ready = staging.finalize(&descriptor.transfer_id).unwrap();
    assert!(ready.is_dir());
    assert_eq!(
        std::fs::read(ready.join("entry-0000.bin")).unwrap(),
        payload
    );
    assert_eq!(staging.verify_ready(&descriptor).unwrap(), ready);
}

#[test]
fn staged_transfer_resumes_after_restart_and_refuses_tampered_ready_data() {
    let dir = tempfile::tempdir().unwrap();
    let payload = vec![0x31; MAX_OPENCODE_TRANSFER_CHUNK_BYTES + 2];
    let descriptor = descriptor(&payload, "transfer-resume");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    staging.begin(&descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, &payload, 0))
        .unwrap();
    drop(staging);

    let restarted = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    assert!(matches!(
        restarted.begin(&descriptor, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ..
        }
    ));
    restarted
        .write_chunk(&chunk(&descriptor, &payload, 1))
        .unwrap();
    let ready = restarted.finalize(&descriptor.transfer_id).unwrap();
    assert_eq!(restarted.verify_ready(&descriptor).unwrap(), ready);
    std::fs::set_permissions(
        ready.join("entry-0000.bin"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    std::fs::write(ready.join("entry-0000.bin"), b"tampered").unwrap();
    assert!(restarted.verify_ready(&descriptor).is_err());
}

#[test]
fn staged_transfer_enforces_bundle_quota_aggregate_queue_and_free_space() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    assert!(staging
        .begin(&descriptor(b"123456789", "over-bundle"), 64)
        .is_err());
    assert!(staging
        .begin(&descriptor(b"12345678", "low-space"), 7)
        .is_err());

    let first = descriptor(b"12345678", "first-transfer");
    assert!(matches!(
        staging.begin(&first, 8).unwrap(),
        StagingStart::Started { .. }
    ));
    let queued = descriptor(b"ab", "queued-transfer");
    assert_eq!(staging.begin(&queued, 8).unwrap(), StagingStart::Queued);
    staging.abort(&first.transfer_id).unwrap();
    assert!(matches!(
        staging.begin(&queued, 8).unwrap(),
        StagingStart::Started { .. }
    ));
}

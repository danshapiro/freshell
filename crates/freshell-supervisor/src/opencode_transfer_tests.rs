use super::{OpenCodeTransferStaging, StagingLimits, StagingStart};
use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferChunk,
    OpenCodeTransferDescriptor, OpenCodeTransferFile, OpenCodeTransferReadinessReceipt,
    MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    os::unix::fs::PermissionsExt,
    time::{Duration, SystemTime},
};

fn descriptor(payload: &[u8], transfer_id: &str) -> OpenCodeTransferDescriptor {
    descriptor_for_generation(payload, transfer_id, &"e".repeat(64))
}

fn descriptor_for_generation(
    payload: &[u8],
    transfer_id: &str,
    generation: &str,
) -> OpenCodeTransferDescriptor {
    let source_store_id = "b".repeat(64);
    let source_generation = generation.to_string();
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
fn staged_transfer_repairs_crash_between_partial_creation_and_descriptor_payload() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(b"synthetic", "transfer-init-crash");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    let partial = staging.root.join("transfer-init-crash.partial");
    std::fs::create_dir(&partial).unwrap();
    std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o700)).unwrap();

    assert!(matches!(
        staging.begin(&descriptor, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 0,
            ..
        }
    ));
    assert!(partial.join("descriptor.json").is_file());
    assert!(partial.join("entry-0000.part").is_file());
}

#[test]
fn staged_transfer_recovers_after_payload_rename_before_ready_marker() {
    let dir = tempfile::tempdir().unwrap();
    let payload = b"synthetic payload";
    let descriptor = descriptor(payload, "transfer-finalize-crash");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    staging.begin(&descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, payload, 0))
        .unwrap();
    let partial = staging.root.join("transfer-finalize-crash.partial");
    std::fs::rename(
        partial.join("entry-0000.part"),
        partial.join("entry-0000.bin"),
    )
    .unwrap();
    drop(staging);

    let restarted = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    assert!(matches!(
        restarted.begin(&descriptor, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ref file_offsets,
        } if file_offsets[0].next_offset == payload.len() as u64
    ));
    let ready = restarted.finalize(&descriptor.transfer_id).unwrap();
    assert_eq!(
        std::fs::read(ready.join("entry-0000.bin")).unwrap(),
        payload
    );
}

#[test]
fn staged_transfer_resumes_and_reuses_ready_bundle_below_full_bundle_free_space() {
    let dir = tempfile::tempdir().unwrap();
    let payload = vec![0x52; MAX_OPENCODE_TRANSFER_CHUNK_BYTES + 1];
    let descriptor = descriptor(&payload, "transfer-low-space-resume");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    staging.begin(&descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, &payload, 0))
        .unwrap();

    assert!(matches!(
        staging.begin(&descriptor, 1).unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ref file_offsets,
        } if file_offsets[0].next_offset == MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64
    ));
    staging
        .write_chunk(&chunk(&descriptor, &payload, 1))
        .unwrap();
    staging.finalize(&descriptor.transfer_id).unwrap();
    assert!(matches!(
        staging.begin(&descriptor, 0).unwrap(),
        StagingStart::Started {
            next_sequence: 2,
            ..
        }
    ));
}

#[test]
fn release_cleanup_waits_for_receipts_and_retries_after_restart_without_references() {
    let dir = tempfile::tempdir().unwrap();
    let payload = b"synthetic payload";
    let descriptor = descriptor(payload, "transfer-release-retry");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    staging.begin(&descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, payload, 0))
        .unwrap();
    let ready = staging.finalize(&descriptor.transfer_id).unwrap();
    let receipt = readiness_receipt(&descriptor);
    staging
        .mark_release_eligible(&descriptor, &receipt)
        .unwrap();

    assert_eq!(
        staging
            .reclaim_release_eligible(&HashSet::from([descriptor.transfer_id.clone()]))
            .unwrap(),
        0
    );
    assert!(ready.is_dir());

    drop(staging);
    let restarted = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    assert_eq!(
        restarted.reclaim_release_eligible(&HashSet::new()).unwrap(),
        1
    );
    assert!(!ready.exists());
    assert_eq!(
        restarted.reclaim_release_eligible(&HashSet::new()).unwrap(),
        0
    );
}

#[test]
fn release_cleanup_rejects_receipts_bound_to_another_transfer() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(b"payload", "transfer-release-binding");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    staging.begin(&descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, b"payload", 0))
        .unwrap();
    let ready = staging.finalize(&descriptor.transfer_id).unwrap();
    let mut receipt = readiness_receipt(&descriptor);
    receipt.transfer_id = "different-transfer".into();
    assert!(staging
        .mark_release_eligible(&descriptor, &receipt)
        .is_err());
    assert!(ready.is_dir());
}

fn readiness_receipt(descriptor: &OpenCodeTransferDescriptor) -> OpenCodeTransferReadinessReceipt {
    OpenCodeTransferReadinessReceipt {
        transfer_id: descriptor.transfer_id.clone(),
        destination_store_id: descriptor.destination_store_id.clone(),
        root_session_id: descriptor.root_session_id.clone(),
        source_generation: descriptor.source_generation.clone(),
        provider_uid: unsafe { libc::geteuid() },
        provider_gid: unsafe { libc::getegid() },
        structural_sha256: "a".repeat(64),
        reader_receipt_sha256: "b".repeat(64),
    }
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

#[test]
fn changed_source_generation_reclaims_stale_partial_and_finishes_within_quota_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let payload = b"12345678";
    let old = descriptor_for_generation(payload, "transfer-old-generation", &"e".repeat(64));
    let old_partial = dir
        .path()
        .join("opencode-transfers/transfer-old-generation.partial");
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    staging.begin(&old, u64::MAX).unwrap();
    staging.write_chunk(&chunk(&old, payload, 0)).unwrap();
    drop(staging);

    // Simulate a partial created by the previous release, before its activity
    // marker existed. Legacy entries age from their newest payload/metadata.
    std::fs::remove_file(old_partial.join(".activity")).unwrap();
    set_tree_modified(
        &old_partial,
        SystemTime::now() - Duration::from_secs(2 * 60 * 60),
    );
    let restarted = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    let changed = descriptor_for_generation(payload, "transfer-new-generation", &"f".repeat(64));
    assert_ne!(old.source_generation, changed.source_generation);
    assert_ne!(old.transfer_id, changed.transfer_id);
    assert!(matches!(
        restarted.begin(&changed, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 0,
            ..
        }
    ));
    assert!(
        !old_partial.exists(),
        "stale generation must release its quota"
    );

    restarted.write_chunk(&chunk(&changed, payload, 0)).unwrap();
    let ready = restarted.finalize(&changed.transfer_id).unwrap();
    assert_eq!(
        std::fs::read(ready.join("entry-0000.bin")).unwrap(),
        payload
    );
}

#[test]
fn stale_stage_cleanup_preserves_a_transfer_with_recent_durable_activity() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    let active = descriptor(b"12345678", "transfer-active");
    staging.begin(&active, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&active, b"12345678", 0))
        .unwrap();

    let other = descriptor(b"x", "transfer-waits-for-active");
    assert_eq!(
        staging.begin(&other, u64::MAX).unwrap(),
        StagingStart::Queued
    );
    assert!(staging.partial_path(&active.transfer_id).is_dir());
    assert!(staging.queued_path(&other.transfer_id).is_dir());
}

#[test]
fn stale_partial_cleanup_after_restart_is_idempotent_and_keeps_ready_release_guards() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 16);
    let partial = descriptor(b"12345678", "transfer-crashed-partial");
    let ready = descriptor(b"12345678", "transfer-ready-is-not-garbage");
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    staging.begin(&partial, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&partial, b"12345678", 0))
        .unwrap();
    staging.begin(&ready, u64::MAX).unwrap();
    staging.write_chunk(&chunk(&ready, b"12345678", 0)).unwrap();
    let ready_path = staging.finalize(&ready.transfer_id).unwrap();
    let stale_path = staging.partial_path(&partial.transfer_id);
    drop(staging);

    set_tree_modified(
        &stale_path,
        SystemTime::now() - Duration::from_secs(2 * 60 * 60),
    );
    let restarted = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    assert_eq!(restarted.reclaim_abandoned_partials().unwrap(), 1);
    assert_eq!(restarted.reclaim_abandoned_partials().unwrap(), 0);
    let next = descriptor(b"z", "transfer-after-restart");
    assert!(matches!(
        restarted.begin(&next, u64::MAX).unwrap(),
        StagingStart::Started { .. }
    ));
    assert!(!stale_path.exists());
    assert!(ready_path.is_dir(), "ready bundles remain receipt-gated");
    restarted.abort(&ready.transfer_id).unwrap();
    assert!(ready_path.is_dir(), "Abort must not bypass receipt release");

    let final_id = descriptor(b"q", "transfer-idempotent-retry");
    assert!(matches!(
        restarted.begin(&final_id, u64::MAX).unwrap(),
        StagingStart::Started { .. }
    ));
    assert!(matches!(
        restarted.begin(&final_id, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 0,
            ..
        }
    ));
}

fn set_tree_modified(path: &std::path::Path, modified: SystemTime) {
    for entry in std::fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        let file = File::open(entry.path()).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    File::open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
}

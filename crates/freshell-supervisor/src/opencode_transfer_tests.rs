use super::{OpenCodeTransferStaging, StagingLimits, StagingStart, ABANDONED_READY_AGE};
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

const TEST_ATTEMPT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RETRY_ATTEMPT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
    chunk_for_attempt(descriptor, payload, sequence, TEST_ATTEMPT)
}

fn chunk_for_attempt(
    descriptor: &OpenCodeTransferDescriptor,
    payload: &[u8],
    sequence: u64,
    attempt_id: &str,
) -> OpenCodeTransferChunk {
    let offset = sequence as usize * MAX_OPENCODE_TRANSFER_CHUNK_BYTES;
    let data =
        payload[offset..(offset + MAX_OPENCODE_TRANSFER_CHUNK_BYTES).min(payload.len())].to_vec();
    OpenCodeTransferChunk {
        transfer_id: descriptor.transfer_id.clone(),
        attempt_id: attempt_id.into(),
        sequence,
        file_index: 0,
        offset: offset as u64,
        sha256: hex::encode(Sha256::digest(&data)),
        data,
    }
}

fn begin_test_attempt(
    staging: &OpenCodeTransferStaging,
    descriptor: &OpenCodeTransferDescriptor,
    available_bytes: u64,
) -> Result<StagingStart, super::StagingError> {
    staging.begin(descriptor, TEST_ATTEMPT, available_bytes)
}

fn finalize_test_attempt(
    staging: &OpenCodeTransferStaging,
    transfer_id: &str,
) -> Result<std::path::PathBuf, super::StagingError> {
    staging.finalize(transfer_id, TEST_ATTEMPT)
}

fn abort_test_attempt(
    staging: &OpenCodeTransferStaging,
    transfer_id: &str,
) -> Result<(), super::StagingError> {
    staging.abort(transfer_id, TEST_ATTEMPT)
}

#[test]
fn staged_transfer_enforces_order_retries_identical_chunks_and_verifies_final_digest() {
    let dir = tempfile::tempdir().unwrap();
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    let payload = vec![0x41; MAX_OPENCODE_TRANSFER_CHUNK_BYTES + 9];
    let descriptor = descriptor(&payload, "transfer-order");
    assert!(matches!(
        begin_test_attempt(&staging, &descriptor, u64::MAX).unwrap(),
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
    assert!(finalize_test_attempt(&staging, &descriptor.transfer_id).is_err());
    staging
        .write_chunk(&chunk(&descriptor, &payload, 1))
        .unwrap();
    let ready = finalize_test_attempt(&staging, &descriptor.transfer_id).unwrap();
    assert!(ready.is_dir());
    assert_eq!(
        std::fs::read(ready.join("entry-0000.bin")).unwrap(),
        payload
    );
    assert_eq!(staging.verify_ready(&descriptor).unwrap(), ready);
}

#[test]
fn delayed_abort_from_superseded_attempt_keeps_resumed_partial_stage() {
    let dir = tempfile::tempdir().unwrap();
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    let payload = vec![0x71; MAX_OPENCODE_TRANSFER_CHUNK_BYTES + 5];
    let descriptor = descriptor(&payload, "transfer-abort-fence");

    // Attempt A has durable progress when it is cancelled.
    staging.begin(&descriptor, TEST_ATTEMPT, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, &payload, 0))
        .unwrap();

    // A retry for the same stable transfer ID resumes that exact partial.
    assert!(matches!(
        staging.begin(&descriptor, RETRY_ATTEMPT, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ref file_offsets,
        } if file_offsets[0].next_offset == MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64
    ));

    // The delayed cancellation cleanup from A must not remove B's stage.
    assert!(
        staging
            .write_chunk(&chunk_for_attempt(&descriptor, &payload, 1, TEST_ATTEMPT))
            .is_err(),
        "superseded A cannot write after B resumes"
    );
    assert!(
        staging
            .finalize(&descriptor.transfer_id, TEST_ATTEMPT)
            .is_err(),
        "superseded A cannot finalize after B resumes"
    );
    staging
        .abort(&descriptor.transfer_id, TEST_ATTEMPT)
        .unwrap();
    assert!(
        staging.partial_path(&descriptor.transfer_id).is_dir(),
        "a superseded attempt's delayed Abort must leave the resumed stage intact"
    );
    staging
        .write_chunk(&chunk_for_attempt(&descriptor, &payload, 1, RETRY_ATTEMPT))
        .unwrap();
    let ready = staging
        .finalize(&descriptor.transfer_id, RETRY_ATTEMPT)
        .unwrap();
    staging
        .mark_launch_claimed(&descriptor, RETRY_ATTEMPT)
        .unwrap();
    assert_eq!(
        std::fs::read(ready.join("entry-0000.bin")).unwrap(),
        payload
    );
    staging
        .abort(&descriptor.transfer_id, RETRY_ATTEMPT)
        .unwrap();
    assert!(ready.is_dir(), "Abort must never remove a ready stage");
}

#[test]
fn current_attempt_abort_releases_partial_quota_after_stale_abort_is_inert() {
    let dir = tempfile::tempdir().unwrap();
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::for_test(8, 8)).unwrap();
    let payload = b"12345678";
    let transfer = descriptor(payload, "transfer-abort-quota");

    staging.begin(&transfer, TEST_ATTEMPT, 8).unwrap();
    staging
        .write_chunk(&chunk_for_attempt(&transfer, payload, 0, TEST_ATTEMPT))
        .unwrap();
    staging.begin(&transfer, RETRY_ATTEMPT, 0).unwrap();

    // An old cleanup is an idempotent no-op against the new owner.
    staging.abort(&transfer.transfer_id, TEST_ATTEMPT).unwrap();
    assert!(staging.partial_path(&transfer.transfer_id).is_dir());

    // The current owner still releases its reservation promptly.
    staging.abort(&transfer.transfer_id, RETRY_ATTEMPT).unwrap();
    assert!(!staging.partial_path(&transfer.transfer_id).exists());
    let next = descriptor(b"abcdefgh", "transfer-after-abort");
    assert!(matches!(
        staging.begin(&next, TEST_ATTEMPT, 8).unwrap(),
        StagingStart::Started { .. }
    ));
}

#[test]
fn staged_transfer_resumes_after_restart_and_refuses_tampered_ready_data() {
    let dir = tempfile::tempdir().unwrap();
    let payload = vec![0x31; MAX_OPENCODE_TRANSFER_CHUNK_BYTES + 2];
    let descriptor = descriptor(&payload, "transfer-resume");
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    staging.begin(&descriptor, TEST_ATTEMPT, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, &payload, 0))
        .unwrap();
    drop(staging);

    let restarted = OpenCodeTransferStaging::new(dir.path(), StagingLimits::production()).unwrap();
    assert!(matches!(
        restarted
            .begin(&descriptor, RETRY_ATTEMPT, u64::MAX)
            .unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ..
        }
    ));
    restarted
        .abort(&descriptor.transfer_id, TEST_ATTEMPT)
        .unwrap();
    assert!(restarted.partial_path(&descriptor.transfer_id).is_dir());
    restarted
        .write_chunk(&chunk_for_attempt(&descriptor, &payload, 1, RETRY_ATTEMPT))
        .unwrap();
    let ready = restarted
        .finalize(&descriptor.transfer_id, RETRY_ATTEMPT)
        .unwrap();
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
        begin_test_attempt(&staging, &descriptor, u64::MAX).unwrap(),
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
    begin_test_attempt(&staging, &descriptor, u64::MAX).unwrap();
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
        begin_test_attempt(&restarted, &descriptor, u64::MAX).unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ref file_offsets,
        } if file_offsets[0].next_offset == payload.len() as u64
    ));
    let ready = finalize_test_attempt(&restarted, &descriptor.transfer_id).unwrap();
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
    begin_test_attempt(&staging, &descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, &payload, 0))
        .unwrap();

    assert!(matches!(
        begin_test_attempt(&staging, &descriptor, 1).unwrap(),
        StagingStart::Started {
            next_sequence: 1,
            ref file_offsets,
        } if file_offsets[0].next_offset == MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64
    ));
    staging
        .write_chunk(&chunk(&descriptor, &payload, 1))
        .unwrap();
    finalize_test_attempt(&staging, &descriptor.transfer_id).unwrap();
    assert!(matches!(
        begin_test_attempt(&staging, &descriptor, 0).unwrap(),
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
    begin_test_attempt(&staging, &descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, payload, 0))
        .unwrap();
    let ready = finalize_test_attempt(&staging, &descriptor.transfer_id).unwrap();
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
    begin_test_attempt(&staging, &descriptor, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&descriptor, b"payload", 0))
        .unwrap();
    let ready = finalize_test_attempt(&staging, &descriptor.transfer_id).unwrap();
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
        .begin(&descriptor(b"123456789", "over-bundle"), TEST_ATTEMPT, 64)
        .is_err());
    assert!(staging
        .begin(&descriptor(b"12345678", "low-space"), TEST_ATTEMPT, 7)
        .is_err());

    let first = descriptor(b"12345678", "first-transfer");
    assert!(matches!(
        begin_test_attempt(&staging, &first, 8).unwrap(),
        StagingStart::Started { .. }
    ));
    let queued = descriptor(b"ab", "queued-transfer");
    assert_eq!(
        begin_test_attempt(&staging, &queued, 8).unwrap(),
        StagingStart::Queued
    );
    abort_test_attempt(&staging, &first.transfer_id).unwrap();
    assert!(matches!(
        begin_test_attempt(&staging, &queued, 8).unwrap(),
        StagingStart::Started { .. }
    ));
}

#[test]
fn staging_queue_is_bounded_and_rejects_only_entries_beyond_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let staging = OpenCodeTransferStaging::new(dir.path(), StagingLimits::for_test(8, 8)).unwrap();
    let full = descriptor(b"12345678", "transfer-queue-bound-full");
    assert!(matches!(
        staging.begin(&full, TEST_ATTEMPT, 8).unwrap(),
        StagingStart::Started { .. }
    ));

    for index in 0..super::MAX_QUEUED_TRANSFERS {
        let queued = descriptor(b"abcdefgh", &format!("transfer-queue-bound-{index}"));
        assert_eq!(
            staging.begin(&queued, TEST_ATTEMPT, 8).unwrap(),
            StagingStart::Queued
        );
    }
    assert_eq!(
        staging.queued_count_unlocked().unwrap(),
        super::MAX_QUEUED_TRANSFERS
    );

    let overflow = descriptor(b"ABCDEFGH", "transfer-queue-bound-overflow");
    assert!(matches!(
        staging.begin(&overflow, TEST_ATTEMPT, 8),
        Err(super::StagingError::Capacity(_))
    ));
    assert!(!staging.queued_path(&overflow.transfer_id).exists());
}

#[test]
fn finalized_unclaimed_ready_stage_is_released_on_abort_or_expiry_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();

    let cancelled = descriptor(b"12345678", "transfer-finalized-cancelled");
    staging.begin(&cancelled, TEST_ATTEMPT, 8).unwrap();
    staging
        .write_chunk(&chunk(&cancelled, b"12345678", 0))
        .unwrap();
    let cancelled_ready = staging
        .finalize(&cancelled.transfer_id, TEST_ATTEMPT)
        .unwrap();
    staging.abort(&cancelled.transfer_id, TEST_ATTEMPT).unwrap();
    assert!(
        !cancelled_ready.exists(),
        "a matching pre-registration cancellation promptly releases the ready reservation"
    );

    let crashed = descriptor(b"abcdefgh", "transfer-finalized-crashed");
    staging.begin(&crashed, TEST_ATTEMPT, 8).unwrap();
    staging
        .write_chunk(&chunk(&crashed, b"abcdefgh", 0))
        .unwrap();
    let crashed_ready = staging
        .finalize(&crashed.transfer_id, TEST_ATTEMPT)
        .unwrap();
    drop(staging);

    let restarted = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    let expired_at = SystemTime::now() + ABANDONED_READY_AGE + Duration::from_secs(1);
    assert_eq!(
        restarted
            .reclaim_abandoned_ready_at(&HashSet::new(), expired_at)
            .unwrap(),
        1
    );
    assert!(!crashed_ready.exists());
    let replacement = descriptor(b"87654321", "transfer-after-ready-expiry");
    assert!(matches!(
        restarted.begin(&replacement, TEST_ATTEMPT, 8).unwrap(),
        StagingStart::Started { .. }
    ));
}

#[test]
fn claimed_or_registry_referenced_ready_stages_survive_abort_and_expiry_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    let registered = descriptor(b"12345678", "transfer-registered-ready");
    staging.begin(&registered, TEST_ATTEMPT, 8).unwrap();
    staging
        .write_chunk(&chunk(&registered, b"12345678", 0))
        .unwrap();
    let ready = staging
        .finalize(&registered.transfer_id, TEST_ATTEMPT)
        .unwrap();

    // A stale registry snapshot must retain the stage while it is referenced.
    let expired_at = SystemTime::now() + ABANDONED_READY_AGE + Duration::from_secs(1);
    assert_eq!(
        staging
            .reclaim_abandoned_ready_at(
                &HashSet::from([registered.transfer_id.clone()]),
                expired_at,
            )
            .unwrap(),
        0
    );

    // Claim and cancellation serialize under the staging lock. Once claimed,
    // retryable registry state remains protected even when a later snapshot
    // temporarily contains no reference.
    staging
        .mark_launch_claimed(&registered, TEST_ATTEMPT)
        .unwrap();
    staging
        .abort(&registered.transfer_id, TEST_ATTEMPT)
        .unwrap();
    assert!(ready.is_dir());
    assert_eq!(
        staging
            .reclaim_abandoned_ready_at(&HashSet::new(), expired_at)
            .unwrap(),
        0
    );
    assert!(ready.is_dir());
}

#[test]
fn registration_claim_racing_abort_and_expiry_keeps_registry_owned_ready_stage() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let staging = std::sync::Arc::new(OpenCodeTransferStaging::new(dir.path(), limits).unwrap());
    let registered = descriptor(b"12345678", "transfer-register-abort-race");
    staging.begin(&registered, TEST_ATTEMPT, 8).unwrap();
    staging
        .write_chunk(&chunk(&registered, b"12345678", 0))
        .unwrap();
    let ready = staging
        .finalize(&registered.transfer_id, TEST_ATTEMPT)
        .unwrap();
    staging
        .mark_launch_registering(&registered, TEST_ATTEMPT, false)
        .unwrap();

    let superseding_begin = staging.begin(&registered, RETRY_ATTEMPT, 8);
    assert!(
        superseding_begin.is_err(),
        "a new attempt cannot replace ownership while registry preparation is in flight"
    );

    let references = HashSet::from([registered.transfer_id.clone()]);
    let claim_staging = std::sync::Arc::clone(&staging);
    let abort_staging = std::sync::Arc::clone(&staging);
    let cleanup_staging = std::sync::Arc::clone(&staging);
    std::thread::scope(|scope| {
        let claim = scope.spawn(|| claim_staging.mark_launch_claimed(&registered, TEST_ATTEMPT));
        let abort = scope.spawn(|| {
            abort_staging.abort_with_references(&registered.transfer_id, TEST_ATTEMPT, &references)
        });
        let cleanup = scope.spawn(|| {
            cleanup_staging.reclaim_abandoned_ready_at(
                &references,
                SystemTime::now() + ABANDONED_READY_AGE + Duration::from_secs(1),
            )
        });
        claim.join().unwrap().unwrap();
        abort.join().unwrap().unwrap();
        assert_eq!(cleanup.join().unwrap().unwrap(), 0);
    });

    assert!(ready.is_dir());
    assert_eq!(
        staging
            .reclaim_abandoned_ready_at(
                &HashSet::new(),
                SystemTime::now() + ABANDONED_READY_AGE + Duration::from_secs(1),
            )
            .unwrap(),
        0,
        "a claimed retry stage stays intact even without a stale reference snapshot"
    );
}

#[tokio::test]
async fn queued_transfers_progress_fifo_after_receipt_release_and_cancel_by_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let staging = std::sync::Arc::new(OpenCodeTransferStaging::new(dir.path(), limits).unwrap());
    let full = descriptor(b"12345678", "transfer-full-ready");
    staging.begin(&full, TEST_ATTEMPT, 8).unwrap();
    staging.write_chunk(&chunk(&full, b"12345678", 0)).unwrap();
    staging.finalize(&full.transfer_id, TEST_ATTEMPT).unwrap();
    staging.mark_launch_claimed(&full, TEST_ATTEMPT).unwrap();

    let first = descriptor(b"abcdefgh", "transfer-queue-first");
    let cancelled = descriptor(b"ABCDEFGH", "transfer-queue-cancelled");
    let last = descriptor(b"87654321", "transfer-queue-last");
    for item in [&first, &cancelled, &last] {
        assert_eq!(
            staging.begin(item, TEST_ATTEMPT, 8).unwrap(),
            StagingStart::Queued
        );
    }

    let first_wait = {
        let staging = std::sync::Arc::clone(&staging);
        let transfer_id = first.transfer_id.clone();
        tokio::spawn(async move { staging.wait_for_capacity(&transfer_id, TEST_ATTEMPT).await })
    };
    let cancelled_wait = {
        let staging = std::sync::Arc::clone(&staging);
        let transfer_id = cancelled.transfer_id.clone();
        tokio::spawn(async move { staging.wait_for_capacity(&transfer_id, TEST_ATTEMPT).await })
    };
    let last_wait = {
        let staging = std::sync::Arc::clone(&staging);
        let transfer_id = last.transfer_id.clone();
        tokio::spawn(async move { staging.wait_for_capacity(&transfer_id, TEST_ATTEMPT).await })
    };

    staging
        .mark_release_eligible(&full, &readiness_receipt(&full))
        .unwrap();
    assert_eq!(
        staging.reclaim_release_eligible(&HashSet::new()).unwrap(),
        1
    );
    assert!(matches!(
        first_wait.await.unwrap().unwrap(),
        StagingStart::Started { .. }
    ));
    assert!(staging.partial_path(&first.transfer_id).is_dir());
    assert!(staging.queued_path(&cancelled.transfer_id).is_dir());
    assert!(staging.queued_path(&last.transfer_id).is_dir());

    // Cancelling a queued waiter removes only its own FIFO entry. It cannot
    // delete the next transfer's reservation or queue position.
    staging.abort(&cancelled.transfer_id, TEST_ATTEMPT).unwrap();
    assert!(cancelled_wait.await.unwrap().is_err());
    staging.abort(&first.transfer_id, TEST_ATTEMPT).unwrap();
    assert!(matches!(
        last_wait.await.unwrap().unwrap(),
        StagingStart::Started { .. }
    ));
    assert!(staging.partial_path(&last.transfer_id).is_dir());
}

#[test]
fn queued_transfer_order_and_retry_survive_supervisor_restart() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StagingLimits::for_test(8, 8);
    let full = descriptor(b"12345678", "transfer-restart-full");
    let queued = descriptor(b"abcdefgh", "transfer-restart-queued");
    let staging = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    staging.begin(&full, TEST_ATTEMPT, 8).unwrap();
    assert_eq!(
        staging.begin(&queued, TEST_ATTEMPT, 8).unwrap(),
        StagingStart::Queued
    );
    drop(staging);

    let restarted = OpenCodeTransferStaging::new(dir.path(), limits).unwrap();
    assert_eq!(
        restarted.begin(&queued, RETRY_ATTEMPT, 8).unwrap(),
        StagingStart::Queued
    );
    restarted.abort(&queued.transfer_id, TEST_ATTEMPT).unwrap();
    assert!(restarted.queued_path(&queued.transfer_id).is_dir());
    restarted.abort(&full.transfer_id, TEST_ATTEMPT).unwrap();
    assert!(matches!(
        restarted.begin(&queued, RETRY_ATTEMPT, 8).unwrap(),
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
    begin_test_attempt(&staging, &old, u64::MAX).unwrap();
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
        begin_test_attempt(&restarted, &changed, u64::MAX).unwrap(),
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
    let ready = finalize_test_attempt(&restarted, &changed.transfer_id).unwrap();
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
    begin_test_attempt(&staging, &active, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&active, b"12345678", 0))
        .unwrap();

    let other = descriptor(b"x", "transfer-waits-for-active");
    assert_eq!(
        begin_test_attempt(&staging, &other, u64::MAX).unwrap(),
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
    begin_test_attempt(&staging, &partial, u64::MAX).unwrap();
    staging
        .write_chunk(&chunk(&partial, b"12345678", 0))
        .unwrap();
    begin_test_attempt(&staging, &ready, u64::MAX).unwrap();
    staging.write_chunk(&chunk(&ready, b"12345678", 0)).unwrap();
    let ready_path = finalize_test_attempt(&staging, &ready.transfer_id).unwrap();
    staging.mark_launch_claimed(&ready, TEST_ATTEMPT).unwrap();
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
        begin_test_attempt(&restarted, &next, u64::MAX).unwrap(),
        StagingStart::Started { .. }
    ));
    assert!(!stale_path.exists());
    assert!(ready_path.is_dir(), "ready bundles remain receipt-gated");
    abort_test_attempt(&restarted, &ready.transfer_id).unwrap();
    assert!(ready_path.is_dir(), "Abort must not bypass receipt release");

    let final_id = descriptor(b"q", "transfer-idempotent-retry");
    assert!(matches!(
        begin_test_attempt(&restarted, &final_id, u64::MAX).unwrap(),
        StagingStart::Started { .. }
    ));
    assert!(matches!(
        begin_test_attempt(&restarted, &final_id, u64::MAX).unwrap(),
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

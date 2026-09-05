//! Unit tests for `crate::pane_ledger` (P1.8, spec §4.2). Kept in a sibling
//! file (the `tabs_persist_tests.rs` convention) to respect the ≤1K-lines
//! file limit as the ledger's test surface grows.

use super::*;
use std::collections::HashSet;
use std::path::PathBuf;

fn temp_root(label: &str) -> PathBuf {
    // Same atomic-counter + pid pattern as `opencode_association.rs`'s
    // `unique_temp_dir` — no tempfile dependency needed for a dir we
    // remove ourselves.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-test-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp root");
    dir
}

fn write(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    now_ms: i64,
) -> BindingWrite<'static> {
    // Leak the strings for test brevity — tests are short-lived.
    BindingWrite {
        provider: Box::leak(provider.to_string().into_boxed_str()),
        session_id: Box::leak(session_id.to_string().into_boxed_str()),
        terminal_id: Box::leak(terminal_id.to_string().into_boxed_str()),
        mode: Box::leak(provider.to_string().into_boxed_str()),
        cwd: Some("/tmp/proj"),
        create_request_id: Some("req-1"),
        now_ms,
    }
}

#[test]
fn record_binding_roundtrips_all_fields() {
    let root = temp_root("roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .expect("write ok");
    let row = ledger.load_binding("claude", "sess-a").expect("row exists");
    assert_eq!(row.ledger_version, LEDGER_VERSION);
    assert_eq!(row.provider, "claude");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(row.mode, "claude");
    assert_eq!(row.cwd.as_deref(), Some("/tmp/proj"));
    assert_eq!(row.live_terminal_id.as_deref(), Some("t1"));
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 1_000);
    assert_eq!(row.last_observed_at, 1_000);
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    assert_eq!(row.superseded_by, None);
    assert!(ledger.ever_bound("claude", "sess-a"));
    assert!(!ledger.ever_bound("claude", "sess-other"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rewrite_preserves_created_at_and_bumps_updated_at() {
    let root = temp_root("rewrite");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 5_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 5_000);
    assert_eq!(row.last_observed_at, 5_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn disabled_ledger_is_a_silent_noop() {
    let ledger = PaneLedger::disabled();
    ledger
        .record_binding(&write("claude", "s", "t", 1))
        .expect("noop ok");
    assert_eq!(ledger.load_binding("claude", "s"), None);
    assert!(!ledger.ever_bound("claude", "s"));
    assert!(ledger.list_bindings().is_empty());
}

/// kata 1wxv delta-r1 F4 (disabled-mode honesty, durable-BEFORE-mutation): the
/// ONE write the disabled ledger must REFUSE is the rollback-record row — a
/// false "durable" answer would let providers destructively mutate history with
/// no surviving markers. Every OTHER write keeps its silent no-op policy (the
/// binding/pending identity lanes degrade gracefully).
#[test]
fn disabled_ledger_refuses_the_rollback_row_write_with_a_loud_error() {
    let ledger = PaneLedger::disabled();
    let payload = serde_json::json!({"version": 1, "entries": []});
    let err = ledger
        .record_rollback_row("claude", "sid", &payload, 1)
        .expect_err("a disabled ledger must never report a rollback 'durable' write as Ok");
    assert_eq!(err.kind(), std::io::ErrorKind::Other);
    assert!(
        err.to_string().contains("ledger DISABLED"),
        "the error names the disabled mode: {err}"
    );
    // Nothing was insta-indexed either.
    assert!(
        ledger.load_rollback_row("claude", "sid").is_none(),
        "a refused write lands nowhere"
    );
    // The other lanes keep their existing disabled policy (silent no-op).
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "claude",
            session_id: "sid",
            mode: "freshclaude",
            cwd: None,
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: None,
            now_ms: 1,
        })
        .expect("binding writes keep their silent-no-op policy on a disabled ledger");
    ledger
        .record_pending("ph", "freshclaude", None, 1)
        .expect("pending writes keep their silent-no-op policy on a disabled ledger");
    ledger
        .delete_rollback_row("claude", "sid")
        .expect("a delete of a row that cannot exist stays a no-op");
}

#[test]
fn writes_are_atomic_sibling_temp_plus_rename() {
    // After a successful write no *.tmp-* residue remains, and the row file
    // is a direct child of bindings/<provider>/.
    let root = temp_root("atomic");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .unwrap();
    let provider_dir = root.join("bindings").join("claude");
    let entries: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["sess-a.json".to_string()]);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn key_encoding_is_path_safe_and_injective() {
    assert_eq!(encode_segment("claude"), "claude");
    assert_eq!(
        encode_segment("11111111-2222-3333-4444-555555555555"),
        "11111111-2222-3333-4444-555555555555"
    );
    assert_eq!(encode_segment("a/b"), "a%2Fb");
    assert_eq!(encode_segment("a%b"), "a%25b");
    assert_eq!(encode_segment(".."), "%2E%2E");
    assert_eq!(encode_segment("."), "%2E");
    assert_eq!(encode_segment(""), "%00");
    // Injective: distinct inputs never collide after encoding.
    assert_ne!(encode_segment("a/b"), encode_segment("a%2Fb"));
}

#[test]
fn index_loads_existing_rows_at_construction() {
    // The write-through index is seeded by ONE directory scan in new()
    // (V1.md read policy); a second instance over the same dir answers
    // from its own fresh load — the restart-equivalent shape.
    let root = temp_root("index-reload");
    {
        let gen1 = PaneLedger::new(Some(root.clone()));
        gen1.record_binding(&write("claude", "sess-a", "t1", 1_000))
            .unwrap();
    }
    let gen2 = PaneLedger::new(Some(root.clone()));
    assert!(gen2.ever_bound("claude", "sess-a"));
    assert_eq!(gen2.list_bindings().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn new_locked_degrades_to_disabled_when_another_holder_exists() {
    // Single-writer guard (V2.md): never two writers on one store. The
    // second locked construction logs a loud ERROR and comes up DISABLED;
    // dropping the holder frees the flock (kernel-released on death too).
    //
    // DEFLAKE (f3wp): this test flaked >=4 times under `cargo test
    // --workspace` load (fossils: /tmp/pane-ledger-test-lock-*-13; history:
    // docs/plans/2026-07-26-sidebar-registry-sync.md:1192-1207). Every fossil
    // held a complete durably-written s1.json, so the failure was the THIRD
    // constructor coming up blind -- and the errno that would name the
    // mechanism (EWOULDBLOCK: flock genuinely held, vs ENOSPC/EMFILE:
    // resource pressure, vs a silently-empty load_index) was dropped because
    // this binary installs no tracing subscriber. Per C1's reasoning we do
    // NOT retry-mask; instead every assertion below carries the on-disk and
    // errno evidence needed to diagnose the next occurrence on sight.
    let root = temp_root("lock");
    let holder = PaneLedger::new_locked(Some(root.clone()));
    holder
        .record_binding(&write("claude", "s1", "t1", 1))
        .unwrap();
    let loser = PaneLedger::new_locked(Some(root.clone()));
    loser
        .record_binding(&write("claude", "s2", "t2", 2))
        .expect("disabled no-op");
    assert!(!loser.ever_bound("claude", "s2"), "loser is disabled");
    drop(holder);

    // Evidence probe 1: the on-disk truth the fossils always showed.
    let s1_on_disk = root
        .join("bindings")
        .join("claude")
        .join("s1.json")
        .exists();
    assert!(
        s1_on_disk,
        "holder's s1.json must be durably on disk before the re-acquire"
    );

    // Evidence probe 2: re-acquire through the SAME private code path
    // production uses, so an Err surfaces its errno instead of being
    // swallowed into a DISABLED ledger.
    match PaneLedger::acquire_store_lock(&root) {
        Ok(lock) => drop(lock), // release before constructing `next`
        Err(err) => panic!(
            "acquire_store_lock failed after holder drop: errno={:?} kind={:?} \
             (EWOULDBLOCK => flock genuinely still held after drop; \
             ENOSPC/EMFILE/EACCES => resource pressure, H1)",
            err.raw_os_error(),
            err.kind()
        ),
    }

    let next = PaneLedger::new_locked(Some(root.clone()));
    assert!(
        next.ever_bound("claude", "s1"),
        "third new_locked came up blind despite the lock being acquirable and \
         s1.json on disk ({s1_on_disk}): load_index silently returned empty \
         (H2, pane_ledger.rs:299-321 swallows I/O errors) or a second \
         acquire Err raced in after the probe"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn secondary_index_reads_by_terminal_and_request_id() {
    let root = temp_root("secondary");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-9", "t2", 2_000))
        .unwrap();
    let sref = ledger
        .bound_session_ref_for_terminal("t1")
        .expect("t1 bound");
    assert_eq!(sref.provider, "claude");
    assert_eq!(sref.session_id, "sess-a");
    assert_eq!(ledger.bound_session_ref_for_terminal("t-missing"), None);
    let row = ledger
        .lookup_by_create_request_id("claude", "req-1")
        .expect("by request id");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(
        ledger.lookup_by_create_request_id("claude", "req-none"),
        None
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_retires_old_row() {
    // Red test `rebind-retires-old-row` (spec §4.2 G3): a pane's binding
    // legitimately moves -> the writer retires the old row and writes the
    // new one; the old row records WHERE identity went.
    let root = temp_root("rebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-old", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-new", "t1", 2_000))
        .unwrap();

    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    let by = old.superseded_by.expect("supersededBy set");
    assert_eq!(by.provider, "codex");
    assert_eq!(by.session_id, "th-new");

    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    assert_eq!(new.live_terminal_id.as_deref(), Some("t1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn client_claims_superseded_ref_is_answered_from_the_chain_terminus() {
    // Red test `client-claims-superseded-ref` (ledger-API level; full
    // verdict wiring is Phase 3): a lookup for a superseded ref follows
    // `supersededBy` to the live bound row and reports corrected:true —
    // never returns the retired row as the answer.
    let root = temp_root("chain");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-2", "t1", 2_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-3", "t1", 3_000))
        .unwrap();

    let hit = ledger.lookup_by_session("codex", "th-1").expect("resolves");
    assert!(hit.corrected);
    assert_eq!(hit.row.session_id, "th-3");
    assert_eq!(hit.row.state, RowState::Bound);

    // A direct claim of the live terminus is NOT a correction.
    let direct = ledger.lookup_by_session("codex", "th-3").unwrap();
    assert!(!direct.corrected);

    // A retired row with no successor (e.g. closed) is returned as-is so
    // callers can apply their own reader rule — but never invents a bound.
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn pending_marker_roundtrips_and_reader_rule_prefers_binding() {
    let root = temp_root("pending");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "opencode", Some("/tmp/p"), 1_000)
        .unwrap();
    let marker = ledger.pending_for_terminal("t1").expect("marker readable");
    assert_eq!(marker.terminal_id, "t1");
    assert_eq!(marker.mode, "opencode");
    assert_eq!(marker.cwd.as_deref(), Some("/tmp/p"));
    assert_eq!(marker.spawned_at, 1_000);

    // Reader rule (spec §4.2): "binding row wins; a marker whose terminalId
    // already has a binding row is stale."
    ledger
        .record_binding(&write("opencode", "ses-1", "t1", 2_000))
        .unwrap();
    assert_eq!(ledger.pending_for_terminal("t1"), None);
    // The raw file still exists until the boot sweep (Task 4) removes it.
    assert_eq!(ledger.list_pending_raw().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_writes_binding_first_then_deletes_marker() {
    let root = temp_root("resolve");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "codex", Some("/tmp/p"), 1_000)
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    assert!(ledger.load_binding("codex", "th-1").is_some());
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn resolve_pending_marker_delete_failure_is_not_a_durability_error() {
    // The binding row (the durable identity) was written — a failed marker
    // delete is cleanup residue the boot sweep repairs, NOT a durability
    // failure. resolve_pending must return Ok(()) (logging at WARN), so the
    // caller never raises a false `durability.degraded` alarm.
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("marker-delete-fails");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "codex", Some("/tmp/p"), 1_000)
        .unwrap();
    // Make the pending dir read-only so the marker unlink fails (EACCES).
    let pending_dir = root.join("pending");
    std::fs::set_permissions(&pending_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = ledger.resolve_pending(&write("codex", "th-1", "t1", 2_000));
    // Restore perms before asserting so cleanup always works.
    std::fs::set_permissions(&pending_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    result.expect("binding written durably; marker-delete failure must not propagate");
    // The durable identity IS recorded...
    assert!(ledger.load_binding("codex", "th-1").is_some());
    // ...and the stale marker survives (on disk and in the index) for the
    // boot sweep to repair.
    assert!(pending_dir.join("t1.json").exists());
    assert_eq!(ledger.list_pending_raw().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn pending_resolution_collision_is_idempotent() {
    // Red test `pending-resolution-collision` (spec §4.2 / decision 5): a
    // second racing resolution for the same terminalId finds the marker
    // gone or already-bound and no-ops — one binding row, no error.
    let root = temp_root("collision");
    let ledger = std::sync::Arc::new(PaneLedger::new(Some(root.clone())));
    ledger
        .record_pending("t1", "codex", Some("/tmp/p"), 1_000)
        .unwrap();

    // Sequential double-resolution.
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_001))
        .expect("second resolve no-ops");
    assert_eq!(
        ledger
            .list_bindings()
            .iter()
            .filter(|r| r.session_id == "th-1")
            .count(),
        1
    );

    // Concurrent resolution from two threads (the actual race shape).
    ledger
        .record_pending("t2", "codex", Some("/tmp/p"), 3_000)
        .unwrap();
    let a = std::sync::Arc::clone(&ledger);
    let b = std::sync::Arc::clone(&ledger);
    let ha = std::thread::spawn(move || a.resolve_pending(&write("codex", "th-2", "t2", 3_001)));
    let hb = std::thread::spawn(move || b.resolve_pending(&write("codex", "th-2", "t2", 3_002)));
    ha.join().unwrap().expect("racer A ok");
    hb.join().unwrap().expect("racer B ok");
    assert_eq!(
        ledger
            .list_bindings()
            .iter()
            .filter(|r| r.session_id == "th-2")
            .count(),
        1
    );
    assert!(ledger.pending_for_terminal("t2").is_none());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn sigkill_inside_locator_window_leaves_a_durable_marker() {
    // Red test `SIGKILL-inside-locator-window` (unit shape): a marker
    // written pre-resolution survives "process death" (a second PaneLedger
    // instance over the same dir) so a restarted server can answer
    // "fresh by race, not by intent" instead of silent fresh.
    let root = temp_root("sigkill-window");
    {
        let gen1 = PaneLedger::new(Some(root.clone()));
        gen1.record_pending("t1", "opencode", Some("/tmp/p"), 1_000)
            .unwrap();
        // gen1 "dies" here — dropped without resolving.
    }
    let gen2 = PaneLedger::new(Some(root.clone()));
    let marker = gen2
        .pending_for_terminal("t1")
        .expect("marker survived the crash");
    assert_eq!(marker.mode, "opencode");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_pending_is_a_noop_when_missing() {
    let root = temp_root("del-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .delete_pending("never-existed")
        .expect("missing marker is Ok");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn deleted_binding_row_is_gone_for_recovery_readers() {
    // PIN 2 (Step 4b): a pre-spawn claude binding whose spawn then FAILED is
    // deleted so it can never surface as a ghost `ledgerOnly` recovery offer.
    // `list_bindings` is THE reader that feeds the recovery inventory
    // (`recovery_inventory.rs` build_inventory), so "gone" is judged there.
    let root = temp_root("del-binding");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-failed", "t1", 1_000))
        .expect("write ok");
    assert!(ledger
        .list_bindings()
        .iter()
        .any(|r| r.session_id == "sess-failed"));

    ledger
        .delete_binding("claude", "sess-failed")
        .expect("delete ok");

    // Gone for the recovery-inventory reader, the raw read, AND on disk
    // (a construction-time rescan must not resurrect it).
    assert!(!ledger
        .list_bindings()
        .iter()
        .any(|r| r.session_id == "sess-failed"));
    assert!(ledger.load_binding("claude", "sess-failed").is_none());
    let gen2 = PaneLedger::new(Some(root.clone()));
    assert!(gen2.load_binding("claude", "sess-failed").is_none());

    // Idempotent: deleting a missing row is Ok (mirror of delete_pending).
    ledger
        .delete_binding("claude", "sess-failed")
        .expect("missing row is Ok");
    std::fs::remove_dir_all(&root).ok();
}

fn never_absent(_p: &str, _s: &str) -> bool {
    false
}

#[test]
fn corrupt_ledger_boot_quarantines_per_row_never_per_store() {
    // Red test `corrupt-ledger-boot` (spec §4.2): an unparsable row is
    // renamed aside + logged, never silently dropped, and never causes
    // healthy rows to be skipped.
    let root = temp_root("corrupt");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-good", "t1", 1_000))
        .unwrap();
    let bad = root.join("bindings").join("claude").join("sess-bad.json");
    std::fs::write(&bad, b"{ not json").unwrap();
    // A future-versioned row is also quarantined (ledgerVersion gates
    // migration), never silently reinterpreted.
    let vnext = root.join("bindings").join("claude").join("sess-vnext.json");
    std::fs::write(
        &vnext,
        br#"{"ledgerVersion": 999, "someFutureShape": true}"#,
    )
    .unwrap();

    let report = ledger.boot_scan(2_000, &never_absent);
    assert_eq!(report.quarantined.len(), 2);
    assert!(!bad.exists(), "corrupt row renamed aside");
    assert!(!vnext.exists(), "future-version row renamed aside");
    let provider_dir = root.join("bindings").join("claude");
    let quarantined: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".quarantined-"))
        .collect();
    assert_eq!(quarantined.len(), 2, "renamed aside, not deleted");
    // Healthy rows still served.
    assert!(ledger.load_binding("claude", "sess-good").is_some());
    assert_eq!(ledger.quarantined_rows().len(), 2, "surfaced via API");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn crash_between_binding_write_and_marker_delete_is_repaired_at_boot() {
    // Red test `crash-between-binding-write-and-marker-delete`: both rows
    // present (the safe crash shape the pinned order buys) -> the boot
    // sweep deletes the stale marker; the binding row wins throughout.
    let root = temp_root("crash-window");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "codex", Some("/tmp/p"), 1_000)
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    // (simulates: binding written, crash before marker delete)

    let report = ledger.boot_scan(3_000, &never_absent);
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    assert!(ledger.load_binding("codex", "th-1").is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn boot_scan_never_sweeps_a_marker_merely_because_the_terminal_is_not_live() {
    // Spec §4.2: pending markers are GC'd only for terminals whose clean
    // exit was observed IN THIS PROCESS EPOCH — never swept at boot just
    // because the terminal isn't currently live. That would erase the
    // fresh-by-race breadcrumb at exactly the boot that needs it.
    let root = temp_root("marker-preserved");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "opencode", Some("/tmp/p"), 1_000)
        .unwrap();
    let report = ledger.boot_scan(2_000, &never_absent);
    assert!(report.stale_markers_removed.is_empty());
    assert!(ledger.pending_for_terminal("t1").is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn aged_out_marker_is_swept_after_its_ttl() {
    // A8/V7: a marker can leak (e.g. its pane died with a dead server and
    // the terminal id is never re-minted). Lifetime is BOUNDED: a marker
    // older than PENDING_MARKER_TTL_MS is swept, loudly. Fresh-by-race
    // evidence matters at the boots NEAR the crash — a 30-day-old marker
    // is stale noise, not evidence.
    let root = temp_root("marker-ttl");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "codex", Some("/tmp/p"), 1_000)
        .unwrap();
    let report = ledger.boot_scan(1_000 + PENDING_MARKER_TTL_MS + 1, &never_absent);
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn periodic_gc_sweeps_aged_markers_without_a_restart() {
    // The `gc` contract includes the aged-marker sweep (see the Interfaces
    // note and the PENDING_MARKER_TTL_MS doc): the leaked-marker lifetime
    // bound must hold on a LONG-RUNNING server, so the periodic path — not
    // just boot_scan — must sweep aged markers.
    let root = temp_root("marker-ttl-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending("t1", "codex", Some("/tmp/p"), 1_000)
        .unwrap();
    // A fresh marker survives a GC pass (never swept merely for age < TTL)...
    let report = ledger.gc(2_000, &never_absent, None);
    assert!(report.stale_markers_removed.is_empty());
    assert!(ledger.pending_for_terminal("t1").is_some());
    // ...but an aged-out one is swept by gc() alone — no boot_scan involved.
    let report = ledger.gc(1_000 + PENDING_MARKER_TTL_MS + 1, &never_absent, None);
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn orphaned_pending_marker_is_gced_after_orphan_ttl() {
    // PERIODIC sweep semantics (live_terminal_ids = Some({"live-t"})):
    // marker: terminal "dead-t", spawned_at = now - (ORPHAN_TTL + 1h), no
    // binding row, terminal NOT in the live set -> deleted.
    // marker: terminal "live-t", same age, IS in the live set -> kept.
    // marker: terminal "young-t", spawned_at = now - 60_000, not live ->
    // kept (younger than the orphan TTL).
    let root = temp_root("orphan-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    let now = 2 * PENDING_MARKER_ORPHAN_TTL_MS;
    let orphan_age = now - (PENDING_MARKER_ORPHAN_TTL_MS + 60 * 60 * 1000);
    ledger
        .record_pending("dead-t", "codex", Some("/tmp/p"), orphan_age)
        .unwrap();
    ledger
        .record_pending("live-t", "codex", Some("/tmp/p"), orphan_age)
        .unwrap();
    ledger
        .record_pending("young-t", "codex", Some("/tmp/p"), now - 60_000)
        .unwrap();
    let live: HashSet<String> = HashSet::from(["live-t".to_string()]);

    let report = ledger.gc(now, &never_absent, Some(&live));
    assert_eq!(report.stale_markers_removed, vec!["dead-t".to_string()]);
    let mut remaining: Vec<String> = ledger
        .list_pending_raw()
        .into_iter()
        .map(|m| m.terminal_id)
        .collect();
    remaining.sort();
    assert_eq!(
        remaining,
        vec!["live-t".to_string(), "young-t".to_string()],
        "live marker and young marker are kept; only the dead+old orphan is swept"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn boot_path_never_runs_the_orphan_rule() {
    // BOOT sweep semantics (live_terminal_ids = None -- pre-serve, the
    // registry is empty, main.rs:603-630): a "dead-t"-shaped marker older
    // than ORPHAN_TTL with no binding row -> KEPT (otherwise every old
    // marker would be swept at every boot; only the pre-existing
    // PENDING_MARKER_TTL_MS 30-day rule applies at boot).
    let root = temp_root("orphan-boot");
    let ledger = PaneLedger::new(Some(root.clone()));
    let now = 2 * PENDING_MARKER_ORPHAN_TTL_MS;
    let orphan_age = now - (PENDING_MARKER_ORPHAN_TTL_MS + 60 * 60 * 1000);
    ledger
        .record_pending("dead-t", "codex", Some("/tmp/p"), orphan_age)
        .unwrap();

    let report = ledger.boot_scan(now, &never_absent);
    assert!(report.stale_markers_removed.is_empty());
    let remaining: Vec<String> = ledger
        .list_pending_raw()
        .into_iter()
        .map(|m| m.terminal_id)
        .collect();
    assert_eq!(
        remaining,
        vec!["dead-t".to_string()],
        "boot never sweeps by the orphan rule"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn crash_mid_supersession_two_bound_rows_repaired_by_updated_at_tiebreak() {
    // Red test `crash-mid-supersession-two-bound-rows`: the new bound row
    // was written but the crash landed before the old row was retired ->
    // two bound rows share a pane lineage (liveTerminalId). Boot repair:
    // newer updatedAt wins, older auto-retired as superseded, loudly.
    let root = temp_root("two-bound");
    // Forge the crash shape directly on disk (record_binding would retire
    // the old); the ledger is constructed AFTER, so its construction-time
    // index load sees the forged rows — the actual post-crash boot shape.
    for (sid, at) in [("th-old", 1_000i64), ("th-new", 2_000i64)] {
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: "codex".into(),
            session_id: sid.into(),
            mode: "codex".into(),
            cwd: None,
            live_terminal_id: Some("t1".into()),
            create_request_id: None,
            created_at: at,
            updated_at: at,
            last_observed_at: at,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
            pane_kind: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
        };
        write_row_atomic(
            &root
                .join("bindings")
                .join("codex")
                .join(format!("{sid}.json")),
            &row,
        )
        .unwrap();
    }
    // Constructed AFTER the forged rows, as promised above.
    let ledger = PaneLedger::new(Some(root.clone()));

    let report = ledger.boot_scan(3_000, &never_absent);
    assert_eq!(report.supersession_repairs.len(), 1);
    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    assert_eq!(old.superseded_by.as_ref().unwrap().session_id, "th-new");
    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn gc_expires_unobserved_bound_rows_to_tombstones_never_deletion() {
    let root = temp_root("gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-old", "t1", 1_000))
        .unwrap();
    let now = 1_000 + BOUND_GC_TTL_MS + 1;
    let report = ledger.gc(now, &never_absent, None);
    assert_eq!(report.gc_tombstoned.len(), 1);
    let row = ledger.load_binding("claude", "sess-old").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::GcExpired));
    // NOT deleted — a tombstone.
    assert!(ledger.ever_bound("claude", "sess-old"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn tombstone_deletion_is_conditioned_on_transcript_absence() {
    let root = temp_root("tombstone");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-x", "t1", 1_000))
        .unwrap();
    let expire_at = 1_000 + BOUND_GC_TTL_MS + 1;
    ledger.gc(expire_at, &never_absent, None);
    let delete_at = expire_at + TOMBSTONE_GC_TTL_MS + 1;

    // Transcript still on disk (or unknown) -> tombstone survives forever.
    let report = ledger.gc(delete_at, &never_absent, None);
    assert!(report.tombstones_deleted.is_empty());
    assert!(ledger.ever_bound("claude", "sess-x"));

    // Definitively absent -> deletion is finally allowed.
    let report = ledger.gc(delete_at, &|_p, _s| true, None);
    assert_eq!(report.tombstones_deleted.len(), 1);
    assert!(!ledger.ever_bound("claude", "sess-x"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn gc_expired_tombstone_rebinds_on_a_live_identity_event() {
    // Spec §4.2: `retired/gc_expired -> bound` is a LEGAL transition, taken
    // automatically (never-ask-when-we-can-act) and loudly logged.
    let root = temp_root("revive");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-x", "t1", 1_000))
        .unwrap();
    ledger.gc(1_000 + BOUND_GC_TTL_MS + 1, &never_absent, None);
    assert_eq!(
        ledger
            .load_binding("claude", "sess-x")
            .unwrap()
            .retired_reason,
        Some(RetiredReason::GcExpired)
    );
    let revive_at = 1_000 + BOUND_GC_TTL_MS + 2;
    ledger
        .record_binding(&write("claude", "sess-x", "t2", revive_at))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-x").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_binding_roundtrips_settings_and_pane_kind() {
    let root = temp_root("fresh-agent-roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "thread-1",
            mode: "freshcodex",
            cwd: Some("/home/u/proj"),
            create_request_id: Some("req-1"),
            model: Some("gpt-5.3-codex-spark"),
            sandbox: Some("workspace-write"),
            permission_mode: Some("on-request"),
            effort: Some("high"),
            supersedes: None,
            now_ms: 1_000,
        })
        .unwrap();
    let row = ledger.load_binding("codex", "thread-1").expect("row");
    assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    assert_eq!(row.model.as_deref(), Some("gpt-5.3-codex-spark"));
    assert_eq!(row.sandbox.as_deref(), Some("workspace-write"));
    assert_eq!(row.permission_mode.as_deref(), Some("on-request"));
    assert_eq!(row.effort.as_deref(), Some("high"));
    assert_eq!(row.cwd.as_deref(), Some("/home/u/proj"));
    assert_eq!(row.created_at, 1_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_binding_upsert_preserves_created_at_and_refreshes_settings() {
    let root = temp_root("fresh-agent-upsert");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "opencode",
        session_id: "ses_abc",
        mode: "freshopencode",
        cwd: Some("/w"),
        create_request_id: None,
        model: Some("m1"),
        sandbox: None,
        permission_mode: None,
        effort: Some("low"),
        supersedes: None,
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            model: Some("m2"),
            effort: None,
            now_ms: 2_000,
            ..base
        })
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_abc").expect("row");
    assert_eq!(row.created_at, 1_000, "upsert must preserve created_at");
    assert_eq!(row.updated_at, 2_000);
    assert_eq!(row.model.as_deref(), Some("m2"));
    assert_eq!(
        row.effort, None,
        "settings are a full snapshot, not a merge"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn supersedes_retires_the_old_row_and_links_the_chain() {
    // G3 supersession (V8/A14): codex crash-respawn must retire the OLD
    // thread row and link it to the new one — never leave two Bound rows.
    let root = temp_root("fresh-agent-supersedes");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "codex",
        session_id: "old-thread",
        mode: "freshcodex",
        cwd: Some("/w"),
        create_request_id: None,
        model: Some("m"),
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            session_id: "new-thread",
            supersedes: Some("old-thread"),
            now_ms: 2_000,
            ..base
        })
        .unwrap();
    let old = ledger
        .load_binding("codex", "old-thread")
        .expect("old row kept");
    assert_eq!(
        old.state,
        RowState::Retired,
        "old row retired, never left Bound"
    );
    assert_eq!(
        old.superseded_by.as_ref().map(|l| l.session_id.as_str()),
        Some("new-thread"),
        "supersededBy links old → new"
    );
    let res = ledger
        .lookup_by_session("codex", "old-thread")
        .expect("chain resolves");
    assert!(
        res.corrected,
        "claiming the old id is a corrected resolution"
    );
    assert_eq!(
        res.row.session_id, "new-thread",
        "resolution lands at the terminus"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_upsert_preserves_advisory_create_request_id_when_absent() {
    // create_request_id is advisory, latest-observed (D4): a rewrite that
    // carries None must not erase the previously observed value.
    let root = temp_root("fresh-agent-req-id");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "codex",
        session_id: "thread-1",
        mode: "freshcodex",
        cwd: None,
        create_request_id: Some("req-1"),
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            create_request_id: None,
            now_ms: 2_000,
            ..base
        })
        .unwrap();
    let row = ledger.load_binding("codex", "thread-1").expect("row");
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_settings_recorded_keys_off_settings_bearing_rows() {
    // Task 3's ledger predicate behind the identity sink's `was_recorded`
    // rekeying: a fresh-agent binding row counts as "recorded" only when it
    // carries a SETTINGS-BEARING snapshot — at least one of
    // model/sandbox/permission_mode/effort/cwd set (the exact complement of
    // the fresh-agent sink `load_settings` blank guard). Lineage-only rows
    // (all blank) answer false, so unconditional lineage writes never arm a
    // false SETTINGS_RESET. Schema-compatible: no migration; historical blank
    // rows flip to false (forward-looking tradeoff, accepted).
    let root = temp_root("fresh-agent-settings-recorded");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "opencode",
        session_id: "ses_full",
        mode: "freshopencode",
        cwd: Some("/w"),
        create_request_id: Some("cr-1"),
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        now_ms: 1_000,
    };
    // A cwd-only snapshot counts as settings-bearing (real creates always
    // carry at least cwd).
    ledger.record_fresh_agent_binding(&base).unwrap();
    assert!(ledger.fresh_agent_settings_recorded("opencode", "ses_full"));
    // A lineage-only row (every settings column blank) does NOT count.
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            session_id: "ses_lineage",
            cwd: None,
            ..base
        })
        .unwrap();
    assert!(!ledger.fresh_agent_settings_recorded("opencode", "ses_lineage"));
    // Terminal-pane rows (no pane_kind) never count, even with cwd set.
    ledger
        .record_binding(&write("claude", "sess-t", "t1", 2_000))
        .unwrap();
    assert!(!ledger.fresh_agent_settings_recorded("claude", "sess-t"));
    // Unknown keys answer false.
    assert!(!ledger.fresh_agent_settings_recorded("opencode", "nope"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn supersedes_of_a_missing_old_row_is_a_silent_noop() {
    let root = temp_root("fresh-agent-supersedes-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "new-thread",
            mode: "freshcodex",
            cwd: None,
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: Some("never-existed"),
            now_ms: 1_000,
        })
        .expect("missing old row is a silent no-op, not an error");
    assert!(ledger.load_binding("codex", "never-existed").is_none());
    let row = ledger.load_binding("codex", "new-thread").expect("row");
    assert_eq!(row.state, RowState::Bound);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn old_terminal_rows_without_settings_fields_still_deserialize() {
    // A wave-A row serialized before this change has none of the new fields.
    let json = r#"{"ledgerVersion":1,"provider":"claude","sessionId":"s1","mode":"claude",
        "createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound"}"#;
    let row: BindingRow = serde_json::from_str(json).expect("old row must parse");
    assert_eq!(row.pane_kind, None);
    assert_eq!(row.model, None);
}

#[test]
fn resolve_identity_without_pending_marker_supersedes_prior_binding() {
    // The mid-session rebind path calls resolve_pending with NO pending
    // marker on disk (the pane bound long ago). The binding row must still
    // be written and the previous bound row retired as Superseded with
    // supersededBy -- and the absent marker delete must be a no-op, not an
    // error surfaced to the caller.
    let root = temp_root("resolve-no-marker");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .resolve_pending(&write("codex", "old-id", "t1", 1_000))
        .expect("first bind");
    ledger
        .resolve_pending(&write("codex", "new-id", "t1", 2_000))
        .expect("rebind without marker must succeed");
    let hit = ledger
        .lookup_by_session("codex", "old-id")
        .expect("old row remains, retired");
    assert!(
        hit.corrected,
        "stale claim answered from the chain terminus"
    );
    assert_eq!(hit.row.session_id, "new-id");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_to_the_same_identity_is_not_a_supersession() {
    let root = temp_root("samebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retire_missing_marks_bound_row_session_missing() {
    // Setup: a ledger with a Bound binding for ("amplifier", "stale-sid")
    let root = temp_root("retire-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("amplifier", "stale-sid", "t1", 1_000))
        .unwrap();

    // Act: retire the binding as missing
    let retired = ledger.retire_missing("amplifier", "stale-sid");

    // Assert: retirement succeeded
    assert!(retired);
    let row = ledger.load_binding("amplifier", "stale-sid").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::SessionMissing));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retire_missing_is_noop_without_binding() {
    // Fresh ledger, no rows.
    let root = temp_root("retire-missing-noop");
    let ledger = PaneLedger::new(Some(root.clone()));

    // Act: try to retire a non-existent binding
    let retired = ledger.retire_missing("amplifier", "never-seen");

    // Assert: no-op returns false
    assert!(!retired);
    // Verify no row was created
    assert_eq!(ledger.load_binding("amplifier", "never-seen"), None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retire_missing_does_not_reretire() {
    // Bound row retired once => true; second call => false; reason stays
    // SessionMissing; updated_at from the first retire is not clobbered
    // by the failed second call.
    let root = temp_root("retire-missing-reretire");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("amplifier", "sid", "t1", 1_000))
        .unwrap();

    // First retire should succeed
    let first = ledger.retire_missing("amplifier", "sid");
    assert!(first);
    let row_after_first = ledger.load_binding("amplifier", "sid").unwrap();
    let first_updated_at = row_after_first.updated_at;
    assert_eq!(row_after_first.state, RowState::Retired);
    assert_eq!(
        row_after_first.retired_reason,
        Some(RetiredReason::SessionMissing)
    );

    // Second retire should fail (already retired)
    let second = ledger.retire_missing("amplifier", "sid");
    assert!(!second);
    let row_after_second = ledger.load_binding("amplifier", "sid").unwrap();
    assert_eq!(row_after_second.state, RowState::Retired);
    assert_eq!(
        row_after_second.retired_reason,
        Some(RetiredReason::SessionMissing)
    );
    // Verify updated_at was not clobbered
    assert_eq!(row_after_second.updated_at, first_updated_at);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn session_missing_serde_round_trips() {
    // Test serialization
    let reason = RetiredReason::SessionMissing;
    let json = serde_json::to_string(&reason).expect("serialize");
    assert_eq!(json, r#""session_missing""#);

    // Test deserialization
    let deserialized: RetiredReason = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deserialized, RetiredReason::SessionMissing);
}

/// kata 1wxv Task 4: the claude fork-adoption re-key MOVES the rollback row
/// old→new — copy under the new id lands durably, and the old id's row is gone
/// from BOTH the on-disk file and the write-through index (a surviving stale
/// row would let the superseded id keep describing rollback state it no longer
/// owns).
#[test]
fn rollback_row_rekey_move_drops_the_old_durably() {
    let root = temp_root("rollback-rekey");
    let ledger = PaneLedger::new(Some(root.clone()));
    let payload_a = serde_json::json!({"version": 1, "entries": []});
    ledger
        .record_rollback_row("claude", "old-id", &payload_a, 1)
        .expect("seed write");
    let payload_old = ledger
        .load_rollback_row("claude", "old-id")
        .expect("seeded");
    // The re-key move: copy under the new id, then delete the old.
    ledger
        .record_rollback_row("claude", "new-id", &payload_old, 2)
        .expect("copy");
    ledger
        .delete_rollback_row("claude", "old-id")
        .expect("delete old");
    assert!(
        ledger.load_rollback_row("claude", "old-id").is_none(),
        "the old row is out of the write-through index"
    );
    assert_eq!(
        ledger.load_rollback_row("claude", "new-id"),
        Some(payload_a),
        "the moved row reads identically under the new id"
    );
    // A FRESH ledger over the same root proves the delete is durable (not index-only).
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert!(
        ledger2.load_rollback_row("claude", "old-id").is_none(),
        "the old row's FILE is gone"
    );
    assert!(ledger2.load_rollback_row("claude", "new-id").is_some());
    // A missing row/file is a silent no-op (never an error).
    ledger
        .delete_rollback_row("claude", "never-existed")
        .expect("no-op delete");
    std::fs::remove_dir_all(&root).ok();
}

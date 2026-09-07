//! Unit tests for `crate::codex_locator`. Kept in a sibling file (the
//! `pane_ledger_tests.rs` convention: a `#[path]`-included child module) to
//! respect the repo's <=1K-lines file limit; `use super::*` still reaches
//! the parent's private items (`probe_rollout`, `Probe`).

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Same convention as opencode_locator.rs tests: no tempfile crate.
fn unique_temp_dir(label: &str) -> PathBuf {
    let n = TEST_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "freshell-codex-locator-test-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create test dir");
    dir
}

/// Write a rollout file whose FIRST line is the session_meta identity
/// record, exactly the shape the real codex CLI writes
/// (payload.id = identity; payload.cwd = the session's working dir).
fn write_rollout(root: &Path, rel_dir: &str, thread_id: &str, cwd: Option<&str>) -> PathBuf {
    write_rollout_full(root, rel_dir, thread_id, cwd, None, None)
}

/// Extended writer: same session_meta shape, with optional fork lineage.
/// Modeled on the verified 019fa613 USER-fork child (forked_from_id +
/// thread_source:"user" + originator:"codex-tui") AND its ~100x-more-
/// common evil twin, the SUBAGENT child (thread_source:"subagent" +
/// OBJECT-shaped source {"subagent":{"thread_spawn":…}}). `source` is
/// polymorphic on disk -- string for user sessions, object for
/// subagents -- never parse it with an assumed-string shape.
fn write_rollout_full(
    root: &Path,
    rel_dir: &str,
    thread_id: &str,
    cwd: Option<&str>,
    forked_from: Option<&str>,
    thread_source: Option<&str>,
) -> PathBuf {
    let dir = root.join(rel_dir);
    std::fs::create_dir_all(&dir).expect("create rollout dir");
    let file = dir.join(format!("rollout-2026-07-26T08-00-00-{thread_id}.jsonl"));
    let mut payload = serde_json::json!({ "id": thread_id, "session_id": thread_id });
    if let Some(c) = cwd {
        payload["cwd"] = serde_json::json!(c);
    }
    if let Some(f) = forked_from {
        payload["forked_from_id"] = serde_json::json!(f);
        payload["originator"] = serde_json::json!("codex-tui");
    }
    match thread_source {
        Some("subagent") => {
            payload["thread_source"] = serde_json::json!("subagent");
            payload["source"] = serde_json::json!({
                "subagent": { "thread_spawn": { "parent_thread_id": forked_from, "depth": 1 } }
            });
        }
        Some(ts) => {
            payload["thread_source"] = serde_json::json!(ts);
            payload["source"] = serde_json::json!("cli");
        }
        None => {} // older-CLI shape: no thread_source key at all
    }
    let line = serde_json::json!({
        "timestamp": "2026-07-26T08:00:00.000Z",
        "type": "session_meta",
        "payload": payload,
    });
    std::fs::write(&file, format!("{line}\n")).expect("write rollout");
    file
}

const TID: &str = "11111111-2222-3333-4444-555555555555";

#[test]
fn fresh_rollout_after_first_enter_resolves_via_enter_window() {
    let root = unique_temp_dir("enter-happy");
    let cwd = root.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.to_string_lossy().to_string();
    let locator = CodexLocator::new(root.clone());

    assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
    // No submit yet -> no deadline exists; nothing to evaluate.
    assert!(locator.tick(10_000).is_empty());
    // Enter at 20_000; the rollout appears AFTER the submit (real codex
    // materializes the file only when the first user prompt is recorded).
    assert!(locator.note_submit("t1", 20_000));
    let path = write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));

    // Before the Enter-anchored deadline: nothing yet.
    assert!(locator.tick(20_000 + CODEX_WINDOW_MS - 1).is_empty());
    let located = locator.tick(20_000 + CODEX_WINDOW_MS);
    assert_eq!(
        located,
        vec![Located {
            terminal_id: "t1".into(),
            thread_id: TID.into(),
            rollout_path: path,
            cwd: crate::opencode_locator::normalize_cwd(&cwd_s),
        }]
    );
    // Success fully resolves and disarms; tick() drains.
    assert_eq!(locator.armed_count(), 0);
    assert!(locator.tick(20_000 + CODEX_WINDOW_MS + 1).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rollout_after_arm_without_submit_is_never_bound_and_never_scanned() {
    // A1 (validated): real codex creates the rollout ONLY at the first
    // user prompt, so before Enter every new same-cwd rollout is by
    // construction FOREIGN. With no submit there is NO window: the file
    // must never bind and no deadline scans may run.
    let root = unique_temp_dir("no-submit");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert_eq!(locator.fs_scan_count(), 1); // the arm snapshot
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert!(locator.tick(100 * CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    assert_eq!(locator.fs_scan_count(), 1); // still only the arm snapshot
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rollout_created_between_arm_and_first_enter_never_binds() {
    // A4 hardening (first-submit re-snapshot): Premise 7 guarantees the
    // pane's own rollout cannot exist before its first Enter, so EVERY
    // file that appears between arm and the first submit is foreign by
    // construction (freshagent sidecar, `codex exec`, codex outside
    // freshell in the same cwd). The FIRST note_submit re-snapshots
    // known_files, so a bare Enter (empty composer, trust dialog) can
    // never hand the window to that foreign file as a sole candidate.
    let root = unique_temp_dir("resnapshot");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    // Foreign rollout lands AFTER arm but BEFORE the first Enter.
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    assert!(locator.note_submit("t1", 1_000)); // first submit re-snapshots
    assert_eq!(locator.fs_scan_count(), 2); // arm + first-submit scans
    assert!(locator.tick(1_000 + CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1); // zero candidates → keep watching
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn arm_admission_gates() {
    let root = unique_temp_dir("gates");
    let locator = CodexLocator::new(root.clone());
    // wrong mode
    assert!(!locator.arm("t1", "opencode", true, None, Some("/tmp")));
    // not running
    assert!(!locator.arm("t1", "codex", false, None, Some("/tmp")));
    // resume id present — the ONLY already-bound gate (no restore flag)
    assert!(!locator.arm("t1", "codex", true, Some(TID), Some("/tmp")));
    // missing / empty cwd
    assert!(!locator.arm("t1", "codex", true, None, None));
    assert!(!locator.arm("t1", "codex", true, None, Some("")));
    // happy arm, then idempotent re-arm returns false
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(!locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert_eq!(locator.armed_count(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn disarmed_terminal_never_resolves() {
    let root = unique_temp_dir("disarm");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    locator.disarm("t1");
    assert!(locator.tick(CODEX_WINDOW_MS + 1).is_empty());
    assert_eq!(locator.armed_count(), 0);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn tick_while_unarmed_performs_zero_fs_scans() {
    let root = unique_temp_dir("idle");
    let locator = CodexLocator::new(root.clone());
    // Construction must not scan eagerly either.
    assert_eq!(locator.fs_scan_count(), 0);
    assert!(locator.tick(10_000).is_empty());
    assert_eq!(locator.fs_scan_count(), 0);
    // Arming scans once (the known-files snapshot)…
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert_eq!(locator.fs_scan_count(), 1);
    // …and a tick BEFORE any Enter-anchored deadline is due (here: no
    // submit at all, so no deadline exists) still scans nothing.
    let before = locator.fs_scan_count();
    assert!(locator.tick(1).is_empty());
    assert_eq!(locator.fs_scan_count(), before);
    let _ = std::fs::remove_dir_all(&root);
}

const TID2: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

#[test]
fn rollout_present_at_arm_is_never_a_candidate() {
    let root = unique_temp_dir("snapshot");
    // File exists BEFORE arm — the known-files snapshot must exclude it
    // forever, regardless of any timing.
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 1_000));
    assert!(locator.tick(1_000 + CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1); // zero candidates → keep watching
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn foreign_cwd_rollout_is_never_a_candidate() {
    let root = unique_temp_dir("cwd");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/home/me/project-a")));
    assert!(locator.note_submit("t1", 0));
    write_rollout(&root, "2026/07/26", TID, Some("/home/me/project-b"));
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rollout_without_cwd_field_never_binds() {
    // cwd is REQUIRED (A4 hardening): `SessionMeta.cwd` is non-optional
    // at codex 0.145.0 and 3,858/3,858 + 500/500 real rollouts carry it.
    // A no-cwd first line is a foreign shape — accepting it would be
    // pure attack surface (a location-blind universal candidate).
    let root = unique_temp_dir("no-cwd");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    write_rollout(&root, "2026/07/26", TID, None);
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn two_new_rollouts_in_one_window_refuse_to_bind() {
    let root = unique_temp_dir("ambiguous");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    // Refusal marks the evaluation resolved but stays armed…
    assert_eq!(locator.armed_count(), 1);
    // …and a later Enter re-opens a fresh window (both files are now
    // still absent from known_files, so still ambiguous — proves the
    // refusal is repeatable, never a guess).
    assert!(locator.note_submit("t1", CODEX_WINDOW_MS + 100));
    assert!(locator
        .tick(CODEX_WINDOW_MS + 100 + CODEX_WINDOW_MS)
        .is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn same_rollout_claimed_by_two_armed_terminals_refuses_both() {
    let root = unique_temp_dir("contested");
    let locator = CodexLocator::new(root.clone());
    // Two panes, SAME cwd, armed concurrently, submitting in the same
    // tick; ONE new rollout. The contested-cwd census refuses both
    // (Pass 2's same-tick claim check remains as defense-in-depth).
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.arm("t2", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    assert!(locator.note_submit("t2", 0));
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 2);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn idle_armed_cwd_mate_does_not_starve_a_submitting_pane() {
    // Incident 2026-07-27 (DirectorDeck): three panes armed in one repo,
    // ONE submitted and created its session -- the census refused
    // forever because it counted ARMED panes, not contenders. Only panes
    // with an in-flight Enter window can claim a file; idle armed mates
    // are not contenders.
    let root = unique_temp_dir("census-idle-mate");
    let cwd = root.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.to_string_lossy().to_string();
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
    assert!(locator.arm("t2", "codex", true, None, Some(&cwd_s)));
    assert!(locator.note_submit("t1", 10_000)); // t2 never submits
    let path = write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));
    let located = locator.tick(10_000 + CODEX_WINDOW_MS);
    assert_eq!(
        located.len(),
        1,
        "solo submitter must bind despite an idle armed cwd-mate"
    );
    assert_eq!(located[0].terminal_id, "t1");
    assert_eq!(located[0].rollout_path, path);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn overlapping_windows_same_cwd_still_refuse_then_solo_reenter_binds() {
    // Genuine ambiguity (two in-flight windows, one new file) still
    // refuses -- but refusal is not forever: a later SOLO Enter binds.
    let root = unique_temp_dir("census-overlap");
    let cwd = root.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.to_string_lossy().to_string();
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
    assert!(locator.arm("t2", "codex", true, None, Some(&cwd_s)));
    assert!(locator.note_submit("t1", 10_000));
    assert!(locator.note_submit("t2", 10_500));
    write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));
    assert!(
        locator.tick(10_500 + CODEX_WINDOW_MS).is_empty(),
        "contested: refuse"
    );
    assert_eq!(locator.armed_count(), 2, "refusal never disarms");
    // t2's evaluation resolved; t1 re-enters SOLO -> binds (re-opens
    // never re-snapshot, so the file is still a candidate for t1).
    assert!(locator.note_submit("t1", 20_000));
    let located = locator.tick(20_000 + CODEX_WINDOW_MS);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].terminal_id, "t1");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn windowless_same_cwd_rollout_is_claimed_by_a_later_solo_window() {
    // PINNED ACCEPTED RESIDUAL (A6.1/A6.3) -- not desired behavior, but
    // deliberately visible: t2's submission was coalesced into a
    // text+CR chunk freshell never classified as submit-shaped (e.g. the
    // REST maybe_send_keys "prompt\r" path with codex's paste-burst
    // disabled), so its rollout lands WINDOWLESS. Candidates are a
    // SNAPSHOT DIFFERENCE, not time-bounded (codex_locator.rs:282), so
    // t1's later SOLO window claims t2's file -- a misbind whose sole
    // guard is codex-tui's own submit discipline (see Step 2's census
    // comment). This test keeps the residual from regressing silently
    // into an unpinned assumption.
    let root = unique_temp_dir("census-windowless");
    let cwd = root.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.to_string_lossy().to_string();
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some(&cwd_s)));
    assert!(locator.arm("t2", "codex", true, None, Some(&cwd_s)));
    // t1's first Enter snapshots known_files; its window resolves empty.
    assert!(locator.note_submit("t1", 10_000));
    assert!(locator.tick(10_000 + CODEX_WINDOW_MS).is_empty());
    // t2's windowless rollout appears (owner never opened a window).
    let path = write_rollout(&root, "2026/07/26", TID, Some(&cwd_s));
    // t1 re-enters SOLO: t2 has no in-flight window, so it is not a
    // contender under the new census -- t1 claims t2's file.
    assert!(locator.note_submit("t1", 60_000));
    let located = locator.tick(60_000 + CODEX_WINDOW_MS);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].terminal_id, "t1");
    assert_eq!(located[0].rollout_path, path);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn zero_candidate_window_keeps_watching_and_later_enter_reopens() {
    let root = unique_temp_dir("reopen");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    // Window closes with zero candidates → keep watching (stays armed).
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    // A later Enter re-opens; the rollout appears; resolves via the new
    // Enter-anchored window.
    let enter_at = 10 * CODEX_WINDOW_MS;
    assert!(locator.note_submit("t1", enter_at));
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    let located = locator.tick(enter_at + CODEX_WINDOW_MS);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].thread_id, TID);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn later_enter_reopen_keeps_the_first_submit_snapshot() {
    // Slow materialization (>2 s Enter→creation) is recovered by a later
    // Enter ONLY if re-opens never re-snapshot: the pane's own late
    // rollout appears between the first window's close and the second
    // Enter, and must STAY a candidate. Only the FIRST submit
    // re-snapshots (pinned via fs_scan_count).
    let root = unique_temp_dir("reopen-snapshot");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0)); // first submit: re-snapshot
                                           // First window closes empty.
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    // The pane's own rollout lands LATE — after the window, before the
    // next Enter.
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    let scans_before = locator.fs_scan_count();
    assert!(locator.note_submit("t1", 10_000)); // re-open: NO re-snapshot
    assert_eq!(locator.fs_scan_count(), scans_before);
    let located = locator.tick(10_000 + CODEX_WINDOW_MS);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].thread_id, TID);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn mid_turn_enter_never_reopens_a_pending_evaluation() {
    let root = unique_temp_dir("midturn");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 100));
    // Second Enter while the first evaluation is still pending: no-op.
    assert!(!locator.note_submit("t1", 200));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn non_session_meta_or_malformed_first_line_is_never_a_candidate() {
    // COMPLETE (newline-terminated) garbage lines are `Probe::Never` —
    // not pending: codex writes the whole meta line + '\n' in one
    // write-then-flush, so a complete non-candidate line never becomes
    // one. (Empty/torn lines are the pending case — see the tests below.)
    let root = unique_temp_dir("badmeta");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    let dir = root.join("2026/07/26");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl")),
        format!(
            "{{\"type\":\"event_msg\",\"payload\":{{\"id\":\"{TID}\"}}}}
"
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join(format!("rollout-2026-07-26T08-00-01-{TID2}.jsonl")),
        "not json at all\n",
    )
    .unwrap();
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn empty_first_line_file_is_pending_and_binds_once_meta_lands() {
    // A3 (validated): codex CREATES the rollout file, then awaits
    // git-info collection (subprocesses, 5 s timeout each, worst ~10 s)
    // BEFORE writing the session_meta first line. A deadline scan can
    // observe the empty file — it must be a re-probed PENDING candidate,
    // never dropped by a one-shot read.
    let root = unique_temp_dir("pending");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    let dir = root.join("2026/07/26");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
    std::fs::write(&file, "").unwrap(); // created, meta not yet written
                                        // Deadline scan: pending candidate → bind NOTHING, stay unresolved.
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    // Meta line lands (well within grace); the next sweep binds it.
    // (write_rollout reuses the same filename — same ts, same TID.)
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    let located = locator.tick(CODEX_WINDOW_MS + 300);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].thread_id, TID);
    assert_eq!(locator.armed_count(), 0);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn readable_candidate_never_binds_while_another_new_file_is_pending() {
    // A4 (validated, CRITICAL): the pane's OWN rollout can sit
    // unreadable in the git-info gap while a FOREIGN same-cwd rollout is
    // already readable. Pending candidates are BIND-BLOCKING — the
    // readable file must not win the window.
    let root = unique_temp_dir("pending-block");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    // Pane's own file: created, first line not yet written.
    let dir = root.join("2026/07/26");
    std::fs::create_dir_all(&dir).unwrap();
    let own = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
    std::fs::write(&own, "").unwrap();
    // Foreign file: fully readable, same cwd.
    write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
    // Deadline: NOTHING binds while the pending file exists.
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    assert_eq!(locator.armed_count(), 1);
    // Own meta line lands → TWO candidates → ambiguity refusal (fail
    // toward refusal, never a guess).
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    assert!(locator.tick(CODEX_WINDOW_MS + 300).is_empty());
    assert_eq!(locator.armed_count(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn pending_file_that_never_parses_expires_after_grace() {
    // Grace is bounded (A4 hardening 1): once PENDING_FIRST_LINE_GRACE_MS
    // elapses without a readable first line, the file is permanently
    // excluded and stops blocking; a surviving sole candidate may then
    // bind.
    let root = unique_temp_dir("pending-expiry");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    let dir = root.join("2026/07/26");
    std::fs::create_dir_all(&dir).unwrap();
    let own = dir.join(format!("rollout-2026-07-26T08-00-00-{TID}.jsonl"));
    std::fs::write(&own, "").unwrap(); // never gains a first line
    write_rollout(&root, "2026/07/26", TID2, Some("/tmp"));
    // First due scan sees the pending file (grace clock starts here).
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty());
    // Still blocked just before grace expiry…
    assert!(locator
        .tick(CODEX_WINDOW_MS + PENDING_FIRST_LINE_GRACE_MS - 1)
        .is_empty());
    // …then the never-parsed file expires and the sole survivor binds.
    let located = locator.tick(CODEX_WINDOW_MS + PENDING_FIRST_LINE_GRACE_MS);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].thread_id, TID2);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn missing_sessions_root_is_tolerated_and_resolves_once_it_appears() {
    let base = unique_temp_dir("missing-root");
    let root = base.join("does-not-exist-yet");
    let locator = CodexLocator::new(root.clone());
    // arm() scans the missing root — tolerated, never a panic.
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    assert!(locator.tick(CODEX_WINDOW_MS).is_empty()); // no panic, keep watching
    assert_eq!(locator.armed_count(), 1);
    assert!(locator.note_submit("t1", 2 * CODEX_WINDOW_MS));
    write_rollout(&root, "2026/07/26", TID, Some("/tmp"));
    let located = locator.tick(3 * CODEX_WINDOW_MS);
    assert_eq!(located.len(), 1);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn flat_test_shape_rollout_resolves() {
    // locate_codex_rollout supports flat `<id>.jsonl`; the locator's walk
    // must too (integration fixtures seed this shape).
    let root = unique_temp_dir("flat");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.arm("t1", "codex", true, None, Some("/tmp")));
    assert!(locator.note_submit("t1", 0));
    write_rollout(&root, ".", TID, Some("/tmp"));
    let located = locator.tick(CODEX_WINDOW_MS);
    assert_eq!(located.len(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn probe_surfaces_forked_from_id_and_thread_source() {
    let root = unique_temp_dir("probe-fork");
    let path = write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-parent"),
        Some("user"),
    );
    match probe_rollout(&path) {
        Probe::Candidate {
            forked_from_id,
            thread_source,
            ..
        } => {
            assert_eq!(forked_from_id.as_deref(), Some("aaaa-parent"));
            assert_eq!(thread_source.as_deref(), Some("user"));
        }
        other => panic!("expected Candidate, got {other:?}"),
    }
    // Subagent child: the OBJECT-shaped `source` must not break the
    // probe (polymorphic source, validated A4).
    const SUB: &str = "22222222-2222-3333-4444-555555555555";
    let sub = write_rollout_full(
        &root,
        "2026/07/27",
        SUB,
        Some("/tmp/x"),
        Some("aaaa-parent"),
        Some("subagent"),
    );
    match probe_rollout(&sub) {
        Probe::Candidate {
            forked_from_id,
            thread_source,
            ..
        } => {
            assert_eq!(forked_from_id.as_deref(), Some("aaaa-parent"));
            assert_eq!(thread_source.as_deref(), Some("subagent"));
        }
        other => panic!("expected Candidate, got {other:?}"),
    }
    const PLAIN: &str = "33333333-2222-3333-4444-555555555555";
    let plain = write_rollout_full(&root, "2026/07/27", PLAIN, Some("/tmp/x"), None, None);
    match probe_rollout(&plain) {
        Probe::Candidate {
            forked_from_id,
            thread_source,
            ..
        } => {
            assert_eq!(forked_from_id, None);
            assert_eq!(thread_source, None);
        }
        other => panic!("expected Candidate, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn fork_rollout_with_lineage_rebinds_within_window() {
    let root = unique_temp_dir("fork-happy");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    // No window open: a fork file appearing is NOT scanned/claimed yet.
    let path = write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    assert!(locator.tick_forks(1_000).is_empty());
    // Enter opens the window; the same file is now claimed.
    assert!(locator.note_fork_submit("t1", 2_000));
    let located = locator.tick_forks(2_100);
    assert_eq!(
        located,
        vec![ForkLocated {
            terminal_id: "t1".into(),
            old_session_id: "aaaa-old".into(),
            new_session_id: TID.into(),
            rollout_path: path,
            cwd: Some("/tmp/x".into()),
        }]
    );
    // One-shot per fork: drained.
    assert!(locator.tick_forks(2_200).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn refused_rebind_recovery_rewatch_still_detects_a_later_genuine_fork() {
    // `tick_forks` eagerly advances the watch to the child id BEFORE the
    // ws-layer rebind guards run. When the rebind is REFUSED, the fork
    // drain recovers by re-registering the watch with the OLD id
    // (`watch_fork(t, old)`). This pins that recovery's semantics:
    // (a) a later GENUINE fork of the ORIGINAL session is still
    // detected, and (b) the refused child's rollout (re-snapshotted
    // into known_files) can never re-fire.
    let root = unique_temp_dir("fork-refused-recovery");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    // A fork child of aaaa-old appears whose rebind the ws layer will
    // refuse (e.g. the A13 hijack guard). The locator can't know that:
    // it emits the hit and eagerly advances the watch to the child id.
    const REFUSED: &str = "55555555-2222-3333-4444-555555555555";
    write_rollout_full(
        &root,
        "2026/07/27",
        REFUSED,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    let located = locator.tick_forks(1_100);
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].new_session_id, REFUSED);
    // The refusal recovery: re-register with the OLD id (this also
    // re-snapshots known_files, capturing the refused child's file).
    assert!(locator.watch_fork("t1", "aaaa-old"));
    // A later GENUINE user fork of the ORIGINAL session must still be
    // detected -- without the recovery the watch would be tracking the
    // refused child id and this fork would be silently missed.
    assert!(locator.note_fork_submit("t1", 2_000));
    const GENUINE: &str = "66666666-2222-3333-4444-555555555555";
    let genuine_path = write_rollout_full(
        &root,
        "2026/07/27",
        GENUINE,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    let located = locator.tick_forks(2_100);
    assert_eq!(
        located,
        vec![ForkLocated {
            terminal_id: "t1".into(),
            old_session_id: "aaaa-old".into(),
            new_session_id: GENUINE.into(),
            rollout_path: genuine_path,
            cwd: Some("/tmp/x".into()),
        }],
        "the genuine fork of the ORIGINAL session must be the sole hit \
         (the refused child is in known_files and cannot re-fire)"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn fork_pointing_at_foreign_session_never_matches() {
    let root = unique_temp_dir("fork-foreign");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("zzzz-not-ours"),
        Some("user"),
    );
    assert!(locator.tick_forks(1_100).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn in_window_subagent_child_is_never_a_fork_candidate() {
    // A4 (validated 2026-07-28): subagent forks outnumber user forks
    // ~100:1 on the real substrate (1,148 of 1,160 forked rollouts), and
    // 86/340 codex-tui subagent children were born <=30s after the
    // parent's user input (min 7.0s) -- squarely inside this window.
    // Lineage alone is NOT proof: without the thread_source filter the
    // pane would be rebound onto a subagent thread.
    let root = unique_temp_dir("fork-subagent");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("subagent"),
    );
    assert!(locator.tick_forks(1_100).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn subagent_sibling_does_not_make_a_real_user_fork_ambiguous() {
    // Subagent children are excluded BEFORE the n>=2 ambiguity count: a
    // same-window subagent must not veto the genuine user fork.
    let root = unique_temp_dir("fork-subagent-sibling");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    const SUB: &str = "44444444-2222-3333-4444-555555555555";
    write_rollout_full(
        &root,
        "2026/07/27",
        SUB,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("subagent"),
    );
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    let located = locator.tick_forks(1_100);
    assert_eq!(
        located.len(),
        1,
        "the user fork must be emitted despite the subagent sibling"
    );
    assert_eq!(located[0].new_session_id, TID);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn plain_new_rollout_is_not_a_fork_candidate() {
    let root = unique_temp_dir("fork-plain");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    write_rollout_full(&root, "2026/07/27", TID, Some("/tmp/x"), None, None);
    assert!(locator.tick_forks(1_100).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn expired_window_never_scans_or_claims() {
    let root = unique_temp_dir("fork-expired");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    let scans_before = locator.fs_scan_count();
    assert!(locator
        .tick_forks(1_000 + CODEX_FORK_WINDOW_MS + 1)
        .is_empty());
    assert_eq!(
        locator.fs_scan_count(),
        scans_before,
        "expired window must not walk the fs"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn chained_fork_rebinds_twice() {
    let root = unique_temp_dir("fork-chain");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    let first = locator.tick_forks(1_100);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].new_session_id, TID);
    // Watch auto-advanced to TID: a second fork off TID is claimed next.
    const TID2: &str = "33333333-2222-3333-4444-555555555555";
    assert!(locator.note_fork_submit("t1", 2_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        TID2,
        Some("/tmp/x"),
        Some(TID),
        Some("user"),
    );
    let second = locator.tick_forks(2_100);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].old_session_id, TID);
    assert_eq!(second[0].new_session_id, TID2);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn two_watched_panes_same_cwd_each_claim_their_own_fork() {
    // Lineage is positive proof of ownership -- NO cwd census applies to
    // the fork lane (contrast: the arm/census lane, Task 8).
    let root = unique_temp_dir("fork-two-panes");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.watch_fork("t2", "bbbb-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    assert!(locator.note_fork_submit("t2", 1_000));
    const TID2: &str = "33333333-2222-3333-4444-555555555555";
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    write_rollout_full(
        &root,
        "2026/07/27",
        TID2,
        Some("/tmp/x"),
        Some("bbbb-old"),
        Some("user"),
    );
    let mut located = locator.tick_forks(1_100);
    located.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
    assert_eq!(located.len(), 2);
    assert_eq!(
        (
            located[0].terminal_id.as_str(),
            located[0].new_session_id.as_str()
        ),
        ("t1", TID)
    );
    assert_eq!(
        (
            located[1].terminal_id.as_str(),
            located[1].new_session_id.as_str()
        ),
        ("t2", TID2)
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn disarm_clears_the_fork_watch() {
    let root = unique_temp_dir("fork-disarm");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    locator.disarm("t1");
    assert!(!locator.note_fork_submit("t1", 1_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    assert!(locator.tick_forks(1_100).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn repointed_fork_watch_silences_the_old_lineage() {
    // D-RESUME support pin (kata 3gvd, LB2): the proxy resume arm re-points
    // the disk fork lane at the RESUMED thread via `watch_fork(t, NEW)`,
    // which REPLACES the terminal's one watch (HashMap keyed on terminal_id,
    // doc-pinned overwrite semantics at `watch_fork`). Nothing unit-pinned
    // that the re-pointed watch goes SILENT for the OLD lineage -- an
    // overwrite that append-merged two lineage sets would keep rebinding
    // the pane whenever the retired thread next forked. All ids uuid-shaped
    // (the fork lane's is_uuid_shaped candidate filter).
    const OLD: &str = "aaaaaaaa-1111-2222-3333-444444444444";
    const NEW: &str = "bbbbbbbb-1111-2222-3333-444444444444";
    const OLD_CHILD: &str = "cccccccc-2222-3333-4444-555555555555";
    const OLD_CHILD_2: &str = "dddddddd-2222-3333-4444-555555555555";
    const NEW_CHILD: &str = "eeeeeeee-2222-3333-4444-555555555555";
    let root = unique_temp_dir("fork-repoint");
    let locator = CodexLocator::new(root.clone());

    // Baseline: the OLD lineage fires while watched.
    assert!(locator.watch_fork("t1", OLD));
    assert!(locator.note_fork_submit("t1", 1_000));
    let old_child = write_rollout_full(
        &root,
        "2026/07/27",
        OLD_CHILD,
        Some("/tmp/x"),
        Some(OLD),
        Some("user"),
    );
    let located = locator.tick_forks(1_100);
    assert_eq!(
        located,
        vec![ForkLocated {
            terminal_id: "t1".into(),
            old_session_id: OLD.into(),
            new_session_id: OLD_CHILD.into(),
            rollout_path: old_child,
            cwd: Some("/tmp/x".into()),
        }],
        "the watched OLD lineage fires a fork hit"
    );

    // Re-point at the RESUMED thread; then a fork of the OLD lineage goes
    // silent (its child file is scanned into known_files and never
    // re-fires), while a fork of the NEW lineage hits.
    assert!(locator.watch_fork("t1", NEW));
    assert!(locator.note_fork_submit("t1", 2_000));
    write_rollout_full(
        &root,
        "2026/07/27",
        OLD_CHILD_2,
        Some("/tmp/x"),
        Some(OLD),
        Some("user"),
    );
    assert!(
        locator.tick_forks(2_100).is_empty(),
        "the OLD-lineage watch is gone: no hit for t1"
    );
    let new_child = write_rollout_full(
        &root,
        "2026/07/27",
        NEW_CHILD,
        Some("/tmp/x"),
        Some(NEW),
        Some("user"),
    );
    let located = locator.tick_forks(2_200);
    assert_eq!(
        located,
        vec![ForkLocated {
            terminal_id: "t1".into(),
            old_session_id: NEW.into(),
            new_session_id: NEW_CHILD.into(),
            rollout_path: new_child,
            cwd: Some("/tmp/x".into()),
        }],
        "the re-pointed watch tracks the NEW lineage"
    );
    let _ = std::fs::remove_dir_all(&root);
}

// Warn-once latch tests live in a `#[path]` child (this file sits against
// the 1,000-line cap; same convention as `tabs_persist_validation_tests.rs`).
#[path = "codex_locator_tests_warn.rs"]
mod warn_once;

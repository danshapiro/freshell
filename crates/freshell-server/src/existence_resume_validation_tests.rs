//! Resume-validation feature tests (plan Task 3): amplifier + codex by-id
//! fallbacks on the warm-Absent adjudication path, and cold-index coverage
//! for the cheap amplifier/claude locators. Included as a sibling module of
//! `existence.rs`'s `tests` (file-include pattern precedent:
//! `freshell-sessions/src/amplifier_stub_scan_tests.rs`), reusing that
//! module's `pub(super)` scaffolding helpers.
use super::tests::{direct_locator_over, probe_over, temp_claude_home, write_session};
use super::*;
use crate::existence_by_id::codex_rollout_on_disk;

use freshell_sessions::directory_index::{ClaudeSource, SessionSource};
use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};
use std::time::Duration;

static RV_COUNTER: AtomicU64 = AtomicU64::new(0);

fn rv_temp_dir(tag: &str) -> std::path::PathBuf {
    let n = RV_COUNTER.fetch_add(1, TestOrdering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "freshell-existence-rv-{tag}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir rv temp dir");
    dir
}

/// Amplifier home with `projects/-p/sessions/<id>/` created for each id.
fn amp_home_with_sessions(tag: &str, ids: &[&str]) -> std::path::PathBuf {
    let home = rv_temp_dir(tag);
    for id in ids {
        std::fs::create_dir_all(home.join("projects/-p/sessions").join(id))
            .expect("mkdir amplifier session dir");
    }
    home
}

/// Write a codex rollout owned by `session_id` under the dated tree
/// `<root>/2026/07/29/rollout-2026-07-29T10-00-00-<id>.jsonl` (first line =
/// `session_meta` whose `payload.id` proves ownership). Returns the file path.
fn write_codex_rollout(root: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let dated = root.join("2026/07/29");
    std::fs::create_dir_all(&dated).expect("mkdir codex dated dir");
    let path = dated.join(format!("rollout-2026-07-29T10-00-00-{session_id}.jsonl"));
    std::fs::write(
        &path,
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\"}}}}\n"),
    )
    .expect("write codex rollout");
    path
}

/// Permission tests are meaningless as root (root ignores mode bits) —
/// e.g. sandboxed/container suites. Skip (return early) when euid == 0.
#[cfg(unix)]
fn running_as_root() -> bool {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

/// Probe over a claude-source index at `index_home` (like `probe_over`) but
/// with caller-chosen provider roots — the cold-index tests need per-provider
/// roots that exist so the ProviderUnavailable pre-check does not fire.
fn probe_with_roots(
    index_home: &std::path::Path,
    roots: HashMap<String, PathBuf>,
) -> (IndexExistenceProbe, Arc<SessionIndex>) {
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(ClaudeSource::new(index_home.to_path_buf())) as Arc<dyn SessionSource>],
        Duration::from_millis(50),
        None,
    ));
    (
        IndexExistenceProbe::new(Arc::clone(&index), None, roots),
        index,
    )
}

/// Warm snapshot says Absent, but the session dir exists on disk (created
/// after the snapshot). By-id fallback must answer Present.
#[tokio::test]
async fn amplifier_absent_snapshot_rescued_by_dir_locator() {
    let home = temp_claude_home("amp-rescue");
    let amp_home = amp_home_with_sessions("amp-rescue-home", &["amp-new"]);
    let (probe, index) = probe_over(&home);
    let probe = probe.with_amplifier_session_locator(amplifier_dir_locator(amp_home.clone()));
    index.warm().await;
    assert_eq!(
        probe.exists("amplifier", "amp-new"),
        SessionExistence::Present,
        "the session dir exists on disk — a stale warm snapshot must never \
         adjudicate a real session absent"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&amp_home);
}

/// Warm snapshot Absent + locator scans a readable store without the id.
#[tokio::test]
async fn amplifier_definitively_absent_stays_absent() {
    let home = temp_claude_home("amp-absent");
    let amp_home = amp_home_with_sessions("amp-absent-home", &["amp-other"]);
    let (probe, index) = probe_over(&home);
    let probe = probe.with_amplifier_session_locator(amplifier_dir_locator(amp_home.clone()));
    index.warm().await;
    assert_eq!(
        probe.exists("amplifier", "amp-gone"),
        SessionExistence::Absent,
        "store readable, session definitively absent => positive Absent"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&amp_home);
}

/// Locator returns Unreadable (e.g. permissions) => the honest
/// post-readiness `Unreadable` (kata vnpc Task 4: reconcile surfaces
/// error{session_store_unreadable}), never a false Absent.
#[tokio::test]
async fn amplifier_unreadable_store_answers_unreadable() {
    let home = temp_claude_home("amp-unreadable");
    let (probe, index) = probe_over(&home);
    let probe = probe.with_amplifier_session_locator(Arc::new(|_sid: &str| ByIdAnswer::Unreadable));
    index.warm().await;
    assert_eq!(
        probe.exists("amplifier", "amp-x"),
        SessionExistence::Unreadable,
        "read failure is the honest unreadable-store error — never Absent"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// No locator chained (default) => today's behavior byte-for-byte.
#[tokio::test]
async fn amplifier_without_locator_keeps_snapshot_answer() {
    let home = temp_claude_home("amp-nolocator");
    let (probe, index) = probe_over(&home);
    index.warm().await;
    assert_eq!(
        probe.exists("amplifier", "amp-anything"),
        SessionExistence::Absent,
        "without a locator the pure warm-index answer stands"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// Same shape as the amplifier rescue test, with a temp codex sessions root
/// containing `sessions/2026/07/29/rollout-...-<id>.jsonl`.
#[tokio::test]
async fn codex_absent_snapshot_rescued_by_rollout_locator() {
    let home = temp_claude_home("codex-rescue");
    let root = rv_temp_dir("codex-rescue-root");
    let session_id = "c0dec0de-1111-4222-8333-444455556666";
    write_codex_rollout(&root, session_id);
    let (probe, index) = probe_over(&home);
    let probe = probe.with_codex_rollout_locator(codex_rollout_existence_locator(root.clone()));
    index.warm().await;
    assert_eq!(
        probe.exists_for_gate("codex", session_id),
        SessionExistence::Present,
        "the rollout exists on disk (the resume arm would find it) — a stale \
         warm snapshot must never adjudicate it absent"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&root);
}

/// Pins the exists()/exists_for_gate split (reconcile blocking-IO fix):
/// plain `exists()` is consulted inline on the sync reconcile path (~250ms
/// IO budget), so it must answer a warm-snapshot Absent for codex WITHOUT
/// running the ~1s rollout walk; `exists_for_gate()` (spawn doors, wrapped
/// in spawn_blocking per A13) runs the walk on the SAME probe and rescues
/// the stale warm-Absent.
#[tokio::test]
async fn reconcile_exists_never_runs_codex_walk_gate_variant_does() {
    use std::sync::atomic::AtomicBool;
    let home = temp_claude_home("codex-gate-split");
    let (probe, index) = probe_over(&home);
    let walked = Arc::new(AtomicBool::new(false));
    let walked_in = Arc::clone(&walked);
    let probe = probe.with_codex_rollout_locator(Arc::new(move |_sid: &str| {
        walked_in.store(true, TestOrdering::SeqCst);
        ByIdAnswer::Present
    }));
    index.warm().await;
    assert_eq!(
        probe.exists("codex", "thread-gate-split"),
        SessionExistence::Absent,
        "plain exists() answers the snapshot Absent WITHOUT the ~1s walk \
         (reconcile-path IO budget)"
    );
    assert!(
        !walked.load(TestOrdering::SeqCst),
        "the codex rollout walk must never run from exists() (reconcile path)"
    );
    assert_eq!(
        probe.exists_for_gate("codex", "thread-gate-split"),
        SessionExistence::Present,
        "the gate variant runs the walk and rescues the stale warm-Absent"
    );
    assert!(
        walked.load(TestOrdering::SeqCst),
        "exists_for_gate must consult the codex rollout locator on warm-Absent"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// sessions root NotFound => Absent (AD-1: fresh install, parent readable);
/// locator returning Unreadable => probe answers Unknown. Root readability
/// is established via read_dir inside `codex_rollout_on_disk`, not
/// fs::metadata — metadata tests existence, not readability (V3 E3).
#[tokio::test]
async fn codex_missing_sessions_root_is_absent_and_unreadable_is_unknown() {
    let home = temp_claude_home("codex-missing-root");
    let parent = rv_temp_dir("codex-missing-root-parent");
    let missing_root = parent.join("sessions"); // never created
    let (probe, index) = probe_over(&home);
    let probe =
        probe.with_codex_rollout_locator(codex_rollout_existence_locator(missing_root.clone()));
    index.warm().await;
    assert_eq!(
        probe.exists_for_gate("codex", "thread-1"),
        SessionExistence::Absent,
        "missing sessions root with readable parent is positive absence (AD-1)"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&parent);

    let home2 = temp_claude_home("codex-unreadable");
    let (probe2, index2) = probe_over(&home2);
    let probe2 = probe2.with_codex_rollout_locator(Arc::new(|_sid: &str| ByIdAnswer::Unreadable));
    index2.warm().await;
    assert_eq!(
        probe2.exists_for_gate("codex", "thread-2"),
        SessionExistence::Unknown,
        "an unreadable store is honest Unknown — fail open, never Absent"
    );
    let _ = std::fs::remove_dir_all(&home2);
}

/// Future codex rollout compression (V2): a `rollout-...-<id>.jsonl.zst`
/// candidate MUST pass the filename prefilter; its first line is not plain
/// JSONL, so the ownership read fails => counts as an error => Unreadable
/// (the probe answers Unknown — fail open, never Absent for a
/// CLI-resumable file).
#[test]
fn codex_zst_rollout_is_candidate_but_undecodable_answers_unreadable() {
    let root = rv_temp_dir("codex-zst");
    let session_id = "c0dec0de-2222-4222-8333-444455556666";
    let dated = root.join("2026/07/29");
    std::fs::create_dir_all(&dated).expect("mkdir codex dated dir");
    // zstd magic bytes + arbitrary binary — not decodable as JSONL.
    let mut bytes = vec![0x28u8, 0xB5, 0x2F, 0xFD];
    bytes.extend_from_slice(&[0x00, 0xFF, 0x13, 0x37]);
    std::fs::write(
        dated.join(format!(
            "rollout-2026-07-29T10-00-00-{session_id}.jsonl.zst"
        )),
        bytes,
    )
    .expect("write zst candidate");
    assert_eq!(
        codex_rollout_on_disk(&root, session_id),
        ByIdAnswer::Unreadable,
        "an undecodable candidate is an ERROR, never 'not the owner'"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// V3 case E4: the rollout lives under `sessions/2026/07/29/` chmod 000 —
/// the per-entry read_dir error must be accumulated (no silent skip).
#[cfg(unix)]
#[test]
fn codex_unreadable_date_subdir_answers_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    if running_as_root() {
        return; // root ignores mode bits — test is meaningless
    }
    let root = rv_temp_dir("codex-locked-subdir");
    let session_id = "c0dec0de-3333-4222-8333-444455556666";
    write_codex_rollout(&root, session_id);
    let locked = root.join("2026/07/29");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let answer = codex_rollout_on_disk(&root, session_id);
    // Restore perms before asserting so cleanup works even on failure.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        answer,
        ByIdAnswer::Unreadable,
        "an unreadable subtree may hide the rollout — never Absent"
    );

    // And through the probe: warm-Absent + Unreadable walk => Unknown.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let home = temp_claude_home("codex-locked-probe");
    let (probe, index) = probe_over(&home);
    let probe = probe.with_codex_rollout_locator(codex_rollout_existence_locator(root.clone()));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(index.warm());
    let probe_answer = probe.exists_for_gate("codex", session_id);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(probe_answer, SessionExistence::Unknown);
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&root);
}

/// V3 case E7: the owning rollout file itself is chmod 000 — the first-line
/// ownership read fails => error => Unreadable, never Absent.
#[cfg(unix)]
#[test]
fn codex_unreadable_candidate_file_answers_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    if running_as_root() {
        return; // root ignores mode bits — test is meaningless
    }
    let root = rv_temp_dir("codex-locked-file");
    let session_id = "c0dec0de-4444-4222-8333-444455556666";
    let file = write_codex_rollout(&root, session_id);
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    let answer = codex_rollout_on_disk(&root, session_id);
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        answer,
        ByIdAnswer::Unreadable,
        "an unreadable candidate file is an ERROR, never 'not the owner'"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Cold index (peek() == None, the every-boot state) + amplifier root
/// present + locator chained: the cheap by-id locator answers instead of
/// Unknown. This is the incident scenario: a restore-time create racing the
/// detached boot sweep. Plain #[test] (no tokio runtime) so kick_refresh
/// no-ops and the index deterministically stays cold.
#[test]
fn cold_index_amplifier_uses_dir_locator() {
    // (a) session dir on disk => Present.
    let index_home = temp_claude_home("cold-amp-present");
    let amp_home = amp_home_with_sessions("cold-amp-present-home", &["amp-cold"]);
    let (probe, _index) = probe_with_roots(
        &index_home,
        HashMap::from([("amplifier".to_string(), amp_home.clone())]),
    );
    let probe = probe.with_amplifier_session_locator(amplifier_dir_locator(amp_home.clone()));
    assert_eq!(
        probe.exists("amplifier", "amp-cold"),
        SessionExistence::Present,
        "cold index + dir on disk => Present (the incident scenario)"
    );
    let _ = std::fs::remove_dir_all(&index_home);
    let _ = std::fs::remove_dir_all(&amp_home);

    // (b) readable-empty store => Absent.
    let index_home = temp_claude_home("cold-amp-absent");
    let amp_home = rv_temp_dir("cold-amp-absent-home");
    let (probe, _index) = probe_with_roots(
        &index_home,
        HashMap::from([("amplifier".to_string(), amp_home.clone())]),
    );
    let probe = probe.with_amplifier_session_locator(amplifier_dir_locator(amp_home.clone()));
    assert_eq!(
        probe.exists("amplifier", "amp-cold"),
        SessionExistence::Absent,
        "cold index + readable-empty store => positive Absent"
    );
    let _ = std::fs::remove_dir_all(&index_home);
    let _ = std::fs::remove_dir_all(&amp_home);

    // (c) locator Unreadable => Unknown.
    let index_home = temp_claude_home("cold-amp-unreadable");
    let amp_home = rv_temp_dir("cold-amp-unreadable-home");
    let (probe, _index) = probe_with_roots(
        &index_home,
        HashMap::from([("amplifier".to_string(), amp_home.clone())]),
    );
    let probe = probe.with_amplifier_session_locator(Arc::new(|_sid: &str| ByIdAnswer::Unreadable));
    assert_eq!(
        probe.exists("amplifier", "amp-cold"),
        SessionExistence::Unknown
    );
    let _ = std::fs::remove_dir_all(&index_home);
    let _ = std::fs::remove_dir_all(&amp_home);
}

/// Same shape via the EXISTING claude transcript locator: cold index +
/// transcript file on disk => Present; readable store without it => Absent
/// (the gate still Proceeds unless ever_observed_on_disk — Task 1).
#[test]
fn cold_index_claude_uses_transcript_locator() {
    let home = temp_claude_home("cold-claude");
    let session_id = "4d5e6f70-8192-4aa3-8b4c-5d6e7f809101";
    write_session(&home, session_id);
    let (probe, _index) = probe_over(&home);
    let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
    assert_eq!(
        probe.exists("claude", session_id),
        SessionExistence::Present,
        "cold index + transcript on disk => Present via the cheap raw-file check"
    );
    assert_eq!(
        probe.exists("claude", "5e6f7081-92a3-4bb4-8c5d-6e7f80910212"),
        SessionExistence::Absent,
        "cold index + readable store without the transcript => positive Absent"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// Cold index + locators chained: codex must NOT run its by-id lookup when
/// cold (AD-4 — the walk is ~1 s on a real store; no cold codex locator was
/// added). opencode RESOLVES by id when cold (kata vnpc Task 4: the cheap
/// SQLite locator is the warm-miss arm's own check, safe pre-readiness).
/// The root-missing => ProviderUnavailable pre-check stays byte-for-byte
/// today's behavior.
#[test]
fn cold_index_codex_stays_unknown_opencode_resolves_by_id() {
    let index_home = temp_claude_home("cold-codex-opencode");
    let codex_root = rv_temp_dir("cold-codex-root");
    let opencode_root = rv_temp_dir("cold-opencode-root");
    let (probe, _index) = probe_with_roots(
        &index_home,
        HashMap::from([
            ("codex".to_string(), codex_root.clone()),
            ("opencode".to_string(), opencode_root.clone()),
        ]),
    );
    // Both locators would answer Present if (wrongly) consulted.
    let probe = probe
        .with_codex_rollout_locator(Arc::new(|_sid: &str| ByIdAnswer::Present))
        .with_opencode_session_locator(Arc::new(|_sid: &str| OpencodeDbAnswer::Present));
    assert_eq!(
        probe.exists("codex", "thread-cold"),
        SessionExistence::Unknown,
        "cold codex stays Unknown — the ~1s walk must not run on early-boot creates (AD-4)"
    );
    assert_eq!(
        probe.exists("opencode", "ses_cold00000000000000000000000"),
        SessionExistence::Present,
        "cold opencode resolves by id without waiting for the scan (kata vnpc Task 4)"
    );

    // Root-missing pre-check untouched: even with a locator chained, a
    // missing provider root still answers ProviderUnavailable.
    let gone = codex_root.join("never-created");
    let (probe2, _index2) =
        probe_with_roots(&index_home, HashMap::from([("codex".to_string(), gone)]));
    let probe2 = probe2.with_codex_rollout_locator(Arc::new(|_sid: &str| ByIdAnswer::Present));
    assert_eq!(
        probe2.exists("codex", "thread-cold"),
        SessionExistence::ProviderUnavailable
    );
    let _ = std::fs::remove_dir_all(&index_home);
    let _ = std::fs::remove_dir_all(&codex_root);
    let _ = std::fs::remove_dir_all(&opencode_root);
}

// ── Antigravity by-id locator (plan Task 7) ─────────────────────────────────
//
// The index's `AntigravitySource` drops every transcript whose
// ownership/workspace parse yields no row (antigravity.rs module doc —
// unreadable file, no ownership record, no usable workspace path), so a
// conversation dir on disk can be index-invisible while the attach arm
// (`agy --conversation <id>`) would still resume it. The by-id locator is
// the attach-parity arm: before finalizing a warm-Absent for antigravity,
// re-check the SAME canonical transcript path the CLI resolves.

/// Antigravity home with `brain/<id>/.system_generated/logs/transcript.jsonl`
/// seeded for each id (locator-relevant bytes only — the by-id check needs
/// existence + readability, not parseable content).
fn agy_home_with_conversations(tag: &str, ids: &[&str]) -> std::path::PathBuf {
    let home = rv_temp_dir(tag);
    for id in ids {
        let logs = home
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&logs).expect("mkdir antigravity brain");
        std::fs::write(logs.join("transcript.jsonl"), "{\"v\":1}\n")
            .expect("write antigravity transcript");
    }
    home
}

/// Warm snapshot says Absent, but the conversation's transcript exists on
/// disk (created after the snapshot, or parse-dropped from the index). The
/// by-id fallback must answer Present — a stale warm snapshot must never
/// adjudicate a real conversation absent.
#[tokio::test]
async fn antigravity_absent_snapshot_rescued_by_transcript_locator() {
    let home = temp_claude_home("agy-rescue");
    let conv = "11111111-2222-3333-4444-555555555555";
    let agy_home = agy_home_with_conversations("agy-rescue-home", &[conv]);
    let (probe, index) = probe_over(&home);
    let probe =
        probe.with_antigravity_transcript_locator(antigravity_transcript_locator(agy_home.clone()));
    index.warm().await;
    assert_eq!(
        probe.exists("antigravity", conv),
        SessionExistence::Present,
        "the conversation transcript exists on disk (the attach arm would resume it) — \
         a stale warm snapshot must never adjudicate it absent"
    );
    assert!(
        probe.ever_observed_on_disk("antigravity", conv),
        "a fallback hit is an on-disk observation and must feed ever_observed_on_disk"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&agy_home);
}

/// Warm snapshot Absent + a readable store without the id ⇒ positive
/// Absent (both index and walk agree) — the fallback must never weaken
/// positive denial.
#[tokio::test]
async fn antigravity_definitively_absent_stays_absent() {
    let home = temp_claude_home("agy-absent");
    let agy_home =
        agy_home_with_conversations("agy-absent-home", &["11111111-2222-3333-4444-555555555556"]);
    let (probe, index) = probe_over(&home);
    let probe =
        probe.with_antigravity_transcript_locator(antigravity_transcript_locator(agy_home.clone()));
    index.warm().await;
    assert_eq!(
        probe.exists("antigravity", "00000000-1111-2222-3333-444444444444"),
        SessionExistence::Absent,
        "store readable, conversation definitively absent => positive Absent"
    );
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&agy_home);
}

/// An unreadable transcript (the corruption/permission class) answers
/// the honest post-readiness `Unreadable` (kata vnpc Task 4: reconcile
/// surfaces error{session_store_unreadable}) — never a finalized Absent
/// that could adjudicate a live conversation dead.
#[tokio::test]
async fn antigravity_unreadable_store_answers_unreadable() {
    let home = temp_claude_home("agy-unreadable");
    let (probe, index) = probe_over(&home);
    let probe = probe.with_antigravity_transcript_locator(Arc::new(|_sid: &str| {
        crate::existence_by_id::ByIdAnswer::Unreadable
    }));
    index.warm().await;
    assert_eq!(
        probe.exists("antigravity", "agy-x"),
        SessionExistence::Unreadable,
        "read failure is the honest unreadable-store error — never Absent"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// Provider gating pin: the fallback is ANTIGRAVITY-scoped — a claude
/// Absent must stay Absent even when the antigravity locator would answer
/// Present for any id.
#[tokio::test]
async fn claude_absent_never_consults_the_antigravity_locator() {
    let home = temp_claude_home("claude-agy-gate");
    let (probe, index) = probe_over(&home);
    let probe =
        probe.with_antigravity_transcript_locator(Arc::new(|_sid: &str| ByIdAnswer::Present));
    index.warm().await;
    assert_eq!(
        probe.exists("claude", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
        SessionExistence::Absent,
        "the by-id transcript fallback is provider-gated to antigravity only"
    );
    let _ = std::fs::remove_dir_all(&home);
}

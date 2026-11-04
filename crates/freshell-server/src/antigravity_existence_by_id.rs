//! By-id antigravity transcript locator (plan Task 7,
//! docs/plans/2026-10-29-google-cli-first-class-support.md): the
//! deterministic disk check behind [`crate::existence::IndexExistenceProbe`]'s
//! warm-Absent adjudication for provider `antigravity`.
//!
//! Attach-parity rationale (the kata 09v1 pattern — the probe must agree
//! with the ATTACH ARM): antigravity's attach arm is
//! `agy --conversation <id>`, which resolves the canonical
//! `brain/<id>/.system_generated/logs/transcript.jsonl` regardless of index
//! state, while the index's [`freshell_sessions::antigravity::AntigravitySource`]
//! drops every transcript whose ownership/workspace parse yields no row
//! (no ownership record, no usable workspace path, unreadable file). A
//! conversation dir on disk can therefore be index-invisible yet perfectly
//! resumable — a stale or parse-gap warm snapshot must never adjudicate it
//! absent.
//!
//! Gate activation (resume-gate flip, Task 3 of
//! docs/plans/2026-11-02-antigravity-transcript-validation.md): the
//! conversation-resume gate is ACTIVE for antigravity (activated
//! 2026-11-03 on real-binary transcript evidence (2026-11-02) + a
//! proven settings-conformant real resume (2026-11-03; Provider
//! Contract Record rows 74/75/76; evidence:
//! real-binary-transcript-evidence.md) — antigravity joined
//! `freshell_platform::resume_gate::VALIDATED_PROVIDERS`, so the spawn
//! doors consult this locator through the gate: `exists_for_gate`
//! validates BOTH a warm-index Present and a cold-index Unknown against
//! this same on-disk by-id walk before the gate trusts them (GC3's
//! no-silent-replacement rule — the CLI's documented missing-ID
//! behavior silently starts a fresh conversation). The locator's
//! pane-reconcile role (the warm-Absent attach-parity arm in
//! `existence.rs`) is unchanged.
//!
//! UNION ROOTS (focused repair round 2, Major 1): the seam
//! (`freshell_sessions::provider_layout::antigravity_home`) resolves ONE
//! root (env override > default root when it holds conversations > snap
//! root), but the binary's WRITE root is not necessarily the seam's read
//! root — the snap binary pins its store under `$HOME/snap` while the
//! default root can also hold conversations. A single-root locator
//! therefore answers false Absent for a valid conversation in the
//! UNSELECTED root, and the gate turns that into a false SESSION_MISSING
//! refusal. The locator this module hands the probe now walks EVERY
//! candidate root (see [`antigravity_store_root_candidates`]) and answers:
//! found in ANY root ⇒ `Present`; absent from ALL ⇒ `Absent`; absent
//! everywhere but unreadable somewhere ⇒ `Unreadable` (fail-open, G28).
//! History/search keep the seam's single-root selection — a separate,
//! older design, out of scope here.
//!
//! Tri-state contract (mirrors [`crate::existence_by_id::ByIdAnswer`]):
//! * transcript exists + readable ⇒ `Present`;
//! * missing conversation dir (or any missing path component — the CLI
//!   never ran here) ⇒ `Absent`;
//! * unreadable (EACCES on the tree, corruption, io error) ⇒ `Unreadable`
//!   — the probe maps it to `Unknown`, NEVER `Absent`.
//!
//! New focused file (the `existence_by_id.rs` layout), re-exported through
//! `existence.rs` so the probe's locator surface stays `existence::*`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::existence_by_id::ByIdAnswer;

/// Injected by-id antigravity transcript check (the
/// [`crate::existence_by_id::AmplifierSessionLocator`] pattern). A closure
/// (not a direct call) keeps the probe unit-testable without touching
/// process-global `FRESHELL_ANTIGRAVITY_HOME`; the production wiring in
/// `main.rs` resolves the home ONCE and bakes it into the closure.
pub type AntigravityTranscriptLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>;

/// The canonical transcript path for `session_id` under the (already
/// resolved) antigravity home, or `None` when the id can never name a
/// conversation directory: a conversation dir name cannot contain a path
/// separator or NUL, and neither `.` nor `..` names one — joining such an
/// id would walk OUT of the brain tree and probe a foreign path, so it is
/// treated as definitively absent instead. `pub(crate)` so the existence
/// gate tests seed and delete the exact canonical path the locator probes
/// (single source of truth).
pub(crate) fn conversation_transcript_path(home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\0')
        || session_id == "."
        || session_id == ".."
    {
        return None;
    }
    Some(
        home.join("brain")
            .join(session_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl"),
    )
}

/// Deterministic by-id existence check: does
/// `brain/<id>/.system_generated/logs/transcript.jsonl` exist and open for
/// reading? `File::open` with read intent IS the readability proof —
/// `fs::metadata` is not (it tests existence, not permissions, and would
/// answer Present for a chmod-000 transcript the CLI could not read). A
/// missing path component collapses to `NotFound` ⇒ `Absent` (the store
/// tree exists; the conversation does not); any other open error
/// (permissions, io, corruption) ⇒ `Unreadable`.
pub fn antigravity_transcript_on_disk(antigravity_home: &Path, session_id: &str) -> ByIdAnswer {
    let Some(path) = conversation_transcript_path(antigravity_home, session_id) else {
        return ByIdAnswer::Absent;
    };
    match std::fs::File::open(&path) {
        Ok(_file) => ByIdAnswer::Present,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => ByIdAnswer::Absent,
        Err(_) => ByIdAnswer::Unreadable,
    }
}

/// Single-root locator: wraps [`antigravity_transcript_on_disk`] over one
/// resolved antigravity home — the per-root core's thin constructor. The
/// PRODUCTION wiring is the UNION locator
/// ([`antigravity_union_root_locator`], focused repair round 2, Major 1);
/// this single-root shape remains for the existence/gate tests that mirror
/// a one-store-root wiring over an already-resolved home (and any caller
/// that genuinely wants exactly one root probed).
#[cfg(test)]
pub fn antigravity_transcript_locator(antigravity_home: PathBuf) -> AntigravityTranscriptLocator {
    Arc::new(move |session_id: &str| antigravity_transcript_on_disk(&antigravity_home, session_id))
}

/// The candidate antigravity store roots on this machine (focused repair
/// round 2, Major 1) — the SAME candidate list the real-provider smoke
/// scans (`agyStoreRootCandidates`,
/// test/integration/real/antigravity-launch-smoke.test.ts):
/// the `FRESHELL_ANTIGRAVITY_HOME` override (when set and non-empty),
/// the default root `<home>/.gemini/antigravity-cli`, and the snap
/// install's root `<home>/snap/antigravity-cli/common/.gemini/antigravity-cli`
/// — deduplicated, order-preserving. The snap path shape mirrors
/// provider_layout.rs's private `snap_antigravity_root` (snap confinement
/// pins the CLI's HOME to `<home>/snap/antigravity-cli/common`, so the
/// CLI writes its usual relative store under it) — provider_layout itself
/// is out of scope for this fix. `env_override` is PASSED IN, not read
/// here, so tests never mutate process-global env; the production
/// constructor [`antigravity_union_root_locator`] reads the variable once
/// at wiring time.
pub fn antigravity_store_root_candidates(
    user_home: &Path,
    env_override: Option<&str>,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(v) = env_override.filter(|v| !v.is_empty()) {
        let root = PathBuf::from(v);
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    let default_root = user_home.join(".gemini").join("antigravity-cli");
    if !roots.contains(&default_root) {
        roots.push(default_root);
    }
    let snap_root = user_home
        .join("snap")
        .join("antigravity-cli")
        .join("common")
        .join(".gemini")
        .join("antigravity-cli");
    if !roots.contains(&snap_root) {
        roots.push(snap_root);
    }
    roots
}

/// Union-root by-id check (focused repair round 2, Major 1): does the
/// conversation exist in ANY candidate root? The seam
/// (`provider_layout::antigravity_home`) resolves ONE root, but the
/// binary's WRITE root is not necessarily the seam's read root (the snap
/// binary pins its store under `$HOME/snap` while the default root can
/// also hold conversations), so a single-root walk answers false Absent
/// for a valid conversation in the unselected root — a refusal the resume
/// gate would turn into a false SESSION_MISSING. The union walk keeps the
/// per-root tri-state semantics and folds them:
/// * `Present` in ANY root ⇒ `Present` (never refuse a conversation that
///   exists);
/// * absent everywhere but UNREADABLE somewhere ⇒ `Unreadable`
///   (fail-open, G28 — an unreadable root may hold the live
///   conversation, never a guessed Absent);
/// * absent from ALL roots ⇒ `Absent` (positive — every candidate was
///   probed and answered clean NotFound).
///
/// RESIDUAL (honest limitation, cited): on a dual-root host Freshell
/// cannot know which store root the CLI will READ — the binary's actual
/// read root remains the CLI's own (the seam's root-ambiguity limitation,
/// recorded in provider_layout.rs's docs and the README's known
/// limitations). The union is honest for the REFUSAL question this locator
/// serves (the gate's exists_for_gate variant AND the sync warm-Absent
/// adjudication): it never refuses a conversation that exists, and its
/// positive Absent means the conversation exists in NO candidate root the
/// binary could plausibly read. History/search keep the seam's
/// single-root selection (out of scope here).
pub fn antigravity_transcript_on_disk_any_root(roots: &[PathBuf], session_id: &str) -> ByIdAnswer {
    // An id that can never name a conversation dir (the per-root junk-id
    // gate is id-ONLY, so deciding it under the first root decides for
    // the whole union) — and an empty candidate list can hold nothing.
    if roots.is_empty() || conversation_transcript_path(&roots[0], session_id).is_none() {
        return ByIdAnswer::Absent;
    }
    let mut saw_unreadable = false;
    for root in roots {
        match antigravity_transcript_on_disk(root, session_id) {
            ByIdAnswer::Present => return ByIdAnswer::Present,
            ByIdAnswer::Unreadable => saw_unreadable = true,
            ByIdAnswer::Absent => {}
        }
    }
    if saw_unreadable {
        ByIdAnswer::Unreadable
    } else {
        ByIdAnswer::Absent
    }
}

/// Locator over an EXPLICIT candidate-root list: wraps
/// [`antigravity_transcript_on_disk_any_root`] (the union shape the
/// production wiring installs; tests compose it with
/// [`antigravity_store_root_candidates`] to pin the wiring without
/// touching process-global env).
pub fn antigravity_union_transcript_locator(roots: Vec<PathBuf>) -> AntigravityTranscriptLocator {
    Arc::new(move |session_id: &str| antigravity_transcript_on_disk_any_root(&roots, session_id))
}

/// The production union-root locator (focused repair round 2, Major 1):
/// every candidate store root ([`antigravity_store_root_candidates`] —
/// the same list the real-provider smoke scans), with the
/// `FRESHELL_ANTIGRAVITY_HOME` override read ONCE here at wiring time
/// (the resolve-once-and-bake discipline the single-root locator's
/// `main.rs` wiring already follows). `user_home` is the OS home
/// (`session_directory::provider_home()`), NOT the resolved antigravity
/// home — the candidate list is DERIVED from it. This locator serves the
/// existence probe's gate variant AND its sync warm-Absent adjudication:
/// the union answer is correct for both (a valid conversation in the
/// unselected root must be neither refused by the gate nor adjudicated
/// dead by reconcile).
pub fn antigravity_union_root_locator(user_home: &Path) -> AntigravityTranscriptLocator {
    let env_override = std::env::var("FRESHELL_ANTIGRAVITY_HOME")
        .ok()
        .filter(|v| !v.is_empty());
    antigravity_union_transcript_locator(antigravity_store_root_candidates(
        user_home,
        env_override.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_agy_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "freshell-agy-by-id-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp antigravity home");
        dir
    }

    /// Seed `brain/<id>/.system_generated/logs/transcript.jsonl`.
    fn seed_conversation(home: &Path, id: &str) {
        let logs = home
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&logs).expect("mkdir brain conversation");
        std::fs::write(logs.join("transcript.jsonl"), "{\"v\":1}\n").expect("write transcript");
    }

    #[test]
    fn seeded_conversation_is_present() {
        let home = temp_agy_home("present");
        let id = "11111111-2222-3333-4444-555555555555";
        seed_conversation(&home, id);
        assert_eq!(
            antigravity_transcript_on_disk(&home, id),
            ByIdAnswer::Present,
            "exists + readable => Present (the attach arm would resume it)"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_conversation_is_absent() {
        let home = temp_agy_home("absent");
        // Store tree exists (brain/ created), the conversation does not —
        // and a home where the CLI never ran (no brain/ at all) is the
        // same honest Absent.
        std::fs::create_dir_all(home.join("brain")).expect("mkdir brain root");
        assert_eq!(
            antigravity_transcript_on_disk(&home, "00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "missing conversation dir => positive Absent"
        );
        let never_ran = temp_agy_home("never-ran");
        assert_eq!(
            antigravity_transcript_on_disk(&never_ran, "00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "no brain tree at all (CLI never ran here) => the same honest Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&never_ran);
    }

    /// An unreadable transcript file (chmod 000 — the corruption/permission
    /// class) is an honest `Unreadable`, never a guessed Absent. Skipped
    /// when running as root (root ignores mode bits).
    #[cfg(unix)]
    #[test]
    fn unreadable_transcript_answers_unreadable() {
        if std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
        {
            return; // root ignores mode bits — test is meaningless
        }
        use std::os::unix::fs::PermissionsExt;
        let home = temp_agy_home("unreadable");
        let id = "22222222-3333-4444-5555-666666666666";
        seed_conversation(&home, id);
        let transcript = home
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = antigravity_transcript_on_disk(&home, id);
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            answer,
            ByIdAnswer::Unreadable,
            "an unreadable transcript may be a live conversation — never Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn junk_ids_never_probe_foreign_paths() {
        let home = temp_agy_home("junk");
        for id in ["", ".", "..", "../..", "a/b", "x\0y"] {
            assert_eq!(
                antigravity_transcript_on_disk(&home, id),
                ByIdAnswer::Absent,
                "an id that cannot name a conversation dir is definitively absent \
                 and must never walk out of the brain tree: {id:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── Union-root locator (focused repair round 2, Major 1) ──────────

    fn default_root_of(user_home: &Path) -> PathBuf {
        user_home.join(".gemini").join("antigravity-cli")
    }

    fn snap_root_of(user_home: &Path) -> PathBuf {
        user_home
            .join("snap")
            .join("antigravity-cli")
            .join("common")
            .join(".gemini")
            .join("antigravity-cli")
    }

    /// The candidate list is pure path math (never touches disk), so a
    /// never-created home is fine.
    #[test]
    fn candidate_roots_env_default_snap_deduplicated() {
        let user_home = PathBuf::from("/home/freshell-candidates");
        assert_eq!(
            antigravity_store_root_candidates(&user_home, None),
            vec![default_root_of(&user_home), snap_root_of(&user_home)],
            "no override: the default root, then the snap root, in preference order"
        );
        assert_eq!(
            antigravity_store_root_candidates(&user_home, Some("/custom/agy-home")),
            vec![
                PathBuf::from("/custom/agy-home"),
                default_root_of(&user_home),
                snap_root_of(&user_home),
            ],
            "the env override LEADS, and the default/snap candidates still follow — \
             the override says where the CLI was POINTED, not that the other roots \
             cannot hold conversations"
        );
        assert_eq!(
            antigravity_store_root_candidates(&user_home, Some("")),
            vec![default_root_of(&user_home), snap_root_of(&user_home)],
            "an empty override is dropped, never probed"
        );
        assert_eq!(
            antigravity_store_root_candidates(
                &user_home,
                Some(default_root_of(&user_home).to_str().unwrap()),
            ),
            vec![default_root_of(&user_home), snap_root_of(&user_home)],
            "an override equal to the default dedupes — every root is probed once"
        );
    }

    /// The dual-root-host shape (the finding): the default root holds a
    /// DIFFERENT conversation (so the seam would select it) and the
    /// conversation under test lives ONLY in the snap root — the union
    /// walk must find it.
    #[test]
    fn union_locator_finds_a_conversation_only_in_the_second_root() {
        let user_home = temp_agy_home("union-second-root");
        let default_root = default_root_of(&user_home);
        let snap_root = snap_root_of(&user_home);
        seed_conversation(&default_root, "11111111-2222-3333-4444-555555555555");
        let snap_conv = "11111111-2222-3333-4444-555555555556";
        seed_conversation(&snap_root, snap_conv);
        let roots = vec![default_root.clone(), snap_root.clone()];
        assert_eq!(
            antigravity_transcript_on_disk_any_root(&roots, snap_conv),
            ByIdAnswer::Present,
            "found in the unselected snap root ⇒ Present — the union never \
             refuses a conversation that exists"
        );
        // The same answer through the locator closure (the production
        // wiring's shape), including when a NON-EXISTENT env-override root
        // leads the candidate list (a missing root contributes a clean
        // NotFound, never an error).
        let locator = antigravity_union_transcript_locator(antigravity_store_root_candidates(
            &user_home,
            Some("/custom/agy-home-that-does-not-exist"),
        ));
        assert_eq!(locator(snap_conv), ByIdAnswer::Present);
        let _ = std::fs::remove_dir_all(&user_home);
    }

    #[test]
    fn union_locator_absent_from_all_roots_is_positive_absent() {
        let user_home = temp_agy_home("union-absent");
        let default_root = default_root_of(&user_home);
        let snap_root = snap_root_of(&user_home);
        // Both roots EXIST and hold OTHER conversations — the adversarial
        // shape (a readable store that genuinely lacks the id).
        seed_conversation(&default_root, "11111111-2222-3333-4444-555555555555");
        seed_conversation(&snap_root, "11111111-2222-3333-4444-555555555557");
        let locator = antigravity_union_transcript_locator(vec![default_root, snap_root]);
        assert_eq!(
            locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "absent from ALL candidate roots is POSITIVE absence — the gate's \
             typed refusal stays honest"
        );
        // A never-created root pair is the same honest Absent (the CLI
        // never ran anywhere on this machine).
        let never_ran = temp_agy_home("union-absent-never-ran");
        let never_ran_locator = antigravity_union_transcript_locator(
            antigravity_store_root_candidates(&never_ran, None),
        );
        assert_eq!(
            never_ran_locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent
        );
        let _ = std::fs::remove_dir_all(&user_home);
        let _ = std::fs::remove_dir_all(&never_ran);
    }

    /// Unreadable in the only populated root ⇒ `Unreadable` (fail-open,
    /// G28): the unreadable root may hold the live conversation — a
    /// missing sibling root's clean NotFound must not turn the union's
    /// answer into a guessed Absent. Skipped when running as root (root
    /// ignores mode bits).
    #[cfg(unix)]
    #[test]
    fn union_locator_unreadable_in_only_populated_root_is_unreadable() {
        if std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
        {
            return; // root ignores mode bits — test is meaningless
        }
        use std::os::unix::fs::PermissionsExt;
        let user_home = temp_agy_home("union-unreadable");
        let default_root = default_root_of(&user_home); // exists, EMPTY brain
        std::fs::create_dir_all(default_root.join("brain")).expect("mkdir default brain");
        let snap_root = snap_root_of(&user_home);
        let id = "22222222-3333-4444-5555-666666666666";
        seed_conversation(&snap_root, id);
        let transcript = snap_root
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = antigravity_transcript_on_disk_any_root(&[default_root, snap_root], id);
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            answer,
            ByIdAnswer::Unreadable,
            "absent from one root but UNREADABLE in the populated one ⇒ Unreadable — \
             never a guessed Absent over a root that may hold the live conversation"
        );
        let _ = std::fs::remove_dir_all(&user_home);
    }

    #[test]
    fn union_locator_junk_ids_are_definitively_absent() {
        let user_home = temp_agy_home("union-junk");
        let snap_root = snap_root_of(&user_home);
        seed_conversation(&snap_root, "11111111-2222-3333-4444-555555555555");
        let locator = antigravity_union_transcript_locator(antigravity_store_root_candidates(
            &user_home, None,
        ));
        for id in ["", ".", "..", "../..", "a/b", "x\0y"] {
            assert_eq!(
                locator(id),
                ByIdAnswer::Absent,
                "an id that cannot name a conversation dir is definitively absent \
                 across the whole union: {id:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&user_home);
    }
}

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

/// Production locator: wraps [`antigravity_transcript_on_disk`] over the
/// resolved antigravity home (the SAME home `main.rs` hands the
/// `AntigravitySource` and the existence `provider_roots` entry).
pub fn antigravity_transcript_locator(antigravity_home: PathBuf) -> AntigravityTranscriptLocator {
    Arc::new(move |session_id: &str| antigravity_transcript_on_disk(&antigravity_home, session_id))
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
}

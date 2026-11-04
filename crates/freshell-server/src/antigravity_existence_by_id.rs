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
//! AUTHORITY LADDER (focused repair round 3, Major 1 — replaces round 2's
//! union): the seam (`freshell_sessions::provider_layout::antigravity_home`)
//! resolves ONE root, but the binary's WRITE root is not necessarily the
//! seam's read root — the snap binary pins its store under `$HOME/snap`
//! while the default root can also hold conversations. Round 2 answered
//! Present for an id found in ANY candidate root, but the binary reads
//! only ITS OWN root: on a dual-root host a wrong-root Present proceeds
//! to the CLI, which silently starts a fresh conversation (GC3 hazard).
//! The gate's by-id answer is therefore rooted in the binary's own
//! store, resolved as an AUTHORITY LADDER (see
//! [`resolve_antigravity_store_authority`]):
//!
//! 1. `FRESHELL_ANTIGRAVITY_HOME` set ⇒ AUTHORITATIVE single root:
//!    answers come from that root alone (the operator declared the
//!    store; an id found only in another candidate root is Absent).
//! 2. Env unset, exactly ONE candidate root holds conversations (the
//!    root's `brain/` dir lists ≥1 id — the same probe the smoke and the
//!    seam use) ⇒ that root is the binary's store (strong evidence: the
//!    binary wrote those conversations): answers come from that root
//!    alone.
//! 3. Env unset, ZERO roots populated ⇒ any id answers Absent (nothing
//!    exists anywhere; covers fresh installs).
//! 4. Env unset, BOTH roots populated ⇒ genuine ambiguity Freshell
//!    cannot resolve: an id found in EITHER root answers `Defer`
//!    (Unknown at the probe — defer to the binary; its own missing-ID
//!    warning is visible in the pane, the documented pre-gate behavior;
//!    NEVER a silent substitution); an id found in NEITHER root answers
//!    Absent (the typed refusal — honest positive absence); an id found
//!    nowhere but unreadable somewhere answers Unreadable (fail-open,
//!    G28). A dual-root store emits a LOUD once-per-process startup log
//!    telling the operator to set `FRESHELL_ANTIGRAVITY_HOME` (the
//!    README/`antigravity_store_root_missing` event precedent in
//!    provider_layout.rs).
//!
//! RESIDUAL (honest, unchanged by the ladder): the binary's actual read
//! root remains the CLI's own — the ladder never answers Present for an
//! id the resolved authority root cannot resume (case 4 answers Defer for
//! found ids precisely because it cannot prove resumability), and the
//! ambiguous corner defers to the binary rather than guessing.
//! History/search keep the seam's single-root selection — a separate,
//! older design, out of scope here.
//!
//! BINARY-AUTHORITY RESIDUAL (focused repair round 4, Major 1 — documented
//! residual, not a code gap): the gate's by-id walk is FILESYSTEM
//! EVIDENCE, never binary authority — no disk state can prove which store
//! root the CURRENT CLI binary reads (migration corner: an old store
//! populated while the new binary's store is empty, e.g. a CLI
//! reinstall/switch that moved roots; `FRESHELL_ANTIGRAVITY_HOME` selects
//! FRESHELL's read path, not the CLI's). In those corners the CLI's own
//! missing-id warning (`warning: conversation "<id>" not found`, visible
//! in the pane) is the final backstop, and the resulting substitution is
//! neither silent nor identity-corrupting — the CLI's fresh conversation
//! rebinds through the provider's natural identity fold, which clears the
//! stale id. The follow-up surface is post-spawn warning detection
//! (binary-authority verification: surface the CLI's own missing-id
//! warning as a Freshell-visible fact), recorded as future work.
//!
//! Per-root tri-state contract (the ladder's core; mirrors
//! [`crate::existence_by_id::ByIdAnswer`]):
//! * transcript exists + readable ⇒ `Present`;
//! * missing conversation dir (or any missing path component — the CLI
//!   never ran here) ⇒ `Absent`;
//! * unreadable (EACCES on the tree, corruption, io error) ⇒ `Unreadable`
//!   — the probe maps it to `Unknown`, NEVER `Absent`.
//!
//! The ladder folds the per-root answers per the resolution (see
//! [`antigravity_transcript_on_disk_authority`]); only the AMBIGUOUS
//! resolution ever answers `Defer`.
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
/// PRODUCTION wiring is the AUTHORITY-LADDER locator
/// ([`antigravity_authority_root_locator`], focused repair round 3,
/// Major 1); this single-root shape remains for the existence/gate tests
/// that mirror a one-store-root wiring over an already-resolved home
/// (and any caller that genuinely wants exactly one root probed).
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
/// constructor [`antigravity_authority_root_locator`] reads the variable
/// once at wiring time.
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

/// Whether a candidate root holds conversations (focused repair round 3,
/// Major 1): the root's `brain/` dir lists ≥1 id — the SAME probe the
/// smoke and the seam's `root_holds_conversations` use. A root with no
/// `brain/` (or an empty readable one) never ran the CLI; a root whose
/// `brain/` cannot be LISTED is `Unreadable` — its population (and any
/// conversation in it) is unknowable, which the ladder treats as
/// ambiguity it cannot resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootPopulation {
    /// `brain/` lists ≥1 entry: the binary wrote conversations here.
    Conversations,
    /// No `brain/`, or an empty readable one: the CLI never ran here.
    Empty,
    /// `brain/` cannot be listed (EACCES/corruption/io): the root may
    /// hold conversations Freshell cannot see.
    Unreadable,
}

fn antigravity_root_population(root: &Path) -> RootPopulation {
    match std::fs::read_dir(root.join("brain")) {
        Ok(entries) => {
            // ≥1 readable entry = ≥1 listed conversation id (the seam/smoke
            // probe; an entry that fails to list does not count).
            if entries.into_iter().any(|entry| entry.is_ok()) {
                RootPopulation::Conversations
            } else {
                RootPopulation::Empty
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => RootPopulation::Empty,
        Err(_) => RootPopulation::Unreadable,
    }
}

/// The resolved authority for the gate's by-id answers (focused repair
/// round 3, Major 1 — the AUTHORITY LADDER replacing round 2's union).
/// The binary reads only ITS OWN store root, so an answer is only
/// authoritative when rooted in that store:
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AntigravityStoreAuthority {
    /// The binary's store root is resolved (operator override, or the
    /// single conversation-bearing candidate): by-id answers come from
    /// this root ALONE — an id found only in another candidate root is
    /// Absent.
    Root(PathBuf),
    /// No candidate root holds conversations: nothing exists anywhere —
    /// every id answers Absent (covers fresh installs).
    NothingAnywhere,
    /// The store root cannot be resolved (both candidate roots hold
    /// conversations, or a root's population is unreadable): an id found
    /// in any root answers `Defer` (never a wrong-root Present the CLI
    /// cannot resume); an id found nowhere answers Absent; an id found
    /// nowhere but unreadable somewhere answers Unreadable (fail-open,
    /// G28).
    Ambiguous(Vec<PathBuf>),
}

/// Resolve the authority ladder (pure — no logging, no env reads;
/// `env_override` is passed in so tests never mutate process-global env):
///
/// 1. `FRESHELL_ANTIGRAVITY_HOME` set (non-empty) ⇒ AUTHORITATIVE single
///    root: the operator declared the store; answers come from that root
///    alone (an id found only in another candidate root is Absent).
/// 2. Env unset, exactly ONE candidate root holds conversations ⇒ that
///    root is the binary's store (strong evidence: the binary wrote those
///    conversations): answers come from that root alone. (An id in the
///    other root would make that root conversation-bearing too — the
///    unselected root cannot hold it.)
/// 3. Env unset, ZERO roots populated ⇒ any id answers Absent (nothing
///    exists anywhere).
/// 4. Env unset, BOTH roots populated ⇒ genuine ambiguity Freshell cannot
///    resolve: defer semantics (see [`AntigravityStoreAuthority::Ambiguous`]).
///    A root whose population is UNREADABLE also lands here — the
///    single-store evidence is incomplete when a candidate root may hold
///    conversations Freshell cannot list.
pub(crate) fn resolve_antigravity_store_authority(
    user_home: &Path,
    env_override: Option<&str>,
) -> AntigravityStoreAuthority {
    if let Some(v) = env_override.filter(|v| !v.is_empty()) {
        return AntigravityStoreAuthority::Root(PathBuf::from(v));
    }
    // The env-unset candidate pair (default + snap), from the ONE
    // candidate-list source of truth.
    let candidates = antigravity_store_root_candidates(user_home, None);
    let populations: Vec<RootPopulation> = candidates
        .iter()
        .map(|r| antigravity_root_population(r))
        .collect();
    if populations
        .iter()
        .any(|p| matches!(p, RootPopulation::Unreadable))
    {
        return AntigravityStoreAuthority::Ambiguous(candidates);
    }
    let populated: Vec<PathBuf> = candidates
        .iter()
        .zip(populations)
        .filter(|(_, p)| matches!(p, RootPopulation::Conversations))
        .map(|(root, _)| root.clone())
        .collect();
    match populated.len() {
        0 => AntigravityStoreAuthority::NothingAnywhere,
        // Exactly one conversation-bearing candidate: it is the binary's
        // store (the other candidate holds no conversations, so it cannot
        // hold this id either — answers from this root alone are complete).
        1 => AntigravityStoreAuthority::Root(
            populated
                .into_iter()
                .next()
                .expect("exactly one populated root by the match"),
        ),
        _ => AntigravityStoreAuthority::Ambiguous(candidates),
    }
}

/// The ladder's by-id fold: answer `session_id` under the RESOLVED
/// authority (focused repair round 3, Major 1). Junk ids (an id that can
/// never name a conversation dir) are definitively absent under every
/// resolution — the gate is id-only, decided once.
pub(crate) fn antigravity_transcript_on_disk_authority(
    authority: &AntigravityStoreAuthority,
    session_id: &str,
) -> ByIdAnswer {
    match authority {
        // Case 3: nothing exists anywhere — the population probes read
        // both roots clean and empty, so no candidate can hold the id.
        AntigravityStoreAuthority::NothingAnywhere => ByIdAnswer::Absent,
        // Cases 1+2: answers come from the resolved root ALONE. The
        // per-root tri-state is complete: in case 2 the other candidate
        // holds no conversations, so it cannot hold this id either; in
        // case 1 the operator declared the store.
        AntigravityStoreAuthority::Root(root) => {
            if conversation_transcript_path(root, session_id).is_none() {
                return ByIdAnswer::Absent;
            }
            antigravity_transcript_on_disk(root, session_id)
        }
        // Case 4 (+ the population-unreadable corners): defer semantics.
        AntigravityStoreAuthority::Ambiguous(roots) => {
            if roots.is_empty() || conversation_transcript_path(&roots[0], session_id).is_none() {
                return ByIdAnswer::Absent;
            }
            let mut saw_unreadable = false;
            for root in roots {
                match antigravity_transcript_on_disk(root, session_id) {
                    // Found — but the binary's read root is unknowable: a
                    // Present here is the wrong-root Present the CLI
                    // silently replaces with a fresh conversation (GC3).
                    // Defer to the binary (the probe maps Defer to
                    // Unknown: the gate fails open, the CLI's own
                    // missing-ID warning is visible in the pane).
                    ByIdAnswer::Present => return ByIdAnswer::Defer,
                    ByIdAnswer::Unreadable => saw_unreadable = true,
                    ByIdAnswer::Absent => {}
                    // The per-root core never produces Defer.
                    ByIdAnswer::Defer => {}
                }
            }
            // Found NOWHERE: absent from all readable candidates is
            // positive absence (the typed refusal); an unreadable
            // candidate may hold the live conversation — never a guessed
            // Absent (fail-open, G28).
            if saw_unreadable {
                ByIdAnswer::Unreadable
            } else {
                ByIdAnswer::Absent
            }
        }
    }
}

/// Once-per-process loud ambiguity announcement (focused repair round 3,
/// Major 1). Mirrors the README/`antigravity_store_root_missing` event
/// precedent (provider_layout.rs's `announce_antigravity_root` — the
/// operator-facing one-line warn with `event`/root fields): a dual-root
/// store is ambiguous for every future by-id answer, and the operator can
/// disambiguate it, so it is announced at most once per process, loudly.
static ANTIGRAVITY_STORE_AMBIGUITY_ANNOUNCED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn announce_antigravity_store_ambiguity_once(user_home: &Path, roots: &[PathBuf]) {
    use std::sync::atomic::Ordering;
    if ANTIGRAVITY_STORE_AMBIGUITY_ANNOUNCED.swap(true, Ordering::Relaxed) {
        return; // announced once this process already
    }
    let default_root = user_home.join(".gemini").join("antigravity-cli");
    let snap_root = user_home
        .join("snap")
        .join("antigravity-cli")
        .join("common")
        .join(".gemini")
        .join("antigravity-cli");
    tracing::warn!(
        target: "freshell_server::antigravity_existence_by_id",
        event = "antigravity_store_root_ambiguous",
        default_root = %default_root.display(),
        snap_root = %snap_root.display(),
        candidate_roots = ?roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>(),
        "antigravity_store_root_ambiguous: multiple candidate antigravity store \
         roots hold conversations (or one cannot be read) — Freshell cannot \
         know which root the agy binary reads, so resume answers DEFER to the \
         binary for ids found in either root. Set FRESHELL_ANTIGRAVITY_HOME to \
         the binary's actual store root to disambiguate."
    );
}

/// The AUTHORITY-LADDER locator (focused repair round 3, Major 1 — the
/// production wiring's shape), with the env override PASSED IN (never
/// read here) so tests compose override scenarios without touching
/// process-global env. Serves the existence probe's gate variant AND
/// its sync warm-Absent adjudication: the ladder answer is correct for
/// both (a conversation the authority root holds is neither refused by
/// the gate nor adjudicated dead by reconcile; a dual-populated store
/// defers instead of guessing).
///
/// The authority is RE-RESOLVED per query (population probes are two
/// cheap `read_dir`s — the same class as the per-root `File::open`), NOT
/// baked at wiring: conversations created after boot (a fresh install
/// that ran agy, a second store root appearing) flip the ladder honestly,
/// whereas a baked resolution would answer from stale evidence forever
/// (e.g. a baked "nothing exists anywhere" would false-refuse a
/// conversation created after Freshell started). The wiring-time eager
/// resolution below exists ONLY so a dual-root store is announced as a
/// STARTUP log, before the first query; both announcements share the
/// once-per-process guard.
pub fn antigravity_authority_root_locator_with_override(
    user_home: &Path,
    env_override: Option<&str>,
) -> AntigravityTranscriptLocator {
    // Startup announcement: resolve once eagerly so an already-dual-root
    // host logs at boot even before any by-id query runs.
    let eager = resolve_antigravity_store_authority(user_home, env_override);
    if let AntigravityStoreAuthority::Ambiguous(roots) = &eager {
        announce_antigravity_store_ambiguity_once(user_home, roots);
    }
    let user_home = user_home.to_path_buf();
    let env_override = env_override.map(str::to_string);
    Arc::new(move |session_id: &str| {
        let authority = resolve_antigravity_store_authority(&user_home, env_override.as_deref());
        if let AntigravityStoreAuthority::Ambiguous(roots) = &authority {
            announce_antigravity_store_ambiguity_once(&user_home, roots);
        }
        antigravity_transcript_on_disk_authority(&authority, session_id)
    })
}

/// The production authority-root locator: reads `FRESHELL_ANTIGRAVITY_HOME`
/// ONCE at wiring time (the resolve-once-and-bake discipline) and
/// delegates to [`antigravity_authority_root_locator_with_override`].
/// `user_home` is the OS home (`session_directory::provider_home()`),
/// NOT the resolved antigravity home — the candidate roots are DERIVED
/// from it.
pub fn antigravity_authority_root_locator(user_home: &Path) -> AntigravityTranscriptLocator {
    let env_override = std::env::var("FRESHELL_ANTIGRAVITY_HOME")
        .ok()
        .filter(|v| !v.is_empty());
    antigravity_authority_root_locator_with_override(user_home, env_override.as_deref())
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

    // ── Authority ladder (focused repair round 3, Major 1) ─────────────

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
            "the env override LEADS the candidate list (path math only — the \
             LADDER treats a set override as authoritative and never probes \
             the other candidates for answers)"
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

    /// The ladder's resolution, pinned per case (pure — env passed in).
    #[test]
    fn resolve_authority_ladder_cases() {
        // Case 1: the override is authoritative ALONE, even when it does not
        // exist on disk and both candidates hold conversations (the operator
        // declared the store; its per-root tri-state owns every answer).
        let user_home = temp_agy_home("ladder-resolve-override");
        seed_conversation(
            &default_root_of(&user_home),
            "11111111-2222-3333-4444-555555555555",
        );
        seed_conversation(
            &snap_root_of(&user_home),
            "11111111-2222-3333-4444-555555555556",
        );
        assert_eq!(
            resolve_antigravity_store_authority(&user_home, Some("/custom/agy-home")),
            AntigravityStoreAuthority::Root(PathBuf::from("/custom/agy-home")),
            "case 1: a set override is the authoritative single root"
        );
        // An EMPTY override is unset — the population ladder runs.
        assert_eq!(
            resolve_antigravity_store_authority(&user_home, Some("")),
            AntigravityStoreAuthority::Ambiguous(vec![
                default_root_of(&user_home),
                snap_root_of(&user_home),
            ]),
            "an empty override is dropped: both roots populated ⇒ Ambiguous (case 4)"
        );
        // Case 4: both roots populated ⇒ genuine ambiguity.
        assert_eq!(
            resolve_antigravity_store_authority(&user_home, None),
            AntigravityStoreAuthority::Ambiguous(vec![
                default_root_of(&user_home),
                snap_root_of(&user_home),
            ]),
            "case 4: both candidate roots hold conversations ⇒ Ambiguous"
        );
        let _ = std::fs::remove_dir_all(&user_home);

        // Case 2: exactly ONE conversation-bearing root ⇒ that root is the
        // store (here: snap only — the default root never ran the CLI).
        let single_snap = temp_agy_home("ladder-resolve-single-snap");
        seed_conversation(
            &snap_root_of(&single_snap),
            "11111111-2222-3333-4444-555555555557",
        );
        assert_eq!(
            resolve_antigravity_store_authority(&single_snap, None),
            AntigravityStoreAuthority::Root(snap_root_of(&single_snap)),
            "case 2: the single conversation-bearing root is the binary's store"
        );
        let _ = std::fs::remove_dir_all(&single_snap);

        // Case 2 (the default twin): only the default root populated.
        let single_default = temp_agy_home("ladder-resolve-single-default");
        seed_conversation(
            &default_root_of(&single_default),
            "11111111-2222-3333-4444-555555555558",
        );
        assert_eq!(
            resolve_antigravity_store_authority(&single_default, None),
            AntigravityStoreAuthority::Root(default_root_of(&single_default)),
            "case 2: the default root alone ⇒ it is the store"
        );
        let _ = std::fs::remove_dir_all(&single_default);

        // Case 3: zero populated ⇒ nothing exists anywhere. A never-created
        // home AND a home with empty readable brain/ trees both count.
        let never_ran = temp_agy_home("ladder-resolve-never-ran");
        let empty_brains = temp_agy_home("ladder-resolve-empty-brains");
        std::fs::create_dir_all(default_root_of(&empty_brains).join("brain"))
            .expect("mkdir default brain");
        std::fs::create_dir_all(snap_root_of(&empty_brains).join("brain"))
            .expect("mkdir snap brain");
        for home in [&never_ran, &empty_brains] {
            assert_eq!(
                resolve_antigravity_store_authority(home, None),
                AntigravityStoreAuthority::NothingAnywhere,
                "case 3: zero conversation-bearing roots ⇒ NothingAnywhere"
            );
        }
        let _ = std::fs::remove_dir_all(&never_ran);
        let _ = std::fs::remove_dir_all(&empty_brains);
    }

    /// Case 2 pin: the snap root is the ONLY conversation-bearing root ⇒ it
    /// is the binary's store, and a snap conversation answers Present
    /// through the production locator shape — never a false Absent (the
    /// round-1 bug) and never a defer (this is not the ambiguous shape).
    #[test]
    fn authority_single_populated_snap_root_answers_present() {
        let user_home = temp_agy_home("ladder-single-snap");
        let snap_conv = "11111111-2222-3333-4444-555555555560";
        seed_conversation(&snap_root_of(&user_home), snap_conv);
        let locator = antigravity_authority_root_locator_with_override(&user_home, None);
        assert_eq!(
            locator(snap_conv),
            ByIdAnswer::Present,
            "the single conversation-bearing root is the store — a valid \
             conversation in it answers Present"
        );
        assert_eq!(
            locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "an id the store does not hold is positive Absent"
        );
        let _ = std::fs::remove_dir_all(&user_home);
    }

    /// Case 4 pin — the GC3 hazard the ladder closes: BOTH roots populated
    /// (the default root holds a DIFFERENT conversation so the seam would
    /// select it; the id under test lives in the snap root). The binary
    /// reads only ITS OWN root, so a found id answers `Defer` (Unknown at
    /// the probe — defer to the binary), NEVER the round-2 union's
    /// wrong-root Present. The defer is symmetric for an id in the
    /// seam-selected root, and an id in NEITHER root stays the honest
    /// positive Absent.
    #[test]
    fn authority_dual_populated_defers_found_ids() {
        let user_home = temp_agy_home("ladder-dual-defer");
        let default_root = default_root_of(&user_home);
        let snap_root = snap_root_of(&user_home);
        let default_conv = "11111111-2222-3333-4444-555555555561";
        let snap_conv = "11111111-2222-3333-4444-555555555562";
        seed_conversation(&default_root, default_conv);
        seed_conversation(&snap_root, snap_conv);
        let locator = antigravity_authority_root_locator_with_override(&user_home, None);
        assert_eq!(
            locator(snap_conv),
            ByIdAnswer::Defer,
            "found in the seam-UNSELECTED root on a dual-populated store ⇒ Defer \
             (Unknown at the probe) — a Present here is the wrong-root Present \
             the CLI silently replaces with a fresh conversation"
        );
        assert_eq!(
            locator(default_conv),
            ByIdAnswer::Defer,
            "the defer is symmetric: the binary's own read root is unknowable for \
             the seam-selected root's ids too"
        );
        assert_eq!(
            locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "found in NEITHER root ⇒ the honest positive Absent (the typed refusal)"
        );
        let _ = std::fs::remove_dir_all(&user_home);
    }

    /// Case 1 pin — the override is AUTHORITATIVE ALONE: answers come from
    /// the override root only. An id found in another candidate root (here:
    /// snap) is Absent — the round-2 union answered Present for it, sending
    /// the CLI a wrong-root id it cannot resume. The override's OWN
    /// conversation stays Present, and a non-existent override root
    /// contributes a clean per-root NotFound (Absent), never an error.
    #[test]
    fn authority_override_answers_from_the_override_alone() {
        let user_home = temp_agy_home("ladder-override");
        let override_root = user_home.join("custom-agy-store");
        let override_conv = "11111111-2222-3333-4444-555555555563";
        let snap_conv = "11111111-2222-3333-4444-555555555564";
        seed_conversation(&override_root, override_conv);
        seed_conversation(&snap_root_of(&user_home), snap_conv);
        let locator = antigravity_authority_root_locator_with_override(
            &user_home,
            Some(override_root.to_str().unwrap()),
        );
        assert_eq!(
            locator(override_conv),
            ByIdAnswer::Present,
            "the operator-declared store answers for its own conversations"
        );
        assert_eq!(
            locator(snap_conv),
            ByIdAnswer::Absent,
            "an id found only OUTSIDE the authoritative override root is Absent — \
             never a wrong-root Present"
        );
        assert_eq!(
            locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "an id the override root does not hold is positive Absent"
        );
        // A non-existent override root is the same honest per-root Absent
        // (clean NotFound — the CLI was pointed at a store it never wrote).
        let missing_override = antigravity_authority_root_locator_with_override(
            &user_home,
            Some("/custom/agy-home-that-does-not-exist"),
        );
        assert_eq!(missing_override(snap_conv), ByIdAnswer::Absent);
        assert_eq!(
            missing_override("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent
        );
        let _ = std::fs::remove_dir_all(&user_home);
    }

    /// Case 3 pin: zero populated roots (fresh install — no candidate ever
    /// ran the CLI) ⇒ every id answers Absent, through the production
    /// locator shape. Covers both a never-created home and empty readable
    /// brain/ trees.
    #[test]
    fn authority_nothing_anywhere_answers_absent() {
        let never_ran = temp_agy_home("ladder-never-ran");
        let never_ran_locator = antigravity_authority_root_locator_with_override(&never_ran, None);
        assert_eq!(
            never_ran_locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "nothing exists anywhere ⇒ any id answers Absent"
        );
        let empty_brains = temp_agy_home("ladder-empty-brains");
        std::fs::create_dir_all(default_root_of(&empty_brains).join("brain"))
            .expect("mkdir default brain");
        std::fs::create_dir_all(snap_root_of(&empty_brains).join("brain"))
            .expect("mkdir snap brain");
        let empty_brains_locator =
            antigravity_authority_root_locator_with_override(&empty_brains, None);
        assert_eq!(
            empty_brains_locator("00000000-1111-2222-3333-444444444444"),
            ByIdAnswer::Absent,
            "readable EMPTY brain trees are the same honest Absent"
        );
        let _ = std::fs::remove_dir_all(&never_ran);
        let _ = std::fs::remove_dir_all(&empty_brains);
    }

    /// Case 4's fail-open clause: on the AMBIGUOUS resolution, an id found
    /// NOWHERE but UNREADABLE somewhere answers Unreadable — the probe maps
    /// it to Unknown (G28: an unreadable candidate may hold the live
    /// conversation, never a guessed Absent). Skipped when running as root
    /// (root ignores mode bits).
    #[cfg(unix)]
    #[test]
    fn authority_dual_populated_unreadable_found_nowhere_is_unreadable() {
        if std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
        {
            return; // root ignores mode bits — test is meaningless
        }
        use std::os::unix::fs::PermissionsExt;
        let user_home = temp_agy_home("ladder-dual-unreadable");
        let default_root = default_root_of(&user_home);
        let snap_root = snap_root_of(&user_home);
        let default_conv = "11111111-2222-3333-4444-555555555565";
        let unreadable_conv = "22222222-3333-4444-5555-666666666666";
        seed_conversation(&default_root, default_conv);
        seed_conversation(&snap_root, unreadable_conv);
        let transcript = snap_root
            .join("brain")
            .join(unreadable_conv)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = antigravity_transcript_on_disk_authority(
            &resolve_antigravity_store_authority(&user_home, None),
            unreadable_conv,
        );
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            answer,
            ByIdAnswer::Unreadable,
            "dual-populated, found nowhere readable but UNREADABLE in one root ⇒ \
             Unreadable (fail-open) — never a guessed Absent over a root that may \
             hold the live conversation"
        );
        let _ = std::fs::remove_dir_all(&user_home);
    }

    /// Case 2's fail-open pin: the resolved store root (the only populated
    /// candidate) holds an UNREADABLE transcript for the id ⇒ Unreadable —
    /// the per-root tri-state under the resolved authority (the unreadable
    /// store may be a live conversation — never Absent). Skipped when
    /// running as root (root ignores mode bits).
    #[cfg(unix)]
    #[test]
    fn authority_unreadable_in_only_populated_root_is_unreadable() {
        if std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
        {
            return; // root ignores mode bits — test is meaningless
        }
        use std::os::unix::fs::PermissionsExt;
        let user_home = temp_agy_home("ladder-single-unreadable");
        let default_root = default_root_of(&user_home); // exists, EMPTY brain
        std::fs::create_dir_all(default_root.join("brain")).expect("mkdir default brain");
        let snap_root = snap_root_of(&user_home);
        let id = "22222222-3333-4444-5555-666666666667";
        seed_conversation(&snap_root, id);
        let transcript = snap_root
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = antigravity_transcript_on_disk_authority(
            &resolve_antigravity_store_authority(&user_home, None),
            id,
        );
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            answer,
            ByIdAnswer::Unreadable,
            "the resolved store's unreadable transcript ⇒ Unreadable — never a \
             guessed Absent over a root that may hold the live conversation"
        );
        let _ = std::fs::remove_dir_all(&user_home);
    }

    /// Junk ids are definitively absent under EVERY resolution of the
    /// ladder — an id that cannot name a conversation dir must never walk
    /// out of any candidate's brain tree.
    #[test]
    fn authority_junk_ids_are_definitively_absent() {
        let user_home = temp_agy_home("ladder-junk");
        seed_conversation(
            &snap_root_of(&user_home),
            "11111111-2222-3333-4444-555555555555",
        );
        seed_conversation(
            &default_root_of(&user_home),
            "11111111-2222-3333-4444-555555555566",
        );
        // The ambiguous resolution (both populated) AND the authoritative
        // override shape (a custom root) AND nothing-anywhere.
        let ambiguous = antigravity_authority_root_locator_with_override(&user_home, None);
        let override_shape = antigravity_authority_root_locator_with_override(
            &user_home,
            Some(user_home.join("custom-agy-store").to_str().unwrap()),
        );
        let nothing_home = temp_agy_home("ladder-junk-nothing");
        let nothing = antigravity_authority_root_locator_with_override(&nothing_home, None);
        for id in ["", ".", "..", "../..", "a/b", "x\0y"] {
            assert_eq!(
                ambiguous(id),
                ByIdAnswer::Absent,
                "an id that cannot name a conversation dir is definitively absent \
                 under the ambiguous resolution: {id:?}"
            );
            assert_eq!(
                override_shape(id),
                ByIdAnswer::Absent,
                "…and under the authoritative override: {id:?}"
            );
            assert_eq!(
                nothing(id),
                ByIdAnswer::Absent,
                "…and when nothing exists anywhere: {id:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&user_home);
        let _ = std::fs::remove_dir_all(&nothing_home);
    }
}

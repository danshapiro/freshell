//! The index-backed [`SessionExistenceProbe`] (reconciliation-handshake
//! design §5.1): "does `provider:sessionId` exist on disk?" answered from the
//! SAME shared [`SessionIndex`] the History/session-directory surfaces read.
//!
//! Semantics (the design's defined contract):
//! * unknown provider → `Absent`, **never** `Unknown` (change #4c);
//! * known provider + no published snapshot (cold index) → `Unknown` — and a
//!   background `snapshot()` refresh is kicked so a re-query converges;
//! * known provider + published snapshot → `Present`/`Absent` from the
//!   snapshot; a STALE snapshot also kicks a background refresh, so a
//!   `provider:sessionId` written to disk after a cold read resolves
//!   `Present` on re-query — never a latched stale `Absent` (§9.1 test 13).
//!
//! `ever_observed` gates `dead_session` (§5.3 rows 4/4b): every snapshot read
//! feeds a monotone observed-set, so "disk has seen this identity at least
//! once (this boot)" survives the session later disappearing from disk.
//! * warm snapshot `Absent` for provider `claude` with a transcript locator
//!   installed ⇒ re-checked against raw file existence (kata 09v1): a claude
//!   transcript can be on disk yet cwd-less (e2e fixture's create-time 0-byte
//!   file; crash-window partial writes), so the R10b index gate excludes it —
//!   file present ⇒ `Present`, so reconcile agrees with the attach arm and
//!   never adjudicates dead a transcript the attach arm would try to resume.
//! * warm snapshot `Absent` for provider `opencode` with a session locator
//!   installed => re-checked BY ID against `opencode.db` (rebind
//!   dead-session fix): child rows (`parent_id` set), directory-less
//!   roots, and archived rows are DB-present yet index-invisible — the
//!   listing is root-filtered, drops cwd-less rows, and excludes archived
//!   — while the attach arm (`opencode --session <id>`, session.get by
//!   id, which has none of those filters) resolves them all. Row present
//!   => `Present`; unreadable DB => `Unreadable` (kata vnpc Task 4), never
//!   `Absent`.
//! * kata vnpc Task 4 — scan-failure honesty: the warm path reads the rows
//!   AND the scan failures from ONE generation
//!   ([`SessionIndex::peek_with_failures`]); a session miss for a provider
//!   named in THAT generation's `scan_failures` answers `Unreadable`
//!   (→ error{session_store_unreadable}), never the snapshot-only `Absent`
//!   that would fold dead_session/fresh for a recoverable identity. A
//!   by-id fallback's definitive answer (hit OR clean miss) stays
//!   authoritative even when the scan failed. The provider-root presence
//!   check runs at the TOP of `exists()` — it holds for the WARM path too,
//!   so a published snapshot can never adjudicate `Absent` for a provider
//!   whose root is gone (`ProviderUnavailable`).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use freshell_freshagent::TranscriptLocation;
use freshell_sessions::directory_index::SessionIndex;
use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};

/// The disk-indexed providers of `main.rs`'s `SessionIndex` construction —
/// the "known provider" set of the probe contract.
const KNOWN_PROVIDERS: [&str; 5] = ["claude", "codex", "opencode", "amplifier", "antigravity"];

/// Injected raw-file transcript check for claude (kata 09v1). Wiring installs
/// `freshell_freshagent::locate_transcript_state` — the SAME ordered-candidate-
/// roots scan the attach arm trusts (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
/// platform home `.claude`) — so reconcile and attach can never disagree about
/// whether a claude transcript exists. Three-state (G28): an unreadable store
/// maps to `Unreadable` (kata vnpc Task 4 — post-readiness this is the honest
/// error{session_store_unreadable}, never `Absent`, and never the cold-only
/// `Unknown`). A closure (not a direct call) keeps this probe
/// unit-testable without process-global env mutation; precedent:
/// `codex_rollout_locator` (main.rs).
pub type ClaudeTranscriptLocator = Arc<dyn Fn(&str) -> TranscriptLocation + Send + Sync>;

/// Answer from the injected opencode by-id DB check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeDbAnswer {
    /// A `session` row with the id exists in `opencode.db` (archived
    /// included — the attach arm's session.get has no archived filter).
    Present,
    /// No such row — including "no DB file at all" (opencode never ran here).
    Absent,
    /// The DB exists but could not be read (WAL lock contention, corruption,
    /// io error, schema variance). LOAD-BEARING: the probe maps this to
    /// `Unreadable` (kata vnpc Task 4 — the honest
    /// error{session_store_unreadable} post-readiness; `Unknown` while the
    /// index is still cold), NEVER `Absent` — Absent-on-error would
    /// adjudicate live sessions dead under transient lock contention.
    Unreadable,
}

/// Injected by-id opencode DB check, mirroring [`ClaudeTranscriptLocator`]
/// (kata 09v1 pattern: the probe must agree with the ATTACH ARM). Opencode's
/// attach arm is `opencode --session <id>` — session.get by id, children
/// included — while the index listing is root-filtered
/// (`parent_id IS NULL`, parse/opencode.rs) and drops directory-less rows.
/// A closure (not a direct call) keeps this probe unit-testable; precedent:
/// `claude_transcript_locator` above.
pub type OpencodeSessionLocator = Arc<dyn Fn(&str) -> OpencodeDbAnswer + Send + Sync>;

// Resume-validation (plan Task 3): the amplifier/codex by-id locators live in
// a focused sibling module; re-exported so the probe's whole locator surface
// stays addressable as `existence::*` (main.rs wiring, tests).
pub use crate::existence_by_id::{
    amplifier_dir_locator, codex_rollout_existence_locator, AmplifierSessionLocator, ByIdAnswer,
    CodexRolloutExistenceLocator,
};
// Antigravity by-id locator (plan Task 7): same focused-sibling convention.
// The production wiring (main.rs) installs the AUTHORITY-LADDER locator
// (focused repair round 3, Major 1): by-id answers are rooted in the
// binary's own store, resolved per the operator-override /
// single-populated / dual-populated ladder (see
// antigravity_existence_by_id.rs). The single-root constructor's
// re-export is test-only (the existence/gate tests mirror one-store-root
// wirings over an already-resolved home).
#[cfg(test)]
pub use crate::antigravity_existence_by_id::antigravity_transcript_locator;
pub use crate::antigravity_existence_by_id::{
    antigravity_authority_root_locator, AntigravityTranscriptLocator,
};

pub struct IndexExistenceProbe {
    index: Arc<SessionIndex>,
    /// `provider:sessionId` keys ever seen in ANY snapshot this boot.
    observed: Mutex<HashSet<String>>,
    /// P1.8 (spec §4.2 read 2): the durable "ever bound by this server"
    /// memory — survives restarts, so a transcript deleted while the server
    /// was down yields loud dead_session, not silent fresh.
    ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
    /// Each known provider's session root on THIS machine (the same paths
    /// `main.rs` hands the index sources). A known provider whose root does
    /// not exist will never warm up — the cold-index answer for it is
    /// `ProviderUnavailable`, not the deferrable `Unknown`. A provider with
    /// no entry keeps the plain `Unknown` cold answer.
    provider_roots: HashMap<String, PathBuf>,
    /// Zero-turn claude fallback (kata 09v1): a claude transcript can be on
    /// disk yet index-invisible — no cwd-bearing line (the e2e sidecar's
    /// create-time 0-byte file; crash-window partial writes) — so the index's
    /// R10b gate excludes it and the warm snapshot answers a false Absent
    /// while the attach arm would attempt resume on it.
    /// When set, a warm-index Absent for provider "claude" is re-checked
    /// against raw file existence before being finalized. `None` (tests,
    /// callers that never set it) keeps the pure index answer.
    claude_transcript_locator: Option<ClaudeTranscriptLocator>,
    /// Opencode by-id fallback (rebind dead-session fix): a session row can
    /// be in opencode.db yet index-invisible — the listing filters
    /// `parent_id IS NULL` (children hidden), drops NULL/empty
    /// `directory` rows (some roots hidden), and excludes archived rows
    /// (which the attach arm still resolves) — so the warm snapshot answers
    /// a false Absent while the attach arm (`opencode --session <id>`)
    /// would resolve it. When set, a warm-index Absent for provider
    /// "opencode" is re-checked by id against the DB before being
    /// finalized. `None` (tests, callers that never set it) keeps the pure
    /// index answer.
    opencode_session_locator: Option<OpencodeSessionLocator>,
    /// Amplifier by-id fallback (resume-validation): the warm snapshot can be
    /// STALE — a session created moments before a restart may be missing —
    /// and it is `None` every boot while restore-time creates race the
    /// detached sweep. When set, a warm-index Absent for provider
    /// "amplifier" is re-checked by id on disk, and the COLD-index answer
    /// runs the same cheap check (the incident scenario). `None` keeps the
    /// pure index answer.
    amplifier_session_locator: Option<AmplifierSessionLocator>,
    /// Codex by-id fallback (resume-validation): warm-Absent adjudication
    /// ONLY, and only from `exists_for_gate` — the rollout walk is ~1s on a
    /// real store, so plain `exists()` (sync reconcile path, ~250ms budget)
    /// and the cold path never consult it (AD-4: cold codex stays
    /// `Unknown`). `None` keeps the pure index answer.
    codex_rollout_locator: Option<CodexRolloutExistenceLocator>,
    /// Antigravity by-id fallback (plan Task 7 + focused repair round 2,
    /// Major 1): the index's `AntigravitySource` drops transcripts whose
    /// ownership/workspace parse yields no row, so a conversation dir on
    /// disk can be index-invisible while the attach arm
    /// (`agy --conversation <id>`) would still resume it — the two arms
    /// must agree. The check is CHEAP (one `File::open` on the canonical
    /// `brain/<id>/.system_generated/logs/transcript.jsonl` path PER
    /// candidate root), so it lives on the sync warm-Absent adjudication
    /// path in `exists()` beside the amplifier/opencode arms (NOT the
    /// codex gate-only treatment — there is no ~1s walk to keep off the
    /// reconcile path) and improves pane-reconcile dead-session answers;
    /// since the resume-gate activation (2026-11-03) `exists_for_gate`
    /// ALSO consults it DIRECTLY to validate a warm-index Present and a
    /// cold-index Unknown before the gate trusts them (the gate block
    /// below). The PRODUCTION wiring (`main.rs`) installs the UNION-root
    /// locator: the seam resolves ONE root, but the binary's write root
    /// is not necessarily the seam's read root (the snap binary pins its
    /// store under `$HOME/snap` while the default root can also hold
    /// conversations), so a single-root walk would answer a false Absent
    /// for a valid conversation in the unselected root — a refusal the
    /// gate would turn into a false SESSION_MISSING. Found in ANY
    /// candidate root ⇒ Present; absent from ALL ⇒ Absent; unreadable
    /// somewhere with no hit ⇒ Unreadable (fail-open, G28). `None`
    /// (tests, callers that never set it) keeps the pure index answer.
    antigravity_transcript_locator: Option<AntigravityTranscriptLocator>,
}

impl IndexExistenceProbe {
    pub fn new(
        index: Arc<SessionIndex>,
        ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
        provider_roots: HashMap<String, PathBuf>,
    ) -> Self {
        Self {
            index,
            observed: Mutex::new(HashSet::new()),
            ledger,
            provider_roots,
            claude_transcript_locator: None,
            opencode_session_locator: None,
            amplifier_session_locator: None,
            codex_rollout_locator: None,
            antigravity_transcript_locator: None,
        }
    }

    /// Builder-style: install the raw-file fallback for claude (see the field
    /// doc). Chained at the single production construction site in main.rs.
    pub fn with_claude_transcript_locator(mut self, locator: ClaudeTranscriptLocator) -> Self {
        self.claude_transcript_locator = Some(locator);
        self
    }

    /// Builder-style: install the by-id sqlite fallback for opencode (see
    /// the field doc). Chained at the single production construction site
    /// in main.rs.
    pub fn with_opencode_session_locator(mut self, locator: OpencodeSessionLocator) -> Self {
        self.opencode_session_locator = Some(locator);
        self
    }

    /// Builder-style: install the by-id disk fallback for amplifier (see the
    /// field doc). Chained at the single production construction site in
    /// main.rs.
    pub fn with_amplifier_session_locator(mut self, locator: AmplifierSessionLocator) -> Self {
        self.amplifier_session_locator = Some(locator);
        self
    }

    /// Builder-style: install the by-id rollout fallback for codex (see the
    /// field doc). Chained at the single production construction site
    /// in main.rs.
    pub fn with_codex_rollout_locator(mut self, locator: CodexRolloutExistenceLocator) -> Self {
        self.codex_rollout_locator = Some(locator);
        self
    }

    /// Builder-style: install the by-id transcript fallback for
    /// antigravity (see the field doc). Chained at the single production
    /// construction site in main.rs.
    pub fn with_antigravity_transcript_locator(
        mut self,
        locator: AntigravityTranscriptLocator,
    ) -> Self {
        self.antigravity_transcript_locator = Some(locator);
        self
    }

    /// Kick a detached background refresh (never blocks the caller). No-op
    /// outside a tokio runtime — the WS handler always runs inside one.
    fn kick_refresh(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let index = Arc::clone(&self.index);
            handle.spawn(async move {
                let _ = index.snapshot().await;
            });
        }
    }

    fn record_observed(&self, items: &[freshell_sessions::directory_index::IndexedSession]) {
        let mut observed = self.observed.lock().expect("observed set lock");
        for item in items {
            observed.insert(item.key());
        }
    }

    /// Cold-path by-id adjudication shared by the amplifier/opencode/antigravity
    /// cold locators (kata vnpc Task 4): a by-id Present is disk truth (feed
    /// the monotone observed-set), a clean miss is positive Absent, and an
    /// unreadable store stays `Unknown` while the index is cold —
    /// pre-readiness uncertainty is warming (the scan may still speak),
    /// never the post-readiness `Unreadable`. The antigravity authority
    /// ladder's dual-root `Defer` (focused repair round 3, Major 1) maps
    /// fail-open exactly like `Unreadable` here: an ambiguous store must not
    /// adjudicate a found conversation dead OR present while cold.
    fn cold_by_id_to_existence(
        &self,
        provider: &str,
        session_id: &str,
        answer: ByIdAnswer,
    ) -> SessionExistence {
        match answer {
            ByIdAnswer::Present => {
                // On-disk observation — feed the monotone observed-set
                // (module-doc invariant).
                self.observed
                    .lock()
                    .expect("observed set lock")
                    .insert(format!("{provider}:{session_id}"));
                SessionExistence::Present
            }
            ByIdAnswer::Absent => SessionExistence::Absent,
            ByIdAnswer::Unreadable => SessionExistence::Unknown,
            ByIdAnswer::Defer => SessionExistence::Unknown,
        }
    }
}

/// Production opencode locator: by-id check against
/// `<data_home>/opencode.db` via
/// `freshell_sessions::parse::session_exists_by_id` — read-only open, 250ms
/// busy timeout (NOT the listing's 5000ms; `exists()` is sync on the
/// reconcile path), no archived/parent/directory filters (attach parity:
/// opencode's session.get has none of them). Missing DB file => `Absent`
/// (opencode never ran); any read error => `Unreadable` (kata vnpc Task 4:
/// the warm-miss arm surfaces it as `Unreadable`, the cold arm keeps the
/// honest `Unknown` warming label).
pub fn opencode_db_locator(data_home: PathBuf) -> OpencodeSessionLocator {
    Arc::new(move |session_id: &str| {
        match freshell_sessions::parse::session_exists_by_id(&data_home, session_id) {
            Ok(true) => OpencodeDbAnswer::Present,
            Ok(false) => OpencodeDbAnswer::Absent,
            Err(_) => OpencodeDbAnswer::Unreadable,
        }
    })
}

impl SessionExistenceProbe for IndexExistenceProbe {
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
        if !KNOWN_PROVIDERS.contains(&provider) {
            return SessionExistence::Absent;
        }
        // Provider-root presence check (kata vnpc round-3 finding 5 hoist):
        // a known provider whose session root does not exist on this
        // machine will NEVER warm up — that is an immediate, honest
        // ProviderUnavailable, on the COLD path AND the WARM path alike (a
        // published snapshot for a provider whose root is gone must not
        // adjudicate Absent — that would fold dead_session/fresh for an
        // uninstalled provider's recoverable identity). A provider with no
        // registered root keeps going.
        if self
            .provider_roots
            .get(provider)
            .is_some_and(|root| !root.exists())
        {
            return SessionExistence::ProviderUnavailable;
        }
        // Keep the answer converging: any non-fresh state kicks a detached
        // refresh so a re-query (the client's reconnect-and-re-present loop)
        // eventually reads current disk truth.
        if !self.index.is_fresh() {
            self.kick_refresh();
        }
        // Scan-failure honesty (kata vnpc Task 4, round-1 finding 3 +
        // round-2 finding 4): the rows AND the scan failures must come from
        // ONE generation — `peek_with_failures()` takes the snapshot mutex
        // once. Pairing `peek()` with a later `scan_failures()` read would
        // let a refresh publish between the two reads and tear the pair.
        match self.index.peek_with_failures() {
            None => {
                // Cold-index coverage (resume-validation, A1): the snapshot
                // is None every boot and the warm sweep is a detached spawn —
                // restore-time creates race it. amplifier + claude have CHEAP
                // direct by-id locators, and kata vnpc Task 4 added the same
                // for opencode (the SQLite by-id check) and antigravity (the
                // canonical transcript single-open) — run them so a known
                // identity resolves without waiting for the broad scan.
                // codex stays Unknown when cold (AD-4: the rollout walk is
                // ~1 s on a real store — warm-Absent adjudication only); with
                // the readiness-driven recovery (kata vnpc) codex panes park
                // briefly as error{index_warming} and resume automatically
                // when the first sweep publishes.
                if provider == "amplifier" {
                    if let Some(locator) = &self.amplifier_session_locator {
                        return self.cold_by_id_to_existence(
                            provider,
                            session_id,
                            locator(session_id),
                        );
                    }
                }
                if provider == "claude" {
                    // Reuse the EXISTING claude transcript locator (raw-file
                    // check — cheap), same mapping as the warm fallback
                    // below: hit => Present, clean miss => Absent, an
                    // unreadable store => Unknown while cold (G28: cannot
                    // check is the honest warming label pre-readiness,
                    // never a dead_session).
                    if let Some(locator) = &self.claude_transcript_locator {
                        return match locator(session_id) {
                            TranscriptLocation::Found(_) => {
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                SessionExistence::Present
                            }
                            TranscriptLocation::Absent => SessionExistence::Absent,
                            TranscriptLocation::Unreadable(_) => SessionExistence::Unknown,
                        };
                    }
                }
                if provider == "opencode" {
                    // Cheap cold by-id (kata vnpc Task 4): the same SQLite
                    // locator the warm-miss arm uses resolves a known
                    // identity without the broad scan. Unreadable stays
                    // Unknown while cold (warming is honest pre-readiness —
                    // the scan may still speak).
                    if let Some(locator) = &self.opencode_session_locator {
                        let answer = match locator(session_id) {
                            OpencodeDbAnswer::Present => ByIdAnswer::Present,
                            OpencodeDbAnswer::Absent => ByIdAnswer::Absent,
                            OpencodeDbAnswer::Unreadable => ByIdAnswer::Unreadable,
                        };
                        return self.cold_by_id_to_existence(provider, session_id, answer);
                    }
                }
                if provider == "antigravity" {
                    // Canonical transcript single-open check (kata vnpc
                    // Task 4), same locator as the warm-miss arm; matches
                    // the claude G28 cold-locator precedent.
                    if let Some(locator) = &self.antigravity_transcript_locator {
                        return self.cold_by_id_to_existence(
                            provider,
                            session_id,
                            locator(session_id),
                        );
                    }
                }
                SessionExistence::Unknown
            }
            Some((items, scan_failures)) => {
                self.record_observed(&items);
                let hit = items
                    .iter()
                    .any(|s| s.provider == provider && s.session_id == session_id);
                if hit {
                    return SessionExistence::Present;
                }
                // Set when a by-id fallback adjudicated this identity with a
                // definitive answer (a clean miss — a hit or an unreadable
                // store return immediately below). The fallback's answer is
                // the attach arm's own check, so it stays authoritative even
                // when the broad scan failed (kata vnpc Task 4).
                let mut fallback_adjudicated = false;
                // Zero-turn claude fallback (kata 09v1): a claude transcript
                // can be on disk yet carry no cwd-bearing line (e2e fixture's
                // create-time 0-byte file; crash-window partial writes), so
                // the index's R10b gate
                // (directory_index.rs::parse_claude_file) excludes it and the
                // warm snapshot answers a false Absent, while the attach arm
                // (claude.rs::handle_attach via
                // claude_snapshot::locate_transcript) trusts raw file
                // existence and attempts resume. The two arms must agree: before
                // finalizing Absent for claude, consult the SAME raw-file
                // check. CLAUDE-scoped only — zero-turn codex genuinely has
                // no rollout file (reconcile_freshagent.rs module doc) — and
                // R10b itself stays intact for History listing. An
                // unreadable store (G28) is `Unreadable` (kata vnpc Task 4:
                // reconcile surfaces the honest
                // error{session_store_unreadable}, identity preserved for a
                // later retry) — NEVER a finalized Absent.
                if provider == "claude" {
                    if let Some(locator) = &self.claude_transcript_locator {
                        match locator(session_id) {
                            TranscriptLocation::Found(_) => {
                                // A fallback hit is an on-disk observation:
                                // feed the monotone observed-set (module-doc
                                // invariant) so a LATER genuine deletion still
                                // derives loud dead_session even without the
                                // ledger.
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                return SessionExistence::Present;
                            }
                            TranscriptLocation::Absent => {
                                fallback_adjudicated = true;
                            }
                            TranscriptLocation::Unreadable(_) => {
                                return SessionExistence::Unreadable;
                            }
                        }
                    }
                }
                // Opencode by-id fallback (rebind dead-session fix): the
                // index listing is root-filtered (`parent_id IS NULL`,
                // parse/opencode.rs) and drops directory-less rows, so a
                // rebound CHILD session id — or a cwd-less root — is
                // DB-present yet index-invisible and the warm snapshot
                // answers a false Absent, while the attach arm
                // (`opencode --session <id>` -> session.get by id, no
                // parent/directory/archived filters) resolves it. The two
                // arms must agree: before finalizing Absent for
                // opencode, consult the SAME by-id DB truth. An unreadable
                // DB (WAL lock contention, corruption) is honest
                // `Unreadable` (kata vnpc Task 4: reconcile surfaces
                // error{session_store_unreadable}) — NEVER Absent. The
                // listing's root-only query itself stays intact for History.
                if provider == "opencode" {
                    if let Some(locator) = &self.opencode_session_locator {
                        match locator(session_id) {
                            OpencodeDbAnswer::Present => {
                                // A fallback hit is an on-disk observation:
                                // feed the monotone observed-set (module-doc
                                // invariant), same as the claude arm above.
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                return SessionExistence::Present;
                            }
                            OpencodeDbAnswer::Unreadable => {
                                return SessionExistence::Unreadable;
                            }
                            OpencodeDbAnswer::Absent => {
                                fallback_adjudicated = true;
                            }
                        }
                    }
                }
                // Amplifier by-id fallback (resume-validation): a STALE warm
                // snapshot must never adjudicate a real session absent — a
                // session created moments before a restart may be missing
                // from the snapshot, and `peek_with_failures()` serves
                // snapshots regardless of TTL. Same adjudication point as
                // the claude/opencode fallbacks above: only reached when the
                // snapshot would otherwise answer Absent. The scan is CHEAP
                // (one read_dir + one metadata per project slug), so it
                // stays on this sync reconcile-consulted path. After this
                // arm, `Absent` for claude/opencode/amplifier is POSITIVE
                // absence; codex `Absent` from `exists()` is SNAPSHOT-ONLY
                // (non-positive) — the ~1s rollout walk lives in
                // `exists_for_gate` (below), so positive codex absence is
                // the gate variant's job.
                if provider == "amplifier" {
                    if let Some(locator) = &self.amplifier_session_locator {
                        match locator(session_id) {
                            ByIdAnswer::Present => {
                                // A fallback hit is an on-disk observation:
                                // feed the monotone observed-set (module-doc
                                // invariant), same as the arms above.
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                return SessionExistence::Present;
                            }
                            ByIdAnswer::Unreadable => return SessionExistence::Unreadable,
                            // Never produced by the amplifier locator; mapped
                            // fail-open exactly like an unreadable store if a
                            // future locator ever emits it.
                            ByIdAnswer::Defer => return SessionExistence::Unreadable,
                            ByIdAnswer::Absent => {
                                fallback_adjudicated = true;
                            }
                        }
                    }
                }
                // Antigravity by-id fallback (plan Task 7): before
                // finalizing Absent for antigravity, re-check the SAME
                // canonical transcript path the attach arm
                // (`agy --conversation <id>`) resolves — the index's
                // AntigravitySource drops parse-failed transcripts (no
                // ownership record, no usable workspace path), so a
                // conversation dir on disk can be index-invisible yet
                // resumable. CHEAP single-open check per resolved authority
                // root (the amplifier/opencode class, NOT codex's gate-only
                // ~1s walk; the round-3 authority ladder adds two cheap
                // brain/ readdirs for the population probe), so it stays on
                // this sync reconcile-consulted path and improves
                // pane-reconcile dead-session answers; since the
                // resume-gate activation (2026-11-03) `exists_for_gate`
                // ALSO consults it directly (the gate block below), so
                // after this arm `Absent` for antigravity is POSITIVE
                // absence for BOTH callers. An unreadable store is
                // honest `Unreadable` (kata vnpc Task 4:
                // error{session_store_unreadable}), NEVER Absent —
                // and so is the ladder's dual-root Defer (focused repair
                // round 3, Major 1): an ambiguous store must not adjudicate
                // a found conversation dead OR present; the binary decides.
                if provider == "antigravity" {
                    if let Some(locator) = &self.antigravity_transcript_locator {
                        match locator(session_id) {
                            ByIdAnswer::Present => {
                                // A fallback hit is an on-disk observation:
                                // feed the monotone observed-set (module-doc
                                // invariant), same as the arms above.
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                return SessionExistence::Present;
                            }
                            ByIdAnswer::Unreadable => return SessionExistence::Unreadable,
                            // Dual-root defer (round 3, Major 1): the id was
                            // found but the store-root authority is ambiguous —
                            // the same honest unreadable-store deferral
                            // (identity preserved, retryable), never a
                            // finalized Absent that could adjudicate a live
                            // conversation dead, never a wrong-root Present.
                            ByIdAnswer::Defer => return SessionExistence::Unreadable,
                            ByIdAnswer::Absent => {
                                fallback_adjudicated = true;
                            }
                        }
                    }
                }
                // Scan-failure honesty (kata vnpc Task 4, round-1 finding 3
                // + round-2 finding 4): a warm miss for a provider whose
                // listing failed in THIS generation is the honest
                // `Unreadable` (→ error{session_store_unreadable}), never a
                // snapshot-only Absent — a failed codex root scan publishing
                // an empty snapshot must not fold dead_session/fresh for a
                // recoverable identity. A by-id fallback's definitive answer
                // (tracked above) stays authoritative: the fallback is the
                // attach arm's own fresh, targeted check.
                if !fallback_adjudicated && scan_failures.iter().any(|name| name == provider) {
                    return SessionExistence::Unreadable;
                }
                // After the antigravity arm, `Absent` for
                // claude/opencode/amplifier/antigravity is POSITIVE absence.
                SessionExistence::Absent
            }
        }
    }

    fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
        if self
            .observed
            .lock()
            .expect("observed set lock")
            .contains(&format!("{provider}:{session_id}"))
        {
            return true;
        }
        self.ledger
            .as_ref()
            .is_some_and(|ledger| ledger.ever_bound(provider, session_id))
    }

    fn ever_observed_on_disk(&self, provider: &str, session_id: &str) -> bool {
        self.observed
            .lock()
            .expect("observed set lock")
            .contains(&format!("{provider}:{session_id}"))
    }

    /// Gate-caller variant (trait doc): `exists()` plus (a) the EXPENSIVE
    /// codex by-id rollout walk (~1s on a real store) on a warm-Absent
    /// answer, and (b) the antigravity Present/Unknown/ProviderUnavailable
    /// disk validation (see the gate block below — activated 2026-11-03).
    /// The expensive work lives HERE and not in `exists()` because
    /// `exists()` is consulted inline on the sync reconcile path, whose IO
    /// discipline is ~250ms per consult (see `opencode_db_locator`); gate
    /// callers run this variant inside `tokio::task::spawn_blocking` (A13:
    /// never inline on the async runtime). AD-4 is preserved exactly:
    /// cold-index codex answers `Unknown` from `exists()`, and the walk
    /// only runs on `Absent`, so it still NEVER runs on the cold path.
    fn exists_for_gate(&self, provider: &str, session_id: &str) -> SessionExistence {
        let base = self.exists(provider, session_id);
        // Antigravity gate validation (activated 2026-11-03 on real-binary
        // transcript evidence (2026-11-02) + a proven settings-conformant
        // real resume (2026-11-03; real-binary-transcript-evidence.md)):
        // neither a warm-index hit nor a cold-index Unknown is sufficient
        // evidence for the resume gate — the index can be stale for a
        // conversation deleted from disk, and the cold window precedes
        // every warm-up, while the CLI's documented missing-ID behavior
        // silently starts a FRESH conversation (GC3 violation). The SAME
        // hole holds for ProviderUnavailable (GC3 hole #3, focused review
        // round 1): a cold index over a MISSING store root answers it from
        // the root-existence pre-check, and passing it through fails open
        // (map_existence → Unknown → Proceed) straight into the CLI's
        // silent fresh conversation. Validate all three against the same
        // on-disk by-id walk the Absent arm uses — the production locator
        // is the AUTHORITY LADDER (focused repair round 3, Major 1): by-id
        // answers are rooted in the binary's own store (operator override;
        // the single conversation-bearing candidate; the dual-populated
        // defer), so the ladder never answers Present for an id the
        // resolved authority root cannot resume: disk Present confirms
        // (and feeds the observed set — module-doc invariant), disk Absent
        // corrects to Absent (typed refusal — the resolved authority's
        // `File::open`s give NotFound, positive absence), disk Unreadable
        // defers as Unknown (G28 fail-open), and the dual-root Defer
        // defers as Unknown too (the binary's own missing-ID warning is
        // visible in the pane — the documented pre-gate behavior, never a
        // silent substitution). Absent itself needs no re-check — the
        // warm-Absent arm at exists() already disk-verified it.
        // Kata vnpc merge note: `Unreadable` joins the validation set —
        // main's post-readiness honest-error label (which the merged
        // exists() now also mints for the dual-root Defer) is exactly the
        // class of non-definitive answer this block exists to re-check, and
        // the ladder's own gate mapping restores the fail-open Unknown the
        // gate contract pins (map_existence treats both as Proceed either
        // way; the re-check keeps the probe-level answer honest AND
        // defer-shaped).
        if provider == "antigravity" {
            if let Some(locator) = &self.antigravity_transcript_locator {
                match base {
                    SessionExistence::Present
                    | SessionExistence::Unknown
                    | SessionExistence::ProviderUnavailable
                    | SessionExistence::Unreadable => {
                        return match locator(session_id) {
                            ByIdAnswer::Present => {
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                SessionExistence::Present
                            }
                            ByIdAnswer::Absent => SessionExistence::Absent,
                            ByIdAnswer::Unreadable => SessionExistence::Unknown,
                            // Dual-root defer (round 3, Major 1): found on
                            // disk, but the binary's read root is ambiguous
                            // — Unknown defers to the CLI (fail-open), never
                            // a wrong-root Present, never a typed refusal.
                            ByIdAnswer::Defer => SessionExistence::Unknown,
                        };
                    }
                    _ => {}
                }
            }
        }
        if base == SessionExistence::Absent && provider == "codex" {
            if let Some(locator) = &self.codex_rollout_locator {
                return match locator(session_id) {
                    ByIdAnswer::Present => {
                        // A fallback hit is an on-disk observation: feed the
                        // monotone observed-set (module-doc invariant), same
                        // as the fallback arms in `exists()`.
                        self.observed
                            .lock()
                            .expect("observed set lock")
                            .insert(format!("{provider}:{session_id}"));
                        SessionExistence::Present
                    }
                    ByIdAnswer::Unreadable => SessionExistence::Unknown,
                    // Never produced by the codex locator; mapped fail-open
                    // like Unreadable if ever emitted.
                    ByIdAnswer::Defer => SessionExistence::Unknown,
                    ByIdAnswer::Absent => SessionExistence::Absent,
                };
            }
        }
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_sessions::directory_index::{
        ClaudeSource, DirectToken, FileStat, IndexedSession, OpencodeSource, SessionSource,
    };
    use std::time::Duration;

    pub(super) fn temp_claude_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "freshell-existence-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("projects/proj")).expect("mkdir claude home");
        dir
    }

    /// A temp ANTIGRAVITY home (the `antigravity-cli` subtree) with one
    /// canonical `brain/<conv>/.system_generated/logs/transcript.jsonl`
    /// seeded from the committed fresh fixture. Returns `(home, conv_id)`.
    fn temp_antigravity_home(tag: &str) -> (std::path::PathBuf, &'static str) {
        let home = std::env::temp_dir().join(format!(
            "freshell-existence-agy-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        const CONV: &str = "11111111-2222-3333-4444-555555555555";
        let logs = home
            .join("brain")
            .join(CONV)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&logs).expect("mkdir antigravity brain");
        let fixture = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/fixtures/coding-cli/antigravity/fresh.sanitized.jsonl"),
        )
        .expect("read antigravity fixture");
        std::fs::write(logs.join("transcript.jsonl"), fixture).expect("write transcript");
        (home, CONV)
    }

    /// The probe over a REAL `AntigravitySource` with the antigravity root
    /// registered (the `main.rs` wiring shape: the resolved antigravity
    /// home, so a missing home answers `ProviderUnavailable` when cold).
    fn antigravity_probe(home: std::path::PathBuf) -> (IndexExistenceProbe, Arc<SessionIndex>) {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![
                Arc::new(freshell_sessions::antigravity::AntigravitySource::new(
                    home.clone(),
                )) as Arc<dyn SessionSource>,
            ],
            Duration::from_millis(50),
            None,
        ));
        (
            IndexExistenceProbe::new(
                Arc::clone(&index),
                None,
                HashMap::from([("antigravity".to_string(), home)]),
            ),
            index,
        )
    }

    pub(super) fn write_session(claude_home: &std::path::Path, session_id: &str) {
        // Minimal claude transcript that passes the R10b cwd gate: one line
        // carrying `cwd` + timestamps; the file stem is the session id.
        let line = serde_json::json!({
            "type": "user",
            "message": "hello",
            "uuid": "msg-1",
            "cwd": "/tmp/proj",
            "timestamp": "2026-07-22T10:00:00.000Z"
        });
        std::fs::write(
            claude_home
                .join("projects/proj")
                .join(format!("{session_id}.jsonl")),
            format!("{line}\n"),
        )
        .expect("write session fixture");
    }

    pub(super) fn probe_over(home: &std::path::Path) -> (IndexExistenceProbe, Arc<SessionIndex>) {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(home.to_path_buf())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None, // no persistent parse-cache — fully isolated temp home
        ));
        (
            IndexExistenceProbe::new(
                Arc::clone(&index),
                None,
                HashMap::from([("claude".to_string(), home.to_path_buf())]),
            ),
            index,
        )
    }

    /// Construct a probe exactly as `main.rs` does — over an index whose
    /// provider home is an EMPTY temp dir (the transcript is gone) — with the
    /// given ledger handle. The home leaks intentionally: it's a per-test
    /// unique temp path and the OS temp cleaner owns it.
    fn new_test_probe_with_ledger(
        ledger: Option<std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>>,
    ) -> IndexExistenceProbe {
        let home = temp_claude_home("with-ledger");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        IndexExistenceProbe::new(index, ledger, HashMap::from([("claude".to_string(), home)]))
    }

    /// A zero-turn claude transcript as the E2E FIXTURE constructs it at
    /// session create: 0 bytes, no cwd-bearing line, fails the index's R10b
    /// gate. (Validated against claude CLI 2.1.220: the REAL CLI materializes
    /// the transcript only at first turn and rejects resume of a 0-byte file;
    /// this shape stands in for the broader on-disk-but-R10b-excluded class,
    /// e.g. crash-window partial transcripts. See the plan's Validated-reality
    /// note: the invariant is arm-agreement, not resumability.)
    fn write_zero_turn_session(claude_home: &std::path::Path, session_id: &str) {
        std::fs::write(
            claude_home
                .join("projects/proj")
                .join(format!("{session_id}.jsonl")),
            "",
        )
        .expect("write zero-turn fixture");
    }

    /// Test locator with the SAME contract as
    /// claude_snapshot::locate_transcript_state (Found(path) iff the
    /// transcript file exists, else a clean Absent), scoped to the temp home
    /// so tests never touch process-global CLAUDE_* env vars.
    pub(super) fn direct_locator_over(home: &std::path::Path) -> ClaudeTranscriptLocator {
        let projects = home.join("projects/proj");
        Arc::new(move |session_id: &str| {
            let p = projects.join(format!("{session_id}.jsonl"));
            if p.is_file() {
                TranscriptLocation::Found(p)
            } else {
                TranscriptLocation::Absent
            }
        })
    }

    /// Kata 09v1 RED: a zero-turn claude transcript (0-byte file, on disk from
    /// session create in the fixture) must answer Present, never Absent — the
    /// attach arm would attempt resume on it, so reconcile must not
    /// adjudicate it dead. Today the R10b
    /// cwd gate excludes it from the index and the warm snapshot answers a
    /// false Absent.
    #[tokio::test]
    async fn zero_turn_claude_transcript_on_disk_is_present_not_absent() {
        let home = temp_claude_home("zero-turn");
        let session_id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        write_zero_turn_session(&home, session_id);
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present,
            "the file exists on disk (the attach arm would attempt resume) — \
             the probe must agree with the raw-file check, not the R10b-gated index"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Fallback-Present feeds the monotone observed-set (module-doc invariant:
    /// every read that sees the identity on disk records it), so a LATER
    /// genuine deletion still derives loud dead_session even without a ledger.
    #[tokio::test]
    async fn fallback_present_feeds_ever_observed() {
        let home = temp_claude_home("fallback-observed");
        let session_id = "2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182";
        write_zero_turn_session(&home, session_id);
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present
        );
        assert!(
            probe.ever_observed("claude", session_id),
            "a fallback hit is an on-disk observation and must feed ever_observed"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// HAZARD GUARD (must not regress): a transcript GENUINELY absent from
    /// disk stays Absent even with the locator installed — the fallback must
    /// never weaken positive denial. (The Absent + ever_observed ⇒
    /// dead_session derivation itself stays pinned by the existing
    /// `ever_observed_survives_a_restart_via_the_ledger` here, reconcile.rs's
    /// `row4_absent_but_ever_observed_yields_dead_session`, and
    /// reconcile_freshagent.rs's `gone_observed_maps_to_dead_session_not_on_disk`.)
    #[tokio::test]
    async fn genuinely_missing_transcript_stays_absent_with_locator_installed() {
        let home = temp_claude_home("hazard-guard");
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"),
            SessionExistence::Absent,
            "no transcript anywhere: warm-index Absent AND raw-file miss ⇒ Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A locator whose store cannot be read (EACCES/EIO on `projects/`).
    fn unreadable_locator() -> ClaudeTranscriptLocator {
        Arc::new(|_sid: &str| {
            TranscriptLocation::Unreadable(freshell_freshagent::LocateError::Io {
                root: std::path::PathBuf::from("/claude-store"),
                kind: std::io::ErrorKind::PermissionDenied,
                message: "permission denied".to_string(),
            })
        })
    }

    /// G28 (warm path, kata vnpc Task 4): an index-Absent claude session
    /// whose raw-file recheck cannot READ the store is `Unreadable` — the
    /// honest error{session_store_unreadable} verdict (post-readiness, an
    /// unreadable store is NOT warming) — never a finalized `Absent` that
    /// can derive dead_session. Pre-change this answered `Unknown`.
    #[tokio::test]
    async fn warm_unreadable_claude_store_answers_unreadable_not_absent() {
        let home = temp_claude_home("warm-unreadable");
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(unreadable_locator());
        index.warm().await;
        assert_eq!(
            probe.exists("claude", "6f708192-a3b4-4cc5-8d6e-7f8091021323"),
            SessionExistence::Unreadable,
            "cannot check the transcript store => the honest unreadable-store error, \
             never absence and never a lying warming label"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// G28 (cold path): the cold-index claude by-id check answers `Unknown`
    /// for an unreadable store, never `Absent`. Plain #[test] (no tokio
    /// runtime) so kick_refresh no-ops and the index stays cold.
    #[test]
    fn cold_index_with_an_unreadable_store_is_unknown_not_absent() {
        let home = temp_claude_home("cold-unreadable");
        let (probe, _index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(unreadable_locator());
        assert_eq!(
            probe.exists("claude", "708192a3-b4c5-4dd6-8e7f-809102132434"),
            SessionExistence::Unknown,
            "cannot check the transcript store => cannot adjudicate absence"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The fallback is CLAUDE-scoped: zero-turn codex genuinely has no rollout
    /// file (vendor deferred materialization — reconcile_freshagent.rs module
    /// doc), so a codex Absent must stay Absent even when the installed
    /// locator would answer Some for any id.
    #[tokio::test]
    async fn codex_absent_never_consults_the_claude_locator() {
        let home = temp_claude_home("codex-gate");
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(Arc::new(|_sid: &str| {
            TranscriptLocation::Found(std::path::PathBuf::from("/nonexistent/never-used.jsonl"))
        }));
        index.warm().await;
        assert_eq!(
            probe.exists("codex", "thread-1"),
            SessionExistence::Absent,
            "the raw-file fallback is provider-gated to claude only"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ever_observed_survives_a_restart_via_the_ledger() {
        // Spec §4.2 read 2: a transcript deleted while the server was DOWN
        // must yield loud dead_session, not silent fresh. The per-boot
        // observed set is empty after a restart — the ledger is the durable
        // memory. (The Absent+ever_observed => dead_session derivation is
        // already pinned by reconcile.rs's
        // `row4_absent_but_ever_observed_yields_dead_session`; this test
        // covers the INPUT seam.)
        let dir = std::env::temp_dir().join(format!(
            "ledger-everobs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let ledger =
            std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone())));
        // "Generation 1" bound this identity durably.
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: "11111111-2222-3333-4444-555555555555",
                terminal_id: "t1",
                mode: "claude",
                cwd: None,
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                observed_epoch: None,
                observed_generation: None,
                now_ms: 1_000,
            })
            .unwrap();

        // "Generation 2": a brand-new probe with an EMPTY observed set —
        // construct it exactly as main.rs does, over an index whose
        // provider home is an empty temp dir (the transcript is gone).
        let probe = new_test_probe_with_ledger(Some(std::sync::Arc::clone(&ledger)));
        assert!(
            probe.ever_observed("claude", "11111111-2222-3333-4444-555555555555"),
            "durable ledger memory answers across restarts"
        );
        assert!(!probe.ever_observed("claude", "99999999-2222-3333-4444-555555555555"));

        // Without a ledger, the old per-boot behavior is preserved.
        let bare = new_test_probe_with_ledger(None);
        assert!(!bare.ever_observed("claude", "11111111-2222-3333-4444-555555555555"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// PIN 1 (claude never-conversed carve-out): "seen on disk" is a strictly
    /// stronger fact than "ever bound". A ledger binding proves the identity
    /// was minted at create — NOT that a transcript ever existed. The
    /// carve-out keys on disk observation, so ever_bound alone must not
    /// count.
    #[test]
    fn ever_observed_on_disk_excludes_ledger_only_bindings() {
        let dir = std::env::temp_dir().join(format!(
            "ledger-everobs-disk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let ledger =
            std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone())));
        // "Generation 1" bound this identity durably.
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: "11111111-2222-3333-4444-555555555555",
                terminal_id: "t1",
                mode: "claude",
                cwd: None,
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                observed_epoch: None,
                observed_generation: None,
                now_ms: 1_000,
            })
            .unwrap();

        // "Generation 2": a brand-new probe with an EMPTY observed set —
        // construct it exactly as main.rs does, over an index whose
        // provider home is an empty temp dir (the transcript is gone).
        let probe = new_test_probe_with_ledger(Some(std::sync::Arc::clone(&ledger)));
        let session_id = "11111111-2222-3333-4444-555555555555";
        assert!(probe.ever_observed("claude", session_id)); // via ledger — unchanged
        assert!(!probe.ever_observed_on_disk("claude", session_id)); // NEW: ledger does not count
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A genuine on-disk observation (index snapshot or locator-fallback hit)
    /// counts for BOTH ever_observed and ever_observed_on_disk.
    #[tokio::test]
    async fn ever_observed_on_disk_true_after_disk_observation() {
        let home = temp_claude_home("disk-observed");
        let session_id = "3c4d5e6f-7081-4a92-8b3c-4d5e6f708192";
        write_zero_turn_session(&home, session_id);
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present
        );
        assert!(probe.ever_observed_on_disk("claude", session_id));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_provider_is_absent_never_unknown() {
        let home = temp_claude_home("unknown-provider");
        let (probe, _index) = probe_over(&home);
        assert_eq!(
            probe.exists("not-a-provider", "s1"),
            SessionExistence::Absent
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn cold_index_is_unknown_for_known_provider() {
        let home = temp_claude_home("cold");
        let (probe, _index) = probe_over(&home);
        // Nothing published yet — honest Unknown, never a guessed Absent.
        assert_eq!(probe.exists("claude", "s-cold"), SessionExistence::Unknown);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A known provider whose session root does NOT exist on this machine
    /// will never warm up — the probe answers `ProviderUnavailable`, not the
    /// deferrable `Unknown`.
    #[tokio::test]
    async fn missing_provider_root_is_provider_unavailable_not_unknown() {
        let home = temp_claude_home("root-missing");
        let gone = home.join("never-created-claude-root");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(gone.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        let probe = IndexExistenceProbe::new(
            index,
            None,
            std::collections::HashMap::from([("claude".to_string(), gone)]),
        );
        assert_eq!(
            probe.exists("claude", "s-any"),
            SessionExistence::ProviderUnavailable
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The counterpart boundary: the root EXISTS but the index is still cold
    /// → `Unknown` (warming), unchanged by the ProviderUnavailable check.
    #[tokio::test]
    async fn existing_but_cold_provider_root_stays_unknown() {
        let home = temp_claude_home("root-cold");
        let (probe, _index) = probe_over(&home);
        assert_eq!(probe.exists("claude", "s-cold"), SessionExistence::Unknown);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── Kata vnpc Task 4: cold by-id locators + scan-failure honesty ──────

    /// AD-4 stands: codex has NO cold locator — the ~1s sync rollout walk
    /// remains too expensive for the per-pane sync derive path. With the
    /// readiness-driven recovery (kata vnpc) codex panes park briefly as
    /// error{index_warming} and resume automatically when the first sweep
    /// publishes; `Unknown` is the honest cold label.
    #[test]
    fn codex_stays_unknown_when_cold_ad4_stands() {
        let index_home = temp_claude_home("cold-codex-ad4");
        let codex_root = index_home.join("codex-sessions");
        std::fs::create_dir_all(&codex_root).expect("mkdir codex root");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(index_home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        let probe = IndexExistenceProbe::new(
            index,
            None,
            HashMap::from([("codex".to_string(), codex_root)]),
        );
        // A chained gate locator proves the cold path never consults it.
        let probe = probe.with_codex_rollout_locator(Arc::new(|_sid: &str| ByIdAnswer::Present));
        assert_eq!(
            probe.exists("codex", "thread-cold"),
            SessionExistence::Unknown,
            "cold codex stays Unknown — no cold codex locator was added (AD-4)"
        );
        let _ = std::fs::remove_dir_all(&index_home);
    }

    /// Cold index + the opencode by-id locator: a seeded `opencode.db` row
    /// resolves Present WITHOUT waiting for the broad scan (the same G28
    /// precedent as the claude cold transcript check); a missing row is
    /// positive Absent. Plain #[test] (no tokio runtime) so kick_refresh
    /// no-ops and the index deterministically stays cold.
    #[test]
    fn cold_opencode_resolves_by_id_without_waiting_for_the_scan() {
        // (a) seeded row => Present.
        let home = temp_opencode_data_home("cold-by-id-present");
        seed_opencode_db(
            &home,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let (probe, _index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        assert_eq!(
            probe.exists("opencode", "ses_root0000000000000000000000"),
            SessionExistence::Present,
            "cold index + seeded DB row => Present via the cheap by-id locator"
        );
        assert!(
            probe.ever_observed("opencode", "ses_root0000000000000000000000"),
            "a cold by-id hit is an on-disk observation and must feed ever_observed"
        );
        let _ = std::fs::remove_dir_all(&home);

        // (b) missing row in a readable DB => positive Absent.
        let home = temp_opencode_data_home("cold-by-id-absent");
        seed_opencode_db(
            &home,
            &[(
                "ses_other0000000000000000000000",
                Some("/tmp/p"),
                None,
                None,
            )],
        );
        let (probe, _index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        assert_eq!(
            probe.exists("opencode", "ses_missing0000000000000000000"),
            SessionExistence::Absent,
            "cold index + readable DB without the row => positive Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Cold index + the opencode by-id locator hitting an UNREADABLE store
    /// stays `Unknown` — pre-readiness uncertainty is warming (the scan may
    /// still speak), NEVER `Unreadable` (the post-readiness honest error).
    /// Root-proof unreadable seeding (ledger C4a): a DIRECTORY at the
    /// `opencode.db` path — SQLite's `Connection::open` fails on a directory
    /// for ANY euid. (Do NOT seed a directory at a claude transcript path:
    /// the claude locator is metadata-based and a directory is a clean MISS
    /// => Absent — ledger C4b, a different verdict path, never Unreadable.)
    #[test]
    fn cold_unreadable_locator_stays_unknown_warming_is_honest_pre_readiness() {
        let good = temp_opencode_data_home("cold-unreadable-good");
        seed_opencode_db(
            &good,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let broken = temp_opencode_data_home("cold-unreadable-broken");
        std::fs::create_dir_all(broken.join("opencode.db")).expect("mkdir dir-as-db");
        let (probe, _index) = opencode_probe_over(&good);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(broken.clone()));
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Unknown,
            "cold + unreadable store => warming is the honest label pre-readiness"
        );
        let _ = std::fs::remove_dir_all(&good);
        let _ = std::fs::remove_dir_all(&broken);
    }

    /// Cold index + the antigravity canonical-transcript locator: a
    /// conversation on disk resolves Present, a missing one is positive
    /// Absent, and an unreadable path stays `Unknown` while cold (warming
    /// is the honest pre-readiness label). The unreadable seeding is
    /// root-proof: `.system_generated` as a regular FILE makes the
    /// transcript path fail with ENOTDIR (not NotFound) for ANY euid.
    #[test]
    fn cold_antigravity_resolves_by_transcript_path_without_waiting_for_the_scan() {
        let home = temp_claude_home("cold-agy-locator");
        let agy_home = home.join("antigravity-home");
        let conv = "33333333-4444-5555-6666-777777777777";
        let logs = agy_home
            .join("brain")
            .join(conv)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&logs).expect("mkdir antigravity brain");
        std::fs::write(logs.join("transcript.jsonl"), "{\"v\":1}\n").expect("write transcript");

        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        let probe = IndexExistenceProbe::new(
            index,
            None,
            HashMap::from([("antigravity".to_string(), agy_home.clone())]),
        )
        .with_antigravity_transcript_locator(antigravity_transcript_locator(agy_home.clone()));

        assert_eq!(
            probe.exists("antigravity", conv),
            SessionExistence::Present,
            "cold index + canonical transcript on disk => Present via the cheap by-id locator"
        );
        assert!(
            probe.ever_observed("antigravity", conv),
            "a cold by-id hit is an on-disk observation and must feed ever_observed"
        );
        assert_eq!(
            probe.exists("antigravity", "00000000-1111-2222-3333-444444444444"),
            SessionExistence::Absent,
            "cold index + readable store without the conversation => positive Absent"
        );

        // Unreadable: `.system_generated` as a FILE — the canonical path
        // beneath it fails with ENOTDIR (never NotFound) for any euid.
        let unreadable_home = home.join("antigravity-unreadable");
        std::fs::create_dir_all(unreadable_home.join("brain").join(conv))
            .expect("mkdir brain conversation");
        std::fs::write(
            unreadable_home
                .join("brain")
                .join(conv)
                .join(".system_generated"),
            "not a directory",
        )
        .expect("seed ENOTDIR component");
        let probe_unreadable = IndexExistenceProbe::new(
            Arc::new(SessionIndex::with_ttl_and_cache_path(
                vec![Arc::new(ClaudeSource::new(home.clone())) as Arc<dyn SessionSource>],
                Duration::from_millis(50),
                None,
            )),
            None,
            HashMap::from([("antigravity".to_string(), unreadable_home.clone())]),
        )
        .with_antigravity_transcript_locator(antigravity_transcript_locator(
            unreadable_home.clone(),
        ));
        assert_eq!(
            probe_unreadable.exists("antigravity", conv),
            SessionExistence::Unknown,
            "cold + unreadable transcript path => warming is the honest label pre-readiness"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Round-1 finding 3 + round-2 finding 4 (scan-failure honesty): the
    /// sweep publishes with `scan_failures` naming codex and no codex rows;
    /// a codex session warm-miss must answer `Unreadable`
    /// (→ error{session_store_unreadable}), NEVER the snapshot-only Absent
    /// that would fold dead_session/fresh for a recoverable identity. The
    /// rows AND the failures come from ONE `peek_with_failures()` read
    /// (same generation). A provider NOT named in this generation's
    /// failures keeps the honest warm-miss Absent (provider-scoped).
    #[tokio::test]
    async fn warm_codex_miss_with_a_failed_codex_scan_answers_unreadable_never_absent() {
        struct FailingCodexSource(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl SessionSource for FailingCodexSource {
            fn discover(&self) -> Vec<FileStat> {
                Vec::new()
            }
            fn parse(&self, _p: &std::path::Path) -> Option<IndexedSession> {
                None
            }
            fn provider_name(&self) -> Option<&'static str> {
                Some("codex")
            }
            fn direct_change_token(&self) -> Option<DirectToken> {
                Some(DirectToken {
                    mtime_ns: 42,
                    size: 0,
                })
            }
            fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
                if self.0.load(std::sync::atomic::Ordering::SeqCst) {
                    Err("codex root: permission denied".to_string())
                } else {
                    Ok(Vec::new())
                }
            }
            fn direct_health_check(&self) -> Result<(), String> {
                if self.0.load(std::sync::atomic::Ordering::SeqCst) {
                    Err("codex root: permission denied".to_string())
                } else {
                    Ok(())
                }
            }
        }

        let home = temp_claude_home("codex-scan-failure");
        let codex_root = home.join("codex-sessions");
        std::fs::create_dir_all(&codex_root).expect("mkdir codex root");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(FailingCodexSource(std::sync::Arc::new(
                std::sync::atomic::AtomicBool::new(true),
            ))) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        let probe = IndexExistenceProbe::new(
            Arc::clone(&index),
            None,
            HashMap::from([
                ("claude".to_string(), home.clone()),
                ("codex".to_string(), codex_root),
            ]),
        );
        // The sweep publishes the failed generation: empty items +
        // scan_failures ["codex"].
        index.warm().await;
        assert_eq!(
            probe.exists("codex", "thread-recoverable"),
            SessionExistence::Unreadable,
            "a warm miss for a provider whose scan failed in THIS generation \
             is the honest unreadable-store error — never the Absent that \
             would fold dead_session/fresh for a recoverable identity"
        );
        // Provider-scoped: claude is not named in this generation's
        // failures, so a claude warm-miss keeps the honest Absent.
        assert_eq!(
            probe.exists("claude", "no-such-session"),
            SessionExistence::Absent,
            "a provider whose scan succeeded keeps positive-absence semantics"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Round-3 finding 5 (root-check hoist): the provider-root presence
    /// check holds on the WARM path — a published snapshot with no rows for
    /// a provider whose root is gone answers ProviderUnavailable, never the
    /// Absent that would fold dead_session/fresh for an uninstalled
    /// provider's recoverable identity.
    #[tokio::test]
    async fn warm_index_with_a_missing_provider_root_answers_provider_unavailable_never_absent() {
        let home = temp_claude_home("warm-missing-root");
        let session_id = "8a9b0c1d-2e3f-4a5b-8c9d-0e1f2a3b4c5d";
        write_session(&home, session_id);
        let gone_codex_root = home.join("codex-root-never-created");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        let probe = IndexExistenceProbe::new(
            Arc::clone(&index),
            None,
            HashMap::from([
                ("claude".to_string(), home.clone()),
                ("codex".to_string(), gone_codex_root),
            ]),
        );
        index.warm().await;
        // Control: the provider whose root exists still answers from the
        // warm snapshot.
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present
        );
        // The hoist: a WARM miss for a provider whose root is gone is the
        // immediate, honest ProviderUnavailable — never Absent.
        assert_eq!(
            probe.exists("codex", "thread-any"),
            SessionExistence::ProviderUnavailable,
            "a warm published snapshot must not adjudicate Absent for a \
             provider that can never warm up on this machine"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── Antigravity (plan Task 5): the probe answers for the provider ──

    /// Warm index → `Present` for the indexed conversation; a genuinely
    /// absent id → `Absent`; an unknown provider stays `Absent` (never
    /// `Unknown`). Before `"antigravity"` joined `KNOWN_PROVIDERS`, every
    /// query on the provider mis-adjudicated as unknown-provider `Absent`
    /// (dead-session evidence for a live session).
    #[tokio::test]
    async fn antigravity_warm_index_answers_present_and_absent() {
        let (home, conv_id) = temp_antigravity_home("warm");
        let (probe, index) = antigravity_probe(home.clone());
        index.warm().await;
        assert_eq!(
            probe.exists("antigravity", conv_id),
            SessionExistence::Present,
            "a warm snapshot carrying the antigravity row must answer Present"
        );
        assert_eq!(
            probe.exists("antigravity", "00000000-1111-2222-3333-444444444444"),
            SessionExistence::Absent,
            "a genuinely absent conversation id must answer Absent"
        );
        assert_eq!(
            probe.exists("not-a-provider", conv_id),
            SessionExistence::Absent,
            "unknown provider stays Absent, never Unknown"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A cold index whose registered antigravity root does NOT exist will
    /// never warm up — `ProviderUnavailable`, not the deferrable `Unknown`;
    /// the counterpart boundary (root EXISTS, index cold) stays `Unknown`.
    #[tokio::test]
    async fn antigravity_cold_index_missing_root_is_provider_unavailable() {
        let (base, _conv_id) = temp_antigravity_home("cold-missing");
        let gone = base.join("no-antigravity-here"); // never created
        let (probe, _index) = antigravity_probe(gone);
        assert_eq!(
            probe.exists("antigravity", "s-any"),
            SessionExistence::ProviderUnavailable,
            "a missing antigravity home is an immediate provider_unavailable, never index_warming"
        );
        std::fs::remove_dir_all(&base).ok();

        let (home, _conv_id) = temp_antigravity_home("cold-existing");
        let (probe, _index) = antigravity_probe(home.clone());
        assert_eq!(
            probe.exists("antigravity", "s-cold"),
            SessionExistence::Unknown,
            "an EXISTING antigravity root with a cold index stays Unknown (warming)"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// §9.1 test 13 — real-index staleness: a `provider:sessionId` written to
    /// disk AFTER a cold read must resolve `Present` on re-query; a stale
    /// `Absent` must never latch.
    #[tokio::test]
    async fn session_written_after_cold_read_resolves_present_on_requery() {
        let home = temp_claude_home("staleness");
        let (probe, index) = probe_over(&home);
        let session_id = "5f0c2a1e-9b7d-4c3a-8e21-0d9f6b4a7c11";

        // Cold read: Unknown (kicks a background refresh of the EMPTY home).
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Unknown
        );
        index.warm().await;
        // Warmed empty home: honestly Absent.
        assert_eq!(probe.exists("claude", session_id), SessionExistence::Absent);

        // The session appears on disk AFTER that Absent answer.
        write_session(&home, session_id);

        // Re-query until the stale-kicked refresh publishes it (bounded).
        let mut last = SessionExistence::Absent;
        for _ in 0..100u8 {
            last = probe.exists("claude", session_id);
            if last == SessionExistence::Present {
                break;
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        assert_eq!(
            last,
            SessionExistence::Present,
            "a re-query must converge to Present — no latched stale Absent"
        );
        assert!(probe.ever_observed("claude", session_id));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The observed-set is monotone: once seen on disk, an identity stays
    /// `ever_observed` even after its file disappears — exactly what gates
    /// `dead_session` vs `fresh(identity_never_observed)`.
    #[tokio::test]
    async fn ever_observed_survives_the_session_disappearing_from_disk() {
        let home = temp_claude_home("observed");
        let (probe, index) = probe_over(&home);
        let session_id = "7a1b3c5d-2e4f-4a6b-9c8d-1e2f3a4b5c6d";
        write_session(&home, session_id);
        index.warm().await;
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present
        );

        std::fs::remove_file(
            home.join("projects/proj")
                .join(format!("{session_id}.jsonl")),
        )
        .expect("delete session file");

        let mut last = SessionExistence::Present;
        for _ in 0..100u8 {
            last = probe.exists("claude", session_id);
            if last == SessionExistence::Absent {
                break;
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        assert_eq!(last, SessionExistence::Absent);
        assert!(
            probe.ever_observed("claude", session_id),
            "the observed-set must remember identities disk has seen"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    fn temp_opencode_data_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "freshell-existence-opencode-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir opencode data home");
        dir
    }

    /// Same schema shape as crates/freshell-sessions/tests/opencode_sqlite.rs
    /// `create_full_schema` (and the spike fixture). Row tuple:
    /// (id, directory, parent_id, time_archived).
    #[allow(clippy::type_complexity)] // fixture row tuple, documented above
    fn seed_opencode_db(
        data_home: &std::path::Path,
        rows: &[(&str, Option<&str>, Option<&str>, Option<i64>)],
    ) {
        let conn =
            rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY,
                directory TEXT,
                title TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                time_archived INTEGER,
                project_id TEXT,
                parent_id TEXT
             );
             CREATE TABLE part (session_id TEXT, data TEXT);
             CREATE TABLE message (session_id TEXT, data TEXT);",
        )
        .expect("create schema");
        for (id, directory, parent_id, time_archived) in rows {
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'T', 1000, 5000, ?4, NULL, ?3)",
                rusqlite::params![id, directory, parent_id, time_archived],
            )
            .expect("insert session row");
        }
    }

    fn opencode_probe_over(
        data_home: &std::path::Path,
    ) -> (IndexExistenceProbe, Arc<SessionIndex>) {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(OpencodeSource::new(data_home.to_path_buf())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        (
            IndexExistenceProbe::new(
                Arc::clone(&index),
                None,
                HashMap::from([("opencode".to_string(), data_home.to_path_buf())]),
            ),
            index,
        )
    }

    /// Rebind fix RED: a CHILD session row (parent_id set) IS in
    /// opencode.db, but the listing's `parent_id IS NULL` root filter hides
    /// it from the index — the probe must answer Present via the by-id DB
    /// fallback, because the attach arm (`opencode --session <id>`) would
    /// resolve it.
    #[tokio::test]
    async fn child_opencode_session_row_on_disk_is_present_not_absent() {
        let home = temp_opencode_data_home("child-row");
        seed_opencode_db(
            &home,
            &[
                ("ses_root0000000000000000000000", Some("/tmp/p"), None, None),
                (
                    "ses_child000000000000000000000",
                    Some("/tmp/p"),
                    Some("ses_root0000000000000000000000"),
                    None,
                ),
            ],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Present,
            "the row exists on disk (the attach arm would resolve it) — the \
             probe must agree with the by-id DB check, not the root-filtered index"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Fallback-Present feeds the monotone observed-set (module-doc
    /// invariant), same as the claude fallback, so a LATER genuine deletion
    /// still derives loud dead_session even without a ledger.
    #[tokio::test]
    async fn opencode_fallback_present_feeds_ever_observed() {
        let home = temp_opencode_data_home("fallback-observed");
        seed_opencode_db(
            &home,
            &[
                ("ses_root0000000000000000000000", Some("/tmp/p"), None, None),
                (
                    "ses_child000000000000000000000",
                    Some("/tmp/p"),
                    Some("ses_root0000000000000000000000"),
                    None,
                ),
            ],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Present
        );
        assert!(
            probe.ever_observed("opencode", "ses_child000000000000000000000"),
            "a fallback hit is an on-disk observation and must feed ever_observed"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// HAZARD GUARD (must not regress): an id GENUINELY absent from the DB
    /// stays Absent even with the locator installed — the fallback must
    /// never weaken positive denial.
    #[tokio::test]
    async fn genuinely_missing_opencode_id_stays_absent_with_locator_installed() {
        let home = temp_opencode_data_home("hazard-guard");
        seed_opencode_db(
            &home,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_missing0000000000000000000"),
            SessionExistence::Absent,
            "no row anywhere: warm-index Absent AND by-id miss => Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The fallback is OPENCODE-scoped (mirror of
    /// `codex_absent_never_consults_the_claude_locator`): a claude Absent
    /// must stay Absent even when the installed opencode locator would
    /// answer Present for any id.
    #[tokio::test]
    async fn claude_absent_never_consults_the_opencode_locator() {
        let home = temp_claude_home("claude-opencode-gate");
        let (probe, index) = probe_over(&home);
        let probe =
            probe.with_opencode_session_locator(Arc::new(|_sid: &str| OpencodeDbAnswer::Present));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
            SessionExistence::Absent,
            "the by-id DB fallback is provider-gated to opencode only"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Same gate for codex.
    #[tokio::test]
    async fn codex_absent_never_consults_the_opencode_locator() {
        let home = temp_claude_home("codex-opencode-gate");
        let (probe, index) = probe_over(&home);
        let probe =
            probe.with_opencode_session_locator(Arc::new(|_sid: &str| OpencodeDbAnswer::Present));
        index.warm().await;
        assert_eq!(
            probe.exists("codex", "thread-1"),
            SessionExistence::Absent,
            "the by-id DB fallback is provider-gated to opencode only"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A ROOT row with NULL directory is returned by the listing SQL but
    /// dropped at mapping (parse/opencode.rs ~:314-317) — index-invisible
    /// yet DB-present. The fallback must find it.
    #[tokio::test]
    async fn directory_less_opencode_root_row_is_present_via_fallback() {
        let home = temp_opencode_data_home("dirless-root");
        seed_opencode_db(
            &home,
            &[("ses_dirless0000000000000000000", None, None, None)],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_dirless0000000000000000000"),
            SessionExistence::Present,
            "directory-less roots are real attachable rows the listing drops"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// PINNED: an archived row (time_archived set) is PRESENT via the
    /// fallback — attach parity. The listing excludes archived rows
    /// (parse/opencode.rs:204, `time_archived IS NULL`), but opencode's
    /// attach arm resolves them: `Session.get` has NO archived filter and
    /// a live `opencode --session <archived-id>` attach succeeds
    /// (load-bearing validation against v1.18.9). Answering Absent here
    /// would kill the bookmark of an attachable session — the exact bug
    /// class this fix removes.
    #[tokio::test]
    async fn archived_opencode_row_is_present_attach_parity() {
        let home = temp_opencode_data_home("archived");
        seed_opencode_db(
            &home,
            &[(
                "ses_arch0000000000000000000000",
                Some("/tmp/p"),
                None,
                Some(9999),
            )],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_arch0000000000000000000000"),
            SessionExistence::Present,
            "archived rows are index-invisible but attachable — the probe \
             must agree with the attach arm"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// LOAD-BEARING (kata vnpc Task 4 flip): an unreadable DB (here: a
    /// DIRECTORY where the file should be — the corruption/io-error class)
    /// answers `Unreadable` on the WARM path, NEVER `Absent`.
    /// Absent-on-error would recreate the dead-session bug under WAL lock
    /// contention; `Unknown` was the pre-change answer and is now reserved
    /// for the honest pre-readiness (cold) label. Reconcile turns
    /// `Unreadable` into error{session_store_unreadable} — identity
    /// preserved for a later retry. The index is warmed over a separate
    /// GOOD home so the warm-snapshot arm (where the fallback lives) is
    /// actually exercised.
    #[tokio::test]
    async fn unreadable_opencode_db_answers_unreadable_never_absent() {
        let good = temp_opencode_data_home("unreadable-good");
        seed_opencode_db(
            &good,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let broken = temp_opencode_data_home("unreadable-broken");
        std::fs::create_dir_all(broken.join("opencode.db")).expect("mkdir dir-as-db");
        let (probe, index) = opencode_probe_over(&good);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(broken.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Unreadable,
            "read failure is the honest unreadable-store error — it must never \
             become a false Absent and never the cold-only warming label"
        );
        let _ = std::fs::remove_dir_all(&good);
        let _ = std::fs::remove_dir_all(&broken);
    }

    /// A MISSING DB file is a normal Absent (opencode never ran here) —
    /// distinct from the unreadable case above.
    #[tokio::test]
    async fn missing_opencode_db_file_stays_absent() {
        let good = temp_opencode_data_home("missing-db-good");
        seed_opencode_db(
            &good,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let empty = temp_opencode_data_home("missing-db-empty");
        let (probe, index) = opencode_probe_over(&good);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(empty.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Absent
        );
        let _ = std::fs::remove_dir_all(&good);
        let _ = std::fs::remove_dir_all(&empty);
    }

    /// END-TO-END proof of the opencode rebind dead-session fix (promoted
    /// from spike/child-session-restart @ d505ad0c, which proved the RED
    /// state against unfixed code: the child claim derived
    /// DeadSession{session_not_on_disk} and chain-correction buried the
    /// superseded root too). After a pane is rebound (signal lane) to a
    /// CHILD session id, a restart must Respawn it — and a stale claim for
    /// the superseded ROOT must chain-correct (rung 2b) to the child and
    /// Respawn there.
    ///
    /// Real components end-to-end — NO fakes for the probe, index, listing,
    /// ledger, locator, or verdict derivation:
    ///   real `OpencodeSource` over a temp `opencode.db` -> real
    ///   `SessionIndex` -> real `IndexExistenceProbe` with the production
    ///   `opencode_db_locator` + real `PaneLedger` (post-rebind state via
    ///   `resolve_pending`, the SAME API the signal rebind lane's write hook
    ///   calls) -> real `freshell_ws::reconcile::derive_verdicts` with
    ///   restart-empty terminal/identity registries.
    #[tokio::test]
    async fn child_session_rebound_pane_restart_yields_respawn() {
        use freshell_protocol::{ReconcilePane, ReconcileVerdict, SessionLocator};
        use freshell_sessions::directory_index::OpencodeSource;
        use freshell_terminal::TerminalRegistry;
        use freshell_ws::identity::TerminalIdentityRegistry;
        use freshell_ws::pane_ledger::{BindingWrite, PaneLedger, RetiredReason, RowState};
        use freshell_ws::reconcile::{derive_verdicts, ReconcileDeps};

        // Opencode-shaped ids: ses_ + 26 alphanumerics.
        const ROOT: &str = "ses_root0000000000000000000000";
        const CHILD: &str = "ses_child000000000000000000000"; // parent_id = ROOT
        const ROOT2: &str = "ses_root2222222222222222222222"; // control: never rebound

        // -- 1. Temp opencode data home: root + child (subagent) rows ------
        let base = std::env::temp_dir().join(format!(
            "freshell-child-restart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_home = base.join("opencode");
        std::fs::create_dir_all(&data_home).expect("mkdir opencode data home");
        let cwd_dir = base.join("proj");
        std::fs::create_dir_all(&cwd_dir).expect("mkdir cwd");
        let cwd = cwd_dir.to_string_lossy().to_string();
        {
            // Same schema shape as crates/freshell-sessions/tests/
            // opencode_sqlite.rs `create_full_schema` (includes parent_id).
            let conn =
                rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
            conn.execute_batch(
                "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
                 CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    directory TEXT,
                    title TEXT,
                    time_created INTEGER,
                    time_updated INTEGER,
                    time_archived INTEGER,
                    project_id TEXT,
                    parent_id TEXT
                 );
                 CREATE TABLE part (session_id TEXT, data TEXT);
                 CREATE TABLE message (session_id TEXT, data TEXT);",
            )
            .expect("create schema");
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'Root', 1000, 5000, NULL, NULL, NULL)",
                rusqlite::params![ROOT, cwd],
            )
            .expect("insert root");
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'Child (subagent)', 2000, 6000, NULL, NULL, ?3)",
                rusqlite::params![CHILD, cwd, ROOT],
            )
            .expect("insert child");
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'Root 2', 1000, 4000, NULL, NULL, NULL)",
                rusqlite::params![ROOT2, cwd],
            )
            .expect("insert root2");
        }

        // -- 2. Real SessionIndex over the real OpencodeSource -------------
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(OpencodeSource::new(data_home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));

        // -- 3. Real PaneLedger with the post-rebind state ------------------
        // Faithful reproduction of the signal lane's writes, via the SAME
        // API `ledger_resolve_identity` calls (`resolve_pending`), in the
        // production order: pending marker at spawn -> first-bind resolution
        // to ROOT -> signal rebind to CHILD (child bound row FIRST, then
        // ROOT retired as Superseded{supersededBy}).
        let ledger_root = base.join("ledger");
        std::fs::create_dir_all(&ledger_root).expect("mkdir ledger root");
        let ledger = Arc::new(PaneLedger::new(Some(ledger_root)));
        ledger
            .record_pending(
                "t-pane1",
                "opencode",
                Some(&cwd),
                None,
                freshell_ws::pane_ledger::ProvenanceStamps::default(),
                1_000,
            )
            .expect("pending marker");
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: ROOT,
                terminal_id: "t-pane1",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                now_ms: 2_000,
                observed_epoch: None,
                observed_generation: None,
            })
            .expect("first bind: root");
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: CHILD,
                terminal_id: "t-pane1",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                now_ms: 3_000,
                observed_epoch: None,
                observed_generation: None,
            })
            .expect("signal rebind: child");
        // Control pane: ROOT2 bound to its own terminal, never superseded.
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: ROOT2,
                terminal_id: "t-pane2",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                now_ms: 2_500,
                observed_epoch: None,
                observed_generation: None,
            })
            .expect("control bind: root2");

        // Sanity: the ledger holds the exact post-rebind shape the signal
        // lane produces (old row Retired/Superseded -> child; child Bound).
        let old = ledger
            .load_binding("opencode", ROOT)
            .expect("root row exists");
        assert_eq!(old.state, RowState::Retired);
        assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
        assert_eq!(
            old.superseded_by.as_ref().map(|l| l.session_id.as_str()),
            Some(CHILD)
        );
        let new = ledger
            .load_binding("opencode", CHILD)
            .expect("child row exists");
        assert_eq!(new.state, RowState::Bound);

        // -- 4. Real probe: index + ledger + PRODUCTION opencode locator ---
        let probe = IndexExistenceProbe::new(
            Arc::clone(&index),
            Some(Arc::clone(&ledger)),
            HashMap::from([("opencode".to_string(), data_home.clone())]),
        )
        .with_opencode_session_locator(opencode_db_locator(data_home.clone()));

        // Cold-index path resolves by id (kata vnpc Task 4): the seeded
        // child row is provable in opencode.db without waiting for the
        // broad scan — a cheap, fresh, targeted read (the G28 cold-locator
        // precedent), never a guessed Absent and never a stalled Unknown.
        assert_eq!(
            probe.exists("opencode", CHILD),
            SessionExistence::Present,
            "cold index + seeded DB row => Present via the cheap by-id locator"
        );

        index.warm().await;

        // -- 5. Probe answers after restart ---------------------------------
        assert_eq!(
            probe.exists("opencode", ROOT),
            SessionExistence::Present,
            "root session (parent_id NULL) is listed by the opencode source"
        );
        assert_eq!(
            probe.exists("opencode", CHILD),
            SessionExistence::Present,
            "THE FIX: the child row is hidden from the listing by the \
             `parent_id IS NULL` root filter, but the by-id DB fallback \
             finds it — the probe now agrees with the attach arm"
        );
        assert!(probe.ever_observed("opencode", CHILD));

        // -- 6. Restart-shaped reconcile through the REAL derivation --------
        // Empty registries: no terminal survives a server restart.
        let registry = TerminalRegistry::new();
        let identity = TerminalIdentityRegistry::new();
        let deps = ReconcileDeps {
            registry: &registry,
            identity: &identity,
            existence: &probe,
            pane_ledger: &ledger,
            fresh_agent: None,
            managed: None,
        };
        let pane = |n: u32, sid: &str| ReconcilePane {
            pane_key: format!("pane-{n}"),
            kind: Some("terminal".to_string()),
            mode: Some("opencode".to_string()),
            create_request_id: Some(format!("cr-{n}")),
            terminal_id: Some(format!("t-pane{n}")),
            server_instance_id: None,
            session_ref: Some(SessionLocator {
                provider: "opencode".to_string(),
                session_id: sid.to_string(),
            }),
            resume_session_id: None,
            status: None,
            naming_handle: None,
        };
        let verdicts = derive_verdicts(
            &deps,
            &[
                pane(1, CHILD), // the rebound pane presenting its child bookmark
                pane(2, ROOT2), // control: a plain root-session pane
                pane(3, ROOT),  // a stale claim for the superseded ROOT
            ],
        );

        // (a) The rebound pane's child bookmark survives: Respawn AT the child.
        assert_eq!(
            verdicts[0].verdict,
            ReconcileVerdict::Respawn,
            "child-rebound pane after restart: got {:?} (reason {:?})",
            verdicts[0].verdict,
            verdicts[0].reason
        );
        assert_eq!(
            verdicts[0]
                .session_ref
                .as_ref()
                .map(|l| l.session_id.as_str()),
            Some(CHILD)
        );

        // (b) Control: a never-rebound root-session pane stays Respawn.
        assert_eq!(
            verdicts[1].verdict,
            ReconcileVerdict::Respawn,
            "control root pane after restart: got {:?} (reason {:?})",
            verdicts[1].verdict,
            verdicts[1].reason
        );
        assert_eq!(
            verdicts[1]
                .session_ref
                .as_ref()
                .map(|l| l.session_id.as_str()),
            Some(ROOT2)
        );

        // (c) The stale superseded-ROOT claim is chain-corrected (ledger
        // rung 2b) to the child terminus — which the fallback now finds —
        // so it Respawns AT the child, marked corrected. No more chain
        // poisoning: one rebind no longer buries both bookmarks.
        assert_eq!(
            verdicts[2].verdict,
            ReconcileVerdict::Respawn,
            "stale superseded-root claim after restart: got {:?} (reason {:?})",
            verdicts[2].verdict,
            verdicts[2].reason
        );
        assert_eq!(
            verdicts[2]
                .session_ref
                .as_ref()
                .map(|l| l.session_id.as_str()),
            Some(CHILD),
            "the superseded ROOT claim resolves to the CHILD chain terminus"
        );
        assert_eq!(
            verdicts[2].corrected,
            Some(true),
            "the server overrode the differing client claim"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}

// Resume-validation (plan Task 3) tests live in a sibling file — this module
// is already large; same include pattern as
// freshell-sessions/src/amplifier_stub.rs's `scan_tests`. It reuses the
// `pub(super)` scaffolding helpers from `tests` above.
#[cfg(test)]
#[path = "existence_resume_validation_tests.rs"]
mod resume_validation_tests;

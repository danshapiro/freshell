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
//!   => `Present`; unreadable DB => `Unknown`, never `Absent`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use freshell_sessions::directory_index::SessionIndex;
use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};

/// The disk-indexed providers of `main.rs`'s `SessionIndex` construction —
/// the "known provider" set of the probe contract.
const KNOWN_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

/// Injected raw-file transcript check for claude (kata 09v1). Wiring installs
/// `freshell_freshagent::locate_transcript` — the SAME ordered-candidate-roots
/// scan the attach arm trusts (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
/// `$HOME/.claude`) — so reconcile and attach can never disagree about whether
/// a claude transcript exists. A closure (not a direct call) keeps this probe
/// unit-testable without process-global env mutation; precedent:
/// `codex_rollout_locator` (main.rs).
pub type ClaudeTranscriptLocator = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

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
    /// `Unknown`, NEVER `Absent` — Absent-on-error would adjudicate live
    /// sessions dead under transient lock contention.
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
    /// field doc). Chained at the single production construction site in
    /// main.rs.
    pub fn with_codex_rollout_locator(mut self, locator: CodexRolloutExistenceLocator) -> Self {
        self.codex_rollout_locator = Some(locator);
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
}

/// Production opencode locator: by-id check against
/// `<data_home>/opencode.db` via
/// `freshell_sessions::parse::session_exists_by_id` — read-only open, 250ms
/// busy timeout (NOT the listing's 5000ms; `exists()` is sync on the
/// reconcile path), no archived/parent/directory filters (attach parity:
/// opencode's session.get has none of them). Missing DB file => `Absent`
/// (opencode never ran); any read error => `Unreadable` (=> the probe
/// answers `Unknown`).
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
        // Keep the answer converging: any non-fresh state kicks a detached
        // refresh so a re-query (the client's reconnect-and-re-present loop)
        // eventually reads current disk truth.
        if !self.index.is_fresh() {
            self.kick_refresh();
        }
        match self.index.peek() {
            None => {
                // Cold index: a known provider whose session root does not
                // exist on this machine will NEVER warm up — that's an
                // immediate, honest provider_unavailable, not index_warming.
                if self
                    .provider_roots
                    .get(provider)
                    .is_some_and(|root| !root.exists())
                {
                    return SessionExistence::ProviderUnavailable;
                }
                // Cold-index coverage (resume-validation, A1): the snapshot
                // is None every boot and the warm sweep is a detached spawn —
                // restore-time creates race it. amplifier + claude have CHEAP
                // direct by-id locators; run them so the gate still fires in
                // the incident scenario. codex/opencode stay Unknown when
                // cold (AD-4: the codex walk is ~1 s on a real store —
                // warm-Absent adjudication only).
                if provider == "amplifier" {
                    if let Some(locator) = &self.amplifier_session_locator {
                        return match locator(session_id) {
                            ByIdAnswer::Present => {
                                // On-disk observation — feed the monotone
                                // observed-set (module-doc invariant).
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                SessionExistence::Present
                            }
                            ByIdAnswer::Absent => SessionExistence::Absent,
                            ByIdAnswer::Unreadable => SessionExistence::Unknown,
                        };
                    }
                }
                if provider == "claude" {
                    // Reuse the EXISTING claude transcript locator (raw-file
                    // check — cheap), same mapping as the warm fallback
                    // below: hit => Present, clean miss => Absent (the
                    // Option shape has no error channel).
                    if let Some(locator) = &self.claude_transcript_locator {
                        return if locator(session_id).is_some() {
                            self.observed
                                .lock()
                                .expect("observed set lock")
                                .insert(format!("{provider}:{session_id}"));
                            SessionExistence::Present
                        } else {
                            SessionExistence::Absent
                        };
                    }
                }
                SessionExistence::Unknown
            }
            Some(items) => {
                self.record_observed(&items);
                let hit = items
                    .iter()
                    .any(|s| s.provider == provider && s.session_id == session_id);
                if hit {
                    return SessionExistence::Present;
                }
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
                // R10b itself stays intact for History listing.
                if provider == "claude" {
                    if let Some(locator) = &self.claude_transcript_locator {
                        if locator(session_id).is_some() {
                            // A fallback hit is an on-disk observation: feed
                            // the monotone observed-set (module-doc invariant)
                            // so a LATER genuine deletion still derives loud
                            // dead_session even without the ledger.
                            self.observed
                                .lock()
                                .expect("observed set lock")
                                .insert(format!("{provider}:{session_id}"));
                            return SessionExistence::Present;
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
                // DB (WAL lock contention, corruption) is honest Unknown —
                // reconcile's bounded deferral retries — NEVER Absent. The
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
                                return SessionExistence::Unknown;
                            }
                            OpencodeDbAnswer::Absent => {}
                        }
                    }
                }
                // Amplifier by-id fallback (resume-validation): a STALE warm
                // snapshot must never adjudicate a real session absent — a
                // session created moments before a restart may be missing
                // from the snapshot, and `peek()` serves snapshots
                // regardless of TTL. Same adjudication point as the claude/
                // opencode fallbacks above: only reached when the snapshot
                // would otherwise answer Absent. The scan is CHEAP (one
                // read_dir + one metadata per project slug), so it stays on
                // this sync reconcile-consulted path. After this arm,
                // `Absent` for claude/opencode/amplifier is POSITIVE
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
                            ByIdAnswer::Unreadable => return SessionExistence::Unknown,
                            ByIdAnswer::Absent => {}
                        }
                    }
                }
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

    /// Gate-caller variant (trait doc): `exists()` plus the EXPENSIVE codex
    /// by-id rollout walk (~1s on a real store) on a warm-Absent answer.
    /// The walk lives HERE and not in `exists()` because `exists()` is
    /// consulted inline on the sync reconcile path, whose IO discipline is
    /// ~250ms per consult (see `opencode_db_locator`); gate callers run this
    /// variant inside `tokio::task::spawn_blocking` (A13: never inline on
    /// the async runtime). AD-4 is preserved exactly: cold-index codex
    /// answers `Unknown` from `exists()`, and the walk only runs on
    /// `Absent`, so it still NEVER runs on the cold path.
    fn exists_for_gate(&self, provider: &str, session_id: &str) -> SessionExistence {
        let base = self.exists(provider, session_id);
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
    use freshell_sessions::directory_index::{ClaudeSource, OpencodeSource, SessionSource};
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

    /// Test locator with the SAME contract as claude_snapshot::locate_transcript
    /// (Some(path) iff the transcript file exists), scoped to the temp home so
    /// tests never touch process-global CLAUDE_* env vars.
    pub(super) fn direct_locator_over(home: &std::path::Path) -> ClaudeTranscriptLocator {
        let projects = home.join("projects/proj");
        Arc::new(move |session_id: &str| {
            let p = projects.join(format!("{session_id}.jsonl"));
            p.is_file().then_some(p)
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

    /// The fallback is CLAUDE-scoped: zero-turn codex genuinely has no rollout
    /// file (vendor deferred materialization — reconcile_freshagent.rs module
    /// doc), so a codex Absent must stay Absent even when the installed
    /// locator would answer Some for any id.
    #[tokio::test]
    async fn codex_absent_never_consults_the_claude_locator() {
        let home = temp_claude_home("codex-gate");
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(Arc::new(|_sid: &str| {
            Some(std::path::PathBuf::from("/nonexistent/never-used.jsonl"))
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

    /// LOAD-BEARING: an unreadable DB (here: a DIRECTORY where the file
    /// should be — the corruption/io-error class) answers Unknown, NEVER
    /// Absent. Absent-on-error would recreate the dead-session bug under
    /// WAL lock contention. Reconcile turns Unknown into
    /// error{index_warming} + its single bounded deferral, then re-derives.
    /// The index is warmed over a separate GOOD home so the warm-snapshot
    /// arm (where the fallback lives) is actually exercised.
    #[tokio::test]
    async fn unreadable_opencode_db_answers_unknown_never_absent() {
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
            SessionExistence::Unknown,
            "read failure is honest ignorance — reconcile defers and retries; \
             it must never become a false Absent"
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
            .record_pending("t-pane1", "opencode", Some(&cwd), 1_000)
            .expect("pending marker");
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: ROOT,
                terminal_id: "t-pane1",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                now_ms: 2_000,
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
                now_ms: 3_000,
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
                now_ms: 2_500,
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

        // Cold-index path stays honest Unknown — the fallback lives ONLY in
        // the warm-snapshot arm and must never manufacture answers before
        // the index publishes.
        assert_eq!(
            probe.exists("opencode", CHILD),
            SessionExistence::Unknown,
            "cold index answers Unknown, never a guessed Absent or a \
             fallback-manufactured Present"
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

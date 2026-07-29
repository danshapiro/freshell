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
        }
    }

    /// Builder-style: install the raw-file fallback for claude (see the field
    /// doc). Chained at the single production construction site in main.rs.
    pub fn with_claude_transcript_locator(mut self, locator: ClaudeTranscriptLocator) -> Self {
        self.claude_transcript_locator = Some(locator);
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_sessions::directory_index::{ClaudeSource, SessionSource};
    use std::time::Duration;

    fn temp_claude_home(tag: &str) -> std::path::PathBuf {
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

    fn write_session(claude_home: &std::path::Path, session_id: &str) {
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

    fn probe_over(home: &std::path::Path) -> (IndexExistenceProbe, Arc<SessionIndex>) {
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
    fn direct_locator_over(home: &std::path::Path) -> ClaudeTranscriptLocator {
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
                provider_scope: None,
                materialization: freshell_recovery::MaterializationState::Observed,
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
}

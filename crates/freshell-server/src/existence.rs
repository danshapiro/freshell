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

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use freshell_sessions::directory_index::SessionIndex;
use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};

/// The disk-indexed providers of `main.rs`'s `SessionIndex` construction —
/// the "known provider" set of the probe contract.
const KNOWN_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

pub struct IndexExistenceProbe {
    index: Arc<SessionIndex>,
    /// `provider:sessionId` keys ever seen in ANY snapshot this boot.
    observed: Mutex<HashSet<String>>,
}

impl IndexExistenceProbe {
    pub fn new(index: Arc<SessionIndex>) -> Self {
        Self {
            index,
            observed: Mutex::new(HashSet::new()),
        }
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
            None => SessionExistence::Unknown,
            Some(items) => {
                self.record_observed(&items);
                let hit = items
                    .iter()
                    .any(|s| s.provider == provider && s.session_id == session_id);
                if hit {
                    SessionExistence::Present
                } else {
                    SessionExistence::Absent
                }
            }
        }
    }

    fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
        self.observed
            .lock()
            .expect("observed set lock")
            .contains(&format!("{provider}:{session_id}"))
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
        (IndexExistenceProbe::new(Arc::clone(&index)), index)
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

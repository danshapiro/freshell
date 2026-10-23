//! The claude lane's side of a session's genesis (core-runtime design §4.1,
//! §4.2, §4.3 and §4.5).
//!
//! A session that has no transcript yet (a fresh session before its first
//! prompt, or a pending fork) records how it came to be in its binding row
//! ([`ClaudeGenesis`]) until the transcript is observed on disk. The lane reads
//! it to serve the session's snapshot (`Fresh` holds nothing, a pending `Fork`
//! its parent's prefix) and to boot the session again before its transcript
//! exists (after a restart or a crash), always against the transcript store its
//! sidecars write. It clears it lazily, only once the transcript is on disk: a
//! launch that finds the transcript clears it, and so does the first result
//! after the transcript is flushed (each line lags its SDK frame, T3), so a CLI
//! death in that window never loses the session.

use std::time::Duration;

use super::*;

use crate::claude_launch::{decide_boot, BootDecision};
use crate::claude_snapshot::{ClaudeSnapshotError, TranscriptLocation};
use crate::identity_sink::RecordedGenesis;

/// How many times the lazy clear looks for the transcript after a result.
pub(crate) const GENESIS_CLEAR_ATTEMPTS: u32 = 10;
/// How long the lazy clear waits between looks (a transcript line lags its SDK
/// frame by 95-200 ms, T3).
pub(crate) const GENESIS_CLEAR_INTERVAL: Duration = Duration::from_millis(200);

/// What one lazy clear did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GenesisClear {
    /// The transcript was on disk at the `attempt`-th look; the genesis is gone.
    Cleared { attempt: u32 },
    /// The transcript never appeared: the genesis stays, so the next launch
    /// boots the session from it again.
    NotObserved,
    /// The transcript was on disk but the ledger write failed: the genesis
    /// stays (harmless: a found transcript always wins), the next result or
    /// launch clears it.
    Failed(String),
}

/// A boot decided from a session's recorded genesis
/// ([`FreshClaudeState::decide_create_resume_boot`]).
#[derive(Debug)]
pub(super) struct GenesisAwareBoot {
    pub(super) boot: ClaudeBoot,
    /// The directory the conversation (or a fork's parent) was recorded in,
    /// when it still exists.
    pub(super) cwd: Option<String>,
    /// The id a fresh or forked boot writes under (the session's own).
    pub(super) session_id: Option<String>,
    /// The genesis the boot follows; `None` when the transcript is on disk and
    /// the boot resumes it.
    pub(super) genesis: Option<crate::claude_launch::ClaudeGenesis>,
    /// The genesis the session's binding row records (the boot's one typed
    /// retry follows it, design §4.2).
    pub(super) recorded: crate::claude_launch::ClaudeGenesis,
}

/// Clear `session_id`'s genesis once its transcript is on disk in `roots`:
/// look up to `attempts` times, `interval` apart, and clear at the first find.
/// A store that cannot be read is not a find.
pub(crate) async fn clear_genesis_once_observed(
    sink: &crate::identity_sink::SharedPaneIdentitySink,
    roots: Vec<PathBuf>,
    session_id: &str,
    attempts: u32,
    interval: Duration,
) -> GenesisClear {
    for attempt in 1..=attempts {
        let (store, id) = (roots.clone(), session_id.to_string());
        let found = tokio::task::spawn_blocking(move || {
            matches!(
                crate::claude_snapshot::locate_transcript_state_in(&store, &id),
                TranscriptLocation::Found(_)
            )
        })
        .await
        .unwrap_or(false);
        if found {
            return match sink.clear_genesis(PROVIDER, session_id).await {
                Ok(()) => GenesisClear::Cleared { attempt },
                Err(error) => GenesisClear::Failed(error.to_string()),
            };
        }
        if attempt < attempts {
            tokio::time::sleep(interval).await;
        }
    }
    GenesisClear::NotObserved
}

/// One structured line per lazy clear.
fn log_genesis_clear(session_id: &str, genesis: &str, trigger: &str, outcome: &GenesisClear) {
    match outcome {
        GenesisClear::Cleared { attempt } => tracing::info!(
            component = "freshagent.claude",
            event = "freshagent.claude.genesis_cleared",
            session_id = %session_id,
            genesis,
            trigger,
            attempt,
            "the session's transcript is on disk; its genesis is cleared"
        ),
        GenesisClear::NotObserved => tracing::warn!(
            component = "freshagent.claude",
            event = "freshagent.claude.genesis_kept",
            session_id = %session_id,
            genesis,
            trigger,
            attempts = GENESIS_CLEAR_ATTEMPTS,
            "the session's transcript did not appear; its genesis stays, so the next launch boots it again"
        ),
        GenesisClear::Failed(error) => tracing::warn!(
            component = "freshagent.claude",
            event = "freshagent.claude.genesis_clear_failed",
            session_id = %session_id,
            genesis,
            trigger,
            error = %error,
            "the session's transcript is on disk but its genesis could not be cleared; a later result or launch retries"
        ),
    }
}

impl FreshClaudeState {
    /// The durable session id `any_id` names: a live session's adopted claude
    /// id (or its map key until it has one), resolved like every handler here
    /// (map key or durable UUID through `cli_index`); an untracked id (a
    /// disk-only read after a restart) is itself.
    pub(crate) async fn durable_session_id(&self, any_id: &str) -> String {
        match self.resolve_session_key(any_id).await {
            Some(map_key) => self
                .sessions
                .lock()
                .await
                .get(&map_key)
                .and_then(|session| session.cli_session_id.clone())
                .unwrap_or(map_key),
            None => any_id.to_string(),
        }
    }

    /// The genesis the session `any_id` names came from, if any (memory-only):
    /// what its binding row records, else what its live runtime was launched
    /// from (a lane with no ledger, such as the hosted session host, records
    /// nothing).
    pub(crate) async fn load_genesis(&self, any_id: &str) -> Option<RecordedGenesis> {
        let durable = self.durable_session_id(any_id).await;
        if let Some(recorded) = self
            .identity_sink()
            .and_then(|sink| sink.load_genesis(PROVIDER, &durable))
        {
            return Some(recorded);
        }
        let key = self.resolve_session_key(any_id).await?;
        self.sessions
            .lock()
            .await
            .get(&key)
            .and_then(|session| session.launch_genesis.clone())
    }

    /// The session's snapshot from disk, read from this lane's transcript store:
    /// its transcript, or, before it has one, its genesis; with the durable
    /// rollback record's markers and revision floor. No overlay of live state.
    pub(crate) async fn disk_snapshot(
        &self,
        session_type: &str,
        thread_id: &str,
    ) -> Result<Value, ClaudeSnapshotError> {
        let rollback = self.load_rollback_record(thread_id).await;
        let genesis = self.load_genesis(thread_id).await;
        crate::claude_snapshot::get_claude_snapshot_in(
            &self.transcript_roots(),
            session_type,
            thread_id,
            genesis.as_ref(),
            rollback.as_ref(),
        )
        .await
    }

    /// Which conversation an attach that resumes `durable` boots (design §4.2):
    /// [`decide_boot`] over the lane's store and the binding row's genesis. The
    /// boot, the directory the conversation was recorded in, and the id a fresh
    /// or forked boot writes under. A found transcript whose row still records a
    /// genesis clears it (the transcript is observed). Lost and unreadable map to
    /// the attach's errors (unreadable is logged and never lost).
    pub(super) fn decide_attach_boot(
        &self,
        durable: &str,
        sink: Option<&crate::identity_sink::SharedPaneIdentitySink>,
    ) -> Result<(ClaudeBoot, Option<String>, Option<String>), ResumeClaudeError> {
        let recorded = sink.and_then(|sink| sink.load_genesis(PROVIDER, durable));
        self.decide_recorded_boot("attach_resume", durable, sink, recorded.as_ref())
    }

    /// Which conversation a create that resumes `durable` boots (design §4.2,
    /// the boot decision every launch makes; §4.3's crash row). A session whose
    /// binding row records a genesis (a zero-turn session, an undo's replacement
    /// or a fork's child before its first send) is decided exactly like an
    /// attach: from its genesis while it has no transcript, as a resume once it
    /// has one. So the pane's Resume after such a session's sidecar died boots
    /// the same conversation again instead of a resume the CLI refuses (T5).
    ///
    /// `None` for a session with no genesis: the create resumes it as it always
    /// did. Its only possible boot is that resume, and the CLI, which reads the
    /// store from its own environment, refuses a conversation it does not hold
    /// with the typed `CONVERSATION_NOT_FOUND` (T5), the same answer a lost
    /// decision gives.
    pub(super) fn decide_create_resume_boot(
        &self,
        durable: &str,
    ) -> Result<Option<GenesisAwareBoot>, ResumeClaudeError> {
        let sink = self.identity_sink();
        let Some(recorded) = sink
            .as_ref()
            .and_then(|sink| sink.load_genesis(PROVIDER, durable))
        else {
            return Ok(None);
        };
        let (boot, cwd, session_id) =
            self.decide_recorded_boot("create_resume", durable, sink.as_ref(), Some(&recorded))?;
        // A boot under the session's own id is a boot from its genesis; a
        // resume (the transcript is on disk) boots nothing from it.
        let genesis = session_id.is_some().then(|| recorded.genesis.clone());
        Ok(Some(GenesisAwareBoot {
            boot,
            cwd,
            session_id,
            genesis,
            recorded: recorded.genesis,
        }))
    }

    /// [`decide_boot`] for `durable`, whose binding row records `recorded`, on
    /// behalf of the launch `lane` (it names the log lines).
    fn decide_recorded_boot(
        &self,
        lane: &'static str,
        durable: &str,
        sink: Option<&crate::identity_sink::SharedPaneIdentitySink>,
        recorded: Option<&RecordedGenesis>,
    ) -> Result<(ClaudeBoot, Option<String>, Option<String>), ResumeClaudeError> {
        let location = self.locate_transcript(durable);
        let found = matches!(location, TranscriptLocation::Found(_));
        let decision = decide_boot(
            durable,
            location,
            recorded.map(|recorded| &recorded.genesis),
            |id| self.locate_transcript(id),
        );
        match decision {
            BootDecision::Boot {
                boot,
                cwd,
                session_id,
            } => {
                if let (Some(recorded), Some(sink)) = (recorded, sink) {
                    if found {
                        self.clear_found_genesis(sink, durable, recorded);
                    } else {
                        tracing::info!(
                            component = "freshagent.claude",
                            event = "freshagent.claude.genesis_boot",
                            session_id = %durable,
                            lane,
                            genesis = recorded.genesis.kind(),
                            boot = boot.kind(),
                            "the session has no transcript yet; it boots from its genesis"
                        );
                    }
                }
                Ok((boot, cwd, session_id))
            }
            BootDecision::Lost => {
                tracing::info!(
                    component = "freshagent.claude",
                    event = "freshagent.claude.boot_lost",
                    session_id = %durable,
                    lane,
                    genesis = recorded.map(|recorded| recorded.genesis.kind()),
                    "the session has no transcript and nothing to boot it from; it is gone"
                );
                Err(ResumeClaudeError::NotFound)
            }
            BootDecision::Transient(error) => {
                crate::claude_snapshot::log_transcript_unreadable(lane, durable, &error);
                Err(ResumeClaudeError::Transient(error.to_string()))
            }
        }
    }

    /// A launch found the transcript of a session whose row still records a
    /// genesis: clear it now, off the launch's path.
    fn clear_found_genesis(
        &self,
        sink: &crate::identity_sink::SharedPaneIdentitySink,
        durable: &str,
        recorded: &RecordedGenesis,
    ) {
        let (sink, durable, genesis) = (sink.clone(), durable.to_string(), recorded.genesis.kind());
        let roots = self.transcript_roots();
        tokio::spawn(async move {
            let outcome =
                clear_genesis_once_observed(&sink, roots, &durable, 1, Duration::ZERO).await;
            log_genesis_clear(&durable, genesis, "launch", &outcome);
        });
    }

    /// After a result of the session `session_key` names: when its binding row
    /// still records a genesis, clear it once the transcript is flushed (the
    /// lazy clear, design §4.1). Detached from the caller (the sidecar's output
    /// reader) entirely: resolving the durable id takes the session locks, which
    /// the reader must never wait on. A session with no genesis costs one memory
    /// read.
    pub(super) fn spawn_genesis_clear_after_result(&self, session_key: &str) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        let (state, session_key) = (self.clone(), session_key.to_string());
        tokio::spawn(async move {
            let durable = state.durable_session_id(&session_key).await;
            let Some(recorded) = sink.load_genesis(PROVIDER, &durable) else {
                return;
            };
            let outcome = clear_genesis_once_observed(
                &sink,
                state.transcript_roots(),
                &durable,
                GENESIS_CLEAR_ATTEMPTS,
                GENESIS_CLEAR_INTERVAL,
            )
            .await;
            log_genesis_clear(&durable, recorded.genesis.kind(), "result", &outcome);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_launch::ClaudeGenesis;
    use crate::identity_sink::{FakeIdentitySink, PaneIdentitySink, SharedPaneIdentitySink};

    const ID: &str = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";

    fn sink_with_genesis() -> (Arc<FakeIdentitySink>, SharedPaneIdentitySink) {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.seed_genesis(PROVIDER, ID, ClaudeGenesis::Fresh);
        let shared: SharedPaneIdentitySink = fake.clone();
        (fake, shared)
    }

    fn transcript_path(store: &std::path::Path) -> PathBuf {
        store
            .join("projects")
            .join("-w")
            .join(format!("{ID}.jsonl"))
    }

    /// §4.1: the genesis is cleared only after the transcript is observed. The
    /// transcript is flushed a moment after the result (T3); the clear keeps
    /// looking and clears at the first find.
    #[tokio::test]
    async fn the_genesis_clears_once_the_transcript_is_flushed() {
        let store = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(store.path().join("projects")).unwrap();
        let (fake, sink) = sink_with_genesis();
        let path = transcript_path(store.path());
        let flush = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}\n").unwrap();
        });
        let outcome = clear_genesis_once_observed(
            &sink,
            vec![store.path().to_path_buf()],
            ID,
            50,
            Duration::from_millis(10),
        )
        .await;
        flush.await.unwrap();
        assert!(
            matches!(outcome, GenesisClear::Cleared { attempt } if attempt > 1),
            "{outcome:?}"
        );
        assert_eq!(fake.load_genesis(PROVIDER, ID), None);
    }

    /// §4.1/§4.3: a CLI death before the transcript is flushed never loses the
    /// session: with no transcript (or a store that cannot be read) the genesis
    /// stays, so the next launch boots the session from it again.
    #[tokio::test]
    async fn a_transcript_never_flushed_keeps_the_genesis() {
        let store = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(store.path().join("projects")).unwrap();
        let (fake, sink) = sink_with_genesis();
        for roots in [vec![store.path().to_path_buf()], Vec::new()] {
            let outcome =
                clear_genesis_once_observed(&sink, roots, ID, 3, Duration::from_millis(1)).await;
            assert_eq!(outcome, GenesisClear::NotObserved);
        }
        assert_eq!(
            fake.load_genesis(PROVIDER, ID).map(|r| r.genesis),
            Some(ClaudeGenesis::Fresh)
        );
        assert!(
            fake.genesis_clears.lock().unwrap().is_empty(),
            "nothing was cleared"
        );
    }

    /// A clear whose ledger write fails is reported and leaves the genesis (a
    /// found transcript wins at the next launch anyway).
    #[tokio::test]
    async fn a_failed_clear_is_reported_and_keeps_the_genesis() {
        let store = tempfile::tempdir().unwrap();
        let path = transcript_path(store.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}\n").unwrap();
        let (fake, sink) = sink_with_genesis();
        fake.set_fail_writes(true);
        let outcome = clear_genesis_once_observed(
            &sink,
            vec![store.path().to_path_buf()],
            ID,
            3,
            Duration::from_millis(1),
        )
        .await;
        assert!(matches!(outcome, GenesisClear::Failed(_)), "{outcome:?}");
        assert!(fake.load_genesis(PROVIDER, ID).is_some());
    }
}

//! The claude lane's reads of a session's genesis (core-runtime design §4.1,
//! §4.3 and §4.5).
//!
//! A session that has no transcript yet (a fresh session before its first
//! prompt, or a pending fork) records how it came to be in its binding row
//! ([`ClaudeGenesis`]) until the transcript is observed on disk. The lane reads
//! it to serve the session's snapshot (`Fresh` holds nothing, a pending `Fork`
//! its parent's prefix), always from the transcript store its sidecars write.

use super::*;

use crate::claude_snapshot::ClaudeSnapshotError;
use crate::identity_sink::RecordedGenesis;

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

    /// The genesis the binding row of the session `any_id` names records, if
    /// any (memory-only).
    pub(crate) async fn load_genesis(&self, any_id: &str) -> Option<RecordedGenesis> {
        let durable = self.durable_session_id(any_id).await;
        self.identity_sink()
            .and_then(|sink| sink.load_genesis(PROVIDER, &durable))
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
}

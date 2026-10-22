//! The sweep's targeted OpenCode first-message lookup (name-reliability
//! plan, Task 5, condition C5).
//!
//! OpenCode names a session itself after its first exchange, so the bounded
//! session listing carries a first user message only for rows OpenCode has
//! not named; for the others the sweep reads the session's first message on
//! demand (one read-only query). It does so while the naming store can
//! still use the message — as AI-naming input, or as a name for a record
//! below `first_message` or stuck on a junk default label such as its
//! folder name. A session that has no user message would then be read on
//! every 5-second pass forever, so every answer is remembered ACROSS passes,
//! keyed by session id and the index row's last activity: a new message
//! moves the row's activity, which reads again. Entries for sessions that
//! left the index are forgotten at the end of each pass, so the memo never
//! outgrows the index.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// One remembered lookup answer.
struct Remembered {
    last_activity_at: i64,
    message: Option<String>,
}

/// The cross-pass memo of targeted first-message lookups. Cheap to clone
/// (shared state).
#[derive(Clone, Default)]
pub struct FirstMessageLookupMemo {
    inner: Arc<Mutex<HashMap<String, Remembered>>>,
}

impl FirstMessageLookupMemo {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Remembered>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The session's first user message at `last_activity_at`: the
    /// remembered answer when this activity was already read, else
    /// `read()`'s (remembered for later passes).
    pub(crate) async fn first_message<F, Fut>(
        &self,
        session_id: &str,
        last_activity_at: i64,
        read: F,
    ) -> Option<String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Option<String>>,
    {
        if let Some(remembered) = self.map().get(session_id) {
            if remembered.last_activity_at == last_activity_at {
                return remembered.message.clone();
            }
        }
        let message = read().await;
        tracing::debug!(
            target: "freshell_server::auto_title_sweep",
            op = "first_message_lookup",
            session_id = %session_id,
            found = message.is_some(),
            "session_names.first_message_lookup"
        );
        self.map().insert(
            session_id.to_string(),
            Remembered {
                last_activity_at,
                message: message.clone(),
            },
        );
        message
    }

    /// Forget every session that is not in this pass's index rows.
    pub(crate) fn retain_sessions(&self, live: &HashSet<&str>) {
        self.map()
            .retain(|session_id, _| live.contains(session_id.as_str()));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map().len()
    }
}

/// The targeted lookup for one OpenCode row through the shared index (a
/// blocking read-only query, off the async executor), remembered in the
/// sweep state's memo.
pub(crate) async fn opencode_first_message(
    state: &super::AutoTitleSweepState,
    row: &super::SweepSession,
) -> Option<String> {
    let index = state.index.clone()?;
    let session_id = row.session_id.clone();
    state
        .first_message_lookups
        .first_message(&row.session_id, row.last_activity_at, || async move {
            tokio::task::spawn_blocking(move || index.opencode_first_user_message(&session_id))
                .await
                .ok()
                .flatten()
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn look(
        memo: &FirstMessageLookupMemo,
        reads: &AtomicUsize,
        session_id: &str,
        at: i64,
        answer: Option<&str>,
    ) -> Option<String> {
        memo.first_message(session_id, at, || async {
            reads.fetch_add(1, Ordering::SeqCst);
            answer.map(str::to_string)
        })
        .await
    }

    #[tokio::test]
    async fn an_answer_is_read_once_per_activity_stamp() {
        let memo = FirstMessageLookupMemo::default();
        let reads = AtomicUsize::new(0);
        for _ in 0..3 {
            assert_eq!(look(&memo, &reads, "ses_silent", 10, None).await, None);
        }
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "no user message: read once"
        );
        assert_eq!(
            look(&memo, &reads, "ses_silent", 20, Some("Now it has one"))
                .await
                .as_deref(),
            Some("Now it has one"),
            "newer activity reads again"
        );
        assert_eq!(
            look(&memo, &reads, "ses_silent", 20, None).await.as_deref(),
            Some("Now it has one"),
            "a found message is remembered too"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn sessions_that_left_the_index_are_forgotten() {
        let memo = FirstMessageLookupMemo::default();
        let reads = AtomicUsize::new(0);
        look(&memo, &reads, "ses_kept", 1, None).await;
        look(&memo, &reads, "ses_gone", 1, None).await;
        memo.retain_sessions(&HashSet::from(["ses_kept"]));
        assert_eq!(memo.len(), 1);
        look(&memo, &reads, "ses_kept", 1, None).await;
        assert_eq!(
            reads.load(Ordering::SeqCst),
            2,
            "the kept session is still remembered"
        );
    }
}

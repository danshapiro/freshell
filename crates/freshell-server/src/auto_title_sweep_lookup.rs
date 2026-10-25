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
//! every 5-second pass forever, so every ANSWER (the message, or "no user
//! message") is remembered ACROSS passes, keyed by session id and the index
//! row's last activity: a new message moves the row's activity, which reads
//! again. A FAILED read (the database stayed busy past its timeout, the
//! query failed, the task died) is not an answer: it is logged as a warning
//! and retried on the first pass after [`FAILED_LOOKUP_RETRY`] — or at once
//! when the row's activity moves — so one transient failure never puts off
//! a session's first-message name, and a lasting one costs one read and one
//! warning per session per window. Entries for sessions that left the index
//! are forgotten at the end of each pass, so the memo never outgrows the
//! index.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_sessions::directory_index::FirstUserMessageRead;
use freshell_sessions::parse::OpencodeByIdError;

/// How long a FAILED read waits before a later pass retries it.
pub(crate) const FAILED_LOOKUP_RETRY: Duration = Duration::from_secs(60);

/// What the memo holds for one session, at one index activity stamp.
enum Remembered {
    /// A known answer: the first user message, or `None` (no user message).
    Answer {
        last_activity_at: i64,
        message: Option<String>,
    },
    /// The read failed; no read again before `retry_at` at this stamp.
    Failed {
        last_activity_at: i64,
        retry_at: Instant,
    },
}

/// What a lookup at one activity stamp should do.
enum Recall {
    /// Serve this remembered answer.
    Answer(Option<String>),
    /// A recent read failed: no message this pass, no read.
    Waiting,
    /// Read now.
    Read,
}

impl Remembered {
    fn recall(&self, last_activity_at: i64, now: Instant) -> Recall {
        match self {
            Self::Answer {
                last_activity_at: at,
                message,
            } if *at == last_activity_at => Recall::Answer(message.clone()),
            Self::Failed {
                last_activity_at: at,
                retry_at,
            } if *at == last_activity_at && now < *retry_at => Recall::Waiting,
            _ => Recall::Read,
        }
    }
}

/// The cross-pass memo of targeted first-message lookups. Cheap to clone
/// (shared state).
#[derive(Clone)]
pub struct FirstMessageLookupMemo {
    inner: Arc<Mutex<HashMap<String, Remembered>>>,
    failure_retry: Duration,
}

impl Default for FirstMessageLookupMemo {
    fn default() -> Self {
        Self::with_failure_retry(FAILED_LOOKUP_RETRY)
    }
}

impl FirstMessageLookupMemo {
    /// A memo whose failed reads are retried after `failure_retry` (the
    /// sweep uses [`FAILED_LOOKUP_RETRY`]).
    pub(crate) fn with_failure_retry(failure_retry: Duration) -> Self {
        Self {
            inner: Arc::default(),
            failure_retry,
        }
    }

    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Remembered>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The session's first user message at `last_activity_at`: the
    /// remembered answer when this activity was already read, `None` while
    /// a failed read waits out its retry window, else `read()`'s — an
    /// answer is remembered for later passes, a failure only delays the
    /// next read.
    pub(crate) async fn first_message<F, Fut>(
        &self,
        session_id: &str,
        last_activity_at: i64,
        read: F,
    ) -> Option<String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = FirstUserMessageRead>,
    {
        let recall = self
            .map()
            .get(session_id)
            .map_or(Recall::Read, |remembered| {
                remembered.recall(last_activity_at, Instant::now())
            });
        match recall {
            Recall::Answer(message) => return message,
            Recall::Waiting => return None,
            Recall::Read => {}
        }
        let (remembered, message) = match read().await {
            Ok(message) => {
                tracing::debug!(
                    target: "freshell_server::auto_title_sweep",
                    op = "first_message_lookup",
                    session_id = %session_id,
                    found = message.is_some(),
                    "session_names.first_message_lookup"
                );
                (
                    Remembered::Answer {
                        last_activity_at,
                        message: message.clone(),
                    },
                    message,
                )
            }
            Err(failure) => {
                tracing::warn!(
                    target: "freshell_server::auto_title_sweep",
                    op = "first_message_lookup",
                    session_id = %session_id,
                    code = failure.code.as_deref().unwrap_or("unknown"),
                    error = %failure.message,
                    retry_in_ms = u64::try_from(self.failure_retry.as_millis()).unwrap_or(u64::MAX),
                    "session_names.first_message_lookup_failed: the targeted first-message read failed; a later pass retries it"
                );
                (
                    Remembered::Failed {
                        last_activity_at,
                        retry_at: Instant::now() + self.failure_retry,
                    },
                    None,
                )
            }
        };
        self.map().insert(session_id.to_string(), remembered);
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
/// blocking read-only query, off the async executor), through the sweep
/// state's memo. A failed query and a failed blocking task are both failed
/// reads (retried later), never "no user message".
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
                .unwrap_or_else(|join| {
                    Err(OpencodeByIdError {
                        code: None,
                        message: format!("the lookup task failed: {join}"),
                    })
                })
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
        read_with(memo, reads, session_id, at, Ok(answer.map(str::to_string))).await
    }

    async fn read_with(
        memo: &FirstMessageLookupMemo,
        reads: &AtomicUsize,
        session_id: &str,
        at: i64,
        read: FirstUserMessageRead,
    ) -> Option<String> {
        memo.first_message(session_id, at, || async {
            reads.fetch_add(1, Ordering::SeqCst);
            read
        })
        .await
    }

    fn busy() -> FirstUserMessageRead {
        Err(OpencodeByIdError {
            code: Some("SQLITE_BUSY".to_string()),
            message: "database is locked".to_string(),
        })
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

    /// A failed read (busy past the timeout, a query error, a failed task)
    /// is never remembered as "no user message": the pass after the retry
    /// window reads again, and the found message is then remembered.
    #[tokio::test]
    async fn a_failed_read_is_retried_after_the_retry_window() {
        let memo = FirstMessageLookupMemo::with_failure_retry(Duration::ZERO);
        let reads = AtomicUsize::new(0);
        assert_eq!(
            read_with(&memo, &reads, "ses_flaky", 10, busy()).await,
            None
        );
        assert_eq!(
            look(
                &memo,
                &reads,
                "ses_flaky",
                10,
                Some("Fix the sardine importer")
            )
            .await
            .as_deref(),
            Some("Fix the sardine importer"),
            "the same activity is read again once the window passed"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert_eq!(
            look(&memo, &reads, "ses_flaky", 10, None).await.as_deref(),
            Some("Fix the sardine importer"),
            "the answer that followed is remembered"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    /// Inside the retry window a failed session is not re-read every pass
    /// (a lasting failure costs one read, and one warning, per window); a
    /// move of its activity reads at once.
    #[tokio::test]
    async fn a_failed_read_waits_out_the_window_unless_the_activity_moves() {
        let events = crate::test_trace_capture::captured_trace_events();
        let session_id = format!("ses_window_{}", uuid::Uuid::new_v4());
        let memo = FirstMessageLookupMemo::with_failure_retry(Duration::from_secs(3_600));
        let reads = AtomicUsize::new(0);
        assert_eq!(
            read_with(&memo, &reads, &session_id, 10, busy()).await,
            None
        );
        assert_eq!(
            look(&memo, &reads, &session_id, 10, Some("unread")).await,
            None,
            "inside the window: no read"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            look(&memo, &reads, &session_id, 20, Some("Now it has one"))
                .await
                .as_deref(),
            Some("Now it has one"),
            "newer activity reads at once"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);

        let warnings: Vec<_> = events
            .snapshot()
            .into_iter()
            .filter(|event| {
                event.level == tracing::Level::WARN
                    && event
                        .message
                        .starts_with("session_names.first_message_lookup_failed")
                    && event.fields.get("session_id") == Some(&session_id)
            })
            .collect();
        assert_eq!(warnings.len(), 1, "one warning for the one failed read");
        assert_eq!(
            warnings[0].fields.get("code").map(String::as_str),
            Some("SQLITE_BUSY")
        );
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

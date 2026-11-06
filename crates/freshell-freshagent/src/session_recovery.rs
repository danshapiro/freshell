//! Server-owned single-flight state for recovering one canonical conversation.
//!
//! Provider adapters retain native start/admission/cleanup behavior and call
//! this holder only after resolving aliases to the canonical provider id. A
//! caller owns a waiter, while the spawned operation belongs to this holder:
//! dropping a socket handler never cancels native recovery or loses its result.

use freshell_agent_runtime::RecoveryStatus;
use futures_util::FutureExt;
use std::{
    collections::HashMap,
    future::Future,
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{watch, Mutex as AsyncMutex};

pub const MAX_FAILED_LAUNCHES: u32 = 3;
pub const RECOVERY_RETRY_FLOOR: Duration = Duration::from_secs(1);

type SharedResult<T, E> = Arc<Result<T, RecoveryFailure<E>>>;

/// A failure reported by an admitted provider operation. Only failures with
/// `counts_as_failed_launch` consume the per-conversation recovery budget.
pub struct RecoveryAttemptFailure<E> {
    pub error: E,
    pub counts_as_failed_launch: bool,
}

impl<E> RecoveryAttemptFailure<E> {
    pub fn launch(error: E) -> Self {
        Self {
            error,
            counts_as_failed_launch: true,
        }
    }

    pub fn refusal(error: E) -> Self {
        Self {
            error,
            counts_as_failed_launch: false,
        }
    }
}

/// The shared result for the whole operation cohort. Provider failures retain
/// their native typed error; a panic is settled explicitly instead of leaving
/// every joined caller waiting forever.
#[derive(Debug)]
pub enum RecoveryFailure<E> {
    Attempt(E),
    Panicked,
}

/// One caller's view of a shared operation. `result` is shared by reference so
/// provider errors do not need to be cloned or translated between waiters.
pub struct RecoveryAnswer<T, E> {
    pub operation_id: String,
    pub result: SharedResult<T, E>,
    pub status: RecoveryStatus,
    pub joined_existing: bool,
}

pub struct SessionRecoveryMap<T, E> {
    inner: Arc<SessionRecoveryInner<T, E>>,
}

impl<T, E> Clone for SessionRecoveryMap<T, E> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

struct SessionRecoveryInner<T, E> {
    entries: AsyncMutex<HashMap<String, Arc<RecoveryEntry<T, E>>>>,
    retry_floor: Duration,
    maximum_failed_launches: u32,
}

struct RecoveryEntry<T, E> {
    state: Mutex<RecoveryEntryState<T, E>>,
}

struct RecoveryEntryState<T, E> {
    operation_id: String,
    in_flight: bool,
    failed_launches: u32,
    retry_until: Option<Instant>,
    exhausted: bool,
    waiters: usize,
    result: Option<SharedResult<T, E>>,
    current: Option<Arc<RecoveryOperation<T, E>>>,
}

struct RecoveryOperation<T, E> {
    operation_id: String,
    result_tx: watch::Sender<Option<SharedResult<T, E>>>,
}

enum Admission<T, E> {
    Start {
        entry: Arc<RecoveryEntry<T, E>>,
        operation: Arc<RecoveryOperation<T, E>>,
        receiver: watch::Receiver<Option<SharedResult<T, E>>>,
    },
    Join {
        entry: Arc<RecoveryEntry<T, E>>,
        operation_id: String,
        receiver: watch::Receiver<Option<SharedResult<T, E>>>,
        waiter_count: usize,
    },
    Cached {
        entry: Arc<RecoveryEntry<T, E>>,
        operation_id: String,
        result: SharedResult<T, E>,
    },
}

struct WaiterGuard<T, E> {
    entry: Arc<RecoveryEntry<T, E>>,
    operation_id: String,
}

impl<T, E> Drop for WaiterGuard<T, E> {
    fn drop(&mut self) {
        let mut state = self
            .entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.operation_id == self.operation_id {
            state.waiters = state.waiters.saturating_sub(1);
        }
    }
}

impl<T, E> Default for SessionRecoveryMap<T, E> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T, E> SessionRecoveryMap<T, E> {
    pub fn new() -> Self {
        Self::with_policy(MAX_FAILED_LAUNCHES, RECOVERY_RETRY_FLOOR)
    }

    pub fn with_policy(maximum_failed_launches: u32, retry_floor: Duration) -> Self {
        Self {
            inner: Arc::new(SessionRecoveryInner {
                entries: AsyncMutex::new(HashMap::new()),
                retry_floor,
                maximum_failed_launches,
            }),
        }
    }

    /// Read the current per-session state without starting work, resetting the
    /// budget, or changing retry timing. `key` must already be canonical.
    pub async fn status(&self, key: &str) -> Option<RecoveryStatus> {
        let entry = self.inner.entries.lock().await.get(key).cloned()?;
        let state = entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.in_flight
            && state.waiters == 0
            && state.result.as_ref().is_some_and(|result| result.is_ok())
        {
            return None;
        }
        Some(recovery_status(&state))
    }

    /// Read recovery facts without waiting for admission. Lifecycle code uses
    /// this before taking an existing owner fence, where an await could let a
    /// map-hit incumbent remain unfenced while another task holds its map.
    pub fn try_status(&self, key: &str) -> Option<RecoveryStatus> {
        let entries = self.inner.entries.try_lock().ok()?;
        let entry = entries.get(key).cloned()?;
        drop(entries);
        let state = entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.in_flight
            && state.waiters == 0
            && state.result.as_ref().is_some_and(|result| result.is_ok())
        {
            return None;
        }
        Some(recovery_status(&state))
    }

    #[cfg(test)]
    pub(crate) async fn waiter_count_for_test(&self, key: &str) -> usize {
        let Some(entry) = self.inner.entries.lock().await.get(key).cloned() else {
            return 0;
        };
        let waiters = entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .waiters;
        waiters
    }

    /// Join or start one recovery operation. Work is spawned before waiting,
    /// so the operation survives cancellation of any individual caller.
    pub async fn run<F, Fut>(&self, key: impl Into<String>, start: F) -> RecoveryAnswer<T, E>
    where
        T: Send + Sync + 'static,
        E: Send + Sync + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, RecoveryAttemptFailure<E>>> + Send + 'static,
    {
        self.run_with_requester(key, None, start).await
    }

    /// Join or start one recovery operation while retaining the initiating
    /// request's id in structured admission logs. The log is emitted before a
    /// caller waits for the shared result, so diagnostics can distinguish
    /// concurrent joins from a later retry after a provider timeout.
    pub async fn run_with_requester<F, Fut>(
        &self,
        key: impl Into<String>,
        request_id: Option<String>,
        start: F,
    ) -> RecoveryAnswer<T, E>
    where
        T: Send + Sync + 'static,
        E: Send + Sync + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, RecoveryAttemptFailure<E>>> + Send + 'static,
    {
        self.run_with_requester_preflight(key, request_id, || None, start)
            .await
    }

    /// Join or start one recovery operation after checking current authority
    /// whenever admission would return a cached failure or start a new
    /// operation. Existing in-flight and successful-cohort joiners bypass the
    /// check so they can consume the operation that already owns `Starting`.
    /// A preflight refusal is requester-scoped and never changes the retry
    /// budget or starts provider work.
    pub async fn run_with_requester_preflight<F, Fut, P>(
        &self,
        key: impl Into<String>,
        request_id: Option<String>,
        mut preflight: P,
        start: F,
    ) -> RecoveryAnswer<T, E>
    where
        T: Send + Sync + 'static,
        E: Send + Sync + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, RecoveryAttemptFailure<E>>> + Send + 'static,
        P: FnMut() -> Option<E> + Send,
    {
        let key = key.into();
        let admission = {
            let mut entries = self.inner.entries.lock().await;
            let entry = entries
                .entry(key.clone())
                .or_insert_with(|| {
                    Arc::new(RecoveryEntry {
                        state: Mutex::new(RecoveryEntryState {
                            operation_id: String::new(),
                            in_flight: false,
                            failed_launches: 0,
                            retry_until: None,
                            exhausted: false,
                            waiters: 0,
                            result: None,
                            current: None,
                        }),
                    })
                })
                .clone();
            let mut state = entry
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let now = Instant::now();
            if state.in_flight {
                let operation = state
                    .current
                    .as_ref()
                    .expect("in-flight recovery has an operation");
                let receiver = operation.result_tx.subscribe();
                let operation_id = operation.operation_id.clone();
                state.waiters += 1;
                Admission::Join {
                    entry: entry.clone(),
                    operation_id,
                    receiver,
                    waiter_count: state.waiters,
                }
            } else if state.exhausted
                || state
                    .retry_until
                    .is_some_and(|retry_until| now < retry_until)
            {
                if let Some(error) = preflight() {
                    tracing::info!(target: "freshell_freshagent::session_recovery",
                        event = "freshagent.recovery_admission_refused",
                        canonical_key = %key,
                        operation_id = %state.operation_id,
                        request_id = request_id.as_deref().unwrap_or(""),
                        admission = "cached",
                        "current ownership prevented reuse of the cached recovery outcome");
                    return RecoveryAnswer {
                        operation_id: state.operation_id.clone(),
                        result: Arc::new(Err(RecoveryFailure::Attempt(error))),
                        status: recovery_status(&state),
                        joined_existing: true,
                    };
                }
                Admission::Cached {
                    operation_id: state.operation_id.clone(),
                    result: state
                        .result
                        .as_ref()
                        .expect("settled recovery retains its result")
                        .clone(),
                    entry: entry.clone(),
                }
            } else if state.result.as_ref().is_some_and(|result| result.is_ok())
                && state.waiters > 0
            {
                // A slow requester from the just-completed successful cohort
                // is still consuming that result; a late view may join it.
                let operation = state
                    .current
                    .as_ref()
                    .expect("successful recovery has an operation");
                let receiver = operation.result_tx.subscribe();
                let operation_id = operation.operation_id.clone();
                state.waiters += 1;
                Admission::Join {
                    entry: entry.clone(),
                    operation_id,
                    receiver,
                    waiter_count: state.waiters,
                }
            } else {
                if let Some(error) = preflight() {
                    tracing::info!(target: "freshell_freshagent::session_recovery",
                        event = "freshagent.recovery_admission_refused",
                        canonical_key = %key,
                        operation_id = %state.operation_id,
                        request_id = request_id.as_deref().unwrap_or(""),
                        admission = "start",
                        "current ownership prevented a new recovery operation");
                    return RecoveryAnswer {
                        operation_id: state.operation_id.clone(),
                        result: Arc::new(Err(RecoveryFailure::Attempt(error))),
                        status: recovery_status(&state),
                        joined_existing: false,
                    };
                }
                let operation_id = uuid::Uuid::new_v4().to_string();
                let (result_tx, receiver) = watch::channel(None);
                let operation = Arc::new(RecoveryOperation {
                    operation_id: operation_id.clone(),
                    result_tx,
                });
                state.operation_id = operation_id;
                state.in_flight = true;
                state.retry_until = None;
                state.exhausted = false;
                state.waiters = 1;
                state.result = None;
                state.current = Some(operation.clone());
                Admission::Start {
                    entry: entry.clone(),
                    operation,
                    receiver,
                }
            }
        };

        let (operation_id, admission_kind, waiter_count) = match &admission {
            Admission::Start { operation, .. } => {
                (operation.operation_id.clone(), "started", 1usize)
            }
            Admission::Join {
                operation_id,
                waiter_count,
                ..
            } => (operation_id.clone(), "joined", *waiter_count),
            Admission::Cached { operation_id, .. } => (operation_id.clone(), "cached", 0usize),
        };
        let admitted_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        tracing::info!(target: "freshell_freshagent::session_recovery",
            event = "freshagent.recovery_admitted",
            canonical_key = %key,
            operation_id = %operation_id,
            admission = admission_kind,
            waiter_count,
            admitted_at_ms,
            request_id = request_id.as_deref().unwrap_or(""),
            "Freshagent requester admitted to shared recovery");

        match admission {
            Admission::Cached {
                entry,
                operation_id,
                result,
            } => RecoveryAnswer {
                status: {
                    let state = entry
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    recovery_status(&state)
                },
                operation_id,
                result,
                joined_existing: true,
            },
            Admission::Join {
                entry,
                operation_id,
                receiver,
                waiter_count: _,
            } => {
                let _waiter = WaiterGuard {
                    entry: entry.clone(),
                    operation_id: operation_id.clone(),
                };
                let result = await_result(receiver).await;
                let status = {
                    let state = entry
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    recovery_status(&state)
                };
                RecoveryAnswer {
                    operation_id,
                    result,
                    status,
                    joined_existing: true,
                }
            }
            Admission::Start {
                entry,
                operation,
                receiver,
            } => {
                let _waiter = WaiterGuard {
                    entry: entry.clone(),
                    operation_id: operation.operation_id.clone(),
                };
                let state = entry.clone();
                let operation_id = operation.operation_id.clone();
                let answer_operation_id = operation_id.clone();
                let retry_floor = self.inner.retry_floor;
                let maximum_failed_launches = self.inner.maximum_failed_launches;
                let operation_tx = operation.result_tx.clone();
                tokio::spawn(async move {
                    let settled = AssertUnwindSafe(start()).catch_unwind().await;
                    let (outcome, failed_launch): (SharedResult<T, E>, bool) = match settled {
                        Ok(Ok(value)) => (Arc::new(Ok(value)), false),
                        Ok(Err(failure)) => (
                            Arc::new(Err(RecoveryFailure::Attempt(failure.error))),
                            failure.counts_as_failed_launch,
                        ),
                        Err(_) => {
                            tracing::error!(target: "freshell_freshagent::session_recovery",
                                event = "freshagent.recovery_operation_panicked",
                                operation_id = %operation_id,
                                "the shared recovery operation panicked before settling");
                            (Arc::new(Err(RecoveryFailure::Panicked)), false)
                        }
                    };
                    let mut current = state
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if current.operation_id == operation_id {
                        current.in_flight = false;
                        current.result = Some(outcome.clone());
                        match outcome.as_ref() {
                            Ok(_) => {
                                current.failed_launches = 0;
                                current.retry_until = None;
                                current.exhausted = false;
                            }
                            Err(RecoveryFailure::Attempt(_)) if failed_launch => {
                                current.failed_launches = current.failed_launches.saturating_add(1);
                                current.retry_until = Some(Instant::now() + retry_floor);
                                current.exhausted =
                                    current.failed_launches >= maximum_failed_launches;
                            }
                            Err(_) => {
                                current.retry_until = Some(Instant::now() + retry_floor);
                                current.exhausted =
                                    current.failed_launches >= maximum_failed_launches;
                            }
                        }
                    }
                    operation_tx.send_replace(Some(outcome));
                });
                let result = await_result(receiver).await;
                let status = {
                    let state = entry
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    recovery_status(&state)
                };
                RecoveryAnswer {
                    operation_id: answer_operation_id,
                    result,
                    status,
                    joined_existing: false,
                }
            }
        }
    }

    /// Join a recovery that already exists without ever starting a new one.
    /// This is for callers that observed a lifecycle owner in `Starting` and
    /// must close the gap between that observation and waiter admission
    /// without risking a duplicate provider launch.
    pub async fn join_existing(
        &self,
        key: &str,
        request_id: Option<String>,
    ) -> Option<RecoveryAnswer<T, E>>
    where
        T: Send + Sync + 'static,
        E: Send + Sync + 'static,
    {
        self.join_existing_with_requester_preflight(key, request_id, || None)
            .await
    }

    /// Join an existing recovery while checking current authority before
    /// returning a cached failure. A requester that reaches an operation
    /// while it is still in flight joins that cohort without preflight, so a
    /// later owner transition cannot replace its shared result.
    pub async fn join_existing_with_requester_preflight<P>(
        &self,
        key: &str,
        request_id: Option<String>,
        mut preflight: P,
    ) -> Option<RecoveryAnswer<T, E>>
    where
        T: Send + Sync + 'static,
        E: Send + Sync + 'static,
        P: FnMut() -> Option<E> + Send,
    {
        enum ExistingAdmission<T, E> {
            Join {
                entry: Arc<RecoveryEntry<T, E>>,
                operation_id: String,
                receiver: watch::Receiver<Option<SharedResult<T, E>>>,
                waiter_count: usize,
            },
            Cached {
                entry: Arc<RecoveryEntry<T, E>>,
                operation_id: String,
                result: SharedResult<T, E>,
            },
        }

        let admission = {
            let entries = self.inner.entries.lock().await;
            let entry = entries.get(key)?.clone();
            let mut state = entry
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let now = Instant::now();
            if state.in_flight
                || (state.result.as_ref().is_some_and(|result| result.is_ok()) && state.waiters > 0)
            {
                let operation = state
                    .current
                    .as_ref()
                    .expect("active recovery cohort has an operation");
                let receiver = operation.result_tx.subscribe();
                let operation_id = operation.operation_id.clone();
                state.waiters += 1;
                ExistingAdmission::Join {
                    entry: entry.clone(),
                    operation_id,
                    receiver,
                    waiter_count: state.waiters,
                }
            } else if (state.exhausted
                || state
                    .retry_until
                    .is_some_and(|retry_until| now < retry_until))
                && state.result.is_some()
            {
                if let Some(error) = preflight() {
                    tracing::info!(target: "freshell_freshagent::session_recovery",
                        event = "freshagent.recovery_admission_refused",
                        canonical_key = %key,
                        operation_id = %state.operation_id,
                        request_id = request_id.as_deref().unwrap_or(""),
                        admission = "cached_existing_join",
                        "current ownership prevented reuse of the cached recovery outcome");
                    return Some(RecoveryAnswer {
                        operation_id: state.operation_id.clone(),
                        result: Arc::new(Err(RecoveryFailure::Attempt(error))),
                        status: recovery_status(&state),
                        joined_existing: true,
                    });
                }
                ExistingAdmission::Cached {
                    entry: entry.clone(),
                    operation_id: state.operation_id.clone(),
                    result: state
                        .result
                        .as_ref()
                        .expect("settled recovery retains its result")
                        .clone(),
                }
            } else {
                return None;
            }
        };

        let (operation_id, admission_kind, waiter_count) = match &admission {
            ExistingAdmission::Join {
                operation_id,
                waiter_count,
                ..
            } => (operation_id.clone(), "joined", *waiter_count),
            ExistingAdmission::Cached { operation_id, .. } => {
                (operation_id.clone(), "cached", 0usize)
            }
        };
        let admitted_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        tracing::info!(target: "freshell_freshagent::session_recovery",
            event = "freshagent.recovery_admitted",
            canonical_key = %key,
            operation_id = %operation_id,
            admission = admission_kind,
            waiter_count,
            admitted_at_ms,
            request_id = request_id.as_deref().unwrap_or(""),
            "Freshagent requester joined an existing recovery without starting work");

        Some(match admission {
            ExistingAdmission::Cached {
                entry,
                operation_id,
                result,
            } => RecoveryAnswer {
                status: {
                    let state = entry
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    recovery_status(&state)
                },
                operation_id,
                result,
                joined_existing: true,
            },
            ExistingAdmission::Join {
                entry,
                operation_id,
                receiver,
                waiter_count: _,
            } => {
                let _waiter = WaiterGuard {
                    entry: entry.clone(),
                    operation_id: operation_id.clone(),
                };
                let result = await_result(receiver).await;
                let status = {
                    let state = entry
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    recovery_status(&state)
                };
                RecoveryAnswer {
                    operation_id,
                    result,
                    status,
                    joined_existing: true,
                }
            }
        })
    }
}

async fn await_result<T, E>(
    mut receiver: watch::Receiver<Option<SharedResult<T, E>>>,
) -> SharedResult<T, E> {
    loop {
        if let Some(result) = receiver.borrow().as_ref() {
            return result.clone();
        }
        if receiver.changed().await.is_err() {
            return Arc::new(Err(RecoveryFailure::Panicked));
        }
    }
}

fn recovery_status<T, E>(state: &RecoveryEntryState<T, E>) -> RecoveryStatus {
    let retry_after_ms = if state.exhausted {
        None
    } else {
        state.retry_until.and_then(|retry_until| {
            let remaining = retry_until.saturating_duration_since(Instant::now());
            (remaining > Duration::ZERO).then(|| remaining.as_millis().min(u64::MAX as u128) as u64)
        })
    };
    RecoveryStatus {
        operation_id: state.operation_id.clone(),
        in_flight: state.in_flight,
        failed_launches: state.failed_launches,
        retry_after_ms,
        exhausted: state.exhausted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    type TestRecovery = SessionRecoveryMap<String, &'static str>;

    #[tokio::test]
    async fn shared_recovery_success_fans_out_one_committed_identity() {
        let recovery = TestRecovery::with_policy(3, Duration::from_secs(1));
        let starts = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());

        let first_recovery = recovery.clone();
        let first_starts = starts.clone();
        let first_started = started.clone();
        let first_release = release.clone();
        let first = tokio::spawn(async move {
            first_recovery
                .run("claude:canonical-session", move || async move {
                    first_starts.fetch_add(1, Ordering::SeqCst);
                    first_started.notify_one();
                    first_release.notified().await;
                    Ok("session=canonical-session; owner=committed".to_string())
                })
                .await
        });

        started.notified().await;
        let second_recovery = recovery.clone();
        let second = tokio::spawn(async move {
            second_recovery
                .run("claude:canonical-session", || async {
                    panic!("a joining view must not start another provider launch")
                })
                .await
        });
        release.notify_one();
        let (first, second) = tokio::join!(first, second);
        let first = first.expect("the first requester settles");
        let second = second.expect("the joining requester settles");

        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(first.operation_id, second.operation_id);
        assert!(Arc::ptr_eq(&first.result, &second.result));
        assert_eq!(
            first.result.as_ref().as_ref().unwrap(),
            "session=canonical-session; owner=committed"
        );
    }

    #[tokio::test]
    async fn shared_recovery_dropped_waiter_does_not_cancel_the_operation() {
        let recovery = TestRecovery::with_policy(3, Duration::from_secs(1));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let first_recovery = recovery.clone();
        let first_started = started.clone();
        let first_release = release.clone();
        let first = tokio::spawn(async move {
            first_recovery
                .run("codex:thread", move || async move {
                    first_started.notify_one();
                    first_release.notified().await;
                    Ok("same thread and owner fence".to_string())
                })
                .await
        });
        started.notified().await;
        first.abort();
        let _ = first.await;
        assert!(recovery.status("codex:thread").await.unwrap().in_flight);

        let follower = recovery.run("codex:thread", || async {
            panic!("a surviving requester must join the server-owned launch")
        });
        release.notify_one();
        let result = follower.await;
        assert_eq!(
            result.result.as_ref().as_ref().unwrap(),
            "same thread and owner fence"
        );
        assert!(!result.status.in_flight);
    }

    #[tokio::test]
    async fn shared_recovery_failure_has_a_retry_floor_and_counts_only_real_failed_launches() {
        let recovery = TestRecovery::with_policy(3, Duration::from_millis(20));
        let starts = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());

        let first_recovery = recovery.clone();
        let first_starts = starts.clone();
        let first_started = started.clone();
        let first_release = release.clone();
        let first = tokio::spawn(async move {
            first_recovery
                .run("opencode:ses-canonical", move || async move {
                    first_starts.fetch_add(1, Ordering::SeqCst);
                    first_started.notify_one();
                    first_release.notified().await;
                    Err(RecoveryAttemptFailure::launch("transient"))
                })
                .await
        });
        started.notified().await;
        let second_recovery = recovery.clone();
        let second = tokio::spawn(async move {
            second_recovery
                .run("opencode:ses-canonical", || async {
                    panic!("same-locator attach joins the in-flight recovery")
                })
                .await
        });
        release.notify_one();
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(first.operation_id, second.operation_id);
        assert!(Arc::ptr_eq(&first.result, &second.result));
        assert_eq!(first.status.failed_launches, 1);
        assert!(first.status.retry_after_ms.is_some());

        let late = recovery
            .run("opencode:ses-canonical", || async {
                panic!("the retry floor retains the failed cohort outcome")
            })
            .await;
        assert_eq!(late.operation_id, first.operation_id);
        assert_eq!(late.status.failed_launches, 1);
        assert_eq!(starts.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(25)).await;
        let refused = recovery
            .run("opencode:ses-canonical", || async {
                Err(RecoveryAttemptFailure::refusal("terminal owns the key"))
            })
            .await;
        assert_eq!(refused.status.failed_launches, 1);
        assert!(!refused.status.exhausted);

        tokio::time::sleep(Duration::from_millis(25)).await;
        let second_failure = recovery
            .run("opencode:ses-canonical", || async {
                Err(RecoveryAttemptFailure::launch("second transient"))
            })
            .await;
        assert_eq!(second_failure.status.failed_launches, 2);
        tokio::time::sleep(Duration::from_millis(25)).await;
        let third_failure = recovery
            .run("opencode:ses-canonical", || async {
                Err(RecoveryAttemptFailure::launch("third transient"))
            })
            .await;
        assert_eq!(third_failure.status.failed_launches, 3);
        assert!(third_failure.status.exhausted);
        assert_eq!(third_failure.status.retry_after_ms, None);

        for _ in 0..100 {
            let status = recovery.status("opencode:ses-canonical").await.unwrap();
            assert_eq!(status.failed_launches, 3);
            assert!(status.exhausted);
        }
        let exhausted = recovery
            .run("opencode:ses-canonical", || async {
                panic!("exhaustion is finite and never starts a fourth attempt")
            })
            .await;
        assert_eq!(exhausted.operation_id, third_failure.operation_id);
        assert!(exhausted.status.exhausted);
    }

    #[tokio::test]
    async fn shared_recovery_success_resets_the_failure_episode() {
        let recovery = TestRecovery::with_policy(3, Duration::from_millis(5));
        for expected in 1..=2 {
            let failed = recovery
                .run("claude:reset", || async {
                    Err(RecoveryAttemptFailure::launch("resume failed"))
                })
                .await;
            assert_eq!(failed.status.failed_launches, expected);
            tokio::time::sleep(Duration::from_millis(7)).await;
        }
        let established = recovery
            .run("claude:reset", || async { Ok("ready".to_string()) })
            .await;
        assert_eq!(established.status.failed_launches, 0);
        assert!(!established.status.exhausted);
        let failed_again = recovery
            .run("claude:reset", || async {
                Err(RecoveryAttemptFailure::launch("new episode"))
            })
            .await;
        assert_eq!(failed_again.status.failed_launches, 1);
    }

    #[tokio::test]
    async fn admission_preflight_refuses_cached_failure_and_new_attempt_without_starting() {
        let recovery = TestRecovery::with_policy(3, Duration::from_millis(20));
        let starts = Arc::new(AtomicUsize::new(0));
        let first_starts = starts.clone();
        let failed = recovery
            .run("claude:preflight", move || async move {
                first_starts.fetch_add(1, Ordering::SeqCst);
                Err(RecoveryAttemptFailure::launch("provider failed"))
            })
            .await;
        assert_eq!(failed.status.failed_launches, 1);

        let cached = recovery
            .run_with_requester_preflight(
                "claude:preflight",
                Some("request-cached".into()),
                || Some("terminal owns session"),
                || async { panic!("a cached admission must not start a provider attempt") },
            )
            .await;
        assert!(matches!(
            cached.result.as_ref(),
            Err(RecoveryFailure::Attempt("terminal owns session"))
        ));
        assert_eq!(cached.operation_id, failed.operation_id);
        assert_eq!(cached.status.failed_launches, 1);

        tokio::time::sleep(Duration::from_millis(25)).await;
        let retry = recovery
            .run_with_requester_preflight(
                "claude:preflight",
                Some("request-retry".into()),
                || Some("terminal owns session"),
                || async { panic!("a refused retry must not start another provider attempt") },
            )
            .await;
        assert!(matches!(
            retry.result.as_ref(),
            Err(RecoveryFailure::Attempt("terminal owns session"))
        ));
        assert_eq!(retry.operation_id, failed.operation_id);
        assert_eq!(retry.status.failed_launches, 1);
        assert!(!retry.joined_existing);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn existing_join_preserves_in_flight_result_across_later_owner_handoff() {
        let recovery = TestRecovery::with_policy(3, Duration::from_secs(1));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let handed_off = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let preflight_calls = Arc::new(AtomicUsize::new(0));

        let first_recovery = recovery.clone();
        let first_started = started.clone();
        let first_release = release.clone();
        let first = tokio::spawn(async move {
            first_recovery
                .run("opencode:handoff-race", move || async move {
                    first_started.notify_one();
                    first_release.notified().await;
                    Err(RecoveryAttemptFailure::launch("original provider failure"))
                })
                .await
        });
        started.notified().await;

        let late_recovery = recovery.clone();
        let late_handoff = handed_off.clone();
        let late_preflight_calls = preflight_calls.clone();
        let late = tokio::spawn(async move {
            late_recovery
                .join_existing_with_requester_preflight(
                    "opencode:handoff-race",
                    Some("late-map-hit".into()),
                    move || {
                        late_preflight_calls.fetch_add(1, Ordering::SeqCst);
                        late_handoff
                            .load(Ordering::SeqCst)
                            .then_some("terminal owns session")
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while recovery
                .waiter_count_for_test("opencode:handoff-race")
                .await
                < 2
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the requester is admitted to the actual in-flight operation");

        handed_off.store(true, Ordering::SeqCst);
        release.notify_one();
        let (first, late) = tokio::join!(first, late);
        let first = first.unwrap();
        let late = late
            .unwrap()
            .expect("the existing recovery is still joinable");
        assert_eq!(preflight_calls.load(Ordering::SeqCst), 0);
        assert!(Arc::ptr_eq(&first.result, &late.result));
        assert!(matches!(
            late.result.as_ref(),
            Err(RecoveryFailure::Attempt("original provider failure"))
        ));
        assert_eq!(late.status.failed_launches, 1);
    }
}

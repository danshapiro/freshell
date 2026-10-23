//! Lifecycle of the short-lived helper containers the supervisor runs for one
//! bounded read: the Claude source readers and the provider mountpoint helper.
//!
//! Docker can take tens of seconds to answer a container create. It mounts
//! and unmounts the new container's overlay root filesystem, and the kernel
//! syncs the whole filesystem under Docker's data root when that overlay
//! mount goes away, so the create waits for every dirty page on that disk. On
//! the development host a create took about 0.1s idle, 4.5s with 1 GB of dirty
//! data and 16.7s with 3 GB, and up to 31s during busy test runs; the next
//! create, with little left to flush, is fast again. Three rules follow:
//!
//! 1. A create keeps running when its caller stops waiting
//!    ([`InFlightCreate`]). Dropping the request does not stop Docker; it only
//!    hides whether the helper now exists.
//! 2. An attempt's objects are removed only once every create they came from
//!    has answered, by exact name with confirmed absence
//!    ([`DockerEngineBackend::release_helper_objects`]). Objects stay owned
//!    until their absence is confirmed: a create still unanswered when its
//!    caller's wait ends, or a removal that runs out of time or fails, goes to
//!    a background reaper that keeps removing them
//!    ([`DockerEngineBackend::reap_helper_objects`]).
//! 3. A helper run whose create or start timed out, or that Docker refused or
//!    dropped transiently, is retried within a bounded budget
//!    ([`DockerEngineBackend::retry_helper`]). Every other failure is final.
use super::*;
use std::future::Future;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Exact-name removal of one attempt's helper objects, once every create they
/// came from has answered.
pub(super) const HELPER_CLEANUP_BUDGET: Duration = Duration::from_secs(5);

/// How long the background reaper waits for Docker to answer a create whose
/// caller gave up, before it reports the helper's absence as unconfirmed.
const LATE_CREATE_LIMIT: Duration = Duration::from_secs(600);

/// How long the background reaper keeps removing what one attempt left, once
/// every create it came from has answered. A force-remove can wait on the
/// same disk flush a create does, so one removal can take tens of seconds.
const LATE_REMOVAL_LIMIT: Duration = Duration::from_secs(120);

/// The longest wait between two of the background reaper's removal tries.
const LATE_REMOVAL_BACKOFF_CAP: Duration = Duration::from_secs(15);

/// A helper create Docker answers after this long is logged with its
/// latency: a healthy create answers in well under a second.
const SLOW_CREATE: Duration = Duration::from_secs(5);

/// When one helper attempt's work and its cleanup wait end.
#[derive(Debug, Clone, Copy)]
pub(super) struct HelperDeadlines {
    /// The helper's own work (create, start, exchange, wait) ends here.
    pub(super) operation: Instant,
    /// Cleanup waits until here for a create Docker has not answered yet;
    /// after that the background reaper owns its removal.
    pub(super) settle: Instant,
    /// The exact-name removal after every create answered.
    pub(super) cleanup: Duration,
}

impl HelperDeadlines {
    /// A stand-alone attempt: `budget` of work, then up to `settle_after` for
    /// a create Docker has not answered yet.
    pub(super) fn after(budget: Duration, settle_after: Duration) -> Self {
        let operation = Instant::now() + budget;
        Self {
            operation,
            settle: operation + settle_after,
            cleanup: HELPER_CLEANUP_BUDGET,
        }
    }
}

/// Why a failed helper attempt may be retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TransientCause {
    /// The attempt's work outlasted its deadline.
    TimedOut,
    /// Docker answered a create or start with a server error.
    Refused,
    /// A create or start got no answer at all.
    Unanswered,
}

impl TransientCause {
    fn as_str(self) -> &'static str {
        match self {
            Self::TimedOut => "timed_out",
            Self::Refused => "refused",
            Self::Unanswered => "unanswered",
        }
    }
}

/// A failed helper attempt. It is transient only where a create or start
/// timed out, or Docker refused or dropped it without judging the request.
/// Every other failure stays final: changed ownership or topology, a helper
/// that exited without evidence, a client error, an unconfirmed cleanup.
#[derive(Debug)]
pub(super) struct HelperFailure {
    pub(super) error: BackendError,
    transient: Option<(TransientCause, &'static str)>,
}

impl From<BackendError> for HelperFailure {
    fn from(error: BackendError) -> Self {
        Self {
            error,
            transient: None,
        }
    }
}

impl HelperFailure {
    /// The attempt's work outlasted its deadline.
    pub(super) fn timed_out(error: BackendError) -> Self {
        Self {
            error,
            transient: Some((TransientCause::TimedOut, "operation")),
        }
    }

    /// Docker answered `step` ("create" or "start") with `status`. Only a
    /// server error is transient; a client error judged the request.
    pub(super) fn answered(step: &'static str, status: u16, error: BackendError) -> Self {
        Self {
            error,
            transient: (500..600)
                .contains(&status)
                .then_some((TransientCause::Refused, step)),
        }
    }

    /// `step` ("create" or "start") got no answer.
    pub(super) fn unanswered(step: &'static str, error: BackendError) -> Self {
        Self {
            error,
            transient: Some((TransientCause::Unanswered, step)),
        }
    }
}

type CreateAnswer = Result<DockerResponse, BackendError>;

/// Where an [`InFlightCreate`] stands after a bounded wait.
enum Settled {
    /// Nothing was outstanding.
    Idle,
    /// The outstanding create answered while we waited.
    Answered(CreateAnswer),
    /// The create is still unanswered.
    Pending,
}

/// One create request for a helper object. It runs as its own task, so a
/// caller that stops waiting at its deadline does not abandon it: cleanup can
/// still learn whether Docker made the object, and remove it.
#[derive(Default)]
pub(super) struct InFlightCreate(Option<JoinHandle<CreateAnswer>>);

impl InFlightCreate {
    /// Send the create of the object called `name`. A slow answer is logged
    /// with its latency when it arrives, whether or not anyone still waits.
    pub(super) async fn send(
        &mut self,
        backend: &DockerEngineBackend,
        name: &str,
        path: String,
        body: Value,
    ) -> CreateAnswer {
        let backend = backend.clone();
        let name = name.to_owned();
        let request = self.0.insert(tokio::spawn(async move {
            let sent = Instant::now();
            let answer = backend
                .request_bounded("POST", &path, Some(&body), 64 * 1024)
                .await;
            let elapsed = sent.elapsed();
            if elapsed >= SLOW_CREATE {
                backend.helper_event(
                    "supervisor.helper.create_slow",
                    json!({"severity":"warn","name":name,"elapsedMs":millis(elapsed),
                        "status":answer.as_ref().ok().map(|response| response.status)}),
                );
            }
            answer
        }));
        let answer = joined(request.await);
        self.0 = None;
        answer
    }

    /// Wait until the outstanding create answers, at most until `deadline`.
    async fn settle(&mut self, deadline: Instant) -> Settled {
        let Some(request) = self.0.as_mut() else {
            return Settled::Idle;
        };
        match tokio::time::timeout_at(deadline, request).await {
            Ok(answer) => {
                self.0 = None;
                Settled::Answered(joined(answer))
            }
            Err(_) => Settled::Pending,
        }
    }

    /// Wait until the outstanding create answers, at most until `deadline`;
    /// false while it is still unanswered. `attempted` records whether Docker
    /// may hold an object under the create's name: a name conflict proves the
    /// name was never ours.
    pub(super) async fn settle_ownership(
        &mut self,
        deadline: Instant,
        attempted: &mut bool,
    ) -> bool {
        match self.settle(deadline).await {
            Settled::Pending => false,
            Settled::Answered(Ok(response)) if response.status == 409 => {
                *attempted = false;
                true
            }
            Settled::Idle | Settled::Answered(_) => true,
        }
    }
}

fn joined(answer: Result<CreateAnswer, tokio::task::JoinError>) -> CreateAnswer {
    answer.unwrap_or_else(|_| {
        Err(BackendError::Unavailable(
            "helper create request ended without an answer".into(),
        ))
    })
}

/// The Docker objects one helper attempt created or may have created. They
/// are removed only once every create they came from has answered.
#[async_trait]
pub(super) trait HelperObjects: Send + 'static {
    /// The objects' names, for logs.
    fn names(&self) -> Vec<String>;
    /// Wait until every create has answered; false if one is still
    /// unanswered at `deadline`.
    async fn settle(&mut self, deadline: Instant) -> bool;
    /// Remove every owned object by exact name and confirm its absence.
    async fn remove(&mut self, backend: &DockerEngineBackend) -> Result<(), BackendError>;
}

/// Why an attempt's objects went to the background reaper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Deferred {
    /// A create was still unanswered when the caller's wait ended.
    CreateUnanswered,
    /// Every create answered, but removing the objects ran out of time or
    /// failed before their absence was confirmed.
    RemovalUnconfirmed,
}

impl Deferred {
    fn as_str(self) -> &'static str {
        match self {
            Self::CreateUnanswered => "create_unanswered",
            Self::RemovalUnconfirmed => "removal_unconfirmed",
        }
    }
}

/// Which fixed helper a [`HelperContainer`] is, for its ownership check.
#[derive(Debug, Clone, Copy)]
pub(super) enum HelperKind {
    ClaudeSource,
    ClaudeCandidateReader,
    ProviderMountpoints,
}

/// A helper container the supervisor asked Docker to create, owned until its
/// exact-name absence is confirmed.
pub(super) struct HelperContainer {
    kind: HelperKind,
    pub(super) name: String,
    pub(super) expected: Value,
    create: InFlightCreate,
    /// Docker may hold an object under `name` because of this create.
    attempted: bool,
}

impl HelperContainer {
    pub(super) fn new(kind: HelperKind, name: String, expected: Value) -> Self {
        Self {
            kind,
            name,
            expected,
            create: InFlightCreate::default(),
            attempted: false,
        }
    }

    /// Docker has not answered this helper's create yet.
    pub(super) fn is_pending(&self) -> bool {
        self.create.0.is_some()
    }

    /// Ask Docker to create the helper. A name conflict proves the name was
    /// never ours.
    pub(super) async fn create(&mut self, backend: &DockerEngineBackend) -> CreateAnswer {
        self.attempted = true;
        let path = format!("{DOCKER_API}/containers/create?name={}", self.name);
        let answer = self
            .create
            .send(backend, &self.name, path, self.expected.clone())
            .await;
        if matches!(&answer, Ok(response) if response.status == 409) {
            self.attempted = false;
        }
        answer
    }
}

#[async_trait]
impl HelperObjects for HelperContainer {
    fn names(&self) -> Vec<String> {
        vec![self.name.clone()]
    }

    async fn settle(&mut self, deadline: Instant) -> bool {
        self.create
            .settle_ownership(deadline, &mut self.attempted)
            .await
    }

    async fn remove(&mut self, backend: &DockerEngineBackend) -> Result<(), BackendError> {
        if !self.attempted {
            return Ok(());
        }
        match self.kind {
            HelperKind::ClaudeSource => {
                backend
                    .cleanup_claude_source_helper(&self.name, &self.expected)
                    .await
            }
            HelperKind::ClaudeCandidateReader => {
                backend
                    .cleanup_claude_candidate_reader(&self.name, &self.expected)
                    .await
            }
            HelperKind::ProviderMountpoints => {
                backend
                    .cleanup_provider_mountpoint_helper(&self.name, &self.expected)
                    .await
            }
        }?;
        self.attempted = false;
        Ok(())
    }
}

/// Bounded retry of one helper read. Each attempt keeps the helper's own
/// work bound; the whole retry, its waits and its cleanup stay inside
/// `total`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HelperRetryPolicy {
    /// One attempt's helper work.
    pub(crate) attempt: Duration,
    /// Every attempt, the waits between them and the cleanup after them.
    pub(crate) total: Duration,
    /// The exact-name removal after each attempt.
    pub(crate) cleanup: Duration,
    /// The waits before the second and third attempt.
    pub(crate) backoff: [Duration; 2],
    /// A retry starts only with at least this much helper time left.
    pub(crate) min_attempt: Duration,
}

impl HelperRetryPolicy {
    fn max_attempts(&self) -> usize {
        self.backoff.len() + 1
    }
}

/// The Claude source reader: 25 seconds of helper work per attempt (a
/// healthy read takes about two). A stalled create answers only once the host
/// has flushed what was unwritten on Docker's disk: up to 8 GB and a 43-second
/// stall during the provider parity runs on the development host. The whole
/// read therefore gets three attempt lengths, each with its five-second
/// cleanup: the attempt the stall times out, up to one more attempt length
/// for Docker to answer that create, and one full retry after it. A third
/// attempt fits only when an earlier one was refused quickly.
pub(crate) const CLAUDE_SOURCE_READER_RETRY: HelperRetryPolicy = HelperRetryPolicy {
    attempt: Duration::from_secs(25),
    total: Duration::from_secs(3 * (25 + HELPER_CLEANUP_BUDGET.as_secs())),
    cleanup: HELPER_CLEANUP_BUDGET,
    backoff: [Duration::from_secs(1), Duration::from_secs(2)],
    min_attempt: Duration::from_secs(10),
};

fn with_fields(context: &Value, fields: Value) -> Value {
    let mut merged = context.clone();
    if let (Some(merged), Value::Object(fields)) = (merged.as_object_mut(), fields) {
        merged.extend(fields);
    }
    merged
}

fn millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

impl DockerEngineBackend {
    /// A helper lifecycle event: always a tracing event, and a line in the
    /// supervisor's lifecycle JSONL when the backend has one.
    pub(super) fn helper_event(&self, event: &'static str, data: Value) {
        match data["severity"].as_str() {
            Some("error") => tracing::error!(event, data = %data, "helper lifecycle"),
            Some("warn") => tracing::warn!(event, data = %data, "helper lifecycle"),
            _ => tracing::info!(event, data = %data, "helper lifecycle"),
        }
        if let Some(path) = &self.lifecycle_log {
            crate::service::append_event(path, event, data);
        }
    }

    /// Release one attempt's helper objects, then hand back the attempt's
    /// `result`. Waits until `settle` for every create the objects came from
    /// to answer, then removes them by exact name; an unconfirmed removal
    /// replaces the result with a final failure. Objects whose create is
    /// still unanswered, or whose removal is unconfirmed, go to the
    /// background reaper. [`Self::retry_helper`] settles until its last
    /// cleanup reserve and treats an unconfirmed removal as final, so no
    /// retry follows a hand-off: it could not reuse what may still appear
    /// under those names.
    pub(super) async fn release_helper_objects<T, O: HelperObjects>(
        &self,
        helper: &'static str,
        mut objects: O,
        deadlines: HelperDeadlines,
        result: Result<T, HelperFailure>,
    ) -> Result<T, HelperFailure> {
        if !objects.settle(deadlines.settle).await {
            self.reap_helper_objects(helper, objects, Deferred::CreateUnanswered);
            // Every create answered before an attempt could succeed.
            return result.and_then(|_| {
                Err(BackendError::Unavailable(format!(
                    "{helper} create is still unanswered; its removal continues in the background"
                ))
                .into())
            });
        }
        let removed = tokio::time::timeout(deadlines.cleanup, objects.remove(self))
            .await
            .unwrap_or_else(|_| {
                Err(BackendError::Unavailable(format!(
                    "{helper} cleanup timed out"
                )))
            });
        if let Err(error) = removed {
            // The objects stay ours until their absence is confirmed.
            self.reap_helper_objects(helper, objects, Deferred::RemovalUnconfirmed);
            return Err(error.into());
        }
        result
    }

    /// Keep removing `objects` in the background: wait for every create they
    /// came from to answer, then remove them by exact name, retrying with a
    /// growing wait until their absence is confirmed or the reaper's limit
    /// passes. Each removal re-checks ownership, so a retry never removes an
    /// object that is no longer ours.
    pub(super) fn reap_helper_objects<O: HelperObjects>(
        &self,
        helper: &'static str,
        mut objects: O,
        why: Deferred,
    ) {
        let names = objects.names();
        self.helper_event(
            "supervisor.helper.cleanup.deferred",
            json!({"severity":"warn","helper":helper,"names":names,"reason":why.as_str()}),
        );
        let backend = self.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let removed = if objects.settle(started + LATE_CREATE_LIMIT).await {
                backend
                    .keep_removing(&mut objects, Instant::now() + LATE_REMOVAL_LIMIT)
                    .await
            } else {
                Err(BackendError::Unavailable(format!(
                    "{helper} create still unanswered after {}s",
                    LATE_CREATE_LIMIT.as_secs()
                )))
            };
            match removed {
                Ok(()) => backend.helper_event(
                    "supervisor.helper.cleanup.removed",
                    json!({"severity":"info","helper":helper,"names":names,
                        "reason":why.as_str(),"elapsedMs":millis(started.elapsed())}),
                ),
                Err(error) => backend.helper_event(
                    "supervisor.helper.cleanup.unconfirmed",
                    json!({"severity":"error","helper":helper,"names":names,
                        "reason":why.as_str(),"error":error.to_string()}),
                ),
            }
        });
    }

    /// Remove `objects` until their absence is confirmed or `deadline`
    /// passes, waiting longer between tries.
    async fn keep_removing<O: HelperObjects>(
        &self,
        objects: &mut O,
        deadline: Instant,
    ) -> Result<(), BackendError> {
        let mut wait = Duration::from_secs(1);
        loop {
            let error = match tokio::time::timeout_at(deadline, objects.remove(self)).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(error)) => error,
                Err(_) => {
                    return Err(BackendError::Unavailable(format!(
                        "helper removal still unconfirmed after {}s",
                        LATE_REMOVAL_LIMIT.as_secs()
                    )))
                }
            };
            if Instant::now() + wait >= deadline {
                return Err(error);
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(LATE_REMOVAL_BACKOFF_CAP);
        }
    }

    /// Run `attempt` until it succeeds, fails finally, or `policy` leaves no
    /// room for another attempt. An attempt runs only after the previous
    /// one's helpers were removed, so retries never pile creates onto a
    /// stalled daemon. Every attempt and its cleanup end by `until` (and
    /// inside `policy.total`). `context` identifies the read in every event.
    pub(super) async fn retry_helper<T, F, Fut>(
        &self,
        policy: &HelperRetryPolicy,
        helper: &'static str,
        context: Value,
        until: Instant,
        mut attempt: F,
    ) -> Result<T, BackendError>
    where
        F: FnMut(HelperDeadlines) -> Fut,
        Fut: Future<Output = Result<T, HelperFailure>>,
    {
        let started = Instant::now();
        // Every attempt's work and cleanup wait end here, which leaves the
        // last cleanup inside the total and before the caller's end.
        let end = (started + policy.total).min(until);
        let reserve = end
            .checked_sub(policy.cleanup)
            .unwrap_or(started)
            .max(started);
        let mut number = 1;
        loop {
            let deadlines = HelperDeadlines {
                operation: (Instant::now() + policy.attempt).min(reserve),
                settle: reserve,
                cleanup: policy.cleanup,
            };
            let failure = match attempt(deadlines).await {
                Ok(value) => {
                    if number > 1 {
                        self.helper_event(
                            "supervisor.helper.recovered",
                            with_fields(
                                &context,
                                json!({"severity":"info","helper":helper,"attempts":number,
                                    "elapsedMs":millis(started.elapsed())}),
                            ),
                        );
                    }
                    return Ok(value);
                }
                Err(failure) => failure,
            };
            let Some((cause, step)) = failure.transient else {
                return Err(failure.error);
            };
            let detail = json!({"helper":helper,"attempt":number,
                "maxAttempts":policy.max_attempts(),"cause":cause.as_str(),"step":step,
                "reason":failure.error.to_string(),"elapsedMs":millis(started.elapsed())});
            let wait = policy.backoff.get(number - 1).copied().filter(|wait| {
                reserve.saturating_duration_since(Instant::now() + *wait) >= policy.min_attempt
            });
            let Some(wait) = wait else {
                self.helper_event(
                    "supervisor.helper.retry_exhausted",
                    with_fields(&with_fields(&context, detail), json!({"severity":"error"})),
                );
                return Err(failure.error);
            };
            self.helper_event(
                "supervisor.helper.retry",
                with_fields(
                    &with_fields(&context, detail),
                    json!({"severity":"warn","backoffMs":millis(wait)}),
                ),
            );
            tokio::time::sleep(wait).await;
            number += 1;
        }
    }
}

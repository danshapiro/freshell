//! Native title observations never stall an event relay (name-reliability
//! plan, Task 4; G14, G46).
//!
//! Provider lanes (the freshopencode SSE bridge, the codex proxy route, the
//! CLI opencode lane, freshcodex) fold every native title they see into the
//! naming store. The store's transaction takes a cross-process file lock
//! with a one-second budget, so a relay loop that awaited a retry inline
//! would stall behind a busy store. Instead each observation is built ONCE —
//! its location revision stamped at observation time — and makes one
//! attempt; a `LockUnavailable`/`Persistence` failure hands that SAME
//! observation to a background retry (after 200 ms, then 1 s, then it is
//! dropped: the next observation of the target records it again). A retry
//! re-submits the captured observation unchanged, never re-stamped, so if
//! the provider location moved meanwhile it folds as stale (provenance
//! only).
//!
//! Ordering: every observation reserves a per-target sequence number when it
//! is observed (in relay order), and a submission — inline or retry —
//! applies only while its sequence is still the latest reserved for its
//! target, one submission per target at a time. An older title can therefore
//! never land after a newer one.
//!
//! The inline attempt never waits for its target's turn: when another
//! submission of the same target is still inside the store (a background
//! retry, or a concurrent lane's inline attempt), the new observation goes
//! straight to the background, where it takes the turn as soon as it is
//! free (then the same 200 ms / 1 s ladder). The relay's worst case stays
//! one store attempt, never two back to back.
//!
//! The bookkeeping is process-wide, keyed by (sink, target): one sink is one
//! naming store, so this is a per-sink retrier. A target's entry lives only
//! while one of its observations is in flight.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use freshell_protocol::session_names::{SessionNameRef, SessionNameUpdate};

use crate::naming::{
    log_name_error, name_ref_debug_key, NameError, NativeNameObservation, NativeNameOrigin,
    SessionNaming,
};

/// The background retry delays after a failed inline attempt.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(200), Duration::from_millis(1_000)];

/// (sink identity, target key).
type TargetKey = (usize, String);

struct Slot {
    /// The newest sequence reserved for the target.
    latest: u64,
    /// Reserved observations of the target not yet finished.
    in_flight: usize,
    /// One submission per target at a time.
    submit: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Default)]
struct Registry {
    next_seq: u64,
    slots: HashMap<TargetKey, Slot>,
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Mutex::new(Registry::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One reserved observation of a target. Dropping it releases its claim on
/// the target's bookkeeping.
pub struct ObservationTicket {
    key: TargetKey,
    seq: u64,
    sink: Arc<dyn SessionNaming>,
    target: SessionNameRef,
    submit: Arc<tokio::sync::Mutex<()>>,
}

impl ObservationTicket {
    fn is_latest(&self) -> bool {
        registry()
            .slots
            .get(&self.key)
            .is_some_and(|slot| slot.latest == self.seq)
    }
}

impl Drop for ObservationTicket {
    fn drop(&mut self) {
        let mut registry = registry();
        let remove = match registry.slots.get_mut(&self.key) {
            Some(slot) => {
                slot.in_flight = slot.in_flight.saturating_sub(1);
                slot.in_flight == 0
            }
            None => false,
        };
        if remove {
            registry.slots.remove(&self.key);
        }
    }
}

/// Reserve the next sequence for an observation of `target`, superseding
/// every older observation of it still waiting. Synchronous, so a lane that
/// spawns its folds reserves them in relay order.
pub fn reserve(sink: &Arc<dyn SessionNaming>, target: &SessionNameRef) -> ObservationTicket {
    let key: TargetKey = (
        Arc::as_ptr(sink) as *const () as usize,
        name_ref_debug_key(target),
    );
    let mut registry = registry();
    registry.next_seq += 1;
    let seq = registry.next_seq;
    let slot = registry.slots.entry(key.clone()).or_insert_with(|| Slot {
        latest: 0,
        in_flight: 0,
        submit: Arc::new(tokio::sync::Mutex::new(())),
    });
    slot.latest = seq;
    slot.in_flight += 1;
    let submit = Arc::clone(&slot.submit);
    ObservationTicket {
        key,
        seq,
        sink: Arc::clone(sink),
        target: target.clone(),
        submit,
    }
}

enum Attempt {
    Applied(SessionNameUpdate),
    Superseded,
    Retryable(NameError),
    Failed(NameError),
}

/// How an observation reaches the background.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handoff {
    /// The inline attempt failed on a busy or failing store: the backoff
    /// ladder follows.
    AfterFailure,
    /// Another submission of the target held its turn: the observation has
    /// made no attempt yet, so it takes the turn as soon as it is free, then
    /// the ladder.
    TargetBusy,
}

/// One submission. The caller holds the target's turn for the whole call.
async fn fold(ticket: &ObservationTicket, observation: NativeNameObservation) -> Attempt {
    if !ticket.is_latest() {
        return Attempt::Superseded;
    }
    match ticket.sink.observe_native(observation).await {
        Ok(update) => Attempt::Applied(update),
        Err(error @ (NameError::LockUnavailable(_) | NameError::Persistence(_))) => {
            Attempt::Retryable(error)
        }
        Err(error) => Attempt::Failed(error),
    }
}

/// One submission that waits for the target's turn (background only).
async fn attempt(ticket: &ObservationTicket, observation: NativeNameObservation) -> Attempt {
    let _turn = ticket.submit.lock().await;
    fold(ticket, observation).await
}

/// Fold one reserved observation: stamp it with the store's current
/// location revision NOW, make one attempt, and on a busy or failing store
/// hand the same observation to the background retry. When another
/// submission of the target is still inside the store, the observation goes
/// to the background without an inline attempt. Returns the accepted update
/// when the inline attempt applied; `None` otherwise (the caller never waits
/// for a retry or for another submission).
pub async fn submit(
    ticket: ObservationTicket,
    title: String,
    origin: NativeNameOrigin,
    event_id: Option<String>,
) -> Option<SessionNameUpdate> {
    let location_revision = match ticket.sink.current_location_revision(&ticket.target).await {
        Ok(revision) => revision,
        Err(error) => {
            log_name_error("current_location_revision", &ticket.target, &error);
            return None;
        }
    };
    let observation = NativeNameObservation {
        target: ticket.target.clone(),
        title,
        origin,
        location_revision,
        event_id,
    };
    let turn = Arc::clone(&ticket.submit);
    let outcome = match turn.try_lock() {
        Ok(_turn) => fold(&ticket, observation.clone()).await,
        Err(_) => {
            tracing::debug!(
                target: "freshell_freshagent::naming",
                op = "observe_native",
                name_ref = %name_ref_debug_key(&ticket.target),
                "session_names.native_observation_queued_behind_in_flight"
            );
            tokio::spawn(retry(ticket, observation, Handoff::TargetBusy));
            return None;
        }
    };
    match outcome {
        Attempt::Applied(update) => Some(update),
        Attempt::Superseded => None,
        Attempt::Failed(error) => {
            log_name_error("observe_native", &ticket.target, &error);
            None
        }
        Attempt::Retryable(error) => {
            tracing::debug!(
                target: "freshell_freshagent::naming",
                op = "observe_native",
                name_ref = %name_ref_debug_key(&ticket.target),
                class = %error.code(),
                "session_names.native_observation_retry_scheduled"
            );
            tokio::spawn(retry(ticket, observation, Handoff::AfterFailure));
            None
        }
    }
}

/// The background attempts: a busy-target handoff first takes the turn as
/// soon as it is free; then the backoff ladder. Every observation makes at
/// most `RETRY_DELAYS.len() + 1` attempts in all.
async fn retry(ticket: ObservationTicket, observation: NativeNameObservation, handoff: Handoff) {
    // `None`: the queued attempt (no delay, not a retry).
    let queued = (handoff == Handoff::TargetBusy).then_some(None);
    let schedule: Vec<Option<Duration>> = queued
        .into_iter()
        .chain(RETRY_DELAYS.into_iter().map(Some))
        .collect();
    let last = schedule.len() - 1;
    let mut retries = 0usize;
    for (index, delay) in schedule.into_iter().enumerate() {
        if let Some(delay) = delay {
            retries += 1;
            tokio::time::sleep(delay).await;
        }
        match attempt(&ticket, observation.clone()).await {
            Attempt::Applied(_) => {
                // A busy-target handoff that lands at once was queued, not
                // retried: only a real retry is worth an INFO line.
                if delay.is_none() {
                    tracing::debug!(
                        target: "freshell_freshagent::naming",
                        op = "observe_native",
                        name_ref = %name_ref_debug_key(&ticket.target),
                        "session_names.native_observation_queued_applied"
                    );
                } else {
                    tracing::info!(
                        target: "freshell_freshagent::naming",
                        op = "observe_native",
                        name_ref = %name_ref_debug_key(&ticket.target),
                        retry = retries,
                        "session_names.native_observation_retry_applied"
                    );
                }
                return;
            }
            Attempt::Superseded => {
                tracing::debug!(
                    target: "freshell_freshagent::naming",
                    op = "observe_native",
                    name_ref = %name_ref_debug_key(&ticket.target),
                    "session_names.native_observation_retry_superseded"
                );
                return;
            }
            Attempt::Failed(error) => {
                log_name_error("observe_native", &ticket.target, &error);
                return;
            }
            Attempt::Retryable(error) => {
                if index == last {
                    tracing::warn!(
                        target: "freshell_freshagent::naming",
                        op = "observe_native",
                        name_ref = %name_ref_debug_key(&ticket.target),
                        revision = error.log_revision(),
                        class = %error.code(),
                        attempts = RETRY_DELAYS.len() + 1,
                        "session_names.native_observation_retry_gave_up: {error}"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use freshell_protocol::session_names::{
        NameSource, NamedProvider, SessionNameRecord, SessionNameRef,
    };

    use crate::naming::test_support::RecordingSink;
    use crate::naming::{observe_native_live, NativeNameOrigin, SessionNaming};

    fn target(id: &str) -> SessionNameRef {
        SessionNameRef::Session {
            provider: NamedProvider::Opencode,
            session_id: id.to_string(),
        }
    }

    /// A sink that already holds a record for `id`, so an accepted
    /// observation answers `Ok`.
    fn sink_for(id: &str) -> Arc<RecordingSink> {
        let sink = RecordingSink::new();
        sink.seed_record(SessionNameRecord {
            name_ref: target(id),
            name: "proj".into(),
            source: NameSource::Directory,
            revision: 1,
            manual_revision: None,
            renamed_at: None,
            legacy_origin: None,
        });
        sink
    }

    fn dyn_sink(sink: &Arc<RecordingSink>) -> Option<Arc<dyn SessionNaming>> {
        Some(sink.clone() as Arc<dyn SessionNaming>)
    }

    async fn wait_until(budget: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        done()
    }

    /// A locked store never stalls the caller: the inline attempt fails, the
    /// call returns at once, and the background retry lands the title.
    #[tokio::test]
    async fn lock_error_retries_in_background_without_blocking_the_caller() {
        let sink = sink_for("ses_lock");
        sink.fail_next_observations(1);
        let started = Instant::now();
        let answer = observe_native_live(
            &dyn_sink(&sink),
            target("ses_lock"),
            "Publishing blocked by token error",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        let elapsed = started.elapsed();
        assert!(answer.is_none(), "the inline attempt failed");
        assert!(
            elapsed < Duration::from_millis(20),
            "the caller returned at once ({elapsed:?})"
        );
        assert!(
            wait_until(Duration::from_secs(3), || {
                sink.observed_titles() == vec!["Publishing blocked by token error".to_string()]
            })
            .await,
            "the background retry landed the title: attempts {:?}",
            sink.attempted_titles()
        );
    }

    /// A retry applies only while it is still the latest observation of its
    /// target: "A" fails, "B" succeeds inline, so the retry of "A" is dropped
    /// and "B" stays the last word.
    #[tokio::test]
    async fn an_older_title_never_lands_after_a_newer_one() {
        let sink = sink_for("ses_order");
        sink.fail_next_observations(1);
        observe_native_live(
            &dyn_sink(&sink),
            target("ses_order"),
            "A",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        let b = observe_native_live(
            &dyn_sink(&sink),
            target("ses_order"),
            "B",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        assert!(b.is_some(), "B succeeds inline");
        // Past both retry delays (200 ms, then 1 s).
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert_eq!(
            sink.observed_titles(),
            vec!["B".to_string()],
            "the superseded retry of A never landed"
        );
        assert_eq!(
            sink.attempted_titles(),
            vec!["A".to_string(), "B".to_string()],
            "A was never re-submitted"
        );
    }

    /// The retry re-submits the captured observation unchanged: its
    /// location stamp is the one taken at observation time, so a location
    /// that moved meanwhile makes it stale, never current.
    #[tokio::test]
    async fn a_retry_keeps_the_original_location_stamp() {
        let sink = sink_for("ses_stamp");
        sink.location_revision
            .store(3, std::sync::atomic::Ordering::SeqCst);
        sink.fail_next_observations(1);
        observe_native_live(
            &dyn_sink(&sink),
            target("ses_stamp"),
            "Stamped title",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        // The provider location moves before the retry runs.
        sink.location_revision
            .store(4, std::sync::atomic::Ordering::SeqCst);
        assert!(
            wait_until(Duration::from_secs(3), || !sink
                .observed_titles()
                .is_empty())
            .await,
            "the retry ran"
        );
        let observed = sink.observed.lock().unwrap().clone();
        assert_eq!(observed.len(), 1);
        assert_eq!(
            observed[0].location_revision, 3,
            "the retry folds with the original stamp"
        );
    }

    /// The retries are bounded: 200 ms, then 1 s, then the observation is
    /// dropped (the next observation of the target records it again).
    #[tokio::test]
    async fn a_retry_gives_up_after_its_bounded_attempts() {
        let sink = sink_for("ses_bounded");
        sink.fail_next_observations(10);
        observe_native_live(
            &dyn_sink(&sink),
            target("ses_bounded"),
            "Never lands",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        assert_eq!(
            sink.attempted_titles().len(),
            3,
            "one inline attempt plus two retries: {:?}",
            sink.attempted_titles()
        );
        assert!(sink.observed_titles().is_empty());
    }

    /// A new observation never waits behind its target's in-flight
    /// background retry: while that retry sits inside a slow store
    /// transaction, the next inline call returns at once, and its title
    /// lands once the retry finishes — after it, so the newest title is the
    /// last word.
    #[tokio::test]
    async fn an_inline_observation_never_waits_behind_an_in_flight_retry() {
        let sink = sink_for("ses_busy");
        sink.fail_next_observations(1);
        observe_native_live(
            &dyn_sink(&sink),
            target("ses_busy"),
            "A",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        // The background retry of "A" blocks inside the store until released.
        let release = sink.block_next_observation();
        assert!(
            wait_until(Duration::from_secs(2), || sink.attempted_titles().len()
                == 2)
            .await,
            "the retry of A is in flight: {:?}",
            sink.attempted_titles()
        );

        let inline = tokio::time::timeout(
            Duration::from_millis(200),
            observe_native_live(
                &dyn_sink(&sink),
                target("ses_busy"),
                "B",
                NativeNameOrigin::Snapshot,
                None,
            ),
        )
        .await;
        let inline = inline.expect("the inline call returned while the retry was in flight");
        assert!(inline.is_none(), "B is not answered inline");

        release.send(()).expect("the retry of A still waits");
        assert!(
            wait_until(Duration::from_secs(3), || {
                sink.observed_titles() == vec!["A".to_string(), "B".to_string()]
            })
            .await,
            "B lands after the retry of A finished: observed {:?}, attempted {:?}",
            sink.observed_titles(),
            sink.attempted_titles()
        );
    }

    /// OpenCode's placeholder title never even reaches the store.
    #[tokio::test]
    async fn a_provider_placeholder_never_reaches_the_sink() {
        let sink = sink_for("ses_placeholder");
        let answer = observe_native_live(
            &dyn_sink(&sink),
            target("ses_placeholder"),
            "New session - 2026-10-20T00:09:25.350Z",
            NativeNameOrigin::Snapshot,
            None,
        )
        .await;
        assert!(answer.is_none());
        assert!(
            sink.attempted_titles().is_empty(),
            "no transaction for a placeholder"
        );
    }
}

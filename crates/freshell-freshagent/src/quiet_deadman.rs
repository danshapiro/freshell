//! The wedged-runtime quiet deadman every fresh-agent lane shares (design
//! 2026-10-22 §3.2, §5.6; moved out of `codex.rs`).
//!
//! A wedged-but-ALIVE sidecar (process running, no events, no exit) must not
//! leave a pane asserting "working" forever. While a turn is in flight, the
//! lane feeds the deadman on every piece of lane-visible activity and each feed
//! re-arms a quiet window; a waiter ([`wait_for_quiet_deadline`]) fires iff the
//! window elapses with no feed and the turn still in flight. The lane then
//! flags the pane `stuck` and rings its attention edge. Any later feed resolves
//! the flag.
//!
//! This module owns only the state machine and the waiter. The lane decides
//! what counts as activity, what "in flight" means, how to broadcast the stuck
//! status and the edge, and how to log each phase.
//!
//! Every mutation bumps a generation, so a waiter armed under an older
//! generation observes the mismatch and exits without firing. That keeps the
//! waiters from accumulating beyond the feeds in one window.
//!
//! LOCK DISCIPLINE: the deadman sits behind a plain `std::sync::Mutex` that is
//! only ever held briefly: never across an `.await`, never while broadcasting.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

/// Per-session state of the quiet deadman. No field is exposed: every change
/// goes through the methods below, each of which bumps the generation.
pub(crate) struct QuietDeadman {
    /// Bumped on EVERY state mutation (arm, feed/reset, disarm, resolve). A
    /// waiter fires only when the generation it was armed under is current.
    generation: u64,
    /// The armed deadline; `Some` only while a turn is in flight (or was when
    /// the epoch fired: firing leaves it set so an arm-if-absent never re-arms
    /// a flagged epoch).
    deadline: Option<tokio::time::Instant>,
    /// When the deadman fired (the pane is flagged `stuck`); `None` while
    /// quiet.
    stuck_since: Option<Instant>,
}

/// What one [`QuietDeadman::feed`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct QuietFeed {
    /// The feed cleared a fired epoch (the pane was flagged `stuck`).
    pub(crate) resolved: bool,
    /// The epoch the feed armed (a turn is in flight); the lane spawns a
    /// waiter for it. `None` when the feed disarmed the window.
    pub(crate) armed: Option<ArmedEpoch>,
}

/// An armed quiet window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ArmedEpoch {
    /// The generation a waiter for this window must still see to fire.
    pub(crate) generation: u64,
    /// `true` on the disarmed-to-armed transition; `false` when the feed
    /// re-armed an armed or fired window (a reset, logged as no new arming).
    pub(crate) fresh: bool,
}

impl QuietDeadman {
    /// A fresh, disarmed deadman behind its shared lock.
    pub(crate) fn new_shared() -> Arc<StdMutex<Self>> {
        Arc::new(StdMutex::new(Self {
            generation: 0,
            deadline: None,
            stuck_since: None,
        }))
    }

    /// Lane-visible activity proves the sidecar is alive. Resolves a fired
    /// epoch first, then re-arms the window `window` from now while a turn is
    /// `in_flight`, or disarms it when none is.
    pub(crate) fn feed(&mut self, in_flight: bool, window: Duration) -> QuietFeed {
        let resolved = self.stuck_since.take().is_some();
        self.generation += 1;
        let armed = if in_flight {
            let fresh = self.deadline.is_none() && !resolved;
            self.deadline = Some(tokio::time::Instant::now() + window);
            Some(ArmedEpoch {
                generation: self.generation,
                fresh,
            })
        } else {
            self.deadline = None;
            None
        };
        QuietFeed { resolved, armed }
    }

    /// Arm the window ONLY if none is armed and the epoch has not fired (a
    /// poll that observes a turn in flight must never reset an armed window).
    /// Returns the armed generation, or `None` when nothing changed.
    pub(crate) fn arm_if_absent(&mut self, window: Duration) -> Option<u64> {
        if self.deadline.is_some() || self.stuck_since.is_some() {
            return None;
        }
        self.generation += 1;
        self.deadline = Some(tokio::time::Instant::now() + window);
        Some(self.generation)
    }

    /// Disarm on a turn's end or the session's teardown: invalidates every
    /// outstanding waiter. Returns whether a fired epoch was resolved.
    pub(crate) fn disarm(&mut self) -> bool {
        self.generation += 1;
        self.deadline = None;
        self.stuck_since.take().is_some()
    }

    /// Whether the deadman has fired and nothing has resolved it since.
    pub(crate) fn is_stuck(&self) -> bool {
        self.stuck_since.is_some()
    }

    pub(crate) fn is_stuck_generation(&self, generation: u64) -> bool {
        self.generation == generation && self.is_stuck()
    }

    /// Fire iff NOTHING changed since the epoch was armed: the same
    /// generation and deadline, a turn still `in_flight`, not already fired.
    /// Returns whether it fired (and flagged the session stuck).
    pub(crate) fn try_fire(
        &mut self,
        generation: u64,
        deadline: tokio::time::Instant,
        in_flight: bool,
    ) -> bool {
        if in_flight
            && self.generation == generation
            && self.deadline == Some(deadline)
            && self.stuck_since.is_none()
        {
            self.stuck_since = Some(Instant::now());
            true
        } else {
            false
        }
    }
}

/// One waiter for one armed epoch: sleeps until the armed deadline, then fires
/// iff the epoch is still current ([`QuietDeadman::try_fire`]), reading
/// `in_flight` under the deadman's lock at the deadline. Returns whether it
/// fired; the caller then flags the pane and rings the edge. A deadman with
/// nothing armed returns `false` at once.
///
/// The waiter validates only the captured deadman state, never that the lane
/// still holds this session: whoever replaces a session record must disarm the
/// old record's deadman first, or an orphaned waiter fires for it.
pub(crate) async fn wait_for_quiet_deadline(
    quiet: &Arc<StdMutex<QuietDeadman>>,
    generation: u64,
    in_flight: impl FnOnce() -> bool,
) -> bool {
    let Some(deadline) = quiet.lock().expect("quiet deadman lock").deadline else {
        return false;
    };
    tokio::time::sleep_until(deadline).await;
    let mut q = quiet.lock().expect("quiet deadman lock");
    q.try_fire(generation, deadline, in_flight())
}

/// A quiet window in milliseconds from the environment variable `var`: a
/// positive integer, else `default_ms` (missing, unparseable, or zero).
pub(crate) fn window_from_env(var: &str, default_ms: u64) -> u64 {
    parse_window_ms(std::env::var(var).ok().as_deref(), default_ms)
}

fn parse_window_ms(raw: Option<&str>, default_ms: u64) -> u64 {
    raw.and_then(|raw| raw.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(default_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    const WINDOW: Duration = Duration::from_millis(100);

    #[test]
    fn a_feed_with_a_turn_in_flight_arms_a_fresh_epoch_and_later_feeds_reset_it() {
        let quiet = QuietDeadman::new_shared();
        let mut q = quiet.lock().unwrap();
        assert_eq!(q.deadline, None, "a new deadman is disarmed");

        let before = tokio::time::Instant::now();
        let first = q.feed(true, WINDOW);
        assert!(!first.resolved);
        let armed = first.armed.expect("a turn in flight arms the window");
        assert!(armed.fresh, "disarmed -> armed is a fresh arming");
        let deadline = q.deadline.expect("armed");
        assert!(deadline >= before + WINDOW);

        let second = q.feed(true, WINDOW);
        let reset = second.armed.expect("a feed re-arms the window");
        assert!(!reset.fresh, "re-arming an armed window is a reset");
        assert!(reset.generation > armed.generation);
        assert!(q.deadline.expect("still armed") >= deadline);
        assert!(!q.is_stuck());
    }

    #[test]
    fn a_feed_with_no_turn_in_flight_disarms() {
        let quiet = QuietDeadman::new_shared();
        let mut q = quiet.lock().unwrap();
        q.feed(true, WINDOW);
        let feed = q.feed(false, WINDOW);
        assert_eq!(feed.armed, None);
        assert!(!feed.resolved);
        assert_eq!(q.deadline, None);
    }

    #[tokio::test(start_paused = true)]
    async fn the_waiter_fires_once_when_the_window_elapses_with_no_feed() {
        let quiet = QuietDeadman::new_shared();
        let generation = quiet
            .lock()
            .unwrap()
            .feed(true, WINDOW)
            .armed
            .expect("armed")
            .generation;
        let started = tokio::time::Instant::now();

        let fired = wait_for_quiet_deadline(&quiet, generation, || true).await;

        assert!(fired, "a silent window with a turn in flight fires");
        assert!(tokio::time::Instant::now() >= started + WINDOW);
        let mut q = quiet.lock().unwrap();
        assert!(q.is_stuck());
        let deadline = q.deadline.expect("a fired epoch keeps its deadline");
        assert!(
            !q.try_fire(generation, deadline, true),
            "a fired epoch never fires twice"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_supersedes_the_waiter_armed_before_it() {
        let quiet = QuietDeadman::new_shared();
        let stale = quiet.lock().unwrap().feed(true, WINDOW).armed.unwrap();
        let stale_waiter = tokio::spawn({
            let quiet = Arc::clone(&quiet);
            async move { wait_for_quiet_deadline(&quiet, stale.generation, || true).await }
        });
        tokio::time::sleep(WINDOW / 2).await;
        let current = quiet.lock().unwrap().feed(true, WINDOW).armed.unwrap();

        assert!(
            !stale_waiter.await.unwrap(),
            "the stale epoch's waiter exits without firing"
        );
        assert!(!quiet.lock().unwrap().is_stuck());
        assert!(wait_for_quiet_deadline(&quiet, current.generation, || true).await);
        assert!(quiet.lock().unwrap().is_stuck());
    }

    #[tokio::test(start_paused = true)]
    async fn the_waiter_does_not_fire_when_no_turn_is_in_flight_at_the_deadline() {
        let quiet = QuietDeadman::new_shared();
        let generation = quiet
            .lock()
            .unwrap()
            .feed(true, WINDOW)
            .armed
            .unwrap()
            .generation;
        let in_flight = Arc::new(AtomicBool::new(true));
        let waiter = tokio::spawn({
            let quiet = Arc::clone(&quiet);
            let in_flight = Arc::clone(&in_flight);
            async move {
                wait_for_quiet_deadline(&quiet, generation, || in_flight.load(Ordering::SeqCst))
                    .await
            }
        });
        // The turn ends mid-window without any lane-visible feed (e.g. a
        // requested stop): the waiter reads the latch at the deadline.
        tokio::time::sleep(WINDOW / 2).await;
        in_flight.store(false, Ordering::SeqCst);

        assert!(!waiter.await.unwrap());
        assert!(!quiet.lock().unwrap().is_stuck());
    }

    #[tokio::test(start_paused = true)]
    async fn the_waiter_returns_without_firing_when_nothing_is_armed() {
        let quiet = QuietDeadman::new_shared();
        assert!(!wait_for_quiet_deadline(&quiet, 0, || true).await);
        assert!(!quiet.lock().unwrap().is_stuck());
    }

    #[tokio::test(start_paused = true)]
    async fn disarm_invalidates_the_waiter_and_resolves_a_fired_epoch() {
        let quiet = QuietDeadman::new_shared();
        let first = quiet.lock().unwrap().feed(true, WINDOW).armed.unwrap();
        assert!(wait_for_quiet_deadline(&quiet, first.generation, || true).await);

        assert!(
            quiet.lock().unwrap().disarm(),
            "disarm resolves the stuck flag"
        );
        let mut q = quiet.lock().unwrap();
        assert!(!q.is_stuck());
        assert_eq!(q.deadline, None);
        assert!(!q.disarm(), "nothing left to resolve");

        let second = q.feed(true, WINDOW).armed.unwrap();
        let deadline = q.deadline.unwrap();
        q.disarm();
        assert!(
            !q.try_fire(second.generation, deadline, true),
            "a waiter armed before the disarm never fires"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_feed_after_a_fire_resolves_stuck_and_rearms_as_a_reset() {
        let quiet = QuietDeadman::new_shared();
        let first = quiet.lock().unwrap().feed(true, WINDOW).armed.unwrap();
        assert!(wait_for_quiet_deadline(&quiet, first.generation, || true).await);

        let feed = quiet.lock().unwrap().feed(true, WINDOW);

        assert!(feed.resolved, "activity after the fire resolves the flag");
        let rearmed = feed.armed.expect("the turn is still in flight");
        assert!(
            !rearmed.fresh,
            "re-arming a fired epoch is not a fresh arming"
        );
        assert!(!quiet.lock().unwrap().is_stuck());
        assert!(wait_for_quiet_deadline(&quiet, rearmed.generation, || true).await);
    }

    #[tokio::test(start_paused = true)]
    async fn arm_if_absent_never_resets_an_armed_or_fired_epoch() {
        let quiet = QuietDeadman::new_shared();
        {
            let mut q = quiet.lock().unwrap();
            let generation = q.arm_if_absent(WINDOW).expect("arms a disarmed deadman");
            let deadline = q.deadline.unwrap();
            assert_eq!(q.arm_if_absent(WINDOW), None, "already armed");
            assert_eq!(q.deadline, Some(deadline), "the armed window is not reset");
            assert!(q.try_fire(generation, deadline, true));
        }
        let mut q = quiet.lock().unwrap();
        assert_eq!(
            q.arm_if_absent(WINDOW),
            None,
            "a fired epoch is not re-armed"
        );
        q.disarm();
        assert!(q.arm_if_absent(WINDOW).is_some(), "disarmed again: arms");
    }

    #[test]
    fn window_ms_parsing_takes_positive_integers_and_falls_back_otherwise() {
        assert_eq!(parse_window_ms(None, 600_000), 600_000);
        assert_eq!(parse_window_ms(Some("250"), 600_000), 250);
        assert_eq!(parse_window_ms(Some("0"), 600_000), 600_000);
        assert_eq!(parse_window_ms(Some("-5"), 600_000), 600_000);
        assert_eq!(parse_window_ms(Some("ten"), 600_000), 600_000);
        assert_eq!(parse_window_ms(Some(""), 600_000), 600_000);
    }
}

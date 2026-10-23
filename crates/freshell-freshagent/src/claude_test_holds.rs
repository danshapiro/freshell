//! Test holds on a claude session's lifecycle. Each one parks a single step so a
//! test can land a race inside that window every time instead of by luck. No hold
//! is ever set in production, where each is a no-op.
//!
//! - Registration ([`ClaudeTestHolds::hold_registration`]): registering a session
//!   waits this long between starting its consumer and inserting its record. A
//!   production resume create awaits an identity-sink write while it registers;
//!   rigs wire no sink, so this hold stands in for that await.
//! - Exit report ([`ClaudeTestHolds::hold_exit_report`]): the end-of-output path
//!   parks after it recorded the dead session, before it reaps the sidecar and
//!   reports the exit, so a resume can land while the dead sidecar is reaped.
//! - Rollback boot ([`ClaudeTestHolds::hold_rollback_boot`]): an undo or redo
//!   parks after it wrote its durable record, holding the session's turn lock,
//!   before it boots the replacement runtime, so a test can park a send behind
//!   it or change the transcript store under it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

/// The holds a test set on one claude lane (shared by every clone of the state).
#[derive(Default)]
pub(crate) struct ClaudeTestHolds {
    registration: Mutex<Option<Duration>>,
    exit_report: Mutex<Option<Arc<StepHold>>>,
    rollback_boot: Mutex<Option<Arc<StepHold>>>,
}

/// One parked step: [`Self::parked`] returns once the step reached the hold,
/// and the step goes on after [`Self::release`].
#[derive(Default)]
pub struct StepHold {
    parked: Notify,
    release: Notify,
}

#[cfg(any(test, feature = "test-support"))]
impl StepHold {
    /// Wait until the step is parked at the hold.
    pub async fn parked(&self) {
        self.parked.notified().await;
    }

    /// Let the parked step go on.
    pub fn release(&self) {
        // `notify_one` keeps a permit for a waiter that has not arrived yet.
        self.release.notify_one();
    }
}

impl StepHold {
    /// Park here until released (a test's hold).
    async fn park(&self) {
        // `notify_one` keeps a permit for a test that is not waiting yet.
        self.parked.notify_one();
        self.release.notified().await;
    }
}

impl ClaudeTestHolds {
    /// Make every later session registration wait `hold` between starting the
    /// session's consumer and inserting its record.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn hold_registration(&self, hold: Duration) {
        *self.registration.lock().expect("registration hold lock") = Some(hold);
    }

    /// Park every later end-of-output path before it reaps the sidecar and
    /// reports the exit, until the returned hold is released.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn hold_exit_report(&self) -> Arc<StepHold> {
        let hold = Arc::new(StepHold::default());
        *self.exit_report.lock().expect("exit report hold lock") = Some(Arc::clone(&hold));
        hold
    }

    /// Park every later undo or redo before it boots its replacement runtime,
    /// until the returned hold is released.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn hold_rollback_boot(&self) -> Arc<StepHold> {
        let hold = Arc::new(StepHold::default());
        *self.rollback_boot.lock().expect("rollback boot hold lock") = Some(Arc::clone(&hold));
        hold
    }

    /// The registration hold, if a test set one.
    pub(crate) async fn registration(&self) {
        let hold = *self.registration.lock().expect("registration hold lock");
        if let Some(hold) = hold {
            tokio::time::sleep(hold).await;
        }
    }

    /// The exit-report hold, if a test set one.
    pub(crate) async fn exit_report(&self) {
        let hold = self
            .exit_report
            .lock()
            .expect("exit report hold lock")
            .clone();
        if let Some(hold) = hold {
            hold.park().await;
        }
    }

    /// The rollback-boot hold, if a test set one.
    pub(crate) async fn rollback_boot(&self) {
        let hold = self
            .rollback_boot
            .lock()
            .expect("rollback boot hold lock")
            .clone();
        if let Some(hold) = hold {
            hold.park().await;
        }
    }
}

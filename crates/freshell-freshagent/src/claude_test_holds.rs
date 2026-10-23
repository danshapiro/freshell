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

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

/// The holds a test set on one claude lane (shared by every clone of the state).
#[derive(Default)]
pub(crate) struct ClaudeTestHolds {
    registration: Mutex<Option<Duration>>,
    exit_report: Mutex<Option<Arc<ExitReportHold>>>,
}

/// A parked exit report: [`Self::parked`] returns once an end-of-output path
/// reached the hold, and the report goes on after [`Self::release`].
#[derive(Default)]
pub struct ExitReportHold {
    parked: Notify,
    release: Notify,
}

#[cfg(any(test, feature = "test-support"))]
impl ExitReportHold {
    /// Wait until an end-of-output path is parked at the hold.
    pub async fn parked(&self) {
        self.parked.notified().await;
    }

    /// Let the parked exit report go on.
    pub fn release(&self) {
        // `notify_one` keeps a permit for a waiter that has not arrived yet.
        self.release.notify_one();
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
    pub(crate) fn hold_exit_report(&self) -> Arc<ExitReportHold> {
        let hold = Arc::new(ExitReportHold::default());
        *self.exit_report.lock().expect("exit report hold lock") = Some(Arc::clone(&hold));
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
            // `notify_one` keeps a permit for a test that is not waiting yet.
            hold.parked.notify_one();
            hold.release.notified().await;
        }
    }
}

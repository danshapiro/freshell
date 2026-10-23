//! Test holds on a claude session's lifecycle. Each one parks a single step so a
//! test can land a race inside that window every time instead of by luck. No hold
//! is ever set in production, where each is a no-op.
//!
//! - Registration ([`ClaudeTestHolds::hold_registration`]): registering a session
//!   waits this long between starting its consumer and inserting its record. A
//!   production resume create awaits an identity-sink write while it registers;
//!   rigs wire no sink, so this hold stands in for that await.

use std::sync::Mutex;
use std::time::Duration;

/// The holds a test set on one claude lane (shared by every clone of the state).
#[derive(Default)]
pub(crate) struct ClaudeTestHolds {
    registration: Mutex<Option<Duration>>,
}

impl ClaudeTestHolds {
    /// Make every later session registration wait `hold` between starting the
    /// session's consumer and inserting its record.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn hold_registration(&self, hold: Duration) {
        *self.registration.lock().expect("registration hold lock") = Some(hold);
    }

    /// The registration hold, if a test set one.
    pub(crate) async fn registration(&self) {
        let hold = *self.registration.lock().expect("registration hold lock");
        if let Some(hold) = hold {
            tokio::time::sleep(hold).await;
        }
    }
}

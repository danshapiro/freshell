//! Shared close-and-drain admission for host-owned coding-agent starts.
//!
//! This is intentionally separate from [`crate::spawn_gate::SpawnGate`]: the
//! latter limits concurrent PTY creation, while this gate temporarily rejects
//! new coding-agent starts/revivals so maintenance can take a final census.

use std::{
    fmt,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::sync::Notify;
use tokio::time::Instant;

#[derive(Clone)]
pub struct HostAgentAdmissionGate {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    active_permits: usize,
    lease: Option<LeaseState>,
    shutdown_latched: bool,
}

struct LeaseState {
    owner_id: String,
    lease_id: String,
    expires_at: Instant,
    drained: bool,
    clean: bool,
    committed: bool,
}

/// The owner-bound capability returned by `begin_quiesce`.
///
/// The lease id is deliberately omitted from debug output because callers use
/// it as a bearer capability for renewal, release, and shutdown commitment.
#[derive(Clone, PartialEq, Eq)]
pub struct AdmissionLease {
    pub owner_id: String,
    pub lease_id: String,
}

impl fmt::Debug for AdmissionLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdmissionLease")
            .field("owner_id", &self.owner_id)
            .field("lease_id", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionGateStatus {
    /// `open`, `quiesced`, or `shutdown-latched`.
    pub phase: String,
    pub active_permits: usize,
    pub lease_owner: Option<String>,
    pub lease_expires_in_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    Maintenance,
    ShutdownLatched,
    InvalidOwner,
    InvalidLeaseDuration,
    LeaseBusy,
    LeaseMismatch,
    LeaseExpired,
    DrainTimeout,
    NotDrained,
    LeaseNotClean,
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Maintenance => "host coding-agent starts are paused for maintenance",
            Self::ShutdownLatched => "host coding-agent admission is latched closed for shutdown",
            Self::InvalidOwner => {
                "maintenance lease owner must be a non-empty id of at most 128 bytes"
            }
            Self::InvalidLeaseDuration => "maintenance lease duration must be greater than zero",
            Self::LeaseBusy => "another maintenance lease is already active",
            Self::LeaseMismatch => {
                "maintenance lease does not belong to this owner or is no longer current"
            }
            Self::LeaseExpired => "maintenance lease expired before shutdown was committed",
            Self::DrainTimeout => {
                "in-flight host coding-agent operations did not drain before the deadline"
            }
            Self::NotDrained => "maintenance lease has not drained all admitted operations",
            Self::LeaseNotClean => {
                "maintenance lease has not passed a complete clean process census"
            }
        })
    }
}

impl std::error::Error for AdmissionError {}

/// A permit held from before a host coding-agent start/revival side effect
/// through terminal/process and ownership publication. Dropping the permit
/// is the only way to decrement the in-flight count.
pub struct HostAgentAdmissionPermit {
    inner: Arc<Inner>,
    released: bool,
}

impl Drop for HostAgentAdmissionPermit {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = lock(&self.inner.state);
        state.active_permits = state.active_permits.saturating_sub(1);
        if state.active_permits == 0 {
            self.inner.changed.notify_waiters();
        }
    }
}

impl Default for HostAgentAdmissionGate {
    fn default() -> Self {
        Self::new()
    }
}

impl HostAgentAdmissionGate {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                changed: Notify::new(),
            }),
        }
    }

    /// Admit a host coding-agent start/revival unless a temporary maintenance
    /// lease or the process shutdown latch has closed the gate.
    pub fn try_admit(&self) -> Result<HostAgentAdmissionPermit, AdmissionError> {
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        if state.shutdown_latched || state.lease.as_ref().is_some_and(|lease| lease.committed) {
            return Err(AdmissionError::ShutdownLatched);
        }
        if state.lease.is_some() {
            return Err(AdmissionError::Maintenance);
        }
        state.active_permits = state.active_permits.saturating_add(1);
        Ok(HostAgentAdmissionPermit {
            inner: Arc::clone(&self.inner),
            released: false,
        })
    }

    /// Wait for a temporary maintenance lease to release/expire, then acquire
    /// admission atomically. Background recovery uses this so it stays pending
    /// while maintenance is active without recording a provider launch failure
    /// or spinning on a requeued crash event.
    pub async fn admit_when_open(&self) -> Result<HostAgentAdmissionPermit, AdmissionError> {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();

            let expiry = {
                let mut state = lock(&self.inner.state);
                expire_temporary_lease(&mut state, Instant::now());
                if state.shutdown_latched
                    || state.lease.as_ref().is_some_and(|lease| lease.committed)
                {
                    return Err(AdmissionError::ShutdownLatched);
                }
                match state.lease.as_ref() {
                    None => {
                        state.active_permits = state.active_permits.saturating_add(1);
                        return Ok(HostAgentAdmissionPermit {
                            inner: Arc::clone(&self.inner),
                            released: false,
                        });
                    }
                    Some(lease) => lease.expires_at,
                }
            };

            tokio::select! {
                _ = &mut changed => {}
                _ = tokio::time::sleep_until(expiry) => {}
            }
        }
    }

    /// Close new admission atomically and return an owner-bound temporary
    /// lease. `drain` separately waits for already admitted work to settle.
    pub fn begin_quiesce(
        &self,
        owner_id: &str,
        lease_duration: Duration,
    ) -> Result<AdmissionLease, AdmissionError> {
        if owner_id.is_empty() || owner_id.len() > 128 {
            return Err(AdmissionError::InvalidOwner);
        }
        if lease_duration.is_zero() {
            return Err(AdmissionError::InvalidLeaseDuration);
        }
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        if state.shutdown_latched {
            return Err(AdmissionError::ShutdownLatched);
        }
        if state.lease.is_some() {
            return Err(AdmissionError::LeaseBusy);
        }
        let lease_id = uuid::Uuid::new_v4().simple().to_string();
        state.lease = Some(LeaseState {
            owner_id: owner_id.to_string(),
            lease_id: lease_id.clone(),
            expires_at: Instant::now() + lease_duration,
            drained: false,
            clean: false,
            committed: false,
        });
        Ok(AdmissionLease {
            owner_id: owner_id.to_string(),
            lease_id,
        })
    }

    /// Wait for permits admitted before `begin_quiesce` to drop. The wait is
    /// bounded by both the caller's drain deadline and the lease expiry.
    pub async fn drain(
        &self,
        lease: &AdmissionLease,
        drain_timeout: Duration,
    ) -> Result<(), AdmissionError> {
        let drain_deadline = Instant::now() + drain_timeout;
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();

            let (active, lease_deadline) = {
                let mut state = lock(&self.inner.state);
                expire_temporary_lease(&mut state, Instant::now());
                validate_temporary_lease(&state, lease)?;
                let active_permits = state.active_permits;
                let lease_deadline = state
                    .lease
                    .as_ref()
                    .expect("validated lease remains present")
                    .expires_at;
                if active_permits == 0 {
                    state
                        .lease
                        .as_mut()
                        .expect("validated lease remains present")
                        .drained = true;
                    self.inner.changed.notify_waiters();
                    return Ok(());
                }
                (active_permits, lease_deadline)
            };

            debug_assert_ne!(active, 0);
            let deadline = std::cmp::min(drain_deadline, lease_deadline);
            if Instant::now() >= deadline {
                let mut state = lock(&self.inner.state);
                expire_temporary_lease(&mut state, Instant::now());
                if state
                    .lease
                    .as_ref()
                    .is_none_or(|current| !lease_matches(current, lease))
                {
                    return Err(AdmissionError::LeaseExpired);
                }
                if state.active_permits == 0 {
                    if let Some(current) = state.lease.as_mut() {
                        current.drained = true;
                    }
                    return Ok(());
                }
                return Err(AdmissionError::DrainTimeout);
            }

            tokio::select! {
                _ = &mut changed => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Extend a current temporary lease. A committed shutdown lease cannot be
    /// renewed, and an expired token cannot be revived.
    pub fn renew(
        &self,
        owner_id: &str,
        lease_id: &str,
        lease_duration: Duration,
    ) -> Result<AdmissionLease, AdmissionError> {
        if lease_duration.is_zero() {
            return Err(AdmissionError::InvalidLeaseDuration);
        }
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        if state.shutdown_latched {
            return Err(AdmissionError::ShutdownLatched);
        }
        let Some(current) = state.lease.as_ref() else {
            return Err(AdmissionError::LeaseExpired);
        };
        if current.owner_id != owner_id || current.lease_id != lease_id {
            return Err(AdmissionError::LeaseMismatch);
        }
        if current.committed {
            return Err(AdmissionError::ShutdownLatched);
        }
        let current = state.lease.as_mut().expect("lease validated above");
        current.expires_at = Instant::now() + lease_duration;
        Ok(AdmissionLease {
            owner_id: current.owner_id.clone(),
            lease_id: current.lease_id.clone(),
        })
    }

    pub fn release(&self, lease: &AdmissionLease) -> Result<(), AdmissionError> {
        self.release_for(&lease.owner_id, &lease.lease_id)
    }

    /// Release only this owner's current temporary lease. Expiry and shutdown
    /// commitment are monotonic boundaries and cannot be undone by cleanup.
    pub fn release_for(&self, owner_id: &str, lease_id: &str) -> Result<(), AdmissionError> {
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        if state.shutdown_latched {
            return Err(AdmissionError::ShutdownLatched);
        }
        let Some(current) = state.lease.as_ref() else {
            return Err(AdmissionError::LeaseExpired);
        };
        if current.owner_id != owner_id || current.lease_id != lease_id {
            return Err(AdmissionError::LeaseMismatch);
        }
        if current.committed {
            return Err(AdmissionError::ShutdownLatched);
        }
        state.lease = None;
        self.inner.changed.notify_waiters();
        Ok(())
    }

    /// Record that a complete final census had no host-managed, unknown, or
    /// unattached process. Only a drained, current temporary lease can become
    /// clean.
    pub fn mark_clean(&self, lease: &AdmissionLease) -> Result<(), AdmissionError> {
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        if state.shutdown_latched {
            return Err(AdmissionError::ShutdownLatched);
        }
        validate_temporary_lease(&state, lease)?;
        if state.active_permits != 0
            || !state
                .lease
                .as_ref()
                .expect("validated lease remains present")
                .drained
        {
            return Err(AdmissionError::NotDrained);
        }
        state
            .lease
            .as_mut()
            .expect("validated lease remains present")
            .clean = true;
        Ok(())
    }

    /// Permanently close admission for this server process immediately before
    /// the updater stops the web unit. A committed gate has no expiry/release
    /// path; a replacement server gets a new open gate from `new()`.
    pub fn commit_stop(&self, lease: &AdmissionLease) -> Result<(), AdmissionError> {
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        if state.shutdown_latched {
            return Err(AdmissionError::ShutdownLatched);
        }
        validate_temporary_lease(&state, lease)?;
        if state.active_permits != 0
            || !state
                .lease
                .as_ref()
                .expect("validated lease remains present")
                .drained
        {
            return Err(AdmissionError::NotDrained);
        }
        if !state
            .lease
            .as_ref()
            .expect("validated lease remains present")
            .clean
        {
            return Err(AdmissionError::LeaseNotClean);
        }
        state
            .lease
            .as_mut()
            .expect("validated lease remains present")
            .committed = true;
        state.shutdown_latched = true;
        self.inner.changed.notify_waiters();
        Ok(())
    }

    /// The normal signal-driven shutdown path latches admission before it
    /// starts killing owned child work.
    pub fn latch_shutdown(&self) {
        let mut state = lock(&self.inner.state);
        state.shutdown_latched = true;
        if let Some(lease) = state.lease.as_mut() {
            lease.committed = true;
        }
        self.inner.changed.notify_waiters();
    }

    pub fn status(&self) -> AdmissionGateStatus {
        let mut state = lock(&self.inner.state);
        expire_temporary_lease(&mut state, Instant::now());
        let phase = if state.shutdown_latched {
            "shutdown-latched"
        } else if state.lease.is_some() {
            "quiesced"
        } else {
            "open"
        };
        AdmissionGateStatus {
            phase: phase.to_string(),
            active_permits: state.active_permits,
            lease_owner: state.lease.as_ref().map(|lease| lease.owner_id.clone()),
            lease_expires_in_ms: state.lease.as_ref().and_then(|lease| {
                (!lease.committed).then(|| {
                    lease
                        .expires_at
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u64
                })
            }),
        }
    }
}

fn lock(mutex: &Mutex<State>) -> MutexGuard<'_, State> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn expire_temporary_lease(state: &mut State, now: Instant) {
    if !state.shutdown_latched
        && state
            .lease
            .as_ref()
            .is_some_and(|lease| !lease.committed && lease.expires_at <= now)
    {
        state.lease = None;
    }
}

fn lease_matches(current: &LeaseState, requested: &AdmissionLease) -> bool {
    current.owner_id == requested.owner_id && current.lease_id == requested.lease_id
}

fn validate_temporary_lease(
    state: &State,
    requested: &AdmissionLease,
) -> Result<(), AdmissionError> {
    let Some(current) = state.lease.as_ref() else {
        return Err(AdmissionError::LeaseExpired);
    };
    if !lease_matches(current, requested) {
        return Err(AdmissionError::LeaseMismatch);
    }
    if current.committed || state.shutdown_latched {
        return Err(AdmissionError::ShutdownLatched);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{AdmissionError, HostAgentAdmissionGate};

    #[tokio::test]
    async fn quiesce_closes_admission_atomically_and_waits_for_existing_permits() {
        let gate = HostAgentAdmissionGate::new();
        let permit = gate.try_admit().expect("gate starts open");
        let quiescing = gate.clone();
        let lease = quiescing
            .begin_quiesce("updater-a", Duration::from_secs(30))
            .unwrap();
        assert!(matches!(gate.try_admit(), Err(AdmissionError::Maintenance)));
        let task = tokio::spawn(async move {
            quiescing
                .drain(&lease, Duration::from_secs(5))
                .await
                .unwrap();
            lease
        });

        tokio::task::yield_now().await;
        assert_eq!(gate.status().active_permits, 1);
        drop(permit);

        let lease = task.await.unwrap();
        assert_eq!(gate.status().phase, "quiesced");
        assert_eq!(gate.status().active_permits, 0);
        assert!(gate.mark_clean(&lease).is_ok());
        gate.commit_stop(&lease).unwrap();
        assert_eq!(gate.status().phase, "shutdown-latched");
    }

    #[test]
    fn invalid_owner_and_zero_lease_duration_are_rejected() {
        let gate = HostAgentAdmissionGate::new();
        assert_eq!(
            gate.begin_quiesce("", Duration::from_secs(1)),
            Err(AdmissionError::InvalidOwner)
        );
        assert_eq!(
            gate.begin_quiesce("updater-a", Duration::ZERO),
            Err(AdmissionError::InvalidLeaseDuration)
        );
        assert_eq!(
            gate.renew("updater-a", "missing", Duration::ZERO),
            Err(AdmissionError::InvalidLeaseDuration)
        );
    }

    #[tokio::test]
    async fn drain_timeout_is_bounded_and_temporary_lease_can_be_released() {
        let gate = HostAgentAdmissionGate::new();
        let permit = gate.try_admit().unwrap();
        let lease = gate
            .begin_quiesce("updater-a", Duration::from_secs(30))
            .unwrap();

        assert_eq!(
            gate.drain(&lease, Duration::from_millis(1)).await,
            Err(AdmissionError::DrainTimeout)
        );
        assert!(matches!(gate.try_admit(), Err(AdmissionError::Maintenance)));
        gate.release(&lease).unwrap();
        assert!(gate.try_admit().is_ok());
        drop(permit);
    }

    #[tokio::test(start_paused = true)]
    async fn temporary_lease_renews_expires_and_rejects_foreign_or_stale_owners() {
        let gate = HostAgentAdmissionGate::new();
        let lease = gate
            .begin_quiesce("updater-a", Duration::from_secs(2))
            .unwrap();
        assert_eq!(
            gate.release_for("updater-b", &lease.lease_id),
            Err(AdmissionError::LeaseMismatch)
        );
        gate.renew("updater-a", &lease.lease_id, Duration::from_secs(5))
            .unwrap();
        tokio::time::advance(Duration::from_secs(4)).await;
        assert!(matches!(gate.try_admit(), Err(AdmissionError::Maintenance)));
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(
            gate.try_admit().is_ok(),
            "expired pre-stop lease reopens admission"
        );
        assert_eq!(
            gate.renew("updater-a", &lease.lease_id, Duration::from_secs(5)),
            Err(AdmissionError::LeaseExpired)
        );
        assert_eq!(
            gate.release_for("updater-a", &lease.lease_id),
            Err(AdmissionError::LeaseExpired)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn committed_shutdown_cannot_be_reopened_by_expiry_release_or_new_instance_state() {
        let gate = HostAgentAdmissionGate::new();
        let lease = gate
            .begin_quiesce("updater-a", Duration::from_secs(1))
            .unwrap();
        gate.drain(&lease, Duration::from_secs(1)).await.unwrap();
        assert_eq!(gate.commit_stop(&lease), Err(AdmissionError::LeaseNotClean));
        gate.mark_clean(&lease).unwrap();
        gate.commit_stop(&lease).unwrap();
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_eq!(
            gate.release_for("updater-a", &lease.lease_id),
            Err(AdmissionError::ShutdownLatched)
        );
        assert!(matches!(
            gate.try_admit(),
            Err(AdmissionError::ShutdownLatched)
        ));
        gate.latch_shutdown();
        assert!(matches!(
            gate.try_admit(),
            Err(AdmissionError::ShutdownLatched)
        ));

        let replacement = HostAgentAdmissionGate::new();
        assert!(
            replacement.try_admit().is_ok(),
            "a new process owns a fresh gate"
        );
    }

    #[tokio::test]
    async fn commit_requires_a_current_drained_clean_lease() {
        let gate = HostAgentAdmissionGate::new();
        let permit = gate.try_admit().unwrap();
        let lease = gate
            .begin_quiesce("updater-a", Duration::from_secs(30))
            .unwrap();
        assert_eq!(gate.commit_stop(&lease), Err(AdmissionError::NotDrained));
        drop(permit);
        gate.drain(&lease, Duration::from_secs(1)).await.unwrap();
        assert_eq!(gate.commit_stop(&lease), Err(AdmissionError::LeaseNotClean));
        gate.mark_clean(&lease).unwrap();
        gate.commit_stop(&lease).unwrap();

        let stale = gate
            .begin_quiesce("updater-b", Duration::from_secs(30))
            .unwrap_err();
        assert_eq!(stale, AdmissionError::ShutdownLatched);
    }

    #[tokio::test]
    async fn background_admission_waits_for_temporary_release_without_spinning() {
        let gate = HostAgentAdmissionGate::new();
        let lease = gate
            .begin_quiesce("updater-a", Duration::from_secs(30))
            .unwrap();
        gate.drain(&lease, Duration::from_secs(1)).await.unwrap();

        let waiting_gate = gate.clone();
        let waiting = tokio::spawn(async move { waiting_gate.admit_when_open().await });
        tokio::task::yield_now().await;
        assert!(
            !waiting.is_finished(),
            "recovery remains deferred while closed"
        );
        gate.release(&lease).unwrap();
        let permit = waiting.await.unwrap().expect("release resumes admission");
        assert_eq!(gate.status().active_permits, 1);
        drop(permit);
    }
}

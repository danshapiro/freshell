//! One process incarnation's native conversation identity and close guard.
//! Callers take the sessions-map lock before mutating this short mutex. A
//! rekey shares this handle; a replacement process copies only its lineage.

use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub(super) struct RuntimeIdentity(Arc<Mutex<IdentityState>>);

#[derive(Debug)]
struct IdentityState {
    current: String,
    prior: Vec<String>,
    close_count: usize,
}

impl IdentityState {
    fn remember_prior(&mut self, id: String) {
        if id != self.current && !self.prior.contains(&id) {
            self.prior.push(id);
        }
    }
}

/// The native conversation cannot move while an operation is closing its
/// runtime. The guard, rather than the session id, owns that operation's count.
#[must_use = "keep this guard until the close operation has settled"]
#[derive(Debug)]
pub(super) struct RuntimeCloseGuard(Arc<Mutex<IdentityState>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RuntimeClosing;

impl std::fmt::Display for RuntimeClosing {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the runtime is closing")
    }
}

impl std::error::Error for RuntimeClosing {}

impl RuntimeIdentity {
    pub(super) fn new(
        current: impl Into<String>,
        prior_ids: impl IntoIterator<Item = String>,
    ) -> Self {
        let mut state = IdentityState {
            current: current.into(),
            prior: Vec::new(),
            close_count: 0,
        };
        for id in prior_ids {
            state.remember_prior(id);
        }
        Self(Arc::new(Mutex::new(state)))
    }

    pub(super) fn current(&self) -> String {
        self.0
            .lock()
            .expect("runtime identity lock")
            .current
            .clone()
    }

    pub(super) fn contains(&self, id: &str) -> bool {
        let state = self.0.lock().expect("runtime identity lock");
        state.current == id || state.prior.iter().any(|known| known == id)
    }

    /// Prior ids in discovery order, followed by the current id once.
    pub(super) fn ids(&self) -> Vec<String> {
        let state = self.0.lock().expect("runtime identity lock");
        let mut ids = state.prior.clone();
        ids.push(state.current.clone());
        ids
    }

    pub(super) fn inherit(&self, ids: impl IntoIterator<Item = String>) {
        let mut state = self.0.lock().expect("runtime identity lock");
        for id in ids {
            state.remember_prior(id);
        }
    }

    pub(super) fn begin_close(&self) -> RuntimeCloseGuard {
        self.0.lock().expect("runtime identity lock").close_count += 1;
        RuntimeCloseGuard(Arc::clone(&self.0))
    }

    pub(super) fn is_closing(&self) -> bool {
        self.0.lock().expect("runtime identity lock").close_count > 0
    }

    pub(super) fn rekey(&self, next: &str) -> Result<(), RuntimeClosing> {
        let mut state = self.0.lock().expect("runtime identity lock");
        if state.close_count > 0 {
            return Err(RuntimeClosing);
        }
        if state.current != next {
            state.prior.retain(|id| id != next);
            let previous = std::mem::replace(&mut state.current, next.to_string());
            state.remember_prior(previous);
        }
        Ok(())
    }
}

impl Drop for RuntimeCloseGuard {
    fn drop(&mut self) {
        self.0.lock().expect("runtime identity lock").close_count -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };

    #[test]
    fn rekeys_keep_every_native_id_once_and_inherit_prior_lineage() {
        let identity = RuntimeIdentity::new("A", Vec::new());
        identity.rekey("B").unwrap();
        identity.rekey("C").unwrap();
        assert_eq!(identity.current(), "C");
        assert_eq!(identity.ids(), ["A", "B", "C"]);
        for id in ["A", "B", "C"] {
            assert!(identity.contains(id));
        }
        assert!(!identity.contains("unknown"));
        identity.inherit(["A", "B", "C", "D", "D"].map(str::to_string));
        let mut ids = identity.ids();
        ids.sort();
        assert_eq!(ids, ["A", "B", "C", "D"]);
        identity.rekey("A").unwrap();
        let mut ids = identity.ids();
        ids.sort();
        assert_eq!(identity.current(), "A");
        assert_eq!(ids, ["A", "B", "C", "D"]);
    }

    #[test]
    fn recovery_copies_lineage_without_sharing_the_old_close_counter() {
        let old = RuntimeIdentity::new("A", Vec::new());
        old.rekey("B").unwrap();
        let close = old.begin_close();
        let recovered = RuntimeIdentity::new(old.current(), old.ids());
        assert_eq!(recovered.ids(), ["A", "B"]);
        assert!(old.is_closing());
        assert!(!recovered.is_closing());
        recovered.rekey("C").unwrap();
        assert_eq!(recovered.ids(), ["A", "B", "C"]);
        assert_eq!(old.current(), "B");
        drop(close);
        assert!(!old.is_closing());
    }

    #[test]
    fn overlapping_close_guards_refuse_rekey_until_the_last_guard_drops() {
        let identity = RuntimeIdentity::new("A", ["A", "older", "older"].map(str::to_string));
        assert_eq!(identity.ids(), ["older", "A"]);
        let first = identity.begin_close();
        let second = identity.clone().begin_close();
        let error = identity.rekey("B").unwrap_err();
        assert!(!error.to_string().is_empty());
        drop(first);
        assert!(identity.is_closing());
        assert!(identity.rekey("B").is_err());
        assert_eq!(identity.current(), "A");
        drop(second);
        assert!(!identity.is_closing());
        identity.rekey("B").unwrap();
        assert_eq!(identity.current(), "B");
    }

    #[test]
    fn canceling_an_actually_polled_future_releases_its_close_guard() {
        let identity = RuntimeIdentity::new("A", Vec::new());
        let mut operation = Box::pin(async {
            let _closing = identity.begin_close();
            std::future::pending::<()>().await;
        });
        assert!(!identity.is_closing());
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(
            operation.as_mut().poll(&mut context),
            Poll::Pending
        ));
        assert!(identity.is_closing());
        assert!(identity.rekey("B").is_err());
        drop(operation);
        assert!(!identity.is_closing());
        identity.rekey("B").unwrap();
    }
}

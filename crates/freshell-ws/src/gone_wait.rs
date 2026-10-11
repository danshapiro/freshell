//! Requests that wait for a conversation's unit to be Gone (Stage 2: LB-20).
//!
//! A request that reaches a conversation whose key is `Stopping` (its unit is
//! being stopped and holds the conversation lock until Gone is confirmed) is
//! PARKED here instead of being refused: one spawned task, correlated by the
//! request's key, waits (event-driven, [`wait_while_stopping`]) for the key
//! to leave `Stopping` and then re-submits the request. Nothing here ever
//! waits inline in a shared loop: a connection's message loop, its
//! interactive-create worker, the auto-resume hub and a spawn-gate permit
//! holder all stay responsive while a request is parked.
//!
//! A parked request is cancelled when it is superseded (a later park under
//! the same key), withdrawn (a kill naming its create-request id, a later
//! attach or detach of the same terminal) or when its connection closes
//! ([`GoneWaits::cancel_connection`]). A cancelled request never runs.
//!
//! WebSocket requests are re-submitted to their own connection: the
//! connection registers a redelivery channel
//! ([`GoneWaits::register_connection`]) and its message loop dispatches a
//! redelivered message exactly like a freshly received one (with the
//! receipt time of the original).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use freshell_containment::events;
use freshell_freshagent::ownership_lane::{stopping_log_keys, wait_while_stopping};
use freshell_ownership::{OwnershipState, RuntimeOwnershipRegistry};
use freshell_protocol::{ClientMessage, SessionLocator};
use tokio::sync::{mpsc, oneshot};
use tracing::Instrument;

use crate::WsState;

/// The entry point a parked request came in through (the `entry_point`
/// field of `unit.start.waited`).
pub const WS_CREATE: &str = "ws-create";
pub const WS_RESTORE: &str = "ws-restore";
pub const WS_ATTACH: &str = "ws-attach";
pub const FRESH_AGENT_CREATE: &str = "fresh-agent-create";

/// One parked request.
struct Entry {
    /// Distinguishes this park from a later one under the same key.
    token: u64,
    /// The connection the request came from (cancelled with it).
    conn_id: Option<u64>,
    /// Dropping it (or sending) wakes the wait task, which then does
    /// nothing.
    cancel: oneshot::Sender<()>,
}

/// A WebSocket message handed back to the connection it came from, to be
/// dispatched like a freshly received one.
#[derive(Debug)]
pub(crate) struct Redelivery {
    pub(crate) message: ClientMessage,
    /// When the original message was received (a create's provenance keeps
    /// the time of the browser's assertion, never the time it was replayed).
    pub(crate) received_at: i64,
}

/// The server-wide set of requests parked until a conversation's unit is
/// Gone. See the module docs.
#[derive(Default)]
pub struct GoneWaits {
    entries: Mutex<HashMap<String, Entry>>,
    connections: Mutex<HashMap<u64, mpsc::UnboundedSender<Redelivery>>>,
    next_token: AtomicU64,
}

impl GoneWaits {
    /// Parks a request under `key` until `(provider, session_id)` leaves
    /// `Stopping`, then runs `resume` (once, on a spawned task). A park on a
    /// key that already has one supersedes it (the older request never
    /// runs). The settle is logged as `unit.start.waited` with the entry
    /// point and the measured wait. Must be called inside the tokio runtime.
    #[allow(clippy::too_many_arguments)] // the request's correlation, its conversation, and its resubmission
    pub fn park(
        self: &Arc<Self>,
        registry: &Arc<RuntimeOwnershipRegistry>,
        key: String,
        conn_id: Option<u64>,
        provider: &str,
        session_id: &str,
        entry_point: &'static str,
        resume: Box<dyn FnOnce() + Send>,
    ) {
        let keys = stopping_log_keys(registry, provider, session_id);
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let (cancel, cancelled) = oneshot::channel();
        let superseded = self.entries.lock().expect("gone waits lock").insert(
            key.clone(),
            Entry {
                token,
                conn_id,
                cancel,
            },
        );
        tracing::info!(target: "freshell_unit",
            event = "unit.start.parked",
            unit_id = %keys.unit_id,
            provider = %keys.provider,
            session_id = %keys.session_id.as_deref().unwrap_or(""),
            terminal_id = %keys.terminal_id.as_deref().unwrap_or(""),
            operation_id = %keys.operation_id.as_deref().unwrap_or(""),
            entry_point,
            request_key = %key,
            superseded = superseded.is_some(),
            "a request waits for the conversation's unit to be gone");
        drop(superseded);
        let waits = Arc::clone(self);
        let registry = Arc::clone(registry);
        let (provider, session_id) = (provider.to_string(), session_id.to_string());
        let started = std::time::Instant::now();
        tokio::spawn(
            async move {
                tokio::select! {
                    _ = wait_while_stopping(&registry, &provider, &session_id) => {}
                    // Cancelled, or superseded (the entry was replaced and
                    // its sender dropped).
                    _ = cancelled => return,
                }
                if !waits.take(&key, token) {
                    // Cancelled while the wait was settling.
                    return;
                }
                events::start_waited(&keys, entry_point, started.elapsed().as_millis() as u64);
                resume();
            }
            .instrument(tracing::Span::current()),
        );
    }

    /// Cancels the request parked under `key`. `true` when one was parked
    /// (it will never run).
    pub fn cancel(&self, key: &str) -> bool {
        let removed = self.entries.lock().expect("gone waits lock").remove(key);
        if let Some(entry) = removed {
            let _ = entry.cancel.send(());
            tracing::debug!(target: "freshell_unit",
                event = "unit.start.park_cancelled",
                request_key = %key,
                "a parked request was withdrawn");
            return true;
        }
        false
    }

    /// Cancels every request the connection parked and forgets its
    /// redelivery channel. Called from the connection's teardown, so a
    /// parked request dies with its connection.
    pub fn cancel_connection(&self, conn_id: u64) {
        self.connections
            .lock()
            .expect("gone waits connections lock")
            .remove(&conn_id);
        let cancelled: Vec<(String, Entry)> = {
            let mut entries = self.entries.lock().expect("gone waits lock");
            let keys: Vec<String> = entries
                .iter()
                .filter(|(_, entry)| entry.conn_id == Some(conn_id))
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key).map(|entry| (key, entry)))
                .collect()
        };
        for (key, entry) in cancelled {
            let _ = entry.cancel.send(());
            tracing::debug!(target: "freshell_unit",
                event = "unit.start.park_cancelled",
                request_key = %key,
                connection_id = conn_id,
                "a parked request died with its connection");
        }
    }

    /// Whether a request is parked under `key`.
    pub fn is_parked(&self, key: &str) -> bool {
        self.entries
            .lock()
            .expect("gone waits lock")
            .contains_key(key)
    }

    /// Registers the connection's redelivery channel: messages parked by
    /// this connection come back on the returned receiver.
    pub(crate) fn register_connection(&self, conn_id: u64) -> mpsc::UnboundedReceiver<Redelivery> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.connections
            .lock()
            .expect("gone waits connections lock")
            .insert(conn_id, tx);
        rx
    }

    /// Whether the connection `conn_id` is registered (still open).
    pub(crate) fn has_connection(&self, conn_id: u64) -> bool {
        self.connections
            .lock()
            .expect("gone waits connections lock")
            .contains_key(&conn_id)
    }

    /// Hands `message` back to the connection `conn_id`; `false` when that
    /// connection is gone.
    pub(crate) fn redeliver(&self, conn_id: u64, message: Redelivery) -> bool {
        let sender = self
            .connections
            .lock()
            .expect("gone waits connections lock")
            .get(&conn_id)
            .cloned();
        sender.is_some_and(|sender| sender.send(message).is_ok())
    }

    /// Removes the entry under `key` if it is still this park's.
    fn take(&self, key: &str, token: u64) -> bool {
        let mut entries = self.entries.lock().expect("gone waits lock");
        if entries.get(key).is_some_and(|entry| entry.token == token) {
            entries.remove(key);
            return true;
        }
        false
    }
}

/// Parks a WebSocket request of connection `conn_id` until the
/// conversation `locator` leaves `Stopping`, then hands `message` back to
/// that connection, which dispatches it like a freshly received one.
/// `false` (nothing parked) when the server has no owner registry or the
/// connection is already gone (a create its worker drains after the
/// connection closed has nobody to answer).
pub(crate) fn park_until_gone(
    state: &WsState,
    conn_id: u64,
    key: String,
    locator: &SessionLocator,
    entry_point: &'static str,
    message: ClientMessage,
    received_at: i64,
) -> bool {
    let Some(registry) = state.ownership.as_ref() else {
        return false;
    };
    if !state.gone_waits.has_connection(conn_id) {
        return false;
    }
    let waits = Arc::clone(&state.gone_waits);
    let redeliver = Arc::clone(&state.gone_waits);
    waits.park(
        registry,
        key,
        Some(conn_id),
        &locator.provider,
        &locator.session_id,
        entry_point,
        Box::new(move || {
            redeliver.redeliver(
                conn_id,
                Redelivery {
                    message,
                    received_at,
                },
            );
        }),
    );
    true
}

/// Whether `(provider, session_id)` is `Stopping` now (a request for it is
/// parked rather than refused).
pub(crate) fn is_stopping(state: &WsState, provider: &str, session_id: &str) -> bool {
    state.ownership.as_ref().is_some_and(|registry| {
        matches!(
            registry.observe(provider, session_id).state,
            OwnershipState::Stopping { .. }
        )
    })
}

/// The key an attach of `terminal_id` by connection `conn_id` is parked
/// under (a later attach or detach of that terminal on that connection
/// supersedes or cancels it).
pub(crate) fn attach_key(conn_id: u64, terminal_id: &str) -> String {
    format!("attach:{conn_id}:{terminal_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind};
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// A registry whose key `(codex, sid)` is held Live by unit `u1`, then
    /// put `Stopping` by that unit's stop.
    fn stopping_registry(sid: &str) -> Arc<RuntimeOwnershipRegistry> {
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "codex",
            sid,
            RuntimeOwnerKind::Terminal,
            "op-start",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted");
        };
        let owner = OwnerIdentity {
            terminal_id: Some("t-old".into()),
            unit_id: Some("u1".into()),
            ..OwnerIdentity::default()
        };
        assert_eq!(
            registry.commit_live("codex", sid, "op-start", generation, owner),
            CommitOutcome::Committed
        );
        assert_eq!(
            registry.begin_unit_stop("u1", "op-stop", "test", 2).len(),
            1
        );
        registry
    }

    fn counting(runs: &Arc<AtomicUsize>) -> Box<dyn FnOnce() + Send> {
        let runs = Arc::clone(runs);
        Box::new(move || {
            runs.fetch_add(1, Ordering::SeqCst);
        })
    }

    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    async fn eventually(what: &str, cond: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(tokio::time::Instant::now() < deadline, "{what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn a_parked_request_runs_at_gone_and_never_before() {
        let registry = stopping_registry("s1");
        let waits = Arc::new(GoneWaits::default());
        let runs = Arc::new(AtomicUsize::new(0));
        waits.park(
            &registry,
            "crq-1".into(),
            Some(7),
            "codex",
            "s1",
            WS_CREATE,
            counting(&runs),
        );
        settle().await;
        assert_eq!(runs.load(Ordering::SeqCst), 0, "never before Gone");
        assert!(waits.is_parked("crq-1"));

        assert_eq!(registry.commit_unit_stop("u1", "op-stop").len(), 1);
        eventually("it runs once the key is released", || {
            runs.load(Ordering::SeqCst) == 1
        })
        .await;
        settle().await;
        assert_eq!(runs.load(Ordering::SeqCst), 1, "exactly once");
        assert!(!waits.is_parked("crq-1"));
    }

    #[tokio::test]
    async fn a_superseded_or_cancelled_park_never_runs() {
        let registry = stopping_registry("s1");
        let waits = Arc::new(GoneWaits::default());
        let superseded = Arc::new(AtomicUsize::new(0));
        let superseding = Arc::new(AtomicUsize::new(0));
        let cancelled = Arc::new(AtomicUsize::new(0));
        let of_closed_connection = Arc::new(AtomicUsize::new(0));
        let of_other_connection = Arc::new(AtomicUsize::new(0));
        waits.park(
            &registry,
            "k".into(),
            Some(1),
            "codex",
            "s1",
            WS_CREATE,
            counting(&superseded),
        );
        waits.park(
            &registry,
            "k".into(),
            Some(1),
            "codex",
            "s1",
            WS_CREATE,
            counting(&superseding),
        );
        waits.park(
            &registry,
            "c".into(),
            Some(1),
            "codex",
            "s1",
            WS_ATTACH,
            counting(&cancelled),
        );
        waits.park(
            &registry,
            "conn".into(),
            Some(2),
            "codex",
            "s1",
            WS_RESTORE,
            counting(&of_closed_connection),
        );
        waits.park(
            &registry,
            "other".into(),
            Some(3),
            "codex",
            "s1",
            WS_RESTORE,
            counting(&of_other_connection),
        );
        assert!(waits.cancel("c"));
        assert!(!waits.cancel("c"), "a second cancel finds nothing");
        waits.cancel_connection(2);
        assert!(!waits.is_parked("conn"));

        assert_eq!(registry.commit_unit_stop("u1", "op-stop").len(), 1);
        eventually("the surviving parks run", || {
            superseding.load(Ordering::SeqCst) == 1
                && of_other_connection.load(Ordering::SeqCst) == 1
        })
        .await;
        settle().await;
        assert_eq!(superseded.load(Ordering::SeqCst), 0, "superseded");
        assert_eq!(cancelled.load(Ordering::SeqCst), 0, "cancelled");
        assert_eq!(
            of_closed_connection.load(Ordering::SeqCst),
            0,
            "its connection closed"
        );
    }

    #[tokio::test]
    async fn a_redelivery_reaches_only_a_registered_connection() {
        let waits = GoneWaits::default();
        let mut rx = waits.register_connection(4);
        let message = || Redelivery {
            message: ClientMessage::Ping,
            received_at: 11,
        };
        assert!(waits.redeliver(4, message()));
        let delivered = rx.recv().await.expect("redelivered");
        assert_eq!(delivered.received_at, 11);
        assert!(!waits.redeliver(5, message()), "an unknown connection");
        waits.cancel_connection(4);
        assert!(!waits.redeliver(4, message()), "a closed connection");
    }
}

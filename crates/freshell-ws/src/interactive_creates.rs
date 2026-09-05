//! Ordinary creates keep their existing per-connection serial order and rate
//! limiter, but no longer occupy the socket reader while planning/spawning.
//! Restore creates continue to use create_gate and its independent permits.
//!
//! A create that was already READ off the socket is never silently discarded:
//! the old inline dispatch completed every dequeued create, and the reconnect
//! path (`pane_reconcile`'s interrupted-create regression) attaches to that
//! already-spawned terminal. Connection cancellation therefore closes
//! admission and DRAINS what was accepted — it never aborts the active job
//! (a spawn_blocking PTY spawn cannot safely be cancelled) and never drops a
//! queued one. The Job Drop guard remains the backstop for worker panic,
//! server shutdown, and queue-full rejection.

use std::future::Future;
use std::sync::Arc;

use freshell_protocol::TerminalCreate;
use freshell_terminal::FrameSink;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tracing::Instrument;

use crate::create_limit::CreateRateLimiter;
use crate::WsState;

pub(super) struct Job {
    create: Option<TerminalCreate>,
    request_id: String,
    generation: Option<Arc<std::time::Instant>>,
    state: WsState,
}

impl Job {
    pub(super) fn new(create: TerminalCreate, state: &WsState) -> Self {
        Self {
            generation: state.create_dedupe.in_flight_generation(&create.request_id),
            request_id: create.request_id.clone(),
            create: Some(create),
            state: state.clone(),
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Covers queue-full rejection, worker panic, server-shutdown skip and
        // normal failure. Accepted creates are never dropped from the queue
        // (see run_serial), so this guard is the backstop — not a fast path.
        // A settled entry is left intact by this existing API.
        if let Some(generation) = &self.generation {
            // Drop can run during a worker panic. A poisoned dedupe lock or
            // panicking waiter must not trigger a second unwind/process abort.
            cleanup_without_unwinding(&self.request_id, || {
                self.state
                    .create_dedupe
                    .clear_matching_generation(&self.request_id, generation);
            });
        }
    }
}

fn cleanup_without_unwinding(request_id: &str, cleanup: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(cleanup)).is_err() {
        tracing::error!(
            request_id = %request_id,
            "ws.create_cleanup.failed: reservation cleanup panicked; no further cleanup attempted"
        );
    }
}

fn cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow() || cancel.has_changed().is_err()
}

/// The actual worker loop, shared with deterministic scheduling/cancellation
/// tests. Carrying state through each job keeps ONE limiter without an async
/// mutex, a fresh-per-job budget, or concurrent creates on this connection.
async fn run_serial<S, T, F, Fut>(
    mut worker_state: S,
    mut rx: mpsc::Receiver<T>,
    mut cancel: watch::Receiver<bool>,
    mut work: F,
) -> S
where
    F: FnMut(S, T) -> Fut,
    Fut: Future<Output = S>,
{
    loop {
        if cancelled(&cancel) {
            // Cancellation (connection teardown) closes admission, then runs
            // everything already accepted. The only producer — this
            // connection's reader — is gone by now, so the queued set is
            // final: each received job runs to settle, exactly as the old
            // inline dispatch completed every create it had dequeued. The
            // drain keeps spawn_blocking jobs out of the conn-death lease
            // sweep by construction (the teardown joins this worker first).
            rx.close();
            while let Ok(job) = rx.try_recv() {
                worker_state = work(worker_state, job).await;
            }
            break;
        }
        tokio::select! {
            biased;
            _ = cancel.changed() => {},
            job = rx.recv() => {
                let Some(job) = job else { break };
                let active = work(worker_state, job);
                tokio::pin!(active);
                // Keep watching cancellation while work is active so queue
                // admission closes PROMPTLY — but never abort the started job
                // and never drop a queued one: the drain runs when the worker
                // next loops, after this spawn settles.
                worker_state = tokio::select! {
                    biased;
                    _ = cancel.changed() => {
                        rx.close();
                        active.await
                    }
                    state = &mut active => state,
                };
            },
        }
    }
    worker_state
}

/// Behavior changes relative to the old inline dispatch, all deliberate:
///  - The sliding-window rate limiter now records DEQUEUE time (worker start)
///    rather than socket-arrival time; queue admission is bounded separately
///    by the channel cap (`spawn_queue_cap`), and overflow gets a loud
///    `RATE_LIMITED` reply from the reader.
///  - A create dequeued after server shutdown started is skipped without a
///    reply (its dedupe reservation is released via its guard): shutdown is
///    tearing the sockets down anyway.
///  - A create settling after shutdown started kills the newest terminal
///    created under its requestId — its own late lineage only — so shutdown's
///    registry snapshot cannot straggle a PTY that outlived it.
pub(super) fn spawn(
    state: &WsState,
    sink: &FrameSink,
    cancel: watch::Receiver<bool>,
    conn_id: u64,
    pane_reconcile_v1: bool,
) -> (mpsc::Sender<Job>, JoinHandle<()>) {
    // A queue bound is necessary now that the reader can continue while a
    // create runs. Deliberately reuses the configured pending-create count
    // (`create_limit::CreateProtectConfig::spawn_queue_cap`) as the PER-
    // CONNECTION queue depth: one operator ceiling for "creates parked, not
    // running", server-wide (restore gate) and per-connection (this worker).
    let (tx, rx) = mpsc::channel(state.create_protect.spawn_queue_cap.max(1));
    let state = state.clone();
    let sink = Arc::clone(sink);
    let limiter = CreateRateLimiter::new(
        state.create_protect.rate_limit,
        state.create_protect.rate_window_ms,
    );
    let task = tokio::spawn(
        async move {
            let _ = run_serial(limiter, rx, cancel, move |mut limiter, mut job: Job| {
                let state = state.clone();
                let sink = Arc::clone(&sink);
                async move {
                    if state
                        .shutdown_started
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        return limiter;
                    }
                    let create = job.create.take().expect("interactive job consumed once");
                    debug_assert_ne!(create.restore, Some(true));
                    let mut out = crate::create_gate::CreateOutput::Channel(&sink);
                    let _ = super::handle_create(
                        create,
                        None,
                        &mut out,
                        &state,
                        conn_id,
                        pane_reconcile_v1,
                        &mut limiter,
                    )
                    .await;
                    // Shutdown can snapshot running terminals while this create is
                    // still in spawn_blocking. Reap ONLY this late lineage, never
                    // kill unrelated work during an ordinary browser disconnect.
                    if state
                        .shutdown_started
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        if let Some(tid) =
                            state.registry.newest_by_create_request_id(&job.request_id)
                        {
                            let registry = state.registry.clone();
                            let _ = tokio::task::spawn_blocking(move || registry.kill(&tid)).await;
                        }
                    }
                    // The error/success reply was pushed into the outbox inside
                    // handle_create, but the dedupe sentinel clears only here, at
                    // the guard drop. Between those two points (no await — a pure
                    // scheduling sliver) a same-connection resend is answered
                    // `DuplicateInFlight` with no fresh reply frame; the first
                    // attempt's reply on the same sink reaches that resender
                    // milliseconds later under the same requestId, so the client
                    // is never left truly silent (unlike the old inline dispatch,
                    // where the sliver could not exist by construction).
                    drop(job);
                    limiter
                }
            })
            .await;
        }
        .instrument(tracing::Span::current()),
    );
    (tx, task)
}

#[cfg(test)]
#[path = "interactive_creates_tests.rs"]
mod tests;

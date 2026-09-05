//! The gated restore-create path (WSL-outage RCA §6.3): reply-sink
//! abstraction (this task) + the spawned, permit-holding, cancellable
//! restore create (Task 6 adds `spawn_gated_restore_create`).

use freshell_protocol::ServerMessage;
use freshell_terminal::FrameSink;
use tracing::Instrument;

/// Where a `terminal.create` reply goes.
pub(crate) enum CreateOutput<'a> {
    /// The handler's nonblocking connection outbox. Admission failure closes
    /// the reader; actual socket errors are observed by writer supervision.
    Socket(&'a mut crate::terminal::WsSink),
    /// The connection's frame sink — used by both create workers. The
    /// independent writer drains it; pushing is non-blocking, so a
    /// stalled client can never wedge a gate permit. A dead connection just
    /// drops the frames.
    Channel(&'a FrameSink),
}

impl CreateOutput<'_> {
    pub(crate) async fn send(&mut self, msg: &ServerMessage) -> bool {
        match self {
            CreateOutput::Socket(ws_tx) => crate::terminal::send(ws_tx, msg).await,
            CreateOutput::Channel(sink) => {
                (sink)(msg.clone());
                true
            }
        }
    }
}

use freshell_protocol::client_messages::TerminalCreate;
use freshell_protocol::ErrorCode;

use crate::spawn_gate::SpawnGateError;
use crate::terminal::spawn_gate_error_parts;
use crate::WsState;

/// Run `work` (the whole settled-create section: handle_create through the
/// shutdown post-check) while holding `permit`, releasing it only after
/// `work` completes. Extracted so the spawn-to-settled permit scope - the
/// ordering the da5d9b5c prior art got wrong by releasing at the spawn
/// syscall - is deterministically unit-testable instead of being pinned
/// only by a wall-clock race in the acceptance suite.
async fn hold_permit_across<G, F>(permit: G, work: F)
where
    F: std::future::Future<Output = ()>,
{
    work.await;
    drop(permit);
}

/// Run one `restore:true` create through the server-wide gate on a spawned
/// task, holding the permit from BEFORE the PTY spawn until the terminal is
/// settled (`terminal.created` + broadcasts queued — the end of
/// `handle_create`). Spawning (instead of awaiting inline like non-restore
/// creates) keeps the connection's select loop polling, which is what makes
/// cancellation REAL: on disconnect or server shutdown the loop exits, the
/// per-connection cancel watch fires (send or sender drop), and every queued
/// restore create for that connection unblocks as Cancelled WITHOUT spawning
/// a PTY.
pub(crate) fn spawn_gated_restore_create(
    create: TerminalCreate,
    state: &WsState,
    conn_sink: &freshell_terminal::FrameSink,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    conn_id: u64,
    pane_reconcile_v1: bool,
) {
    let state = state.clone();
    let sink = std::sync::Arc::clone(conn_sink);
    // DIAG-01: this fn is called from within the connection loop's `ws_conn`
    // span context; carry it into the detached task so the restore create's
    // events (prepare/gate/spawn) keep the serving connection's `connection_id`.
    tokio::spawn(
        async move {
            // P1 (graceful restore/resume S1): prepare — resume-identity
            // derivation + the codex managed plan — runs BEFORE the gate, so
            // permits only ever cover fast, mode-uniform PTY-spawn->settle work
            // and codex planning can no longer starve other modes' restores.
            // The restore-class plan wait is cancel-aware with no wall-clock
            // death (LaunchClass::Restore; overflow -> RATE_LIMITED).
            let prepared =
                match crate::terminal::prepare_launch(&create, &state, &mut cancel_rx).await {
                    Ok(prepared) => prepared,
                    Err(crate::terminal::PrepareError::Cancelled) => {
                        tracing::info!(
                            target: "freshell_ws::spawn_gate",
                            request_id = %create.request_id,
                            "restore_create_cancelled"
                        );
                        // Non-settled exit: drop the dedupe sentinel (and fail any
                        // cross-connection waiters loud) so a resend proceeds fresh.
                        state.create_dedupe.clear_if_in_flight(&create.request_id);
                        return;
                    }
                    Err(crate::terminal::PrepareError::PlanQueueFull) => {
                        let mut out = CreateOutput::Channel(&sink);
                        let _ = crate::terminal::send_create_error(
                            &mut out,
                            ErrorCode::RateLimited,
                            "Too many concurrent codex launches".to_string(),
                            &create.request_id,
                        )
                        .await;
                        state.create_dedupe.clear_if_in_flight(&create.request_id);
                        return;
                    }
                    // (No Reject arm: post-A12, prepare_launch cannot reject — the
                    // claude RESTORE_UNAVAILABLE ladder runs inside handle_create,
                    // after the adopt/D8 arms, exactly as today.)
                    Err(crate::terminal::PrepareError::PlanFailed(message)) => {
                        // Same frame this failure produced when it happened inside
                        // handle_create (`error{code:PTY_SPAWN_FAILED}`).
                        let mut out = CreateOutput::Channel(&sink);
                        let _ = crate::terminal::send_create_error(
                            &mut out,
                            ErrorCode::PtySpawnFailed,
                            message,
                            &create.request_id,
                        )
                        .await;
                        state.create_dedupe.clear_if_in_flight(&create.request_id);
                        return;
                    }
                };
            // Restore-class gate wait: cancel-aware, NO timeout (D-GATE-SOFT
            // generalized: contention may not kill a restore). QueueFull still
            // fails loud (-> RATE_LIMITED via spawn_gate_error_parts); Timeout
            // is unreachable on this path. Interactive creates never ride this
            // fn and keep spawn_timeout_ms.
            let permit = match state.spawn_gate.acquire_unbounded(&mut cancel_rx).await {
                Ok(permit) => permit,
                Err(SpawnGateError::Cancelled) => {
                    tracing::info!(
                        target: "freshell_ws::spawn_gate",
                        request_id = %create.request_id,
                        "restore_create_cancelled"
                    );
                    // `prepared` drops here: the RAII guard discards the sidecar.
                    state.create_dedupe.clear_if_in_flight(&create.request_id);
                    return;
                }
                Err(err) => {
                    // A prepared codex launch IS materialized now (P1 inverted
                    // the old "nothing has been materialized yet" invariant);
                    // dropping `prepared` on this return discards it via the
                    // PreparedCodexLaunch guard. QueueFull maps to RATE_LIMITED
                    // (spawn_gate_error_parts) — the ladder absorbs it.
                    let (code, msg) = spawn_gate_error_parts(err);
                    let mut out = CreateOutput::Channel(&sink);
                    let _ = crate::terminal::send_create_error(
                        &mut out,
                        code,
                        msg.to_string(),
                        &create.request_id,
                    )
                    .await;
                    state.create_dedupe.clear_if_in_flight(&create.request_id);
                    return;
                }
            };
            // Last-instant check: the permit may have been granted a beat after
            // the client vanished. Nothing has been spawned yet — abandon
            // (dropping `prepared` discards the sidecar).
            if *cancel_rx.borrow() {
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %create.request_id,
                    "restore_create_cancelled"
                );
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
            // A10 shutdown-race pre-check (V3): kill_all snapshots ids once
            // (registry.rs:889-892); if shutdown already began, nothing has been
            // spawned yet — abandon instead of inserting a PTY the snapshot will
            // never visit. (`prepared` drops -> sidecar discarded.)
            if state
                .shutdown_started
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %create.request_id,
                    "restore_create_abandoned_for_shutdown"
                );
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
            // Permit held across PTY spawn -> registry insert -> meta/identity ->
            // terminal.created -> broadcasts (the spawn-to-settled requirement,
            // pinned by permit_released_only_after_work_completes). Codex
            // planning happens ABOVE, outside the permit — the hold is now fast
            // and mode-uniform. Replies go through the non-blocking conn sink,
            // so no stalled client can wedge the permit (the da5d9b5c hazard
            // still cannot exist on this path).
            let request_id = create.request_id.clone();
            // A5 residual signal (V3), hold side: the permit-held awaits below
            // are deadline-free (PTY spawn terminal.rs:2253-2269, association
            // fs walk :2431-2454, fsync ledger writes :2517-2545) — a wedged
            // hold would otherwise be invisible. Warn ONCE at ~30s while the
            // hold is still in flight; abort the watchdog when the hold
            // settles. Logging only — no frames, no protocol change.
            let hold_watchdog = tokio::spawn({
                let request_id = request_id.clone();
                async move {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    tracing::warn!(
                        target: "freshell_ws::spawn_gate",
                        request_id = %request_id,
                        "spawn_gate_permit_hold_slow"
                    );
                }
                // DIAG-01: keep the connection context on the watchdog event too.
                .instrument(tracing::Span::current())
            });
            hold_permit_across(permit, async {
                let mut out = CreateOutput::Channel(&sink);
                // Fresh limiter, never consulted: `handle_create`'s rate-limit
                // check is gated on `create.restore != Some(true)`, and this
                // path is restore:true by construction (the `if create.restore
                // == Some(true)` branch in `handle_client_text`) — so this is a
                // throwaway to satisfy the shared signature, not a live budget.
                let mut create_limiter = crate::create_limit::CreateRateLimiter::new(
                    state.create_protect.rate_limit,
                    state.create_protect.rate_window_ms,
                );
                let _ = crate::terminal::handle_create(
                    create,
                    Some(prepared),
                    &mut out,
                    &state,
                    conn_id,
                    pane_reconcile_v1,
                    &mut create_limiter,
                )
                .await;
                // Covers create failure: no-op when handle_create settled the entry,
                // drops the InFlight sentinel (failing waiters loud) when it did not.
                state.create_dedupe.clear_if_in_flight(&request_id);
                // A10 shutdown-race post-check (V3): shutdown may have begun DURING
                // the create, after main's kill_all snapshot. The server is reaping
                // everything anyway, so an idempotent kill_all here reaps our own
                // just-inserted terminal (and any other late insert). Belt to the
                // pre-check's braces; main.rs adds a drain re-sweep too (Task 7
                // Step 2b).
                if state
                    .shutdown_started
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    let killed = state.registry.kill_all();
                    tracing::info!(
                        target: "freshell_ws::spawn_gate",
                        request_id = %request_id,
                        killed,
                        "restore_create_settled_during_shutdown_reaped"
                    );
                }
            })
            .await;
            // Hold settled (fast path): silence the slow-hold watchdog.
            hold_watchdog.abort();
        }
        .instrument(tracing::Span::current()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn channel_output_forwards_message_and_reports_success() {
        let captured: Arc<Mutex<Vec<ServerMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: FrameSink = {
            let captured = Arc::clone(&captured);
            Arc::new(move |msg| captured.lock().expect("lock").push(msg))
        };
        let mut out = CreateOutput::Channel(&sink);
        // Cheapest existing variant: `ServerMessage` has no unit variant
        // (the brief's `ServerMessage::Pong` is a tuple variant carrying
        // `Pong { timestamp }`) — the test only asserts forwarding.
        let msg = ServerMessage::Pong(freshell_protocol::Pong {
            timestamp: "t".to_string(),
        });
        assert!(out.send(&msg).await);
        assert_eq!(captured.lock().expect("lock").len(), 1);
    }

    use std::sync::atomic::{AtomicBool, Ordering};

    /// Stand-in for the gate permit whose release is observable.
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// Pins the spawn-to-settled permit scope deterministically: the permit
    /// must stay held while the create work is still running (the da5d9b5c
    /// prior-art bug released it at the spawn syscall) and be released once
    /// the work - which ends at settle - completes. The work future is
    /// parked on a oneshot, so "mid-create" is a synchronization point, not
    /// a timing window.
    #[tokio::test]
    async fn permit_released_only_after_work_completes() {
        let released = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let flag = DropFlag(Arc::clone(&released));
        let task = tokio::spawn(hold_permit_across(flag, async move {
            let _ = rx.await;
        }));
        tokio::task::yield_now().await;
        assert!(
            !released.load(Ordering::SeqCst),
            "permit must be held while the create is still running"
        );
        tx.send(()).expect("release the parked work");
        task.await.expect("task");
        assert!(
            released.load(Ordering::SeqCst),
            "permit must be released once the work (settle) completes"
        );
    }
}

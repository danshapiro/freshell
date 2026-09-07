//! S5.a (DEV-0006): the proxy-event router — the ONLY consumer of the managed
//! launch's `RemoteProxyEvent` stream. Routes into the EXISTING tails; builds
//! no new identity writer (single-writer discipline, campaign §2.3.2).
//!
//! D-03 RULE (recorded; spec §8.3): for managed panes the proxy candidate is
//! authoritative and the association locator never arms (see
//! `codex_association::should_arm_codex_locator`); on the SAME terminal, first
//! bind wins — a later proxy candidate with a different id is ignored here
//! (identity moves only through the fork rebind lane or the D-RESUME arm
//! below).
//!
//! The first-bind check below is router-task check-then-act (accepted
//! residual, load-bearing ledger A22): safe because this task is the ONLY
//! proxy-candidate writer (single mpsc consumer), create-time session-ref
//! binds complete before any candidate can arrive, and the locator is
//! suppressed for managed panes (Task 7).
//!
//! D-FORK RULE (recorded; spec S5.a "route … or ignore"): proxy fork
//! candidates (`CandidateSource::ThreadForkResponse`) are deliberately
//! IGNORED — the landed disk fork-watch lane (`watch_fork` → `tick_forks` →
//! `rebind_codex_identity`, D7/A13/A8 guards) owns fork rebinds. The router
//! registers `watch_fork` after each adoption so managed fresh panes get the
//! same coverage resume panes get at create (`terminal.rs:3382-3388`).
//!
//! D-RESUME RULE (recorded; kata 3gvd): a `thread/resume` RESPONSE candidate is
//! the ONLY source allowed to MOVE an existing binding — it is the TUI's
//! server-authoritative, request-correlated report of an in-TUI switch. D-03
//! still governs thread/start and thread/started: first bind wins there.
//! Resume of the currently bound thread is a no-op (the pane is already
//! showing exactly that thread).

use std::path::Path;

use freshell_codex::launch_lifecycle::{CodexTerminalLaunchManager, TerminalProxyEvent};
use freshell_codex::remote_proxy::RemoteProxyEvent;
use freshell_codex::remote_proxy_side_effects::CandidateSource;
use tokio::sync::mpsc;

use crate::codex_identity::CodexAdoption;
use crate::WsState;

/// Boot entry: consume the set-once sink channel installed into
/// `freshell-codex` (see `set_codex_proxy_event_sink`) for the whole server.
pub fn spawn_codex_proxy_router(
    state: WsState,
    mut rx: mpsc::UnboundedReceiver<TerminalProxyEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(tagged) = rx.recv().await {
            route_proxy_event(&state, tagged).await;
        }
    })
}

async fn route_proxy_event(state: &WsState, tagged: TerminalProxyEvent) {
    let TerminalProxyEvent {
        terminal_id,
        cwd,
        event,
    } = tagged;
    match event {
        RemoteProxyEvent::Candidate(candidate) => {
            route_candidate(state, &terminal_id, cwd.as_deref(), candidate).await;
        }
        RemoteProxyEvent::TurnStarted(params) => {
            if let Some(hub) = &state.activity {
                hub.note_codex_proxy_turn(
                    &terminal_id,
                    &params.thread_id,
                    params.turn_id.as_deref(),
                    None,
                    false,
                );
            }
        }
        RemoteProxyEvent::TurnCompleted(params) => {
            if let Some(hub) = &state.activity {
                // `status` lives inside params -- nested `params.turn.status`
                // on the small-frame path, flat `params.status` on the
                // oversized byte-scan path. `turn_status` handles both
                // (protocol.rs:316-333).
                let status = freshell_codex::turn_status(&params.params);
                hub.note_codex_proxy_turn(
                    &terminal_id,
                    &params.thread_id,
                    params.turn_id.as_deref(),
                    status.as_deref(),
                    true,
                );
            }
        }
        RemoteProxyEvent::ThreadStarted(_) | RemoteProxyEvent::ThreadLifecycle(_) => {
            tracing::debug!(terminal_id = %terminal_id, "codex_proxy_lifecycle_event");
        }
        RemoteProxyEvent::ThreadLifecycleLoss(loss) => {
            // S5.a: minimal by fence — re-plan-on-loss stays deferred; the
            // auto-resume orchestrator owns recovery.
            tracing::warn!(terminal_id = %terminal_id, ?loss, "codex_proxy_lifecycle_loss");
        }
        RemoteProxyEvent::RepairTrigger(trigger) => {
            // S5.a + D-GATE-SOFT: log only (includes CandidateCaptureTimeout).
            tracing::warn!(terminal_id = %terminal_id, ?trigger, "codex_proxy_repair_trigger");
        }
        RemoteProxyEvent::ApprovalRequested(params) => {
            // Task 7: the app-server is blocked on a human -- the hub's
            // attention tracking pauses the pane and arms the idle gate.
            if let Some(hub) = &state.activity {
                hub.note_codex_approval(
                    &terminal_id,
                    params.thread_id.as_deref(),
                    &params.request_id,
                    true,
                );
            }
        }
        RemoteProxyEvent::ApprovalResolved { request_id } => {
            if let Some(hub) = &state.activity {
                hub.note_codex_approval(&terminal_id, None, &request_id, false);
            }
        }
    }
}

async fn route_candidate(
    state: &WsState,
    terminal_id: &str,
    cwd: Option<&str>,
    candidate: freshell_codex::remote_proxy_side_effects::RemoteProxyCandidate,
) {
    if candidate.source == CandidateSource::ThreadForkResponse {
        tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
            "codex_proxy_fork_candidate_ignored: disk fork-watch lane owns rebinds (D-FORK)");
        return;
    }
    if candidate.thread.ephemeral {
        tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
            "codex_proxy_candidate_skipped: ephemeral thread");
        return;
    }
    // Legacy bind-predicate parity (terminal-registry.ts:2144/2175 — verified,
    // ledger A25): bind only candidates with a non-empty thread id AND an
    // absolute rollout path (the reconcile activity lane also requires the
    // path — ledger A9).
    if candidate.thread.id.is_empty()
        || !candidate
            .thread
            .path
            .as_deref()
            .map(Path::new)
            .is_some_and(Path::is_absolute)
    {
        tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
            "codex_proxy_candidate_skipped: empty thread id or missing/relative rollout path");
        return;
    }
    // D-RESUME: a thread/resume response candidate reports an in-TUI switch to
    // an EXISTING durable thread (request-correlated; the disk fork lane
    // structurally cannot see resume-to-existing — codex_locator.rs:65
    // documents CLI resumes APPEND to the existing rollout).
    if candidate.source == CandidateSource::ThreadResumeResponse {
        let existing_codex_id: Option<String> = match state.identity.get(terminal_id) {
            Some(existing) if existing.provider.as_deref() == Some("codex") => {
                existing.session_id.clone()
            }
            _ => None,
        };
        match existing_codex_id.as_deref() {
            // Unbound pane (the kata's incident shape — the startup window
            // expired unresolved): the resume IS its first identity; fall
            // through to the adoption tail below.
            None => {}
            // Resume of the currently bound thread: nothing moves. A no-op, not
            // a re-adopt — never re-broadcast a no-change identity move.
            Some(current) if current == candidate.thread.id => {
                tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
                    "codex_proxy_resume_candidate_noop: terminal already bound to the resumed thread");
                return;
            }
            // A genuine switch: move the binding through the EXISTING rebind
            // tail (identity store, registry meta, fsynced ledger supersession,
            // associated+meta.updated frames, activity hub re-key + rollout
            // re-attach). rebind_codex_identity's guards (D7/A13/A8) own
            // refusal; a refusal logs its own reason and moves nothing.
            Some(old_id) => {
                // Structural guard (F7): the bind predicate above guarantees
                // Some + absolute, but the safety of `.expect` rested on
                // code ORDERING — a future edit inserting an early-return
                // between the predicate and this arm, or relaxing the
                // predicate for a new source, would silently arm a panic in
                // the one consumer of the proxy-event channel. The let-else
                // makes the invariant structural instead of positional.
                let Some(rollout_path) = candidate
                    .thread
                    .path
                    .as_deref()
                    .map(Path::new)
                    .filter(|path| path.is_absolute())
                else {
                    tracing::debug!(terminal_id = %terminal_id, thread_id = %candidate.thread.id,
                        "codex_proxy_resume_candidate_skipped: rollout path missing or relative \
                         (structural guard — the bind predicate should have caught this)");
                    return;
                };
                let rebound = crate::codex_identity::rebind_codex_identity(
                    state,
                    crate::codex_identity::CodexRebind {
                        terminal_id,
                        old_session_id: old_id,
                        new_session_id: &candidate.thread.id,
                        rollout_path,
                        cwd,
                    },
                )
                .await;
                if !rebound {
                    return;
                }
                // Fan-out parity with the adopt tail below:
                // (1) the resumed id is the durable sidecar record's
                //     restore-time reattach key — without this, restart-time
                //     claim_for_session finds the surviving sidecar by the OLD
                //     id only (verified gap).
                CodexTerminalLaunchManager::global()
                    .note_session_id(terminal_id, &candidate.thread.id)
                    .await;
                // (2) the disk fork lane must now watch the NEW thread, so a
                //     fork from it still rebinds (tick_forks auto-advances only
                //     its own disk-detected forks).
                repoint_codex_fork_watch(state, terminal_id, &candidate.thread.id).await;
                return;
            }
        }
    }
    // D-03: first bind wins on this terminal.
    if let Some(existing) = state.identity.get(terminal_id) {
        if let (Some("codex"), Some(existing_id)) =
            (existing.provider.as_deref(), existing.session_id.as_deref())
        {
            if existing_id != candidate.thread.id {
                tracing::debug!(terminal_id = %terminal_id, existing = %existing_id,
                    incoming = %candidate.thread.id,
                    "codex_proxy_candidate_ignored: terminal already bound (D-03 first-bind-wins)");
                return;
            }
        }
    }
    let adopted = crate::codex_identity::adopt_codex_identity(
        state,
        CodexAdoption {
            terminal_id,
            thread_id: &candidate.thread.id,
            rollout_path: candidate.thread.path.as_deref().map(Path::new),
            cwd,
        },
    )
    .await;
    if adopted {
        // S5.c release: the awaited ledger write inside the tail IS the
        // "persisted" signal (fsync-before-announce). Idempotent on re-adopt.
        // Verified (ledger A7): atomic_write_durable fsyncs file + parent dir.
        // Documented durability.degraded policy: a disabled/degraded ledger
        // still returns adopted=true — accepted, matches existing identity
        // durability semantics.
        CodexTerminalLaunchManager::global()
            .mark_candidate_persisted(terminal_id)
            .await;
        // Task 4: the captured thread id is the durable sidecar record's
        // restore-time reattach key — note it beside the persistence release.
        // No-op without an adopted spawned runtime + enabled store.
        CodexTerminalLaunchManager::global()
            .note_session_id(terminal_id, &candidate.thread.id)
            .await;
        // D-FORK: give managed panes the disk fork watch resume panes get.
        repoint_codex_fork_watch(state, terminal_id, &candidate.thread.id).await;
    } else {
        CodexTerminalLaunchManager::global()
            .fail_candidate_capture(terminal_id, "codex candidate refused by identity guards")
            .await;
    }
}

/// Repoint the disk fork lane's watch at `thread_id` (adopt arm and D-RESUME
/// rebind arm) — `watch_fork` does a bounded fs walk, so it runs on the
/// blocking pool; a panic there must not kill the proxy-event router task.
/// No-op when no `codex_locator` is wired (the kata's expired-window state).
async fn repoint_codex_fork_watch(state: &WsState, terminal_id: &str, thread_id: &str) {
    if let Some(locator) = &state.codex_locator {
        let watch_locator = std::sync::Arc::clone(locator);
        let terminal_id = terminal_id.to_string();
        let thread_id = thread_id.to_string();
        if let Err(join_error) = tokio::task::spawn_blocking(move || {
            watch_locator.watch_fork(&terminal_id, &thread_id);
        })
        .await
        {
            tracing::warn!(
                error = %join_error,
                "codex_watch_fork_panicked: blocking watch_fork task panicked"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_codex::launch_lifecycle::TerminalProxyEvent;
    use freshell_codex::remote_proxy::RemoteProxyEvent;
    use freshell_codex::remote_proxy_side_effects::{
        CandidateSource, CandidateThread, RemoteProxyCandidate,
    };
    use freshell_terminal::ActivityEvent;
    use std::sync::Arc as StdArc;

    /// WsState test-construction, copied from `codex_association.rs`'s
    /// in-module test builder (`state_with_locator`) — same construction,
    /// including a subscribable `broadcast_tx`; the locator is backed by a
    /// unique temp dir so the post-adopt `watch_fork` registration has a
    /// real (empty) sessions root to snapshot.
    fn test_state() -> WsState {
        let data_home = unique_temp_dir("proxy-route");
        let auth_token = StdArc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = StdArc::new(tokio::sync::broadcast::channel::<String>(16).0);
        WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            layout: Default::default(),
            terminal_meta: Default::default(),
            identity: crate::identity::TerminalIdentityRegistry::new(),
            auth_token: StdArc::clone(&auth_token),
            server_instance_id: StdArc::new("srv-1111".to_string()),
            boot_id: StdArc::new("boot-2222".to_string()),
            settings: StdArc::new(crate::test_settings()),
            handshake_settings: StdArc::new(tokio::sync::RwLock::new(crate::test_settings())),
            broadcast_tx: StdArc::clone(&broadcast_tx),
            auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                StdArc::clone(&auth_token),
                StdArc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(StdArc::clone(&broadcast_tx)),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, StdArc::clone(&broadcast_tx)),
            ),
            registry: freshell_terminal::TerminalRegistry::new(),
            shutdown: StdArc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            subagent_interest: Default::default(),
            terminals_revision: StdArc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: StdArc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: StdArc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: StdArc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: std::sync::Arc::new(crate::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: None,
            codex_locator: Some(StdArc::new(
                freshell_sessions::codex_locator::CodexLocator::new(data_home),
            )),
            activity: None,
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
        }
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-codex-proxy-route-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Brief's helper, extended per the brief's prose: takes the rollout
    /// path — the router's bind predicate requires an ABSOLUTE path, so
    /// happy-path candidates pass one and filter tests pass None/relative.
    fn candidate(
        source: CandidateSource,
        id: &str,
        path: Option<&str>,
        ephemeral: bool,
    ) -> RemoteProxyEvent {
        RemoteProxyEvent::Candidate(RemoteProxyCandidate {
            source,
            thread: CandidateThread {
                id: id.to_string(),
                path: path.map(str::to_string),
                ephemeral,
            },
        })
    }

    fn tagged(terminal_id: &str, event: RemoteProxyEvent) -> TerminalProxyEvent {
        TerminalProxyEvent {
            terminal_id: terminal_id.to_string(),
            cwd: Some("/tmp/x".to_string()),
            event,
        }
    }

    /// kata codex-turn-thread-scope: a hub-bearing state for observing turn
    /// routing (test_state() deliberately sets `activity: None`), plus the
    /// hub's broadcast receiver.
    fn test_state_with_hub() -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let mut state = test_state();
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        state.activity = Some(crate::activity::ActivityHub::new(StdArc::new(tx), None));
        (state, rx)
    }

    /// A TurnEventParams whose status sits NESTED at `params.turn.status`
    /// exactly like the real app-server's small-frame form -- proves the
    /// router reads it via `freshell_codex::turn_status`, not a naive
    /// `params.get("status")`.
    fn turn_params(
        thread_id: &str,
        turn_id: &str,
        nested_status: Option<&str>,
    ) -> freshell_codex::remote_proxy::TurnEventParams {
        let mut params = serde_json::Map::new();
        params.insert(
            "threadId".to_string(),
            serde_json::Value::String(thread_id.to_string()),
        );
        params.insert(
            "turnId".to_string(),
            serde_json::Value::String(turn_id.to_string()),
        );
        if let Some(status) = nested_status {
            params.insert("turn".to_string(), serde_json::json!({ "status": status }));
        }
        freshell_codex::remote_proxy::TurnEventParams {
            thread_id: thread_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            params,
        }
    }

    /// Local copy of the activity.rs test harness's frame matcher (that one
    /// is `#[cfg(test)]`-private to its module).
    async fn next_frame_matching(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        wanted: &str,
        timeout_ms: u64,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value = serde_json::from_str(&frame).ok()?;
                    if value["type"] == wanted && pred(&value) {
                        return Some(value);
                    }
                }
                _ => return None,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn turn_events_forward_thread_turn_and_nested_status_to_the_hub() {
        let (state, mut rx) = test_state_with_hub();
        let hub = state.activity.clone().expect("hub");
        // Track + bind the terminal the way a resume-create does.
        (hub.registry_observer())(ActivityEvent::Created {
            terminal_id: "term-t".into(),
            mode: "codex".into(),
            resume_session_id: Some("thread-parent".into()),
            at: 1,
        });

        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnStarted(turn_params("thread-parent", "turn-1", None)),
            ),
        )
        .await;

        // Foreign sub-agent completion: must not ring. The bounded no-ring
        // check sits BETWEEN the foreign and bound completions -- without it,
        // a regressed thread guard would ring HERE and the trailing
        // "exactly one" tail could still pass (the bound completion would
        // then hit the Idle arm and no-op, leaving one frame total).
        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnCompleted(turn_params(
                    "thread-child",
                    "turn-c",
                    Some("completed"),
                )),
            ),
        )
        .await;
        let premature = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "term-t"
            }),
        )
        .await;
        assert!(
            premature.is_err(),
            "a foreign thread completion must not ring"
        );

        // NESTED-status pin: an `inProgress` completion for the BOUND thread
        // and the in-flight turn id must not ring. THIS event is what proves
        // the router extracts `params.turn.status` via
        // `freshell_codex::turn_status`: a router that forgets the extraction
        // (or reads a naive flat `params.get("status")`) forwards `None`,
        // which records a completion (design decision #3: absent status
        // records) and rings here. The tracker's `inProgress` guard returns
        // before touching state, so the pane stays Busy for the real
        // completion below.
        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnCompleted(turn_params(
                    "thread-parent",
                    "turn-1",
                    Some("inProgress"),
                )),
            ),
        )
        .await;
        let premature = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "term-t"
            }),
        )
        .await;
        assert!(
            premature.is_err(),
            "a nested inProgress status must be extracted and must not ring"
        );

        // Bound thread's real completion with NESTED turn.status: rings once.
        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnCompleted(turn_params(
                    "thread-parent",
                    "turn-1",
                    Some("completed"),
                )),
            ),
        )
        .await;

        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "term-t"
        })
        .await
        .expect("bound thread's completion rings");
        assert_eq!(complete["sessionId"], "thread-parent");

        // Exactly one -- the foreign and inProgress completions produced nothing.
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "term-t"
            }),
        )
        .await;
        assert!(second.is_err(), "exactly one turn.complete expected");
    }

    #[tokio::test]
    async fn candidate_adopts_identity_through_the_single_writer_tail() {
        let state = test_state();
        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged(
                "term-a",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "sess-1",
                    Some("/tmp/rollouts/rollout-sess-1.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert_eq!(
            state.identity.get("term-a").and_then(|i| i.session_id),
            Some("sess-1".to_string())
        );
        // Pinned order: associated FIRST, then meta.updated.
        let first = frames.recv().await.unwrap();
        assert!(first.contains("terminal.session.associated"), "{first}");
        let second = frames.recv().await.unwrap();
        assert!(second.contains("terminal.meta.updated"), "{second}");
    }

    #[tokio::test]
    async fn fork_source_candidates_are_deliberately_ignored() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged(
                "term-b",
                candidate(
                    CandidateSource::ThreadForkResponse,
                    "sess-2",
                    Some("/tmp/rollouts/rollout-sess-2.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert!(state
            .identity
            .get("term-b")
            .and_then(|i| i.session_id)
            .is_none());
    }

    #[tokio::test]
    async fn ephemeral_candidates_are_skipped() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged(
                "term-c",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "sess-3",
                    Some("/tmp/rollouts/rollout-sess-3.jsonl"),
                    true,
                ),
            ),
        )
        .await;
        assert!(state
            .identity
            .get("term-c")
            .and_then(|i| i.session_id)
            .is_none());
    }

    #[tokio::test]
    async fn candidates_with_empty_id_or_non_absolute_path_are_skipped() {
        let state = test_state();
        // Empty thread id (absolute path, so the id filter is what rejects).
        route_proxy_event(
            &state,
            tagged(
                "term-f",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "",
                    Some("/tmp/rollouts/rollout-empty.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert!(state.identity.get("term-f").is_none());
        // Relative rollout path.
        route_proxy_event(
            &state,
            tagged(
                "term-g",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "sess-rel",
                    Some("relative/rollout-sess-rel.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert!(state.identity.get("term-g").is_none());
        // Missing rollout path.
        route_proxy_event(
            &state,
            tagged(
                "term-h",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "sess-nopath",
                    None,
                    false,
                ),
            ),
        )
        .await;
        assert!(state.identity.get("term-h").is_none());
    }

    #[tokio::test]
    async fn first_bind_wins_on_the_same_terminal_d03() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged(
                "term-d",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "sess-first",
                    Some("/tmp/rollouts/rollout-sess-first.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        route_proxy_event(
            &state,
            tagged(
                "term-d",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "sess-second",
                    Some("/tmp/rollouts/rollout-sess-second.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert_eq!(
            state.identity.get("term-d").and_then(|i| i.session_id),
            Some("sess-first".to_string()),
            "D-03: a later different-id proxy candidate must not re-adopt"
        );
    }

    /// Seed a Running codex registry row with NO backing PTY (the headless
    /// seam): the D7 rebind guard probes `live_session_owner`, whose identity
    /// arm requires the owning terminal's registry row to be Running
    /// (registry.rs's `live_session_owner_finds_identity_bound_running_terminal`
    /// pins the exact row shape).
    fn register_running_codex(state: &WsState, terminal_id: &str) {
        state
            .registry
            .register_headless(freshell_terminal::registry::HeadlessTerminal {
                terminal_id: terminal_id.to_string(),
                stream_id: format!("s-{terminal_id}"),
                mode: "codex".to_string(),
                resume_session_id: None,
                create_request_id: None,
                created_at: None,
            });
    }

    #[tokio::test]
    async fn resume_candidate_rebinds_a_bound_terminal_through_the_shared_tail() {
        // NOTE: register_running_codex supplies the Running row D7's
        // live_session_owner probes (registry.rs:5548-5565 pins the shape).
        let state = test_state();
        register_running_codex(&state, "term-r");
        route_proxy_event(
            &state,
            tagged(
                "term-r",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "thread-a",
                    Some("/tmp/rollouts/a.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert_eq!(
            state.identity.get("term-r").and_then(|i| i.session_id),
            Some("thread-a".to_string())
        );

        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged(
                "term-r",
                candidate(
                    CandidateSource::ThreadResumeResponse,
                    "thread-b",
                    Some("/tmp/rollouts/b.jsonl"),
                    false,
                ),
            ),
        )
        .await;

        assert_eq!(
            state.identity.get("term-r").and_then(|i| i.session_id),
            Some("thread-b".to_string())
        );
        // Pinned order: associated FIRST (with previousSessionId), meta.updated SECOND.
        let first = frames.recv().await.unwrap();
        assert!(first.contains("terminal.session.associated"), "{first}");
        assert!(first.contains("thread-b"), "{first}");
        assert!(first.contains("previousSessionId"), "{first}");
        assert!(first.contains("thread-a"), "{first}");
        let second = frames.recv().await.unwrap();
        assert!(second.contains("terminal.meta.updated"), "{second}");
        assert!(second.contains("thread-b"), "{second}");
    }

    #[tokio::test]
    async fn resume_candidate_for_the_currently_bound_thread_is_a_noop() {
        let state = test_state();
        register_running_codex(&state, "term-n");
        route_proxy_event(
            &state,
            tagged(
                "term-n",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "thread-a",
                    Some("/tmp/rollouts/a.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged(
                "term-n",
                candidate(
                    CandidateSource::ThreadResumeResponse,
                    "thread-a",
                    Some("/tmp/rollouts/a.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert_eq!(
            state.identity.get("term-n").and_then(|i| i.session_id),
            Some("thread-a".to_string())
        );
        assert!(
            frames.try_recv().is_err(),
            "a same-thread resume must not emit identity frames"
        );
    }

    #[tokio::test]
    async fn resume_candidate_on_an_unbound_terminal_adopts_it_as_the_first_identity() {
        let state = test_state();
        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged(
                "term-u",
                candidate(
                    CandidateSource::ThreadResumeResponse,
                    "thread-d",
                    Some("/tmp/rollouts/d.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert_eq!(
            state.identity.get("term-u").and_then(|i| i.session_id),
            Some("thread-d".to_string())
        );
        let first = frames.recv().await.unwrap();
        assert!(first.contains("terminal.session.associated"), "{first}");
        assert!(
            !first.contains("previousSessionId"),
            "a first bind carries no previousSessionId: {first}"
        );
    }

    #[tokio::test]
    async fn resume_rebind_is_refused_when_the_target_thread_is_live_owned_elsewhere() {
        let state = test_state();
        register_running_codex(&state, "term-1");
        register_running_codex(&state, "term-2");
        route_proxy_event(
            &state,
            tagged(
                "term-1",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "thread-a",
                    Some("/tmp/rollouts/a.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        route_proxy_event(
            &state,
            tagged(
                "term-2",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "thread-c",
                    Some("/tmp/rollouts/c.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged(
                "term-1",
                candidate(
                    CandidateSource::ThreadResumeResponse,
                    "thread-c",
                    Some("/tmp/rollouts/c.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        // A13: term-2 live-owns thread-c — term-1's binding must not move.
        assert_eq!(
            state.identity.get("term-1").and_then(|i| i.session_id),
            Some("thread-a".to_string())
        );
        assert!(
            frames.try_recv().is_err(),
            "a refused rebind must not emit identity frames"
        );
    }

    #[tokio::test]
    async fn d03_first_bind_wins_still_governs_non_resume_sources() {
        let state = test_state();
        register_running_codex(&state, "term-d");
        route_proxy_event(
            &state,
            tagged(
                "term-d",
                candidate(
                    CandidateSource::ThreadStartResponse,
                    "thread-a",
                    Some("/tmp/rollouts/a.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        let mut frames = state.broadcast_tx.subscribe();
        route_proxy_event(
            &state,
            tagged(
                "term-d",
                candidate(
                    CandidateSource::ThreadStartedNotification,
                    "thread-z",
                    Some("/tmp/rollouts/z.jsonl"),
                    false,
                ),
            ),
        )
        .await;
        assert_eq!(
            state.identity.get("term-d").and_then(|i| i.session_id),
            Some("thread-a".to_string())
        );
        assert!(frames.try_recv().is_err());
    }

    #[tokio::test]
    async fn lifecycle_and_repair_events_only_log() {
        let state = test_state();
        route_proxy_event(
            &state,
            tagged(
                "term-e",
                RemoteProxyEvent::RepairTrigger(
                    freshell_codex::remote_proxy::RemoteProxyRepairTrigger::ProxyClose,
                ),
            ),
        )
        .await;
        // Minimal handling: no identity write, no panic.
        assert!(state.identity.get("term-e").is_none());
    }
}

// Newly dated Task004 recovery. These tests use the existing controller, native
// transport, real event consumer and snapshot API; they do not inspect turn_state.
mod tdd_recovery {
    use super::*;
    use std::{future::Future, pin::Pin, task::Poll};

    const THREAD: &str = "recovery-thread";
    const BUDGET: Duration = Duration::from_secs(2);

    struct Harness {
        state: FreshCodexState,
        peer: freshell_codex::ChannelPeer,
        events: tokio::sync::broadcast::Receiver<String>,
    }

    impl Harness {
        async fn new(active: Option<&str>, timeout: Duration) -> Self {
            let (state, events) = state_with_bus();
            let (transport, peer) = freshell_codex::new_channel_transport();
            let (client, notifs) = CodexAppServerClient::connect_with_timeout(transport, timeout);
            let client = Arc::new(client);
            let init = {
                let client = client.clone();
                tokio::spawn(async move { client.initialize().await })
            };
            answer_initialize(&peer).await;
            init.await.unwrap().unwrap();
            insert_fake_session_with_real_consumer(
                &state, THREAD, client,
                Arc::new(StdMutex::new(active.map(str::to_owned))),
                notifs, spawn_sleeper(), "task004-recovery-owned-child",
            ).await;
            Self { state, peer, events }
        }

        async fn ordinary(active: Option<&str>) -> Self {
            Self::new(active, Duration::from_secs(30)).await
        }

        async fn request(&self) -> (freshell_codex::RequestId, String, Value) {
            tokio::time::timeout(BUDGET, self.peer.expect_request()).await
                .expect("controller must issue the expected native request")
        }

        fn terminal(&self, turn: &str, status: &str) {
            self.peer.emit_notification("turn/completed", json!({
                "threadId": THREAD, "turn": {"id": turn, "status": status}
            }));
        }

        async fn event(&mut self, predicate: impl Fn(&Value) -> bool) -> Vec<Value> {
            let frames = collect_frames_until(&mut self.events, BUDGET, predicate).await;
            assert!(frames.matched, "expected controller event; observed {:?}", frames.frames);
            frames.frames
        }

        async fn idle(&mut self) -> Vec<Value> {
            self.event(|w| w["event"]["type"] == "freshAgent.session.snapshot"
                && w["event"]["status"] == "idle").await
        }

        async fn snapshot(&self) -> Value {
            self.snapshot_status("idle").await
        }

        async fn snapshot_status(&self, status: &str) -> Value {
            let state = self.state.clone();
            let snapshot = tokio::spawn(async move { state.get_snapshot(THREAD, None).await });
            let (id, method, params) = self.request().await;
            assert_eq!(method, "thread/read");
            assert_eq!(params["includeTurns"], true);
            self.peer.respond(&id, json!({"thread": {
                "id": THREAD, "status": {"type":status}, "turns": []
            }}));
            snapshot.await.unwrap().unwrap()
        }

        async fn accept_initial(&mut self, request: &str, turn: &str) {
            let state = self.state.clone();
            let msg = input(request, "first input");
            let send = tokio::spawn(async move { state.handle_send(msg).await });
            let (id, method, _) = self.request().await;
            assert_eq!(method, "turn/start");
            self.peer.respond(&id, json!({"turn":{"id":turn}}));
            send.await.unwrap();
            self.event(|w| w["type"] == "freshAgent.send.accepted"
                && w["requestId"] == request).await;
        }

        async fn finish(self) {
            drop(self.peer);
            self.state.shutdown().await;
        }
    }

    fn input(request: &str, text: &str) -> FreshAgentSend {
        let mut msg = send_msg(THREAD, text);
        msg.request_id = Some(request.into());
        msg
    }

    fn stop() -> FreshAgentInterrupt {
        FreshAgentInterrupt {
            session_id: THREAD.into(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: freshell_protocol::AgentProvider::Codex,
            request_id: Some("recovery-stop".into()),
            cwd: None,
        }
    }

    // Drive the real handler to its next blocking point before inspecting the
    // transport. This makes no-frame assertions deterministic, without sleeps or
    // instrumentation of the implementation's private ownership state.
    async fn pending<F: Future>(mut future: Pin<&mut F>) {
        assert!(std::future::poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx).is_pending())).await);
    }

    async fn no_frame(peer: &freshell_codex::ChannelPeer) {
        let mut next = Box::pin(peer.next_raw_frame());
        assert!(std::future::poll_fn(|cx| Poll::Ready(next.as_mut().poll(cx).is_pending())).await,
            "no native request may escape the unresolved operation gate");
    }

    #[tokio::test]
    async fn held_stop_consumes_terminal_with_dispatch_lock_held_and_blocks_later_start() {
        let mut h = Harness::ordinary(None).await;
        h.accept_initial("old-accepted", "old").await;
        let state = h.state.clone();
        let mut steer = Box::pin(state.handle_send(input("old-refused-steer", "adjust old")));
        pending(steer.as_mut()).await;
        let (id, method, params) = h.request().await;
        assert_eq!(method, "turn/steer");
        assert_eq!(params["expectedTurnId"], "old");
        h.peer.respond_error(&id, -32600, "expected active turn id `old` but found `other`");
        steer.await;
        h.event(|w| w["type"] == "error" && w["requestId"] == "old-refused-steer").await;
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (stop_id, method, params) = h.request().await;
        assert_eq!(method, "turn/interrupt");
        assert_eq!(params["turnId"], "old");
        let lock = h.state.sessions.lock().await.get(THREAD).unwrap().turn_lock.clone();
        let held = lock.lock().await;
        h.terminal("old", "completed");
        // Natural completion progresses even while both Stop and dispatch lock
        // are held; it settles only old work and does not resolve Stop issuance.
        h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await;
        drop(held);
        let state = h.state.clone();
        let mut later = Box::pin(state.handle_send(input("later", "next")));
        pending(later.as_mut()).await;
        no_frame(&h.peer).await;
        h.peer.respond(&stop_id, json!({}));
        interrupt.await;
        pending(later.as_mut()).await;
        let (id, method, _) = h.request().await;
        assert_eq!(method, "turn/start");
        h.peer.respond(&id, json!({"turn":{"id":"new"}}));
        later.await;
        h.finish().await;
    }

    #[tokio::test]
    async fn stop_before_acceptance_targets_returned_id_once_and_acceptance_precedes_completion() {
        let mut h = Harness::ordinary(None).await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("pending", "first")));
        pending(send.as_mut()).await;
        let (start_id, method, _) = h.request().await;
        assert_eq!(method, "turn/start");
        h.state.handle_interrupt(stop()).await;
        no_frame(&h.peer).await;
        h.peer.respond(&start_id, json!({"turn":{"id":"returned"}}));
        let (id, method, params) = tokio::time::timeout(BUDGET, async {
            tokio::select! {
                request = h.peer.expect_request() => request,
                _ = send.as_mut() => panic!("pending Stop must interrupt the accepted returned ID"),
            }
        }).await.expect("returned-ID interrupt must be issued");
        assert_eq!(method, "turn/interrupt");
        assert_eq!(params["turnId"], "returned");
        h.terminal("returned", "interrupted");
        h.peer.respond(&id, json!({}));
        send.await;
        let frames = h.idle().await;
        let accepted = frames.iter().position(|w| w["type"] == "freshAgent.send.accepted").unwrap();
        let completed = frames.iter().position(|w| w["event"]["type"] == "freshAgent.session.snapshot").unwrap();
        assert!(accepted < completed, "acceptance must precede completion");
        no_frame(&h.peer).await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.finish().await;
    }

    #[tokio::test]
    async fn unknown_start_retains_request_correlated_ambiguity_receipt() {
        let mut h = Harness::ordinary(None).await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("unknown-start", "original")));
        pending(send.as_mut()).await;
        let (id, method, _) = h.request().await;
        assert_eq!(method, "turn/start");
        h.peer.respond_error(&id, -32603, "failure after possible admission");
        send.await;
        let frames = h.event(|w| w["type"] == "error" && w["requestId"] == "unknown-start").await;
        assert!(frames.last().unwrap()["message"].as_str().unwrap().starts_with("CODEX_DELIVERY_AMBIGUOUS:"),
            "uncertain native start must be reported as ambiguous");
        assert_eq!(h.snapshot().await["capabilities"]["send"], false);
        h.finish().await;
    }

    #[tokio::test]
    async fn unknown_start_never_replays_or_admits_later_input_and_native_events_recover_it() {
        let mut h = Harness::ordinary(None).await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("unknown-start", "original")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.respond_error(&id, -32603, "failure after possible admission");
        send.await;
        // Polling a second real send must finish with refusal and no provider
        // request, preserving the first delivery. No original-input retry occurs.
        let state = h.state.clone();
        let mut later = Box::pin(state.handle_send(input("later", "follow-up")));
        let completed = std::future::poll_fn(|cx| Poll::Ready(later.as_mut().poll(cx).is_ready())).await;
        assert!(completed, "unknown start must refuse later input instead of issuing a native request");
        no_frame(&h.peer).await;
        drop(later);
        h.peer.emit_notification("turn/started", json!({"threadId":THREAD,"turn":{"id":"recovered","status":"inProgress"}}));
        h.terminal("recovered", "completed");
        h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.accept_initial("after-evidence", "next").await;
        h.finish().await;
    }

    #[tokio::test]
    async fn ambiguous_stop_timeout_keeps_start_gate_after_terminal_until_confirmed_owned_exit() {
        let mut h = Harness::new(Some("old"), Duration::from_millis(100)).await;
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (_, method, _) = h.request().await;
        assert_eq!(method, "turn/interrupt");
        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(200)).await;
        interrupt.await;
        tokio::time::resume();
        h.terminal("old", "interrupted");
        h.idle().await;
        let state = h.state.clone();
        let mut later = Box::pin(state.handle_send(input("later", "follow-up")));
        pending(later.as_mut()).await;
        no_frame(&h.peer).await;
        // shutdown awaits this fixture's owned child's confirmed exit. A bare
        // lost response/transport is never used as evidence of process death.
        drop(h.peer);
        h.state.shutdown().await;
        tokio::time::timeout(BUDGET, later).await.expect("owned exit releases waiter");
    }

    #[tokio::test]
    async fn ack_then_native_idle_keeps_rest_busy_until_matching_terminal() {
        let mut h = Harness::ordinary(Some("old")).await;
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.respond(&id, json!({}));
        interrupt.await;
        h.peer.emit_notification("thread/status/changed", json!({"threadId":THREAD,"status":{"type":"idle"}}));
        h.event(|w| w["event"]["type"] == "freshAgent.session.snapshot").await;
        let snapshot = h.snapshot().await;
        assert_eq!(snapshot["status"], "running", "ACK plus idle is not matching native terminal evidence");
        assert_eq!(snapshot["capabilities"]["send"], false);
        assert_eq!(snapshot["capabilities"]["interrupt"], true);
        h.terminal("old", "interrupted");
        h.idle().await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.finish().await;
    }

    #[tokio::test]
    async fn stale_adversarial_post_rollover_frames_preserve_new_busy_turn_and_stop_target() {
        let mut h = Harness::ordinary(Some("old")).await;
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (old_stop, _, _) = h.request().await;
        h.peer.respond(&old_stop, json!({}));
        interrupt.await;
        h.terminal("old", "interrupted");
        h.idle().await;
        h.accept_initial("new-request", "new").await;
        // Supported resolved rollover is complete. These old duplicate frames
        // are deliberately adversarial, not normal native ACK ordering.
        h.peer.respond(&old_stop, json!({}));
        h.terminal("old", "interrupted");
        h.peer.emit_notification("thread/status/changed", json!({"threadId":THREAD,"status":{"type":"active"}}));
        h.event(|w| w["event"]["type"] == "freshAgent.session.snapshot" && w["event"]["status"] == "running").await;
        let snapshot = h.snapshot_status("active").await;
        assert_eq!(snapshot["capabilities"]["send"], false, "new turn remains busy after old duplicates");
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (id, method, params) = h.request().await;
        assert_eq!(method, "turn/interrupt");
        assert_eq!(params["turnId"], "new");
        h.peer.respond(&id, json!({}));
        interrupt.await;
        h.finish().await;
    }

    #[tokio::test]
    async fn same_id_steer_accepts_two_delivery_requests_and_settles_once() {
        let mut h = Harness::ordinary(None).await;
        h.accept_initial("first-request", "shared").await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("steer-request", "adjust")));
        pending(send.as_mut()).await;
        let (id, method, params) = h.request().await;
        assert_eq!(method, "turn/steer");
        assert_eq!(params["expectedTurnId"], "shared");
        assert_eq!(params.as_object().unwrap().len(), 3, "steer carries no setting overrides");
        h.peer.respond(&id, json!({"turnId":"shared"}));
        send.await;
        let accepted = h.event(|w| w["type"] == "freshAgent.send.accepted" && w["requestId"] == "steer-request").await;
        assert_eq!(accepted.last().unwrap()["submittedTurnId"], "shared");
        h.terminal("shared", "completed");
        let mut frames = h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await;
        // A later status notification on the consumer FIFO is the explicit
        // barrier proving the single native terminal has been fully folded.
        h.peer.emit_notification("thread/status/changed", json!({"threadId":THREAD,"status":{"type":"idle"}}));
        frames.extend(h.idle().await);
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        while let Ok(raw) = h.events.try_recv() { frames.push(serde_json::from_str(&raw).unwrap()); }
        assert_eq!(frames.iter().filter(|w| w["event"]["type"] == "freshAgent.turn.complete").count(), 1);
        h.finish().await;
    }

    #[tokio::test]
    async fn mismatch_refusal_preserves_previously_accepted_work() {
        let mut h = Harness::ordinary(None).await;
        h.accept_initial("first", "old").await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("refused-steer", "adjust")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.respond_error(&id, -32600, "expected active turn id `old` but found `other`");
        send.await;
        h.event(|w| w["type"] == "error" && w["requestId"] == "refused-steer").await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], false, "rejection of second dispatch cannot settle the first");
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (id, _, params) = h.request().await;
        assert_eq!(params["turnId"], "old");
        h.peer.respond(&id, json!({}));
        interrupt.await;
        h.finish().await;
    }

    #[tokio::test]
    async fn rejected_initial_dispatch_is_sendable_and_has_no_interrupt_target() {
        let mut h = Harness::ordinary(None).await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("rejected", "invalid")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.state.handle_interrupt(stop()).await;
        h.peer.respond_error(&id, -32602, "invalid input");
        send.await;
        h.event(|w| w["type"] == "error" && w["requestId"] == "rejected").await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.state.handle_interrupt(stop()).await;
        no_frame(&h.peer).await;
        h.finish().await;
    }

    #[tokio::test]
    async fn completion_arriving_before_start_reply_still_follows_request_acceptance() {
        let mut h = Harness::ordinary(None).await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("early-events", "first")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.emit_notification("turn/started", json!({"threadId":THREAD,"turn":{"id":"early","status":"inProgress"}}));
        h.terminal("early", "completed");
        h.peer.respond(&id, json!({"turn":{"id":"early"}}));
        send.await;
        let frames = h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await;
        let accepted = frames.iter().position(|w| w["type"] == "freshAgent.send.accepted").unwrap();
        let terminal = frames.iter().position(|w| w["event"]["type"] == "freshAgent.session.snapshot").unwrap();
        assert!(accepted < terminal);
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.finish().await;
    }

    #[tokio::test]
    async fn empty_startup_interrupt_ack_cannot_settle_startup_work() {
        let h = Harness::ordinary(Some("")).await;
        let state = h.state.clone();
        let mut interrupt = Box::pin(state.handle_interrupt(stop()));
        pending(interrupt.as_mut()).await;
        let (id, method, params) = h.request().await;
        assert_eq!(method, "turn/interrupt");
        assert_eq!(params["turnId"], "");
        h.peer.respond(&id, json!({}));
        interrupt.await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], false,
            "empty startup ACK promises no terminal event and cannot settle work");
        h.finish().await;
    }

    #[tokio::test]
    async fn ambiguous_steer_is_not_replayed_and_remains_busy_until_native_terminal() {
        let mut h = Harness::ordinary(None).await;
        h.accept_initial("first", "old").await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("unknown-steer", "adjust")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.respond_error(&id, -32603, "failure after possible steer admission");
        send.await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], false,
            "unknown steer receipt cannot make the accepted native turn idle");
        no_frame(&h.peer).await;
        h.terminal("old", "completed");
        h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.finish().await;
    }

    #[tokio::test]
    async fn no_active_steer_refusal_retains_old_delivery_until_matching_terminal() {
        let mut h = Harness::ordinary(None).await;
        h.accept_initial("first", "old").await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("no-active", "adjust")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.respond_error(&id, -32600, "no active turn to steer");
        send.await;
        h.event(|w| w["type"] == "error" && w["requestId"] == "no-active").await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], false,
            "a no-active refusal of steer does not settle earlier accepted input");
        h.terminal("old", "completed");
        h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await;
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.finish().await;
    }

    #[tokio::test]
    async fn duplicate_started_during_refused_steer_never_accepts_its_request() {
        let mut h = Harness::ordinary(None).await;
        h.accept_initial("first", "old").await;
        let state = h.state.clone();
        let mut send = Box::pin(state.handle_send(input("refused-duplicate", "adjust")));
        pending(send.as_mut()).await;
        let (id, _, _) = h.request().await;
        h.peer.emit_notification("turn/started", json!({"threadId":THREAD,"turn":{"id":"old","status":"inProgress"}}));
        h.peer.respond_error(&id, -32600, "no active turn to steer");
        send.await;
        let mut frames = h.event(|w| w["type"] == "error" && w["requestId"] == "refused-duplicate").await;
        h.terminal("old", "completed");
        frames.extend(h.event(|w| w["event"]["type"] == "freshAgent.turn.complete").await);
        assert!(!frames.iter().any(|w| w["type"] == "freshAgent.send.accepted" && w["requestId"] == "refused-duplicate"),
            "duplicate native start cannot acknowledge a refused delivery");
        assert_eq!(h.snapshot().await["capabilities"]["send"], true);
        h.finish().await;
    }

}

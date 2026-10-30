//! Browser-facing adapter for the shared native OpenCode activity transport.
use std::sync::Arc;

use crate::activity::ActivityHub;
#[cfg(test)]
use freshell_opencode::activity_lane::{
    drift_contradiction, translate_serve_event, unseen_pending_asks, version_in_tested_range,
};
pub use freshell_opencode::activity_lane::{
    ConnectedOpencodeStream, NativeTitleObserver, OpencodeEventStream, OpencodeLaneDeps,
    OpencodeLaneHttp, ReqwestLaneHttp, ReqwestLaneStream, OPENCODE_DRIFT_EVENTS,
};
#[cfg(test)]
use std::sync::atomic::Ordering as AtomicOrdering;

pub(crate) fn spawn_opencode_lane(
    deps: Arc<OpencodeLaneDeps>,
    hub: ActivityHub,
    terminal_id: String,
    base_url: String,
    generation: u64,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedSender<()>,
) {
    let observed_terminal = terminal_id.clone();
    freshell_opencode::activity_lane::spawn_opencode_lane(
        deps,
        Arc::new(move |cycle, stream, event| {
            hub.note_opencode_lane_event(&observed_terminal, generation, cycle, stream, event);
        }),
        terminal_id,
        base_url,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use freshell_activity::opencode::OpencodeStatus;
    use freshell_opencode::{parse_serve_event, ParsedServeEvent, SseDecoder};
    use serde_json::json;

    use super::*;
    use crate::activity::{ActivityHub, OpencodeLaneEvent};

    // ── injected fakes (modeled on freshell-opencode/tests/
    //    serve_health_bounded.rs FakeHttp/FakeAllocator) ──────────────────

    /// Shared call-order log across BOTH fakes so tests can assert
    /// cross-seam ordering (connect vs the `/session/status` GET).
    type CallLog = Arc<Mutex<Vec<String>>>;

    type HttpResponder =
        Box<dyn Fn(&str) -> Result<(u16, serde_json::Value), String> + Send + Sync>;

    struct FakeLaneHttp {
        log: CallLog,
        respond: HttpResponder,
    }

    impl OpencodeLaneHttp for FakeLaneHttp {
        fn get_json<'a>(
            &'a self,
            url: &'a str,
        ) -> futures::future::BoxFuture<'a, Result<(u16, serde_json::Value), String>> {
            Box::pin(async move {
                self.log
                    .lock()
                    .expect("call log")
                    .push(format!("GET {url}"));
                (self.respond)(url)
            })
        }
    }

    /// One scripted connection: buffered frames (decoded past the
    /// subscription ack, flushed by `drive` FIRST), then live frames.
    /// `finish == true` → `drive` returns `Ok(())` after sending (clean
    /// stream end → the lane reconnects); `false` → `drive` parks forever
    /// (the cycle stays open, so every stamp stays at this cycle/stream).
    struct StreamScript {
        buffered: Vec<ParsedServeEvent>,
        live: Vec<ParsedServeEvent>,
        finish: bool,
    }

    struct FakeLaneStream {
        log: CallLog,
        scripts: Mutex<VecDeque<StreamScript>>,
    }

    impl OpencodeEventStream for FakeLaneStream {
        fn connect<'a>(
            &'a self,
            url: &'a str,
        ) -> futures::future::BoxFuture<'a, Result<Box<dyn ConnectedOpencodeStream>, String>>
        {
            Box::pin(async move {
                self.log
                    .lock()
                    .expect("call log")
                    .push(format!("CONNECT {url}"));
                let script = self.scripts.lock().expect("scripts").pop_front();
                match script {
                    Some(script) => {
                        Ok(Box::new(FakeConnected { script }) as Box<dyn ConnectedOpencodeStream>)
                    }
                    // Out of scripted cycles: park so the lane goes quiet
                    // instead of looping through unscripted reconnects.
                    None => {
                        std::future::pending::<()>().await;
                        unreachable!()
                    }
                }
            })
        }
    }

    struct FakeConnected {
        script: StreamScript,
    }

    impl ConnectedOpencodeStream for FakeConnected {
        fn drive(
            self: Box<Self>,
            events_tx: tokio::sync::mpsc::UnboundedSender<ParsedServeEvent>,
        ) -> futures::future::BoxFuture<'static, Result<(), String>> {
            Box::pin(async move {
                for event in self.script.buffered {
                    let _ = events_tx.send(event);
                }
                for event in self.script.live {
                    let _ = events_tx.send(event);
                }
                if self.script.finish {
                    Ok(())
                } else {
                    std::future::pending::<()>().await;
                    unreachable!()
                }
            })
        }
    }

    fn parsed(value: serde_json::Value) -> ParsedServeEvent {
        parse_serve_event(&value).expect("parseable serve event")
    }

    fn hub() -> (ActivityHub, tokio::sync::broadcast::Receiver<String>) {
        let (broadcast_tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        (ActivityHub::new(Arc::new(broadcast_tx), None), rx)
    }

    /// Poll the hub's test-only send-side lane-ingress log until it holds at
    /// least `min_len` entries (or panic on timeout).
    async fn wait_for_ingress(
        hub: &ActivityHub,
        min_len: usize,
        timeout_ms: u64,
    ) -> Vec<(u64, u64, u64, OpencodeLaneEvent)> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let log = hub.lane_ingress_log();
            if log.len() >= min_len {
                return log;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "ingress log never reached {min_len} entries, got {log:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Wait for the first frame of `wanted` type that also satisfies `pred`
    /// (same helper shape as activity.rs's tests).
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

    // ── the tests ────────────────────────────────────────────────────────

    /// Verbatim spike vocabulary through the REAL decoder chain
    /// (`SseDecoder` → `parse_serve_event` → `translate_serve_event`):
    /// every attention-relevant kind maps to its lane event, and the
    /// activity-irrelevant kinds map to `None`.
    #[test]
    fn translate_covers_the_attention_vocabulary() {
        let frames = [
            json!({"type":"session.status","properties":{"sessionID":"ses-1","status":{"type":"busy"}}}),
            json!({"type":"session.status","properties":{"sessionID":"ses-1","status":{"type":"idle"}}}),
            json!({"type":"session.status","properties":{"sessionID":"ses-1","status":{"type":"retry"}}}),
            json!({"type":"session.idle","properties":{"sessionID":"ses-1"}}),
            json!({"type":"session.error","properties":{"sessionID":"ses-1","error":{"name":"MessageAbortedError","data":{"message":"aborted"}}}}),
            json!({"type":"session.error","properties":{"sessionID":"ses-1","error":{"data":{"message":"boom"}}}}),
            json!({"type":"permission.asked","properties":{"sessionID":"ses-1","id":"perm-1"}}),
            json!({"type":"permission.replied","properties":{"sessionID":"ses-1","requestID":"perm-1"}}),
            json!({"type":"session.created","properties":{"info":{"id":"ses-child","parentID":"ses-root"}}}),
            json!({"type":"session.created","properties":{"info":{"id":"ses-root"}}}),
            // W2 abort marker: message.updated WITH info.error.name ===
            // "MessageAbortedError" is the second abort signal (D1).
            json!({"type":"message.updated","properties":{"sessionID":"ses-1","info":{"sessionID":"ses-1","error":{"name":"MessageAbortedError"}}}}),
            // Error-less message.updated is routine message churn.
            json!({"type":"message.updated","properties":{"sessionID":"ses-1","info":{"sessionID":"ses-1"}}}),
            json!({"type":"message.part.delta","properties":{"part":{"sessionID":"ses-1"},"delta":"hi"}}),
            json!({"type":"session.diff","properties":{"sessionID":"ses-1","diff":[]}}),
            // #604: v1 + v2 + question families — source-verified against
            // opencode v1.18.14 (2026-08-06). TUI-driven turns emit the
            // V1 names (the TUI's own pause footer matches them); the v2
            // names fire only via the /api/* routes and are covered as
            // forward-compat. The /event stream applies NO type
            // transform, so whichever family the driving surface uses
            // arrives raw.
            json!({"type":"permission.v2.asked","properties":{"sessionID":"ses-1","id":"per-2","action":"bash","resources":["*"]}}),
            json!({"type":"permission.v2.replied","properties":{"sessionID":"ses-1","requestID":"per-2","reply":"once"}}),
            json!({"type":"question.asked","properties":{"sessionID":"ses-1","id":"que-1","questions":[{"question":"Proceed?","header":"Confirm","options":[]}]}}),
            json!({"type":"question.replied","properties":{"sessionID":"ses-1","requestID":"que-1","answers":[["yes"]]}}),
            json!({"type":"question.v2.asked","properties":{"sessionID":"ses-1","id":"que-2","questions":[{"question":"Proceed?","header":"Confirm","options":[]}]}}),
            json!({"type":"question.v2.rejected","properties":{"sessionID":"ses-1","requestID":"que-2"}}),
            json!({"type":"question.rejected","properties":{"sessionID":"ses-1","requestID":"que-1"}}),
            json!({"type":"question.v2.replied","properties":{"sessionID":"ses-1","requestID":"que-2","answers":[[]]}}),
            // There is NO permission.rejected / permission.v2.rejected
            // event type (v1/permission.ts:68, schema/permission.ts:52):
            // permission rejection IS a replied with reply:"reject" —
            // pinned so nobody ever "adds" a rejected row and waits on it.
            json!({"type":"permission.replied","properties":{"sessionID":"ses-1","requestID":"per-1","reply":"reject"}}),
        ];
        let stream: String = frames.iter().map(|f| format!("data: {f}\n\n")).collect();
        let mut decoder = SseDecoder::new();
        let events = decoder.push_str(&stream);
        assert_eq!(
            events.len(),
            frames.len(),
            "every frame decodes: {events:?}"
        );

        let translated: Vec<Option<OpencodeLaneEvent>> =
            events.iter().map(translate_serve_event).collect();
        assert_eq!(
            translated[0],
            Some(OpencodeLaneEvent::Status {
                session_id: "ses-1".into(),
                status: OpencodeStatus::Busy
            })
        );
        assert_eq!(
            translated[1],
            Some(OpencodeLaneEvent::Status {
                session_id: "ses-1".into(),
                status: OpencodeStatus::Idle
            })
        );
        assert_eq!(
            translated[2],
            Some(OpencodeLaneEvent::Status {
                session_id: "ses-1".into(),
                status: OpencodeStatus::Retry
            })
        );
        assert_eq!(
            translated[3],
            Some(OpencodeLaneEvent::SessionIdle {
                session_id: "ses-1".into()
            })
        );
        assert_eq!(
            translated[4],
            Some(OpencodeLaneEvent::SessionError {
                session_id: "ses-1".into(),
                error_name: "MessageAbortedError".into()
            })
        );
        assert_eq!(
            translated[5],
            Some(OpencodeLaneEvent::SessionError {
                session_id: "ses-1".into(),
                error_name: "UnknownError".into()
            }),
            "a session.error without error.name falls back to UnknownError"
        );
        assert_eq!(
            translated[6],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".into(),
                permission_id: "perm-1".into()
            })
        );
        assert_eq!(
            translated[7],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "perm-1".into()
            })
        );
        assert_eq!(
            translated[8],
            Some(OpencodeLaneEvent::SessionCreated {
                session_id: "ses-child".into(),
                parent_id: Some("ses-root".into())
            })
        );
        assert_eq!(
            translated[9],
            Some(OpencodeLaneEvent::SessionCreated {
                session_id: "ses-root".into(),
                parent_id: None
            })
        );
        assert_eq!(
            translated[10],
            Some(OpencodeLaneEvent::SessionError {
                session_id: "ses-1".into(),
                error_name: "MessageAbortedError".into()
            }),
            "the W2 abort marker feeds the same SessionError lane event (D1)"
        );
        assert_eq!(
            translated[11], None,
            "error-less message.updated is routine churn"
        );
        assert_eq!(
            translated[12], None,
            "message.part.delta is activity-irrelevant"
        );
        assert_eq!(translated[13], None, "session.diff is activity-irrelevant");
        assert_eq!(
            translated[14],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".to_string(),
                permission_id: "per-2".to_string(),
            }),
            "permission.v2.asked keeps id/sessionID — one reducer, two families"
        );
        assert_eq!(
            translated[15],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "per-2".to_string(),
            })
        );
        assert_eq!(
            translated[16],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".to_string(),
                permission_id: "que-1".to_string(),
            }),
            "question.asked is a blocker identically to permission.asked (opencode's own TUI treats it so)"
        );
        assert_eq!(
            translated[17],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-1".to_string(),
            })
        );
        assert_eq!(
            translated[18],
            Some(OpencodeLaneEvent::PermissionAsked {
                session_id: "ses-1".to_string(),
                permission_id: "que-2".to_string(),
            })
        );
        assert_eq!(
            translated[19],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-2".to_string(),
            }),
            "a rejected question ends the pause exactly like a reply"
        );
        assert_eq!(
            translated[20],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-1".to_string(),
            })
        );
        assert_eq!(
            translated[21],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "que-2".to_string(),
            })
        );
        assert_eq!(
            translated[22],
            Some(OpencodeLaneEvent::PermissionReplied {
                permission_id: "per-1".to_string(),
            }),
            "rejection IS a replied with reply:\"reject\" — no permission.*.rejected type exists (source-verified v1.18.14); the drain must not wait for one"
        );
    }

    /// Pure prefix check against `TESTED_OPENCODE_VERSION_RANGE`: "1.18.11"
    /// passes; "1.19.0" and "2.0.0" fail (the lane logs once and keeps
    /// bells on).
    #[test]
    fn version_gate_matches_only_the_tested_range() {
        assert!(version_in_tested_range("1.18.11"));
        assert!(!version_in_tested_range("1.19.0"));
        assert!(!version_in_tested_range("2.0.0"));
    }

    /// Name-reliability Task 4: a naming store that refuses (lock busy) the
    /// next `fail` observations, recording every attempt and every accepted
    /// title. Only `observe_native` is exercised.
    #[derive(Default)]
    struct TitleSink {
        fail: AtomicUsize,
        attempts: Mutex<Vec<String>>,
        accepted: Mutex<Vec<String>>,
    }

    impl freshell_freshagent::naming::SessionNaming for TitleSink {
        fn get(
            &self,
            _refs: Vec<freshell_protocol::SessionNameRef>,
        ) -> freshell_freshagent::naming::NameFuture<Vec<freshell_protocol::SessionNameUpdate>>
        {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn ensure_pending(
            &self,
            _input: freshell_freshagent::naming::PendingNameInput,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn bind_pending(
            &self,
            _input: freshell_freshagent::naming::BindNameInput,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn rename(
            &self,
            _input: freshell_freshagent::naming::RenameNameInput,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn activity(
            &self,
            _input: freshell_freshagent::naming::NameActivity,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
        fn observe_native(
            &self,
            input: freshell_freshagent::naming::NativeNameObservation,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            self.attempts.lock().unwrap().push(input.title.clone());
            let refuse = self
                .fail
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok();
            if refuse {
                return Box::pin(async {
                    Err(freshell_freshagent::naming::NameError::LockUnavailable(
                        "injected: the document lock stayed busy".into(),
                    ))
                });
            }
            self.accepted.lock().unwrap().push(input.title.clone());
            let record = freshell_protocol::session_names::SessionNameRecord {
                name_ref: input.target,
                name: input.title,
                source: freshell_protocol::session_names::NameSource::ProviderAi,
                revision: 2,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            };
            Box::pin(async move {
                Ok(freshell_protocol::SessionNameUpdate {
                    record,
                    document_generation: 2,
                    redirects: Vec::new(),
                    changed: true,
                    native_sync: None,
                    outcome: None,
                })
            })
        }
        fn record_acquisition(
            &self,
            _target: freshell_protocol::SessionNameRef,
            _acquisition: freshell_protocol::native_location::NativeAcquisition,
        ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::SessionNameUpdate> {
            Box::pin(async { Err(freshell_freshagent::naming::naming_unavailable("test")) })
        }
    }

    /// Name-reliability Task 4 (the CLI lane's `NativeTitleObserver` seam
    /// that `main.rs` wires): `session.updated` titles fold through the
    /// naming store without ever stalling the lane. The placeholder never
    /// reaches the store, the real title's locked inline attempt hands off
    /// to the background retry, and the event after the titles reaches the
    /// hub at once.
    #[tokio::test(flavor = "multi_thread")]
    async fn naming_title_observer_folds_titles_without_stalling_the_lane() {
        let sink = Arc::new(TitleSink::default());
        sink.fail.store(1, Ordering::SeqCst);
        let observer = crate::opencode_title_naming::naming_title_observer(
            crate::identity::TerminalIdentityRegistry::new(),
            Some(sink.clone() as Arc<dyn freshell_freshagent::naming::SessionNaming>),
        );
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                Ok((404, json!({})))
            }),
        });
        let stream = Arc::new(FakeLaneStream {
            log,
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![
                    parsed(json!({
                        "type": "session.updated",
                        "properties": { "info": {
                            "id": "ses-title",
                            "title": "New session - 2026-10-20T00:09:25.350Z"
                        } }
                    })),
                    parsed(json!({
                        "type": "session.updated",
                        "properties": { "info": {
                            "id": "ses-title",
                            "title": "Publishing blocked by token error"
                        } }
                    })),
                    parsed(json!({
                        "type": "session.idle",
                        "properties": { "sessionID": "ses-title" }
                    })),
                ],
                finish: false,
            }])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: Some(observer),
        });
        let (hub, _rx) = hub();
        (hub.registry_observer())(freshell_terminal::ActivityEvent::Created {
            terminal_id: "t-title".into(),
            mode: "opencode".into(),
            resume_session_id: Some("ses-title".into()),
            at: 1_000,
        });
        hub.register_opencode_lane_for_tests("t-title", 1);
        let (_lane, _verify_tx) =
            spawn_opencode_lane(deps, hub.clone(), "t-title".into(), "http://fake".into(), 1);

        // Snapshot, then the idle that followed both titles — promptly.
        let ingress = wait_for_ingress(&hub, 2, 1_000).await;
        assert!(
            matches!(
                ingress[1].3,
                OpencodeLaneEvent::SessionIdle { ref session_id } if session_id == "ses-title"
            ),
            "{ingress:?}"
        );

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while sink.accepted.lock().unwrap().is_empty() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the background retry never folded the real title: {:?}",
                sink.attempts.lock().unwrap()
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            sink.accepted.lock().unwrap().clone(),
            vec!["Publishing blocked by token error".to_string()]
        );
        assert!(
            !sink
                .attempts
                .lock()
                .unwrap()
                .iter()
                .any(|title| title.starts_with("New session - ")),
            "the placeholder never reached the store"
        );
    }

    /// The cycle shape: health gate (two 500s, then healthy) → two-phase
    /// connect → `/session/status` snapshot → buffered-frame flush. The
    /// snapshot is noted BEFORE the buffered `session.idle`, connect
    /// precedes the snapshot GET, and every ingress event is stamped
    /// (generation 1, cycle 1, stream 1).
    #[tokio::test(flavor = "multi_thread")]
    async fn lane_gates_on_health_then_snapshots_then_streams() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let health_calls = Arc::new(AtomicUsize::new(0));
        let health_calls_resp = health_calls.clone();
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    let n = health_calls_resp.fetch_add(1, Ordering::SeqCst) + 1;
                    if n <= 2 {
                        return Ok((500, json!({})));
                    }
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({ "ses-r": { "type": "busy" } })));
                }
                // Root-resolver probes 404: the conservative forward-anyway
                // path (retried on the next unknown-id occurrence).
                Ok((404, json!({})))
            }),
        });
        let stream = Arc::new(FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![parsed(
                    json!({"type":"session.idle","properties":{"sessionID":"ses-r"}}),
                )],
                live: vec![],
                finish: false, // keep cycle 1 open: all stamps stay (1, 1)
            }])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: None,
        });

        let (hub, mut rx) = hub();
        // A tracked opencode terminal resumed on the root identity, so the
        // snapshot's busy edge and the idle edge flow end-to-end to the wire.
        (hub.registry_observer())(freshell_terminal::ActivityEvent::Created {
            terminal_id: "t-oc".into(),
            mode: "opencode".into(),
            resume_session_id: Some("ses-r".into()),
            at: 1_000,
        });
        hub.register_opencode_lane_for_tests("t-oc", 1);
        let (lane, _verify_tx) =
            spawn_opencode_lane(deps, hub.clone(), "t-oc".into(), "http://fake".into(), 1);

        // Ingress order + stamping: Snapshot BEFORE the buffered
        // SessionIdle, all (generation 1, cycle 1, stream 1).
        let ingress = wait_for_ingress(&hub, 2, 5_000).await;
        assert_eq!(
            ingress[0],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::Snapshot {
                    statuses: vec![("ses-r".into(), OpencodeStatus::Busy)]
                }
            )
        );
        assert_eq!(
            ingress[1],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::SessionIdle {
                    session_id: "ses-r".into()
                }
            )
        );

        // Call order: three health probes gate the cycle, and connect
        // precedes the snapshot GET (the two-phase, loss-free ordering).
        let calls = log.lock().expect("call log").clone();
        let connect_at = calls
            .iter()
            .position(|c| c == "CONNECT http://fake/event")
            .expect("connect happened");
        let snapshot_at = calls
            .iter()
            .position(|c| c == "GET http://fake/session/status")
            .expect("snapshot GET happened");
        assert!(
            connect_at < snapshot_at,
            "two-phase connect must precede the snapshot: {calls:?}"
        );
        assert_eq!(
            calls[..connect_at]
                .iter()
                .filter(|c| *c == "GET http://fake/global/health")
                .count(),
            3,
            "health gated the cycle (two 500s then healthy): {calls:?}"
        );

        // End-to-end wire evidence: the events passed the REAL generation
        // guard — busy upsert from the snapshot, then the idle edge's
        // turn.complete.
        let busy = next_frame_matching(&mut rx, "opencode.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("snapshot busy upsert on the wire");
        assert_eq!(busy["upsert"][0]["terminalId"], "t-oc");
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 5_000, |_| true)
            .await
            .expect("the buffered idle edge completes the turn");
        assert_eq!(complete["provider"], "opencode");
        assert_eq!(complete["terminalId"], "t-oc");

        lane.abort();
    }

    /// Every reconnect is a fresh cycle AND a fresh stream: two clean
    /// streamed cycles note two snapshots stamped (cycle 1, stream 1) then
    /// (cycle 2, stream 2), each after its own connect.
    #[tokio::test(flavor = "multi_thread")]
    async fn reconnect_bumps_stream_and_resnapshots() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                Ok((404, json!({})))
            }),
        });
        let clean_cycle = || StreamScript {
            buffered: vec![],
            live: vec![],
            finish: true, // drive returns Ok(()) immediately → reconnect
        };
        let stream = Arc::new(FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([clean_cycle(), clean_cycle()])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: None,
        });

        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t-oc", 1);
        let (lane, _verify_tx) =
            spawn_opencode_lane(deps, hub.clone(), "t-oc".into(), "http://fake".into(), 1);

        let ingress = wait_for_ingress(&hub, 2, 5_000).await;
        assert_eq!(
            ingress[0],
            (1, 1, 1, OpencodeLaneEvent::Snapshot { statuses: vec![] })
        );
        assert_eq!(
            ingress[1],
            (1, 2, 2, OpencodeLaneEvent::Snapshot { statuses: vec![] }),
            "the reconnect bumps BOTH cycle and stream"
        );

        // Each snapshot was noted after its own connect: the call order is
        // health → connect → snapshot GET → permission GET → question GET,
        // twice (#608: the pending-ask resync runs between the snapshot
        // fetch and the Snapshot note; here both asks GETs 404 → the
        // resync warns and continues).
        let calls = log.lock().expect("call log").clone();
        assert_eq!(
            &calls[..10],
            &[
                "GET http://fake/global/health".to_string(),
                "CONNECT http://fake/event".to_string(),
                "GET http://fake/session/status".to_string(),
                "GET http://fake/permission".to_string(),
                "GET http://fake/question".to_string(),
                "GET http://fake/global/health".to_string(),
                "CONNECT http://fake/event".to_string(),
                "GET http://fake/session/status".to_string(),
                "GET http://fake/permission".to_string(),
                "GET http://fake/question".to_string(),
            ],
            "full order: {calls:?}"
        );

        lane.abort();
    }

    /// D8(c): a streamed event for a session unseen on-stream triggers the
    /// HTTP root resolver, which announces the parent chain (deepest
    /// ancestor first) BEFORE the triggering event; resolver failure
    /// forwards the event anyway (conservative ambiguity stands, retried on
    /// the next occurrence).
    #[tokio::test(flavor = "multi_thread")]
    async fn unmapped_session_is_resolved_via_http_before_forwarding() {
        // ── success: the parentID chain lands root-first, then the event ──
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                if url.ends_with("/session/ses-child") {
                    return Ok((200, json!({ "id": "ses-child", "parentID": "ses-root" })));
                }
                if url.ends_with("/session/ses-root") {
                    return Ok((200, json!({ "id": "ses-root" })));
                }
                Ok((404, json!({})))
            }),
        });
        let stream = Arc::new(FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![parsed(
                    json!({"type":"session.status","properties":{"sessionID":"ses-child","status":{"type":"busy"}}}),
                )],
                finish: false,
            }])),
        });
        let deps = Arc::new(OpencodeLaneDeps {
            http,
            events: stream,
            native_title_observer: None,
        });

        let (hub_ok, _rx) = hub();
        hub_ok.register_opencode_lane_for_tests("t-oc", 1);
        let (lane, _verify_tx) =
            spawn_opencode_lane(deps, hub_ok.clone(), "t-oc".into(), "http://fake".into(), 1);

        let ingress = wait_for_ingress(&hub_ok, 4, 5_000).await;
        assert_eq!(
            ingress[0].3,
            OpencodeLaneEvent::Snapshot { statuses: vec![] }
        );
        assert_eq!(
            ingress[1],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::SessionCreated {
                    session_id: "ses-root".into(),
                    parent_id: None
                }
            ),
            "the deepest unknown ancestor is announced FIRST"
        );
        assert_eq!(
            ingress[2],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::SessionCreated {
                    session_id: "ses-child".into(),
                    parent_id: Some("ses-root".into())
                }
            )
        );
        assert_eq!(
            ingress[3],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::Status {
                    session_id: "ses-child".into(),
                    status: OpencodeStatus::Busy
                }
            ),
            "the triggering event lands AFTER the synthetic chain"
        );
        lane.abort();

        // ── failure: 404 on GET /session/{id} → the Status is forwarded
        //    anyway, with NO synthetic SessionCreated ──
        let log_fail: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http_fail = Arc::new(FakeLaneHttp {
            log: log_fail.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({ "healthy": true, "version": "1.18.11" })));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                Ok((404, json!({})))
            }),
        });
        let stream_fail = Arc::new(FakeLaneStream {
            log: log_fail.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![parsed(
                    json!({"type":"session.status","properties":{"sessionID":"ses-child","status":{"type":"busy"}}}),
                )],
                finish: false,
            }])),
        });
        let deps_fail = Arc::new(OpencodeLaneDeps {
            http: http_fail,
            events: stream_fail,
            native_title_observer: None,
        });

        let (hub_fail, _rx_fail) = hub();
        hub_fail.register_opencode_lane_for_tests("t-oc", 1);
        let (lane_fail, _verify_tx_fail) = spawn_opencode_lane(
            deps_fail,
            hub_fail.clone(),
            "t-oc".into(),
            "http://fake".into(),
            1,
        );

        let ingress = wait_for_ingress(&hub_fail, 2, 5_000).await;
        assert_eq!(
            ingress[1],
            (
                1,
                1,
                1,
                OpencodeLaneEvent::Status {
                    session_id: "ses-child".into(),
                    status: OpencodeStatus::Busy
                }
            ),
            "resolve failure still forwards the triggering event"
        );
        assert!(
            !ingress
                .iter()
                .any(|(_, _, _, e)| matches!(e, OpencodeLaneEvent::SessionCreated { .. })),
            "no synthetic SessionCreated on resolver failure: {ingress:?}"
        );
        // The resolver WAS attempted (and will retry on the next occurrence).
        assert!(
            log_fail
                .lock()
                .expect("call log")
                .iter()
                .any(|c| c == "GET http://fake/session/ses-child"),
            "the resolver probe was attempted"
        );
        lane_fail.abort();
    }

    /// #603: a verify request makes the lane re-fetch /session/status and
    /// note the result with the CURRENT cycle/stream stamps (so the
    /// tracker's sameSessionStream guards accept it); a failing probe
    /// notes SnapshotFailed instead of anything idle-shaped.
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_request_refetches_snapshot_with_current_stamps() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_calls_in_responder = snapshot_calls.clone();
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/session/status") {
                    let n = snapshot_calls_in_responder.fetch_add(1, Ordering::SeqCst);
                    if n <= 1 {
                        // connect snapshot + first verify: busy
                        return Ok((200, json!({"ses-1": {"type": "busy"}})));
                    }
                    // second verify: probe failure
                    return Err("connection refused".to_string());
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );
        // Connect snapshot arrives first.
        let log1 = wait_for_ingress(&hub, 2, 2000).await; // SessionCreated + Snapshot
        let (gen0, cycle0, stream0, _) = log1[log1.len() - 1].clone();
        // Verify request → a SECOND /session/status GET, same stamps.
        verify_tx.send(()).expect("verify channel open");
        let log2 = wait_for_ingress(&hub, 3, 2000).await;
        let (gen1, cycle1, stream1, event1) = log2[log2.len() - 1].clone();
        assert_eq!((gen1, cycle1, stream1), (gen0, cycle0, stream0));
        assert_eq!(
            event1,
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses-1".to_string(), OpencodeStatus::Busy)]
            }
        );
        // Second verify: the probe fails → SnapshotFailed, never idle.
        verify_tx.send(()).expect("verify channel open");
        let log3 = wait_for_ingress(&hub, 4, 2000).await;
        match &log3[log3.len() - 1].3 {
            OpencodeLaneEvent::SnapshotFailed { error } => {
                assert!(error.contains("connection refused"), "got: {error}");
            }
            other => panic!("expected SnapshotFailed, got {other:?}"),
        }
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 3);
        lane.abort();
    }

    /// #604: /session/status parse trouble must never read as "all idle".
    /// Unknown status VOCABULARY degrades toward busy; a SHAPE break is a
    /// probe failure (crash semantics downstream) — pinned both ways.
    #[tokio::test(flavor = "multi_thread")]
    async fn snapshot_unknown_vocabulary_is_busy_and_shape_break_is_failure() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_calls_in_responder = snapshot_calls.clone();
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/session/status") {
                    let n = snapshot_calls_in_responder.fetch_add(1, Ordering::SeqCst);
                    match n {
                        // Connect-cycle snapshot: empty
                        0 => return Ok((200, json!({}))),
                        // First verify: unknown vocabulary "hyperbusy" → Busy + warn
                        1 => return Ok((200, json!({"ses-1": {"type": "hyperbusy"}}))),
                        // Second verify: retry (named so the retrying-turn light can never drift idle)
                        2 => return Ok((200, json!({"ses-1": {"type": "retry"}}))),
                        // Third verify: shape break (not an object)
                        _ => return Ok((200, json!({"ses-1": 42}))),
                    }
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open for verify requests
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );
        // Connect snapshot arrives first (empty, no sessions).
        let log1 = wait_for_ingress(&hub, 1, 2000).await; // Snapshot (empty)
        let (gen0, cycle0, stream0, _) = log1[log1.len() - 1].clone();

        // First verify: unknown vocabulary "hyperbusy" → Busy + warn
        verify_tx.send(()).expect("verify channel open");
        let log2 = wait_for_ingress(&hub, 3, 2000).await; // SessionCreated + Snapshot
        let (gen1, cycle1, stream1, event1) = log2[log2.len() - 1].clone();
        assert_eq!((gen1, cycle1, stream1), (gen0, cycle0, stream0));
        assert_eq!(
            event1,
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses-1".to_string(), OpencodeStatus::Busy)]
            },
            "unknown vocabulary 'hyperbusy' degrades to Busy"
        );

        // Second verify: retry (named so the retrying-turn light can never drift idle)
        verify_tx.send(()).expect("verify channel open");
        let log3 = wait_for_ingress(&hub, 4, 2000).await;
        let (gen2, cycle2, stream2, event2) = log3[log3.len() - 1].clone();
        assert_eq!((gen2, cycle2, stream2), (gen0, cycle0, stream0));
        assert_eq!(
            event2,
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses-1".to_string(), OpencodeStatus::Retry)]
            },
            "retry is Busy everywhere (D6): the light stays on"
        );

        // Third verify: shape break (not an object) → SnapshotFailed
        verify_tx.send(()).expect("verify channel open");
        let log4 = wait_for_ingress(&hub, 5, 2000).await;
        match &log4[log4.len() - 1].3 {
            OpencodeLaneEvent::SnapshotFailed { error } => {
                assert!(
                    error.contains("not an object"),
                    "expected 'not an object' in error, got: {error}"
                );
            }
            other => panic!("expected SnapshotFailed, got {other:?}"),
        }
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 4);
        lane.abort();
    }

    #[test]
    fn drift_contradiction_rule() {
        // Rule (a): a REST-observed status TRANSITION with no recognized
        // stream counterpart is drift…
        assert!(drift_contradiction(Some(true), false, 0));
        assert!(drift_contradiction(Some(false), true, 0));
        // …a transition WITH recognized stream traffic is normal…
        assert!(!drift_contradiction(Some(true), false, 2));
        assert!(!drift_contradiction(Some(false), true, 1));
        // …and steady state across a silent window is a LONG TOOL CALL,
        // not drift (the falsified draft rule: message.part.updated
        // translates to None and session.status publishes on transitions
        // only — never flag busy==busy silence).
        assert!(!drift_contradiction(Some(true), true, 0));
        assert!(!drift_contradiction(Some(false), false, 0));
        // The first observation on a stream has no previous to diff.
        assert!(!drift_contradiction(None, true, 0));
        assert!(!drift_contradiction(None, false, 0));
    }

    #[test]
    fn unseen_pending_asks_rule() {
        // Rule (b): listed-but-never-asked ids are drift evidence; wiring
        // lands with Task 8's pending resync.
        let mut known = std::collections::HashSet::new();
        known.insert("per-1".to_string());
        let listed = vec![
            ("ses-1".to_string(), "per-1".to_string()),
            ("ses-1".to_string(), "que-9".to_string()),
        ];
        assert_eq!(
            unseen_pending_asks(&listed, &known),
            vec!["que-9".to_string()]
        );
        known.insert("que-9".to_string());
        assert!(unseen_pending_asks(&listed, &known).is_empty());
        assert!(unseen_pending_asks(&[], &known).is_empty());
    }

    /// #608: on (re)connect the lane asks GET /permission AND
    /// GET /question (disjoint pending stores, source-verified opencode
    /// v1.18.14) and replays outstanding asks into the tracker BEFORE
    /// the snapshot is noted, so an ask that happened during the SSE gap
    /// still arms the pause; a PermissionsSynced entry follows so the
    /// hub can drain stale local pauses.
    #[tokio::test(flavor = "multi_thread")]
    async fn connect_replays_outstanding_asks_before_snapshot() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/permission") {
                    return Ok((
                        200,
                        json!([{"id":"per-9","sessionID":"ses-1","permission":"bash",
                                "patterns":[],"metadata":{},"always":[]}]),
                    ));
                }
                if url.ends_with("/question") {
                    return Ok((
                        200,
                        json!([{"id":"que-3","sessionID":"ses-1","questions":[]}]),
                    ));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({"ses-1": {"type": "busy"}})));
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, _verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );

        // SessionCreated + PermissionAsked x2 + PermissionsSynced + Snapshot.
        let ingress = wait_for_ingress(&hub, 5, 2000).await;
        let idx_of_per_asked = ingress
            .iter()
            .position(|(_, _, _, e)| {
                *e == OpencodeLaneEvent::PermissionAsked {
                    session_id: "ses-1".to_string(),
                    permission_id: "per-9".to_string(),
                }
            })
            .expect("per-9 replayed as PermissionAsked");
        let idx_of_que_asked = ingress
            .iter()
            .position(|(_, _, _, e)| {
                *e == OpencodeLaneEvent::PermissionAsked {
                    session_id: "ses-1".to_string(),
                    permission_id: "que-3".to_string(),
                }
            })
            .expect("que-3 replayed as PermissionAsked");
        let idx_of_synced = ingress
            .iter()
            .position(|(_, _, _, e)| {
                *e == OpencodeLaneEvent::PermissionsSynced {
                    pending_ids: vec!["per-9".to_string(), "que-3".to_string()],
                }
            })
            .expect("PermissionsSynced noted with both ids");
        let idx_of_snapshot = ingress
            .iter()
            .position(|(_, _, _, e)| matches!(e, OpencodeLaneEvent::Snapshot { .. }))
            .expect("snapshot noted");
        assert!(
            idx_of_per_asked < idx_of_synced && idx_of_que_asked < idx_of_synced,
            "replay must precede reconciliation"
        );
        assert!(
            idx_of_synced < idx_of_snapshot,
            "replay+sync must precede the snapshot"
        );
        // Every entry carries the same (generation, cycle, stream).
        for (generation, cycle, stream_id, _) in &ingress {
            assert_eq!((*generation, *cycle, *stream_id), (7, 1, 1));
        }
        lane.abort();
    }

    /// #608 mid-stream resync wires #604 rule (b): a pending ask id
    /// listed by /permission that was never seen as an *.asked stream
    /// event (nor replayed at connect) is drift — the counter bumps and
    /// the error logs once, but the pause STILL arms: the
    /// PermissionAsked + PermissionsSynced ingress pair arrives anyway.
    #[tokio::test(flavor = "multi_thread")]
    async fn verify_resync_flags_never_streamed_ask_as_drift() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let permission_calls = Arc::new(AtomicUsize::new(0));
        let permission_calls_in_responder = permission_calls.clone();
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(move |url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/permission") {
                    let n = permission_calls_in_responder.fetch_add(1, Ordering::SeqCst);
                    if n == 0 {
                        // Connect-time resync: nothing pending.
                        return Ok((200, json!([])));
                    }
                    // Verify-time resync: a never-streamed pending ask.
                    return Ok((
                        200,
                        json!([{"id":"per-drift","sessionID":"ses-1","permission":"bash",
                                "patterns":[],"metadata":{},"always":[]}]),
                    ));
                }
                if url.ends_with("/question") {
                    return Ok((200, json!([])));
                }
                if url.ends_with("/session/status") {
                    return Ok((200, json!({})));
                }
                if url.ends_with("/session/ses-1") {
                    return Ok((200, json!({"id": "ses-1"})));
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // park: the cycle stays open for verify requests
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );

        // Connect completes: PermissionsSynced (empty) + Snapshot (empty).
        let log1 = wait_for_ingress(&hub, 2, 2000).await;
        assert_eq!(
            log1[0].3,
            OpencodeLaneEvent::PermissionsSynced {
                pending_ids: vec![]
            }
        );
        assert!(matches!(log1[1].3, OpencodeLaneEvent::Snapshot { .. }));

        // One verify against the drifted /permission listing.
        let drift_before = OPENCODE_DRIFT_EVENTS.load(AtomicOrdering::SeqCst);
        verify_tx.send(()).expect("verify channel open");
        // Verify Snapshot + SessionCreated + PermissionAsked +
        // PermissionsSynced.
        let ingress = wait_for_ingress(&hub, 6, 2000).await;
        assert!(
            OPENCODE_DRIFT_EVENTS.load(AtomicOrdering::SeqCst) > drift_before,
            "rule (b) drift increments the counter"
        );
        // The pause still arms even while drift is flagged.
        assert!(
            ingress.iter().any(|(_, _, _, e)| *e
                == OpencodeLaneEvent::PermissionAsked {
                    session_id: "ses-1".to_string(),
                    permission_id: "per-drift".to_string(),
                }),
            "the never-streamed ask is still replayed: {ingress:?}"
        );
        assert!(
            ingress.iter().any(|(_, _, _, e)| *e
                == OpencodeLaneEvent::PermissionsSynced {
                    pending_ids: vec!["per-drift".to_string()],
                }),
            "reconciliation still follows the replay: {ingress:?}"
        );
        lane.abort();
    }

    /// A failing CONNECT-cycle snapshot notes SnapshotFailed (loud, crash
    /// semantics) instead of silently backing off.
    #[tokio::test(flavor = "multi_thread")]
    async fn connect_snapshot_failure_is_noted() {
        let log: CallLog = Arc::new(Mutex::new(Vec::new()));
        let http = FakeLaneHttp {
            log: log.clone(),
            respond: Box::new(|url| {
                if url.ends_with("/global/health") {
                    return Ok((200, json!({"healthy": true, "version": "1.18.14"})));
                }
                if url.ends_with("/session/status") {
                    return Err("boom".to_string());
                }
                Ok((404, json!({})))
            }),
        };
        let stream = FakeLaneStream {
            log: log.clone(),
            scripts: Mutex::new(VecDeque::from([StreamScript {
                buffered: vec![],
                live: vec![],
                finish: false, // one parked stream
            }])),
        };
        let (hub, _rx) = hub();
        hub.register_opencode_lane_for_tests("t1", 7);
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(http),
            events: Arc::new(stream),
            native_title_observer: None,
        });
        let (lane, _verify_tx) = spawn_opencode_lane(
            deps,
            hub.clone(),
            "t1".to_string(),
            "http://127.0.0.1:1".to_string(),
            7,
        );

        // The FIRST ingress entry should be SnapshotFailed (noting the failure
        // on the connect-cycle snapshot, loud crash semantics).
        let ingress = wait_for_ingress(&hub, 1, 2000).await;
        match &ingress[0].3 {
            OpencodeLaneEvent::SnapshotFailed { error } => {
                assert!(
                    error.contains("boom"),
                    "expected 'boom' in error, got: {error}"
                );
            }
            other => panic!("expected SnapshotFailed as first ingress, got {other:?}"),
        }
        lane.abort();
    }
}

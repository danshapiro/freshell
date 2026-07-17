//! codex app-server **wire protocol** — the pure JSON-RPC framing + typed notification
//! parsing, a faithful port of the envelope handling in
//! `server/coding-cli/codex-app-server/client.ts` (`handleSocketMessage`, `:567-641`) and
//! the notification schemas in `protocol.ts:329-415`, plus the validated
//! `extractTurnNotificationEvent` classifier from `json-rpc-side-effects.ts:398-445`.
//!
//! One JSON message per WS frame (`client.ts:796,808`). Envelopes are JSON-RPC 2.0-shaped:
//! - **request** (client→server): `{ id, method, params }` (`client.ts:796`). The reference
//!   does NOT emit a literal `"jsonrpc":"2.0"` tag and the real codex-cli 0.142.x accepts
//!   its absence (proven by the T2 baseline); [`build_request_frame`] mirrors that shape.
//! - **success** (server→client): `{ id, result }` (`protocol.ts:335-338`).
//! - **error** (server→client): `{ id?, error:{code,message,data?} }` (`protocol.ts:340-343`).
//! - **notification** (server→client): `{ method, params }` (`protocol.ts:345-348`). The fake
//!   app-server tags these `"jsonrpc":"2.0"` (`fake-app-server.mjs:321-325`) and the zod
//!   envelope is `.passthrough()`, so the parser TOLERATES a `jsonrpc` tag on any frame.
//!
//! [`parse_incoming_frame`] reproduces the reference discrimination exactly: a frame with an
//! `id` key is a response/error; otherwise it is a notification. Malformed JSON is dropped
//! (returns `None`), never fatal (`client.ts:571-573`).

use std::fmt;

use serde_json::{json, Map, Value};

/// The four codex turn statuses (`CodexTurnStatusSchema`, `protocol.ts:104`;
/// `TURN_STATUSES`, `json-rpc-side-effects.ts:176`). `turn/completed` fires for ALL of
/// these — only `completed` is a positive completion (see [`crate::events`]).
pub const TURN_STATUSES: &[&str] = &["completed", "interrupted", "failed", "inProgress"];

/// A JSON-RPC request id — string or integer (`CodexRequestIdSchema`, `protocol.ts:3`). The
/// reference client only ever mints integers (`nextRequestId++`, `client.ts:127,781`); string
/// ids are accepted for faithfulness.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RequestId {
    Int(i64),
    Str(String),
}

impl RequestId {
    fn to_json(&self) -> Value {
        match self {
            RequestId::Int(n) => json!(n),
            RequestId::Str(s) => json!(s),
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Int(n) => write!(f, "{n}"),
            RequestId::Str(s) => write!(f, "{s}"),
        }
    }
}

/// A JSON-RPC error object (`CodexRpcErrorSchema`, `protocol.ts:329-333`).
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

/// One decoded server→client frame (`handleSocketMessage`, `client.ts:567-641`).
#[derive(Clone, Debug, PartialEq)]
pub enum IncomingMessage {
    /// `{ id, result }` — resolves the pending request `id`.
    Response { id: RequestId, result: Value },
    /// `{ id, error }` — rejects the pending request `id`.
    RpcError { id: RequestId, error: RpcError },
    /// `{ method, params }` — a server-initiated notification.
    Notification {
        method: String,
        params: Option<Value>,
    },
}

/// A turn lifecycle event carrying the FULL notification params (`emitTurnEvent`,
/// `client.ts:669-678`): `{ threadId, turnId?, params }`. The adapter reads
/// `params.turn?.status ?? params.status` off this (`adapter.ts:922-923`).
#[derive(Clone, Debug, PartialEq)]
pub struct CodexTurnEvent {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub params: Map<String, Value>,
}

/// A classified server→client notification (the fan-out in `client.ts:576-615`).
#[derive(Clone, Debug, PartialEq)]
pub enum CodexNotification {
    /// `thread/started` (`protocol.ts:350-355`) — carries the thread handle.
    ThreadStarted { thread: Value },
    /// `thread/closed` (`protocol.ts:359-364`).
    ThreadClosed { thread_id: String },
    /// `thread/status/changed` (`protocol.ts:366-374`).
    ThreadStatusChanged { thread_id: String, status: Value },
    /// `fs/changed` (`protocol.ts:382-388`).
    FsChanged {
        watch_id: String,
        changed_paths: Vec<String>,
    },
    /// `turn/started` (`protocol.ts:390-396`).
    TurnStarted(CodexTurnEvent),
    /// `turn/completed` (`protocol.ts:398-415`) — status-guarded downstream.
    TurnCompleted(CodexTurnEvent),
    /// Any other notification method (generic `handleNotification`, `client.ts:643-661`).
    Other {
        method: String,
        params: Option<Value>,
    },
}

// ── frame building (client.ts:796,807-808) ────────────────────────────────────────────

/// Build a request frame `{ id, method, params }` (`client.ts:796`). Faithful to the
/// reference: no `"jsonrpc":"2.0"` tag (the real cli tolerates its absence; proven by the
/// T2 baseline). Key order (`id`, `method`, `params`) matches the reference insertion order.
pub fn build_request_frame(id: &RequestId, method: &str, params: &Value) -> String {
    let mut obj = Map::new();
    obj.insert("id".to_string(), id.to_json());
    obj.insert("method".to_string(), json!(method));
    obj.insert("params".to_string(), params.clone());
    serde_json::to_string(&Value::Object(obj)).expect("request frame serializes")
}

/// Build a notification frame: `{ method }` when `params` is `None`, else `{ method, params }`
/// (`notify`, `client.ts:805-808`).
pub fn build_notification_frame(method: &str, params: Option<&Value>) -> String {
    let mut obj = Map::new();
    obj.insert("method".to_string(), json!(method));
    if let Some(params) = params {
        obj.insert("params".to_string(), params.clone());
    }
    serde_json::to_string(&Value::Object(obj)).expect("notification frame serializes")
}

// ── frame parsing (client.ts:567-641) ──────────────────────────────────────────────────

fn parse_request_id(value: &Value) -> Option<RequestId> {
    match value {
        Value::String(s) => Some(RequestId::Str(s.clone())),
        Value::Number(n) => n.as_i64().map(RequestId::Int),
        _ => None,
    }
}

fn parse_rpc_error(value: &Value) -> Option<RpcError> {
    let obj = value.as_object()?;
    let code = obj.get("code")?.as_i64()?;
    let message = obj.get("message")?.as_str()?.to_string();
    let data = obj.get("data").cloned();
    Some(RpcError {
        code,
        message,
        data,
    })
}

/// Decode one server→client frame. Mirrors the reference discrimination: a frame WITH an
/// `id` key is a response (`{id,result}`) or error (`{id,error}`); a frame WITHOUT an `id`
/// key is a notification (needs a string `method`). Malformed JSON, non-objects, and a
/// with-id frame lacking both `result` and `error` all yield `None` (dropped, never fatal —
/// `client.ts:571-573,631-633`). A `jsonrpc` tag, if present, is ignored (tolerated).
pub fn parse_incoming_frame(raw: &str) -> Option<IncomingMessage> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;

    if obj.contains_key("id") {
        let id = parse_request_id(obj.get("id")?)?;
        if let Some(result) = obj.get("result") {
            return Some(IncomingMessage::Response {
                id,
                result: result.clone(),
            });
        }
        if let Some(error) = obj.get("error") {
            return Some(IncomingMessage::RpcError {
                id,
                error: parse_rpc_error(error)?,
            });
        }
        // Has id but neither result nor error → not a recognizable envelope; drop.
        return None;
    }

    let method = obj.get("method")?.as_str()?.to_string();
    let params = obj.get("params").cloned();
    Some(IncomingMessage::Notification { method, params })
}

/// A client→server frame decoded from the SERVER's perspective — a request
/// `{ id, method, params }` or a notification `{ method }` / `{ method, params }`. Used by
/// in-memory test/dev peers (and the future live harness) to drive the client; the reference
/// server side is the `ws` `on('message')` handler (`fake-app-server.mjs:418-426`).
#[derive(Clone, Debug, PartialEq)]
pub enum ClientFrame {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
}

/// Decode a client→server frame: a frame WITH an `id` key is a request, else a notification
/// (`fake-app-server.mjs:420` uses the same `hasOwnProperty('id')` discriminant). Returns
/// `None` for malformed JSON or a frame lacking a string `method`.
pub fn parse_client_frame(raw: &str) -> Option<ClientFrame> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    let method = obj.get("method")?.as_str()?.to_string();
    if let Some(id) = obj.get("id") {
        let id = parse_request_id(id)?;
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        return Some(ClientFrame::Request { id, method, params });
    }
    Some(ClientFrame::Notification {
        method,
        params: obj.get("params").cloned(),
    })
}

// ── notification classification (client.ts:576-615) ─────────────────────────────────────

fn required_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)?.as_str().map(str::to_string)
}

fn turn_event_from_params(params: Option<&Value>) -> Option<CodexTurnEvent> {
    let obj = params?.as_object()?;
    let thread_id = required_string(obj, "threadId")?;
    let turn_id = obj
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(CodexTurnEvent {
        thread_id,
        turn_id,
        params: obj.clone(),
    })
}

/// Classify a notification method+params into a typed [`CodexNotification`]
/// (`client.ts:576-615`). Notifications whose required fields are missing/malformed fall
/// through to [`CodexNotification::Other`] rather than aborting — matching the reference,
/// which simply does not dispatch a typed handler when a `safeParse` fails.
pub fn classify_notification(method: &str, params: Option<&Value>) -> CodexNotification {
    let params_obj = params.and_then(Value::as_object);
    match method {
        "thread/started" => {
            if let Some(thread) = params_obj.and_then(|p| p.get("thread")).cloned() {
                return CodexNotification::ThreadStarted { thread };
            }
        }
        "thread/closed" => {
            if let Some(thread_id) = params_obj.and_then(|p| required_string(p, "threadId")) {
                return CodexNotification::ThreadClosed { thread_id };
            }
        }
        "thread/status/changed" => {
            if let Some(p) = params_obj {
                if let (Some(thread_id), Some(status)) =
                    (required_string(p, "threadId"), p.get("status").cloned())
                {
                    return CodexNotification::ThreadStatusChanged { thread_id, status };
                }
            }
        }
        "fs/changed" => {
            if let Some(p) = params_obj {
                if let Some(watch_id) = required_string(p, "watchId") {
                    let changed_paths = p
                        .get("changedPaths")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    return CodexNotification::FsChanged {
                        watch_id,
                        changed_paths,
                    };
                }
            }
        }
        "turn/started" => {
            if let Some(event) = turn_event_from_params(params) {
                return CodexNotification::TurnStarted(event);
            }
        }
        "turn/completed" => {
            if let Some(event) = turn_event_from_params(params) {
                return CodexNotification::TurnCompleted(event);
            }
        }
        _ => {}
    }
    CodexNotification::Other {
        method: method.to_string(),
        params: params.cloned(),
    }
}

/// The RAW completion status the adapter guard reads: `params.turn?.status ?? params.status`
/// (`adapter.ts:922-923`), with NO enum validation. `??` semantics: `turn.status` wins when
/// present (even if `null`/absent it falls back to `status`). Returns `None` when neither is
/// a string. This is the exact value fed to `if (status !== 'completed')`.
pub fn turn_status(params: &Map<String, Value>) -> Option<String> {
    let nested = params
        .get("turn")
        .and_then(Value::as_object)
        .and_then(|t| t.get("status"))
        .and_then(Value::as_str);
    if let Some(status) = nested {
        return Some(status.to_string());
    }
    params
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The result of the validated turn-notification classifier
/// ([`extract_turn_notification_event`]).
#[derive(Clone, Debug, PartialEq)]
pub enum TurnNotificationEvent {
    Started {
        thread_id: String,
        turn_id: Option<String>,
    },
    Completed {
        thread_id: String,
        turn_id: Option<String>,
        status: Option<String>,
    },
    /// The reference's `{ ok:false, reason }` (`json-rpc-side-effects.ts`). The CORE reports
    /// the reason string verbatim for the common cases (`unsupported_shape`, `malformed_json`).
    Rejected { reason: String },
}

/// A faithful semantic port of `extractTurnNotificationEvent` (`json-rpc-side-effects.ts:398-445`):
/// classify a `turn/started` / `turn/completed` frame and VALIDATE the completed status
/// against [`TURN_STATUSES`]. Unlike the reference's byte-scanner (a remote-proxy hardening
/// concern, deferred), this parses with `serde_json` — equivalent for well-formed frames,
/// which is what the CORE consumes. A bogus/absent-required field is `Rejected`.
pub fn extract_turn_notification_event(raw: &str) -> TurnNotificationEvent {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return TurnNotificationEvent::Rejected {
            reason: "malformed_json".to_string(),
        };
    };
    let Some(obj) = value.as_object() else {
        return TurnNotificationEvent::Rejected {
            reason: "unsupported_shape".to_string(),
        };
    };
    let method = obj.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "turn/started" && method != "turn/completed" {
        return TurnNotificationEvent::Rejected {
            reason: "unsupported_shape".to_string(),
        };
    }
    let Some(params) = obj.get("params").and_then(Value::as_object) else {
        return TurnNotificationEvent::Rejected {
            reason: "unsupported_shape".to_string(),
        };
    };
    let thread_id = match required_string(params, "threadId") {
        Some(id) if !id.is_empty() => id,
        _ => {
            return TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".to_string(),
            }
        }
    };
    // turnId, if present, must be a string.
    let turn_id = match params.get("turnId") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".to_string(),
            }
        }
    };

    if method == "turn/started" {
        return TurnNotificationEvent::Started { thread_id, turn_id };
    }

    // turn/completed: status = turn.status ?? status, validated against TURN_STATUSES.
    let status = turn_status(params);
    if let Some(ref s) = status {
        if !TURN_STATUSES.contains(&s.as_str()) {
            return TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".to_string(),
            };
        }
    }
    TurnNotificationEvent::Completed {
        thread_id,
        turn_id,
        status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── frame building ─────────────────────────────────────────────────────────────────

    #[test]
    fn request_frame_has_id_method_params_and_no_jsonrpc_tag() {
        // Mirrors client.ts:796 exactly: { id, method, params } with no jsonrpc tag.
        let frame = build_request_frame(
            &RequestId::Int(1),
            "initialize",
            &json!({ "clientInfo": {} }),
        );
        assert_eq!(
            frame,
            r#"{"id":1,"method":"initialize","params":{"clientInfo":{}}}"#
        );
        assert!(
            !frame.contains("jsonrpc"),
            "the reference does not emit a jsonrpc tag"
        );
    }

    #[test]
    fn notification_frame_omits_params_when_absent() {
        // `notify('initialized')` sends { method } with no params (client.ts:807).
        assert_eq!(
            build_notification_frame("initialized", None),
            r#"{"method":"initialized"}"#
        );
        assert_eq!(
            build_notification_frame("x", Some(&json!({ "a": 1 }))),
            r#"{"method":"x","params":{"a":1}}"#
        );
    }

    // ── frame parsing discrimination (from fake-app-server shapes) ───────────────────────

    #[test]
    fn parses_success_envelope() {
        // fake-app-server.mjs:497-500 sends { id, result }.
        let msg = parse_incoming_frame(r#"{"id":3,"result":{"turn":{"id":"turn-1"}}}"#).unwrap();
        assert_eq!(
            msg,
            IncomingMessage::Response {
                id: RequestId::Int(3),
                result: json!({ "turn": { "id": "turn-1" } })
            }
        );
    }

    #[test]
    fn parses_error_envelope() {
        // fake-app-server.mjs:428-434 sends { id, error:{code,message} }.
        let msg =
            parse_incoming_frame(r#"{"id":5,"error":{"code":-32600,"message":"bad"}}"#).unwrap();
        assert_eq!(
            msg,
            IncomingMessage::RpcError {
                id: RequestId::Int(5),
                error: RpcError {
                    code: -32600,
                    message: "bad".into(),
                    data: None
                },
            }
        );
    }

    #[test]
    fn parses_notification_and_tolerates_jsonrpc_tag() {
        // fake-app-server.mjs:320-325 broadcasts notifications WITH jsonrpc:'2.0' — tolerated.
        let msg = parse_incoming_frame(
            r#"{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"t","status":"completed"}}"#,
        )
        .unwrap();
        assert_eq!(
            msg,
            IncomingMessage::Notification {
                method: "turn/completed".into(),
                params: Some(json!({ "threadId": "t", "status": "completed" })),
            }
        );
    }

    #[test]
    fn drops_malformed_and_incomplete_frames() {
        assert_eq!(parse_incoming_frame("{not json"), None);
        assert_eq!(parse_incoming_frame("[1,2,3]"), None); // batch/array → dropped
        assert_eq!(parse_incoming_frame(r#""a string""#), None);
        // Has id but neither result nor error → dropped (mirror strict-envelope failure).
        assert_eq!(parse_incoming_frame(r#"{"id":1,"foo":true}"#), None);
        // No id and no method → dropped.
        assert_eq!(parse_incoming_frame(r#"{"params":{}}"#), None);
    }

    #[test]
    fn parses_string_request_ids_too() {
        let msg = parse_incoming_frame(r#"{"id":"req-7","result":{}}"#).unwrap();
        assert_eq!(
            msg,
            IncomingMessage::Response {
                id: RequestId::Str("req-7".into()),
                result: json!({})
            }
        );
    }

    // ── notification classification (client.ts fan-out) ─────────────────────────────────

    #[test]
    fn classifies_turn_started_with_extra_fields() {
        // client.test.ts:434-437: params { threadId, turnId, extra } — full params retained.
        let n = classify_notification(
            "turn/started",
            Some(&json!({ "threadId": "thread-1", "turnId": "turn-1", "extra": true })),
        );
        match n {
            CodexNotification::TurnStarted(ev) => {
                assert_eq!(ev.thread_id, "thread-1");
                assert_eq!(ev.turn_id.as_deref(), Some("turn-1"));
                assert_eq!(ev.params.get("extra"), Some(&json!(true)));
            }
            other => panic!("expected TurnStarted, got {other:?}"),
        }
    }

    #[test]
    fn classifies_turn_completed_flat_and_inline_shapes() {
        // Flat status (client.test.ts:438-441 shape).
        let flat = classify_notification(
            "turn/completed",
            Some(&json!({ "threadId": "thread-1", "turnId": "turn-1", "status": "completed" })),
        );
        assert!(
            matches!(flat, CodexNotification::TurnCompleted(ref e) if e.thread_id == "thread-1")
        );

        // Inline turn.status (codex-adapter.test.ts:1109 shape).
        let inline = classify_notification(
            "turn/completed",
            Some(
                &json!({ "threadId": "thread-1", "turn": { "id": "turn-1", "status": "completed" } }),
            ),
        );
        assert!(matches!(inline, CodexNotification::TurnCompleted(_)));
    }

    #[test]
    fn classifies_thread_lifecycle_and_fs_changed() {
        assert_eq!(
            classify_notification("thread/started", Some(&json!({ "thread": { "id": "t1" } }))),
            CodexNotification::ThreadStarted {
                thread: json!({ "id": "t1" })
            }
        );
        assert_eq!(
            classify_notification("thread/closed", Some(&json!({ "threadId": "t1" }))),
            CodexNotification::ThreadClosed {
                thread_id: "t1".into()
            }
        );
        assert_eq!(
            classify_notification(
                "thread/status/changed",
                Some(&json!({ "threadId": "t1", "status": { "type": "idle" } }))
            ),
            CodexNotification::ThreadStatusChanged {
                thread_id: "t1".into(),
                status: json!({ "type": "idle" })
            }
        );
        assert_eq!(
            classify_notification(
                "fs/changed",
                Some(&json!({ "watchId": "w1", "changedPaths": ["/a", "/b"] }))
            ),
            CodexNotification::FsChanged {
                watch_id: "w1".into(),
                changed_paths: vec!["/a".into(), "/b".into()]
            }
        );
    }

    #[test]
    fn unknown_notification_is_other() {
        assert_eq!(
            classify_notification("something/else", Some(&json!({ "x": 1 }))),
            CodexNotification::Other {
                method: "something/else".into(),
                params: Some(json!({ "x": 1 }))
            }
        );
    }

    // ── turn_status: params.turn.status ?? params.status ───────────────────────────────

    #[test]
    fn turn_status_prefers_inline_then_flat() {
        // Inline turn.status wins.
        let inline = json!({ "turn": { "status": "completed" }, "status": "interrupted" });
        assert_eq!(
            turn_status(inline.as_object().unwrap()).as_deref(),
            Some("completed")
        );
        // Falls back to flat status when no inline turn.status.
        let flat = json!({ "status": "failed" });
        assert_eq!(
            turn_status(flat.as_object().unwrap()).as_deref(),
            Some("failed")
        );
        // Neither → None.
        let neither = json!({ "threadId": "t" });
        assert_eq!(turn_status(neither.as_object().unwrap()), None);
    }

    // ── extractTurnNotificationEvent (validated classifier) ─────────────────────────────

    #[test]
    fn extract_turn_event_validates_all_statuses() {
        // json-rpc-side-effects.test.ts:408-432: every valid status classifies; bogus rejects.
        for status in TURN_STATUSES {
            let raw = format!(
                r#"{{"method":"turn/completed","params":{{"threadId":"thread-1","turnId":"turn-{status}","status":"{status}"}}}}"#
            );
            assert_eq!(
                extract_turn_notification_event(&raw),
                TurnNotificationEvent::Completed {
                    thread_id: "thread-1".into(),
                    turn_id: Some(format!("turn-{status}")),
                    status: Some(status.to_string()),
                }
            );
        }
        // Flat bogus and nested bogus both reject as unsupported_shape.
        assert_eq!(
            extract_turn_notification_event(
                r#"{"method":"turn/completed","params":{"threadId":"thread-1","turnId":"t","status":"bogus"}}"#
            ),
            TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".into()
            }
        );
        assert_eq!(
            extract_turn_notification_event(
                r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"t","status":"bogus"}}}"#
            ),
            TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".into()
            }
        );
    }

    #[test]
    fn extract_turn_event_started_and_rejections() {
        assert_eq!(
            extract_turn_notification_event(
                r#"{"method":"turn/started","params":{"threadId":"thread-1","turnId":"turn-1","extra":true}}"#
            ),
            TurnNotificationEvent::Started {
                thread_id: "thread-1".into(),
                turn_id: Some("turn-1".into())
            }
        );
        // Wrong method, missing threadId, non-object params, malformed json.
        assert_eq!(
            extract_turn_notification_event(
                r#"{"method":"thread/closed","params":{"threadId":"t"}}"#
            ),
            TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".into()
            }
        );
        assert_eq!(
            extract_turn_notification_event(
                r#"{"method":"turn/completed","params":{"turnId":"t"}}"#
            ),
            TurnNotificationEvent::Rejected {
                reason: "unsupported_shape".into()
            }
        );
        assert_eq!(
            extract_turn_notification_event("{bad"),
            TurnNotificationEvent::Rejected {
                reason: "malformed_json".into()
            }
        );
    }
}

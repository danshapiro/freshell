//! opencode serve **event** parsing — a faithful port of
//! `server/fresh-agent/adapters/opencode/serve-events.ts` plus the idle/activity
//! classifiers and the SSE block decoder from `serve-manager.ts`.
//!
//! Three pieces:
//! 1. [`parse_serve_event`] — normalize one decoded SSE payload into a
//!    [`ParsedServeEvent`] (`serve-events.ts:58-72`). `/event` frames are flat
//!    `{ type, properties }`; `/global/event` wraps that under `payload`. Session ids
//!    live at `properties.sessionID` (also `properties.part.sessionID` /
//!    `properties.info.sessionID`). Server control frames (`server.connected` /
//!    `server.heartbeat`) are dropped.
//! 2. The **idle edge** classifiers ([`is_idle_status_event`],
//!    [`is_running_status_type`], [`is_idle_status_type`],
//!    [`event_shows_running_status_activity`]) — ported verbatim from
//!    `serve-manager.ts:35-55`. These decide the completion IDLE edge the serve
//!    client surfaces (`session.idle` / `session.status{type:idle}`).
//! 3. [`serve_event_to_sdk`] — map a parsed serve event to the `sdk.*` provider event
//!    the runtime slice understands (`serve-events.ts:99-118`).
//!
//! Plus [`SseDecoder`]: the streaming `\n\n`-delimited `data:` block parser from
//! `serve-manager.ts:529-571` (CRLF-normalized, `:` comments and non-`data:` lines
//! skipped, multi-line `data:` joined), extracted as a pure unit so the real SSE
//! transport and these tests share one decoder.

use serde_json::{Map, Value};

/// One normalized OpenCode SSE event. Mirrors `ParsedServeEvent` (`serve-events.ts:14-20`).
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedServeEvent {
    /// The event discriminant (`payload.type`), e.g. `session.idle`, `session.status`.
    pub kind: String,
    /// The session this event targets, resolved from the property fan-out.
    pub session_id: Option<String>,
    /// The denormalized `properties` payload from the source event.
    pub properties: Map<String, Value>,
    /// The full decoded payload object (`raw` in the reference).
    pub raw: Map<String, Value>,
}

/// The `sdk.*` provider event a parsed serve event maps to (`serve-events.ts:74-77`).
#[derive(Clone, Debug, PartialEq)]
pub enum SdkProviderEvent {
    /// `session.idle` / `session.status{busy|retry|idle}` → a lifecycle snapshot.
    Snapshot {
        session_id: String,
        status: SnapshotStatus,
    },
    /// A transcript/message invalidation or a non-lifecycle status change.
    Changed {
        session_id: String,
        reason: ChangedReason,
    },
    /// A `session.error` surfaced during the turn.
    Error { session_id: String, message: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotStatus {
    Running,
    Idle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangedReason {
    OpencodeMessage,
    OpencodeStatus,
}

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// `stringProperty(value, key)` (`serve-events.ts:22-26`) — `value[key]` iff it is a string.
fn string_property(value: Option<&Value>, key: &str) -> Option<String> {
    let obj = as_object(value?)?;
    match obj.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `nonEmptyString(value)` (`serve-events.ts:28-30`).
fn non_empty_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `opencodeErrorMessage(value)` (`serve-events.ts:32-39`).
fn opencode_error_message(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => non_empty_string(Some(&Value::String(s.clone()))),
        Some(Value::Object(record)) => non_empty_string(record.get("message"))
            .or_else(|| string_property(record.get("data"), "message"))
            .or_else(|| non_empty_string(record.get("error"))),
        _ => None,
    }
}

/// `eventPayload(raw)` (`serve-events.ts:41-48`): a flat `{type,...}` frame is its own
/// payload; otherwise unwrap `payload` when it is an object.
fn event_payload(raw: &Map<String, Value>) -> Option<&Map<String, Value>> {
    if matches!(raw.get("type"), Some(Value::String(_))) {
        return Some(raw);
    }
    as_object(raw.get("payload")?)
}

/// `isServerControlEvent(kind)` (`serve-events.ts:50-52`).
fn is_server_control_event(kind: &str) -> bool {
    kind == "server.connected" || kind == "server.heartbeat"
}

/// Normalize one decoded OpenCode SSE payload (`parseServeEvent`, `serve-events.ts:58-72`).
/// Returns `None` for non-objects, payloads without a string `type`, and server control
/// frames.
pub fn parse_serve_event(event: &Value) -> Option<ParsedServeEvent> {
    let raw_obj = as_object(event)?;
    let payload = event_payload(raw_obj)?;
    let kind = match payload.get("type") {
        Some(Value::String(s)) => s.clone(),
        _ => return None,
    };
    if is_server_control_event(&kind) {
        return None;
    }
    let props: Map<String, Value> = match payload.get("properties") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let session_id = string_property(Some(&Value::Object(props.clone())), "sessionID")
        .or_else(|| string_property(props.get("part"), "sessionID"))
        .or_else(|| string_property(props.get("info"), "sessionID"));
    Some(ParsedServeEvent {
        kind,
        session_id,
        properties: props,
        raw: payload.clone(),
    })
}

// ── idle / activity classifiers (serve-manager.ts:35-55) ────────────────────────

/// `isRunningStatusType(type)` (`serve-manager.ts:42-44`).
pub fn is_running_status_type(type_value: Option<&Value>) -> bool {
    matches!(type_value, Some(Value::String(s)) if s == "busy" || s == "retry")
}

/// `isIdleStatusType(type)` (`serve-manager.ts:46-48`).
pub fn is_idle_status_type(type_value: Option<&Value>) -> bool {
    matches!(type_value, Some(Value::String(s)) if s == "idle")
}

/// `isIdleStatusEvent(event)` (`serve-manager.ts:35-40`) — a `session.status` whose
/// `properties.status.type === 'idle'`.
pub fn is_idle_status_event(event: &ParsedServeEvent) -> bool {
    if event.kind != "session.status" {
        return false;
    }
    let Some(Value::Object(status)) = event.properties.get("status") else {
        return false;
    };
    is_idle_status_type(status.get("type"))
}

/// `eventShowsRunningStatusActivity(event)` (`serve-manager.ts:50-55`).
pub fn event_shows_running_status_activity(event: &ParsedServeEvent) -> bool {
    if event.kind != "session.status" {
        return false;
    }
    let Some(Value::Object(status)) = event.properties.get("status") else {
        return false;
    };
    is_running_status_type(status.get("type"))
}

/// The completion IDLE edge the serve client surfaces: `session.idle` OR
/// `session.status{type:idle}` (`serve-manager.ts:507`).
pub fn is_idle_edge(event: &ParsedServeEvent) -> bool {
    event.kind == "session.idle" || is_idle_status_event(event)
}

// ── sdk.* mapping (serve-events.ts:79-118) ──────────────────────────────────────

/// `opencodeStatusToSnapshotStatus` (`serve-events.ts:79-89`).
fn opencode_status_to_snapshot_status(status_type: Option<&str>) -> Option<SnapshotStatus> {
    match status_type {
        Some("busy") | Some("retry") => Some(SnapshotStatus::Running),
        Some("idle") => Some(SnapshotStatus::Idle),
        _ => None,
    }
}

fn is_opencode_transcript_event(kind: &str) -> bool {
    kind.starts_with("message.")
}

/// `serveEventToSdk(parsed, subscribedId)` (`serve-events.ts:99-118`): map to the `sdk.*`
/// provider event stamped with the id the client first subscribed with.
pub fn serve_event_to_sdk(
    parsed: &ParsedServeEvent,
    subscribed_id: &str,
) -> Option<SdkProviderEvent> {
    match parsed.kind.as_str() {
        "session.idle" => Some(SdkProviderEvent::Snapshot {
            session_id: subscribed_id.to_string(),
            status: SnapshotStatus::Idle,
        }),
        "session.status" => {
            let status_type = string_property(parsed.properties.get("status"), "type");
            match opencode_status_to_snapshot_status(status_type.as_deref()) {
                Some(status) => Some(SdkProviderEvent::Snapshot {
                    session_id: subscribed_id.to_string(),
                    status,
                }),
                None => Some(SdkProviderEvent::Changed {
                    session_id: subscribed_id.to_string(),
                    reason: ChangedReason::OpencodeStatus,
                }),
            }
        }
        "session.error" => {
            let message = opencode_error_message(parsed.properties.get("error"))
                .unwrap_or_else(|| "OpenCode session error".to_string());
            Some(SdkProviderEvent::Error {
                session_id: subscribed_id.to_string(),
                message,
            })
        }
        kind if is_opencode_transcript_event(kind) => Some(SdkProviderEvent::Changed {
            session_id: subscribed_id.to_string(),
            reason: ChangedReason::OpencodeMessage,
        }),
        _ => None,
    }
}

// ── SSE block decoder (serve-manager.ts:529-571 consumeEvents inner loop) ────────

/// Streaming decoder for the serve `text/event-stream`: accumulates bytes, splits on
/// `\n\n` event boundaries (CRLF-normalized), collects `data:` lines (skipping `:`
/// comments and non-`data:` lines), joins multi-line data, `JSON.parse`s, and returns
/// the [`parse_serve_event`]-normalized events. A malformed frame is skipped, never
/// fatal (`serve-manager.ts:558-561`).
#[derive(Default)]
pub struct SseDecoder {
    buf: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }

    /// Feed a decoded UTF-8 chunk; return any complete events it produced.
    pub fn push_str(&mut self, chunk: &str) -> Vec<ParsedServeEvent> {
        // Normalize CRLF so '\r\n\r\n' boundaries are treated uniformly (serve-manager.ts:544).
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut out = Vec::new();
        while let Some(idx) = self.buf.find("\n\n") {
            let block = self.buf[..idx].to_string();
            self.buf.drain(..idx + 2);
            if let Some(event) = decode_sse_block(&block) {
                out.push(event);
            }
        }
        out
    }
}

/// Parse a single SSE block (the text between `\n\n` boundaries) into an event.
fn decode_sse_block(block: &str) -> Option<ParsedServeEvent> {
    let mut data_lines: Vec<String> = Vec::new();
    for line in block.split('\n') {
        let trimmed = line.strip_suffix('\r').unwrap_or(line);
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    let data = data_lines.join("\n");
    let value: Value = serde_json::from_str(&data).ok()?;
    parse_serve_event(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> Option<ParsedServeEvent> {
        parse_serve_event(&v)
    }

    #[test]
    fn parses_flat_event_and_resolves_session_id() {
        let ev = parse(json!({
            "type": "session.idle",
            "properties": { "sessionID": "ses_abc" }
        }))
        .expect("event");
        assert_eq!(ev.kind, "session.idle");
        assert_eq!(ev.session_id.as_deref(), Some("ses_abc"));
    }

    #[test]
    fn parses_global_event_wrapped_under_payload() {
        // `/global/event` wraps the flat shape under `payload`.
        let ev = parse(json!({
            "payload": { "type": "session.idle", "properties": { "sessionID": "ses_wrapped" } }
        }))
        .expect("event");
        assert_eq!(ev.kind, "session.idle");
        assert_eq!(ev.session_id.as_deref(), Some("ses_wrapped"));
    }

    #[test]
    fn resolves_session_id_from_part_and_info_fallbacks() {
        let via_part = parse(json!({
            "type": "message.part.updated",
            "properties": { "part": { "sessionID": "ses_part" } }
        }))
        .expect("event");
        assert_eq!(via_part.session_id.as_deref(), Some("ses_part"));

        let via_info = parse(json!({
            "type": "message.updated",
            "properties": { "info": { "sessionID": "ses_info" } }
        }))
        .expect("event");
        assert_eq!(via_info.session_id.as_deref(), Some("ses_info"));
    }

    #[test]
    fn drops_server_control_frames_and_typeless_payloads() {
        assert!(parse(json!({ "type": "server.connected" })).is_none());
        assert!(parse(json!({ "type": "server.heartbeat" })).is_none());
        assert!(parse(json!({ "properties": { "sessionID": "x" } })).is_none());
        assert!(parse(json!(["not", "an", "object"])).is_none());
        assert!(parse(json!("string")).is_none());
    }

    #[test]
    fn idle_edge_detection_covers_both_signals() {
        // session.idle is the direct idle edge.
        let idle =
            parse(json!({ "type": "session.idle", "properties": { "sessionID": "s" } })).unwrap();
        assert!(is_idle_edge(&idle));

        // session.status{type:idle} is the equivalent idle edge.
        let status_idle =
            parse(json!({ "type": "session.status", "properties": { "sessionID": "s", "status": { "type": "idle" } } }))
                .unwrap();
        assert!(is_idle_edge(&status_idle));
        assert!(is_idle_status_event(&status_idle));

        // busy / retry are NOT idle — they show running activity.
        let busy =
            parse(json!({ "type": "session.status", "properties": { "sessionID": "s", "status": { "type": "busy" } } }))
                .unwrap();
        assert!(!is_idle_edge(&busy));
        assert!(event_shows_running_status_activity(&busy));

        let retry =
            parse(json!({ "type": "session.status", "properties": { "sessionID": "s", "status": { "type": "retry" } } }))
                .unwrap();
        assert!(event_shows_running_status_activity(&retry));
        assert!(!is_idle_status_event(&retry));

        // A non-status event is never the idle edge.
        let msg = parse(
            json!({ "type": "message.updated", "properties": { "info": { "sessionID": "s" } } }),
        )
        .unwrap();
        assert!(!is_idle_edge(&msg));
        assert!(!event_shows_running_status_activity(&msg));
    }

    #[test]
    fn status_type_classifiers_match_reference() {
        assert!(is_running_status_type(Some(&json!("busy"))));
        assert!(is_running_status_type(Some(&json!("retry"))));
        assert!(!is_running_status_type(Some(&json!("idle"))));
        assert!(!is_running_status_type(None));
        assert!(is_idle_status_type(Some(&json!("idle"))));
        assert!(!is_idle_status_type(Some(&json!("busy"))));
        assert!(!is_idle_status_type(None));
    }

    #[test]
    fn serve_event_to_sdk_maps_lifecycle() {
        let idle = parse(json!({ "type": "session.idle", "properties": { "sessionID": "real" } }))
            .unwrap();
        assert_eq!(
            serve_event_to_sdk(&idle, "placeholder"),
            Some(SdkProviderEvent::Snapshot {
                session_id: "placeholder".into(),
                status: SnapshotStatus::Idle
            })
        );

        let busy =
            parse(json!({ "type": "session.status", "properties": { "sessionID": "real", "status": { "type": "busy" } } }))
                .unwrap();
        assert_eq!(
            serve_event_to_sdk(&busy, "placeholder"),
            Some(SdkProviderEvent::Snapshot {
                session_id: "placeholder".into(),
                status: SnapshotStatus::Running
            })
        );

        // A status without a mappable type is a generic change (invalidation).
        let other =
            parse(json!({ "type": "session.status", "properties": { "sessionID": "real", "status": { "type": "queued" } } }))
                .unwrap();
        assert_eq!(
            serve_event_to_sdk(&other, "placeholder"),
            Some(SdkProviderEvent::Changed {
                session_id: "placeholder".into(),
                reason: ChangedReason::OpencodeStatus
            })
        );

        let err = parse(json!({ "type": "session.error", "properties": { "sessionID": "real", "error": { "message": "boom" } } }))
            .unwrap();
        assert_eq!(
            serve_event_to_sdk(&err, "placeholder"),
            Some(SdkProviderEvent::Error {
                session_id: "placeholder".into(),
                message: "boom".into()
            })
        );

        // Transcript events are invalidations, not lifecycle.
        let msg = parse(
            json!({ "type": "message.updated", "properties": { "info": { "sessionID": "real" } } }),
        )
        .unwrap();
        assert_eq!(
            serve_event_to_sdk(&msg, "placeholder"),
            Some(SdkProviderEvent::Changed {
                session_id: "placeholder".into(),
                reason: ChangedReason::OpencodeMessage
            })
        );

        // Unknown, non-transcript events map to nothing.
        let unknown =
            parse(json!({ "type": "session.updated", "properties": { "sessionID": "real" } }))
                .unwrap();
        assert_eq!(serve_event_to_sdk(&unknown, "placeholder"), None);
    }

    #[test]
    fn session_error_falls_back_to_default_message() {
        let err = parse(
            json!({ "type": "session.error", "properties": { "sessionID": "real", "error": {} } }),
        )
        .unwrap();
        assert_eq!(
            serve_event_to_sdk(&err, "p"),
            Some(SdkProviderEvent::Error {
                session_id: "p".into(),
                message: "OpenCode session error".into()
            })
        );
    }

    #[test]
    fn sse_decoder_splits_frames_and_skips_comments_and_heartbeats() {
        let mut dec = SseDecoder::new();
        // A comment line, then a real idle frame, then a heartbeat (dropped), then a
        // status-idle frame — all delivered as separate `\n\n`-terminated blocks, with
        // the last block split across two `push_str` calls to exercise buffering.
        let events = dec.push_str(
            ": ping\n\ndata: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ses_1\"}}\n\ndata: {\"type\":\"server.heartbeat\"}\n\ndata: {\"type\":\"session.st",
        );
        assert_eq!(
            events.len(),
            1,
            "only the idle frame completed so far: {events:?}"
        );
        assert_eq!(events[0].kind, "session.idle");
        assert_eq!(events[0].session_id.as_deref(), Some("ses_1"));

        let more = dec.push_str(
            "atus\",\"properties\":{\"sessionID\":\"ses_1\",\"status\":{\"type\":\"idle\"}}}\n\n",
        );
        assert_eq!(more.len(), 1);
        assert!(is_idle_edge(&more[0]));
    }

    #[test]
    fn sse_decoder_normalizes_crlf_and_joins_multiline_data() {
        let mut dec = SseDecoder::new();
        let events = dec.push_str("data: {\"type\":\"session.idle\",\r\ndata: \"properties\":{\"sessionID\":\"ses_x\"}}\r\n\r\n");
        assert_eq!(
            events.len(),
            1,
            "multi-line data joined into one JSON doc: {events:?}"
        );
        assert_eq!(events[0].session_id.as_deref(), Some("ses_x"));
    }

    #[test]
    fn sse_decoder_skips_malformed_frames_without_panicking() {
        let mut dec = SseDecoder::new();
        let events = dec.push_str("data: {not valid json}\n\ndata: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ok\"}}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id.as_deref(), Some("ok"));
    }
}

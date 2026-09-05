//! Auto-resume orchestrator end-to-end (Task 5): real registry, real PTYs,
//! the hub spawned by the harness with a tiny injected backoff schedule.
//!
//! Raw-WS integration against an in-process axum server on an ephemeral
//! loopback port (shared `common` harness convention). The claude CLI command
//! is a plain-`sh` shim (the `auto_resume_respawn.rs` convention): one
//! variant crashes every generation (retry-exhaustion path), one crashes only
//! its FIRST generation (the reconcile-after-replacement pin). A codex-mode
//! crash-once shim (codex preallocates NO identity — the registry starts
//! EMPTY for the created terminal, the mechanism-B precondition) drives the
//! kata-kmbs identity-grace pins.

mod common;

use std::time::Duration;

use common::next_frame_of_type;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// A claude-shaped CLI spec whose command appends one line to `count_file`
/// per invocation (O_APPEND — atomic for single lines), then exits 1: every
/// generation crashes, so the hub burns its full retry budget.
fn counting_crashing_claude_spec(
    count_file: &std::path::Path,
) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-auto-resume-e2e-counting-shim-{}.sh",
        std::process::id()
    ));
    let script = format!(
        "#!/bin/sh\necho x >> \"{count}\"\nexit 1\n",
        count = count_file.display()
    );
    write_executable(&script_path, &script);
    claude_spec(&script_path)
}

/// A claude-shaped CLI spec that crashes ONLY its first invocation (marker
/// file absent), then survives (`exec sleep 30`) — the replacement generation
/// stays live for the reconcile pin.
fn crash_once_claude_spec(marker: &std::path::Path) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-auto-resume-e2e-crash-once-shim-{}.sh",
        std::process::id()
    ));
    let script = format!(
        "#!/bin/sh\nif [ -e \"{marker}\" ]; then exec sleep 30; fi\n: > \"{marker}\"\nexit 1\n",
        marker = marker.display()
    );
    write_executable(&script_path, &script);
    claude_spec(&script_path)
}

fn write_executable(path: &std::path::Path, script: &str) {
    std::fs::write(path, script).expect("write shim script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }
}

fn claude_spec(script_path: &std::path::Path) -> freshell_platform::CliCommandSpec {
    freshell_platform::CliCommandSpec {
        name: "claude".to_string(),
        label: "claude-label".to_string(),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        // The fresh-claude preallocation path THROWS without
        // `create_session_args` (`cli_launch.rs:436-441`).
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Send a fresh claude `terminal.create` and return
/// (old_terminal_id, session_id) from `terminal.created`.
async fn create_claude_terminal(ws: &mut common::TestWs, request_id: &str) -> (String, String) {
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    let old_tid = created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("fresh claude create carries a preallocated sessionRef")
        .to_string();
    (old_tid, session_id)
}

/// One shared rendering of the ignored-frames ring for BOTH
/// `wait_frame_matching` panic arms (delta-review r1): the catch-all arm is
/// the one that actually fires when the peer goes silent — the final
/// `Err(Elapsed)` from `tokio::time::timeout` routes there, NOT to the
/// end-of-loop deadline panic — so a deadline-only dump would be bypassed by
/// exactly the mechanism-B receipt shape it exists to diagnose.
fn format_ignored_frames(ignored: &std::collections::VecDeque<String>) -> String {
    format!("ignored frames (last {}): {ignored:?}", ignored.len())
}

/// Read frames until `pred` matches one (returns it) or the deadline passes.
///
/// DEFLAKE self-diagnosis (the-usual test-flake-hardening, mechanism-B RCA —
/// reports/mechanism-b-rca.md §0/§4): every parsed-but-non-matching Text frame
/// is RECORDED (its `type` plus `tid`/`status`/`code`/`reason`/`attempt`/
/// `sessionRef` when present, last 10 in a ring — the settle-diagnostic field
/// set widened at delta-r2 plan addition #5(a) so every future mechanism-B
/// occurrence self-names its settle tail for the follow-up task, and `tid`
/// added at delta-r6 so the waiver classifier can correlate the settle frame
/// to the crashed terminal) and dumped
/// into BOTH panic arms — the catch-all `other` arm (which
/// fires on the final `Err(Elapsed)` when the peer simply stops sending, the
/// exact mechanism-B receipt shape; delta-review r1) and the end-of-loop
/// deadline panic — because a zero-frame stall receipt could not distinguish
/// "nothing emitted for the whole budget" from "an early
/// `terminal.status{exited}` settle frame was silently discarded, then
/// nothing". The failure (if it recurs) still fails at the same point with
/// the same budget — only the diagnostic is complete
/// (self-diagnosing-flake idiom, 884fc8721). Loop logic and budgets are
/// unchanged.
async fn wait_frame_matching(
    ws: &mut common::TestWs,
    what: &str,
    deadline: tokio::time::Instant,
    mut pred: impl FnMut(&serde_json::Value) -> bool,
) -> serde_json::Value {
    // Ring of the last 10 ignored frames: parsed Text frames that failed
    // `pred`, summarized as `type=<v>` plus `tid=<v>`/`oldTid=<v>`/
    // `newTid=<v>`/`status=<v>`/`code=<v>`/`reason=<v>`/`attempt=<v>`/
    // `sessionRef=<v>` when the frame carries
    // those fields (the wire TerminalStatus settle/recovering shapes carry
    // `reason`/`attempt`; error frames carry `code`; `terminal.replaced`
    // carries `oldTerminalId`/`newTerminalId`, rendered as oldTid/newTid —
    // delta-r7, the waiver classifier's same-terminal replacement guard).
    // `tid` (delta-review r6):
    // the mechanism-B waiver classifier
    // (scripts/classify-resume-waiver.ts) must correlate a settle frame to
    // its terminal — without `terminalId` the ring cannot distinguish the
    // crashed terminal's settle tail from an unrelated terminal's frames.
    let mut ignored: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return value;
                    }
                    let mut summary = format!("type={}", value["type"]);
                    if let Some(tid) = value.get("terminalId") {
                        summary.push_str(&format!(" tid={tid}"));
                    }
                    // delta-r7: `terminal.replaced` frames carry neither
                    // `terminalId` nor `status` — their identifiers are
                    // `oldTerminalId`/`newTerminalId` (server_messages.rs
                    // TerminalReplaced). Without these, the waiver classifier
                    // could never correlate an arrived replacement to the
                    // settled terminal and the "no recovery" half of the
                    // mechanism-B signature was unenforceable.
                    if let Some(old_tid) = value.get("oldTerminalId") {
                        summary.push_str(&format!(" oldTid={old_tid}"));
                    }
                    if let Some(new_tid) = value.get("newTerminalId") {
                        summary.push_str(&format!(" newTid={new_tid}"));
                    }
                    if let Some(status) = value.get("status") {
                        summary.push_str(&format!(" status={status}"));
                    }
                    if let Some(code) = value.get("code") {
                        summary.push_str(&format!(" code={code}"));
                    }
                    // delta-r2 #5(a): the settle-diagnostic fields — a
                    // mechanism-B settle tail carries `reason` (real settle
                    // frames set it, auto_resume.rs's broadcast_settled_frame)
                    // and recovering frames carry `attempt`.
                    if let Some(reason) = value.get("reason") {
                        summary.push_str(&format!(" reason={reason}"));
                    }
                    if let Some(attempt) = value.get("attempt") {
                        summary.push_str(&format!(" attempt={attempt}"));
                    }
                    if let Some(session_ref) = value.get("sessionRef") {
                        summary.push_str(&format!(" sessionRef={session_ref}"));
                    }
                    if ignored.len() == 10 {
                        ignored.pop_front();
                    }
                    ignored.push_back(summary);
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!(
                "stream ended while waiting for {what}: {other:?}; {}",
                format_ignored_frames(&ignored)
            ),
        }
    }
    panic!(
        "{what} never arrived before the deadline; {}",
        format_ignored_frames(&ignored)
    );
}

fn spawn_count(count_file: &std::path::Path) -> usize {
    std::fs::read_to_string(count_file)
        .map(|s| s.lines().count())
        .unwrap_or(0)
}

/// (a) 3 spawns (1 + 2 retries), (b) `terminal.status{recovering, attempt:1}`
/// and `terminal.replaced{attempt:1}` observed on a subscribed ws client,
/// (c) the newest terminal for the createRequestId settles `exited` and no
/// further spawns occur for 500ms.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crashing_agent_is_resumed_twice_then_settles_exited() {
    let count_file = std::env::temp_dir().join(format!(
        "freshell-auto-resume-e2e-count-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&count_file);
    let (url, registry) = common::spawn_server_with_specs_and_auto_resume_hub(
        vec![counting_crashing_claude_spec(&count_file)],
        vec![50, 100],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-crashy";
    let (old_tid, _session_id) = create_claude_terminal(&mut ws, create_request_id).await;

    // (b) The broadcast recovery frames, in order: recovering attempt 1 for
    // the crashed terminal, then replaced attempt 1 naming its successor.
    // DEFLAKE: FRAME_BUDGET (30s) replaces the old 10s frame budget, with one
    // FRESH deadline per wait_frame_matching stage (per-stage budget) — a
    // single Instant shared by the recovering+replaced stages could expire
    // after the recovering stage consumed most of it under extreme scheduling
    // lag (certification run 9 of task2-certify.log, 2026-09-02). Assertions
    // unchanged (see the constant's doc comment).
    let recovering = wait_frame_matching(
        &mut ws,
        "terminal.status{recovering}",
        tokio::time::Instant::now() + common::FRAME_BUDGET,
        |v| v["type"] == "terminal.status" && v["status"] == "recovering",
    )
    .await;
    assert_eq!(recovering["terminalId"], serde_json::json!(old_tid));
    assert_eq!(recovering["attempt"], serde_json::json!(1));
    // Council 7w4h/xkhx: the client renders from these typed FIELDS — the
    // reason prose below is purely presentational.
    assert_eq!(recovering["maxAttempts"], serde_json::json!(2));
    assert_eq!(recovering["exitCode"], serde_json::json!(1));
    let reason = recovering["reason"].as_str().expect("reason string");
    assert!(
        reason.contains("claude crashed") && reason.contains("attempt 1/2"),
        "unexpected reason: {reason}"
    );
    let replaced = wait_frame_matching(
        &mut ws,
        "terminal.replaced",
        tokio::time::Instant::now() + common::FRAME_BUDGET,
        |v| v["type"] == "terminal.replaced",
    )
    .await;
    assert_eq!(replaced["oldTerminalId"], serde_json::json!(old_tid));
    assert_eq!(replaced["attempt"], serde_json::json!(1));
    assert_eq!(replaced["maxAttempts"], serde_json::json!(2));
    let first_replacement = replaced["newTerminalId"]
        .as_str()
        .expect("newTerminalId")
        .to_string();
    assert_ne!(first_replacement, old_tid);

    // (a) 3 spawns total: the original + 2 retries.
    // DEFLAKE: FRAME_BUDGET (30s) replaces the old 5s poll deadline; the 25ms
    // interval paces (unchanged) — see the constant's doc comment.
    let deadline = std::time::Instant::now() + common::FRAME_BUDGET;
    while spawn_count(&count_file) < 3 {
        assert!(
            std::time::Instant::now() < deadline,
            "expected 3 spawns, saw {} before the deadline",
            spawn_count(&count_file)
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(spawn_count(&count_file), 3);

    // (c) The newest generation for the createRequestId settles exited...
    // DEFLAKE: FRAME_BUDGET (30s) replaces the old 5s poll deadline; the 25ms
    // interval paces (unchanged) — see the constant's doc comment.
    let deadline = std::time::Instant::now() + common::FRAME_BUDGET;
    loop {
        let newest = registry
            .newest_by_create_request_id(create_request_id)
            .expect("a generation exists for the createRequestId");
        let status = registry.probe(&newest).expect("newest row remains").status;
        if status == freshell_protocol::TerminalRunStatus::Exited {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "newest generation never settled exited"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // ...and the budget is spent: no further spawns for 500ms.
    // DEFLAKE-keep (the-usual test-flake-hardening): this negative window
    // stays at 500ms — a late respawn under load only makes the window MORE
    // likely to catch it (load-SAFE direction), so there is no false-fail
    // pressure to widen (2026-09 host-pressure-pane receipts).
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        spawn_count(&count_file),
        3,
        "settled terminal must not respawn again"
    );
}

/// MANDATORY reconcile-after-replacement pin (D-2): after the hub replaces a
/// crashed generation, a SECOND ws client reconciling the OLD terminalId (+
/// the pane's sessionRef + createRequestId) receives an attach verdict naming
/// the NEW live terminal, with `corrected` absent (same-session replacement
/// never overrides the claim, reconcile.rs `corrected_flag`).
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn reconcile_after_replacement_attaches_to_the_new_terminal() {
    let marker = std::env::temp_dir().join(format!(
        "freshell-auto-resume-e2e-crash-once-marker-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let (url, registry) = common::spawn_server_with_specs_and_auto_resume_hub(
        vec![crash_once_claude_spec(&marker)],
        vec![50, 100],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-crash-once";
    let (old_tid, session_id) = create_claude_terminal(&mut ws, create_request_id).await;

    // DEFLAKE: FRAME_BUDGET (30s) replaces the old 10s frame budget as a
    // per-stage budget (this wait gets its own fresh deadline — see the
    // per-stage note in crashing_agent_is_resumed_twice_then_settles_exited);
    // assertions unchanged (see the constant's doc comment).
    let replaced = wait_frame_matching(
        &mut ws,
        "terminal.replaced",
        tokio::time::Instant::now() + common::FRAME_BUDGET,
        |v| v["type"] == "terminal.replaced",
    )
    .await;
    assert_eq!(replaced["oldTerminalId"], serde_json::json!(old_tid));
    let new_tid = replaced["newTerminalId"]
        .as_str()
        .expect("newTerminalId")
        .to_string();

    // A SECOND client (paneReconcileV1 negotiated) presents the pane's
    // pre-crash view: the OLD terminalId + sessionRef + createRequestId.
    let (mut ws2, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws2 connect");
    ws2.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": common::AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": { "paneReconcileV1": true },
        })
        .to_string(),
    ))
    .await
    .expect("send hello");
    // Drain the 4-frame handshake (ready → settings.updated → perf.logging →
    // terminal.inventory) before issuing the reconcile.
    let _ = next_frame_of_type(&mut ws2, "terminal.inventory").await;
    ws2.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "rec-after-replacement",
            "panes": [{
                "paneKey": "pk-replaced",
                "kind": "terminal",
                "mode": "claude",
                "terminalId": old_tid,
                "createRequestId": create_request_id,
                "sessionRef": { "provider": "claude", "sessionId": session_id },
            }],
        })
        .to_string(),
    ))
    .await
    .expect("send pane.reconcile.request");

    let result = next_frame_of_type(&mut ws2, "pane.reconcile.result").await;
    let verdicts = result["verdicts"].as_array().expect("verdicts array");
    assert_eq!(verdicts.len(), 1);
    assert_eq!(verdicts[0]["verdict"], "attach");
    assert_eq!(
        verdicts[0]["terminalId"],
        serde_json::json!(new_tid),
        "reconcile must point the pane at the REPLACEMENT terminal"
    );
    assert!(
        verdicts[0].get("corrected").is_none_or(|v| v.is_null()),
        "same-session replacement must not set corrected: {:?}",
        verdicts[0]
    );

    // Cleanup: reap the surviving replacement PTY.
    registry.kill(&new_tid);
}

// ── Task 2 (kata kmbs): identity-grace e2e pins over the real WS surface ──

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

/// Captured tracing event for the grace-entry proof
/// (pane_ledger_tests.rs shape): the event's OWN message + fields — the hub
/// records `terminal_id` ON the event (auto_resume.rs
/// `identity_grace_entered`), so no span merge is needed.
#[derive(Debug, Clone, Default)]
pub struct CapturedEvent {
    pub message: String,
    pub fields: BTreeMap<String, String>,
}

#[derive(Default)]
struct CapVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl Visit for CapVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = rendered;
        } else {
            self.fields.insert(field.name().to_string(), rendered);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }
}

struct CaptureLayer {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl<S> Layer<S> for CaptureLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CapVisitor::default();
        event.record(&mut visitor);
        self.events
            .lock()
            .expect("capture lock")
            .push(CapturedEvent {
                message: visitor.message,
                fields: visitor.fields,
            });
    }
}

/// Process-global capture for the grace-entry proof — the hub task runs on
/// tokio workers, where a thread-local default dispatcher is blind (kata
/// e08g's cross-thread miss). Same OnceLock-install semantics as
/// diag01_lifecycle_events.rs:163-184: first caller installs; every event in
/// the binary lands in the shared vec, so reads MUST filter by the
/// freshly-minted terminal id (captured start-index + tid field). This
/// binary installs no other global subscriber; a future second installer
/// panics loudly instead of silently capturing nothing.
static GRACE_EVENTS: std::sync::OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> =
    std::sync::OnceLock::new();

fn grace_event_capture() -> (Arc<Mutex<Vec<CapturedEvent>>>, usize) {
    let events = GRACE_EVENTS
        .get_or_init(|| {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            tracing::subscriber::set_global_default(subscriber)
                .expect("this test binary installs exactly one global subscriber");
            events
        })
        .clone();
    let start_index = events.lock().expect("capture lock").len();
    (events, start_index)
}

/// Codex-mode crash-once shim — caller passes a PER-TEST marker path (tests
/// in one binary share std::process::id()). Protocol: absent marker -> touch
/// marker, sleep 1200ms, exit 1 (the sleep window lets the test synchronize
/// its upsert INSIDE the grace reliably); marker present -> `exec sleep 30`
/// (the respawned generation survives). No `create_session_args`: codex has
/// no preallocation, so the identity registry starts EMPTY for the created
/// terminal (mechanism-B precondition). resume_args follow
/// codex_session_ref_resume.rs's codex_cli_spec shape
/// (["resume", "{{sessionId}}"]).
fn crash_once_codex_spec(marker: &std::path::Path) -> freshell_platform::CliCommandSpec {
    // The SCRIPT path is per-test too (derived from the marker name): two
    // tests in one binary share std::process::id(), and a shared script
    // would pin BOTH servers' terminals to whichever marker lost the write
    // race (cross-test marker mixup — a generation meant to crash takes the
    // survivor branch, or vice versa).
    let marker_tag = marker
        .file_name()
        .and_then(|n| n.to_str())
        .expect("marker path has a utf-8 file name");
    let script_path = std::env::temp_dir().join(format!(
        "freshell-auto-resume-e2e-grace-codex-shim-{marker_tag}-{}.sh",
        std::process::id()
    ));
    let script = format!(
        "#!/bin/sh\nif [ -e \"{marker}\" ]; then exec sleep 30; fi\n: > \"{marker}\"\nsleep 1.2\nexit 1\n",
        marker = marker.display()
    );
    write_executable(&script_path, &script);
    freshell_platform::CliCommandSpec {
        name: "codex".to_string(),
        label: "Codex CLI".to_string(),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["resume".to_string(), "{{sessionId}}".to_string()]),
        // Codex has NO preallocation path — `create_session_args` stays None,
        // the shipped-spec shape.
        create_session_args: None,
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Fresh codex `terminal.create` — like `create_claude_terminal` but codex
/// carries NO preallocated sessionRef; only the terminalId is returned.
async fn create_codex_terminal(ws: &mut common::TestWs, request_id: &str) -> String {
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Wait for the replaced frame for `old_tid` while enforcing the in-flight
/// contract: ANY terminal.status{exited} naming old_tid fails the test with
/// the offending frame quoted, and the replaced frame is only accepted after
/// a recovering frame for old_tid has been seen (both frames carry
/// terminalId per terminal.rs emit_recovering/broadcast_settled_frame).
/// Returns the replaced frame. Never discards silently: every consumed frame
/// is either matched, asserted-against, or the deadline expires with the
/// same ring-style dump idiom this file already uses (duplicated here — the
/// kmbs pins keep `wait_frame_matching` itself byte-equivalent).
async fn wait_recovered_or_fail_on_exited(
    ws: &mut common::TestWs,
    old_tid: &str,
    deadline: tokio::time::Instant,
) -> serde_json::Value {
    let mut recovering_seen = false;
    let mut ignored: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.status"
                        && value["status"] == "exited"
                        && value["terminalId"] == old_tid
                    {
                        panic!(
                            "terminal.status{{exited}} arrived for {old_tid} while waiting for its replacement: {value}"
                        );
                    }
                    if value["type"] == "terminal.status"
                        && value["status"] == "recovering"
                        && value["terminalId"] == old_tid
                    {
                        recovering_seen = true;
                        continue;
                    }
                    if value["type"] == "terminal.replaced" && value["oldTerminalId"] == old_tid {
                        assert!(
                            recovering_seen,
                            "terminal.replaced for {old_tid} arrived before any recovering frame: {value}"
                        );
                        return value;
                    }
                    // Same summary shape as `wait_frame_matching`'s ring.
                    let mut summary = format!("type={}", value["type"]);
                    if let Some(tid) = value.get("terminalId") {
                        summary.push_str(&format!(" tid={tid}"));
                    }
                    if let Some(old_tid) = value.get("oldTerminalId") {
                        summary.push_str(&format!(" oldTid={old_tid}"));
                    }
                    if let Some(new_tid) = value.get("newTerminalId") {
                        summary.push_str(&format!(" newTid={new_tid}"));
                    }
                    if let Some(status) = value.get("status") {
                        summary.push_str(&format!(" status={status}"));
                    }
                    if let Some(code) = value.get("code") {
                        summary.push_str(&format!(" code={code}"));
                    }
                    if let Some(reason) = value.get("reason") {
                        summary.push_str(&format!(" reason={reason}"));
                    }
                    if let Some(attempt) = value.get("attempt") {
                        summary.push_str(&format!(" attempt={attempt}"));
                    }
                    if let Some(session_ref) = value.get("sessionRef") {
                        summary.push_str(&format!(" sessionRef={session_ref}"));
                    }
                    if ignored.len() == 10 {
                        ignored.pop_front();
                    }
                    ignored.push_back(summary);
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!(
                "stream ended while waiting for terminal.replaced(old:{old_tid}): {other:?}; {}",
                format_ignored_frames(&ignored)
            ),
        }
    }
    panic!(
        "terminal.replaced(old:{old_tid}) never arrived before the deadline; {}",
        format_ignored_frames(&ignored)
    );
}

/// Explicit negative assertion: read frames for `dur`; FAIL with the frame
/// quoted if any terminal.status{exited} names `tid`. Consumes and inspects
/// every frame in the window — this is not a silent sleep.
async fn assert_no_exited_settle_for(ws: &mut common::TestWs, tid: &str, dur: Duration) {
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return;
        }
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.status"
                        && value["status"] == "exited"
                        && value["terminalId"] == tid
                    {
                        panic!(
                            "terminal.status{{exited}} for {tid} inside the {dur:?} negative window: {value}"
                        );
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(err))) => panic!("ws error inside the negative window: {err:?}"),
            Ok(None) => panic!("stream ended inside the negative window"),
            Err(_) => return, // the window elapsed with no offending frame
        }
    }
}

/// Local millisecond clock (mirror of resume_validation_gate.rs:79);
/// freshell_ws::terminal::now_ms is pub(crate), unreachable from tests.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("wall clock")
        .as_millis() as i64
}

/// Mechanism-B regression pin (kata kmbs): identity landing DURING the grace
/// converts the no_resumable_identity settle into a normal resume.
/// Synchronization: the shim touches its marker then sleeps 1.2s before
/// exiting; the test polls the marker, then upserts 250ms after the shim's
/// own exit instant — comfortably inside the 2s-first grace step, with the
/// grace-entry log assertion proving (never silently vacating) engagement.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crash_with_identity_arriving_during_grace_is_resumed() {
    // Plain-CLI codex, not the managed app-server launch (default-on; opt-out
    // is exactly "0", terminal.rs:1706-1808 — read per create, so a
    // same-binary set_var is safe; precedent codex_session_ref_resume.rs:350).
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let marker = std::env::temp_dir().join(format!(
        "freshell-e2e-grace-resume-marker-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker); // stale-marker absorb (PID reuse)
    let (events, capture_start) = grace_event_capture();
    let (url, _registry, state) = common::spawn_server_with_specs_hub_and_state(
        vec![crash_once_codex_spec(&marker)],
        vec![50, 100],
        vec![2_000, 2_000],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-grace-resume";
    let old_tid = create_codex_terminal(&mut ws, create_request_id).await;

    // Poll for the shim marker (crash imminent), then upsert INSIDE the
    // grace: query#1 happens at the shim's exit (~marker+1.2s); the upsert
    // lands at ~marker+1.45s — inside the first 2s grace step with ~1.75s of
    // headroom both directions against ordinary load skew.
    let marker_seen = {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "shim marker never appeared"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        tokio::time::Instant::now()
    };
    tokio::time::sleep_until(marker_seen + Duration::from_millis(1_200) + Duration::from_millis(250))
        .await;
    // NoIndexProbe::default() -> Unknown for codex -> respawn gate fails open
    // (resume_validation passthrough), so this fabricated thread id is
    // sufficient — the same authority the locator-adoption path upserts.
    state.identity.upsert(&old_tid, Some("codex"), Some("thread-grace-1"), None, now_ms());

    // Engagement proof (the anti-vacuity gate): the hub logged grace entry
    // for THIS terminal. A pathological stall that let the upsert beat
    // query#1 makes THIS assertion fail loudly — never a silent green.
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let found = {
                let evs = events.lock().expect("capture lock");
                evs[capture_start..].iter().any(|e| {
                    e.message.contains("identity_grace_entered")
                        && e.fields
                            .get("terminal_id")
                            .map(|v| v.contains(old_tid.as_str()))
                            .unwrap_or(false)
                })
            };
            if found {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "grace-entry log never captured for {old_tid}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    wait_recovered_or_fail_on_exited(
        &mut ws,
        &old_tid,
        tokio::time::Instant::now() + common::FRAME_BUDGET,
    )
    .await;
    assert_no_exited_settle_for(&mut ws, &old_tid, Duration::from_millis(500)).await;
}

/// Grace exhaustion: identity never resolves — the SAME loud settle frame as
/// pre-grace behavior, bounded-late. The pre-boundary negative window fails
/// RED if the fix regresses to an immediate settle.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crash_with_identity_never_arriving_settles_exited_after_grace() {
    // Plain-CLI codex (see the grace-success test; the same-binary "0" set is
    // idempotent).
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let marker = std::env::temp_dir().join(format!(
        "freshell-e2e-grace-exhaust-marker-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let (url, _registry, _state) = common::spawn_server_with_specs_hub_and_state(
        vec![crash_once_codex_spec(&marker)],
        vec![50, 100],
        vec![2_000, 2_000],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-grace-exhaust";
    let old_tid = create_codex_terminal(&mut ws, create_request_id).await;

    // Pre-boundary negative: with a 2s+2s grace and the shim's 1.2s exit
    // sleep, no legal settle can exist inside the first 2s after create. An
    // immediate-settle regression is caught here, not just "eventually".
    assert_no_exited_settle_for(&mut ws, &old_tid, Duration::from_millis(2_000)).await;

    wait_frame_matching(
        &mut ws,
        "terminal.status{status:exited, reason:no_resumable_identity}",
        tokio::time::Instant::now() + common::FRAME_BUDGET,
        |v| {
            v["type"] == "terminal.status"
                && v["status"] == "exited"
                && v["reason"] == "no_resumable_identity"
                && v["terminalId"] == old_tid
        },
    )
    .await;
}

/// Loopback WS harness for the `wait_frame_matching` panic-path pins
/// (delta-review r1): binds an ephemeral loopback port, spawns a task that
/// accepts ONE connection and runs `serve` on the server half, and returns
/// the client half as a `common::TestWs` (the exact type
/// `connect_async`-based harness helpers use), so the pins exercise the
/// real helper signature. `serve` must HOLD the server socket open (move it
/// into its future) when it wants the client to read a deadline — dropping
/// it would end the stream and take the wrong panic arm.
async fn loopback_test_ws<S, F>(serve: S) -> common::TestWs
where
    S: FnOnce(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> F + Send + 'static,
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept loopback client");
        let server_ws = tokio_tungstenite::accept_async(stream)
            .await
            .expect("accept ws handshake");
        serve(server_ws).await;
    });
    let (ws, _resp) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("loopback client connect");
    ws
}

/// Delta-review r1 pin: the silent-peer failure (mechanism B's receipt
/// shape — the final `Err(Elapsed)` routing through the catch-all arm, NOT
/// the deadline panic) must still carry the ignored-frames ring, even when
/// that ring is empty. The peer holds the socket open and sends NOTHING, so
/// the client's read can only resolve as `Err(Elapsed)`.
#[tokio::test]
#[should_panic(expected = "ignored frames")]
async fn wait_frame_matching_silent_peer_panic_carries_the_ignored_ring() {
    let mut ws = loopback_test_ws(|server_ws| async move {
        // Silent peer: the socket must stay OPEN for the whole read (a drop
        // would end the stream and take the wrong panic arm). The trailing
        // use-after-await pins the socket into the future's state so it is
        // NOT dropped at the last-use point before the never-resolving
        // await.
        std::future::pending::<()>().await;
        drop(server_ws);
    })
    .await;
    let _ = wait_frame_matching(
        &mut ws,
        "a frame the silent loopback peer never sends",
        tokio::time::Instant::now() + Duration::from_millis(100),
        |_| false,
    )
    .await;
}

/// Delta-review r1 pin: with unrelated frames recorded in the ring, the
/// elapsed-path panic NAMES them — the diagnostic the mechanism-B receipts
/// were missing. The peer sends two frames that can never match the
/// predicate, then goes silent with the socket held open. The second frame
/// carries a real settle-frame `reason` (auto_resume.rs's
/// broadcast_settled_frame always sets one), pinning the delta-r2 #5(a) ring
/// enrichment on the mechanism-B-relevant field.
#[tokio::test]
#[should_panic(
    expected = "ignored frames (last 2): [\"type=\\\"sessions.updated\\\"\", \"type=\\\"terminal.status\\\" tid=\\\"t-unrelated\\\" status=\\\"exited\\\" reason=\\\"clean_exit\\\"\"]"
)]
async fn wait_frame_matching_unrelated_frames_panic_names_the_ring() {
    let mut ws = loopback_test_ws(|mut server_ws| async move {
        for frame in [
            serde_json::json!({ "type": "sessions.updated", "sessions": [] }),
            serde_json::json!({
                "type": "terminal.status",
                "terminalId": "t-unrelated",
                "status": "exited",
                "reason": "clean_exit",
            }),
        ] {
            server_ws
                .send(WsMessage::Text(frame.to_string()))
                .await
                .expect("send unrelated frame");
        }
        // Then go silent with the socket held OPEN (trailing use-after-await
        // keeps it in the future's state), so the client's next read takes
        // the `Err(Elapsed)` arm against a populated ring.
        std::future::pending::<()>().await;
        drop(server_ws);
    })
    .await;
    let _ = wait_frame_matching(
        &mut ws,
        "terminal.replaced (never sent by the loopback peer)",
        tokio::time::Instant::now() + Duration::from_millis(100),
        |v| v["type"] == "terminal.replaced",
    )
    .await;
}

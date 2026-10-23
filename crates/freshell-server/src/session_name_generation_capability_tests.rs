//! Name-reliability Task 6: capability and quota failures pause AI naming
//! without using up a session's attempts or losing its naming input; real
//! failures still exhaust, now in the fold; the route and pause logs say
//! what happened once, without secrets or URLs; a key saved in Settings
//! takes over at once. Everything drives the REAL temp-file store and the
//! real worker; transports are scripted fakes or the real HTTP transport
//! against loopback fixtures.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use freshell_protocol::session_names::{NameSource, NamedProvider, SessionNameRef};
use serde_json::Value;
use tower::ServiceExt;

use super::tests::{
    arm_with_message, document_json, ensure_pending, generation_consumed, generation_entry,
    generation_status, get_one, open_store, pending, settings_for, temp_data_dir, NoRouteNative,
};
use super::{GenerationOutcome, SessionNameGenerator};
use crate::ai_title::{AiKeyCell, GeminiSessionNameAuth};
use crate::gemini_failure::{classify_gemini_failure, GeminiFailure};
use crate::session_name_capability::tests::{
    session_name_http, start_fake_gemini, start_fake_proxy, ProxyMode, ScriptedTransport,
};
use crate::session_name_capability::{LatchWindows, PauseKind, SessionNameTransport};
use crate::session_name_native::SessionNameWorker;
use crate::session_names::{
    clear_test_hooks, set_test_hooks, SessionNames, TestHook, GENERATION_RETRY_1_MS,
    GENERATION_RETRY_2_MS, MAX_GENERATION_STARTS,
};
use crate::test_trace_capture::{scoped_trace_capture, CapturedTraceEvent};

const GENERATION_TARGET: &str = "freshell_server::session_name_generation";
const GEMINI_URL: &str = "http://generativelanguage.googleapis.com/v1beta";

fn capability(code: &str) -> GeminiFailure {
    classify_gemini_failure(403, format!(r#"{{"error":"{code}"}}"#).as_bytes())
}

fn throttled() -> GeminiFailure {
    classify_gemini_failure(429, b"")
}

fn windows(capability_ms: u64, throttle_ms: u64) -> LatchWindows {
    LatchWindows {
        capability: Duration::from_millis(capability_ms),
        throttle_base: Duration::from_millis(throttle_ms),
    }
}

fn keyed_auth(key: &str) -> GeminiSessionNameAuth {
    GeminiSessionNameAuth::direct_for_test(AiKeyCell::init(Some(key.to_string()), None))
}

fn generator(
    dir: &std::path::Path,
    auth: GeminiSessionNameAuth,
    transport: Arc<dyn SessionNameTransport>,
    latch: LatchWindows,
) -> Arc<SessionNameGenerator> {
    Arc::new(
        SessionNameGenerator::new(settings_for(dir), auth, transport).with_latch_windows(latch),
    )
}

fn excerpt_of(doc: &Value, target: &SessionNameRef) -> Value {
    generation_entry(doc, target)
        .and_then(|entry| entry.get("excerpt"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn attempt_ids_of(doc: &Value, target: &SessionNameRef) -> Vec<String> {
    generation_entry(doc, target)
        .and_then(|entry| entry.get("attemptIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn attempt_starts_len(doc: &Value, target: &SessionNameRef) -> usize {
    generation_entry(doc, target)
        .and_then(|entry| entry.get("attemptStarts"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

async fn armed_target(store: &Arc<SessionNames>, handle: &str, message: &str) -> SessionNameRef {
    let target = pending(handle);
    ensure_pending(store, handle, NamedProvider::Claude, Some("/w/capability"))
        .await
        .expect("ensure");
    arm_with_message(store, target.clone(), "freshclaude", message).await;
    target
}

/// Claim and fail `count` starts (each fold consumes), advancing the store's
/// decision clock past each retry delay.
async fn consume_failed_starts(
    store: &Arc<SessionNames>,
    dir: &std::path::Path,
    target: &SessionNameRef,
    count: u32,
) -> Option<String> {
    let mut offset = 0;
    let mut excerpt = None;
    set_test_hooks(dir, vec![TestHook::ClockOffsetMs(0)]);
    for attempt in 1..=count {
        let claim = store
            .claim_generation_start(target.clone(), format!("attempt-failed-{attempt}"))
            .await
            .expect("claim runs")
            .expect("the series is claimable");
        excerpt = claim.excerpt.clone();
        store
            .fold_generation_outcome(
                target.clone(),
                claim.series_id,
                claim.input_fingerprint,
                GenerationOutcome::Failed(format!("scripted failure {attempt}")),
            )
            .await
            .expect("the failure folds");
        offset += match attempt {
            1 => GENERATION_RETRY_1_MS,
            _ => GENERATION_RETRY_2_MS,
        };
        set_test_hooks(dir, vec![TestHook::ClockOffsetMs(offset)]);
    }
    excerpt
}

// ---------------------------------------------------------------------------
// The fold: refunds and fold-side exhaustion
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capability_failure_refunds_the_attempt() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-refund", "Refund the sardine attempt").await;
    let armed = document_json(dir.path());
    let armed_excerpt = excerpt_of(&armed, &target);
    assert!(!armed_excerpt.is_null(), "the armed series holds its input");

    let claim = store
        .claim_generation_start(target.clone(), "attempt-refund".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");
    assert_eq!(claim.consumed, 1);
    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::CapabilityUnavailable {
                attempt_id: "attempt-refund".to_string(),
            },
        )
        .await
        .expect("the refund folds");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        0,
        "the start is refunded"
    );
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible")
    );
    assert_eq!(
        excerpt_of(&doc, &target),
        armed_excerpt,
        "the input is kept"
    );
    assert!(
        attempt_ids_of(&doc, &target).is_empty(),
        "the attempt id is removed"
    );
    assert_eq!(
        attempt_starts_len(&doc, &target),
        0,
        "the start time is removed"
    );

    // A quota answer refunds the same way.
    let claim = store
        .claim_generation_start(target.clone(), "attempt-throttled".to_string())
        .await
        .expect("claim runs")
        .expect("a refunded series is claimable again");
    assert_eq!(claim.consumed, 1);
    assert_eq!(claim.excerpt.as_deref(), armed_excerpt.as_str());
    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id,
            claim.input_fingerprint,
            GenerationOutcome::Throttled {
                attempt_id: "attempt-throttled".to_string(),
            },
        )
        .await
        .expect("the refund folds");
    let doc = document_json(dir.path());
    assert_eq!(generation_consumed(&doc, &target), 0);
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible")
    );
    assert_eq!(excerpt_of(&doc, &target), armed_excerpt);
}

#[tokio::test]
async fn third_attempt_capability_failure_keeps_the_series_and_its_excerpt() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-third-capability", "Keep the third attempt").await;
    let armed_excerpt = consume_failed_starts(&store, dir.path(), &target, 2).await;
    assert!(armed_excerpt.is_some());

    let claim = store
        .claim_generation_start(target.clone(), "attempt-third".to_string())
        .await
        .expect("claim runs")
        .expect("the third start is claimable");
    assert_eq!(claim.consumed, MAX_GENERATION_STARTS);
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("inFlight"),
        "the claim never exhausts: the fold decides"
    );
    assert_eq!(
        excerpt_of(&doc, &target).as_str(),
        armed_excerpt.as_deref(),
        "the claim keeps the input"
    );

    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id,
            claim.input_fingerprint,
            GenerationOutcome::CapabilityUnavailable {
                attempt_id: "attempt-third".to_string(),
            },
        )
        .await
        .expect("the refund folds");
    let doc = document_json(dir.path());
    assert_eq!(generation_consumed(&doc, &target), 2);
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible")
    );
    assert_eq!(excerpt_of(&doc, &target).as_str(), armed_excerpt.as_deref());

    let next = store
        .claim_generation_start(target.clone(), "attempt-third-again".to_string())
        .await
        .expect("claim runs")
        .expect("the refunded third start is claimable again");
    assert_eq!(
        next.excerpt, armed_excerpt,
        "the next claim sends the same input"
    );
    assert_eq!(next.consumed, MAX_GENERATION_STARTS);
    clear_test_hooks(dir.path());
}

#[tokio::test]
async fn third_attempt_real_failure_exhausts_in_the_fold() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-third-failed", "Exhaust in the fold").await;
    consume_failed_starts(&store, dir.path(), &target, 2).await;
    let claim = store
        .claim_generation_start(target.clone(), "attempt-third".to_string())
        .await
        .expect("claim runs")
        .expect("the third start is claimable");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("inFlight")
    );
    assert!(!excerpt_of(&doc, &target).is_null());

    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id,
            claim.input_fingerprint,
            GenerationOutcome::Failed("gemini http 500 Internal Server Error".to_string()),
        )
        .await
        .expect("the failure folds");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("exhausted")
    );
    assert_eq!(
        generation_consumed(&doc, &target),
        u64::from(MAX_GENERATION_STARTS)
    );
    assert!(
        excerpt_of(&doc, &target).is_null(),
        "exhaustion clears the input"
    );
    assert!(
        generation_entry(&doc, &target)
            .and_then(|entry| entry.get("exhaustedAt"))
            .is_some_and(Value::is_i64),
        "the exhaustion time is recorded"
    );
    let beyond = store
        .claim_generation_start(target.clone(), "attempt-beyond".to_string())
        .await
        .expect("claim runs");
    assert!(beyond.is_none());
    clear_test_hooks(dir.path());
}

/// Pinning test: a crash mid-attempt at the cap still ends exhausted.
#[tokio::test]
async fn interrupted_start_at_the_cap_still_exhausts_at_recovery() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-third-interrupted", "Interrupted at the cap").await;
    consume_failed_starts(&store, dir.path(), &target, 2).await;
    store
        .claim_generation_start(target.clone(), "attempt-interrupted".to_string())
        .await
        .expect("claim runs")
        .expect("the third start is claimable");
    // Restart: the start was persisted, never folded.
    let store = open_store(dir.path());
    store
        .recover_interrupted_generation()
        .await
        .expect("recovery runs");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("exhausted")
    );
    assert!(excerpt_of(&doc, &target).is_null());
    assert_eq!(store.interrupted_generation_count(), 0);
    let beyond = store
        .claim_generation_start(target.clone(), "attempt-beyond".to_string())
        .await
        .expect("claim runs");
    assert!(beyond.is_none(), "an exhausted series is never claimable");
    clear_test_hooks(dir.path());
}

// ---------------------------------------------------------------------------
// The worker under a pause
// ---------------------------------------------------------------------------

async fn wait_for(deadline: Duration, what: &str, mut done: impl FnMut() -> bool) {
    let until = tokio::time::Instant::now() + deadline;
    while !done() {
        assert!(tokio::time::Instant::now() < until, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn gaps(transport: &ScriptedTransport) -> Vec<Duration> {
    let times = transport.call_times.lock().unwrap().clone();
    times.windows(2).map(|pair| pair[1] - pair[0]).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn latched_capability_pauses_without_claims() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-latched", "Paused by the gateway").await;
    let transport = ScriptedTransport::new(vec![Err(capability("access_restricted"))]);
    let generator = generator(
        dir.path(),
        keyed_auth("latched-key-value"),
        transport.clone(),
        windows(50, 20),
    );
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(NoRouteNative),
        Arc::clone(&generator),
    );
    wait_for(Duration::from_secs(5), "three probes", || {
        transport.calls() >= 3
    })
    .await;
    // Stop the worker between probes (never mid-attempt): once the last
    // refund is on disk and the next re-probe is still well ahead, nothing
    // can claim before the abort.
    wait_for(
        Duration::from_secs(5),
        "a folded refund inside a window",
        || {
            let doc = document_json(dir.path());
            generation_status(&doc, &target).as_deref() == Some("eligible")
                && generator
                    .latch()
                    .reprobe_in(tokio::time::Instant::now())
                    .is_some_and(|left| left >= Duration::from_millis(25))
        },
    )
    .await;
    worker.abort();
    for gap in gaps(&transport) {
        assert!(
            gap >= Duration::from_millis(50),
            "no claim before the re-probe time (gap {gap:?})"
        );
    }
    assert_eq!(generator.latch().pause_kind(), Some(PauseKind::Capability));
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        0,
        "a paused series keeps its whole allowance"
    );
    assert!(!excerpt_of(&doc, &target).is_null(), "and its input");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn throttled_latches_with_growing_backoff() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-throttled", "Throttled by the quota").await;
    let transport = ScriptedTransport::new(vec![
        Err(throttled()),
        Err(throttled()),
        Err(throttled()),
        Err(throttled()),
        Ok("Quota recovered name".to_string()),
    ]);
    let generator = generator(
        dir.path(),
        keyed_auth("throttled-key-value"),
        transport.clone(),
        windows(60_000, 20),
    );
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(NoRouteNative),
        Arc::clone(&generator),
    );
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(update) = get_one(&store, target.clone()).await {
            if update.record.source == NameSource::FreshellAi {
                assert_eq!(update.record.name, "Quota recovered name");
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < until,
            "the fifth probe names the session"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    worker.abort();
    assert_eq!(
        transport.calls(),
        5,
        "never back-to-back: one probe per window"
    );
    let expected = [20u64, 40, 80, 160];
    for (gap, minimum) in gaps(&transport).iter().zip(expected) {
        assert!(
            *gap >= Duration::from_millis(minimum),
            "the throttle window doubles (gap {gap:?}, expected at least {minimum} ms)"
        );
    }
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        1,
        "only the successful attempt consumed"
    );
    assert_eq!(
        generator.latch().pause_kind(),
        None,
        "the success resets the pause"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_credential_means_no_claims() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-no-credential", "Nothing to name with").await;
    let transport = ScriptedTransport::new(vec![Ok("Never requested".to_string())]);
    let generator = generator(
        dir.path(),
        GeminiSessionNameAuth::direct_for_test(AiKeyCell::default()),
        transport.clone(),
        LatchWindows::default(),
    );
    assert!(!generator.capability_ready().await);
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(NoRouteNative),
        Arc::clone(&generator),
    );
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    worker.abort();
    assert_eq!(transport.calls(), 0);
    let doc = document_json(dir.path());
    assert_eq!(generation_consumed(&doc, &target), 0);
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible")
    );
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

fn named<'a>(events: &'a [CapturedTraceEvent], name: &str) -> Vec<&'a CapturedTraceEvent> {
    events
        .iter()
        .filter(|event| event.message.split(':').next() == Some(name))
        .collect()
}

fn assert_no_leak(events: &[CapturedTraceEvent], secrets: &[&str]) {
    for event in events {
        let rendered = format!("{} {:?}", event.message, event.fields);
        for secret in secrets {
            assert!(
                !rendered.contains(secret),
                "a log line leaked {secret:?}: {rendered}"
            );
        }
    }
}

#[tokio::test]
async fn capability_logs_once_per_transition() {
    let (_guard, events) = scoped_trace_capture(GENERATION_TARGET);
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    armed_target(&store, "h-logs", "Log the pause once").await;
    // The key route through an ordinary proxy that refuses the key (the
    // gateway's 400 answer): a capability failure on every attempt.
    let proxy = start_fake_proxy("Unused", ProxyMode::AccessRestricted).await;
    let key = "never-log-this-key-value-123";
    let (auth, http) = session_name_http(
        AiKeyCell::init(Some(key.to_string()), None),
        GEMINI_URL,
        Some(&proxy.ordinary_url()),
    );
    let generator = generator(dir.path(), auth, http, LatchWindows::default());
    for _ in 0..3 {
        let items = store.generation_work_snapshot();
        assert_eq!(items.len(), 1, "a refunded series is claimable again");
        generator.run_due_attempt(&store, &items[0]).await;
    }
    assert_eq!(proxy.recorded().len(), 3, "three failures");
    let events = events.snapshot();
    let warnings = named(&events, "session_names.generation_capability_unavailable");
    assert_eq!(warnings.len(), 1, "one WARN per transition: {events:#?}");
    assert_eq!(warnings[0].level, tracing::Level::WARN);
    assert_eq!(
        warnings[0].fields.get("code").map(String::as_str),
        Some("access_restricted")
    );
    assert_eq!(
        warnings[0].fields.get("route").map(String::as_str),
        Some("key")
    );
    assert_eq!(
        warnings[0].fields.get("status").map(String::as_str),
        Some("400")
    );
    assert!(
        named(&events, "session_names.generation_failed").is_empty(),
        "a refunded failure is not a consumed failure"
    );
    assert_no_leak(
        &events,
        &[
            key,
            &format!("127.0.0.1:{}", proxy.port),
            "generativelanguage",
        ],
    );
    let doc = document_json(dir.path());
    assert_eq!(generation_consumed(&doc, &pending("h-logs")), 0);
}

#[tokio::test]
async fn a_consumed_failure_logs_its_status_and_provider_code() {
    let (_guard, events) = scoped_trace_capture(GENERATION_TARGET);
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    armed_target(&store, "h-consumed", "Log the consumed failure").await;
    let transport = ScriptedTransport::new(vec![Err(classify_gemini_failure(
        500,
        br#"{"error":{"code":500,"status":"INTERNAL"}}"#,
    ))]);
    let generator = generator(
        dir.path(),
        keyed_auth("consumed-key-value"),
        transport,
        LatchWindows::default(),
    );
    let items = store.generation_work_snapshot();
    generator.run_due_attempt(&store, &items[0]).await;
    let events = events.snapshot();
    let failed = named(&events, "session_names.generation_failed");
    assert_eq!(failed.len(), 1, "{events:#?}");
    assert_eq!(
        failed[0].fields.get("status").map(String::as_str),
        Some("500")
    );
    assert_eq!(
        failed[0].fields.get("provider_code").map(String::as_str),
        Some("INTERNAL")
    );
    assert_eq!(
        generation_consumed(&document_json(dir.path()), &pending("h-consumed")),
        1
    );
}

#[tokio::test]
async fn a_proxy_error_never_reaches_logs() {
    let (_guard, events) = scoped_trace_capture(GENERATION_TARGET);
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    armed_target(&store, "h-proxy-leak", "Keep the proxy out of logs").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    // A OneCLI-marked proxy URL with credentials, nothing listening: reqwest's
    // own error text names the proxy.
    let proxy_url = format!("http://aoc_leak_marker:leak-password@127.0.0.1:{port}");
    let (auth, http) = session_name_http(AiKeyCell::default(), GEMINI_URL, Some(&proxy_url));
    let failure = SessionNameTransport::generate_content(http.as_ref(), "p".to_string(), 30)
        .await
        .expect_err("nothing listens on the proxy");
    assert_eq!(failure.code(), "proxy_unreachable");
    assert!(!failure.to_string().contains("leak"));
    let generator = generator(dir.path(), auth, http, LatchWindows::default());
    let items = store.generation_work_snapshot();
    generator.run_due_attempt(&store, &items[0]).await;
    let events = events.snapshot();
    assert_eq!(
        named(&events, "session_names.generation_capability_unavailable").len(),
        1,
        "{events:#?}"
    );
    assert_no_leak(
        &events,
        &["aoc_leak_marker", "leak-password", &format!(":{port}")],
    );
}

#[tokio::test]
async fn boot_log_reports_key_route_transport() {
    let (_guard, events) = scoped_trace_capture(GENERATION_TARGET);
    let dir = temp_data_dir();
    let key = "boot-log-key-value-456";
    let transport = ScriptedTransport::new(vec![Ok(String::new())]);
    for (proxy, transport_name, marker) in [
        ("http://%61oc_boot_marker@127.0.0.1:9", "direct", "true"),
        ("http://127.0.0.1:9", "ambient_proxy", "false"),
    ] {
        let (auth, _http) = session_name_http(
            AiKeyCell::init(Some(key.to_string()), None),
            GEMINI_URL,
            Some(proxy),
        );
        generator(dir.path(), auth, transport.clone(), LatchWindows::default()).log_boot_route();
        let snapshot = events.snapshot();
        let selected = named(&snapshot, "session_names.generation_route_selected");
        let last = selected.last().expect("the route is logged at boot");
        assert_eq!(last.level, tracing::Level::INFO);
        assert_eq!(last.fields.get("route").map(String::as_str), Some("key"));
        assert_eq!(
            last.fields.get("key_route_transport").map(String::as_str),
            Some(transport_name)
        );
        assert_eq!(
            last.fields.get("onecli_marker").map(String::as_str),
            Some(marker)
        );
        assert_eq!(
            last.fields.get("key_configured").map(String::as_str),
            Some("true")
        );
    }
    let snapshot = events.snapshot();
    assert!(named(
        &snapshot,
        "session_names.generation_route_inherited_identity"
    )
    .is_empty());
    assert_no_leak(&snapshot, &[key, "boot_marker", "127.0.0.1"]);
}

#[tokio::test]
async fn inherited_proxy_route_logs_one_warning() {
    let (_guard, events) = scoped_trace_capture(GENERATION_TARGET);
    let dir = temp_data_dir();
    let transport = ScriptedTransport::new(vec![Ok(String::new())]);
    let (auth, _http) = session_name_http(
        AiKeyCell::default(),
        GEMINI_URL,
        Some("http://%61oc_boot_marker@127.0.0.1:9"),
    );
    let inherited = generator(dir.path(), auth, transport.clone(), LatchWindows::default());
    inherited.log_boot_route();
    inherited.notify_capability_change();
    let snapshot = events.snapshot();
    let warnings = named(
        &snapshot,
        "session_names.generation_route_inherited_identity",
    );
    assert_eq!(warnings.len(), 1, "{snapshot:#?}");
    assert_eq!(warnings[0].level, tracing::Level::WARN);
    let selected = named(&snapshot, "session_names.generation_route_selected");
    assert_eq!(selected.len(), 2, "boot, then the capability change");
    assert_eq!(
        selected[0].fields.get("route").map(String::as_str),
        Some("inherited_onecli")
    );
    assert_eq!(
        selected[0].fields.get("key_configured").map(String::as_str),
        Some("false")
    );
    assert_no_leak(&snapshot, &["boot_marker", "127.0.0.1"]);
}

// ---------------------------------------------------------------------------
// A key saved in Settings
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saved_key_clears_the_latch() {
    let dir = temp_data_dir();
    std::fs::create_dir_all(dir.path().join(".freshell")).unwrap();
    let store = open_store(dir.path());
    let target = armed_target(&store, "h-saved-key", "Take over from the gateway").await;
    let gemini = start_fake_gemini("Saved key name", Some("saved-valid-key-value")).await;
    let proxy = start_fake_proxy("Unused", ProxyMode::AccessRestricted).await;
    let key_cell = AiKeyCell::default();
    let (auth, http) = session_name_http(
        key_cell.clone(),
        &gemini.base_url,
        Some(&proxy.onecli_url()),
    );
    let settings = settings_for(dir.path());
    let generator = Arc::new(
        SessionNameGenerator::new(settings.clone(), auth, http)
            .with_latch_windows(windows(600_000, 600_000)),
    );
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(NoRouteNative),
        Arc::clone(&generator),
    );
    wait_for(
        Duration::from_secs(5),
        "the inherited route is refused",
        || generator.latch().pause_kind() == Some(PauseKind::Capability),
    )
    .await;
    assert_eq!(proxy.recorded().len(), 1);

    // Save the key through the real Settings route.
    let auth_token = Arc::new("settings-token".to_string());
    let (broadcast_tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let broadcast_tx = Arc::new(broadcast_tx);
    let log_secrets = freshell_runtime_observability::LiveSecrets::default();
    let state = crate::settings_store::SettingsRouterState {
        store: settings,
        auth_token: Arc::clone(&auth_token),
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({}),
        ),
        registry: freshell_terminal::TerminalRegistry::new(),
        ai_key: key_cell.clone(),
        log_secrets: log_secrets.clone(),
        naming_generation: Some(Arc::clone(&generator)),
    };
    let response = crate::settings_store::router(state)
        .oneshot(
            axum::http::Request::builder()
                .method("PATCH")
                .uri("/api/settings")
                .header("x-auth-token", "settings-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"ai":{"geminiApiKey":"saved-valid-key-value"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(
        log_secrets.redact("x saved-valid-key-value y".to_string()) == "x ***REDACTED*** y",
        "the saved key is a live log secret"
    );

    let until = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(update) = get_one(&store, target.clone()).await {
            if update.record.source == NameSource::FreshellAi {
                assert_eq!(update.record.name, "Saved key name");
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < until,
            "the next poll claims on the key route"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    worker.abort();
    assert_eq!(
        *gemini.keys.lock().unwrap(),
        vec![Some("saved-valid-key-value".to_string())],
        "one keyed request, direct"
    );
    assert!(
        proxy.recorded().iter().all(|request| !request.has_api_key),
        "the OneCLI proxy never sees the key"
    );
    assert_eq!(proxy.recorded().len(), 1);
    assert_eq!(generator.latch().pause_kind(), None);
}

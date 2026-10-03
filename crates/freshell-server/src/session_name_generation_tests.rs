//! Generation behavior tests (plan Task 4): durable eligibility, the bounded
//! retry series, the shared worker's generation dispatch, activity admission
//! for all six modes, index hydration, interrupt recovery, exhaustion
//! finality, late-answer guards, and the two-real-process worker contention
//! (a re-exec of this exact selector in child roles). Everything drives the
//! REAL temp-file store through the strict transaction path; the retry
//! arithmetic is pinned with the data-dir-keyed clock offset (never wall-clock
//! waits), and backend completion is controlled with gates/barriers, never
//! throughput assertions.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_freshagent::naming::{
    BindNameInput, NameActivity, NameActivityReason, NameError, NativeNameObservation,
    NativeNameOrigin, PendingNameInput, RenameNameInput, SessionNaming,
};
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::{
    NameIntent, NameSource, NamedProvider, SessionNameRef, SessionNameUpdate,
};
use serde_json::Value;

use super::{GenerationOutcome, IndexedNameInput, SessionNameGenerator};
use crate::ai_title::{AiKeyCell, BoxFuture, GeminiHttp, GeminiSessionNameHttp, GeminiTransport};
use crate::session_name_native::{
    NativeCallResult, NativeFuture, NativeNameAttempt, NativeNameBackend, NativeNameReadback,
    NativeNameTarget, NativeProbeFuture, SessionNameWorker,
};
use crate::session_names::{
    clear_test_hooks, name_ref_key, set_test_hooks, SessionNames, TestHook, GENERATION_RETRY_1_MS,
    GENERATION_RETRY_2_MS, MAX_GENERATION_STARTS,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_data_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open_store(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.to_string() }
}

fn session(provider: NamedProvider, id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider,
        session_id: id.to_string(),
    }
}

fn claude_location(root: &str, session_id: &str) -> NativeLocation {
    NativeLocation::Claude {
        config_root: root.to_string(),
        transcript_path: Some(format!("{root}/projects/-p/{session_id}.jsonl")),
        project_directory_key: None,
        transcript_cwd: None,
        effective_project_key_override: None,
    }
}

fn verified_acquisition(location: NativeLocation) -> NativeAcquisition {
    NativeAcquisition {
        location,
        evidence: NativeEvidenceKind::SelectedTranscript,
        persistence: NativePersistence::Verified,
    }
}

async fn ensure_pending(
    store: &Arc<SessionNames>,
    handle: &str,
    provider: NamedProvider,
    cwd: Option<&str>,
) -> Result<SessionNameUpdate, NameError> {
    store
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider,
            cwd: cwd.map(str::to_string),
        })
        .await
}

async fn rename_user(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
}

async fn activity(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    mode: &str,
    event_id: &str,
    reason: NameActivityReason,
    first_user_message: Option<&str>,
) -> Result<SessionNameUpdate, NameError> {
    store
        .activity(NameActivity {
            target,
            mode: mode.to_string(),
            event_id: event_id.to_string(),
            reason,
            first_user_message: first_user_message.map(str::to_string),
            cwd: None,
        })
        .await
}

async fn observe_provider_title(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    title: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .observe_native(NativeNameObservation {
            target,
            title: title.to_string(),
            origin: NativeNameOrigin::ProviderAi,
            location_revision: 0,
            event_id: None,
        })
        .await
}

async fn get_one(store: &Arc<SessionNames>, target: SessionNameRef) -> Option<SessionNameUpdate> {
    let updates = store.get(vec![target]).await.expect("get succeeds");
    updates.into_iter().next()
}

/// Arm one record's generation series through the accepted-input path.
async fn arm_with_message(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    mode: &str,
    message: &str,
) -> SessionNameUpdate {
    activity(
        store,
        target,
        mode,
        "e-arm",
        NameActivityReason::AcceptedUserMessage,
        Some(message),
    )
    .await
    .expect("accepted input arms the series")
}

/// The persisted document JSON (black-box: the series/retry state lives in
/// the internal sections; the file is the contract).
fn document_json(dir: &Path) -> Value {
    let bytes = std::fs::read(dir.join("session-names.json")).expect("document exists");
    serde_json::from_slice(&bytes).expect("document parses")
}

/// The generation series entry for one target (black-box).
fn generation_entry<'a>(doc: &'a Value, target: &SessionNameRef) -> Option<&'a Value> {
    doc["generation"].as_object()?.get(&name_ref_key(target))
}

fn generation_status(doc: &Value, target: &SessionNameRef) -> Option<String> {
    generation_entry(doc, target)?["status"]
        .as_str()
        .map(str::to_string)
}

fn generation_consumed(doc: &Value, target: &SessionNameRef) -> u64 {
    generation_entry(doc, target)
        .and_then(|entry| entry["consumed"].as_u64())
        .unwrap_or(0)
}

fn generation_next_due(doc: &Value, target: &SessionNameRef) -> Option<i64> {
    generation_entry(doc, target).and_then(|entry| entry["nextDue"].as_i64())
}

/// The store's decision clock right now (wall now + the data-dir offset).
fn decision_now(dir: &Path) -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        + crate::session_names::clock_offset_ms_for_tests(dir)
}

/// A counting, immediately-answering in-process transport.
struct CountingTransport {
    calls: AtomicU32,
    answer: Mutex<String>,
}

impl CountingTransport {
    fn new(answer: &str) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicU32::new(0),
            answer: Mutex::new(answer.to_string()),
        })
    }

    fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

impl GeminiTransport for CountingTransport {
    fn generate_content(&self, _prompt: String, _max: u32) -> BoxFuture<Result<String, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self.answer.lock().unwrap().clone();
        Box::pin(async move { Ok(answer) })
    }
}

/// A transport whose FIRST call parks until a file-based gate opens, then
/// answers — the barrier that proves what completes while a provider
/// operation is held.
struct FileGatedTransport {
    calls: AtomicU32,
    answer: String,
    gate_path: PathBuf,
    held_sentinel: PathBuf,
}

impl GeminiTransport for FileGatedTransport {
    fn generate_content(&self, _prompt: String, _max: u32) -> BoxFuture<Result<String, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self.answer.clone();
        let gate = self.gate_path.clone();
        let held = self.held_sentinel.clone();
        Box::pin(async move {
            let _ = std::fs::write(&held, b"held");
            let deadline = std::time::Instant::now() + Duration::from_secs(25);
            while !gate.exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the generation gate never opened"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(answer)
        })
    }
}

/// A transport that always fails (the bounded-retry driver).
struct FailingTransport {
    calls: AtomicU32,
}

impl FailingTransport {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicU32::new(0),
        })
    }
}

impl GeminiTransport for FailingTransport {
    fn generate_content(&self, _prompt: String, _max: u32) -> BoxFuture<Result<String, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Err("scripted provider failure".to_string()) })
    }
}

/// A native backend that never has a route: native work stays paused.
struct NoRouteNative;

impl NativeNameBackend for NoRouteNative {
    fn read(&self, _target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
        Box::pin(async move {
            NativeCallResult::Unsupported("no native route in this test".to_string())
        })
    }

    fn write(&self, _attempt: NativeNameAttempt) -> NativeFuture<()> {
        Box::pin(async move {
            NativeCallResult::Unsupported("no native route in this test".to_string())
        })
    }

    fn route_available(&self, _target: NativeNameTarget) -> NativeProbeFuture {
        Box::pin(async move { false })
    }
}

fn settings_for(dir: &Path) -> crate::settings_store::SettingsStore {
    crate::settings_store::SettingsStore::load(Some(dir), vec![])
}

fn generator_with(
    dir: &Path,
    key: Option<&str>,
    transport: Arc<dyn GeminiTransport>,
) -> Arc<SessionNameGenerator> {
    Arc::new(SessionNameGenerator::new(
        settings_for(dir),
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(AiKeyCell::init(
            key.map(str::to_string),
            None,
        )),
        transport,
    ))
}

/// A local HTTP Gemini fixture whose responses are HELD until released —
/// the real `GeminiHttp` transport rides it, so the request bound, the wire
/// contract, and the gated release are all real.
struct GatedHttpGemini {
    base_url: String,
    requests: Arc<AtomicU32>,
    open: Arc<tokio::sync::watch::Sender<bool>>,
}

async fn start_gated_http_gemini(reply: &str) -> GatedHttpGemini {
    use axum::routing::post;
    use axum::Router;
    let requests = Arc::new(AtomicU32::new(0));
    let requests_handle = Arc::clone(&requests);
    let (open, open_rx) = tokio::sync::watch::channel(false);
    let reply = reply.to_string();
    let app = Router::new().route(
        "/v1beta/models/gemini-3.5-flash-lite:generateContent",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            let mut open_rx = open_rx.clone();
            let reply = reply.clone();
            async move {
                requests.fetch_add(1, Ordering::SeqCst);
                let _ = body;
                loop {
                    if *open_rx.borrow() {
                        break;
                    }
                    if open_rx.changed().await.is_err() {
                        break;
                    }
                }
                axum::Json(serde_json::json!({
                    "candidates": [{ "content": { "parts": [{ "text": reply }] } }]
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    GatedHttpGemini {
        base_url: format!("http://{addr}/v1beta"),
        requests: requests_handle,
        open: Arc::new(open),
    }
}

impl GatedHttpGemini {
    fn transport(&self, key: &str) -> Arc<GeminiHttp> {
        Arc::new(GeminiHttp::new(
            reqwest::Client::new(),
            AiKeyCell::init(Some(key.to_string()), None),
            self.base_url.clone(),
        ))
    }

    fn release(&self) {
        let _ = self.open.send(true);
    }
}

struct OneCliFallbackGemini {
    base_url: String,
    observed_fallback_headers: Arc<Mutex<Vec<bool>>>,
}

async fn start_onecli_fallback_gemini() -> OneCliFallbackGemini {
    use axum::body::Body;
    use axum::routing::post;
    use axum::{http::Response, Router};

    let observed_fallback_headers = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&observed_fallback_headers);
    let requests = Arc::new(AtomicU32::new(0));
    let request_count = Arc::clone(&requests);
    let app = Router::new().route(
        "/v1beta/models/gemini-3.5-flash-lite:generateContent",
        post(move |headers: axum::http::HeaderMap| {
            let observed = Arc::clone(&observed);
            let request_count = Arc::clone(&request_count);
            async move {
                observed.lock().unwrap().push(
                    headers
                        .get("x-goog-api-key")
                        .and_then(|value| value.to_str().ok())
                        == Some("worker-fallback-sentinel"),
                );
                let response_number = request_count.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if response_number == 0 {
                    (
                        axum::http::StatusCode::UNAUTHORIZED,
                        r#"{"error":"credential_not_found"}"#,
                    )
                } else {
                    (
                        axum::http::StatusCode::OK,
                        r#"{"candidates":[{"content":{"parts":[{"text":"Sardine crash investigation"}]}}]}"#,
                    )
                };
                let mut response = Response::new(Body::from(body));
                *response.status_mut() = status;
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    OneCliFallbackGemini {
        base_url: format!("http://{addr}/v1beta"),
        observed_fallback_headers,
    }
}

// ---------------------------------------------------------------------------
// Activity admission: the six modes, fallback, excluded modes
// ---------------------------------------------------------------------------

/// Every scoped mode admits activity without any PTY or browser: the
/// first-message fallback lands immediately and the series is armed
/// Eligible (immediately ready), for the fresh pending lanes and the
/// CLI/index lanes alike.
#[tokio::test]
async fn six_modes_admit_activity_with_an_immediate_fallback_and_an_armed_series() {
    let cases = [
        ("freshclaude", NamedProvider::Claude, true),
        ("freshcodex", NamedProvider::Codex, true),
        ("freshopencode", NamedProvider::Opencode, true),
        ("claude", NamedProvider::Claude, false),
        ("codex", NamedProvider::Codex, false),
        ("opencode", NamedProvider::Opencode, false),
    ];
    for (mode, provider, fresh) in cases {
        let dir = temp_data_dir();
        let store = open_store(dir.path());
        let target = if fresh {
            let target = pending("h-six");
            ensure_pending(&store, "h-six", provider, Some("/w/sixproj"))
                .await
                .expect("ensure");
            target
        } else {
            // The CLI lane: the record comes from index observation.
            let target = session(provider, "ses-six");
            store
                .hydrate_indexed(
                    IndexedNameInput {
                        provider,
                        session_id: "ses-six".to_string(),
                        cwd: Some("/w/sixproj".to_string()),
                        first_user_message: None,
                        provider_title: None,
                    },
                    false,
                )
                .await
                .expect("hydrate");
            target
        };
        let updated =
            arm_with_message(&store, target.clone(), mode, "Fix the login flow\nrest").await;
        assert_eq!(updated.record.source, NameSource::FirstMessage, "{mode}");
        assert_eq!(updated.record.name, "Fix the login flow", "{mode}");
        let doc = document_json(dir.path());
        assert_eq!(
            generation_status(&doc, &target).as_deref(),
            Some("eligible"),
            "{mode}: the series is armed"
        );
        let items = store.generation_work_snapshot();
        assert!(
            items.iter().any(|item| item.target == target),
            "{mode}: an armed series is immediately ready"
        );
    }
}

/// Excluded modes never enter the generator: kilroy, amplifier, and shells
/// keep their existing naming approach — activity neither upgrades the
/// fallback nor arms a series for them.
#[tokio::test]
async fn excluded_modes_never_arm_or_upgrade() {
    for mode in ["kilroy", "amplifier", "shell"] {
        let dir = temp_data_dir();
        let store = open_store(dir.path());
        let target = pending("h-excluded");
        ensure_pending(&store, "h-excluded", NamedProvider::Claude, Some("/w/proj"))
            .await
            .expect("ensure");
        let updated = activity(
            &store,
            target.clone(),
            mode,
            "e-excluded",
            NameActivityReason::AcceptedUserMessage,
            Some("A scoped message the mode must ignore"),
        )
        .await
        .expect("the fold itself resolves");
        assert_eq!(updated.record.source, NameSource::Directory, "{mode}");
        assert_eq!(updated.record.name, "proj", "{mode}");
        assert!(
            store.generation_work_snapshot().is_empty(),
            "{mode}: nothing enters the generator"
        );
        let doc = document_json(dir.path());
        assert!(
            generation_entry(&doc, &target).is_none(),
            "{mode}: no series is created"
        );
    }
}

/// A post-exit CLI session (no live terminal, no browser) still gets its
/// activity admitted: the durable record hydrates from the index and the
/// newly observed message arms generation.
#[tokio::test]
async fn post_exit_cli_activity_arms_without_a_terminal() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = session(NamedProvider::Codex, "ses-postexit");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Codex,
                session_id: "ses-postexit".to_string(),
                cwd: Some("/w/postexit".to_string()),
                first_user_message: None,
                provider_title: None,
            },
            false,
        )
        .await
        .expect("hydrate the historical row");
    arm_with_message(
        &store,
        target.clone(),
        "codex",
        "Investigate the dropped connection",
    )
    .await;
    assert!(
        store
            .generation_work_snapshot()
            .iter()
            .any(|item| item.target == target),
        "no terminal is required for the arming"
    );
}

/// Duplicate delivery of the same accepted message persists nothing: the
/// series' input fingerprint absorbs it (one series, one document shape).
#[tokio::test]
async fn duplicate_activity_delivery_is_absorbed_by_the_input_fingerprint() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-dup");
    ensure_pending(&store, "h-dup", NamedProvider::Claude, Some("/w/dup"))
        .await
        .expect("ensure");
    arm_with_message(&store, target.clone(), "freshclaude", "Duplicate message").await;
    let gen_after_arm = document_json(dir.path())["documentGeneration"]
        .as_u64()
        .unwrap();
    let duplicate = activity(
        &store,
        target.clone(),
        "freshclaude",
        "e-dup-2",
        NameActivityReason::AcceptedUserMessage,
        Some("Duplicate message"),
    )
    .await
    .expect("duplicate folds");
    assert!(!duplicate.changed);
    assert_eq!(
        document_json(dir.path())["documentGeneration"]
            .as_u64()
            .unwrap(),
        gen_after_arm,
        "duplicate delivery persists nothing"
    );
    let doc = document_json(dir.path());
    assert!(
        generation_entry(&doc, &target).is_some(),
        "the one armed series survives"
    );
    assert_eq!(
        doc["generation"].as_object().map(|m| m.len()),
        Some(1),
        "exactly one series exists for the record"
    );
}

// ---------------------------------------------------------------------------
// Dispatch: the gated HTTP fixture, provider titles, generation execution
// ---------------------------------------------------------------------------

/// The full pipeline through the REAL HTTP transport and the shared worker:
/// activity lands the first-message fallback immediately, the release of the
/// gated HTTP fixture saves the short AI name (exactly one request), and
/// the accepted Freshell AI name arms its native writeback series.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn releasing_the_gated_http_fixture_saves_a_short_ai_name() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let fixture = start_gated_http_gemini("Sardine crash investigation").await;
    let generator = Arc::new(SessionNameGenerator::new(
        settings_for(dir.path()),
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(AiKeyCell::init(
            Some("gen-key".to_string()),
            None,
        )),
        fixture.transport("gen-key"),
    ));
    let target = pending("h-http");
    ensure_pending(&store, "h-http", NamedProvider::Claude, Some("/w/httpproj"))
        .await
        .expect("ensure");
    let armed = arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Investigate the crash",
    )
    .await;
    assert_eq!(armed.record.name, "Investigate the crash");

    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(NoRouteNative),
        Arc::clone(&generator),
    );
    // The worker claims the start and holds the provider operation on the
    // closed gate: the fallback stays visible and exactly one request went
    // out.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while fixture.requests.load(Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the start dispatched"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let interim = get_one(&store, target.clone()).await.expect("record");
    assert_eq!(interim.record.name, "Investigate the crash");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        1,
        "the start is charged"
    );

    // Release the fixture: the committed winner publishes.
    fixture.release();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(update) = get_one(&store, target.clone()).await {
            if update.record.source == NameSource::FreshellAi {
                assert_eq!(update.record.name, "Sardine crash investigation");
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the released answer must save the AI name"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    worker.abort();
    assert_eq!(fixture.requests.load(Ordering::SeqCst), 1, "one request");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("idle"),
        "the accepted series rests"
    );
    // The accepted Freshell AI name is a writable name decision: its native
    // writeback series is armed.
    let sync = get_one(&store, target.clone())
        .await
        .expect("record")
        .native_sync
        .expect("the accepted AI name projects a native series");
    assert_eq!(sync.desired_revision, interim.record.revision + 1);
}

/// The real worker uses the session-name transport's explicit OneCLI
/// missing-credential fallback and persists the generated title through the
/// normal durable name-store path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn onecli_missing_credential_worker_fallback_saves_ai_name() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let fixture = start_onecli_fallback_gemini().await;
    let auth = crate::ai_title::GeminiSessionNameAuth::onecli_for_test(AiKeyCell::init(
        Some("worker-fallback-sentinel".to_string()),
        None,
    ));
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let transport = Arc::new(GeminiSessionNameHttp::new(
        client,
        auth.clone(),
        fixture.base_url.clone(),
    ));
    let generator = Arc::new(SessionNameGenerator::new(
        settings_for(dir.path()),
        auth,
        transport,
    ));
    let target = pending("h-onecli-fallback");
    ensure_pending(
        &store,
        "h-onecli-fallback",
        NamedProvider::Claude,
        Some("/w/onecli-fallback"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Investigate the crash",
    )
    .await;

    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(NoRouteNative),
        Arc::clone(&generator),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(update) = get_one(&store, target.clone()).await {
            if update.record.source == NameSource::FreshellAi {
                assert_eq!(update.record.name, "Sardine crash investigation");
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the worker must save the fallback answer"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    worker.abort();

    assert_eq!(
        *fixture.observed_fallback_headers.lock().unwrap(),
        vec![false, true],
        "the worker makes one keyless OneCLI request and one direct-key fallback"
    );
}

/// A provider-authored title never suppresses generation: it lands at its
/// own fallback rank, and the AI answer still replaces it.
#[tokio::test]
async fn a_seeded_provider_title_does_not_suppress_generation() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let transport = CountingTransport::new("Provider replacement name");
    let generator = generator_with(dir.path(), Some("gen-key"), transport.clone());
    let target = pending("h-provider");
    ensure_pending(
        &store,
        "h-provider",
        NamedProvider::Opencode,
        Some("/w/provider"),
    )
    .await
    .expect("ensure");
    observe_provider_title(&store, target.clone(), "Provider AI title")
        .await
        .expect("the provider observation offers");
    let armed = arm_with_message(
        &store,
        target.clone(),
        "freshopencode",
        "Design the export flow",
    )
    .await;
    assert_eq!(armed.record.source, NameSource::ProviderAi);
    assert_eq!(armed.record.name, "Provider AI title");
    let items = store.generation_work_snapshot();
    assert_eq!(items.len(), 1, "generation still runs");
    generator.run_due_attempt(&store, &items[0]).await;
    assert_eq!(transport.calls(), 1);
    let after = get_one(&store, target.clone()).await.expect("record");
    assert_eq!(after.record.source, NameSource::FreshellAi);
    assert_eq!(after.record.name, "Provider replacement name");
}

/// A pending→durable bind during dispatch keeps the in-flight answer: the
/// completion resolves through the redirect and folds onto the durable
/// record (the union preserves the series id, so the guard accepts it).
#[tokio::test]
async fn a_pending_bind_during_dispatch_folds_through_the_redirect() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let transport = CountingTransport::new("Redirected AI name");
    let _generator = generator_with(dir.path(), Some("gen-key"), transport.clone());
    let target = pending("h-bindrace");
    ensure_pending(
        &store,
        "h-bindrace",
        NamedProvider::Codex,
        Some("/w/bindrace"),
    )
    .await
    .expect("ensure");
    arm_with_message(&store, target.clone(), "freshcodex", "Bind race message").await;
    let items = store.generation_work_snapshot();
    assert_eq!(items.len(), 1);
    let claim = store
        .claim_generation_start(target.clone(), "attempt-bindrace".to_string())
        .await
        .expect("claim transaction runs")
        .expect("the series is claimable");

    // The durable identity materializes mid-flight.
    let durable = session(NamedProvider::Codex, "ses_bindrace");
    store
        .bind_pending(BindNameInput {
            pending: target.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(NativeLocation::Codex {
                codex_home: "/w/homes/codex".to_string(),
                native_thread_id: Some("ses_bindrace".to_string()),
                rollout_path: None,
                persistence_evidence: None,
            }),
        })
        .await
        .expect("bind");

    // The late answer folds on the PENDING ref: the redirect resolves it.
    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Redirected AI name".to_string()),
        )
        .await
        .expect("the fold runs");
    let after = get_one(&store, durable.clone())
        .await
        .expect("durable record");
    assert_eq!(after.record.source, NameSource::FreshellAi);
    assert_eq!(after.record.name, "Redirected AI name");
}

/// A MANUAL pending winner that binds AFTER the generation claim — the
/// materialization race: the sweep armed the durable session's series
/// before the naming bind transferred the pending record — must not pay
/// the provider call. The dispatch re-check sees the bound record's
/// protected source, folds without dispatch, and the manual winner keeps
/// the name (the series closes without a retry).
#[tokio::test]
async fn a_manual_winner_binding_after_the_claim_skips_the_provider_call() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let transport = CountingTransport::new("Must never be requested");
    let generator = generator_with(dir.path(), Some("gen-key"), transport.clone());
    // The durable session: hydration installs the fallback record, and the
    // sweep's later pass ARMS the series (a genuinely new message) — the
    // fallback record is claimable.
    let durable = session(NamedProvider::Codex, "ses_manualclaim");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Codex,
                session_id: "ses_manualclaim".to_string(),
                cwd: Some("/w/manualclaim".to_string()),
                first_user_message: None,
                provider_title: None,
            },
            true,
        )
        .await
        .expect("hydrate");
    arm_with_message(&store, durable.clone(), "freshcodex", "Race arm message").await;
    let claim = store
        .claim_generation_start(durable.clone(), "attempt-manualclaim".to_string())
        .await
        .expect("claim transaction runs")
        .expect("the fallback series is claimable");
    // The user's PRE-DURABLE manual rename binds MID-DISPATCH: the manual
    // winner is now the session's accepted record.
    let pending_ref = pending("h-manualclaim");
    ensure_pending(
        &store,
        "h-manualclaim",
        NamedProvider::Codex,
        Some("/w/manualclaim"),
    )
    .await
    .expect("ensure");
    rename_user(&store, pending_ref.clone(), "Manual winner name")
        .await
        .expect("manual rename");
    store
        .bind_pending(BindNameInput {
            pending: pending_ref.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(NativeLocation::Codex {
                codex_home: "/w/homes/codex".to_string(),
                native_thread_id: Some("ses_manualclaim".to_string()),
                rollout_path: None,
                persistence_evidence: None,
            }),
        })
        .await
        .expect("bind");
    // The dispatch: the protected winner cancels the provider call.
    generator.dispatch_claimed_attempt(&store, &claim).await;
    assert_eq!(
        transport.calls(),
        0,
        "a protected winner landing after the claim must not pay the provider call"
    );
    let after = get_one(&store, durable.clone()).await.expect("record");
    assert_eq!(after.record.name, "Manual winner name");
    assert_eq!(after.record.source, NameSource::Manual);
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &durable).as_deref(),
        Some("idle"),
        "the superseded series closes without a retry"
    );
}

// ---------------------------------------------------------------------------
// The bounded retry series (clock-controlled — never wall-clock waits)
// ---------------------------------------------------------------------------

/// The exact retry schedule: attempt 1 is ready immediately, attempt 2 is
/// due EXACTLY 30 seconds after failure 1, attempt 3 EXACTLY five minutes
/// after failure 2, exhaustion at the third start is final across messages
/// and restarts, and a not-yet-due series never reaches the selector.
#[tokio::test]
async fn the_retry_schedule_is_immediate_then_thirty_seconds_then_five_minutes() {
    let dir = temp_data_dir();
    set_test_hooks(dir.path(), vec![TestHook::ClockOffsetMs(0)]);
    let store = open_store(dir.path());
    let target = pending("h-retry");
    ensure_pending(&store, "h-retry", NamedProvider::Claude, Some("/w/retry"))
        .await
        .expect("ensure");
    arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Retry schedule message",
    )
    .await;

    // Attempt 1: immediately ready.
    let items = store.generation_work_snapshot();
    assert_eq!(items.len(), 1, "first eligibility is immediately ready");
    let claim1 = store
        .claim_generation_start(target.clone(), "attempt-1".to_string())
        .await
        .expect("claim runs")
        .expect("attempt 1 claims");
    assert_eq!(claim1.consumed, 1);

    // Failure 1: the retry is due EXACTLY 30 seconds after the fold.
    let before_fold = decision_now(dir.path());
    store
        .fold_generation_outcome(
            target.clone(),
            claim1.series_id.clone(),
            claim1.input_fingerprint.clone(),
            GenerationOutcome::Failed("scripted failure 1".to_string()),
        )
        .await
        .expect("failure 1 folds");
    let after_fold = decision_now(dir.path());
    let due =
        generation_next_due(&document_json(dir.path()), &target).expect("the retry is scheduled");
    assert!(
        due >= before_fold + GENERATION_RETRY_1_MS && due <= after_fold + GENERATION_RETRY_1_MS,
        "attempt 2 is due exactly 30s after failure 1 (due {due}, fold {before_fold}..{after_fold})"
    );
    assert!(
        store.generation_work_snapshot().is_empty(),
        "a not-yet-due series never reaches the selector"
    );

    // Advance the clock past the delay: attempt 2 claims.
    set_test_hooks(
        dir.path(),
        vec![TestHook::ClockOffsetMs(GENERATION_RETRY_1_MS)],
    );
    let claim2 = store
        .claim_generation_start(target.clone(), "attempt-2".to_string())
        .await
        .expect("claim runs")
        .expect("attempt 2 claims after the delay");
    assert_eq!(claim2.consumed, 2);

    // Failure 2: due EXACTLY five minutes after the fold.
    let before_fold2 = decision_now(dir.path());
    store
        .fold_generation_outcome(
            target.clone(),
            claim2.series_id.clone(),
            claim2.input_fingerprint.clone(),
            GenerationOutcome::Failed("scripted failure 2".to_string()),
        )
        .await
        .expect("failure 2 folds");
    let after_fold2 = decision_now(dir.path());
    let due2 = generation_next_due(&document_json(dir.path()), &target)
        .expect("the second retry is scheduled");
    assert!(
        due2 >= before_fold2 + GENERATION_RETRY_2_MS && due2 <= after_fold2 + GENERATION_RETRY_2_MS,
        "attempt 3 is due exactly five minutes after failure 2"
    );
    set_test_hooks(
        dir.path(),
        vec![TestHook::ClockOffsetMs(
            GENERATION_RETRY_1_MS + GENERATION_RETRY_2_MS,
        )],
    );
    let claim3 = store
        .claim_generation_start(target.clone(), "attempt-3".to_string())
        .await
        .expect("claim runs")
        .expect("attempt 3 claims after the delay");
    assert_eq!(claim3.consumed, MAX_GENERATION_STARTS);

    // The third start exhausts the series at the claim; the final failure
    // keeps it exhausted and removes the excerpt.
    store
        .fold_generation_outcome(
            target.clone(),
            claim3.series_id.clone(),
            claim3.input_fingerprint.clone(),
            GenerationOutcome::Failed("scripted failure 3".to_string()),
        )
        .await
        .expect("failure 3 folds");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("exhausted"),
        "three consumed starts exhaust the series"
    );
    assert!(
        generation_entry(&doc, &target)
            .expect("the exhausted series persists")
            .get("excerpt")
            .is_none_or(Value::is_null),
        "the excerpt is removed after exhaustion"
    );

    // Exhaustion is final: new messages, reconnect refreshes, and restarts
    // never rearm it.
    activity(
        &store,
        target.clone(),
        "freshclaude",
        "e-after-exhaustion",
        NameActivityReason::AcceptedUserMessage,
        Some("A brand new conversation message"),
    )
    .await
    .expect("activity folds");
    store.refresh_current().await.expect("reconnect refresh");
    let reopened = open_store(dir.path());
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("exhausted"),
        "messages, refreshes, and restarts never rearm exhaustion"
    );
    assert!(reopened.generation_work_snapshot().is_empty());
    let beyond = reopened
        .claim_generation_start(target.clone(), "attempt-beyond".to_string())
        .await
        .expect("claim runs");
    assert!(beyond.is_none(), "an exhausted series is never claimable");
    clear_test_hooks(dir.path());
}

/// The 20-second request bound charges the attempt exactly once: a
/// transport that never answers is cut at the bound (tokio virtual time —
/// no wall-clock wait), the attempt is consumed, and the retry is scheduled
/// without a second charge.
#[tokio::test(start_paused = true)]
async fn the_twenty_second_request_bound_charges_the_attempt_once() {
    struct NeverTransport;
    impl GeminiTransport for NeverTransport {
        fn generate_content(&self, _p: String, _m: u32) -> BoxFuture<Result<String, String>> {
            Box::pin(std::future::pending())
        }
    }
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let generator = generator_with(
        dir.path(),
        Some("gen-key"),
        Arc::new(NeverTransport) as Arc<dyn GeminiTransport>,
    );
    let target = pending("h-bound");
    ensure_pending(&store, "h-bound", NamedProvider::Claude, Some("/w/bound"))
        .await
        .expect("ensure");
    arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Bounded request message",
    )
    .await;
    let items = store.generation_work_snapshot();
    assert_eq!(items.len(), 1);
    let before = decision_now(dir.path());
    generator.run_due_attempt(&store, &items[0]).await;
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        1,
        "the timeout charged the attempt exactly once"
    );
    let due = generation_next_due(&doc, &target).expect("the retry is scheduled");
    let drift = (due - before) - GENERATION_RETRY_1_MS;
    assert!(
        (0..=2_000).contains(&drift),
        "the remaining 30s delay is scheduled from the fold (drift {drift}ms)"
    );
}

/// Restart preserves consumed starts; an interrupted dispatch (a start
/// persisted, never folded) is recovered ONCE as failed at recovery time
/// with the remaining delay scheduled from that fold.
#[tokio::test]
async fn restart_preserves_consumed_starts_and_recovers_an_interrupted_dispatch_once() {
    let dir = temp_data_dir();
    set_test_hooks(dir.path(), vec![TestHook::ClockOffsetMs(0)]);
    let store = open_store(dir.path());
    let target = pending("h-recover");
    ensure_pending(
        &store,
        "h-recover",
        NamedProvider::Claude,
        Some("/w/recover"),
    )
    .await
    .expect("ensure");
    arm_with_message(&store, target.clone(), "freshclaude", "Interrupted message").await;
    let claim = store
        .claim_generation_start(target.clone(), "attempt-interrupted".to_string())
        .await
        .expect("claim runs")
        .expect("the series is claimable");
    assert_eq!(claim.consumed, 1);

    // Restart: the consumed start survives, the interrupted start is visible.
    let store = open_store(dir.path());
    let doc = document_json(dir.path());
    assert_eq!(generation_consumed(&doc, &target), 1);
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("inFlight"),
        "the interrupted start is persisted before dispatch"
    );
    assert_eq!(store.interrupted_generation_count(), 1);

    // Recovery folds it once as failed, scheduling the remaining delay from
    // the fold.
    let before = decision_now(dir.path());
    let recovered = store
        .recover_interrupted_generation()
        .await
        .expect("recovery runs");
    assert_eq!(recovered, 1);
    let after = decision_now(dir.path());
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible"),
        "the recovered series is retry-eligible"
    );
    assert_eq!(generation_consumed(&doc, &target), 1, "no extra start");
    let due = generation_next_due(&doc, &target).expect("the delay is scheduled");
    assert!(
        due >= before + GENERATION_RETRY_1_MS && due <= after + GENERATION_RETRY_1_MS,
        "the remaining delay is scheduled from the recovery fold"
    );
    assert_eq!(
        store.interrupted_generation_count(),
        0,
        "recovery happens exactly once"
    );
    let again = store
        .recover_interrupted_generation()
        .await
        .expect("second recovery runs");
    assert_eq!(again, 0, "a recovered series never recovers twice");
    clear_test_hooks(dir.path());
}

/// Review I1: an interrupted series that is the ONLY dispatchable work
/// still recovers. `generation_work_snapshot` filters `InFlight`, so the
/// worker selects NOTHING — the idle path itself must check for
/// interrupted starts, acquire the guard, and fold them once as failed
/// (the dispatch branches' recovery piggyback cannot fire when there is
/// no other work to dispatch).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_worker_recovers_an_interrupted_series_that_is_the_only_work() {
    let dir = temp_data_dir();
    set_test_hooks(dir.path(), vec![TestHook::ClockOffsetMs(0)]);
    let store = open_store(dir.path());
    let target = pending("h-only-work");
    ensure_pending(
        &store,
        "h-only-work",
        NamedProvider::Claude,
        Some("/w/only"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Only interrupted message",
    )
    .await;
    store
        .claim_generation_start(target.clone(), "attempt-only-interrupted".to_string())
        .await
        .expect("claim runs")
        .expect("the series is claimable");
    assert_eq!(store.interrupted_generation_count(), 1);

    // The interrupted series is the ONLY work: nothing is selectable, so
    // only the idle path's recovery check can schedule the retry within
    // the bounded window.
    let transport = CountingTransport::new("Never dispatched");
    let generator = generator_with(dir.path(), Some("gen-key"), transport.clone());
    let worker = SessionNameWorker::start(Arc::clone(&store), Arc::new(NoRouteNative), generator);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    // Converge on BOTH pins before breaking: the recovery commit writes
    // the durable file first and swaps the in-memory read model after, so
    // a file-only poll can observe the fold while the count still reports
    // the stale InFlight view (the race the post-loop assertions pin).
    loop {
        let doc = document_json(dir.path());
        if generation_status(&doc, &target).as_deref() == Some("eligible")
            && store.interrupted_generation_count() == 0
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the idle path must recover the interrupted series that is the only work"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        1,
        "recovery consumes nothing"
    );
    let due = generation_next_due(&doc, &target).expect("the retry is scheduled");
    assert!(
        due > decision_now(dir.path()),
        "the remaining 30s delay is scheduled from the recovery fold"
    );
    assert_eq!(
        store.interrupted_generation_count(),
        0,
        "recovery happened exactly once"
    );
    assert_eq!(
        transport.calls(),
        0,
        "recovery never dispatches a provider request"
    );
    clear_test_hooks(dir.path());
}

/// Review I2: an AI answer that fails `validate_name` — the Gemini
/// transport trims and caps at 80 chars but never strips control
/// characters, so a reply with an internal newline or tab reaches the
/// fold — consumes the already-charged attempt and schedules the
/// bounded retry. The fold must never error the transaction: an error
/// strands the series `InFlight` with `nextDue: None` (exactly the
/// interrupted-start shape, permanently when it is the only work).
#[tokio::test]
async fn an_invalid_answer_consumes_the_attempt_and_schedules_the_retry() {
    let dir = temp_data_dir();
    set_test_hooks(dir.path(), vec![TestHook::ClockOffsetMs(0)]);
    let store = open_store(dir.path());
    let target = pending("h-invalid-answer");
    ensure_pending(
        &store,
        "h-invalid-answer",
        NamedProvider::Claude,
        Some("/w/invalid"),
    )
    .await
    .expect("ensure");
    let armed = arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Invalid answer message",
    )
    .await;
    assert_eq!(armed.record.name, "Invalid answer message");
    let claim = store
        .claim_generation_start(target.clone(), "attempt-invalid".to_string())
        .await
        .expect("claim runs")
        .expect("the series is claimable");
    let before = decision_now(dir.path());

    // A control character inside the reply fails validate_name (names
    // reject control characters) — the fold treats it as an empty
    // answer: consume the charged attempt, schedule the retry.
    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Bad\nname".to_string()),
        )
        .await
        .expect("an invalid answer folds, never errors the transaction");
    let after = decision_now(dir.path());

    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &target),
        1,
        "the attempt is consumed exactly once"
    );
    assert_eq!(
        generation_status(&doc, &target).as_deref(),
        Some("eligible"),
        "no stranded InFlight: the series is retry-eligible"
    );
    let due = generation_next_due(&doc, &target).expect("the bounded retry is scheduled");
    assert!(
        due >= before + GENERATION_RETRY_1_MS && due <= after + GENERATION_RETRY_1_MS,
        "the 30s delay is scheduled from the fold (due {due}, window {before}..{after}+30s)"
    );
    // The fallback name stands — the invalid answer never publishes.
    let record = get_one(&store, target.clone()).await.expect("record");
    assert_eq!(record.record.name, "Invalid answer message");
    assert_eq!(
        store.interrupted_generation_count(),
        0,
        "the fold left nothing for interrupt recovery"
    );
    clear_test_hooks(dir.path());
}

/// A capability pause (no Gemini key) consumes nothing and does not
/// monopolize the worker: native work behind the paused generation series
/// still converges, and the capability wake resumes the remaining work.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capability_pause_consumes_nothing_and_resumes_on_the_wake() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let cell = AiKeyCell::init(None, None);
    let generation_transport = CountingTransport::new("Woke AI name");
    let generator = Arc::new(SessionNameGenerator::new(
        settings_for(dir.path()),
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(cell.clone()),
        generation_transport.clone(),
    ));

    // One paused generation series and one armed native series.
    let gen_target = pending("h-paused");
    ensure_pending(&store, "h-paused", NamedProvider::Claude, Some("/w/paused"))
        .await
        .expect("ensure");
    arm_with_message(&store, gen_target.clone(), "freshclaude", "Paused message").await;
    let native_target = pending("h-native-behind");
    ensure_pending(
        &store,
        "h-native-behind",
        NamedProvider::Claude,
        Some("/w/native"),
    )
    .await
    .expect("ensure");
    rename_user(&store, native_target.clone(), "Manual Behind")
        .await
        .expect("manual rename");
    store
        .record_acquisition(
            native_target.clone(),
            verified_acquisition(claude_location("/h/.claude", "h-native-behind")),
        )
        .await
        .expect("acquire");
    struct ConfirmingNative;
    impl NativeNameBackend for ConfirmingNative {
        fn read(&self, _target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
            Box::pin(async move {
                NativeCallResult::Confirmed(NativeNameReadback {
                    title: Some("Manual Behind".to_string()),
                })
            })
        }
        fn write(&self, _attempt: NativeNameAttempt) -> NativeFuture<()> {
            Box::pin(async move { NativeCallResult::Confirmed(()) })
        }
        fn route_available(&self, _target: NativeNameTarget) -> NativeProbeFuture {
            Box::pin(async move { true })
        }
    }
    let native_backend = Arc::new(ConfirmingNative);

    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        native_backend.clone(),
        Arc::clone(&generator),
    );
    // The native series converges while generation is capability-paused.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let sync = get_one(&store, native_target.clone())
            .await
            .expect("record")
            .native_sync
            .expect("the manual name arms a series");
        if sync.status == freshell_protocol::session_names::NativeSyncStatus::Synced {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the native series must converge behind a paused generation series"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &gen_target),
        0,
        "the capability pause consumed nothing"
    );
    assert_eq!(generation_transport.calls(), 0, "no request went out");

    // The capability arrives (the shared key cell) and the wake resumes the
    // remaining work.
    cell.apply_settings_key_forced(Some("late-key"));
    generator.notify_capability_change();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(update) = get_one(&store, gen_target.clone()).await {
            if update.record.source == NameSource::FreshellAi {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the capability wake must resume the remaining work"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    worker.abort();
    assert_eq!(generation_transport.calls(), 1);
}

// ---------------------------------------------------------------------------
// Late-answer guards: protected sources reject, fallback upgrades permit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manual_and_accepted_ai_names_reject_late_output_but_fallback_upgrades_permit_it() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    // Manual: a rename during the dispatch rejects the late answer and
    // stops the series.
    let manual_target = pending("h-manual-late");
    ensure_pending(
        &store,
        "h-manual-late",
        NamedProvider::Claude,
        Some("/w/manual"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &store,
        manual_target.clone(),
        "freshclaude",
        "Manual race message",
    )
    .await;
    let claim = store
        .claim_generation_start(manual_target.clone(), "attempt-manual".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");
    rename_user(&store, manual_target.clone(), "Mine stays")
        .await
        .expect("manual rename during the request");
    store
        .fold_generation_outcome(
            manual_target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Late AI answer".to_string()),
        )
        .await
        .expect("the late fold resolves");
    let manual = get_one(&store, manual_target.clone())
        .await
        .expect("record");
    assert_eq!(manual.record.name, "Mine stays");
    assert_eq!(manual.record.source, NameSource::Manual);
    assert!(
        store
            .generation_work_snapshot()
            .iter()
            .all(|item| item.target != manual_target),
        "a manual name stops generation"
    );

    // Accepted Freshell AI: a second late answer is rejected (protected).
    let ai_target = pending("h-ai-late");
    ensure_pending(&store, "h-ai-late", NamedProvider::Claude, Some("/w/ai"))
        .await
        .expect("ensure");
    arm_with_message(&store, ai_target.clone(), "freshclaude", "AI race message").await;
    let claim = store
        .claim_generation_start(ai_target.clone(), "attempt-ai".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");
    store
        .fold_generation_outcome(
            ai_target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("First AI answer".to_string()),
        )
        .await
        .expect("the first answer accepts");
    store
        .fold_generation_outcome(
            ai_target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Second late answer".to_string()),
        )
        .await
        .expect("the late fold resolves");
    let ai = get_one(&store, ai_target.clone()).await.expect("record");
    assert_eq!(ai.record.name, "First AI answer");
    assert_eq!(ai.record.source, NameSource::FreshellAi);

    // Migration-protected labels reject late output the same way.
    let legacy_target = pending("h-legacy-late");
    ensure_pending(
        &store,
        "h-legacy-late",
        NamedProvider::Claude,
        Some("/w/legacy"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &store,
        legacy_target.clone(),
        "freshclaude",
        "Legacy race message",
    )
    .await;
    let claim = store
        .claim_generation_start(legacy_target.clone(), "attempt-legacy".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");
    store
        .offer(
            legacy_target.clone(),
            "Migrated label".to_string(),
            NameSource::LegacyProtected,
        )
        .await
        .expect("the migration-protected offer accepts");
    store
        .fold_generation_outcome(
            legacy_target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Late AI answer".to_string()),
        )
        .await
        .expect("the late fold resolves");
    let legacy = get_one(&store, legacy_target.clone())
        .await
        .expect("record");
    assert_eq!(legacy.record.name, "Migrated label");
    assert_eq!(legacy.record.source, NameSource::LegacyProtected);

    // A fallback upgrade (provider rank, still below Freshell AI) does NOT
    // invalidate the in-flight answer.
    let upgrade_target = pending("h-upgrade");
    ensure_pending(
        &store,
        "h-upgrade",
        NamedProvider::Opencode,
        Some("/w/upgrade"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &store,
        upgrade_target.clone(),
        "freshopencode",
        "Upgrade race message",
    )
    .await;
    let claim = store
        .claim_generation_start(upgrade_target.clone(), "attempt-upgrade".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");
    observe_provider_title(&store, upgrade_target.clone(), "Mid-flight provider title")
        .await
        .expect("the provider fallback upgrades mid-flight");
    store
        .fold_generation_outcome(
            upgrade_target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Still useful AI answer".to_string()),
        )
        .await
        .expect("the useful answer folds");
    let upgraded = get_one(&store, upgrade_target.clone())
        .await
        .expect("record");
    assert_eq!(upgraded.record.name, "Still useful AI answer");
    assert_eq!(upgraded.record.source, NameSource::FreshellAi);
}

/// A re-armed series keeps its series id, so the input fingerprint is the
/// guard: a late answer generated from OLDER input must not be accepted,
/// while the re-armed input's own answer still lands.
#[tokio::test]
async fn a_rearmed_series_rejects_answers_from_older_input() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-rearm");
    ensure_pending(&store, "h-rearm", NamedProvider::Claude, Some("/w/rearm"))
        .await
        .expect("ensure");
    arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "First conversation message",
    )
    .await;
    let claim = store
        .claim_generation_start(target.clone(), "attempt-old".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");

    // A genuinely new message re-arms the series (new fingerprint).
    arm_with_message(
        &store,
        target.clone(),
        "freshclaude",
        "Second conversation message",
    )
    .await;

    // The OLD input's late answer is rejected.
    store
        .fold_generation_outcome(
            target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Stale answer for old input".to_string()),
        )
        .await
        .expect("the stale fold resolves");
    let stale = get_one(&store, target.clone()).await.expect("record");
    assert_eq!(stale.record.source, NameSource::FirstMessage);

    // The re-armed input's own answer still lands.
    let items = store.generation_work_snapshot();
    assert_eq!(items.len(), 1, "the re-armed series is dispatchable");
    store
        .fold_generation_outcome(
            target.clone(),
            items[0].series_id.clone(),
            items[0].input_fingerprint.clone(),
            GenerationOutcome::Answer("Fresh answer for new input".to_string()),
        )
        .await
        .expect("the fresh fold accepts");
    let fresh = get_one(&store, target.clone()).await.expect("record");
    assert_eq!(fresh.record.name, "Fresh answer for new input");
    assert_eq!(fresh.record.source, NameSource::FreshellAi);
}

// ---------------------------------------------------------------------------
// Index hydration: free fallbacks, never paid titles across history
// ---------------------------------------------------------------------------

/// Hydration installs the free fallbacks (provider title > first message >
/// directory basename) and NEVER schedules paid titles across history: the
/// absorbed series rests Idle, out of the selector, and stays that way
/// across repeated hydration; a genuinely new message arms it.
#[tokio::test]
async fn hydration_installs_free_fallbacks_and_never_schedules_paid_titles() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    // A provider-titled session with a first message: the provider title
    // wins the free fallbacks, and the message is absorbed at rest.
    let titled = session(NamedProvider::Opencode, "ses_titled");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Opencode,
                session_id: "ses_titled".to_string(),
                cwd: Some("/w/titled".to_string()),
                first_user_message: Some("The named session's real first message".to_string()),
                provider_title: Some("Opencode's own title".to_string()),
            },
            true,
        )
        .await
        .expect("hydrate");
    let record = get_one(&store, titled.clone()).await.expect("record");
    assert_eq!(record.record.source, NameSource::ProviderAi);
    assert_eq!(record.record.name, "Opencode's own title");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_status(&doc, &titled).as_deref(),
        Some("idle"),
        "the absorbed series rests"
    );
    assert!(
        store.generation_work_snapshot().is_empty(),
        "hydration never schedules paid titles across history"
    );

    // A message-less session installs the directory basename.
    let plain = session(NamedProvider::Claude, "ses_plain");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: "ses_plain".to_string(),
                cwd: Some("/w/plainproj".to_string()),
                first_user_message: None,
                provider_title: None,
            },
            true,
        )
        .await
        .expect("hydrate");
    let record = get_one(&store, plain.clone()).await.expect("record");
    assert_eq!(record.record.source, NameSource::Directory);
    assert_eq!(record.record.name, "plainproj");

    // Repeated hydration is idempotent: an established record never moves.
    let gen_before = document_json(dir.path())["documentGeneration"]
        .as_u64()
        .unwrap();
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Opencode,
                session_id: "ses_titled".to_string(),
                cwd: Some("/w/titled".to_string()),
                first_user_message: Some("The named session's real first message".to_string()),
                provider_title: Some("Opencode's own title".to_string()),
            },
            true,
        )
        .await
        .expect("re-hydrate");
    assert_eq!(
        document_json(dir.path())["documentGeneration"]
            .as_u64()
            .unwrap(),
        gen_before,
        "an existing record is returned unchanged"
    );

    // A genuinely newly observed message (a later pass) arms generation.
    activity(
        &store,
        titled.clone(),
        "opencode",
        "e-new-message",
        NameActivityReason::IndexUserMessage,
        Some("A brand new second turn message"),
    )
    .await
    .expect("the new message arms");
    assert!(
        store
            .generation_work_snapshot()
            .iter()
            .any(|item| item.target == titled),
        "a newly observed message makes the session eligible"
    );
}

/// Round-2 carried finding F2 (adjudicated): a provider title that fails
/// accepted-name validation (over the 200-scalar cap, or control
/// characters) must not ABORT hydration for that session — the ladder
/// falls through to the first-message extraction, then the directory
/// basename, exactly like an absent title. An abort left the session with
/// NO canonical record while the ~5s sweep re-failed and re-logged it
/// every pass.
#[tokio::test]
async fn an_invalid_provider_title_falls_through_the_fallback_ladder() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    // Oversize title + a real first message: the first-message rung serves.
    let oversize = session(NamedProvider::Opencode, "ses_oversize");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Opencode,
                session_id: "ses_oversize".to_string(),
                cwd: Some("/w/oversize".to_string()),
                first_user_message: Some("The message that names the session".to_string()),
                provider_title: Some("x".repeat(201)),
            },
            true,
        )
        .await
        .expect("an oversize provider title falls through, never aborts");
    let record = get_one(&store, oversize.clone())
        .await
        .expect("the record exists");
    assert_eq!(record.record.source, NameSource::FirstMessage);
    assert_eq!(record.record.name, "The message that names the session");

    // Control characters + no usable first message: the directory rung
    // serves (the directory fallback validates the basename away).
    let control = session(NamedProvider::Claude, "ses_control");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: "ses_control".to_string(),
                cwd: Some("/w/controlproj".to_string()),
                first_user_message: None,
                provider_title: Some("bad\u{0007}title".to_string()),
            },
            true,
        )
        .await
        .expect("a control-character provider title falls through");
    let record = get_one(&store, control.clone())
        .await
        .expect("the record exists");
    assert_eq!(record.record.source, NameSource::Directory);
    assert_eq!(record.record.name, "controlproj");

    // A VALID provider title still wins the ladder (the fall-through must
    // not over-apply).
    let valid = session(NamedProvider::Opencode, "ses_valid");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Opencode,
                session_id: "ses_valid".to_string(),
                cwd: Some("/w/valid".to_string()),
                first_user_message: Some("A message that would lose".to_string()),
                provider_title: Some("A perfectly fine title".to_string()),
            },
            true,
        )
        .await
        .expect("hydrate");
    let record = get_one(&store, valid.clone()).await.expect("record");
    assert_eq!(record.record.source, NameSource::ProviderAi);
    assert_eq!(record.record.name, "A perfectly fine title");
}

/// The explicit-open hook: binding a pending handle (an explicit
/// create/open/resume lane) arms an unattempted absorbed series — history
/// stays unpurchased until the user actually opens the session.
#[tokio::test]
async fn an_explicit_open_arms_an_absorbed_unattempted_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let historical = session(NamedProvider::Codex, "ses_historical");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Codex,
                session_id: "ses_historical".to_string(),
                cwd: Some("/w/historical".to_string()),
                first_user_message: Some("Historical first message".to_string()),
                provider_title: None,
            },
            true,
        )
        .await
        .expect("hydrate");
    assert!(
        store.generation_work_snapshot().is_empty(),
        "history alone never schedules the paid title"
    );

    // The explicit open: a pending handle transfers onto the durable record.
    let handle = pending("h-explicit-open");
    ensure_pending(
        &store,
        "h-explicit-open",
        NamedProvider::Codex,
        Some("/w/historical"),
    )
    .await
    .expect("ensure");
    store
        .bind_pending(BindNameInput {
            pending: handle.clone(),
            target: historical.clone(),
            acquisition: verified_acquisition(NativeLocation::Codex {
                codex_home: "/w/homes/codex".to_string(),
                native_thread_id: Some("ses_historical".to_string()),
                rollout_path: None,
                persistence_evidence: None,
            }),
        })
        .await
        .expect("the explicit open binds");
    assert!(
        store
            .generation_work_snapshot()
            .iter()
            .any(|item| item.target == historical),
        "the explicit open armed the unattempted series"
    );

    // Opened/Resumed activity only arms an UNATTEMPTED series: a series with
    // consumed starts is never reset by a reopen.
    let attempted = pending("h-attempted-reopen");
    ensure_pending(
        &store,
        "h-attempted-reopen",
        NamedProvider::Claude,
        Some("/w/reopen"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &store,
        attempted.clone(),
        "freshclaude",
        "Attempted message",
    )
    .await;
    let claim = store
        .claim_generation_start(attempted.clone(), "attempt-reopen".to_string())
        .await
        .expect("claim runs")
        .expect("claimable");
    store
        .fold_generation_outcome(
            attempted.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Failed("scripted failure".to_string()),
        )
        .await
        .expect("failure folds");
    let due_before =
        generation_next_due(&document_json(dir.path()), &attempted).expect("scheduled");
    activity(
        &store,
        attempted.clone(),
        "freshclaude",
        "e-reopen",
        NameActivityReason::Resumed,
        Some("Attempted message"),
    )
    .await
    .expect("the reopen folds");
    assert_eq!(
        generation_next_due(&document_json(dir.path()), &attempted),
        Some(due_before),
        "a reopen never resets an attempted series' schedule"
    );
}

/// Binding colliding series unions the generation budgets conservatively
/// (the combined consumed count caps at three).
#[tokio::test]
async fn binding_competing_series_preserves_conservative_consumed_counts() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let durable = session(NamedProvider::Codex, "ses_comp");
    ensure_pending(
        &store,
        "h-comp-durable",
        NamedProvider::Codex,
        Some("/w/compd"),
    )
    .await
    .expect("ensure durable side");
    set_test_hooks(dir.path(), vec![TestHook::ClockOffsetMs(0)]);
    arm_with_message(
        &store,
        pending("h-comp-durable"),
        "freshcodex",
        "Durable side message",
    )
    .await;
    for (index, attempt) in ["attempt-d1", "attempt-d2"].into_iter().enumerate() {
        if index > 0 {
            set_test_hooks(
                dir.path(),
                vec![TestHook::ClockOffsetMs(GENERATION_RETRY_1_MS)],
            );
        }
        let claim = store
            .claim_generation_start(pending("h-comp-durable"), attempt.to_string())
            .await
            .expect("claim runs")
            .expect("consume durable start");
        store
            .fold_generation_outcome(
                pending("h-comp-durable"),
                claim.series_id.clone(),
                claim.input_fingerprint.clone(),
                GenerationOutcome::Failed("scripted".to_string()),
            )
            .await
            .expect("the failure folds between starts");
    }
    store
        .bind_pending(BindNameInput {
            pending: pending("h-comp-durable"),
            target: durable.clone(),
            acquisition: verified_acquisition(NativeLocation::Codex {
                codex_home: "/w/homes/codex".to_string(),
                native_thread_id: Some("ses_comp".to_string()),
                rollout_path: None,
                persistence_evidence: None,
            }),
        })
        .await
        .expect("bind durable side");

    ensure_pending(
        &store,
        "h-comp-pending",
        NamedProvider::Codex,
        Some("/w/compp"),
    )
    .await
    .expect("ensure pending side");
    arm_with_message(
        &store,
        pending("h-comp-pending"),
        "freshcodex",
        "Pending side message",
    )
    .await;
    store
        .claim_generation_start(pending("h-comp-pending"), "attempt-p1".to_string())
        .await
        .expect("claim runs")
        .expect("consume pending start");

    store
        .bind_pending(BindNameInput {
            pending: pending("h-comp-pending"),
            target: durable.clone(),
            acquisition: verified_acquisition(NativeLocation::Codex {
                codex_home: "/w/homes/codex".to_string(),
                native_thread_id: Some("ses_comp".to_string()),
                rollout_path: None,
                persistence_evidence: None,
            }),
        })
        .await
        .expect("the colliding bind resolves");
    let doc = document_json(dir.path());
    assert_eq!(
        generation_consumed(&doc, &durable),
        MAX_GENERATION_STARTS as u64,
        "the combined budget caps at three"
    );
    assert_eq!(
        generation_status(&doc, &durable).as_deref(),
        Some("exhausted"),
        "the union exhausts at the cap"
    );
    clear_test_hooks(dir.path());
}

/// The targeted first-message lookup for an already-named opencode session
/// (opencode names parent sessions itself, so the bounded listing carries
/// no first message for them) — and `needs_generation_input` bounds it: an
/// exhausted or protected session never pays the lookup again.
#[tokio::test]
async fn the_targeted_opencode_lookup_serves_eligibility_and_is_bounded() {
    let data_home = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(data_home.path()).unwrap();
    let conn = rusqlite::Connection::open(data_home.path().join("opencode.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );
         CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session VALUES ('ses_named', '/w/lookup',
            'Opencode named it', 1000, 5000, NULL, NULL, NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        r#"INSERT INTO message VALUES ('msg_1', 'ses_named', 100, '{"role":"user"}')"#,
        [],
    )
    .unwrap();
    conn.execute(
        r#"INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_named',
            '{"type":"text","text":"The hidden first message"}')"#,
        [],
    )
    .unwrap();
    drop(conn);

    let sources: Vec<Arc<dyn freshell_sessions::directory_index::SessionSource>> = vec![Arc::new(
        freshell_sessions::directory_index::OpencodeSource::new(data_home.path().to_path_buf()),
    )];
    let index = freshell_sessions::directory_index::SessionIndex::with_ttl_and_cache_path(
        sources,
        Duration::from_millis(1_000),
        None,
    );
    let first = index.opencode_first_user_message("ses_named");
    assert_eq!(
        first.as_deref(),
        Some("The hidden first message"),
        "an already-named opencode session's first message is served on demand"
    );
    assert!(
        index.opencode_first_user_message("ses_missing").is_none(),
        "a missing session answers None"
    );

    // The store-side bound: a fresh record needs input; a series that has
    // already CAPTURED its input fingerprint does not (review M4: first
    // messages are immutable, so the targeted sqlite lookup serves only
    // INITIAL eligibility — an armed-unexhausted named session with a
    // captured fingerprint never pays the spawn_blocking query again);
    // an exhausted or protected record does not either.
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let fresh = session(NamedProvider::Opencode, "ses_lookup");
    assert!(
        store.needs_generation_input(&fresh),
        "an absent record needs hydration input"
    );
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Opencode,
                session_id: "ses_lookup".to_string(),
                cwd: Some("/w/lookup".to_string()),
                first_user_message: Some("Lookup message".to_string()),
                provider_title: Some("Opencode named it".to_string()),
            },
            true,
        )
        .await
        .expect("hydrate");
    assert!(
        !store.needs_generation_input(&fresh),
        "an absorbed series already carries its input fingerprint — the lookup has no remaining eligibility value"
    );
    let handle = pending("h-lookup-open");
    ensure_pending(
        &store,
        "h-lookup-open",
        NamedProvider::Opencode,
        Some("/w/lookup"),
    )
    .await
    .expect("ensure");
    store
        .bind_pending(BindNameInput {
            pending: handle.clone(),
            target: fresh.clone(),
            acquisition: verified_acquisition(NativeLocation::Opencode {
                database_path: data_home.path().join("opencode.db").display().to_string(),
                native_session_id: Some("ses_lookup".to_string()),
                original_directory: Some("/w/lookup".to_string()),
                owned_local_endpoint: None,
            }),
        })
        .await
        .expect("the explicit open binds");
    assert!(
        !store.needs_generation_input(&fresh),
        "an ARMED series carries its captured fingerprint — the targeted lookup never runs again for it"
    );
    set_test_hooks(dir.path(), vec![TestHook::ClockOffsetMs(0)]);
    for (index, attempt) in ["a1", "a2", "a3"].into_iter().enumerate() {
        if index > 0 {
            set_test_hooks(
                dir.path(),
                vec![TestHook::ClockOffsetMs(
                    GENERATION_RETRY_1_MS * index as i64
                        + GENERATION_RETRY_2_MS * (index as i64 - 1),
                )],
            );
        }
        store
            .claim_generation_start(fresh.clone(), attempt.to_string())
            .await
            .expect("claim runs")
            .expect("consume");
        let claim_series = generation_entry(&document_json(dir.path()), &fresh)
            .and_then(|e| e["seriesId"].as_str())
            .map(str::to_string)
            .expect("series id");
        let fingerprint = generation_entry(&document_json(dir.path()), &fresh)
            .and_then(|e| e["inputFingerprint"].as_str())
            .map(str::to_string)
            .expect("fingerprint");
        store
            .fold_generation_outcome(
                fresh.clone(),
                claim_series,
                fingerprint,
                GenerationOutcome::Failed("scripted".to_string()),
            )
            .await
            .expect("failure folds");
    }
    assert_eq!(
        generation_status(&document_json(dir.path()), &fresh).as_deref(),
        Some("exhausted")
    );
    assert!(
        !store.needs_generation_input(&fresh),
        "an exhausted session never pays the lookup again"
    );
    clear_test_hooks(dir.path());
    let manual_target = session(NamedProvider::Opencode, "ses_manual_bound");
    store
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Opencode,
                session_id: "ses_manual_bound".to_string(),
                cwd: Some("/w/manual".to_string()),
                first_user_message: Some("Manual bound message".to_string()),
                provider_title: None,
            },
            true,
        )
        .await
        .expect("hydrate the manual record");
    rename_user(&store, manual_target.clone(), "Manual named")
        .await
        .expect("manual rename");
    assert!(
        !store.needs_generation_input(&manual_target),
        "a protected record never pays the lookup"
    );
}

// ---------------------------------------------------------------------------
// The shared worker's selection (unit-pinnable policy)
// ---------------------------------------------------------------------------

/// The generation selector orders by earliest nextDue (an unarmed series is
/// immediately ready), then the stable name-reference key; the class
/// selector alternates by the persisted cursor when both classes have ready
/// work.
#[test]
fn the_selector_orders_generation_by_due_then_key_and_alternates_classes() {
    let item = |key: &str, due: Option<i64>| super::GenerationWorkItem {
        target: pending(key),
        series_id: format!("series-{key}"),
        input_fingerprint: format!("fp-{key}"),
        excerpt: Some("excerpt".to_string()),
        consumed: 0,
        next_due: due,
    };
    let a = item("a-key", Some(5_000));
    let b = item("b-key", None);
    let c = item("c-key", Some(1_000));
    let picked = crate::session_name_native::select_generation(&[a.clone(), b.clone(), c.clone()]);
    assert_eq!(
        picked.unwrap().target,
        b.target,
        "an immediately-ready series orders first"
    );
    let picked = crate::session_name_native::select_generation(&[a.clone(), c.clone()]);
    assert_eq!(picked.unwrap().target, c.target, "earliest due wins");
    let d = item("a-key", Some(1_000));
    let picked = crate::session_name_native::select_generation(&[d.clone(), c.clone()]);
    assert_eq!(
        picked.unwrap().target,
        d.target,
        "equal due falls back to the stable name-reference key"
    );

    // The alternation: with both classes ready, the class flips by the
    // persisted cursor.
    let native_item = crate::session_name_native::NativeWorkItem {
        target: pending("n"),
        location: claude_location("/h/.claude", "n"),
        location_revision: 1,
        desired_revision: 1,
        desired_name: "x".to_string(),
        desired_source: NameSource::Manual,
        cycles_consumed: 0,
        next_due: None,
    };
    let mut backoff = std::collections::HashMap::new();
    let picked = crate::session_name_native::select_work(
        std::slice::from_ref(&native_item),
        &[item("g", None)],
        None,
        &mut backoff,
    );
    assert!(matches!(
        picked,
        Some(crate::session_name_native::WorkSelection::Native(_))
    ));
    let picked = crate::session_name_native::select_work(
        std::slice::from_ref(&native_item),
        &[item("g", None)],
        Some("native"),
        &mut backoff,
    );
    assert!(matches!(
        picked,
        Some(crate::session_name_native::WorkSelection::Generation(_))
    ));
    let picked = crate::session_name_native::select_work(
        std::slice::from_ref(&native_item),
        &[item("g", None)],
        Some("generation"),
        &mut backoff,
    );
    assert!(matches!(
        picked,
        Some(crate::session_name_native::WorkSelection::Native(_))
    ));
    // One ready class serves itself regardless of the cursor.
    let picked = crate::session_name_native::select_work(
        &[],
        &[item("g", None)],
        Some("generation"),
        &mut backoff,
    );
    assert!(matches!(
        picked,
        Some(crate::session_name_native::WorkSelection::Generation(_))
    ));
}

/// Under sustained native requests the worker alternates classes: with equal
/// native and generation backlogs, no class is served twice in a row while
/// the other still has ready work.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_worker_alternates_native_and_generation_under_sustained_native_requests() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let order: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));

    struct LoggingNative {
        order: Arc<Mutex<Vec<&'static str>>>,
    }
    impl NativeNameBackend for LoggingNative {
        fn read(&self, _t: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
            Box::pin(async move {
                // A matching readback synchronizes the cycle immediately:
                // each armed native series serves EXACTLY one cycle now.
                NativeCallResult::Confirmed(NativeNameReadback {
                    title: Some("Manual native".to_string()),
                })
            })
        }
        fn write(&self, _attempt: NativeNameAttempt) -> NativeFuture<()> {
            Box::pin(async move { NativeCallResult::Confirmed(()) })
        }
        fn route_available(&self, _t: NativeNameTarget) -> NativeProbeFuture {
            // One log entry per DISPATCHED cycle — the dispatch order pin.
            self.order.lock().unwrap().push("native");
            Box::pin(async move { true })
        }
    }
    struct LoggingGeneration {
        order: Arc<Mutex<Vec<&'static str>>>,
    }
    impl GeminiTransport for LoggingGeneration {
        fn generate_content(&self, _p: String, _m: u32) -> BoxFuture<Result<String, String>> {
            self.order.lock().unwrap().push("generation");
            Box::pin(async move { Ok("Alternating AI".to_string()) })
        }
    }

    // Four manual native series and four armed generation series.
    for key in ["n1", "n2", "n3", "n4"] {
        let target = pending(key);
        ensure_pending(&store, key, NamedProvider::Claude, Some("/w/alt"))
            .await
            .expect("ensure");
        rename_user(&store, target.clone(), "Manual native")
            .await
            .expect("manual");
        store
            .record_acquisition(
                target.clone(),
                verified_acquisition(claude_location("/h/.claude", key)),
            )
            .await
            .expect("acquire");
    }
    for key in ["g1", "g2", "g3", "g4"] {
        let target = pending(key);
        ensure_pending(&store, key, NamedProvider::Claude, Some("/w/alt"))
            .await
            .expect("ensure");
        arm_with_message(&store, target.clone(), "freshclaude", "Alternating message").await;
    }

    let generator = Arc::new(SessionNameGenerator::new(
        settings_for(dir.path()),
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(AiKeyCell::init(
            Some("alt-key".to_string()),
            None,
        )),
        Arc::new(LoggingGeneration {
            order: Arc::clone(&order),
        }),
    ));
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        Arc::new(LoggingNative {
            order: Arc::clone(&order),
        }),
        Arc::clone(&generator),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let named = match store.get(vec![pending("g4")]).await {
            Ok(updates) => updates
                .into_iter()
                .next()
                .and_then(|u| (u.record.source == NameSource::FreshellAi).then_some(u)),
            // The worker is intentionally writing the same document. A
            // bounded lock miss is a valid read result; keep polling until
            // the overall completion deadline instead of failing this race.
            Err(NameError::LockUnavailable(_)) => None,
            Err(error) => panic!("get: {error:?}"),
        };
        if named.is_some() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the generation backlog must drain"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    let served = order.lock().unwrap().clone();
    assert!(served.len() >= 8, "both backlogs were served: {served:?}");
    // While both classes still had ready work, no class served twice in a
    // row: the first min(4,4)*2 = 8 dispatches alternate.
    let native_total: usize = served.iter().filter(|c| **c == "native").count();
    let generation_total: usize = served.iter().filter(|c| **c == "generation").count();
    assert!(native_total >= 4 && generation_total >= 4, "{served:?}");
    for pair in served.windows(2) {
        if pair[0] == pair[1] {
            // Only the tail (after one class drained) may repeat — never the
            // head while both were loaded.
            panic!("the worker served one class twice in a row: {served:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-process worker contention (two REAL processes; re-exec roles)
// ---------------------------------------------------------------------------

const ROLE_ENV: &str = "FRESHELL_TEST_SGEN_ROLE";
const DIR_ENV: &str = "FRESHELL_TEST_SGEN_DIR";

fn child_env(dir: &Path, role: &str) -> std::process::Command {
    let exe = std::env::current_exe().expect("test binary path");
    let mut command = std::process::Command::new(exe);
    command
        .args([
            "--exact",
            "session_name_generation::tests::worker_contention",
        ])
        .env(ROLE_ENV, role)
        .env(DIR_ENV, dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
}

/// Child role: run a real worker against the shared document until the stop
/// sentinel appears. The transport answers immediately and counts its
/// requests; the gate variant holds its FIRST request on a file barrier so
/// the parent can prove what completes while a provider operation is held.
async fn run_worker_child_role(role: &str, dir: &Path) {
    let stop_path = dir.join("child-stop");
    let store = open_store(dir);
    if role == "worker" {
        std::fs::write(dir.join("child-ready"), b"ready").expect("signal child store open");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !dir.join("child-start").exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "parent never started workers"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let cell = AiKeyCell::init(Some("child-key".to_string()), None);
    let settings = settings_for(dir);
    let (transport, native): (Arc<dyn GeminiTransport>, Arc<dyn NativeNameBackend>) = match role {
        "worker" => (
            CountingTransport::new("Child AI name"),
            Arc::new(NoRouteNative),
        ),
        "gated_worker" => (
            Arc::new(FileGatedTransport {
                calls: AtomicU32::new(0),
                answer: "Gated AI name".to_string(),
                gate_path: dir.join("gemini-release"),
                held_sentinel: dir.join("request-held"),
            }),
            Arc::new(NoRouteNative),
        ),
        "failing_worker" => (FailingTransport::new(), Arc::new(NoRouteNative)),
        other => panic!("unknown child role {other}"),
    };
    let generator = Arc::new(SessionNameGenerator::new(
        settings,
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(cell),
        transport,
    ));
    let worker = SessionNameWorker::start(store, native, generator);
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while !stop_path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "the parent never stopped the child worker"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    std::process::exit(0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_contention() {
    if let Ok(role) = std::env::var(ROLE_ENV) {
        if !role.is_empty() {
            let dir = PathBuf::from(std::env::var(DIR_ENV).expect("child data dir"));
            run_worker_child_role(&role, &dir).await;
        }
    }

    let dir = temp_data_dir();
    let data_dir = dir.path().to_path_buf();

    // -- Part 1: 30 sessions, two real workers, no duplicate claims --------
    let parent_store = open_store(&data_dir);
    for index in 0..30 {
        let handle = format!("h-two-{index:02}");
        let target = pending(&handle);
        ensure_pending(
            &parent_store,
            &handle,
            NamedProvider::Claude,
            Some("/w/two"),
        )
        .await
        .expect("ensure");
        arm_with_message(
            &parent_store,
            target,
            "freshclaude",
            &format!("Thirty-session queue message {index}"),
        )
        .await;
    }
    // Finish seeding before starting the second process: its initial store
    // open is a bounded transaction, not part of the worker contention.
    let child = child_env(&data_dir, "worker")
        .spawn()
        .expect("spawn child worker");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !data_dir.join("child-ready").exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "child did not open its store"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let parent_transport = CountingTransport::new("Parent AI name");
    let parent_generator = generator_with(&data_dir, Some("parent-key"), parent_transport.clone());
    std::fs::write(data_dir.join("child-start"), b"start").unwrap();
    let parent_worker = SessionNameWorker::start(
        Arc::clone(&parent_store),
        Arc::new(NoRouteNative),
        parent_generator,
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let mut named = 0;
        let updates = match parent_store
            .get(
                (0..30)
                    .map(|index| pending(&format!("h-two-{index:02}")))
                    .collect(),
            )
            .await
        {
            Ok(updates) => updates,
            Err(NameError::LockUnavailable(_)) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "document remained locked while workers ran"
                );
                continue;
            }
            Err(error) => panic!("batch get: {error:?}"),
        };
        for update in updates {
            if update.record.source == NameSource::FreshellAi {
                named += 1;
            }
        }
        if named == 30 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "every ready session must eventually be served (named {named}/30)"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    std::fs::write(data_dir.join("child-stop"), b"stop").unwrap();
    let output = child.wait_with_output().expect("child exits");
    assert!(
        output.status.success(),
        "child worker exited cleanly: status={}, stdout={}, stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    parent_worker.abort();
    let doc = document_json(&data_dir);
    let generation = doc["generation"].as_object().expect("generation section");
    assert_eq!(generation.len(), 30);
    let mut all_attempt_ids: Vec<&str> = Vec::new();
    for (key, series) in generation {
        assert_eq!(
            series["consumed"].as_u64(),
            Some(1),
            "{key}: exactly one claimed attempt per session"
        );
        assert_eq!(series["status"].as_str(), Some("idle"));
        for id in series["attemptIds"].as_array().expect("attempt ids") {
            all_attempt_ids.push(id.as_str().expect("id"));
        }
    }
    all_attempt_ids.sort();
    all_attempt_ids.dedup();
    assert_eq!(all_attempt_ids.len(), 30, "no duplicate claims");

    // -- Part 2: a manual rename from the second process completes while a
    //    worker holds a 20-second provider operation ----------------------
    let gated_dir = temp_data_dir();
    let gated_data = gated_dir.path().to_path_buf();
    let gated_store = open_store(&gated_data);
    let gated_target = pending("h-gated");
    ensure_pending(
        &gated_store,
        "h-gated",
        NamedProvider::Claude,
        Some("/w/gated"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &gated_store,
        gated_target.clone(),
        "freshclaude",
        "The gated provider request message",
    )
    .await;
    let manual_target = pending("h-manual-second");
    ensure_pending(
        &gated_store,
        "h-manual-second",
        NamedProvider::Claude,
        Some("/w/manual2"),
    )
    .await
    .expect("ensure");
    let gated_child = child_env(&gated_data, "gated_worker")
        .spawn()
        .expect("spawn gated child worker");
    let held = gated_data.join("request-held");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !held.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the gated worker never dispatched its held request"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // While the child holds the provider operation (and the worker guard),
    // the second process's manual rename must still commit and read.
    let renamed = rename_user(&gated_store, manual_target.clone(), "Second process manual")
        .await
        .expect("the manual rename commits while the provider operation is held");
    assert_eq!(renamed.record.name, "Second process manual");
    let read_back = get_one(&gated_store, manual_target.clone())
        .await
        .expect("the renamed record reads back");
    assert_eq!(read_back.record.name, "Second process manual");
    std::fs::write(gated_data.join("gemini-release"), b"release").unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(update) = get_one(&gated_store, gated_target.clone()).await {
            if update.record.source == NameSource::FreshellAi {
                assert_eq!(update.record.name, "Gated AI name");
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the released gated answer must save"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    std::fs::write(gated_data.join("child-stop"), b"stop").unwrap();
    let output = gated_child.wait_with_output().expect("gated child exits");
    assert!(output.status.success());

    // -- Part 3: no worker lock is held across a retry delay ---------------
    let retry_dir = temp_data_dir();
    let retry_data = retry_dir.path().to_path_buf();
    let retry_store = open_store(&retry_data);
    let retry_target = pending("h-retry-delay");
    ensure_pending(
        &retry_store,
        "h-retry-delay",
        NamedProvider::Claude,
        Some("/w/retryd"),
    )
    .await
    .expect("ensure");
    arm_with_message(
        &retry_store,
        retry_target.clone(),
        "freshclaude",
        "The retry delay lock message",
    )
    .await;
    let retry_child = child_env(&retry_data, "failing_worker")
        .spawn()
        .expect("spawn failing child worker");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let doc = document_json(&retry_data);
        if generation_consumed(&doc, &retry_target) == 1
            && generation_next_due(&doc, &retry_target).is_some()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the failing worker never consumed its first attempt"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // The retry delay (30s out) holds neither lock: this process can take
    // the worker guard within a bounded window (the child only ever holds it
    // around an actual dispatch, never across the delay).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let guard = loop {
        match retry_store
            .try_background_guard()
            .expect("the guard file is healthy")
        {
            Some(guard) => break guard,
            None => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "no worker lock is held across a retry delay"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    };
    drop(guard);
    std::fs::write(retry_data.join("child-stop"), b"stop").unwrap();
    let output = retry_child.wait_with_output().expect("retry child exits");
    assert!(output.status.success());
}

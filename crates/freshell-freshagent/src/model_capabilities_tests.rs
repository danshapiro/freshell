//! Tests for `model_capabilities.rs` — ports of
//! `test/unit/server/fresh-agent/model-capability-registry.test.ts` (registry
//! semantics) plus route-level coverage of `model-capabilities-router.ts`
//! (400/200/503, auth, cwd query plumbing).

use super::*;
use axum::body::Body;
use axum::http::Request;
use serde_json::json;
use std::collections::VecDeque;
use tokio::sync::Notify;
use tower::util::ServiceExt;

// ── fakes ─────────────────────────────────────────────────────────────────────

/// Scripted probe: records every cwd it is asked about, replies FIFO, and can
/// optionally gate responses on a `Notify` the test controls (single-flight).
#[derive(Default)]
struct RecordingProbe {
    calls: Mutex<Vec<Option<String>>>,
    responses: Mutex<VecDeque<CatalogOut>>,
    gate: Option<Arc<Notify>>,
}

impl RecordingProbe {
    fn new() -> Self {
        Self::default()
    }
    fn gated() -> (Arc<Self>, Arc<Notify>) {
        let gate = Arc::new(Notify::new());
        (
            Arc::new(Self {
                gate: Some(gate.clone()),
                ..Self::default()
            }),
            gate,
        )
    }
    async fn push_ok(&self, models: Vec<ModelCapability>) {
        self.responses.lock().await.push_back(Ok(models));
    }
    async fn push_err(&self, err: CapabilityError) {
        self.responses.lock().await.push_back(Err(err));
    }
    async fn call_count(&self) -> usize {
        self.calls.lock().await.len()
    }
    async fn calls(&self) -> Vec<Option<String>> {
        self.calls.lock().await.clone()
    }
}

impl ModelCatalogProbe for RecordingProbe {
    fn probe<'a>(&'a self, cwd: Option<&'a str>) -> BoxFuture<'a, CatalogOut> {
        Box::pin(async move {
            self.calls.lock().await.push(cwd.map(|s| s.to_string()));
            let next = self.responses.lock().await.pop_front().unwrap_or_else(|| {
                Err(CapabilityError {
                    code: "CAPABILITY_PROBE_FAILED".into(),
                    message: "no scripted response".into(),
                    retryable: true,
                })
            });
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
            next
        })
    }
}

fn cap(id: &str, display: &str, source_id: Option<&str>) -> ModelCapability {
    ModelCapability {
        id: id.to_string(),
        display_name: display.to_string(),
        provider: "opencode",
        source: source_id.map(|s| freshell_opencode::catalog::ModelCapabilitySource {
            id: s.to_string(),
            display_name: s.to_string(),
        }),
        supports_effort: true,
        supported_effort_levels: ["minimal", "low", "medium", "high", "max"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        supports_adaptive_thinking: true,
    }
}

fn glm() -> Vec<ModelCapability> {
    vec![cap("opencode-go/glm-5.2", "GLM 5.2", Some("opencode-go"))]
}

fn gemini() -> Vec<ModelCapability> {
    vec![cap("google/gemini-3-pro", "Gemini 3 Pro", Some("google"))]
}

fn registry_with(
    probe: Arc<RecordingProbe>,
) -> (ModelCapabilityRegistry, Arc<std::sync::Mutex<u64>>) {
    let now = Arc::new(std::sync::Mutex::new(1_000u64));
    let now_clone = now.clone();
    let registry = ModelCapabilityRegistry::with_clock(
        probe,
        Arc::new(move || *now_clone.lock().unwrap()),
        Duration::from_millis(5_000),
    );
    (registry, now)
}

fn expected_model_json(m: &ModelCapability) -> Value {
    serde_json::to_value(m).unwrap()
}

#[tokio::test]
async fn claude_catalog_probes_live_models_and_shares_cache_with_kilroy() {
    let opencode = Arc::new(RecordingProbe::new());
    let claude = Arc::new(RecordingProbe::new());
    let mut model = cap("sonnet", "Claude Sonnet", None);
    model.provider = "claude";
    claude.push_ok(vec![model]).await;
    let (registry, _) = registry_with(opencode.clone());
    let registry = registry.with_claude_probe(claude.clone());
    let (status, first) = registry.get(SessionType::FreshClaude, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["models"][0]["id"], "sonnet");
    let (_, cached) = registry.get(SessionType::Kilroy, None).await;
    assert_eq!(cached["status"], "cached");
    assert_eq!(cached["sessionType"], "kilroy");
    assert_eq!(claude.call_count().await, 1);
    assert_eq!(opencode.call_count().await, 0);
    claude
        .push_err(CapabilityError {
            code: "CAPABILITY_PROBE_FAILED".into(),
            message: "login required".into(),
            retryable: true,
        })
        .await;
    let (status, failed) = registry.refresh(SessionType::FreshClaude, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(failed["status"], "unavailable");
    let (_, cached) = registry.get(SessionType::FreshClaude, None).await;
    assert_eq!(cached["models"][0]["id"], "sonnet");
}

// ── registry semantics (model-capability-registry.test.ts ports) ──────────────

/// Port of "caches OpenCode capabilities by cwd without probing Claude or live
/// session sidecars" (`registry.test.ts:387-419`).
#[tokio::test]
async fn opencode_catalog_caches_by_cwd() {
    let probe = Arc::new(RecordingProbe::new());
    probe.push_ok(glm()).await;
    probe.push_ok(gemini()).await;
    let (registry, _now) = registry_with(probe.clone());

    let (status_a, body_a) = registry
        .get(SessionType::FreshOpencode, Some("/repo/a".into()))
        .await;
    assert_eq!(status_a, StatusCode::OK);
    assert_eq!(body_a["status"], json!("fresh"));
    assert_eq!(body_a["models"][0]["id"], json!("opencode-go/glm-5.2"));

    let (_s, body_b) = registry
        .get(SessionType::FreshOpencode, Some("/repo/b".into()))
        .await;
    assert_eq!(body_b["models"][0]["id"], json!("google/gemini-3-pro"));

    // Repeat A within TTL → cached, no third probe.
    let (_s, body_a2) = registry
        .get(SessionType::FreshOpencode, Some("/repo/a".into()))
        .await;
    assert_eq!(body_a2["status"], json!("cached"));
    assert_eq!(probe.call_count().await, 2);
}

/// Port of the TTL arm of "coalesces concurrent refreshes, reuses successful
/// cache within ttl, and refreshes again after expiry" (`:133-185`).
#[tokio::test]
async fn cache_entry_expires_past_ttl_and_reprobes() {
    let probe = Arc::new(RecordingProbe::new());
    probe.push_ok(glm()).await;
    probe.push_ok(gemini()).await;
    let (registry, now) = registry_with(probe.clone());

    let (_s, first) = registry.get(SessionType::FreshOpencode, None).await;
    assert_eq!(first["status"], json!("fresh"));
    let (_s, cached) = registry.get(SessionType::FreshOpencode, None).await;
    assert_eq!(cached["status"], json!("cached"));
    assert_eq!(cached["fetchedAt"], json!(1_000));
    assert_eq!(probe.call_count().await, 1);

    *now.lock().unwrap() += 5_001;
    let (_s, reprobe) = registry.get(SessionType::FreshOpencode, None).await;
    assert_eq!(reprobe["status"], json!("fresh"));
    assert_eq!(reprobe["fetchedAt"], json!(6_001));
    assert_eq!(reprobe["models"][0]["id"], json!("google/gemini-3-pro"));
    assert_eq!(probe.call_count().await, 2);
}

/// Port of "keeps the last successful catalog after a failed refresh"
/// (`:223-266`).
#[tokio::test]
async fn failed_refresh_keeps_last_successful_cache() {
    let probe = Arc::new(RecordingProbe::new());
    probe.push_ok(glm()).await;
    let (registry, _now) = registry_with(probe.clone());

    let (status, first) = registry
        .get(SessionType::FreshOpencode, Some("/repo/a".into()))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["models"][0]["id"], json!("opencode-go/glm-5.2"));

    probe
        .push_err(CapabilityError {
            code: "CAPABILITY_PROBE_FAILED".into(),
            message: "probe failed".into(),
            retryable: true,
        })
        .await;
    let (status, refresh) = registry
        .refresh(SessionType::FreshOpencode, Some("/repo/a".into()))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        refresh,
        json!({
            "ok": false,
            "sessionType": "freshopencode",
            "runtimeProvider": "opencode",
            "status": "unavailable",
            "models": [],
            "error": {
                "code": "CAPABILITY_PROBE_FAILED",
                "message": "probe failed",
                "retryable": true,
            },
        })
    );

    // The cache kept the last success; get() stays within TTL → cached.
    let (status, after) = registry
        .get(SessionType::FreshOpencode, Some("/repo/a".into()))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["status"], json!("cached"));
    assert_eq!(after["models"][0]["id"], json!("opencode-go/glm-5.2"));
}

/// Port of the coalescing arm of `:133-185`: concurrent refreshes share ONE probe.
#[tokio::test]
async fn concurrent_refreshes_single_flight_one_probe() {
    let (probe, gate) = RecordingProbe::gated();
    probe.push_ok(glm()).await;
    let (registry, _now) = registry_with(probe.clone());
    let registry = Arc::new(registry);

    let a = {
        let registry = registry.clone();
        tokio::spawn(async move { registry.refresh(SessionType::FreshOpencode, None).await })
    };
    let b = {
        let registry = registry.clone();
        tokio::spawn(async move { registry.refresh(SessionType::FreshOpencode, None).await })
    };
    // Let both tasks enter the gate.
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    gate.notify_waiters();
    let ((status_a, body_a), (status_b, body_b)) = (a.await.unwrap(), b.await.unwrap());

    assert_eq!(status_a, StatusCode::OK);
    assert_eq!(status_b, StatusCode::OK);
    assert_eq!(body_a["status"], json!("fresh"));
    assert_eq!(body_b["status"], json!("fresh"));
    assert_eq!(probe.call_count().await, 1, "one probe served both waiters");
}

/// Blank cwd is the default cache key and reaches the probe as `None`
/// (`opencodeCacheKey`, `:256-261` + the `:302-306` trim).
#[tokio::test]
async fn blank_cwd_maps_to_default_cache_key() {
    let probe = Arc::new(RecordingProbe::new());
    probe.push_ok(glm()).await;
    let (registry, _now) = registry_with(probe.clone());

    let (_s, _) = registry
        .get(SessionType::FreshOpencode, Some("   ".into()))
        .await;
    assert_eq!(probe.calls().await, vec![None]);
}

/// Codex keeps its built-in catalog without starting a Claude or OpenCode probe.
#[tokio::test]
async fn codex_serves_static_catalog() {
    let probe = Arc::new(RecordingProbe::new());
    let (registry, _now) = registry_with(probe.clone());

    let (status, codex) = registry.get(SessionType::FreshCodex, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        codex,
        json!({
            "ok": true,
            "sessionType": "freshcodex",
            "runtimeProvider": "codex",
            "status": "fresh",
            "fetchedAt": 1_000,
            "models": [
                {
                    "id": "gpt-5.5",
                    "displayName": "GPT-5.5",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["none", "minimal", "low", "medium", "high", "max"],
                    "supportsAdaptiveThinking": true,
                },
                {
                    "id": "gpt-5.4-flash",
                    "displayName": "GPT-5.4 Flash",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["none", "minimal", "low", "medium", "high"],
                    "supportsAdaptiveThinking": true,
                },
                {
                    "id": "gpt-5.3-codex-spark",
                    "displayName": "GPT-5.3 Codex Spark",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["none", "minimal", "low", "medium", "high", "max"],
                    "supportsAdaptiveThinking": true,
                },
            ],
        })
    );

    assert_eq!(probe.call_count().await, 0, "static paths never probe");
}

#[test]
fn claude_catalog_keeps_live_effort_choices_and_deduplicates_models() {
    let models = normalize_claude_catalog(json!([
        { "value": "sonnet", "displayName": "Claude Sonnet", "supportedEffortLevels": ["low", "high", "high"], "supportsAdaptiveThinking": true },
        { "value": "haiku", "displayName": "Claude Haiku" },
        { "value": "sonnet", "displayName": "Duplicate" }
    ])).unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "sonnet");
    assert_eq!(models[0].provider, "claude");
    assert_eq!(models[0].supported_effort_levels, vec!["low", "high"]);
    assert!(models[0].supports_effort);
    assert!(!models[1].supports_effort);
    assert!(normalize_claude_catalog(json!([])).is_err());
    assert!(normalize_claude_catalog(json!([{"displayName": "No id"}])).is_err());
}

// ── route level (model-capabilities-router.ts ports) ─────────────────────────

fn app_with_probe(probe: Arc<RecordingProbe>) -> Router {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
        .with_model_capability_probe(probe);
    router(state)
}

async fn body_json(resp: Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn get(app: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if auth {
        builder = builder.header("x-auth-token", "tok");
    }
    let resp = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    (resp.status(), body_json(resp).await)
}

async fn post(app: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("POST").uri(uri);
    if auth {
        builder = builder.header("x-auth-token", "tok");
    }
    let resp = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    (resp.status(), body_json(resp).await)
}

const CAP: &str = "/api/fresh-agent/model-capabilities";

/// `model-capabilities-router.ts:34-37 + :50-53`.
#[tokio::test]
async fn invalid_session_type_is_400_for_get_and_refresh() {
    let probe = Arc::new(RecordingProbe::new());
    let app = app_with_probe(probe);

    let (status, body) = get(app.clone(), &format!("{CAP}/nope"), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "Invalid sessionType" }));

    let (status, body) = post(app, &format!("{CAP}/nope/refresh"), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({ "error": "Invalid sessionType" }));
}

/// Missing auth token → the crate-wide 401 envelope (same convention as
/// `list_tabs`/`capture`).
#[tokio::test]
async fn routes_require_auth() {
    let probe = Arc::new(RecordingProbe::new());
    let app = app_with_probe(probe);

    let (status, body) = get(app.clone(), &format!("{CAP}/freshopencode"), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body,
        json!({ "status": "error", "message": "unauthorized" })
    );

    let (status, _) = post(app, &format!("{CAP}/freshopencode/refresh"), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// The happy path: a cwd-scoped GET probes once and returns the full strict
/// envelope (`FreshAgentModelCapabilitiesResponseSchema`).
#[tokio::test]
async fn get_freshopencode_returns_full_envelope_and_forwards_cwd() {
    let probe = Arc::new(RecordingProbe::new());
    probe.push_ok(glm()).await;
    let app = app_with_probe(probe.clone());

    let (status, body) = get(app, &format!("{CAP}/freshopencode?cwd=/repo/a"), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["sessionType"], json!("freshopencode"));
    assert_eq!(body["runtimeProvider"], json!("opencode"));
    assert_eq!(body["status"], json!("fresh"));
    assert!(
        body["fetchedAt"].as_u64().expect("fetchedAt is an int") > 0,
        "fetchedAt is a positive epoch-ms int"
    );
    assert_eq!(
        body["models"][0],
        expected_model_json(&cap("opencode-go/glm-5.2", "GLM 5.2", Some("opencode-go")))
    );
    // No extra keys (zod .strict() analog).
    assert_eq!(
        body.as_object().unwrap().keys().collect::<Vec<_>>().len(),
        6,
        "success envelope carries exactly ok/sessionType/runtimeProvider/status/fetchedAt/models"
    );
    assert_eq!(probe.calls().await, vec![Some("/repo/a".to_string())]);
}

/// Probe failure → 503 + the typed-error failure envelope.
#[tokio::test]
async fn probe_failure_maps_to_503_unavailable_envelope() {
    let probe = Arc::new(RecordingProbe::new());
    probe
        .push_err(CapabilityError {
            code: "CAPABILITY_PROBE_FAILED".into(),
            message: "opencode serve did not become healthy within 20000ms".into(),
            retryable: true,
        })
        .await;
    let app = app_with_probe(probe);

    let (status, body) = get(app, &format!("{CAP}/freshopencode"), true).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        json!({
            "ok": false,
            "sessionType": "freshopencode",
            "runtimeProvider": "opencode",
            "status": "unavailable",
            "models": [],
            "error": {
                "code": "CAPABILITY_PROBE_FAILED",
                "message": "opencode serve did not become healthy within 20000ms",
                "retryable": true,
            },
        })
    );
}

/// Static providers work over HTTP too and never probe.
#[tokio::test]
async fn get_freshcodex_serves_static_catalog_over_http() {
    let probe = Arc::new(RecordingProbe::new());
    let app = app_with_probe(probe.clone());

    let (status, body) = get(app, &format!("{CAP}/freshcodex?cwd=/ignored"), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["runtimeProvider"], json!("codex"));
    assert_eq!(body["models"].as_array().unwrap().len(), 3);
    assert_eq!(body["models"][0]["id"], json!("gpt-5.5"));
    assert_eq!(probe.call_count().await, 0);
}

/// POST refresh re-probes even within the TTL window.
#[tokio::test]
async fn refresh_reprobes_and_reports_fresh() {
    let probe = Arc::new(RecordingProbe::new());
    probe.push_ok(glm()).await;
    probe.push_ok(gemini()).await;
    let app = app_with_probe(probe.clone());

    let (_, first) = get(app.clone(), &format!("{CAP}/freshopencode"), true).await;
    assert_eq!(first["status"], json!("fresh"));
    let (_, cached) = get(app.clone(), &format!("{CAP}/freshopencode"), true).await;
    assert_eq!(cached["status"], json!("cached"));

    let (_, refreshed) = post(app, &format!("{CAP}/freshopencode/refresh"), true).await;
    assert_eq!(refreshed["status"], json!("fresh"));
    assert_eq!(refreshed["models"][0]["id"], json!("google/gemini-3-pro"));
    assert_eq!(probe.call_count().await, 2);
}

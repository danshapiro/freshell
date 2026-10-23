//! Tests for `model_capabilities.rs` — ports of
//! `test/unit/server/fresh-agent/model-capability-registry.test.ts` (registry
//! semantics) plus route-level coverage of `model-capabilities-router.ts`
//! (400/200/503, auth, cwd query plumbing).

use super::*;
use axum::body::Body;
use axum::http::Request;
use serde_json::json;
use std::collections::VecDeque;
use std::path::PathBuf;
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
        limit: None,
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

/// The typed internal read (`ModelCapabilityRegistry::models`) returns the
/// same rows the HTTP envelope serves — including the server-internal
/// `limit` block — and shares the TTL cache with `get()`: within TTL, the
/// envelope path must not re-probe.
#[tokio::test]
async fn models_returns_typed_rows_with_limits_and_shares_the_ttl_cache() {
    let probe = Arc::new(RecordingProbe::new());
    let mut model = cap(
        "lunaroute/glm-5.3-vision-background",
        "GLM 5.3 Vision Background",
        Some("lunaroute"),
    );
    model.limit = Some(freshell_opencode::catalog::ModelLimits {
        context: 524288,
        input: None,
        output: Some(131072),
    });
    probe.push_ok(vec![model]).await;
    let (registry, _now) = registry_with(probe.clone());

    let first = registry
        .models(SessionType::FreshOpencode, None)
        .await
        .expect("catalog ok");
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].limit,
        Some(freshell_opencode::catalog::ModelLimits {
            context: 524288,
            input: None,
            output: Some(131072),
        })
    );
    assert_eq!(probe.call_count().await, 1);
    // the HTTP envelope path shares the same cache: within TTL, get() must not re-probe
    let (status, _body) = registry.get(SessionType::FreshOpencode, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe.call_count().await, 1);
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
                    "id": "gpt-6-astra",
                    "displayName": "GPT-6 Astra",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                    "supportsAdaptiveThinking": true,
                },
                {
                    "id": "gpt-5.6-sol",
                    "displayName": "GPT-5.6 Sol",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["none", "low", "medium", "high", "xhigh", "max"],
                    "supportsAdaptiveThinking": true,
                },
                {
                    "id": "gpt-5.6-terra",
                    "displayName": "GPT-5.6 Terra",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["none", "low", "medium", "high", "xhigh", "max"],
                    "supportsAdaptiveThinking": true,
                },
                {
                    "id": "gpt-5.6-luna",
                    "displayName": "GPT-5.6 Luna",
                    "provider": "codex",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["none", "low", "medium", "high", "xhigh", "max"],
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

/// Stage a copy of the sidecar package in `directory` (the catalog helper
/// imports its siblings), with a stub in place of the session entry and
/// `sdk_source` as the SDK module named `sdk_name`, for
/// `FRESHELL_CLAUDE_SDK_QUERY_MODULE=./<sdk_name>`. Returns the stub entry.
fn stage_catalog_sidecar(directory: &std::path::Path, sdk_name: &str, sdk_source: &str) -> PathBuf {
    let package = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../freshell-claude-sidecar"
    ));
    for module in std::fs::read_dir(&package).expect("read the sidecar package") {
        let module = module.expect("sidecar package entry").path();
        if module
            .extension()
            .is_some_and(|extension| extension == "mjs")
        {
            let name = module.file_name().expect("module file name");
            std::fs::copy(&module, directory.join(name)).expect("copy a sidecar module");
        }
    }
    assert!(
        directory.join("model-catalog.mjs").is_file(),
        "the catalog helper was copied"
    );
    let sidecar_entry = directory.join("index.mjs");
    std::fs::write(&sidecar_entry, "export {}\n").expect("write sidecar entry");
    std::fs::write(directory.join(sdk_name), sdk_source).expect("write fake SDK module");
    sidecar_entry
}

/// Runs the catalog probe against a staged copy of the sidecar package
/// ([`stage_catalog_sidecar`]) and returns the probe's answer.
async fn probe_relocated_catalog(sdk_name: &str, sdk_source: &str) -> CatalogOut {
    let directory = tempfile::tempdir().expect("temporary sidecar directory");
    let sidecar_entry = stage_catalog_sidecar(directory.path(), sdk_name, sdk_source);

    std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &sidecar_entry);
    std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
    std::env::set_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE", format!("./{sdk_name}"));
    let result = ClaudeCatalogProbe::default().probe(None).await;
    std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
    std::env::remove_var("FRESHELL_CLAUDE_NODE");
    std::env::remove_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE");
    result
}

/// The installed Electron runtime relocates the sidecar away from the source
/// checkout. A relative SDK seam must therefore be resolved by the copied
/// model-catalog helper, not by the source-tree helper baked into the binary.
#[tokio::test]
async fn claude_catalog_probe_uses_the_configured_sidecar_directory() {
    let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let result = probe_relocated_catalog(
        "task-b-relocated-sdk.mjs",
        r#"
export function query() {
  return {
    supportedModels: async () => [{
      value: 'task-b-relocated-model',
      displayName: 'Task B Relocated Model',
      supportedEffortLevels: ['medium'],
      supportsAdaptiveThinking: true,
    }],
    close: async () => {},
  }
}
"#,
    )
    .await;

    let models = result.expect("configured sidecar catalog should be probed");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "task-b-relocated-model");
    assert_eq!(models[0].display_name, "Task B Relocated Model");
    assert_eq!(models[0].supported_effort_levels, vec!["medium"]);
    assert!(models[0].supports_adaptive_thinking);
}

/// G14 / design §5.9 (review F7): the catalog probe's stderr is the
/// sidecar's JSONL log, so it goes through the same stderr logger as a session
/// sidecar: each record is re-emitted at its own severity, on success too.
#[tokio::test]
async fn claude_catalog_probe_re_emits_its_log_records_at_their_severity() {
    use crate::claude_sidecar_io::test_capture::{capture, with_message};
    let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let (events, _capture) = capture();
    let result = probe_relocated_catalog(
        "f7-logging-sdk.mjs",
        r#"
export function query({ options }) {
  options.stderr('cli says hello\n')
  return {
    supportedModels: async () => [{ value: 'f7-model', displayName: 'F7 Model' }],
    close: async () => { throw new Error('close failed for the test') },
  }
}
"#,
    )
    .await;
    assert_eq!(result.expect("the catalog is read")[0].id, "f7-model");

    let records = with_message(&events, "freshagent.claude.sidecar_log");
    let record = |event: &str| {
        records
            .iter()
            .find(|record| record.fields.get("sidecar_event").map(String::as_str) == Some(event))
            .unwrap_or_else(|| panic!("no {event} record among {records:?}"))
    };
    let cli = record("cli.stderr");
    assert_eq!(cli.level, tracing::Level::INFO);
    assert_eq!(
        cli.fields.get("component").map(String::as_str),
        Some("claude-model-catalog")
    );
    assert_eq!(record("catalog.close_failed").level, tracing::Level::WARN);
}

/// On failure the probe's records keep their own severity, and the failure
/// warning gives the exit status and points to them, instead of carrying the
/// whole stderr as one field.
#[tokio::test]
async fn claude_catalog_probe_failure_keeps_its_records_apart_from_the_warning() {
    use crate::claude_sidecar_io::test_capture::{capture, with_message};
    let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let (events, _capture) = capture();
    let result = probe_relocated_catalog(
        "f7-failing-sdk.mjs",
        r#"
export function query() {
  return {
    supportedModels: async () => { throw new Error('not signed in for the test') },
    close: async () => {},
  }
}
"#,
    )
    .await;
    assert_eq!(
        result.expect_err("the catalog is unavailable").code,
        "CAPABILITY_PROBE_FAILED"
    );

    let unavailable = with_message(&events, "freshagent.claude.sidecar_log")
        .into_iter()
        .find(|record| {
            record.fields.get("sidecar_event").map(String::as_str) == Some("catalog.unavailable")
        })
        .expect("the catalog.unavailable record is re-emitted");
    assert_eq!(unavailable.level, tracing::Level::ERROR);

    let warning = with_message(&events, "freshagent.claude.model_catalog_unavailable");
    assert_eq!(warning.len(), 1, "one failure warning: {warning:?}");
    assert_eq!(warning[0].level, tracing::Level::WARN);
    assert!(warning[0].fields.contains_key("status"));
    assert!(
        !warning[0].fields.contains_key("stderr"),
        "the warning does not carry the stderr blob: {warning:?}"
    );
}

/// G30: in managed mode the session sidecar authenticates with the managed
/// OneCLI key (`FRESHELL_CLAUDE_ONECLI_API_KEY`), so the catalog probe must
/// hand its SDK query the same key, or the model dialog falls back to the
/// static list for a OneCLI-only user. The managed secrets are process-global
/// and install once, so the scenario runs in a re-executed child test process.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn claude_catalog_probe_gets_the_managed_onecli_key_like_the_sidecar() {
    const CASE: &str = "FRESHELL_CATALOG_ONECLI_FIXTURE_CHILD";
    const KEY: &str = "sk-managed-catalog-probe";
    if std::env::var_os(CASE).is_some() {
        let directory = tempfile::tempdir().expect("temporary sidecar directory");
        let sidecar_entry = stage_catalog_sidecar(
            directory.path(),
            "onecli-sdk.mjs",
            &format!(
                r#"
export function query({{ options }}) {{
  return {{
    supportedModels: async () => [{{
      value: 'onecli-model',
      displayName: options.env.ANTHROPIC_API_KEY === '{KEY}' ? 'managed key visible' : 'managed key missing',
    }}],
    close: async () => {{}},
  }}
}}
"#
            ),
        );
        freshell_platform::managed_child_secrets::install(
            [("ANTHROPIC_API_KEY".to_string(), KEY.to_string())].into(),
        )
        .unwrap();
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &sidecar_entry);
        std::env::set_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE", "./onecli-sdk.mjs");
        let models = ClaudeCatalogProbe::default()
            .probe(None)
            .await
            .expect("the catalog probe runs");
        assert_eq!(models[0].display_name, "managed key visible");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env(CASE, "1")
        .args([
            "--exact",
            "model_capabilities::tests::claude_catalog_probe_gets_the_managed_onecli_key_like_the_sidecar",
            "--nocapture",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "the managed-key catalog scenario failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// G30/G31: a hung probe is killed with its whole tree, so the SDK-spawned
/// CLI (here a grandchild node) cannot outlive the timeout on any platform.
#[cfg(unix)]
#[tokio::test]
async fn claude_catalog_probe_timeout_leaves_no_process_behind() {
    let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let directory = tempfile::tempdir().expect("temporary sidecar directory");
    let pid_file = directory.path().join("grandchild.pid");
    let sidecar_entry = stage_catalog_sidecar(
        directory.path(),
        "hung-sdk.mjs",
        r#"
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
export function query() {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  grandchild.on('spawn', () => writeFileSync(process.env.FRESHELL_TEST_GRANDCHILD_PID_FILE, String(grandchild.pid)))
  return { supportedModels: () => new Promise(() => {}), close: () => new Promise(() => {}) }
}
"#,
    );
    std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &sidecar_entry);
    std::env::set_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE", "./hung-sdk.mjs");
    std::env::set_var("FRESHELL_TEST_GRANDCHILD_PID_FILE", &pid_file);
    let result = ClaudeCatalogProbe::with_timeout(Duration::from_secs(2))
        .probe(None)
        .await;
    std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
    std::env::remove_var("FRESHELL_CLAUDE_SDK_QUERY_MODULE");
    std::env::remove_var("FRESHELL_TEST_GRANDCHILD_PID_FILE");

    let error = result.expect_err("a hung catalog probe times out");
    assert!(error.message.contains("timed out"), "{error:?}");
    let grandchild = crate::process_probe::ProcessProbe::open(
        std::fs::read_to_string(&pid_file)
            .expect("the fake SDK started its grandchild")
            .trim()
            .parse()
            .expect("a pid"),
    );
    // The killed grandchild may still be a zombie its adopter has not reaped
    // yet; `kill(pid, 0)` would find that, the probe does not.
    assert!(
        grandchild.exited(),
        "the probe's grandchild did not outlive the timeout"
    );
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
    assert_eq!(body["models"].as_array().unwrap().len(), 5);
    assert_eq!(body["models"][0]["id"], json!("gpt-6-astra"));
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

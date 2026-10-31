//! # model_capabilities — `GET`/`POST /api/fresh-agent/model-capabilities/*`
//!
//! Port of the Node pair
//! * `server/fresh-agent/model-capabilities-router.ts` (route shape, 400/200/503
//!   statuses, cwd context resolution) and
//! * `server/fresh-agent/model-capability-registry.ts` (per-cwd TTL cache with
//!   in-flight single-flight coalescing, refresh bypass, static catalogs,
//!   typed-error envelopes),
//!
//! sitting on the [`freshell_opencode::catalog`] probe for the `freshopencode`
//! runtime. The response bodies conform to
//! `shared/fresh-agent-model-capabilities.ts` (`ok:true` success at 200,
//! `ok:false` `unavailable` + typed error at 503).
//!
//! Claude and Kilroy share a short-lived Claude SDK `supportedModels()` probe
//! through the existing vendored Node sidecar package. Probing never starts an
//! agent turn or modifies an existing session.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::future::{FutureExt, Shared};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use freshell_opencode::catalog::{probe_enabled_model_catalog, CatalogConfig, CatalogDeps};
pub use freshell_opencode::catalog::{ModelCapability, ModelLimits};
use freshell_opencode::serve::BoxFuture;
use freshell_opencode::transport::{LoopbackPortAllocator, ReqwestServeHttp, TokioProcessSpawner};

use crate::{authorized, fail_json, FreshAgentState};

/// `FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS`
/// (`shared/fresh-agent-model-capabilities.ts:3`).
pub const MODEL_CAPABILITY_CACHE_TTL: Duration = Duration::from_millis(5 * 60 * 1000);

// ── session types (FreshAgentModelCapabilitiesSessionTypeSchema) ───────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionType {
    FreshClaude,
    FreshCodex,
    Kilroy,
    FreshOpencode,
}

impl SessionType {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "freshclaude" => Some(Self::FreshClaude),
            "freshcodex" => Some(Self::FreshCodex),
            "kilroy" => Some(Self::Kilroy),
            "freshopencode" => Some(Self::FreshOpencode),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::FreshClaude => "freshclaude",
            Self::FreshCodex => "freshcodex",
            Self::Kilroy => "kilroy",
            Self::FreshOpencode => "freshopencode",
        }
    }

    /// `FreshAgentModelCapabilitiesRuntimeProviderSchema` (the descriptor's
    /// `runtimeProvider`).
    fn runtime_provider(self) -> &'static str {
        match self {
            Self::FreshCodex => "codex",
            Self::FreshOpencode => "opencode",
            Self::FreshClaude | Self::Kilroy => "claude",
        }
    }
}

// ── errors (FreshAgentModelCapabilityErrorSchema) ───────────────────────────────

/// The typed catalog error carried in the `ok:false` envelope
/// (`code`/`message`/`retryable`).
#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

// ── the probe seam (registry's opencodeCatalogProvider) ────────────────────────

pub type CatalogOut = Result<Vec<ModelCapability>, CapabilityError>;

/// Injected probe — the port seam for the reference's `opencodeCatalogProvider`
/// dependency (`RegistryOptions.opencodeCatalogProvider`). Real impl spawns the
/// transient catalog serve; tests record cwd and script responses.
pub trait ModelCatalogProbe: Send + Sync {
    fn probe<'a>(&'a self, cwd: Option<&'a str>) -> BoxFuture<'a, CatalogOut>;
}

/// Production probe over the real transport: transient `opencode serve --pure`.
pub struct OpencodeCatalogProbe {
    deps: CatalogDeps,
    config: CatalogConfig,
}

impl OpencodeCatalogProbe {
    pub fn new(deps: CatalogDeps, config: CatalogConfig) -> Self {
        Self { deps, config }
    }
}

impl Default for OpencodeCatalogProbe {
    fn default() -> Self {
        Self::new(
            CatalogDeps {
                spawner: Arc::new(TokioProcessSpawner),
                http: Arc::new(ReqwestServeHttp::new()),
                ports: Arc::new(LoopbackPortAllocator),
            },
            CatalogConfig::default(),
        )
    }
}

impl ModelCatalogProbe for OpencodeCatalogProbe {
    fn probe<'a>(&'a self, cwd: Option<&'a str>) -> BoxFuture<'a, CatalogOut> {
        Box::pin(async move {
            probe_enabled_model_catalog(&self.deps, &self.config, cwd)
                .await
                .map_err(|e| CapabilityError {
                    // `probeOpencodeCatalog` wraps every untyped probe failure
                    // (model-capability-registry.ts:320-340).
                    code: "CAPABILITY_PROBE_FAILED".to_string(),
                    message: e.to_string(),
                    retryable: true,
                })
        })
    }
}

/// Runs only the SDK catalog control query, separately from live Claude sessions.
pub struct ClaudeCatalogProbe {
    /// How long the probe may run before its whole tree is killed.
    timeout: Duration,
}

impl Default for ClaudeCatalogProbe {
    fn default() -> Self {
        Self {
            timeout: CLAUDE_CATALOG_TIMEOUT,
        }
    }
}

impl ClaudeCatalogProbe {
    #[cfg(test)]
    pub(crate) fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }
}

fn claude_probe_error(message: impl Into<String>) -> CapabilityError {
    CapabilityError {
        code: "CAPABILITY_PROBE_FAILED".into(),
        message: message.into(),
        retryable: true,
    }
}

/// The model-catalog probe's launch recipe: the SAME builder and the same
/// run-as wrapper, managed secrets and OneCLI key flag as the session
/// sidecar (`claude::sidecar_node_command`), so the probe authenticates
/// exactly like the sessions it describes (G30). No ownership tag: the probe
/// is owned by its process-tree guard. Its stdin stays closed.
pub(crate) fn catalog_node_command(
    command: crate::claude_spawn::ClaudeNodeCommand,
) -> crate::claude_spawn::ClaudeNodeCommand {
    command
        .with_run_as()
        .with_managed_environment()
        .with_closed_stdin()
}

/// How long the catalog probe may run before its whole tree is killed.
const CLAUDE_CATALOG_TIMEOUT: Duration = Duration::from_secs(15);

impl ModelCatalogProbe for ClaudeCatalogProbe {
    fn probe<'a>(&'a self, _cwd: Option<&'a str>) -> BoxFuture<'a, CatalogOut> {
        Box::pin(async move {
            let entry = crate::claude::sidecar_entry_path().with_file_name("model-catalog.mjs");
            let (mut child, mut tree_guard) =
                catalog_node_command(crate::claude_spawn::ClaudeNodeCommand::new(entry))
                    .spawn_guarded()
                    .map_err(|error| {
                        claude_probe_error(format!("Cannot start Claude model catalog: {error}"))
                    })?;
            let pid = child.id();
            // The helper's stderr is the sidecar's JSONL log (log.mjs): the same
            // logger as a session sidecar re-emits each record at its severity,
            // bounded and rate-limited (G14, design §5.9).
            let stderr_logger = child.stderr.take().map(|stderr| {
                crate::claude_sidecar_io::spawn_stderr_logger(
                    stderr,
                    crate::claude_sidecar_io::SidecarLogLabels::model_catalog(pid),
                    crate::claude_sidecar_io::hosted_sidecar(None),
                )
            });
            // On a timeout: what the tree guard established about the killed tree.
            let mut timed_out_tree = None;
            let output =
                match tokio::time::timeout(self.timeout, collect_child_output(&mut child)).await {
                    Ok(result) => result.map_err(|error| claude_probe_error(error.to_string())),
                    Err(_) => {
                        // The tree guard owns the probe's SDK-spawned CLI on every
                        // platform, so a hung SDK close cannot leave it behind.
                        timed_out_tree = Some(tree_guard.terminate(&mut child).await);
                        Err(claude_probe_error("Claude model catalog process timed out"))
                    }
                };
            // The process is gone, so its stderr ends: let its last records
            // land before the outcome is logged.
            if let Some(logger) = stderr_logger {
                let _ = tokio::time::timeout(Duration::from_secs(1), logger).await;
            }
            let output = match output {
                Ok(output) => output,
                Err(error) => {
                    tracing::warn!(
                        provider = "claude",
                        component = crate::claude_sidecar_io::MODEL_CATALOG_LABEL,
                        pid,
                        error = %error.message,
                        tree = ?timed_out_tree,
                        "freshagent.claude.model_catalog_unavailable"
                    );
                    return Err(error);
                }
            };
            if !output.status.success() {
                tracing::warn!(
                    provider = "claude",
                    component = crate::claude_sidecar_io::MODEL_CATALOG_LABEL,
                    pid,
                    status = %output.status,
                    see = "the helper's own freshagent.claude.sidecar_log records \
                           (ownership_id claude-model-catalog) say why",
                    "freshagent.claude.model_catalog_unavailable"
                );
                return Err(claude_probe_error("Claude model catalog is unavailable. Check Claude authentication and the server logs."));
            }
            let raw: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
                claude_probe_error(format!("Invalid Claude model catalog: {error}"))
            })?;
            normalize_claude_catalog(raw)
        })
    }
}

/// `wait_with_output` that borrows the child, so a timeout can still kill
/// the child's tree afterwards.
async fn collect_child_output(
    child: &mut tokio::process::Child,
) -> std::io::Result<std::process::Output> {
    async fn read_pipe<R: tokio::io::AsyncRead + Unpin>(
        pipe: Option<R>,
    ) -> std::io::Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            pipe.read_to_end(&mut bytes).await?;
        }
        Ok(bytes)
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (status, stdout, stderr) =
        tokio::try_join!(child.wait(), read_pipe(stdout), read_pipe(stderr))?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn normalize_claude_catalog(raw: Value) -> CatalogOut {
    let invalid = || CapabilityError {
        code: "CAPABILITY_PAYLOAD_INVALID".into(),
        message: "Claude returned an invalid model catalog".into(),
        retryable: false,
    };
    let rows = raw.as_array().ok_or_else(invalid)?;
    if rows.is_empty() {
        return Err(invalid());
    }
    let mut models = Vec::new();
    for row in rows {
        let id = row
            .get("value")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(invalid)?;
        let name = row
            .get("displayName")
            .or_else(|| row.get("display_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(id);
        let levels = row
            .get("supportedEffortLevels")
            .or_else(|| row.get("supported_effort_levels"));
        let mut supported_effort_levels = Vec::new();
        if let Some(levels) = levels {
            for level in levels.as_array().ok_or_else(invalid)? {
                let level = level
                    .as_str()
                    .map(str::trim)
                    .filter(|level| !level.is_empty())
                    .ok_or_else(invalid)?;
                if !supported_effort_levels
                    .iter()
                    .any(|existing| existing == level)
                {
                    supported_effort_levels.push(level.to_string());
                }
            }
        }
        if !models.iter().any(|model: &ModelCapability| model.id == id) {
            models.push(ModelCapability {
                default_effort: None,
                input_modalities: None,
                id: id.into(),
                display_name: name.into(),
                provider: "claude",
                source: None,
                supports_effort: !supported_effort_levels.is_empty(),
                supported_effort_levels,
                supports_adaptive_thinking: row
                    .get("supportsAdaptiveThinking")
                    .or_else(|| row.get("supports_adaptive_thinking"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                limit: None,
            });
        }
    }
    Ok(models)
}

// ── registry (FreshAgentModelCapabilityRegistry) ───────────────────────────────

#[derive(Clone)]
struct CachedCatalog {
    fetched_at_ms: u64,
    models: Vec<ModelCapability>,
}

type SharedCatalogFuture = Shared<BoxFuture<'static, Result<CachedCatalog, CapabilityError>>>;

#[derive(Default)]
struct RegistryState {
    cache: HashMap<String, CachedCatalog>,
    inflight: HashMap<String, SharedCatalogFuture>,
}

/// cwd-keyed TTL cache + in-flight coalescing — `opencodeCacheByKey` /
/// `opencodeInFlightByKey` (`model-capability-registry.ts:193-194`).
pub struct ModelCapabilityRegistry {
    probe: Arc<dyn ModelCatalogProbe>,
    claude_probe: Arc<dyn ModelCatalogProbe>,
    ttl: Duration,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Arc<Mutex<RegistryState>>,
}

fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ModelCapabilityRegistry {
    pub fn new(probe: Arc<dyn ModelCatalogProbe>) -> Self {
        Self {
            probe,
            claude_probe: Arc::new(ClaudeCatalogProbe::default()),
            ttl: MODEL_CAPABILITY_CACHE_TTL,
            now: Arc::new(system_now_ms),
            state: Arc::new(Mutex::new(RegistryState::default())),
        }
    }

    /// Test seam (`RegistryOptions{now, ttlMs}`): injected clock and TTL so cache
    /// aging is deterministic.
    pub fn with_clock(
        probe: Arc<dyn ModelCatalogProbe>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
        ttl: Duration,
    ) -> Self {
        Self {
            probe,
            claude_probe: Arc::new(ClaudeCatalogProbe::default()),
            ttl,
            now,
            state: Arc::new(Mutex::new(RegistryState::default())),
        }
    }

    pub fn with_claude_probe(mut self, probe: Arc<dyn ModelCatalogProbe>) -> Self {
        self.claude_probe = probe;
        self
    }

    /// `getCapabilities` (`model-capability-registry.ts:211-234`): cache hit within
    /// TTL → `cached`; otherwise single-flight refresh → `fresh`; probe failure →
    /// the `unavailable` envelope at 503 (cache untouched). Unbound Codex
    /// callers receive RUNTIME_PENDING; bound reads use `codex` below.
    /// Claude/Kilroy share their SDK catalog cache.
    pub async fn get(&self, session_type: SessionType, cwd: Option<String>) -> (StatusCode, Value) {
        if session_type == SessionType::FreshCodex {
            let error = runtime_pending();
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                failure_body(session_type, &error),
            );
        }
        let key = catalog_cache_key(session_type, cwd.as_deref());
        if let Some(cached) = self.cached_within_ttl(&key).await {
            return (
                StatusCode::OK,
                success_body(session_type, "cached", cached.fetched_at_ms, cached.models),
            );
        }
        self.finish_catalog(session_type, key, cwd).await
    }

    /// Cached catalog within TTL, if fresh. Shared by the HTTP envelope
    /// path ([`Self::get`]) and the typed internal read ([`Self::models`]).
    async fn cached_within_ttl(&self, key: &str) -> Option<CachedCatalog> {
        let state = self.state.lock().await;
        let cached = state.cache.get(key)?;
        // `:270-271`: `now - fetchedAt <= ttlMs`.
        let age_ms = (self.now)().saturating_sub(cached.fetched_at_ms);
        (age_ms <= self.ttl.as_millis() as u64).then(|| cached.clone())
    }

    /// `refreshCapabilities` (`:236-254`): skips the TTL check but shares any
    /// in-flight probe; a failed refresh leaves the last successful cache entry
    /// in place (`:223-266`, "keeps the last successful catalog").
    pub async fn refresh(
        &self,
        session_type: SessionType,
        cwd: Option<String>,
    ) -> (StatusCode, Value) {
        if session_type == SessionType::FreshCodex {
            let error = runtime_pending();
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                failure_body(session_type, &error),
            );
        }
        self.finish_catalog(
            session_type,
            catalog_cache_key(session_type, cwd.as_deref()),
            cwd,
        )
        .await
    }

    /// Typed internal read for server-side consumers (the session-directory
    /// context meter's model-limit snapshot): the same TTL/single-flight
    /// path as [`Self::get`], returning rows instead of the HTTP envelope.
    /// Codex requires a bound runtime source rather than this unscoped read.
    /// A probe failure leaves the last successful cache entry in place.
    pub async fn models(
        &self,
        session_type: SessionType,
        cwd: Option<String>,
    ) -> Result<Vec<ModelCapability>, CapabilityError> {
        if session_type == SessionType::FreshCodex {
            return Err(runtime_pending());
        }
        let key = catalog_cache_key(session_type, cwd.as_deref());
        if let Some(cached) = self.cached_within_ttl(&key).await {
            return Ok(cached.models);
        }
        self.refreshed_catalog(session_type, key, cwd, None)
            .await
            .map(|catalog| catalog.models)
    }

    async fn finish_catalog(
        &self,
        session_type: SessionType,
        key: String,
        cwd: Option<String>,
    ) -> (StatusCode, Value) {
        match self.refreshed_catalog(session_type, key, cwd, None).await {
            Ok(catalog) => (
                StatusCode::OK,
                success_body(session_type, "fresh", catalog.fetched_at_ms, catalog.models),
            ),
            Err(err) => (
                StatusCode::SERVICE_UNAVAILABLE,
                failure_body(session_type, &err),
            ),
        }
    }

    /// `refreshOpencodeCatalog` (`:295-318`): the single-flight. The shared
    /// future removes itself from `inflight` and writes the cache on success —
    /// the reference's `.then(cache.set).finally(inflight.delete)`.
    async fn refreshed_catalog(
        &self,
        session_type: SessionType,
        key: String,
        cwd: Option<String>,
        probe_override: Option<Arc<dyn ModelCatalogProbe>>,
    ) -> Result<CachedCatalog, CapabilityError> {
        let shared = {
            let mut state = self.state.lock().await;
            match state.inflight.get(&key) {
                Some(existing) => existing.clone(),
                None => {
                    let probe = probe_override.clone().unwrap_or_else(|| {
                        if session_type == SessionType::FreshOpencode {
                            self.probe.clone()
                        } else {
                            self.claude_probe.clone()
                        }
                    });
                    let now = self.now.clone();
                    let state_arc = self.state.clone();
                    let key_for_cleanup = key.clone();
                    // `:302-306`: only a non-blank cwd reaches the probe context.
                    let cwd = cwd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                    let key_for_cache = key.clone();
                    let future = async move {
                        let out = probe
                            .probe(cwd.as_deref())
                            .await
                            .map(|models| CachedCatalog {
                                fetched_at_ms: now(),
                                models,
                            });
                        let mut state = state_arc.lock().await;
                        state.inflight.remove(&key_for_cleanup);
                        if let Ok(catalog) = &out {
                            state.cache.insert(key_for_cache, catalog.clone());
                        }
                        out
                    };
                    let shared: SharedCatalogFuture = future.boxed().shared();
                    state.inflight.insert(key, shared.clone());
                    shared
                }
            }
        };
        shared.await
    }
}

/// `opencodeCacheKey` (`:256-261`).
fn catalog_cache_key(session_type: SessionType, cwd: Option<&str>) -> String {
    if session_type != SessionType::FreshOpencode {
        return "claude".into();
    }
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty());
    format!("opencode:{}", cwd.unwrap_or("<default>"))
}

/// `FreshAgentModelCapabilitiesSchema.extend({ok:true})` — the six keys, exactly.
fn success_body(
    session_type: SessionType,
    status: &'static str,
    fetched_at_ms: u64,
    models: Vec<ModelCapability>,
) -> Value {
    json!({
        "ok": true,
        "sessionType": session_type.wire(),
        "runtimeProvider": session_type.runtime_provider(),
        "status": status,
        "fetchedAt": fetched_at_ms,
        "models": models,
    })
}

/// `createFailure` (`model-capability-registry.ts:469-489`): no `fetchedAt` key
/// (the zod schema leaves it optional and the reference omits it).
fn failure_body(session_type: SessionType, err: &CapabilityError) -> Value {
    json!({
        "ok": false,
        "sessionType": session_type.wire(),
        "runtimeProvider": session_type.runtime_provider(),
        "status": "unavailable",
        "models": [],
        "error": {
            "code": err.code,
            "message": err.message,
            "retryable": err.retryable,
        },
    })
}

/// A pane's conversation identity is an observation, never a supplied soul authority.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCatalogContext {
    pub session_id: String,
    pub session_ref: Option<freshell_protocol::SessionLocator>,
    pub cwd: Option<String>,
    pub observed_epoch: Option<u64>,
    pub observed_generation: Option<u64>,
}
impl CodexCatalogContext {
    pub fn native_reference(&self) -> Result<&str, CapabilityError> {
        if let Some(reference) = &self.session_ref {
            if reference.provider != "codex" || reference.session_id.trim().is_empty() {
                return Err(runtime_pending());
            }
            Ok(&reference.session_id)
        } else if !self.session_id.trim().is_empty() {
            Ok(&self.session_id)
        } else {
            Err(runtime_pending())
        }
    }
}

#[derive(Clone)]
pub struct CodexCatalogSource {
    pub key: String,
    pub probe: Arc<dyn ModelCatalogProbe>,
}

pub fn runtime_pending() -> CapabilityError {
    CapabilityError {
        code: "RUNTIME_PENDING".into(),
        message: "Waiting for the conversation's Codex runtime".into(),
        retryable: true,
    }
}
pub fn source_changed() -> CapabilityError {
    CapabilityError {
        code: "CAPABILITY_SOURCE_CHANGED".into(),
        message: "The Codex runtime changed during model discovery. Try again.".into(),
        retryable: true,
    }
}
pub fn codex_probe_error(error: freshell_codex::CodexAppServerError) -> CapabilityError {
    let code = match error {
        freshell_codex::CodexAppServerError::Timeout { .. } => "CAPABILITY_PROBE_TIMEOUT",
        freshell_codex::CodexAppServerError::InvalidResponse { .. } => "CAPABILITY_PAYLOAD_INVALID",
        _ => "CAPABILITY_PROBE_FAILED",
    };
    CapabilityError {
        code: code.into(),
        message: error.to_string(),
        retryable: true,
    }
}
pub fn codex_capabilities(
    models: Vec<freshell_codex::catalog::CodexModel>,
) -> Vec<ModelCapability> {
    models
        .into_iter()
        .map(|model| ModelCapability {
            id: model.id,
            display_name: model.display_name,
            provider: "codex",
            source: None,
            supports_effort: !model.supported_effort_levels.is_empty(),
            supported_effort_levels: model.supported_effort_levels,
            default_effort: model.default_effort,
            input_modalities: model.input_modalities,
            supports_adaptive_thinking: false,
            limit: None,
        })
        .collect()
}

impl ModelCapabilityRegistry {
    pub async fn codex(
        &self,
        source: CodexCatalogSource,
        cwd: Option<String>,
        refresh: bool,
    ) -> (StatusCode, Value) {
        let key = serde_json::to_string(&("codex", source.key, cwd.as_deref().map(str::trim)))
            .expect("catalog key");
        if !refresh {
            if let Some(cached) = self.cached_within_ttl(&key).await {
                return (
                    StatusCode::OK,
                    success_body(
                        SessionType::FreshCodex,
                        "cached",
                        cached.fetched_at_ms,
                        cached.models,
                    ),
                );
            }
        }
        match self
            .refreshed_catalog(SessionType::FreshCodex, key, cwd, Some(source.probe))
            .await
        {
            Ok(catalog) => (
                StatusCode::OK,
                success_body(
                    SessionType::FreshCodex,
                    "fresh",
                    catalog.fetched_at_ms,
                    catalog.models,
                ),
            ),
            Err(error) => (
                StatusCode::SERVICE_UNAVAILABLE,
                failure_body(SessionType::FreshCodex, &error),
            ),
        }
    }
}

async fn bound_codex_source(
    state: &FreshAgentState,
    context: &CodexCatalogContext,
) -> Result<CodexCatalogSource, CapabilityError> {
    if let Some(hosted) = state.hosted_rest_gateway() {
        return hosted.model_catalog_source(context.clone()).await;
    }
    let local = state.codex_catalog.get().ok_or_else(runtime_pending)?;
    local.model_catalog_source(context.clone()).await
}
async fn capabilities_for_request(
    state: &FreshAgentState,
    st: SessionType,
    query: &HashMap<String, String>,
    refresh: bool,
) -> (StatusCode, Value) {
    if st != SessionType::FreshCodex {
        return if refresh {
            state
                .model_capabilities
                .refresh(st, resolve_context(st, query))
                .await
        } else {
            state
                .model_capabilities
                .get(st, resolve_context(st, query))
                .await
        };
    }
    let work = async {
        let context = CodexCatalogContext {
            session_id: query.get("sessionId").cloned().unwrap_or_default(),
            session_ref: query
                .get("sessionRef")
                .map(|s| serde_json::from_str(s).map_err(|_| source_changed()))
                .transpose()?,
            cwd: query.get("cwd").cloned(),
            observed_epoch: query
                .get("observedEpoch")
                .map(|s| s.parse::<u64>().map_err(|_| source_changed()))
                .transpose()?,
            observed_generation: query
                .get("observedGeneration")
                .map(|s| s.parse::<u64>().map_err(|_| source_changed()))
                .transpose()?,
        };
        context.native_reference()?;
        if context.observed_epoch.is_some() != context.observed_generation.is_some() {
            return Err(source_changed());
        }
        let source = bound_codex_source(state, &context).await?;
        let key = source.key.clone();
        let response = state
            .model_capabilities
            .codex(source, context.cwd.clone(), refresh)
            .await;
        if response.0 == StatusCode::OK && bound_codex_source(state, &context).await?.key != key {
            return Err(source_changed());
        }
        Ok(response)
    }
    .await;
    work.unwrap_or_else(|error| (StatusCode::SERVICE_UNAVAILABLE, failure_body(st, &error)))
}

// ── HTTP surface (createFreshAgentModelCapabilitiesRouter) ─────────────────────

/// The two routes. Merged into [`crate::router`] so `freshell-server`'s `main.rs`
/// mounts this crate exactly once, unchanged.
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route(
            "/api/fresh-agent/model-capabilities/{session_type}",
            get(get_capabilities),
        )
        .route(
            "/api/fresh-agent/model-capabilities/{session_type}/refresh",
            post(refresh_capabilities),
        )
        .with_state(state)
}

/// `GET /:sessionType` (`model-capabilities-router.ts:33-47`).
async fn get_capabilities(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Path(session_type): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let Some(st) = SessionType::parse(&session_type) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid sessionType" })),
        )
            .into_response();
    };
    let (status, body) = capabilities_for_request(&state, st, &query, false).await;
    (status, Json(body)).into_response()
}

/// `POST /:sessionType/refresh` (`model-capabilities-router.ts:49-63`).
async fn refresh_capabilities(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Path(session_type): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let Some(st) = SessionType::parse(&session_type) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid sessionType" })),
        )
            .into_response();
    };
    let (status, body) = capabilities_for_request(&state, st, &query, true).await;
    (status, Json(body)).into_response()
}

/// `resolveContext` (`model-capabilities-router.ts:19-26`): only freshopencode
/// takes a `cwd` query param into the probe context.
fn resolve_context(session_type: SessionType, query: &HashMap<String, String>) -> Option<String> {
    if session_type != SessionType::FreshOpencode {
        return None;
    }
    query.get("cwd").cloned()
}

#[cfg(test)]
#[path = "model_capabilities_tests.rs"]
mod tests;

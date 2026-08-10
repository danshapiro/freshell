//! `POST /api/sessions/resolve` — SYNC-06 port of the resolve route
//! (`server/sessions-router.ts`) + the hardened matching semantics of
//! `server/coding-cli/resolve-session.ts` and `resolve-fallbacks.ts`
//! (exact→fallback→prefix ordering, case-sensitivity gating, subagent
//! exclusion, candidate work budget, full-id shape gates + per-request
//! fallback budget).
//!
//! DIVERGENCE LEDGER (full detail in the core's module doc,
//! `freshell-sessions/src/resume_resolve.rs`; history in
//! `docs/plans/2026-07-30-rust-resolve-parity-hardened.md`). The
//! `sessionResolve` capability flag is declared `true` (`main.rs`,
//! `build_platform_payload`): the wire surface, the failure-reporting
//! production fallbacks (checked claude locator, propagating opencode by-id
//! query), and the scan-failure/unsearched-provider route merge all landed
//! in plan Task 6, and the resume-button e2e matrix ran green against this
//! route (plan Task 7). No known unported divergences remain beyond the
//! RECORDED DEVIATIONS documented below (explicit 500 on a resolver panic
//! instead of Node's undefined behavior; `homeDir` omitted when the server
//! has no resolvable home).
//!
//! Behavior contract:
//! - wire shape (`ResumeResolveResponseSchema`, `sessions-router.ts:306-314`):
//!   `{status, matches, hint, providerErrors, unsearchedProviders, homeDir}`
//!   — `providerErrors`/`unsearchedProviders` always present, `homeDir`
//!   omitted only when the server has no resolvable home.
//! - `providerErrors` = the core's fallback failures merged with the index's
//!   scan failures (enabled providers only; fallback errors win the dedupe —
//!   they carry the more specific message/code). A DISABLED provider is
//!   reported in `unsearchedProviders`, never as an error — otherwise a
//!   failed-then-disabled provider would stick degraded forever.
//! - `status`: warming stays warming; otherwise any provider error makes the
//!   response `degraded` — EVEN WITH matches (a failed provider means a
//!   higher-priority exact match may have been missed, so the client must
//!   never auto-resume a surviving lower-priority match). A degraded
//!   response fire-and-forgets `SessionIndex::request_refresh()` so a client
//!   Retry can converge once the provider recovers.
//! - disabled providers are filtered OUT of the index snapshot BEFORE core
//!   resolution (Node's index excludes them at scan time,
//!   `session-indexer.ts:1454-1467`); the exact-id FALLBACKS stay ungated
//!   (Node invokes all wired fallbacks regardless of settings,
//!   `resolve-session.ts:127-156`).
//! - async hygiene: the ENTIRE `resolve_resume_input` call runs inside
//!   `tokio::task::spawn_blocking` (bounded in-memory matching), and each
//!   blocking fallback invocation (rusqlite query, transcript directory
//!   walk) is dispatched onto its OWN nested `spawn_blocking` task; no
//!   DB/FS wait ever blocks the async runtime, and per-request work is
//!   bounded by `MAX_RESUME_CANDIDATES` (8) × `FALLBACK_BUDGET_PER_REQUEST`
//!   (2 per provider) fallback calls + one index scan per token. Keep any
//!   new closure invocation inside that dispatch. ONLY the fallback
//!   dispatch — never input parsing, index-only resolution, warming, or
//!   no-candidate responses — is bounded THREE ways (Node scopes its 15 s
//!   timeout to the individual by-id worker, `opencode-by-id-runner.ts`;
//!   its cheap paths never wait on worker availability): (1)
//!   [`RESOLVE_FALLBACK_DEADLINE`] bounds each admitted fallback task, and
//!   on elapse the task is ABANDONED (blocking tasks cannot be killed —
//!   recorded deviation from Node's `worker.terminate()`) with a timeout
//!   `ProviderFailure` blaming ONLY that provider; (2) a
//!   [`RESOLVE_MAX_CONCURRENCY`]-permit semaphore whose permit MOVES INTO
//!   the fallback task caps how many (abandoned or live) fallback tasks
//!   can exist at once — admission is a SYNCHRONOUS `try_acquire_owned()`
//!   BEFORE the fallback task exists, so a permit-starved dispatch fails
//!   fast with a concurrency-limit provider error instead of queueing (it
//!   never parks the resolver's blocking worker on the semaphore); (3)
//!   the per-provider budget (`FALLBACK_BUDGET_PER_REQUEST`
//!   = 2) caps how many dispatches — and therefore abandoned tasks — one
//!   request can produce. Each dispatch is bounded INDEPENDENTLY: a
//!   timeout blames only the provider whose dispatch elapsed, and later
//!   candidates/providers are still attempted with their own bounds
//!   (Node records the rejection per provider and keeps iterating,
//!   `resolve-session.ts:133-156`). ERRATA: commit bb357a598 applied the
//!   deadline + admission around the WHOLE resolver as an interim
//!   approximation; corrected to fallback-only scoping. ERRATA: commit
//!   ffa4aac1a shared one cooperative cancel flag across both providers,
//!   so one timeout skipped every later fallback and fabricated timeouts
//!   for providers never dispatched; corrected to per-dispatch scoping.
//!   ERRATA: through commit 37be35b9a admission awaited `acquire_owned()`
//!   INSIDE the outer resolver worker, so under saturation each dispatch
//!   pinned an unbounded blocking-pool worker for its full deadline —
//!   the exact exhaustion the semaphore exists to prevent; corrected to
//!   fail-fast admission before any fallback task exists.
//! - RECORDED DEVIATION: a `JoinError` (the resolver PANICKED) answers an
//!   explicit 500 `{"error":"Resolve failed"}`. Node has no defined behavior
//!   here — a top-level resolver throw becomes an unhandled rejection in the
//!   async Express 4 handler (no response at all) — so the explicit 500 is
//!   the honest port, not a wire mismatch; fabricating ready-empty would
//!   present an unsearchable state as a healthy "not found".
//!
//! Behavior contract (validation/readiness):
//! - auth: same `x-auth-token` / `freshell-auth` cookie check as every other
//!   `/api` route (`boot::is_authed`), 401 `{"error":"Unauthorized"}`.
//! - validation: strict body `{ input: string 1..=20000 }` (UTF-16 code
//!   units); any failure → 400
//!   `{"error":"Invalid resolve request","details":[issues]}` where the
//!   issue literals replicate the ACTUAL zod 4.3.6 wire output — field set,
//!   key ORDER (`expected`/`origin` before `code`; `preserve_order` + `json!`
//!   insertion order provide it), and message wording, probed against the
//!   real `ResumeResolveRequestSchema`. NOTHING reads `details` (the client
//!   dialog treats any non-2xx as request-failed without inspecting the
//!   body), so this is test-pinned parity; the literals are pinned to zod
//!   4.3.6 and MUST be re-probed on any zod bump.
//! - membership: the index snapshot is filtered through `deleted: true`
//!   session overrides before matching — Node's resolve reads the
//!   post-filter project groups (`session-indexer.ts:209,1155-1156`) and the
//!   Rust sidebar applies the same overlay (`session_directory.rs`
//!   `apply_session_overrides`). The exact-id fallbacks BYPASS the filter,
//!   as Node's do (they read sqlite/the filesystem directly).
//! - success is ALWAYS 200 — "not found" is `{status:"ready",matches:[]}`,
//!   cold index is `{status:"warming",matches:[],hint}` (never 404/5xx).
//!
//! Accepted deviations (status parity only, recorded): payloads Express's
//! strict body parser rejects with an HTML 400 before zod runs (malformed
//! JSON; JSON scalars string/number/bool/null) get the zod-shaped JSON 400
//! here; axum's default 2 MB body limit vs express `json({limit:'1mb'})`;
//! `PATCH`/`GET /api/sessions/resolve` answer 405 on the merged Rust router
//! where Express would dispatch `:sessionId="resolve"` (unreachable by any
//! known client).
//!
//! Readiness: `SessionIndex::peek()` `None` = never-published = Node's
//! `isIndexReady() === false`. A machine with no resolvable provider home
//! (`session_index: None`) also answers `warming` — the same honest-Unknown
//! convention `NoIndexProbe` uses for existence.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use freshell_sessions::directory_index::{IndexedSession, SessionIndex};
use freshell_sessions::resume_input::ResumeHint;
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, OpencodeByIdHit, ProviderFailure, ResolveDeps,
    ResumeResolveMatch, ResumeResolveProviderError, ResumeResolveStatus,
};

use crate::boot::{is_authed, unauthorized};
use crate::session_metadata::SessionMetadataStore;
use crate::settings_store::SettingsStore;

/// zod `.max(20000)` on `input` (`shared/resume-resolve-contract.ts`).
const RESOLVE_INPUT_MAX_UTF16: usize = 20000;

/// Deadline on EACH admitted blocking fallback task (admission itself is a
/// synchronous fail-fast `try_acquire`, never a wait), mirroring Node's hard
/// per-worker by-id timeout
/// (`opencode-by-id-runner.ts` `DEFAULT_TIMEOUT_MS = 15_000`; the listing
/// runner uses the same value). Node scopes this timeout to the individual
/// worker — its parsing/index paths never wait on it — and so does this
/// port. Without it, a filesystem or SQLite operation stalled OUTSIDE
/// SQLite's 500 ms busy handling would hold this request and a
/// blocking-pool worker alive indefinitely.
pub const RESOLVE_FALLBACK_DEADLINE: std::time::Duration = std::time::Duration::from_millis(15_000);

/// Admission cap on CONCURRENT blocking fallback tasks. Node needs no such
/// cap — its by-id runner `worker.terminate()`s a stalled worker thread at
/// the 15 s timeout, so stalled work never accumulates. A Rust blocking task
/// cannot be killed: on deadline elapse it is ABANDONED and keeps its
/// blocking-pool thread until the underlying FS/SQLite op returns. Without
/// admission control, repeated authenticated requests against a stalled
/// provider store would accumulate abandoned tasks without bound and exhaust
/// Tokio's blocking pool (default max 512 threads), starving UNRELATED
/// server work (every other `spawn_blocking` user). The permit is MOVED INTO
/// the blocking fallback task, so an abandoned task keeps holding it until
/// its underlying op returns — stalled-task accumulation is therefore capped
/// at this count, and the worst case degrades ONLY fallback-requiring
/// resolve requests: parsing, index-only resolution, warming, and
/// no-candidate responses never acquire a permit. Admission is a
/// SYNCHRONOUS `try_acquire_owned()` performed BEFORE the fallback task
/// exists: a starved dispatch fails fast with a degraded provider error
/// rather than parking its resolver worker on the semaphore (queueing there
/// would pin one unbounded outer blocking-pool worker per dispatch for the
/// full deadline — the exact exhaustion this cap exists to prevent).
/// 8 permits comfortably exceed any realistic resolve concurrency (one
/// interactive dialog per user) while staying a small fraction of the pool.
pub const RESOLVE_MAX_CONCURRENCY: usize = 8;

/// opencode `ses_*` by-id fallback: `Ok(Some(hit))` = the lookup resolved the
/// id, `Ok(None)` = miss, `Err(ProviderFailure)` = the provider store could
/// not be searched (recorded as a provider error, result degrades — never a
/// 5xx).
pub type OpencodeByIdLookup =
    Arc<dyn Fn(&str) -> Result<Option<OpencodeByIdHit>, ProviderFailure> + Send + Sync>;

/// claude transcript exact-id fallback: lowercased id + original cwd, same
/// `Result` contract as [`OpencodeByIdLookup`].
pub type ClaudeLocator =
    Arc<dyn Fn(&str) -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> + Send + Sync>;

/// The generic exact-id fallback closure shape shared by
/// [`OpencodeByIdLookup`] (`T = OpencodeByIdHit`) and [`ClaudeLocator`]
/// (`T = ClaudeTranscriptHit`); [`bounded_fallback`] wraps one in the
/// permit + per-dispatch-deadline dispatch.
type FallbackFn<T> = Arc<dyn Fn(&str) -> Result<Option<T>, ProviderFailure> + Send + Sync>;

/// Shared state for the resolve surface.
#[derive(Clone)]
pub struct ResolveState {
    pub auth_token: Arc<String>,
    /// `config.sessionOverrides` reader (`settings_store.rs`): the resolve
    /// read model drops `deleted: true` sessions exactly like the sidebar's
    /// `apply_session_overrides` and Node's post-filter `getProjects()`.
    pub settings: SettingsStore,
    pub session_index: Option<Arc<SessionIndex>>,
    pub session_metadata: SessionMetadataStore,
    pub opencode_session_by_id: Option<OpencodeByIdLookup>,
    pub locate_claude_transcript: Option<ClaudeLocator>,
    /// The USER's home (Node sends `os.homedir()`, `sessions-router.ts:306-314`)
    /// — lets the client prefill a CONCRETE cwd instead of the `~` sentinel.
    /// `None` (no resolvable home) omits `homeDir` from the wire.
    pub home_dir: Option<Arc<String>>,
    /// Deadline for EACH admitted blocking fallback task (admission fails
    /// fast, never waits) — never the resolver around it. Production wires
    /// [`RESOLVE_FALLBACK_DEADLINE`] (Node's 15 s by-id worker timeout);
    /// injectable so tests exercise the timeout path without waiting 15 s.
    pub resolve_deadline: std::time::Duration,
    /// Admission semaphore bounding concurrent blocking FALLBACK tasks (see
    /// [`RESOLVE_MAX_CONCURRENCY`]). Production wires a fresh semaphore with
    /// that many permits; injectable so tests exercise saturation without
    /// spawning eight stalled fallbacks.
    pub resolve_permits: Arc<tokio::sync::Semaphore>,
}

/// `KNOWN_RESUME_PROVIDERS` = `DEFAULT_ENABLED_CLI_PROVIDERS`
/// (`shared/coding-cli-defaults.ts:3`). The indexer scans ONLY
/// settings-enabled providers, so a disabled provider's sessions can never
/// be found — report those as UNSEARCHED so "not found" never overclaims.
/// Order matches the canonical provider list.
const KNOWN_RESUME_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

/// Wire response (`ResumeResolveResponseSchema`): the core outcome plus the
/// router-level provider-health fields. `providerErrors`/`unsearchedProviders`
/// are always present (zod defaults exist for legacy tolerance, but Node
/// always sends them); `homeDir` is omitted only when the server has no
/// resolvable home. Struct field order IS wire key order (workspace-wide
/// `preserve_order`) — it matches the Node object literal,
/// `sessions-router.ts:306-314`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveWireResponse {
    status: ResumeResolveStatus,
    matches: Vec<ResumeResolveMatch>,
    hint: Option<ResumeHint>,
    provider_errors: Vec<ResumeResolveProviderError>,
    unsearched_providers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    home_dir: Option<String>,
}

pub fn router(state: ResolveState) -> Router {
    Router::new()
        .route("/api/sessions/resolve", post(resolve_session))
        .with_state(state)
}

/// zod v4's received-type word for a JSON value.
fn received_type(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "array",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        Value::Object(_) => "object",
    }
}

/// Validate the request body against `ResumeResolveRequestSchema` semantics:
/// strict object, `input: string`, 1..=20000 UTF-16 code units. Returns the
/// input on success, or the `details` issue array on failure — every literal
/// (field set, key ORDER, message wording) is the ACTUAL zod 4.3.6 wire
/// output, probed against the real schema; see the module doc for the
/// version-fragility and no-consumer notes. `json!` insertion order IS the
/// serialized key order (workspace-wide `preserve_order`).
fn validate_resolve_body(body: &Value) -> Result<String, Value> {
    let Value::Object(map) = body else {
        // zod 4.3.6: `expected` precedes `code`; message carries the
        // received type: `[1,2]` -> "...received array", `"x"` ->
        // "...received string", etc.
        return Err(json!([{
            "expected": "object",
            "code": "invalid_type",
            "path": [],
            "message": format!("Invalid input: expected object, received {}", received_type(body))
        }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    // zod emits the shape (`input`) issue BEFORE `unrecognized_keys`
    // (probed: `{foo:1}` -> [invalid_type(input), unrecognized_keys]).
    match map.get("input") {
        Some(Value::String(s)) => {
            let len = s.encode_utf16().count();
            if len < 1 {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too small: expected string to have >=1 characters"
                }));
            } else if len > RESOLVE_INPUT_MAX_UTF16 {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_big",
                    "maximum": RESOLVE_INPUT_MAX_UTF16,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too big: expected string to have <=20000 characters"
                }));
            }
        }
        other => {
            // Missing (`received undefined`) and non-string values both
            // surface zod's invalid_type, with the actual received type.
            let received = other.map_or("undefined", received_type);
            issues.push(json!({
                "expected": "string",
                "code": "invalid_type",
                "path": ["input"],
                "message": format!("Invalid input: expected string, received {received}")
            }));
        }
    }
    let unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|k| *k != "input")
        .collect();
    if !unknown.is_empty() {
        // zod 4.3.6: double-quoted names, singular/plural noun.
        let listed = unknown
            .iter()
            .map(|k| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let noun = if unknown.len() == 1 { "key" } else { "keys" };
        issues.push(json!({
            "code": "unrecognized_keys",
            "keys": unknown,
            "path": [],
            "message": format!("Unrecognized {noun}: {listed}")
        }));
    }
    if issues.is_empty() {
        Ok(map
            .get("input")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    } else {
        Err(Value::Array(issues))
    }
}

/// Wrap ONE provider's exact-id fallback closure in the bounded dispatch
/// that ports Node's per-worker containment (`opencode-by-id-runner.ts`):
/// admission is a SYNCHRONOUS `try_acquire_owned()` on `permits`
/// ([`RESOLVE_MAX_CONCURRENCY`]) — a starved dispatch fails fast with a
/// degraded provider error, never queues — and only an admitted invocation
/// runs on its OWN `spawn_blocking` task, bounded by `deadline` (Node's
/// hard 15 s worker timeout).
///
/// The deadline is scoped to THIS dispatch alone — a timeout here never
/// affects later fallback invocations in the same request. Node bounds
/// each by-id worker individually, records the rejection for that ONE
/// provider, and continues through later candidates/providers
/// (`resolve-session.ts:133-156`); this port does the same, so a stalled
/// opencode store can never fabricate a claude timeout (or vice versa).
/// ERRATA: commit ffa4aac1a shared one cooperative cancel flag across
/// both providers' dispatches, so one timeout skipped every later
/// fallback and blamed providers that were never dispatched; corrected
/// to this per-dispatch scoping.
///
/// RECORDED DEVIATION from Node's cancellation: a blocking task cannot be
/// killed, so on deadline elapse the task is ABANDONED (Node instead
/// `worker.terminate()`s the stalled thread) — the permit MOVES INTO the
/// task, so an abandoned task keeps holding it until its underlying op
/// returns, capping stalled-task accumulation at the permit count; within
/// one request the per-provider budget (`FALLBACK_BUDGET_PER_REQUEST` = 2)
/// caps abandonment at budget × wired providers. A panicking fallback is
/// resumed on the caller thread so the resolver task's JoinError still
/// answers the explicit 500.
///
/// Called from the resolver's blocking thread: admission is synchronous
/// (no runtime needed), then `handle.block_on` re-enters the runtime for
/// the timeout machinery only (never from an async worker thread — the
/// resolver always runs under `spawn_blocking`).
fn bounded_fallback<T: Send + 'static>(
    inner: FallbackFn<T>,
    handle: tokio::runtime::Handle,
    permits: Arc<tokio::sync::Semaphore>,
    deadline: std::time::Duration,
) -> FallbackFn<T> {
    Arc::new(move |id: &str| {
        // Admission FIRST, synchronously, BEFORE any queueing or fallback
        // task exists: a starved dispatch fails fast into the degraded
        // provider-error shape instead of parking this (unbounded) outer
        // resolver worker on the semaphore for up to the full deadline.
        // ERRATA: commits bb357a598..37be35b9a awaited `acquire_owned()`
        // inside the deadline from this thread, so full saturation pinned
        // one outer blocking-pool worker per dispatch for the entire
        // deadline — enough crafted requests could exhaust the pool, the
        // exact failure the semaphore exists to prevent; corrected to this
        // fail-fast `try_acquire_owned()`. (Node has no analogue of this
        // state: it never caps admission because `worker.terminate()`
        // reclaims a stalled worker at its timeout.)
        let permit = match Arc::clone(&permits).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_no_permits) => {
                // The semaphore is never closed, so this is NoPermits:
                // every permit is held by live or abandoned fallbacks.
                tracing::warn!(
                    "resolve fallback rejected: concurrency limit reached; failing fast"
                );
                return Err(ProviderFailure {
                    code: None,
                    message: "resolve concurrency limit reached".to_string(),
                });
            }
        };
        // Node's worker-timeout rejection shape: message-only providerError.
        let message = format!("resolve timed out after {}ms", deadline.as_millis());
        let id = id.to_string();
        let inner = Arc::clone(&inner);
        let task = handle.spawn_blocking(move || {
            let _permit = permit;
            inner(&id)
        });
        let joined = handle.block_on(tokio::time::timeout(deadline, task));
        match joined {
            Ok(Ok(result)) => result,
            Ok(Err(join_error)) => {
                if join_error.is_panic() {
                    // Propagate into the resolver task: its JoinError answers
                    // the explicit 500 (RECORDED DEVIATION, module doc) —
                    // never a fabricated ready-empty.
                    std::panic::resume_unwind(join_error.into_panic());
                }
                Err(ProviderFailure {
                    code: None,
                    message: "resolve fallback task was cancelled".to_string(),
                })
            }
            Err(_elapsed) => {
                // Deadline elapsed — the fallback itself stalled (the
                // permit was already held before the task was spawned, so
                // admission can never consume this budget). Abandon it and
                // blame ONLY this provider; later dispatches in the same
                // request run with their own bounds (Node continues through
                // later candidates/providers, `resolve-session.ts:133-156`).
                tracing::warn!(
                    deadline_ms = deadline.as_millis() as u64,
                    "resolve fallback timed out; abandoning its blocking task"
                );
                Err(ProviderFailure {
                    code: None,
                    message,
                })
            }
        }
    })
}

/// Node's override-key lookup for ONE indexed session
/// (`buildProjectGroups`, `session-indexer.ts:1173-1186`): the composite
/// `"{provider}:{sessionId}"` key first, then the bare session id; only when
/// NEITHER hits and the session is a claude transcript whose file basename
/// differs from its parsed session id (a pre-sessionId-parsing-era override)
/// do the legacy keys apply — composite `"claude:{basename}"`, then the bare
/// basename. First PRESENT entry wins, exactly like Node's `||` chain: an
/// earlier key that maps to an (even empty) object stops the fallthrough.
fn lookup_session_override<'a>(
    overrides: &'a Map<String, Value>,
    session: &IndexedSession,
) -> Option<&'a Map<String, Value>> {
    let direct = overrides
        .get(&session.key())
        .or_else(|| overrides.get(&session.session_id))
        .filter(|v| !v.is_null());
    if let Some(ov) = direct {
        return ov.as_object();
    }
    if session.provider != "claude" {
        return None;
    }
    // `path.basename(sourceFile, '.jsonl')` (`session-indexer.ts:1176`).
    let basename = session.source_file.as_deref()?.file_name()?.to_str()?;
    let legacy_id = basename.strip_suffix(".jsonl").unwrap_or(basename);
    if legacy_id.is_empty() || legacy_id == session.session_id {
        return None;
    }
    overrides
        .get(&format!("claude:{legacy_id}"))
        .or_else(|| overrides.get(legacy_id))
        .filter(|v| !v.is_null())
        .and_then(Value::as_object)
}

/// Node's `applyOverride` (`session-indexer.ts:204-220`) restricted to the
/// fields the resolve wire shape can observe: `deleted` hides the session
/// entirely (`None`), a non-empty `titleOverride` replaces its title
/// (Node's `!!ov?.titleOverride` — an empty string is falsy, never applied).
/// The other fields Node merges (`summaryOverride`, `createdAtOverride`,
/// `archived`) never reach a resolve match — matches carry only
/// title/cwd/lastActivityAt/sessionType/firstUserMessage — so they are not
/// projected here. Node's provider-generated-title suppression is ported too
/// (`session-indexer.ts:210-211`): when the CURRENT parsed title is
/// provider-generated (`IndexedSession::title_provider_generated`, Node's
/// cached `titleSource === 'provider-generated'`) and the stored override's
/// recorded `titleSource` is `dir` or `first-message`, the override is NOT
/// applied — the provider's own title survives, exactly as Node preserves it.
fn project_session_through_overrides(
    session: &IndexedSession,
    overrides: &Map<String, Value>,
) -> Option<IndexedSession> {
    let Some(ov) = lookup_session_override(overrides, session) else {
        return Some(session.clone());
    };
    if ov.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let mut projected = session.clone();
    // Node's `shouldApplyTitleOverride` (`session-indexer.ts:210-211`): the
    // negated conjunction suppresses the override ONLY when the current title
    // is provider-generated AND the override was recorded under the `dir` or
    // `first-message` source — every other source (`user`, `ai`, `legacy`,
    // absent) still substitutes.
    let suppressed = session.title_provider_generated
        && matches!(
            ov.get("titleSource").and_then(Value::as_str),
            Some("dir" | "first-message")
        );
    if let Some(title) = ov
        .get("titleOverride")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && !suppressed)
    {
        projected.title = Some(title.to_string());
    }
    Some(projected)
}

/// Does the request's `Content-Type` match what Node's global
/// `express.json()` (`server/index.ts:185`, express 4.22.1 / body-parser
/// 1.20.4, default `type: 'application/json'`) actually parses? type-is
/// semantics for that default: strip media-type parameters (`; charset=...`),
/// lowercase, then require the EXACT `application/json` media type —
/// `mimeMatch` only widens on `*` patterns, so `application/*+json` (e.g.
/// `application/vnd.api+json`) does NOT match, and an absent or unparseable
/// `Content-Type` never matches.
fn content_type_is_json(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
}

/// `POST /api/sessions/resolve`. Body taken as raw bytes (never an
/// axum-flavored rejection), parsed as JSON ONLY when the `Content-Type`
/// matches Node's `express.json()` matcher ([`content_type_is_json`]): a
/// skipped (non-JSON/absent Content-Type), ABSENT, or UNPARSEABLE body
/// becomes `{}` — body-parser 1.20.x leaves `req.body = {}` when it skips,
/// and Express's `req.body ?? {}` hands zod that same value — so it 400s
/// with the missing-`input` issue. Parsed non-object values
/// (array/string/number/bool/null) flow to the invalid_type-object branch.
/// Recorded deviation (module doc): Express's strict body parser answers
/// malformed JSON and JSON scalars with an HTML 400 before zod ever runs;
/// this port answers those with the zod-shaped JSON 400 (status parity only
/// — no consumer reads 400 bodies). Arrays reach zod on both sides.
/// ERRATA: until this commit the bytes were parsed REGARDLESS of
/// Content-Type, so a valid object under `text/plain` resolved on Rust
/// while Node 400s it — an unrecorded divergence, now closed.
async fn resolve_session(
    State(state): State<ResolveState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let parsed: Value = if content_type_is_json(&headers) {
        serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Map::new()))
    } else {
        Value::Object(Map::new())
    };
    let input = match validate_resolve_body(&parsed) {
        Ok(input) => input,
        Err(details) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid resolve request", "details": details })),
            )
                .into_response();
        }
    };

    // Readiness gate = Node's `getIndexReadiness()`: a never-published (or
    // absent) index answers `warming`. When a snapshot exists,
    // `snapshot_with_failures()` returns it immediately
    // (stale-while-revalidate) — it only blocks when truly cold, which
    // `peek()` has already excluded.
    //
    // ONE COHERENT READ: the snapshot AND its scan failures come from the
    // SAME published generation, in one lock acquisition. Reading them
    // separately (snapshot here, `scan_failures()` after the resolve task)
    // opened a window where a background sweep published in between — the
    // response could pair a failed-scan empty snapshot with a subsequently
    // cleared failure set (a healthy-looking `ready + matches: []` lie), or
    // a recovered snapshot with stale failures. A warming index has no
    // published generation, hence no failures.
    let (snapshot, scan_failure_names) = match state.session_index.as_ref() {
        Some(index) => match index.peek() {
            Some(_) => {
                let (items, failures) = index.snapshot_with_failures().await;
                (Some(items), failures)
            }
            None => (None, Vec::new()),
        },
        None => (None, Vec::new()),
    };

    // Override projection: Node's resolve reads the POST-override project
    // groups (`resolve-session.ts:85` via `session-indexer.ts:1173-1187`,
    // `applyOverride` at `session-indexer.ts:204-220`), so the Rust read
    // model must project the snapshot through the SAME overlay before any
    // matching: `deleted` hides the session, `titleOverride` replaces its
    // title, and the override is looked up under EVERY key shape Node
    // recognizes (composite `provider:sessionId`, bare session id, and the
    // legacy claude transcript-basename keys) — see
    // `lookup_session_override` / `project_session_through_overrides`. The
    // exact-id FALLBACKS below intentionally BYPASS this projection —
    // Node's fallbacks read sqlite/the filesystem directly and never
    // consult overrides — bug-for-bug.
    // Read the enabled set BEFORE dispatching the core resolve, and FILTER
    // the snapshot with it: Node's index EXCLUDES disabled providers at scan
    // time (`session-indexer.ts:1454-1467`), so its resolution never sees
    // their sessions (`resolve-session.ts:85`). The Rust SessionIndex is
    // built with all four sources unconditionally, so the route must apply
    // the equivalent gate — otherwise a disabled provider's indexed session
    // resolves while the same response lists that provider under
    // `unsearchedProviders`. Fallbacks stay UNGATED (Node invokes all wired
    // exact-id fallbacks regardless of settings — `resolve-session.ts:127-156`).
    let enabled: std::collections::HashSet<String> = state
        .settings
        .coding_cli_enabled_providers()
        .await
        .into_iter()
        .collect();

    let snapshot: Option<Vec<IndexedSession>> = snapshot.map(|sessions| {
        let overrides = state.settings.session_overrides();
        sessions
            .iter()
            .filter(|session| enabled.contains(&session.provider))
            .filter_map(|session| project_session_through_overrides(session, &overrides))
            .collect()
    });

    // sessionType overlay (Node: `session-indexer.ts:1159-1161`), keyed
    // `"{provider}:{session_id}"`. Only needed when we can match at all.
    let session_types: HashMap<String, String> = if snapshot.is_some() {
        state
            .session_metadata
            .get_all()
            .await
            .into_iter()
            .filter_map(|(key, entry)| {
                entry
                    .get("sessionType")
                    .and_then(Value::as_str)
                    .map(|t| (key, t.to_string()))
            })
            .collect()
    } else {
        HashMap::new()
    };

    // Each fallback dispatch below is bounded INDEPENDENTLY (own deadline,
    // own permit): a timeout in one provider's dispatch never skips — or
    // fabricates a timeout for — later dispatches, matching Node's
    // per-worker containment (`resolve-session.ts:133-156` records the
    // rejection for that provider and continues). Abandoned-task
    // accumulation is capped by the per-provider budget within a request
    // and by the admission semaphore across requests.
    // Captured HERE (async context) so the blocking resolver thread can
    // dispatch each fallback back onto the runtime via `Handle::block_on`.
    let handle = tokio::runtime::Handle::current();
    let opencode: Option<OpencodeByIdLookup> = state.opencode_session_by_id.clone().map(|inner| {
        bounded_fallback(
            inner,
            handle.clone(),
            Arc::clone(&state.resolve_permits),
            state.resolve_deadline,
        )
    });
    let claude: Option<ClaudeLocator> = state.locate_claude_transcript.clone().map(|inner| {
        bounded_fallback(
            inner,
            handle.clone(),
            Arc::clone(&state.resolve_permits),
            state.resolve_deadline,
        )
    });
    // The resolver task itself runs WITHOUT a permit and WITHOUT a deadline
    // (Node parity: parsing, warming checks, in-memory index matching, and
    // no-candidate responses never wait on fallback-worker availability —
    // its 15 s timeout wraps the individual by-id worker only,
    // `opencode-by-id-runner.ts`). Its non-fallback work is bounded
    // in-memory matching, and every stall-prone fallback invocation inside
    // it is bounded by the permit + deadline dispatch above, so this task's
    // lifetime is bounded even against a fully stalled provider store.
    let joined = tokio::task::spawn_blocking(move || {
        let deps = ResolveDeps {
            // as_deref (Option<Vec<T>> -> Option<&[T]>): as_ref().map(|s| s.as_slice())
            // trips clippy's warn-by-default `option_as_ref_deref` under -D warnings.
            sessions: snapshot.as_deref(),
            session_types: &session_types,
            locate_claude_transcript: claude.as_deref(),
            opencode_session_by_id: opencode.as_deref(),
        };
        resolve_resume_input(&input, &deps)
    })
    .await;

    // JoinError = the resolve task PANICKED. RECORDED DEVIATION (module
    // doc): Node has no defined behavior here (unhandled rejection, no
    // response); the explicit 500 is the honest port — the hardened
    // contract forbids presenting an unsearchable state as a healthy
    // "not found", so NEVER fabricate a ready-empty result. The panic
    // itself is already on stderr for diagnosis.
    let outcome = match joined {
        Ok(outcome) => outcome,
        Err(join_error) => {
            tracing::error!(error = %join_error, "resolve task panicked");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Resolve failed" })),
            )
                .into_response();
        }
    };

    // Router-level merge (`sessions-router.ts:280-314`).
    let unsearched_providers: Vec<String> = KNOWN_RESUME_PROVIDERS
        .iter()
        .filter(|name| !enabled.contains(**name))
        .map(|name| (*name).to_string())
        .collect();
    // Scan failures: enabled-only, fallback errors win the dedupe (more
    // specific code/message). A DISABLED provider is unsearched (reported
    // above), never a provider error — otherwise a failed-then-disabled
    // provider would keep responses degraded forever (no successful scan
    // could ever clear it).
    // `scan_failure_names` was captured atomically WITH the snapshot above
    // (one generation, one lock) — never re-read here, where a background
    // sweep completing mid-request could pair the earlier snapshot with a
    // newer (cleared or stale) failure set.
    let mut provider_errors = outcome.provider_errors;
    for name in scan_failure_names {
        if !enabled.contains(&name) || provider_errors.iter().any(|e| e.provider == name) {
            continue;
        }
        provider_errors.push(ResumeResolveProviderError {
            provider: name,
            code: None,
            message: Some("session scan failed".to_string()),
        });
    }
    // degraded = something FAILED — even when matches exist: a failed
    // provider means a HIGHER-priority exact match may have been missed, so
    // the client must never auto-resume a surviving lower-priority match.
    let status = match outcome.status {
        ResumeResolveStatus::Warming => ResumeResolveStatus::Warming,
        _ if !provider_errors.is_empty() => ResumeResolveStatus::Degraded,
        _ => ResumeResolveStatus::Ready,
    };
    // Fire-and-forget: give the user's Retry a chance to converge once a
    // failed provider recovers (scan failures only clear on a new scan).
    if status == ResumeResolveStatus::Degraded {
        if let Some(index) = state.session_index.as_ref() {
            index.request_refresh();
        }
    }
    Json(ResolveWireResponse {
        status,
        matches: outcome.matches,
        hint: outcome.hint,
        provider_errors,
        unsearched_providers,
        home_dir: state.home_dir.as_ref().map(|h| h.as_str().to_string()),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use freshell_sessions::directory_index::{
        FileStat, IndexedSession, SessionIndex, SessionSource,
    };

    const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";

    /// A file-less, direct-listed source: `discover()` empty, `direct_list()`
    /// serves the fixture rows — a hermetic SessionIndex with zero disk IO.
    struct FixtureSource(Vec<IndexedSession>);

    impl SessionSource for FixtureSource {
        fn discover(&self) -> Vec<FileStat> {
            Vec::new()
        }
        fn parse(&self, _path: &std::path::Path) -> Option<IndexedSession> {
            None
        }
        fn direct_change_token(&self) -> Option<i64> {
            Some(1)
        }
        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            Ok(self.0.clone())
        }
    }

    async fn fixture_index(sessions: Vec<IndexedSession>) -> Arc<SessionIndex> {
        fixture_index_with_sources(vec![
            Arc::new(FixtureSource(sessions)) as Arc<dyn SessionSource>
        ])
        .await
    }

    async fn fixture_index_with_sources(sources: Vec<Arc<dyn SessionSource>>) -> Arc<SessionIndex> {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            sources,
            std::time::Duration::from_secs(3600),
            None,
        ));
        index.warm().await;
        index
    }

    /// The Task-5 `FlakySource` shape (`directory_index.rs` tests): a
    /// direct-listed opencode source whose `direct_list()` errs while
    /// `broken` is true. The change token CHANGES every call so each sweep
    /// re-queries — recovery is observable after `broken` flips to false.
    struct FailingDirectSource {
        broken: Arc<std::sync::atomic::AtomicBool>,
        counter: std::sync::atomic::AtomicI64,
    }

    impl FailingDirectSource {
        fn new(broken: Arc<std::sync::atomic::AtomicBool>) -> Self {
            Self {
                broken,
                counter: std::sync::atomic::AtomicI64::new(0),
            }
        }
    }

    impl SessionSource for FailingDirectSource {
        fn discover(&self) -> Vec<FileStat> {
            Vec::new()
        }
        fn parse(&self, _path: &std::path::Path) -> Option<IndexedSession> {
            None
        }
        fn provider_name(&self) -> Option<&'static str> {
            Some("opencode")
        }
        fn direct_change_token(&self) -> Option<i64> {
            Some(
                self.counter
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            )
        }
        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
                Err("unable to open database file".to_string())
            } else {
                Ok(Vec::new())
            }
        }
    }

    /// Seed `<dir>/.freshell/config.json` with the WRAPPED settings document
    /// (`SettingsStore` unwraps the top-level `settings` key — see
    /// `load_full_settings` in `settings_store.rs`; a bare `codingCli`
    /// object would be silently ignored, reading defaults).
    fn seed_enabled_providers(dir: &std::path::Path, providers: &[&str]) {
        let cfg_dir = dir.join(".freshell");
        std::fs::create_dir_all(&cfg_dir).expect("mkdir .freshell");
        std::fs::write(
            cfg_dir.join("config.json"),
            serde_json::json!({
                "version": 1,
                "settings": { "codingCli": { "enabledProviders": providers } }
            })
            .to_string(),
        )
        .expect("seed config.json");
    }

    fn claude_fixture() -> IndexedSession {
        IndexedSession {
            session_id: CLAUDE_ID.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo/alpha".to_string(),
            title: Some("Fix the parser".to_string()),
            title_provider_generated: false,
            title_source: None,
            summary: None,
            first_user_message: Some("fix the parser".to_string()),
            last_activity_at: 400,
            created_at: None,
            cwd: Some("/repo/alpha".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            git_branch: None,
            source_file: None,
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "frs-resolve-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp dir");
        dir
    }

    fn state(dir: &std::path::Path, index: Option<Arc<SessionIndex>>) -> super::ResolveState {
        super::ResolveState {
            auth_token: Arc::new("tok".into()),
            // Isolated home: overrides read/write under `<dir>/.freshell/`,
            // never the developer's real config (same pattern as the
            // session_directory router tests). All four Node providers are
            // discovered, and the fresh-store default enables all four
            // (Node's `DEFAULT_ENABLED_CLI_PROVIDERS`), so the baseline
            // `unsearchedProviders` is `[]` — deterministic expectations.
            settings: crate::settings_store::SettingsStore::load(
                Some(dir),
                vec![
                    "claude".into(),
                    "codex".into(),
                    "opencode".into(),
                    "amplifier".into(),
                ],
            ),
            session_index: index,
            session_metadata: crate::session_metadata::SessionMetadataStore::new(dir),
            opencode_session_by_id: None,
            locate_claude_transcript: None,
            home_dir: Some(Arc::new("/home/tester".to_string())),
            resolve_deadline: super::RESOLVE_FALLBACK_DEADLINE,
            resolve_permits: Arc::new(tokio::sync::Semaphore::new(super::RESOLVE_MAX_CONCURRENCY)),
        }
    }

    async fn post(
        state: super::ResolveState,
        body: serde_json::Value,
        with_auth: bool,
    ) -> (StatusCode, serde_json::Value) {
        post_with_content_type(state, body, Some("application/json"), with_auth).await
    }

    /// Like [`post`] but with an arbitrary (or absent) `Content-Type` header
    /// — the Node reference (`express.json()` at `server/index.ts:185`) only
    /// parses JSON-typed bodies, so the route tests must be able to send
    /// non-JSON media types.
    async fn post_with_content_type(
        state: super::ResolveState,
        body: serde_json::Value,
        content_type: Option<&str>,
        with_auth: bool,
    ) -> (StatusCode, serde_json::Value) {
        let app = super::router(state);
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/sessions/resolve");
        if let Some(ct) = content_type {
            builder = builder.header("content-type", ct);
        }
        if with_auth {
            builder = builder.header("x-auth-token", "tok");
        }
        let request = builder.body(Body::from(body.to_string())).unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, value)
    }

    /// The zod issue Node emits when `req.body` was never populated:
    /// `express.json()` skipped the body (non-JSON or absent Content-Type),
    /// body-parser 1.20.x leaves `req.body = {}`, and
    /// `safeParse(req.body ?? {})` reports the missing `input`.
    fn missing_input_details() -> serde_json::Value {
        serde_json::json!([{
            "expected": "string",
            "code": "invalid_type",
            "path": ["input"],
            "message": "Invalid input: expected string, received undefined"
        }])
    }

    #[tokio::test]
    async fn non_json_content_type_body_is_never_parsed() {
        // Node's global `express.json()` (`server/index.ts:185`, default
        // `type: 'application/json'`) skips non-matching media types —
        // type-is requires the EXACT `application/json` media type, so
        // `application/*+json` is skipped too — leaving `req.body = {}` and
        // the route 400s with the missing-`input` issue
        // (`sessions-router.ts:259-264`). A valid JSON object under
        // `text/plain` must NOT resolve.
        for ct in ["text/plain", "application/vnd.api+json"] {
            let dir = temp_dir("ctgate");
            let (status, body) = post_with_content_type(
                state(&dir, None),
                serde_json::json!({ "input": CLAUDE_ID }),
                Some(ct),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "content-type {ct}");
            assert_eq!(
                body,
                serde_json::json!({
                    "error": "Invalid resolve request",
                    "details": missing_input_details()
                }),
                "content-type {ct}"
            );
        }
    }

    #[tokio::test]
    async fn json_content_type_with_parameters_or_case_still_parses() {
        // type-is strips parameters and lowercases before matching, so
        // `application/json; charset=utf-8` (and case variants) still parse.
        for ct in ["application/json; charset=utf-8", "Application/JSON"] {
            let dir = temp_dir("ctok");
            let (status, body) = post_with_content_type(
                state(&dir, None),
                serde_json::json!({ "input": CLAUDE_ID }),
                Some(ct),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "content-type {ct}");
            assert_eq!(body["status"], "warming", "content-type {ct}"); // no index in this state
        }
    }

    #[tokio::test]
    async fn missing_content_type_is_treated_as_an_unparsed_body() {
        // No Content-Type header: type-is cannot match, `express.json()`
        // skips, `req.body = {}` — same missing-`input` 400 as `text/plain`.
        let dir = temp_dir("ctnone");
        let (status, body) = post_with_content_type(
            state(&dir, None),
            serde_json::json!({ "input": CLAUDE_ID }),
            None,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            serde_json::json!({
                "error": "Invalid resolve request",
                "details": missing_input_details()
            })
        );
    }

    #[tokio::test]
    async fn rejects_unauthenticated_requests() {
        let dir = temp_dir("auth");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": CLAUDE_ID }),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, serde_json::json!({ "error": "Unauthorized" }));
    }

    #[tokio::test]
    async fn rejects_unknown_keys_with_the_zod_4_3_6_literal() {
        // `input` valid, two unknown keys: exactly ONE issue, plural noun,
        // double-quoted names, key order code/keys/path/message.
        let dir = temp_dir("strict");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": "x", "foo": 1, "bar": 2 }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid resolve request");
        assert_eq!(
            body["details"],
            serde_json::json!([{
                "code": "unrecognized_keys",
                "keys": ["foo", "bar"],
                "path": [],
                "message": "Unrecognized keys: \"foo\", \"bar\""
            }])
        );
    }

    #[tokio::test]
    async fn multi_issue_order_is_input_issue_then_unrecognized_keys() {
        // Probed zod 4.3.6 behavior for `{foo:1}`: the `input` invalid_type
        // issue comes FIRST, `unrecognized_keys` (singular form) SECOND.
        let dir = temp_dir("multi");
        let (status, body) = post(state(&dir, None), serde_json::json!({ "foo": 1 }), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["details"],
            serde_json::json!([
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received undefined"
                },
                {
                    "code": "unrecognized_keys",
                    "keys": ["foo"],
                    "path": [],
                    "message": "Unrecognized key: \"foo\""
                }
            ])
        );
    }

    #[tokio::test]
    async fn zod_details_literals_match_zod_4_3_6_wire_output() {
        // One case per failure class; expectations are the EXACT zod 4.3.6
        // `parsed.error.issues` output probed against the real schema. The
        // scalar bodies (`null` here) are the recorded deviation: Express's
        // strict body parser HTML-400s them before zod, Rust answers the
        // zod-shaped issue for the parsed value instead.
        let dir = temp_dir("bounds");
        let cases: Vec<(serde_json::Value, serde_json::Value)> = vec![
            (
                serde_json::json!({ "input": "" }),
                serde_json::json!([{
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too small: expected string to have >=1 characters"
                }]),
            ),
            (
                serde_json::json!({}),
                serde_json::json!([{
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received undefined"
                }]),
            ),
            (
                serde_json::json!({ "input": 123 }),
                serde_json::json!([{
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received number"
                }]),
            ),
            (
                serde_json::json!({ "input": "x".repeat(20001) }),
                serde_json::json!([{
                    "origin": "string",
                    "code": "too_big",
                    "maximum": 20000,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too big: expected string to have <=20000 characters"
                }]),
            ),
            (
                serde_json::json!([1, 2]),
                serde_json::json!([{
                    "expected": "object",
                    "code": "invalid_type",
                    "path": [],
                    "message": "Invalid input: expected object, received array"
                }]),
            ),
            (
                serde_json::json!(null),
                serde_json::json!([{
                    "expected": "object",
                    "code": "invalid_type",
                    "path": [],
                    "message": "Invalid input: expected object, received null"
                }]),
            ),
        ];
        for (body, details) in cases {
            let (status, response) = post(state(&dir, None), body.clone(), true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body {body}");
            assert_eq!(response["error"], "Invalid resolve request", "body {body}");
            assert_eq!(response["details"], details, "body {body}");
        }
        // Key ORDER is part of the wire shape (zod v4 emits `expected` /
        // `origin` BEFORE `code`). `Value` equality is order-insensitive, so
        // pin one case as a serialized string — `preserve_order` makes the
        // parsed order round-trip the wire order.
        let (_, response) =
            post(state(&dir, None), serde_json::json!({ "input": 123 }), true).await;
        assert_eq!(
            serde_json::to_string(&response["details"]).unwrap(),
            r#"[{"expected":"string","code":"invalid_type","path":["input"],"message":"Invalid input: expected string, received number"}]"#
        );
    }

    #[tokio::test]
    async fn input_of_exactly_20000_chars_is_accepted() {
        let dir = temp_dir("maxok");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": "x".repeat(20000) }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "warming"); // no index in this state
    }

    #[tokio::test]
    async fn warming_with_hint_when_index_never_published() {
        let dir = temp_dir("warming");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": format!("claude --resume {CLAUDE_ID}") }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "warming",
                "matches": [],
                "hint": { "provider": "claude", "source": "command" },
                "providerErrors": [],
                "unsearchedProviders": [],
                "homeDir": "/home/tester"
            })
        );
    }

    #[tokio::test]
    async fn exact_match_returns_full_metadata_via_the_index() {
        let dir = temp_dir("exact");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": CLAUDE_ID,
                "cwd": "/repo/alpha",
                // Hardened Node emits `sessionType ?? provider` — never absent.
                "sessionType": "claude",
                "title": "Fix the parser",
                "firstUserMessage": "fix the parser",
                "lastActivityAt": 400,
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn session_type_overlays_from_the_metadata_store_file() {
        let dir = temp_dir("stype");
        std::fs::write(
            dir.join("session-metadata.json"),
            serde_json::json!({
                "version": 1,
                "sessions": {
                    "claude": {
                        CLAUDE_ID: { "sessionType": "freshclaude", "sessionTypeSource": "explicit" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let index = fixture_index(vec![claude_fixture()]).await;
        let (_, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(body["matches"][0]["sessionType"], "freshclaude");
    }

    #[tokio::test]
    async fn unknown_id_is_ready_empty_never_404() {
        let dir = temp_dir("miss");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": "019fffff-ffff-7fff-bfff-ffffffffffff" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn opencode_fallback_answers_with_row_directory() {
        let dir = temp_dir("ocfb");
        let index = fixture_index(vec![claude_fixture()]).await;
        let unknown = "ses_child000000000000000000000";
        let mut st = state(&dir, Some(index));
        st.opencode_session_by_id = Some(Arc::new(|id: &str| {
            Ok(Some(freshell_sessions::resume_resolve::OpencodeByIdHit {
                session_id: id.to_string(),
                cwd: Some("/repo/beta".to_string()),
                title: Some("beta".to_string()),
                last_activity_at: Some(1234),
            }))
        }));
        let (status, body) = post(st, serde_json::json!({ "input": unknown }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "opencode",
                "sessionId": unknown,
                "cwd": "/repo/beta",
                "sessionType": "opencode",
                "title": "beta",
                "lastActivityAt": 1234,
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn claude_transcript_fallback_answers_on_index_miss() {
        let dir = temp_dir("clfb");
        let index = fixture_index(vec![claude_fixture()]).await;
        let unknown = "aaaaaaaa-1111-4222-8333-444444444444";
        let mut st = state(&dir, Some(index));
        st.locate_claude_transcript = Some(Arc::new(move |id: &str| {
            Ok(Some(
                freshell_sessions::resume_resolve::ClaudeTranscriptHit {
                    session_id: id.to_ascii_lowercase(),
                    cwd: Some("/repo/gamma".to_string()),
                },
            ))
        }));
        let (status, body) = post(st, serde_json::json!({ "input": unknown }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": unknown,
                "cwd": "/repo/gamma",
                "sessionType": "claude",
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn deleted_override_hides_the_session_from_resolve() {
        // Node's resolve reads the post-deleted-filter project groups
        // (`session-indexer.ts:209,1155-1156`) and the Rust sidebar filters
        // the same way (`session_directory.rs::apply_session_overrides`) —
        // the resolve read model must agree with both. Written through the
        // REAL override write path (`patch_session_override`, the same call
        // `PATCH /api/sessions/{id}` lands on).
        let dir = temp_dir("deleted");
        let index = fixture_index(vec![claude_fixture()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{CLAUDE_ID}"),
                &[("deleted", Some(serde_json::json!(true)))],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    /// The pre-parsing-era transcript basename for the legacy-override tests:
    /// differs from `CLAUDE_ID`, so Node's legacy branch
    /// (`session-indexer.ts:1175-1186`) fires for it.
    const LEGACY_BASENAME: &str = "11111111-2222-4333-8444-555555555555";

    /// `claude_fixture()` whose transcript file basename differs from its
    /// parsed session id — the shape that makes Node consult the legacy
    /// `claude:{basename}` / bare-`{basename}` override keys.
    fn claude_fixture_with_legacy_source() -> IndexedSession {
        IndexedSession {
            source_file: Some(std::path::PathBuf::from(format!(
                "/home/tester/.claude/projects/-repo-alpha/{LEGACY_BASENAME}.jsonl"
            ))),
            ..claude_fixture()
        }
    }

    #[tokio::test]
    async fn title_override_projects_onto_resolve_matches() {
        // Node's resolve reads the POST-override projection
        // (`resolve-session.ts:85` via `session-indexer.ts:1187,204-220`):
        // a user rename (`titleOverride`) must be visible on the resolve
        // wire, not the stale parsed title.
        let dir = temp_dir("titleov");
        let index = fixture_index(vec![claude_fixture()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{CLAUDE_ID}"),
                &[
                    ("titleOverride", Some(serde_json::json!("Renamed by user"))),
                    ("titleSource", Some(serde_json::json!("user"))),
                ],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
        assert_eq!(body["matches"][0]["title"], "Renamed by user");
    }

    /// `claude_fixture()` whose title the PROVIDER generated (Node's
    /// parse-layer `titleSource: 'provider-generated'`,
    /// `providers/claude.ts:505`).
    fn claude_fixture_provider_titled() -> IndexedSession {
        IndexedSession {
            title: Some("Provider generated title".to_string()),
            title_provider_generated: true,
            ..claude_fixture()
        }
    }

    /// Shared body for the suppression pair: a session whose CURRENT title is
    /// provider-generated, with a stored override recorded under
    /// `titleSource: {override_source}` — Node's `applyOverride`
    /// (`session-indexer.ts:210-211`) must PRESERVE the provider title.
    async fn assert_provider_title_survives_override(tag: &str, override_source: &str) {
        let dir = temp_dir(tag);
        let index = fixture_index(vec![claude_fixture_provider_titled()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{CLAUDE_ID}"),
                &[
                    (
                        "titleOverride",
                        Some(serde_json::json!("stale placeholder")),
                    ),
                    ("titleSource", Some(serde_json::json!(override_source))),
                ],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
        assert_eq!(
            body["matches"][0]["title"], "Provider generated title",
            "a {override_source}-sourced override must not clobber a provider-generated title"
        );
    }

    #[tokio::test]
    async fn provider_generated_title_survives_dir_sourced_override() {
        // Node's suppression branch (`session-indexer.ts:210-211`): a stale
        // `dir`-sourced override never replaces a CURRENT provider-generated
        // title on the projected (pre-matching) session view.
        assert_provider_title_survives_override("provdir", "dir").await;
    }

    #[tokio::test]
    async fn provider_generated_title_survives_first_message_sourced_override() {
        // Same branch, second suppressed source: `first-message`.
        assert_provider_title_survives_override("provfirstmsg", "first-message").await;
    }

    #[tokio::test]
    async fn user_rename_still_overrides_a_provider_generated_title() {
        // The suppression is SCOPED to `dir`/`first-message` override sources:
        // an explicit user rename (`titleSource: 'user'`) substitutes even
        // over a provider-generated title (`session-indexer.ts:210-211` —
        // the negated conjunction only matches those two sources).
        let dir = temp_dir("provuser");
        let index = fixture_index(vec![claude_fixture_provider_titled()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{CLAUDE_ID}"),
                &[
                    ("titleOverride", Some(serde_json::json!("Renamed by user"))),
                    ("titleSource", Some(serde_json::json!("user"))),
                ],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"][0]["title"], "Renamed by user");
    }

    #[tokio::test]
    async fn bare_session_id_deleted_override_hides_prefix_matches() {
        // Node's override lookup falls back to the BARE session-id key
        // (`session-indexer.ts:1174`); a session deleted under it must not
        // resurface as a prefix match on the Rust side.
        let dir = temp_dir("baredel");
        let index = fixture_index(vec![claude_fixture()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(CLAUDE_ID, &[("deleted", Some(serde_json::json!(true)))])
            .await;
        let prefix = &CLAUDE_ID[..12];
        let (status, body) = post(st, serde_json::json!({ "input": prefix }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn legacy_claude_composite_basename_deleted_override_hides_the_session() {
        // Node's legacy branch (`session-indexer.ts:1175-1186`): when neither
        // the composite nor bare current-id key hits and the claude
        // transcript's file basename differs from its session id, the
        // `claude:{basename}` key applies.
        let dir = temp_dir("legacycomp");
        let index = fixture_index(vec![claude_fixture_with_legacy_source()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{LEGACY_BASENAME}"),
                &[("deleted", Some(serde_json::json!(true)))],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn legacy_claude_bare_basename_deleted_override_hides_the_session() {
        // The deepest rung of Node's lookup chain
        // (`session-indexer.ts:1179`): the bare transcript-basename key.
        let dir = temp_dir("legacybare");
        let index = fixture_index(vec![claude_fixture_with_legacy_source()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                LEGACY_BASENAME,
                &[("deleted", Some(serde_json::json!(true)))],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn malformed_json_body_degrades_to_the_missing_input_400() {
        // Express's strict body parser answers malformed JSON with an HTML
        // 400 before zod runs; this port treats an unparseable body as `{}`
        // (Node's absent-body `req.body ?? {}`) and answers the zod-shaped
        // missing-`input` 400 — status parity only, a recorded deviation.
        let dir = temp_dir("badjson");
        let app = super::router(state(&dir, None));
        let request = Request::builder()
            .method("POST")
            .uri("/api/sessions/resolve")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(Body::from("{not json"))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Invalid resolve request");
        assert_eq!(
            body["details"],
            serde_json::json!([{
                "expected": "string",
                "code": "invalid_type",
                "path": ["input"],
                "message": "Invalid input: expected string, received undefined"
            }])
        );
    }

    // -- Task 6 (resolve parity): hardened wire surface ---------------------

    #[tokio::test]
    async fn wire_shape_carries_the_hardened_provider_health_fields() {
        let dir = temp_dir("wire");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["providerErrors"], serde_json::json!([]));
        assert!(body["unsearchedProviders"].is_array());
        // Baseline is [] — the fresh-store default enables all FOUR Node
        // providers (`DEFAULT_ENABLED_CLI_PROVIDERS` incl. amplifier); a
        // regression in that default must fail loudly here.
        assert_eq!(body["unsearchedProviders"], serde_json::json!([]));
        assert_eq!(body["homeDir"], "/home/tester");
    }

    #[tokio::test]
    async fn broken_opencode_store_degrades_with_a_provider_error_never_silent_not_found() {
        // THE acceptance test (context §4): an unreadable provider store yields
        // degraded + providerErrors on the wire — matches stay empty, status is
        // NOT "ready".
        let dir = temp_dir("degraded");
        let index = fixture_index(vec![claude_fixture()]).await;
        let mut st = state(&dir, Some(index));
        // Node production parity (`sessions-resolve-router.test.ts:308-320`): the
        // opencode worker boundary strips `.code`, so the wire entry is
        // message-only — `code` must be ABSENT, not null-with-key. The production
        // closure (main.rs) maps OpencodeByIdError to code: None accordingly.
        st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
            Err(freshell_sessions::resume_resolve::ProviderFailure {
                code: None,
                message: "unable to open database file".into(),
            })
        }));
        let (status, body) = post(
            st,
            serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "degraded");
        assert_eq!(body["matches"], serde_json::json!([]));
        assert_eq!(
            body["providerErrors"],
            serde_json::json!([{ "provider": "opencode", "message": "unable to open database file" }])
        );
    }

    #[tokio::test]
    async fn degraded_even_with_matches_when_a_higher_priority_fallback_failed() {
        // ses_ fallback fails; the later hex token still prefix-matches the index
        // — the response carries the match AND stays degraded (no auto-resume).
        let dir = temp_dir("degmatch");
        let mut amp = claude_fixture();
        amp.provider = "amplifier".to_string();
        amp.session_id = "417e8345aaaa".to_string();
        let index = fixture_index(vec![amp]).await;
        let mut st = state(&dir, Some(index));
        st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
            Err(freshell_sessions::resume_resolve::ProviderFailure {
                code: None,
                message: "locked".into(),
            })
        }));
        let (_, body) = post(
            st,
            serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa 417e8345" }),
            true,
        )
        .await;
        assert_eq!(body["status"], "degraded");
        assert_eq!(body["matches"][0]["sessionId"], "417e8345aaaa");
    }

    #[tokio::test]
    async fn a_provider_scan_failure_reports_degraded_with_the_scan_failed_literal() {
        // Index whose direct-listed source errs → scan_failures ["opencode"] →
        // degraded + {provider:"opencode", message:"session scan failed"} even
        // though no fallback ran.
        let dir = temp_dir("scanfail");
        let broken = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let index = fixture_index_with_sources(vec![
            Arc::new(FixtureSource(vec![claude_fixture()])) as Arc<dyn SessionSource>,
            Arc::new(FailingDirectSource::new(broken)) as Arc<dyn SessionSource>,
        ])
        .await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "degraded");
        assert_eq!(
            body["providerErrors"],
            serde_json::json!([{ "provider": "opencode", "message": "session scan failed" }])
        );
        // degraded ≠ empty: the exact index hit still rides along.
        assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
    }

    #[tokio::test]
    async fn disabled_providers_are_reported_unsearched_never_as_errors() {
        // Settings with enabledProviders ["claude"]: unsearchedProviders lists
        // the other three; a scan failure for DISABLED opencode is excluded
        // from providerErrors and the response stays "ready" (a
        // failed-then-disabled provider must not stick degraded forever).
        let dir = temp_dir("disabled");
        seed_enabled_providers(&dir, &["claude"]);
        let broken = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let index = fixture_index_with_sources(vec![
            Arc::new(FixtureSource(vec![claude_fixture()])) as Arc<dyn SessionSource>,
            Arc::new(FailingDirectSource::new(broken)) as Arc<dyn SessionSource>,
        ])
        .await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["providerErrors"], serde_json::json!([]));
        let unsearched = body["unsearchedProviders"].as_array().unwrap();
        for name in ["codex", "opencode", "amplifier"] {
            assert!(
                unsearched.iter().any(|v| v == name),
                "{name} must be listed unsearched, got {unsearched:?}"
            );
        }
    }

    #[tokio::test]
    async fn disabled_provider_indexed_sessions_do_not_resolve() {
        // Node's INDEX excludes disabled providers (session-indexer.ts:1454-1467),
        // so its resolution never sees their sessions (resolve-session.ts:85).
        // Rust must filter the snapshot by the live enabled set BEFORE core
        // resolution — a disabled provider's session resolving while that
        // provider is listed in unsearchedProviders would be self-contradictory.
        let dir = temp_dir("disidx");
        seed_enabled_providers(&dir, &["claude"]);
        let codex_id = "0198c0de-aaaa-4bbb-8ccc-1234567890ab";
        let mut codex = claude_fixture();
        codex.provider = "codex".to_string();
        codex.session_id = codex_id.to_string();
        let index = fixture_index(vec![codex]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": codex_id }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
        let unsearched = body["unsearchedProviders"].as_array().unwrap();
        assert!(
            unsearched.iter().any(|v| v == "codex"),
            "codex must be listed unsearched, got {unsearched:?}"
        );
    }

    #[tokio::test]
    async fn a_disabled_provider_exact_id_still_resolves_via_fallback_node_parity() {
        // Node wires ALL FOUR providers' exact-id fallbacks unconditionally
        // (server/index.ts wiring; resolve-session.ts:127-156 invokes them
        // regardless of settings) — settings gate INDEXING only. A disabled
        // opencode's exact ses_ id must therefore still resolve via the
        // fallback, while "opencode" stays listed in unsearchedProviders.
        const SES_ID: &str = "ses_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        let dir = temp_dir("disfb");
        seed_enabled_providers(&dir, &["claude"]);
        let index = fixture_index(Vec::new()).await;
        let mut st = state(&dir, Some(index));
        st.opencode_session_by_id = Some(Arc::new(|id: &str| {
            Ok(Some(freshell_sessions::resume_resolve::OpencodeByIdHit {
                session_id: id.to_string(),
                cwd: Some("/repo/delta".to_string()),
                title: None,
                last_activity_at: None,
            }))
        }));
        let (status, body) = post(st, serde_json::json!({ "input": SES_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"][0]["sessionId"], SES_ID);
        let unsearched = body["unsearchedProviders"].as_array().unwrap();
        assert!(
            unsearched.iter().any(|v| v == "opencode"),
            "opencode must be listed unsearched, got {unsearched:?}"
        );
    }

    #[tokio::test]
    async fn degraded_response_schedules_a_refresh_and_retry_converges() {
        // request_refresh() wiring proof END-TO-END (sessions-router.ts:293-305
        // parity): a degraded response fire-and-forgets a refresh, so once the
        // provider recovers, a client Retry converges back to ready. Assert
        // convergence by POLLING re-posts (each degraded response re-schedules
        // a refresh) rather than sleeping once.
        let dir = temp_dir("refresh");
        let broken = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let index = fixture_index_with_sources(vec![
            Arc::new(FixtureSource(vec![claude_fixture()])) as Arc<dyn SessionSource>,
            Arc::new(FailingDirectSource::new(Arc::clone(&broken))) as Arc<dyn SessionSource>,
        ])
        .await;
        let st = state(&dir, Some(index));
        let (_, body) = post(st.clone(), serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(body["status"], "degraded", "first response: {body}");
        broken.store(false, std::sync::atomic::Ordering::SeqCst);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let (_, body) = post(st.clone(), serde_json::json!({ "input": CLAUDE_ID }), true).await;
            if body["status"] == "ready" && body["providerErrors"] == serde_json::json!([]) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "must converge to ready within 2s; last body: {body}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn a_panicked_resolver_answers_500_never_a_fabricated_ready_empty() {
        // RECORDED DEVIATION (module doc): Node has no defined behavior for a
        // top-level resolver throw (unhandled rejection in the async Express 4
        // handler — no response at all); the explicit 500 is the honest port.
        // The hardened contract forbids presenting an unsearchable state as a
        // healthy "not found", so a JoinError must NEVER fabricate ready-empty.
        let dir = temp_dir("panic");
        let index = fixture_index(vec![claude_fixture()]).await;
        let mut st = state(&dir, Some(index));
        st.opencode_session_by_id = Some(Arc::new(|_id: &str| panic!("resolver crashed")));
        let (status, body) = post(
            st,
            serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, serde_json::json!({ "error": "Resolve failed" }));
    }

    #[tokio::test]
    async fn a_stalled_fallback_answers_degraded_at_the_fallback_deadline_never_hangs() {
        // Node bounds every by-id worker with a hard 15 s timeout
        // (`opencode-by-id-runner.ts` DEFAULT_TIMEOUT_MS); the rejection is
        // caught per-fallback and surfaces as a providerError on a degraded
        // 200. The Rust deadline is scoped the SAME way: it bounds the
        // individual blocking fallback dispatch, never the in-memory
        // resolver around it. The deadline is injected small so the test
        // never waits 15 s; the stalled closure keeps sleeping well past
        // it. Timeliness proof: without the deadline the sleeping closure
        // returns Ok(None) (a clean miss) and the response would be `ready`
        // — asserting `degraded` + the timeout providerError proves the
        // deadline path answered, not the stalled fallback.
        let dir = temp_dir("stall");
        let index = fixture_index(vec![claude_fixture()]).await;
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(50);
        st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
            std::thread::sleep(std::time::Duration::from_millis(400));
            Ok(None)
        }));
        let (status, body) = post(
            st,
            serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "degraded",
                "matches": [],
                // The hint still rides along (Node's timed-out fallback path
                // carries it too — resolution there finishes via `finish()`).
                "hint": { "provider": "opencode", "source": "id-shape" },
                // Node's timeout wraps ONE provider's worker; its rejection
                // blames THAT provider alone. Only the opencode fallback was
                // dispatched here — claude/codex/amplifier finished their
                // (index-only) search normally and must NOT be blamed.
                "providerErrors": [
                    { "provider": "opencode", "message": "resolve timed out after 50ms" }
                ],
                "unsearchedProviders": [],
                "homeDir": "/home/tester"
            })
        );
    }

    #[tokio::test]
    async fn a_fallback_timeout_blames_only_the_attempted_provider() {
        // Blame-attribution pin (Node parity): a stalled opencode by-id
        // dispatch must blame opencode ALONE — not claude (wired, but
        // shape-gated out of a `ses_` token so never consulted) and not
        // codex/amplifier (enabled, but they have no exact-id fallback and
        // their index search completed normally).
        let dir = temp_dir("blame");
        let index = fixture_index(vec![claude_fixture()]).await;
        let claude_invoked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(50);
        st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
            std::thread::sleep(std::time::Duration::from_millis(400));
            Ok(None)
        }));
        st.locate_claude_transcript = Some({
            let claude_invoked = Arc::clone(&claude_invoked);
            Arc::new(move |_id: &str| {
                claude_invoked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            })
        });
        let (status, body) = post(
            st,
            serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "degraded", "response: {body}");
        assert_eq!(
            body["providerErrors"],
            serde_json::json!([
                { "provider": "opencode", "message": "resolve timed out after 50ms" }
            ]),
            "only the attempted provider may be blamed: {body}"
        );
        assert_eq!(
            claude_invoked.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the claude fallback is shape-gated out of a ses_ token"
        );
    }

    #[tokio::test]
    async fn an_opencode_timeout_never_skips_or_blames_a_healthy_claude_fallback() {
        // Cross-provider containment (Node parity): Node bounds each by-id
        // worker INDIVIDUALLY (`opencode-by-id-runner.ts` DEFAULT_TIMEOUT_MS),
        // records the rejection for THAT provider, and CONTINUES through
        // later candidates/providers (`resolve-session.ts:133-156` — the
        // catch records per-provider and the entry loop keeps going). Input
        // = an opencode `ses_` id followed by a claude UUID: the opencode
        // dispatch stalls past its own deadline, but the claude lookup is
        // healthy and MUST still run — returning its match — while ONLY
        // opencode is blamed for the timeout.
        let dir = temp_dir("cross-provider");
        let index = fixture_index(Vec::new()).await;
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(50);
        st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            Ok(None)
        }));
        st.locate_claude_transcript = Some(Arc::new(|id: &str| {
            Ok(Some(
                freshell_sessions::resume_resolve::ClaudeTranscriptHit {
                    session_id: id.to_ascii_lowercase(),
                    cwd: Some("/home/tester/project".to_string()),
                },
            ))
        }));
        let (status, body) = post(
            st,
            serde_json::json!({
                "input": format!("ses_aaaaaaaaaaaaaaaaaaaaaaaaaa {CLAUDE_ID}")
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "degraded", "response: {body}");
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": CLAUDE_ID,
                "cwd": "/home/tester/project",
                "sessionType": "claude",
                "matchKind": "exact"
            }]),
            "the healthy claude fallback match must be returned: {body}"
        );
        assert_eq!(
            body["providerErrors"],
            serde_json::json!([
                { "provider": "opencode", "message": "resolve timed out after 50ms" }
            ]),
            "only the provider whose dispatch timed out may be blamed: {body}"
        );
    }

    #[tokio::test]
    async fn an_exact_index_hit_succeeds_while_the_permit_pool_is_saturated() {
        // CORRECTED SCOPING (Node parity): admission + deadline bound ONLY
        // the blocking provider-fallback dispatch. Node's cheap paths —
        // input parsing, in-memory index matching — never wait on
        // fallback-worker availability, so an exact index hit must answer
        // `ready` immediately even when every permit is held by stalled
        // fallbacks (simulated with a zero-permit semaphore). Fallback
        // closures are wired with a counter to prove no dispatch was even
        // attempted.
        let dir = temp_dir("sat-exact");
        let index = fixture_index(vec![claude_fixture()]).await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(150);
        st.resolve_permits = Arc::new(tokio::sync::Semaphore::new(0));
        st.opencode_session_by_id = Some({
            let counter = Arc::clone(&counter);
            Arc::new(move |_id: &str| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            })
        });
        st.locate_claude_transcript = Some({
            let counter = Arc::clone(&counter);
            Arc::new(move |_id: &str| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            })
        });
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["status"], "ready",
            "an exact index hit must bypass fallback admission: {body}"
        );
        assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
        assert_eq!(body["providerErrors"], serde_json::json!([]));
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no fallback dispatch may run for an exact index hit"
        );
    }

    #[tokio::test]
    async fn garbage_input_with_no_candidates_answers_ready_empty_under_full_saturation() {
        // Garbage input yields no candidate tokens: Node answers ready-empty
        // from pure parsing without ever touching a fallback worker. The
        // same request must not queue for (or degrade on) fallback admission.
        let dir = temp_dir("sat-garbage");
        let index = fixture_index(vec![claude_fixture()]).await;
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(150);
        st.resolve_permits = Arc::new(tokio::sync::Semaphore::new(0));
        let (status, body) = post(
            st,
            serde_json::json!({ "input": "??? total garbage input ???" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "ready",
                "matches": [],
                "hint": null,
                "providerErrors": [],
                "unsearchedProviders": [],
                "homeDir": "/home/tester"
            })
        );
    }

    #[tokio::test]
    async fn a_warming_response_is_unaffected_by_permit_saturation() {
        // A never-published index answers `warming` from a pure readiness
        // check (Node's `isIndexReady()`); no fallback is consulted, so a
        // saturated permit pool must not turn warming into a fabricated
        // degraded timeout.
        let dir = temp_dir("sat-warming");
        let mut st = state(&dir, None);
        st.resolve_deadline = std::time::Duration::from_millis(150);
        st.resolve_permits = Arc::new(tokio::sync::Semaphore::new(0));
        let (status, body) = post(
            st,
            serde_json::json!({ "input": format!("claude --resume {CLAUDE_ID}") }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "warming",
                "matches": [],
                "hint": { "provider": "claude", "source": "command" },
                "providerErrors": [],
                "unsearchedProviders": [],
                "homeDir": "/home/tester"
            })
        );
    }

    /// Blocks until `release` flips true (or a 5 s safety valve elapses so a
    /// broken test can never hang the suite), then answers a clean miss.
    fn stalled_until(
        release: &std::sync::atomic::AtomicBool,
    ) -> Result<
        Option<freshell_sessions::resume_resolve::OpencodeByIdHit>,
        freshell_sessions::resume_resolve::ProviderFailure,
    > {
        let start = std::time::Instant::now();
        while !release.load(std::sync::atomic::Ordering::SeqCst)
            && start.elapsed() < std::time::Duration::from_secs(5)
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Ok(None)
    }

    #[tokio::test]
    async fn saturated_permits_degrade_the_next_request_without_spawning_another_resolver() {
        // Admission-control proof, scoped to the FALLBACK phase: an
        // ABANDONED fallback task keeps its permit until its underlying op
        // returns, and a fallback dispatch that cannot get a permit FAILS
        // FAST — synchronously, WITHOUT spawning an (N+1)th blocking
        // fallback task and WITHOUT queueing toward its deadline. With
        // permits = 1: request A's fallback stalls (holding the permit
        // past its own deadline), request B — another FALLBACK-REQUIRING
        // request — must answer the degraded concurrency-limit shape
        // promptly while the injected fallback body was invoked exactly
        // ONCE — the invocation count staying at 1 IS the proof that no
        // second blocking fallback ran. Request C — an exact in-memory
        // index hit — must answer `ready` while the permit is STILL held:
        // only fallback-requiring requests degrade under saturation
        // (Node's cheap paths never queue behind a worker).
        let dir = temp_dir("permits");
        let index = fixture_index(vec![claude_fixture()]).await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let permits = Arc::new(tokio::sync::Semaphore::new(1));
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(100);
        st.resolve_permits = Arc::clone(&permits);
        st.opencode_session_by_id = Some({
            let counter = Arc::clone(&counter);
            let release = Arc::clone(&release);
            Arc::new(move |_id: &str| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                stalled_until(&release)
            })
        });

        let body = serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
        let (status_a, body_a) = post(st.clone(), body.clone(), true).await;
        assert_eq!(status_a, StatusCode::OK);
        assert_eq!(body_a["status"], "degraded", "request A: {body_a}");
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "request A's fallback must have been invoked once"
        );

        // The abandoned task still holds the ONLY permit. Request B must
        // fail admission FAST — synchronously, before any fallback task
        // exists — never queue toward its deadline. Its deadline is set
        // GENEROUS (10 s) precisely so the strict elapsed bound below
        // FAILS an implementation that queues for the deadline (reviewer
        // finding, iteration 5: the previous 5 s allowance against a
        // 100 ms deadline let a full-deadline queuer pass).
        let mut st_b = st.clone();
        st_b.resolve_deadline = std::time::Duration::from_secs(10);
        let started = std::time::Instant::now();
        let (status_b, body_b) = post(st_b, body, true).await;
        let waited = started.elapsed();
        assert_eq!(status_b, StatusCode::OK);
        assert_eq!(body_b["status"], "degraded", "request B: {body_b}");
        assert_eq!(
            body_b["providerErrors"],
            serde_json::json!([
                { "provider": "opencode", "message": "resolve concurrency limit reached" }
            ]),
            "permit starvation must answer the degraded provider-error shape, \
             blaming ONLY the provider whose fallback was attempted: {body_b}"
        );
        assert!(
            waited < std::time::Duration::from_secs(2),
            "request B must fail admission fast, never queue toward its \
             10 s deadline behind the stalled permit (took {waited:?})"
        );
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "request B must NOT have spawned an (N+1)th blocking fallback"
        );

        // Request C — an exact in-memory index hit — must succeed NORMALLY
        // while the stalled fallback still holds the only permit: cheap
        // index-only resolution never queues for fallback admission.
        let (status_c, body_c) =
            post(st.clone(), serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status_c, StatusCode::OK);
        assert_eq!(body_c["status"], "ready", "request C: {body_c}");
        assert_eq!(body_c["matches"][0]["sessionId"], CLAUDE_ID);
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "request C must not have dispatched any fallback"
        );

        // Cleanup: release the stalled op; the abandoned task finishes and
        // returns its permit — proving the permit's lifetime tracked the
        // UNDERLYING op, not the abandoned request.
        release.store(true, std::sync::atomic::Ordering::SeqCst);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while permits.available_permits() == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "the abandoned resolver must return its permit once its op completes"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn permit_starvation_fails_fast_without_pinning_an_outer_worker_for_the_deadline() {
        // Reviewer finding (iteration 5): admission used to run INSIDE the
        // outer resolver `spawn_blocking` via `block_on(acquire_owned())`,
        // so under full permit saturation each fallback dispatch pinned
        // that unbounded outer blocking worker for its ENTIRE deadline —
        // enough crafted requests could exhaust Tokio's blocking pool, the
        // exact failure the semaphore exists to prevent. Corrected:
        // admission is a synchronous `try_acquire_owned()` BEFORE any
        // fallback task exists, so a starved dispatch degrades
        // immediately. The deadline here is GENEROUS (5 s) precisely so an
        // implementation that queues for the deadline visibly FAILS the
        // strict elapsed bound below.
        let dir = temp_dir("starve-fast");
        let index = fixture_index(Vec::new()).await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_secs(5);
        st.resolve_permits = Arc::new(tokio::sync::Semaphore::new(0));
        st.opencode_session_by_id = Some({
            let counter = Arc::clone(&counter);
            Arc::new(move |_id: &str| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            })
        });
        let started = std::time::Instant::now();
        let (status, body) = post(
            st,
            serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            true,
        )
        .await;
        let waited = started.elapsed();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "degraded", "response: {body}");
        assert_eq!(
            body["providerErrors"],
            serde_json::json!([
                { "provider": "opencode", "message": "resolve concurrency limit reached" }
            ]),
            "a starved dispatch blames ONLY the provider it would have run: {body}"
        );
        assert!(
            waited < std::time::Duration::from_secs(2),
            "a permit-starved fallback dispatch must fail fast, never occupy \
             an outer blocking worker while queueing toward its 5 s deadline \
             (took {waited:?})"
        );
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the fallback body must never run without a permit"
        );
    }

    #[tokio::test]
    async fn two_exact_ses_tokens_invoke_the_opencode_fallback_twice_when_not_abandoned() {
        // CONTROL for the per-dispatch containment test below: this
        // two-token input drives TWO opencode fallback invocations (budget
        // is 2 per provider) when nothing stalls — so the stalled variant's
        // count of TWO proves the budget/input shape allows both calls and
        // continuation after a timeout is real, not an artifact.
        let dir = temp_dir("cancel-control");
        let index = fixture_index(Vec::new()).await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut st = state(&dir, Some(index));
        st.opencode_session_by_id = Some({
            let counter = Arc::clone(&counter);
            Arc::new(move |_id: &str| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            })
        });
        let (status, body) = post(
            st,
            serde_json::json!({
                "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa ses_bbbbbbbbbbbbbbbbbbbbbbbbbb"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready", "control response: {body}");
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the two-token input must consume both opencode fallback calls"
        );
    }

    #[tokio::test]
    async fn a_timed_out_fallback_never_skips_the_next_candidates_dispatch() {
        // Per-dispatch containment (Node parity): after the first
        // candidate's dispatch times out (its blocking task abandoned,
        // holding a permit), the SECOND candidate's fallback must still be
        // dispatched with its OWN deadline — Node records the rejection for
        // that provider and continues through later candidates/providers
        // (`resolve-session.ts:133-156`). ERRATA: ffa4aac1a's shared cancel
        // flag skipped it (and fabricated timeouts for providers never
        // dispatched). Abandonment stays bounded WITHOUT the flag: the
        // per-provider budget (2) caps the dispatches one request can
        // produce. Same two-token input as the control above (which proves
        // exactly TWO invocations happen when nothing stalls), so a count
        // of 2 here proves continuation — while first-error-wins dedupe
        // keeps ONE opencode error on the wire.
        let dir = temp_dir("per-dispatch");
        let index = fixture_index(Vec::new()).await;
        let invoked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut st = state(&dir, Some(index));
        st.resolve_deadline = std::time::Duration::from_millis(50);
        st.opencode_session_by_id = Some({
            let invoked = Arc::clone(&invoked);
            Arc::new(move |_id: &str| {
                invoked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Stall well past the 50 ms deadline, then answer a miss.
                std::thread::sleep(std::time::Duration::from_millis(250));
                Ok(None)
            })
        });
        let (status, body) = post(
            st,
            serde_json::json!({
                "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa ses_bbbbbbbbbbbbbbbbbbbbbbbbbb"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "degraded", "response: {body}");
        assert_eq!(
            body["providerErrors"],
            serde_json::json!([
                { "provider": "opencode", "message": "resolve timed out after 50ms" }
            ]),
            "first error per provider wins — two timeouts, ONE entry: {body}"
        );
        assert_eq!(
            invoked.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the second candidate's dispatch must still run with its own deadline"
        );
    }
}

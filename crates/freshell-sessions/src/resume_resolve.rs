//! Rust port of the HARDENED (#586) `server/coding-cli/resolve-session.ts` +
//! the shape-gate/budget logic of `resolve-fallbacks.ts` — the resume-by-id
//! resolve core. Pure and synchronous: the HTTP layer
//! (`crates/freshell-server/src/resolve.rs`) supplies the index snapshot, the
//! sessionType overlay map, and the two exact-id fallback closures, then
//! merges router-level fields (scan failures, unsearchedProviders, homeDir)
//! and serializes.
//!
//! DIVERGENCE LEDGER — this is the in-code record a follow-up implementer
//! relies on (history in
//! `docs/plans/2026-07-30-rust-resolve-parity-hardened.md`). The
//! `sessionResolve` capability flag is declared `true`
//! (`crates/freshell-server/src/main.rs`, `build_platform_payload`). The
//! CORE below is at parity with the hardened Node core (matching order, case
//! rules, subagent gating, sessionType overlay+default, provider-error
//! channel, shape gates, budgets). The wire surface
//! (`providerErrors`/`unsearchedProviders`/`homeDir`, scan-failure merge,
//! degraded fire-and-forget refresh) and the failure-REPORTING production
//! fallbacks (checked claude locator `locate_transcript_checked`,
//! error-propagating opencode by-id query) landed in plan Task 6
//! (`resolve.rs` + `main.rs`), and the resume-button e2e matrix ran green
//! against the route (plan Task 7). No known unported divergences remain
//! beyond the RECORDED DEVIATIONS documented in the HTTP layer's module doc
//! (`resolve.rs`): an explicit 500 on a resolver panic (Node has no defined
//! behavior there), and `homeDir` omitted when the server has no resolvable
//! home (Node `os.homedir()` platform semantics: USERPROFILE on Windows;
//! HOME else the passwd-entry home on POSIX).
//!
//! Wire parity notes:
//! - Field ORDER in `ResumeResolveMatch` matches the Node object literals —
//!   `serde_json` `preserve_order` + struct field order drive output order.
//! - Optional match fields are OMITTED when `None` (Node drops `undefined`);
//!   `hint` is `null` when absent (zod `.nullable()`), so NOT skip-serialized
//!   by the HTTP layer.
//! - Per-token resolution order (resolve-session.ts:56-70): exact index hits
//!   (ALL sessions, subagents included) → exact-id fallbacks → prefix
//!   discovery (top-level only). A prefix match must NEVER outrank any exact
//!   resolution of the same or a higher-priority token.
//! - UUID/hex-family tokens (hex digits + dashes only) match
//!   case-INSENSITIVELY; everything else — notably ses_ base62 ids — matches
//!   case-SENSITIVELY (base62 case-folding could resolve the WRONG session).
//! - Provider failure ≠ not found: a failing fallback records a per-provider
//!   error and the result becomes `degraded` — never a silent empty miss.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::directory_index::IndexedSession;
use crate::resume_input::{parse_resume_input, ResumeHint};

/// `RESOLVE_MATCH_CAP` (`resolve-session.ts:12`).
pub const RESOLVE_MATCH_CAP: usize = 20;

/// `FALLBACK_BUDGET_PER_REQUEST` (`resolve-fallbacks.ts:34`): each fallback
/// may do REAL work at most this many times per request; beyond that it
/// reports a miss without doing work. Shape gates run FIRST and consume no
/// budget (`resolve-fallbacks.ts:46-48` — order is load-bearing).
pub const FALLBACK_BUDGET_PER_REQUEST: usize = 2;

/// `FALLBACK_ID_SHAPES` (`resolve-fallbacks.ts:22-25`): FULL-id gates. A
/// wrong-shape token is a free no-op miss that must neither do work nor
/// consume budget (otherwise earlier `ses_` tokens could exhaust the claude
/// budget before a valid later claude UUID — false negative). The opencode
/// gate is load-bearing on legacy-schema DBs, where the by-id lookup answers
/// a universal HIT for any id it is actually asked about.
static CLAUDE_FALLBACK_ID_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        .expect("static regex")
});
static OPENCODE_FALLBACK_ID_SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ses_[0-9a-zA-Z]{26}$").expect("static regex"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeResolveStatus {
    Ready,
    Warming,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeMatchKind {
    Exact,
    Prefix,
}

/// One resolve match (`ResumeResolveMatchSchema`). Field order = Node's
/// `toMatch` / fallback literals.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResolveMatch {
    pub provider: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
    pub match_kind: ResumeMatchKind,
}

/// `ResumeResolveProviderErrorSchema`: a provider that could not be searched
/// is 'degraded' — NEVER "not found". Node builds `{provider, ...code, message}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResolveProviderError {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A fallback failure as reported by the closure (the Rust analog of a Node
/// fallback rejection; typed locator errors carry an errno-ish `code`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailure {
    pub code: Option<String>,
    pub message: String,
}

/// The claude transcript fallback's answer. `session_id` is the LOWERCASED
/// id (the locator lowercases before scanning, Node parity).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeTranscriptHit {
    pub session_id: String,
    pub cwd: Option<String>,
}

/// The opencode by-id fallback's answer (hardened Node: the full sqlite row
/// from `opencode-by-id-query.ts`, archived + child sessions included).
/// `last_activity_at` is already floored to integer ms by the producer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeByIdHit {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub last_activity_at: Option<i64>,
}

/// Dependencies for one resolve call (`ResolveResumeDeps`). Fallbacks return
/// `Err(ProviderFailure)` when the provider store could not be searched —
/// the core records it and continues (provider unavailable ≠ not found).
pub struct ResolveDeps<'a> {
    /// Deleted-filtered index snapshot (Node reads the post-filter project
    /// groups, `session-indexer.ts:209,1155-1156`; the Rust HTTP layer drops
    /// `deleted: true` overrides before calling in — see `resolve.rs`).
    /// `None` = never published ⇒ warming.
    pub sessions: Option<&'a [IndexedSession]>,
    /// sessionType overlay keyed `"{provider}:{session_id}"` (Node:
    /// `session-indexer.ts:1159-1161` overlays the SessionMetadataStore).
    pub session_types: &'a HashMap<String, String>,
    /// claude transcript exact-id fallback (`locateClaudeTranscript`).
    #[allow(clippy::type_complexity)]
    pub locate_claude_transcript: Option<
        &'a (dyn Fn(&str) -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> + Send + Sync),
    >,
    /// opencode `ses_*` exact-id fallback (hardened by-id row query).
    #[allow(clippy::type_complexity)]
    pub opencode_session_by_id: Option<
        &'a (dyn Fn(&str) -> Result<Option<OpencodeByIdHit>, ProviderFailure> + Send + Sync),
    >,
}

/// Core result (`ResolveResumeResult` in `resolve-session.ts:31-36`).
/// `provider_errors` carries FALLBACK failures only; the HTTP layer
/// (`crates/freshell-server/src/resolve.rs`) merges in index scan failures
/// and adds `unsearchedProviders`/`homeDir`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResumeResolveOutcome {
    pub status: ResumeResolveStatus,
    pub matches: Vec<ResumeResolveMatch>,
    pub hint: Option<ResumeHint>,
    pub provider_errors: Vec<ResumeResolveProviderError>,
}

/// `isCaseInsensitiveToken` (`resolve-session.ts:51-53`): UUID/hex-family
/// tokens (hex digits + dashes only) match case-insensitively. Everything
/// else — notably `ses_` + base62 ids — matches case-SENSITIVELY: base62
/// upper/lower case are distinct values, so case-folding could resolve the
/// WRONG session.
fn is_case_insensitive_token(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// `resolveResumeInput` (`resolve-session.ts:72-170`), step for step.
/// Candidate tokens are tried in priority order; PER TOKEN the resolution
/// order is:
///
///   1. exact index hits (ALL sessions, including subagent children — an
///      exact pasted id must resolve even for hidden child sessions),
///   2. exact-id fallbacks for sessions the index cannot see (opencode child
///      sessions; cwd-less claude transcripts skipped on cold start),
///   3. and only then prefix matches (top-level sessions only — surfacing
///      hidden subagent children for partial ids would flood disambiguation
///      with noise).
///
/// A prefix match must NEVER outrank any exact resolution of the same or a
/// higher-priority token: an unindexed session whose id EQUALS the token
/// beats any indexed session whose id merely begins with it, or the wrong
/// session gets resumed.
pub fn resolve_resume_input(input: &str, deps: &ResolveDeps<'_>) -> ResumeResolveOutcome {
    // Parse BEFORE the warming gate: the warming response still carries the hint.
    let parsed = parse_resume_input(input);
    let hint = parsed.hint;

    let Some(sessions) = deps.sessions else {
        return ResumeResolveOutcome {
            status: ResumeResolveStatus::Warming,
            matches: Vec::new(),
            hint,
            provider_errors: Vec::new(),
        };
    };
    if parsed.candidates.is_empty() {
        return ResumeResolveOutcome {
            status: ResumeResolveStatus::Ready,
            matches: Vec::new(),
            hint,
            provider_errors: Vec::new(),
        };
    }

    // First-error-per-provider, insertion order (Node's Map semantics).
    // Provider failure ≠ not found: a failing fallback records a per-provider
    // error summary while resolution CONTINUES (prefix/later tokens). Any
    // entry here makes the result 'degraded' — even with matches.
    let mut errors: Vec<ResumeResolveProviderError> = Vec::new();
    // Per-REQUEST budgets (`withRequestBudget` wraps once, before the loop):
    // ONE counter PER FALLBACK — two opencode lookups must never exhaust the
    // claude budget, or vice versa.
    let mut claude_used = 0usize;
    let mut opencode_used = 0usize;

    for candidate in &parsed.candidates {
        let ci = is_case_insensitive_token(&candidate.token);
        let norm = |value: &str| {
            if ci {
                value.to_ascii_lowercase()
            } else {
                value.to_string()
            }
        };
        let target = norm(&candidate.token);

        // 1. Exact index hits — scan ALL sessions, subagent children included.
        let exact: Vec<ResumeResolveMatch> = sessions
            .iter()
            .filter(|session| norm(&session.session_id) == target)
            .map(|session| to_match(session, ResumeMatchKind::Exact, deps.session_types))
            .collect();
        if !exact.is_empty() {
            return finish(exact, hint, errors);
        }

        // 2. Exact-id fallbacks BEFORE prefix matching. Shape FIRST, budget
        // SECOND (wrong-shape tokens are free no-ops); iterated claude-then-
        // opencode (Node's entry order) so a failure is attributed to the
        // RIGHT provider — identity travels with the entry, never its
        // position. The budget is consumed by the real invocation itself,
        // hit or miss.
        let mut hits: Vec<ResumeResolveMatch> = Vec::new();
        if let Some(locate) = deps.locate_claude_transcript {
            if CLAUDE_FALLBACK_ID_SHAPE.is_match(&candidate.token)
                && claude_used < FALLBACK_BUDGET_PER_REQUEST
            {
                claude_used += 1;
                match locate(&candidate.token) {
                    Ok(Some(hit)) => hits.push(ResumeResolveMatch {
                        provider: "claude".to_string(),
                        session_id: hit.session_id.clone(),
                        // cwd may legitimately be missing — the CLIENT then
                        // asks for a working directory instead of auto-opening.
                        cwd: hit.cwd,
                        session_type: Some(overlay_or(
                            deps.session_types,
                            "claude",
                            &hit.session_id,
                        )),
                        title: None,
                        first_user_message: None,
                        last_activity_at: None,
                        match_kind: ResumeMatchKind::Exact,
                    }),
                    Ok(None) => {}
                    Err(failure) => record_error("claude", failure, &mut errors),
                }
            }
        }
        if let Some(lookup) = deps.opencode_session_by_id {
            if OPENCODE_FALLBACK_ID_SHAPE.is_match(&candidate.token)
                && opencode_used < FALLBACK_BUDGET_PER_REQUEST
            {
                opencode_used += 1;
                match lookup(&candidate.token) {
                    Ok(Some(hit)) => hits.push(ResumeResolveMatch {
                        provider: "opencode".to_string(),
                        session_id: hit.session_id.clone(),
                        // opencode resumes in the SPAWN cwd (the row's own
                        // `directory`); empty ⇒ omitted (Node `row.cwd || undefined`).
                        cwd: hit.cwd.filter(|c| !c.is_empty()),
                        session_type: Some(overlay_or(
                            deps.session_types,
                            "opencode",
                            &hit.session_id,
                        )),
                        title: hit.title.filter(|t| !t.is_empty()),
                        first_user_message: None,
                        last_activity_at: hit.last_activity_at,
                        match_kind: ResumeMatchKind::Exact,
                    }),
                    Ok(None) => {}
                    Err(failure) => record_error("opencode", failure, &mut errors),
                }
            }
        }
        if !hits.is_empty() {
            return finish(hits, hint, errors);
        }

        // 3. Prefix DISCOVERY — top-level sessions only; exact ids above
        // still reach subagent children.
        let prefix: Vec<ResumeResolveMatch> = sessions
            .iter()
            .filter(|session| {
                !session.is_subagent && norm(&session.session_id).starts_with(&target)
            })
            .map(|session| to_match(session, ResumeMatchKind::Prefix, deps.session_types))
            .collect();
        if !prefix.is_empty() {
            return finish(prefix, hint, errors);
        }
    }

    finish(Vec::new(), hint, errors)
}

/// Node's `finish` closure (`resolve-session.ts:100-109`): sort most-recent
/// first (stable, like JS; missing lastActivityAt sorts as 0), dedupe keeping
/// the survivor with the most recent activity, cap, and derive degraded-ness
/// from recorded errors.
fn finish(
    mut matches: Vec<ResumeResolveMatch>,
    hint: Option<ResumeHint>,
    errors: Vec<ResumeResolveProviderError>,
) -> ResumeResolveOutcome {
    matches.sort_by(|a, b| {
        b.last_activity_at
            .unwrap_or(0)
            .cmp(&a.last_activity_at.unwrap_or(0))
    });
    let matches: Vec<ResumeResolveMatch> = dedupe(matches)
        .into_iter()
        .take(RESOLVE_MATCH_CAP)
        .collect();
    ResumeResolveOutcome {
        status: if errors.is_empty() {
            ResumeResolveStatus::Ready
        } else {
            // Even with matches: a failed HIGHER-priority exact search may
            // have hidden the right session — the client must not auto-resume.
            ResumeResolveStatus::Degraded
        },
        matches,
        hint,
        provider_errors: errors,
    }
}

/// First error per provider wins (Node: `if (!errorsByProvider.has(provider))`).
fn record_error(
    provider: &str,
    failure: ProviderFailure,
    errors: &mut Vec<ResumeResolveProviderError>,
) {
    if errors.iter().any(|e| e.provider == provider) {
        return;
    }
    errors.push(ResumeResolveProviderError {
        provider: provider.to_string(),
        code: failure.code,
        message: Some(failure.message),
    });
}

/// sessionType resolution shared by index and fallback matches: overlay map
/// (keyed `"{provider}:{id}"`, `IndexedSession::key()`'s format) →
/// provider-name default (`toMatch`'s `session.sessionType ?? session.provider`
/// and `resolve-fallbacks.ts`'s `sessionTypeFor`).
fn overlay_or(session_types: &HashMap<String, String>, provider: &str, id: &str) -> String {
    session_types
        .get(&format!("{provider}:{id}"))
        .cloned()
        .unwrap_or_else(|| provider.to_string())
}

/// `toMatch` (`resolve-session.ts:172-183`): `cwd: session.cwd ?? projectPath`;
/// `sessionType` is the metadata-map overlay when present, defaulting to the
/// provider — the hardened Node `toMatch` emits `sessionType ?? provider`,
/// never absent.
fn to_match(
    session: &IndexedSession,
    match_kind: ResumeMatchKind,
    session_types: &HashMap<String, String>,
) -> ResumeResolveMatch {
    ResumeResolveMatch {
        provider: session.provider.clone(),
        session_id: session.session_id.clone(),
        cwd: Some(
            session
                .cwd
                .clone()
                .unwrap_or_else(|| session.project_path.clone()),
        ),
        session_type: Some(overlay_or(
            session_types,
            &session.provider,
            &session.session_id,
        )),
        title: session.title.clone(),
        first_user_message: session.first_user_message.clone(),
        last_activity_at: Some(session.last_activity_at),
        match_kind,
    }
}

/// `dedupe` (`resolve-session.ts:189-197`): first `provider:sessionId` wins —
/// which, post-sort, is the most recent entry.
fn dedupe(matches: Vec<ResumeResolveMatch>) -> Vec<ResumeResolveMatch> {
    let mut seen: HashSet<String> = HashSet::new();
    matches
        .into_iter()
        .filter(|m| seen.insert(format!("{}:{}", m.provider, m.session_id)))
        .collect()
}

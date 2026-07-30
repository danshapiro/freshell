//! Rust port of the resume-by-id resolve core. Ports the HARDENED matching
//! semantics of `server/coding-cli/resolve-session.ts` +
//! `resolve-fallbacks.ts`: per-token exact→fallback→prefix ordering,
//! case-sensitivity gating (uuid/hex tokens case-insensitive, `ses_` base62
//! case-SENSITIVE), subagent exclusion from prefix discovery, the
//! parser-side candidate work budget, and the fallback request budget
//! (FULL-id shape gates + [`FALLBACK_BUDGET_PER_REQUEST`] real invocations
//! per fallback per request). Pure and synchronous: the HTTP layer
//! (`crates/freshell-server/src/resolve.rs`) supplies the index snapshot,
//! the sessionType overlay map, and the two exact-id fallback closures, then
//! serializes the returned response verbatim.
//!
//! NOT YET PORTED (known divergence from the hardened Node response surface):
//! `degraded` status, `providerErrors`, `unsearchedProviders`, `homeDir`, and
//! the warming/ready readiness merge — tracked in
//! `docs/plans/2026-07-30-rust-resolve-parity-hardened.md` Tasks 3, 5, 6. The
//! `sessionResolve` capability flag is held `false` until that lands.
//!
//! Wire parity notes:
//! - Field ORDER in `ResumeResolveMatch` matches the Node object literals
//!   (`toMatch` / the fallback literals) — `serde_json` has `preserve_order`
//!   on workspace-wide and struct field order drives serde output order.
//! - Optional match fields are OMITTED when `None` (Node/JSON.stringify drop
//!   `undefined`); `hint` is `null` when absent (zod `.nullable()`), so it is
//!   deliberately NOT `skip_serializing_if`.

use std::collections::{HashMap, HashSet};

use crate::directory_index::IndexedSession;
use crate::parse::OpencodeSessionDirectory;
use crate::resume_input::{parse_resume_input, ResumeHint};

/// Node's `RESOLVE_MATCH_CAP` (`resolve-session.ts`).
pub const RESOLVE_MATCH_CAP: usize = 20;

/// Node's `FALLBACK_BUDGET_PER_REQUEST` (`resolve-fallbacks.ts`): each
/// exact-id fallback may do REAL work at most this many times per request;
/// beyond that it reports a miss without doing work. One counter PER
/// FALLBACK (Node's `withRequestBudget` builds a separate `used` counter per
/// key), fresh each request. Combined with the full-id shape gates below
/// this bounds the fallback work (FS scans, sqlite opens) one pasted blob
/// can trigger, no matter how many id-shaped tokens it contains.
pub const FALLBACK_BUDGET_PER_REQUEST: usize = 2;

/// Node's `FALLBACK_ID_SHAPES.claudeTranscriptById` (`resolve-fallbacks.ts`):
/// `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`
/// — a FULL uuid (any hex case), never a shorter or longer token.
fn is_claude_fallback_id(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Node's `FALLBACK_ID_SHAPES.opencodeSessionById` (`resolve-fallbacks.ts`):
/// `^ses_[0-9a-zA-Z]{26}$` — the FULL 26-char base62 opencode id, NOT the
/// parser's looser 8..=64 `xxx_` family shape. Load-bearing on legacy-schema
/// opencode DBs, where the by-id lookup answers a universal HIT for any id
/// it is actually asked about: a wrong-length `ses_*` token must be a free
/// no-op miss, exactly as on Node.
fn is_opencode_fallback_id(token: &str) -> bool {
    token.len() == 30
        && token.starts_with("ses_")
        && token.as_bytes()[4..].iter().all(u8::is_ascii_alphanumeric)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeResolveStatus {
    Ready,
    Warming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeMatchKind {
    Exact,
    Prefix,
}

/// One resolve match (`ResumeResolveMatchSchema`,
/// `shared/resume-resolve-contract.ts`). Field order = Node's `toMatch`.
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

/// `ResumeResolveResponseSchema`: `{ status, matches, hint }` — `hint` is
/// `null` (present) when absent.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ResumeResolveResponse {
    pub status: ResumeResolveStatus,
    pub matches: Vec<ResumeResolveMatch>,
    pub hint: Option<ResumeHint>,
}

/// The claude transcript fallback's answer (`ClaudeTranscriptHit` in
/// `claude-transcript-locator.ts`, minus `sourceFile` which the API never
/// surfaces). `session_id` is the LOWERCASED id (the Node locator lowercases).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeTranscriptHit {
    pub session_id: String,
    pub cwd: Option<String>,
}

/// Dependencies for one resolve call (`ResolveResumeDeps` in
/// `resolve-session.ts`).
pub struct ResolveDeps<'a> {
    /// The flattened session list (Node: `getProjects().flatMap(g => g.sessions)`,
    /// which is the POST-deleted-override-filter project groups,
    /// `session-indexer.ts:209,1155-1156`). The slice the Rust server passes is
    /// likewise the DELETED-FILTERED snapshot (the HTTP layer drops sessions
    /// whose `"{provider}:{session_id}"` override says `deleted: true` before
    /// calling in — see `resolve.rs`); this core stays filter-free on purpose.
    /// `None` = the index has never published a snapshot ⇒ `status: "warming"`
    /// (Node's `isIndexReady() === false`).
    pub sessions: Option<&'a [IndexedSession]>,
    /// sessionType overlay keyed `"{provider}:{session_id}"` (Node:
    /// `session-indexer.ts:1159-1161` overlays the SessionMetadataStore).
    pub session_types: &'a HashMap<String, String>,
    /// opencode `ses_*` exact-id fallback (`resolveOpencodeSessionIds` →
    /// Node's by-id parent-walk): `Some(hit)` = the walk resolved the id —
    /// `hit.directory` is the row's own TRUTHY `directory` (spawn cwd), and
    /// is `None` for empty/NULL directories and ALL legacy-schema hits (the
    /// wire match then omits `cwd`). `None` = miss (no row, orphaned chain,
    /// cycle). Read errors are mapped to `None` by the caller — never a 5xx.
    #[allow(clippy::type_complexity)]
    pub opencode_dir_by_id:
        Option<&'a (dyn Fn(&str) -> Option<OpencodeSessionDirectory> + Send + Sync)>,
    /// claude transcript exact-id fallback (`locateClaudeTranscript`).
    #[allow(clippy::type_complexity)]
    pub locate_claude_transcript:
        Option<&'a (dyn Fn(&str) -> Option<ClaudeTranscriptHit> + Send + Sync)>,
}

/// Node's `isCaseInsensitiveToken`: UUID/hex-family tokens (hex digits +
/// dashes only) match case-insensitively. Everything else — notably `ses_` +
/// base62 ids — matches case-SENSITIVELY: base62 upper/lower case are
/// distinct values, so case-folding could resolve the WRONG session.
fn is_case_insensitive_token(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Port of the hardened `resolveResumeInput` matching semantics. Candidate
/// tokens are tried in priority order; PER TOKEN the resolution order is:
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
///
/// The per-provider error channel (`providerErrors` / `degraded`) is NOT yet
/// ported — see the module doc.
pub fn resolve_resume_input(input: &str, deps: &ResolveDeps<'_>) -> ResumeResolveResponse {
    // Parse BEFORE the warming gate: the warming response still carries the hint.
    let parsed = parse_resume_input(input);
    let hint = parsed.hint;

    let Some(sessions) = deps.sessions else {
        return ResumeResolveResponse {
            status: ResumeResolveStatus::Warming,
            matches: Vec::new(),
            hint,
        };
    };
    if parsed.candidates.is_empty() {
        return ResumeResolveResponse {
            status: ResumeResolveStatus::Ready,
            matches: Vec::new(),
            hint,
        };
    }

    // Node's `withRequestBudget` (`resolve-fallbacks.ts`): ONE budget counter
    // PER FALLBACK, fresh per request — the Node wrapper is built once per
    // `resolveResumeInput` call, BEFORE the token loop, and each key gets its
    // own `used` counter (two opencode lookups must never exhaust the claude
    // budget, or vice versa).
    let mut claude_fallback_used = 0usize;
    let mut opencode_fallback_used = 0usize;

    // Evidence pass: one scan answers all providers at once. Candidates are
    // tried in priority order until one resolves; PER TOKEN the order is
    // exact → exact-id fallbacks → prefix (see the fn doc). The hint NEVER
    // filters.
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
            return finish(exact, hint.clone());
        }

        // 2. Exact-id fallbacks run BEFORE prefix matching (an unindexed
        // session whose id EQUALS the token must beat any indexed session
        // whose id merely begins with it), with Node's `withRequestBudget`
        // semantics (`resolve-fallbacks.ts`) mirrored exactly: the FULL-id
        // shape gate runs FIRST — a wrong-shape token is a free no-op miss
        // that neither does work nor consumes budget (otherwise earlier
        // `ses_` tokens could exhaust the claude budget before a valid later
        // claude UUID) — and the budget check runs SECOND, with the budget
        // consumed by the real invocation itself, hit or miss. The two
        // shapes are mutually exclusive, so at most one fallback runs per
        // token; both are tried in Node's entry order (claude, then
        // opencode).
        if is_claude_fallback_id(&candidate.token) {
            if let Some(locate) = deps.locate_claude_transcript {
                if claude_fallback_used < FALLBACK_BUDGET_PER_REQUEST {
                    claude_fallback_used += 1;
                    if let Some(hit) = locate(&candidate.token) {
                        return finish(
                            vec![ResumeResolveMatch {
                                provider: "claude".to_string(),
                                session_id: hit.session_id,
                                cwd: hit.cwd,
                                session_type: Some("claude".to_string()),
                                title: None,
                                first_user_message: None,
                                last_activity_at: None,
                                match_kind: ResumeMatchKind::Exact,
                            }],
                            hint.clone(),
                        );
                    }
                }
            }
        }
        if is_opencode_fallback_id(&candidate.token) {
            if let Some(lookup) = deps.opencode_dir_by_id {
                if opencode_fallback_used < FALLBACK_BUDGET_PER_REQUEST {
                    opencode_fallback_used += 1;
                    if let Some(hit) = lookup(&candidate.token) {
                        return finish(
                            vec![ResumeResolveMatch {
                                provider: "opencode".to_string(),
                                session_id: candidate.token.clone(),
                                // opencode resumes in the SPAWN cwd (the
                                // sqlite row's own `directory` column), not
                                // the project root. `None` (empty-string
                                // directory, or any legacy-schema hit)
                                // serializes with `cwd` OMITTED — matching
                                // Node, whose `cwd: undefined` is dropped by
                                // `res.json`.
                                cwd: hit.directory,
                                session_type: Some("opencode".to_string()),
                                title: None,
                                first_user_message: None,
                                last_activity_at: None,
                                match_kind: ResumeMatchKind::Exact,
                            }],
                            hint.clone(),
                        );
                    }
                }
            }
        }

        // 3. Prefix DISCOVERY — top-level sessions only (`!is_subagent`);
        // exact ids above still reach subagent children.
        let prefix: Vec<ResumeResolveMatch> = sessions
            .iter()
            .filter(|session| {
                !session.is_subagent && norm(&session.session_id).starts_with(&target)
            })
            .map(|session| to_match(session, ResumeMatchKind::Prefix, deps.session_types))
            .collect();
        if !prefix.is_empty() {
            return finish(prefix, hint.clone());
        }
    }

    ResumeResolveResponse {
        status: ResumeResolveStatus::Ready,
        matches: Vec::new(),
        hint,
    }
}

/// Node's `finish` (minus the provider-error channel — see the module doc):
/// sort most-recent-first BEFORE dedupe (stable, so the dedupe survivor is
/// the most-recent entry; missing lastActivityAt sorts as 0), then cap.
fn finish(mut matches: Vec<ResumeResolveMatch>, hint: Option<ResumeHint>) -> ResumeResolveResponse {
    matches.sort_by(|a, b| {
        b.last_activity_at
            .unwrap_or(0)
            .cmp(&a.last_activity_at.unwrap_or(0))
    });
    let matches: Vec<ResumeResolveMatch> = dedupe(matches)
        .into_iter()
        .take(RESOLVE_MATCH_CAP)
        .collect();
    ResumeResolveResponse {
        status: ResumeResolveStatus::Ready,
        matches,
        hint,
    }
}

/// Node's `toMatch`: `cwd: session.cwd ?? projectPath`; `sessionType` is the
/// metadata-map overlay when present, defaulting to the provider — the
/// hardened Node `toMatch` emits `sessionType ?? provider`, never absent.
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
        session_type: Some(
            session_types
                .get(&session.key())
                .cloned()
                .unwrap_or_else(|| session.provider.clone()),
        ),
        title: session.title.clone(),
        first_user_message: session.first_user_message.clone(),
        last_activity_at: Some(session.last_activity_at),
        match_kind,
    }
}

/// Node's `dedupe`: first `provider:sessionId` wins — which, post-sort, is
/// the most recent entry.
fn dedupe(matches: Vec<ResumeResolveMatch>) -> Vec<ResumeResolveMatch> {
    let mut seen: HashSet<String> = HashSet::new();
    matches
        .into_iter()
        .filter(|m| seen.insert(format!("{}:{}", m.provider, m.session_id)))
        .collect()
}

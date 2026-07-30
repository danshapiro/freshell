//! Rust port of `server/coding-cli/resolve-session.ts` — the resume-by-id
//! resolve core. Pure and synchronous: the HTTP layer
//! (`crates/freshell-server/src/resolve.rs`) supplies the index snapshot, the
//! sessionType overlay map, and the two exact-id fallback closures, then
//! serializes the returned response verbatim.
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
use crate::resume_input::{parse_resume_input, ResumeCandidateKind, ResumeHint};

/// `RESOLVE_MATCH_CAP` (`resolve-session.ts:9`).
pub const RESOLVE_MATCH_CAP: usize = 20;

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

/// `resolveResumeInput` (`resolve-session.ts:24-107`), step for step.
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

    // Evidence pass: one scan answers all providers at once. Candidates are
    // tried in priority order until one resolves. The hint NEVER filters.
    for candidate in &parsed.candidates {
        let needle = candidate.token.to_ascii_lowercase();
        let mut exact: Vec<ResumeResolveMatch> = Vec::new();
        let mut prefix: Vec<ResumeResolveMatch> = Vec::new();
        for session in sessions {
            let id = session.session_id.to_ascii_lowercase();
            if id == needle {
                exact.push(to_match(
                    session,
                    ResumeMatchKind::Exact,
                    deps.session_types,
                ));
            } else if id.starts_with(&needle) {
                prefix.push(to_match(
                    session,
                    ResumeMatchKind::Prefix,
                    deps.session_types,
                ));
            }
        }
        // Exact wins wholesale — exact and prefix are never mixed.
        let mut matches = if !exact.is_empty() { exact } else { prefix };
        if !matches.is_empty() {
            // Sort BEFORE dedupe (stable), so the dedupe survivor is the
            // most-recent entry. Missing lastActivityAt sorts as 0 in Node;
            // the Rust index always has a value.
            matches.sort_by(|a, b| {
                b.last_activity_at
                    .unwrap_or(0)
                    .cmp(&a.last_activity_at.unwrap_or(0))
            });
            let matches: Vec<ResumeResolveMatch> = dedupe(matches)
                .into_iter()
                .take(RESOLVE_MATCH_CAP)
                .collect();
            return ResumeResolveResponse {
                status: ResumeResolveStatus::Ready,
                matches,
                hint,
            };
        }
    }

    // Exact-id fallbacks for sessions the index cannot see (opencode child
    // sessions; cwd-less claude transcripts skipped by the R10b cwd gate) —
    // only reached when EVERY candidate missed the index.
    for candidate in &parsed.candidates {
        if candidate.kind == ResumeCandidateKind::PrefixedId && candidate.token.starts_with("ses_")
        {
            if let Some(lookup) = deps.opencode_dir_by_id {
                if let Some(hit) = lookup(&candidate.token) {
                    return ResumeResolveResponse {
                        status: ResumeResolveStatus::Ready,
                        matches: vec![ResumeResolveMatch {
                            provider: "opencode".to_string(),
                            session_id: candidate.token.clone(),
                            // opencode resumes in the SPAWN cwd (the sqlite
                            // row's own `directory` column), not the project
                            // root. `None` (empty-string directory, or any
                            // legacy-schema hit) serializes with `cwd`
                            // OMITTED — matching Node, whose `cwd: undefined`
                            // is dropped by `res.json`.
                            cwd: hit.directory,
                            session_type: Some("opencode".to_string()),
                            title: None,
                            first_user_message: None,
                            last_activity_at: None,
                            match_kind: ResumeMatchKind::Exact,
                        }],
                        hint,
                    };
                }
            }
        }
        if candidate.kind == ResumeCandidateKind::Uuid {
            if let Some(locate) = deps.locate_claude_transcript {
                if let Some(hit) = locate(&candidate.token) {
                    return ResumeResolveResponse {
                        status: ResumeResolveStatus::Ready,
                        matches: vec![ResumeResolveMatch {
                            provider: "claude".to_string(),
                            session_id: hit.session_id,
                            cwd: hit.cwd,
                            session_type: Some("claude".to_string()),
                            title: None,
                            first_user_message: None,
                            last_activity_at: None,
                            match_kind: ResumeMatchKind::Exact,
                        }],
                        hint,
                    };
                }
            }
        }
    }

    ResumeResolveResponse {
        status: ResumeResolveStatus::Ready,
        matches: Vec::new(),
        hint,
    }
}

/// `toMatch` (`resolve-session.ts:109-119`): `cwd: session.cwd ?? projectPath`;
/// `sessionType` overlays from the metadata map (usually absent).
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
        session_type: session_types.get(&session.key()).cloned(),
        title: session.title.clone(),
        first_user_message: session.first_user_message.clone(),
        last_activity_at: Some(session.last_activity_at),
        match_kind,
    }
}

/// `dedupe` (`resolve-session.ts:121-133`): first `provider:sessionId` wins —
/// which, post-sort, is the most recent entry.
fn dedupe(matches: Vec<ResumeResolveMatch>) -> Vec<ResumeResolveMatch> {
    let mut seen: HashSet<String> = HashSet::new();
    matches
        .into_iter()
        .filter(|m| seen.insert(format!("{}:{}", m.provider, m.session_id)))
        .collect()
}

//! Claude fresh-agent snapshot adapter (restart-resilience plan §2.8 item 4).
//!
//! Reads the Claude CLI's own transcript store (`<store-root>/projects/<cwd-slug>/
//! <uuid>.jsonl`) directly -- the first file-reading snapshot source in the Rust port.
//! Design choice over codex's resume-and-ask: the sidecar protocol has no history op,
//! the SDK's own `getSessionMessages` is itself just a local JSONL read with the same
//! root resolution (ledger A16), a sidecar resume burns a real SDK process per
//! snapshot GET, and the legacy Node server already proved direct-read viable
//! (`server/session-history-loader.ts` -- with real-store parsing fixes, ledger A5).
//! Store-root resolution is ORDERED CANDIDATES (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
//! `$HOME/.claude`) because the real CLI honors CLAUDE_CONFIG_DIR and IGNORES
//! CLAUDE_HOME (ledger A3) -- reading a single root risks false positive denial.
//! The transcript store is also the AUTHORITY for lost-vs-alive on attach
//! ([`crate::FreshClaudeState::handle_attach`]): file present => resumable, file
//! absent in EVERY candidate root => positively gone (mirrors opencode's 404 rule;
//! honest even under claude's 30-day `cleanupPeriodDays` GC -- an expired transcript
//! is unresumable by the CLI too, ledger A4).

use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::fs::Metadata;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use freshell_recovery::{
    DurableRecoveryProvider, ExactRecoveryIssue, ExactRecoveryLookupKey, ExactRecoveryProof,
    ExactRecoveryProviderResult, ExactRecoveryProviderSnapshot, ExactRecoveryQuery,
    ExactRecoveryState, MaterializationState, RecoveryOwnerKey,
};
use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

const MAX_EXACT_BATCH: usize = 256;
const MAX_PROJECT_ENTRIES: usize = 16_384;
const MAX_TRANSCRIPT_RECORDS: usize = 64;
const MAX_TRANSCRIPT_HEAD_BYTES: u64 = 256 * 1024;

/// Ordered candidate store roots. The real CLI resolves its store as
/// `CLAUDE_CONFIG_DIR ?? $HOME/.claude` and IGNORES `CLAUDE_HOME` (verified against
/// cli.js 2.1.220 -- ledger A3); `CLAUDE_HOME` is freshell's legacy knob
/// (`server/claude-home.ts`, `session_directory.rs` -- `pub(crate)` to that crate).
/// We read ALL candidates so a reader/writer root mismatch can never turn a live
/// session into a false positive denial.
pub(crate) fn claude_home_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !v.is_empty() {
            push(PathBuf::from(v));
        }
    }
    if let Ok(v) = std::env::var("CLAUDE_HOME") {
        if !v.is_empty() {
            push(PathBuf::from(v));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            push(PathBuf::from(h).join(".claude"));
        }
    }
    out
}

/// `find_transcript` across every candidate root, in resolution order.
/// Positive denial (attach) and snapshot 404 both require a miss EVERYWHERE.
/// `pub` + re-exported at the crate root (kata 09v1): `freshell-server`'s
/// `IndexExistenceProbe` consults this SAME check before finalizing a
/// warm-index `Absent` for claude — an on-disk transcript can be cwd-less
/// (fixture's create-time 0-byte file; crash-window partial writes) and so
/// fail the index's R10b cwd gate while the attach arm would still attempt
/// resume on it; the reconcile arm and the attach arm must share one
/// definition of "the transcript exists".
pub fn locate_transcript(session_id: &str) -> Option<PathBuf> {
    claude_home_candidates()
        .iter()
        .find_map(|root| find_transcript(root, session_id))
}

/// The one transcript root seen by a newly launched Claude child.
///
/// Exact recovery deliberately differs from the legacy snapshot/attach
/// wrapper above: lower-precedence compatibility roots cannot prove ownership
/// for a child that will write somewhere else.
pub fn effective_claude_home() -> Option<PathBuf> {
    resolve_effective_claude_home_for_cwd(None).ok().flatten()
}

/// Return one child-safe absolute/NFC root. Empty and relative selected roots
/// are valid Claude inputs, but they can only be made exact when the actual
/// child cwd is supplied; recovery never falls back to the server process cwd.
pub(crate) fn resolve_effective_claude_home_for_cwd(
    child_cwd: Option<&Path>,
) -> std::io::Result<Option<PathBuf>> {
    selected_claude_root()?
        .map(|selected| normalize_selected_claude_root(selected, child_cwd))
        .transpose()
}

fn selected_claude_root() -> std::io::Result<Option<PathBuf>> {
    if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Ok(Some(PathBuf::from(value)));
    }
    if let Some(value) = std::env::var_os("CLAUDE_HOME") {
        return Ok(Some(PathBuf::from(value)));
    }
    match std::env::var_os("HOME") {
        Some(home) => Ok(Some(PathBuf::from(home).join(".claude"))),
        None => Ok(None),
    }
}

pub(crate) fn resolve_effective_claude_home_for_launch(
    requested_cwd: Option<&Path>,
) -> std::io::Result<Option<PathBuf>> {
    let process_cwd = std::env::current_dir()?;
    let child_cwd = match requested_cwd {
        Some(cwd) if cwd.is_absolute() => lexically_normalize_absolute(cwd),
        Some(cwd) => lexically_normalize_absolute(&process_cwd.join(cwd)),
        None => process_cwd,
    };
    selected_claude_root()?
        .map(|selected| normalize_selected_claude_root(selected, Some(&child_cwd)))
        .transpose()
}

fn normalize_selected_claude_root(
    path: PathBuf,
    child_cwd: Option<&Path>,
) -> std::io::Result<PathBuf> {
    let path = path.to_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Claude store root must be Unicode",
        )
    })?;
    let path = path.nfc().collect::<String>();
    #[cfg(windows)]
    {
        let child_cwd = child_cwd.and_then(Path::to_str);
        return normalize_selected_claude_root_windows(&path, child_cwd).map(PathBuf::from);
    }
    #[cfg(not(windows))]
    let path = PathBuf::from(path);
    #[cfg(not(windows))]
    let absolute = if path.is_absolute() {
        path
    } else {
        let child_cwd = child_cwd
            .and_then(Path::to_str)
            .map(|cwd| PathBuf::from(cwd.nfc().collect::<String>()))
            .filter(|cwd| cwd.is_absolute())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "relative Claude store root requires the absolute child cwd",
                )
            })?;
        child_cwd.join(path)
    };
    #[cfg(not(windows))]
    Ok(lexically_normalize_absolute(&absolute))
}

#[cfg(any(windows, test))]
fn normalize_selected_claude_root_windows(
    selected: &str,
    child_cwd: Option<&str>,
) -> std::io::Result<String> {
    let selected = selected.nfc().collect::<String>();
    if let Some(absolute) = freshell_platform::path::win32_resolve(&selected) {
        return Ok(absolute);
    }
    let selected_bytes = selected.as_bytes();
    if selected.starts_with(['\\', '/'])
        || (selected_bytes.len() >= 2 && selected_bytes[1] == b':')
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rooted or drive-relative Claude store roots are not exact",
        ));
    }
    let child_cwd = child_cwd
        .map(|cwd| cwd.nfc().collect::<String>())
        .as_deref()
        .and_then(freshell_platform::path::win32_resolve)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "relative Claude store root requires the absolute child cwd",
            )
        })?;
    freshell_platform::path::win32_resolve(&format!(
        "{}\\{selected}",
        child_cwd.trim_end_matches('\\')
    ))
    .ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Claude store root did not resolve to an absolute Windows path",
        )
    })
}

fn lexically_normalize_absolute(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
        }
    }
    normalized
}

/// Resolve each query's child-effective root, grouping identical roots so every
/// root is captured and enumerated at most once in this admitted batch.
pub fn lookup_claude_exact_many(queries: &[ExactRecoveryQuery]) -> ExactRecoveryProviderSnapshot {
    let selected = selected_claude_root().ok().flatten();
    lookup_claude_exact_many_for_optional_selected_root(selected.as_deref(), queries)
}

/// Prove a batch against one raw root selected for the child environment.
///
/// The selected value may be empty or relative. It is resolved independently
/// against each query's exact child cwd, then equal absolute/NFC roots are
/// grouped so each physical store is captured and enumerated once.
pub fn lookup_claude_exact_many_for_selected_root(
    selected_root: &Path,
    queries: &[ExactRecoveryQuery],
) -> ExactRecoveryProviderSnapshot {
    lookup_claude_exact_many_for_optional_selected_root(Some(selected_root), queries)
}

fn lookup_claude_exact_many_for_optional_selected_root(
    selected_root: Option<&Path>,
    queries: &[ExactRecoveryQuery],
) -> ExactRecoveryProviderSnapshot {
    let validated = validated_claude_queries(queries);
    if validated.len() > MAX_EXACT_BATCH {
        return validated
            .into_iter()
            .map(|(key, _, invalid)| {
                (
                    key,
                    ExactRecoveryProviderResult::unscoped(invalid.unwrap_or(
                        ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete),
                    )),
                )
            })
            .collect();
    }
    let mut output = ExactRecoveryProviderSnapshot::new();
    let mut by_root = HashMap::<PathBuf, Vec<ExactRecoveryQuery>>::new();
    for (key, materialization, invalid) in validated {
        if let Some(invalid) = invalid {
            output.insert(key, ExactRecoveryProviderResult::unscoped(invalid));
            continue;
        }
        match selected_root
            .map(|selected| {
                normalize_selected_claude_root(selected.to_path_buf(), key.cwd.as_deref())
            })
            .transpose()
        {
            Ok(Some(root)) => by_root.entry(root).or_default().push(ExactRecoveryQuery {
                mode: DurableRecoveryProvider::Claude,
                key,
                materialization,
            }),
            Ok(None) | Err(_) => {
                output.insert(
                    key,
                    ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Retryable(
                        ExactRecoveryIssue::StoreReadFailed,
                    )),
                );
            }
        }
    }
    for (root, grouped) in by_root {
        output.extend(lookup_claude_exact_many_in_root(&root, &grouped));
    }
    output
}

/// Prove Claude ownership under one already-resolved effective root.
///
/// Callers execute this synchronous batch in the recovery coordinator's one
/// admitted blocking job. The function deduplicates stable keys before I/O.
pub fn lookup_claude_exact_many_in_root(
    claude_home: &Path,
    queries: &[ExactRecoveryQuery],
) -> ExactRecoveryProviderSnapshot {
    lookup_claude_exact_many_in_root_with_project_scan_hook(claude_home, queries, || {})
}

fn lookup_claude_exact_many_in_root_with_project_scan_hook(
    claude_home: &Path,
    queries: &[ExactRecoveryQuery],
    mut on_project_scan: impl FnMut(),
) -> ExactRecoveryProviderSnapshot {
    let validated = validated_claude_queries(queries);
    if validated.len() > MAX_EXACT_BATCH {
        return validated
            .into_iter()
            .map(|(key, _materialization, invalid)| {
                let state = invalid.unwrap_or(ExactRecoveryState::Retryable(
                    ExactRecoveryIssue::ArtifactIncomplete,
                ));
                (key, ExactRecoveryProviderResult::unscoped(state))
            })
            .collect();
    }
    if validated.iter().all(|(_, _, invalid)| invalid.is_some()) {
        return validated
            .into_iter()
            .map(|(key, _, invalid)| {
                (
                    key,
                    ExactRecoveryProviderResult::unscoped(invalid.expect("all invalid")),
                )
            })
            .collect();
    }

    let root = match ClaudeRootEvidence::resolve(claude_home) {
        Ok(root) => root,
        Err(issue) => {
            return validated
                .into_iter()
                .map(|(key, _, invalid)| {
                    (
                        key,
                        ExactRecoveryProviderResult::unscoped(
                            invalid.unwrap_or_else(|| ExactRecoveryState::Retryable(issue.clone())),
                        ),
                    )
                })
                .collect();
        }
    };
    let mut context = ClaudeBatchContext::new(&root, &mut on_project_scan);
    let mut results = validated
        .into_iter()
        .map(|(key, materialization, invalid)| {
            let was_invalid = invalid.is_some();
            let state =
                invalid.unwrap_or_else(|| prove_claude_query(&mut context, &key, materialization));
            (key, state, was_invalid)
        })
        .collect::<Vec<_>>();
    drop(context);

    if !root.unchanged() {
        for (_, state, was_invalid) in &mut results {
            if !*was_invalid {
                *state = ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactChanged);
            }
        }
    }
    results
        .into_iter()
        .map(|(key, state, _)| {
            log_claude_state(&key, &state);
            (key, ExactRecoveryProviderResult::unscoped(state))
        })
        .collect()
}

fn log_claude_state(key: &ExactRecoveryLookupKey, state: &ExactRecoveryState) {
    if let ExactRecoveryState::Retryable(issue) = state {
        if issue != &ExactRecoveryIssue::ArtifactMissing {
            tracing::warn!(
                provider = "claude",
                session_id = %key.session_ref.session_id,
                issue = issue.code(),
                "exact_recovery_provider_lookup_retryable"
            );
        }
    } else if matches!(state, ExactRecoveryState::Conflict) {
        tracing::warn!(
            provider = "claude",
            session_id = %key.session_ref.session_id,
            issue = "ambiguous_artifact",
            "exact_recovery_provider_lookup_conflict"
        );
    }
}

/// Validate and deduplicate direct callers before any provider-store I/O.
///
/// The registry already supplies canonical grouped queries in production, but
/// this provider boundary remains defensive because the trait types are public.
fn validated_claude_queries(
    queries: &[ExactRecoveryQuery],
) -> Vec<(
    ExactRecoveryLookupKey,
    MaterializationState,
    Option<ExactRecoveryState>,
)> {
    let mut positions = HashMap::<ExactRecoveryLookupKey, usize>::new();
    let mut validated = Vec::<(
        ExactRecoveryLookupKey,
        MaterializationState,
        Option<ExactRecoveryState>,
    )>::new();
    for query in queries {
        let validation = if query.mode != DurableRecoveryProvider::Claude {
            let issue = freshell_recovery::validate_session_ref(
                query.mode.as_str(),
                &query.key.session_ref,
            )
            .err()
            .unwrap_or(ExactRecoveryIssue::ProviderModeMismatch);
            Err(issue)
        } else {
            freshell_recovery::validate_session_ref("claude", &query.key.session_ref)
        };
        let (key, invalid) = match validation {
            Ok(session_ref) => (
                ExactRecoveryLookupKey {
                    session_ref,
                    cwd: query.key.cwd.clone(),
                },
                None,
            ),
            Err(issue) => (query.key.clone(), Some(ExactRecoveryState::Invalid(issue))),
        };
        if let Some(&position) = positions.get(&key) {
            let (_, materialization, prior_invalid) = &mut validated[position];
            *materialization = materialization.advance(query.materialization);
            if invalid.is_some() {
                *prior_invalid = invalid;
            }
        } else {
            positions.insert(key.clone(), validated.len());
            validated.push((key, query.materialization, invalid));
        }
    }
    validated
}

#[derive(Debug)]
enum ClaudeRootEvidence {
    Missing {
        requested: PathBuf,
    },
    Present {
        requested: PathBuf,
        canonical: PathBuf,
        identity: ClaudeFileIdentity,
    },
}

impl ClaudeRootEvidence {
    fn resolve(requested: &Path) -> Result<Self, ExactRecoveryIssue> {
        let canonical = match std::fs::canonicalize(requested) {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::Missing {
                    requested: requested.to_path_buf(),
                });
            }
            Err(_) => return Err(ExactRecoveryIssue::StoreReadFailed),
        };
        let metadata =
            std::fs::metadata(&canonical).map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        if !metadata.is_dir() {
            return Err(ExactRecoveryIssue::StoreReadFailed);
        }
        let identity = stable_directory_identity(&canonical)
            .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        Ok(Self::Present {
            requested: requested.to_path_buf(),
            canonical,
            identity,
        })
    }

    fn io_root(&self) -> &Path {
        match self {
            Self::Missing { requested } => requested,
            Self::Present { canonical, .. } => canonical,
        }
    }

    fn canonical(&self) -> Option<&Path> {
        match self {
            Self::Missing { .. } => None,
            Self::Present { canonical, .. } => Some(canonical),
        }
    }

    fn unchanged(&self) -> bool {
        match self {
            Self::Missing { requested } => std::fs::symlink_metadata(requested)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
            Self::Present {
                requested,
                canonical,
                identity,
            } => {
                std::fs::canonicalize(requested).is_ok_and(|resolved| &resolved == canonical)
                    && stable_directory_identity(canonical)
                        .is_ok_and(|current| &current == identity)
            }
        }
    }

    fn fingerprint_component(&self) -> Option<String> {
        match self {
            Self::Missing { .. } => None,
            Self::Present {
                canonical,
                identity,
                ..
            } => Some(format!(
                "{}:{}",
                canonical.to_string_lossy(),
                identity.fingerprint_component()
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeProjectEntryKind {
    Directory,
    Symlink,
    Other,
    FileTypeFailed,
}

#[derive(Debug, Clone)]
struct ClaudeProjectEntry {
    name: Option<String>,
    path: PathBuf,
    kind: ClaudeProjectEntryKind,
}

#[derive(Debug)]
struct ClaudeProjectIndex {
    projects_missing: bool,
    entries: Vec<ClaudeProjectEntry>,
    global_issue: Option<ExactRecoveryIssue>,
}

impl ClaudeProjectIndex {
    fn build(root: &ClaudeRootEvidence) -> Self {
        let projects = root.io_root().join("projects");
        let read_dir = match std::fs::read_dir(projects) {
            Ok(read_dir) => read_dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Self {
                    projects_missing: true,
                    entries: Vec::new(),
                    global_issue: None,
                };
            }
            Err(_) => {
                return Self {
                    projects_missing: false,
                    entries: Vec::new(),
                    global_issue: Some(ExactRecoveryIssue::StoreReadFailed),
                };
            }
        };
        let mut entries = Vec::new();
        let mut global_issue = None;
        for (index, entry) in read_dir.enumerate() {
            if index >= MAX_PROJECT_ENTRIES {
                global_issue = Some(ExactRecoveryIssue::ArtifactIncomplete);
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    global_issue.get_or_insert(ExactRecoveryIssue::StoreReadFailed);
                    continue;
                }
            };
            let kind = match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => ClaudeProjectEntryKind::Directory,
                Ok(file_type) if file_type.is_symlink() => ClaudeProjectEntryKind::Symlink,
                Ok(_) => ClaudeProjectEntryKind::Other,
                Err(_) => ClaudeProjectEntryKind::FileTypeFailed,
            };
            entries.push(ClaudeProjectEntry {
                name: entry.file_name().to_str().map(str::to_owned),
                path: entry.path(),
                kind,
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Self {
            projects_missing: false,
            entries,
            global_issue,
        }
    }

    fn all_directories(&self) -> (Vec<PathBuf>, Option<ExactRecoveryIssue>) {
        let mut paths = Vec::new();
        let mut issue = self.global_issue.clone();
        for entry in &self.entries {
            match entry.kind {
                ClaudeProjectEntryKind::Directory => paths.push(entry.path.clone()),
                ClaudeProjectEntryKind::Symlink | ClaudeProjectEntryKind::FileTypeFailed => {
                    issue.get_or_insert(ExactRecoveryIssue::StoreReadFailed);
                }
                ClaudeProjectEntryKind::Other => {}
            }
        }
        (paths, issue)
    }

    fn matching_long_prefix(
        &self,
        expected_prefix: &str,
    ) -> (Vec<PathBuf>, Option<ExactRecoveryIssue>) {
        let mut paths = Vec::new();
        let mut issue = self.global_issue.clone();
        for entry in &self.entries {
            if !entry
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with(expected_prefix))
            {
                continue;
            }
            if entry.kind == ClaudeProjectEntryKind::Directory {
                paths.push(entry.path.clone());
            } else {
                issue.get_or_insert(ExactRecoveryIssue::StoreReadFailed);
            }
        }
        (paths, issue)
    }
}

struct ClaudeBatchContext<'a> {
    root: &'a ClaudeRootEvidence,
    project_index: Option<ClaudeProjectIndex>,
    inspection_cache:
        HashMap<(PathBuf, String), Result<Option<ClaudeArtifact>, ExactRecoveryIssue>>,
    on_project_scan: &'a mut dyn FnMut(),
}

impl<'a> ClaudeBatchContext<'a> {
    fn new(root: &'a ClaudeRootEvidence, on_project_scan: &'a mut dyn FnMut()) -> Self {
        Self {
            root,
            project_index: None,
            inspection_cache: HashMap::new(),
            on_project_scan,
        }
    }

    fn project_index(&mut self) -> &ClaudeProjectIndex {
        if self.project_index.is_none() {
            (self.on_project_scan)();
            self.project_index = Some(ClaudeProjectIndex::build(self.root));
        }
        self.project_index.as_ref().expect("initialized")
    }

    fn inspect(
        &mut self,
        path: PathBuf,
        expected_session_id: &str,
    ) -> Result<Option<ClaudeArtifact>, ExactRecoveryIssue> {
        let cache_key = (path.clone(), expected_session_id.to_string());
        if let Some(result) = self.inspection_cache.get(&cache_key) {
            return result.clone();
        }
        let result = inspect_claude_transcript_under_root(self.root, &path, expected_session_id);
        self.inspection_cache.insert(cache_key, result.clone());
        result
    }
}

fn prove_claude_query(
    context: &mut ClaudeBatchContext<'_>,
    key: &ExactRecoveryLookupKey,
    materialization: MaterializationState,
) -> ExactRecoveryState {
    let session_id = key.session_ref.session_id.as_str();
    if let Some(cwd) = key.cwd.as_deref() {
        let project = claude_project_location(cwd);
        if let Some(prefix) = project.long_prefix.as_deref() {
            if let Some(state) = prove_claude_long_slug_variants(context, key, session_id, prefix) {
                return state;
            }
        } else {
            let direct = context
                .root
                .io_root()
                .join("projects")
                .join(&project.exact)
                .join(format!("{session_id}.jsonl"));
            match context.inspect(direct, session_id) {
                Ok(Some(artifact)) => return present_claude_proof(key, artifact),
                Ok(None) => {}
                Err(issue) => return ExactRecoveryState::Retryable(issue),
            }
        }
    }

    let (project_paths, mut incomplete_issue, projects_missing) = {
        let index = context.project_index();
        let (paths, issue) = index.all_directories();
        (paths, issue, index.projects_missing)
    };
    if projects_missing {
        return missing_claude_state(key, materialization);
    }

    let mut artifacts = Vec::new();
    let mut identities = HashSet::new();
    for project in project_paths {
        let candidate = project.join(format!("{session_id}.jsonl"));
        match context.inspect(candidate, session_id) {
            Ok(Some(artifact)) => {
                if identities.insert(artifact.identity.clone()) {
                    artifacts.push(artifact);
                }
            }
            Ok(None) => {}
            Err(issue) => {
                incomplete_issue.get_or_insert(issue);
            }
        }
    }
    if artifacts.len() > 1 {
        ExactRecoveryState::Conflict
    } else if incomplete_issue.is_some() {
        ExactRecoveryState::Retryable(incomplete_issue.expect("checked"))
    } else if let Some(artifact) = artifacts.pop() {
        present_claude_proof(key, artifact)
    } else {
        missing_claude_state(key, materialization)
    }
}

/// Claude's Node and Bun builds share the first 200 sanitized UTF-16 code
/// units but use different hash functions. A unique owned sibling under that
/// writer-defined prefix is therefore authoritative; unrelated project
/// failures cannot poison an expected-cwd direct lookup.
fn prove_claude_long_slug_variants(
    context: &mut ClaudeBatchContext<'_>,
    key: &ExactRecoveryLookupKey,
    session_id: &str,
    prefix: &str,
) -> Option<ExactRecoveryState> {
    let expected_prefix = format!("{prefix}-");
    let (paths, mut issue, projects_missing) = {
        let index = context.project_index();
        let (paths, issue) = index.matching_long_prefix(&expected_prefix);
        (paths, issue, index.projects_missing)
    };
    if projects_missing {
        return None;
    }

    let mut artifacts = Vec::new();
    let mut identities = HashSet::new();
    for project in paths {
        let candidate = project.join(format!("{session_id}.jsonl"));
        match context.inspect(candidate, session_id) {
            Ok(Some(artifact)) => {
                if identities.insert(artifact.identity.clone()) {
                    artifacts.push(artifact);
                }
            }
            Ok(None) => {}
            Err(found) => {
                issue.get_or_insert(found);
            }
        }
    }
    if artifacts.len() > 1 {
        Some(ExactRecoveryState::Conflict)
    } else if let Some(issue) = issue {
        Some(ExactRecoveryState::Retryable(issue))
    } else {
        artifacts
            .pop()
            .map(|artifact| present_claude_proof(key, artifact))
    }
}

fn missing_claude_state(
    key: &ExactRecoveryLookupKey,
    materialization: MaterializationState,
) -> ExactRecoveryState {
    if materialization == MaterializationState::Allocated {
        ExactRecoveryState::AllocatedUnmaterialized(
            RecoveryOwnerKey::global(&key.session_ref).expect("validated global Claude owner"),
        )
    } else {
        ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactMissing)
    }
}

/// Claude Code derives its project key from the real cwd, NFC-normalizes it,
/// replaces each non-ASCII-alphanumeric UTF-16 code unit with `-`, and adds a
/// Java-style hash when the result exceeds 200 code units. Bun uses a
/// different hash function, so the prefix is retained for bounded fallback.
struct ClaudeProjectLocation {
    exact: String,
    long_prefix: Option<String>,
}

fn claude_project_location(cwd: &Path) -> ClaudeProjectLocation {
    #[cfg(windows)]
    let writer_cwd = node_compatible_windows_realpath(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    #[cfg(not(windows))]
    let writer_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let writer_cwd = writer_cwd.to_string_lossy();
    let writer_cwd = writer_cwd.into_owned();
    claude_project_location_from_writer_cwd(&writer_cwd)
}

fn claude_project_location_from_writer_cwd(writer_cwd: &str) -> ClaudeProjectLocation {
    let normalized = writer_cwd.nfc().collect::<String>();
    let sanitized = normalized
        .encode_utf16()
        .map(|unit| {
            if matches!(unit, 48..=57 | 65..=90 | 97..=122) {
                char::from_u32(u32::from(unit)).expect("ASCII code unit")
            } else {
                '-'
            }
        })
        .collect::<String>();
    if sanitized.len() <= 200 {
        return ClaudeProjectLocation {
            exact: sanitized,
            long_prefix: None,
        };
    }

    let prefix = sanitized.chars().take(200).collect::<String>();
    let hash = normalized.encode_utf16().fold(0_i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    });
    let suffix = base36_unsigned(if hash < 0 {
        -(i64::from(hash))
    } else {
        i64::from(hash)
    } as u64);
    ClaudeProjectLocation {
        exact: format!("{prefix}-{suffix}"),
        long_prefix: Some(prefix),
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_writer_realpath(path: &str) -> String {
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

#[cfg(any(windows, test))]
fn windows_writer_lexical_path(path: &str) -> std::io::Result<PathBuf> {
    let path = normalize_windows_writer_realpath(path);
    freshell_platform::path::win32_resolve(&path)
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("Claude cwd is not an absolute Windows path"))
}

/// Match Node's default `fs.realpathSync` on Windows: lexical resolution plus
/// a component walk that preserves the caller's spelling/case for ordinary
/// components and substitutes only reparse-point targets. Rust
/// `canonicalize` cannot be used here because it normalizes component case and
/// therefore changes Claude's project slug/hash.
#[cfg(windows)]
fn node_compatible_windows_realpath(path: &Path) -> std::io::Result<PathBuf> {
    use std::path::Component;

    let unresolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut unresolved = windows_writer_lexical_path(
        unresolved
            .to_str()
            .ok_or_else(|| std::io::Error::other("Claude cwd is not Unicode"))?,
    )?;
    for _ in 0..64 {
        let components = unresolved.components().collect::<Vec<_>>();
        let mut resolved = PathBuf::new();
        let mut replacement = None;
        for (index, component) in components.iter().enumerate() {
            match component {
                Component::Prefix(_) | Component::RootDir => {
                    resolved.push(component.as_os_str());
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    resolved.pop();
                }
                Component::Normal(name) => {
                    let candidate = resolved.join(name);
                    let metadata = std::fs::symlink_metadata(&candidate)?;
                    if metadata.file_type().is_symlink() {
                        let target = std::fs::read_link(&candidate)?;
                        let mut next = if target.is_absolute() {
                            target
                        } else {
                            resolved.join(target)
                        };
                        for remaining in &components[index + 1..] {
                            next.push(remaining.as_os_str());
                        }
                        replacement = Some(next);
                        break;
                    }
                    resolved.push(name);
                }
            }
        }
        if let Some(next) = replacement {
            unresolved = windows_writer_lexical_path(
                next.to_str()
                    .ok_or_else(|| std::io::Error::other("Claude cwd is not Unicode"))?,
            )?;
            continue;
        }
        let normalized = normalize_windows_writer_realpath(resolved.to_string_lossy().as_ref());
        return Ok(PathBuf::from(normalized));
    }
    Err(std::io::Error::other(
        "too many Windows reparse points while resolving Claude cwd",
    ))
}

#[cfg(test)]
fn claude_project_slug(cwd: &Path) -> String {
    claude_project_location(cwd).exact
}

fn base36_unsigned(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut reversed = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        reversed.push(if digit < 10 {
            char::from(b'0' + digit)
        } else {
            char::from(b'a' + digit - 10)
        });
        value /= 36;
    }
    reversed.into_iter().rev().collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ClaudeFileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    volume_serial_number: u64,
    #[cfg(windows)]
    file_id: [u8; 16],
}

impl ClaudeFileIdentity {
    #[cfg(unix)]
    fn from_metadata(metadata: &Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }

    fn from_file(file: &File) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self::from_metadata(&file.metadata()?))
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
            };

            let mut information = FILE_ID_INFO::default();
            let result = unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle() as _,
                    FileIdInfo,
                    std::ptr::addr_of_mut!(information).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            };
            if result == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self {
                volume_serial_number: information.VolumeSerialNumber,
                file_id: information.FileId.Identifier,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = file;
            Err(std::io::Error::other(
                "stable file identity is unsupported on this platform",
            ))
        }
    }

    fn fingerprint_component(&self) -> String {
        #[cfg(unix)]
        {
            format!("{}:{}", self.dev, self.ino)
        }
        #[cfg(windows)]
        {
            let file_id = self
                .file_id
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("{}:{file_id}", self.volume_serial_number)
        }
        #[cfg(not(any(unix, windows)))]
        {
            unreachable!("unsupported platforms never produce a stable identity")
        }
    }
}

fn stable_directory_identity(path: &Path) -> std::io::Result<ClaudeFileIdentity> {
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other("not a directory"));
        }
        Ok(ClaudeFileIdentity::from_metadata(&metadata))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };

        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::other("not a stable non-reparse directory"));
        }
        ClaudeFileIdentity::from_file(&file)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(std::io::Error::other(
            "stable directory identity is unsupported on this platform",
        ))
    }
}

fn stable_regular_path_identity(path: &Path) -> std::io::Result<ClaudeFileIdentity> {
    let file = open_regular_nonblocking_nofollow(path)?;
    ClaudeFileIdentity::from_file(&file)
}

#[derive(Debug, Clone)]
struct ClaudeArtifact {
    identity: ClaudeFileIdentity,
    fingerprint: String,
}

fn present_claude_proof(
    key: &ExactRecoveryLookupKey,
    artifact: ClaudeArtifact,
) -> ExactRecoveryState {
    ExactRecoveryState::Present(ExactRecoveryProof {
        owner_key: RecoveryOwnerKey::global(&key.session_ref)
            .expect("validated global Claude owner"),
        artifact_fingerprint: artifact.fingerprint,
        resolved_cwd: None,
    })
}

fn inspect_claude_transcript_under_root(
    root: &ClaudeRootEvidence,
    path: &Path,
    expected_session_id: &str,
) -> Result<Option<ClaudeArtifact>, ExactRecoveryIssue> {
    inspect_claude_transcript_under_root_with_hook(root, path, expected_session_id, || {})
}

fn inspect_claude_transcript_under_root_with_hook(
    root: &ClaudeRootEvidence,
    path: &Path,
    expected_session_id: &str,
    after_read: impl FnOnce(),
) -> Result<Option<ClaudeArtifact>, ExactRecoveryIssue> {
    let initial = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ExactRecoveryIssue::StoreReadFailed),
    };
    if initial.file_type().is_symlink() || !initial.is_file() {
        return Err(ExactRecoveryIssue::StoreReadFailed);
    }
    let Some(canonical_root) = root.canonical() else {
        return Ok(None);
    };
    let requested_parent = path.parent().ok_or(ExactRecoveryIssue::StoreReadFailed)?;
    let canonical_parent =
        std::fs::canonicalize(requested_parent).map_err(|_| ExactRecoveryIssue::ArtifactChanged)?;
    if !canonical_parent.starts_with(canonical_root) {
        return Err(ExactRecoveryIssue::StoreReadFailed);
    }
    let parent_identity = stable_directory_identity(&canonical_parent)
        .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
    let canonical_candidate = canonical_parent.join(
        path.file_name()
            .ok_or(ExactRecoveryIssue::StoreReadFailed)?,
    );
    let mut opened = read_open_claude_transcript(&canonical_candidate)?
        .ok_or(ExactRecoveryIssue::ArtifactChanged)?;
    after_read();
    opened.ensure_unchanged(&canonical_candidate)?;
    let parent_unchanged = stable_directory_identity(&canonical_parent)
        .is_ok_and(|current| current == parent_identity);
    let requested_path_unchanged =
        stable_regular_path_identity(path).is_ok_and(|current| current == opened.identity);
    let requested_parent_unchanged =
        std::fs::canonicalize(requested_parent).is_ok_and(|current| current == canonical_parent);
    if !requested_parent_unchanged
        || !parent_unchanged
        || !requested_path_unchanged
        || !root.unchanged()
    {
        return Err(ExactRecoveryIssue::ArtifactChanged);
    }
    if opened.embedded_session_id.as_deref() != Some(expected_session_id) {
        return Err(ExactRecoveryIssue::Unproved);
    }
    let relative_path = canonical_candidate
        .strip_prefix(canonical_root)
        .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
    let root_fingerprint = root
        .fingerprint_component()
        .ok_or(ExactRecoveryIssue::StoreReadFailed)?;
    Ok(Some(ClaudeArtifact {
        fingerprint: format!(
            "claude:{}:{}:{}",
            root_fingerprint,
            relative_path.to_string_lossy(),
            opened.identity.fingerprint_component()
        ),
        identity: opened.identity,
    }))
}

#[cfg(test)]
fn inspect_claude_transcript(
    path: &Path,
    expected_session_id: &str,
) -> Result<Option<ClaudeArtifact>, ExactRecoveryIssue> {
    inspect_claude_transcript_with_hook(path, expected_session_id, || {})
}

#[cfg(test)]
fn inspect_claude_transcript_with_hook(
    path: &Path,
    expected_session_id: &str,
    after_read: impl FnOnce(),
) -> Result<Option<ClaudeArtifact>, ExactRecoveryIssue> {
    let Some(mut opened) = read_open_claude_transcript(path)? else {
        return Ok(None);
    };
    after_read();
    opened.ensure_unchanged(path)?;
    if opened.embedded_session_id.as_deref() != Some(expected_session_id) {
        return Err(ExactRecoveryIssue::Unproved);
    }
    Ok(Some(ClaudeArtifact {
        identity: opened.identity,
        fingerprint: String::new(),
    }))
}

struct OpenClaudeTranscript {
    file: File,
    identity: ClaudeFileIdentity,
    embedded_session_id: Option<String>,
}

impl OpenClaudeTranscript {
    fn ensure_unchanged(&mut self, path: &Path) -> Result<(), ExactRecoveryIssue> {
        let handle_identity = ClaudeFileIdentity::from_file(&self.file)
            .map_err(|_| ExactRecoveryIssue::ArtifactChanged)?;
        let path_identity =
            stable_regular_path_identity(path).map_err(|_| ExactRecoveryIssue::ArtifactChanged)?;
        if handle_identity != self.identity || path_identity != self.identity {
            return Err(ExactRecoveryIssue::ArtifactChanged);
        }
        Ok(())
    }
}

fn read_open_claude_transcript(
    path: &Path,
) -> Result<Option<OpenClaudeTranscript>, ExactRecoveryIssue> {
    let mut file = match open_regular_nonblocking_nofollow(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ExactRecoveryIssue::StoreReadFailed),
    };
    let identity =
        ClaudeFileIdentity::from_file(&file).map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
    let embedded_session_id = read_claude_identity(&mut file)?;
    Ok(Some(OpenClaudeTranscript {
        file,
        identity,
        embedded_session_id,
    }))
}

fn read_claude_identity(file: &mut File) -> Result<Option<String>, ExactRecoveryIssue> {
    let reader = BufReader::new(file);
    let mut limited = reader.take(MAX_TRANSCRIPT_HEAD_BYTES + 1);
    let mut line = Vec::new();
    for _ in 0..MAX_TRANSCRIPT_RECORDS {
        line.clear();
        let bytes = limited
            .read_until(b'\n', &mut line)
            .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        if bytes == 0 {
            return Err(ExactRecoveryIssue::ArtifactIncomplete);
        }
        if line.len() as u64 > MAX_TRANSCRIPT_HEAD_BYTES || line.last() != Some(&b'\n') {
            return Err(ExactRecoveryIssue::ArtifactIncomplete);
        }
        let trimmed = line
            .strip_suffix(b"\n")
            .and_then(|line| line.strip_suffix(b"\r").or(Some(line)))
            .unwrap_or(&line);
        if trimmed.is_empty() {
            continue;
        }
        let record: Value =
            serde_json::from_slice(trimmed).map_err(|_| ExactRecoveryIssue::ArtifactIncomplete)?;
        if let Some(session_id) = record.get("sessionId").and_then(Value::as_str) {
            return Ok(Some(session_id.to_string()));
        }
    }
    Err(ExactRecoveryIssue::ArtifactIncomplete)
}

fn open_regular_nonblocking_nofollow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        };

        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !metadata.is_file() {
            return Err(std::io::Error::other("not a regular non-reparse file"));
        }
        return Ok(file);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(std::io::Error::other("not a regular no-follow file"));
        }
    }
    #[cfg(not(windows))]
    {
        let file = options.open(path)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other("not a regular file"));
        }
        Ok(file)
    }
}

/// The session's ORIGINAL cwd: first non-empty `cwd` field among the transcript's
/// lines (100% of real user/assistant lines carry it -- ledger A5 census). Needed
/// because the CLI's resume lookup is scoped to the original cwd's project slug
/// (ledger A15). Reads lazily, stops at the first hit; malformed lines skipped.
pub(crate) fn transcript_cwd(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(serde_json::Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Locate `<claude_home>/projects/*/<session_id>.jsonl` (or one subdir deeper, e.g.
/// `<project>/<session-id-dir>/...` layouts). Filename scan, NEVER slug re-derivation:
/// the cwd->slug encoding is lossy (`docs/port-plan.md:45`). Sorted dirs for
/// determinism (mirrors `directory_index.rs::discover_claude_home`).
pub(crate) fn find_transcript(claude_home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let filename = format!("{session_id}.jsonl");
    let projects = claude_home.join("projects");
    let entries = std::fs::read_dir(&projects).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for dir in &dirs {
        let direct = dir.join(&filename);
        if direct.is_file() {
            return Some(direct);
        }
        let Ok(nested) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut subdirs: Vec<PathBuf> = nested
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        for sub in &subdirs {
            let candidate = sub.join(&filename);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Why a claude snapshot could not be served.
#[derive(Debug)]
pub(crate) enum ClaudeSnapshotError {
    /// No transcript file for this id -- the store positively does not know it
    /// (maps to 404 FRESH_AGENT_LOST_SESSION, the codex/opencode convention).
    NotFound,
    /// The file exists but could not be read; the message becomes the 500 error body.
    Io(String),
}

/// One transcript JSONL line -> zero-or-one snapshot turn. Parsing rules are the
/// legacy `extractChatMessagesFromJsonl` contract (`server/session-history-loader.ts:36-131`)
/// PLUS the real-store fixes from the ledger A5 census (23,615 real lines): keep only
/// type user|assistant; message may be a plain string, `{content: [...]}`, or
/// `{content: "<string>"}` (the DOMINANT real prompt shape, which legacy-as-coded
/// drops); lines flagged isMeta/isSidechain/isCompactSummary/isVisibleInTranscriptOnly
/// are synthetic/subagent noise and are SKIPPED; malformed lines and unknown block
/// kinds are skipped, never fatal.
fn parse_transcript_turns(thread_id: &str, transcript: &str) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    for line in transcript.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = match obj.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        // Real transcripts flag synthetic/subagent lines (ledger A5): skip them.
        if [
            "isMeta",
            "isSidechain",
            "isCompactSummary",
            "isVisibleInTranscriptOnly",
        ]
        .iter()
        .any(|k| obj.get(*k).and_then(Value::as_bool) == Some(true))
        {
            continue;
        }
        let msg = obj.get("message");
        let blocks: Vec<Value> = match msg {
            Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
            Some(Value::Object(m)) => match m.get("content") {
                Some(Value::Array(arr)) => arr.clone(),
                Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
                _ => continue,
            },
            _ => continue,
        };

        let ordinal = turns.len();
        let turn_id = format!("{thread_id}:{ordinal}");
        let mut items: Vec<Value> = Vec::new();
        for (j, block) in blocks.iter().enumerate() {
            let item_id = format!("{turn_id}-i{j}");
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        items.push(json!({ "id": item_id, "kind": "text", "text": text }));
                    }
                }
                Some("thinking") => {
                    let text = block
                        .get("thinking")
                        .or_else(|| block.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    items.push(json!({ "id": item_id, "kind": "thinking", "text": text }));
                }
                Some("tool_use") => {
                    let tool_use_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(item_id.as_str())
                        .to_string();
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let mut item = Map::new();
                    item.insert("id".into(), json!(item_id));
                    item.insert("kind".into(), json!("tool_use"));
                    item.insert("toolUseId".into(), json!(tool_use_id));
                    item.insert("name".into(), json!(name));
                    if let Some(input) = block.get("input") {
                        item.insert("input".into(), input.clone());
                    }
                    items.push(Value::Object(item));
                }
                Some("tool_result") => {
                    let tool_use_id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or(item_id.as_str())
                        .to_string();
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    items.push(json!({
                        "id": item_id,
                        "kind": "tool_result",
                        "toolUseId": tool_use_id,
                        "content": tool_result_text(block),
                        "isError": is_error,
                    }));
                }
                _ => {}
            }
        }
        if items.is_empty() {
            continue;
        }

        let summary = summarize(&items);
        let mut turn = Map::new();
        turn.insert("id".into(), json!(turn_id));
        turn.insert("turnId".into(), json!(turn_id));
        if let Some(message_id) = msg
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            turn.insert("messageId".into(), json!(message_id));
        }
        turn.insert("ordinal".into(), json!(ordinal));
        turn.insert("source".into(), json!("durable"));
        turn.insert("role".into(), json!(role));
        if let Some(ts) = obj.get("timestamp").and_then(Value::as_str) {
            turn.insert("timestamp".into(), json!(ts));
        }
        if let Some(model) = msg
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            turn.insert("model".into(), json!(model));
        }
        turn.insert("summary".into(), json!(summary));
        turn.insert("items".into(), json!(items));
        turns.push(Value::Object(turn));
    }
    turns
}

/// Flatten a tool_result block's content (string, or array of text blocks) to a string.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Turn summary: first non-empty `text` item's text, falling back to the first
/// non-empty `thinking` item's text (char-safe truncate), else a tool label --
/// `FreshAgentTurnSchema.summary` is REQUIRED. Text is preferred over thinking
/// so an assistant turn's summary is its visible answer, not its reasoning
/// preamble (golden fixture turn 1: items `[thinking "pondering", text "first
/// answer"]` must summarize to `"first answer"`).
fn summarize(items: &[Value]) -> String {
    let first_text_of = |kind: &str| -> Option<String> {
        items.iter().find_map(|item| {
            if item.get("kind").and_then(Value::as_str) != Some(kind) {
                return None;
            }
            let trimmed = item.get("text").and_then(Value::as_str)?.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(120).collect())
            }
        })
    };
    if let Some(summary) = first_text_of("text").or_else(|| first_text_of("thinking")) {
        return summary;
    }
    for item in items {
        match item.get("kind").and_then(Value::as_str) {
            Some("tool_use") => {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    return name.to_string();
                }
            }
            Some("tool_result") => return "[tool result]".to_string(),
            _ => {}
        }
    }
    "[claude turn]".to_string()
}

/// Build the `FreshAgentSnapshotSchema`-exact JSON (`shared/fresh-agent-contract.ts:230-246`,
/// zod `.strict()` -- every key here is either required or schema-known; NOTHING extra).
pub(crate) fn build_claude_snapshot_json(
    session_type: &str,
    thread_id: &str,
    transcript: &str,
    revision: i64,
) -> Value {
    let turns = parse_transcript_turns(thread_id, transcript);
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "sessionType": session_type,
        "provider": "claude",
        "threadId": thread_id,
        "sessionId": thread_id,
        "revision": revision.max(0),
        "latestTurnId": latest_turn_id,
        // Deliberate divergence from codex (which serves live status from session
        // state): this adapter is disk-only and always reports "idle" -- live status
        // is authoritative via the WS status events, so the client ignores this on
        // live sessions.
        "status": "idle",
        "capabilities": {
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            "fork": false,
        },
        "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
        "pendingApprovals": [],
        "pendingQuestions": [],
        "worktrees": [],
        "diffs": [],
        "childThreads": [],
        "turns": turns,
        "extensions": {},
    })
}

/// Locate + read + build. `revision` = transcript mtime in ms (monotonic as the file
/// grows -- `mergeSnapshotForDisplay` DROPS revision regressions), fallback turn count.
pub(crate) async fn get_claude_snapshot(
    session_type: &str,
    thread_id: &str,
) -> Result<Value, ClaudeSnapshotError> {
    // Cannot check => must not deny (the attach arm in claude.rs treats this exact
    // state as Transient): with NO resolvable store root we cannot assert the
    // session is gone, so this is Io (-> 500), never NotFound (-> 404 lost).
    if claude_home_candidates().is_empty() {
        return Err(ClaudeSnapshotError::Io(
            "no claude store root resolvable (CLAUDE_CONFIG_DIR/CLAUDE_HOME/HOME all unset)".into(),
        ));
    }
    // Miss in EVERY candidate root => 404 (positive denial; ledger A3/A4).
    let path = locate_transcript(thread_id).ok_or(ClaudeSnapshotError::NotFound)?;
    let mtime_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| ClaudeSnapshotError::Io(e.to_string()))?;
    let mut snapshot = build_claude_snapshot_json(session_type, thread_id, &content, 0);
    let turn_count = snapshot["turns"]
        .as_array()
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    snapshot["revision"] = json!(mtime_ms.unwrap_or(turn_count).max(0));
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_protocol::SessionLocator;
    use freshell_recovery::{
        DurableRecoveryProvider, ExactRecoveryIssue, ExactRecoveryQuery, ExactRecoveryState,
        MaterializationState,
    };

    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn find_transcript_locates_a_direct_project_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-home-user-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "11111111-1111-4111-8111-111111111111"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_locates_a_one_level_nested_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p").join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "22222222-2222-4222-8222-222222222222"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_misses_cleanly_and_rejects_traversal() {
        let home = temp_home();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        assert_eq!(
            find_transcript(home.path(), "33333333-3333-4333-8333-333333333333"),
            None
        );
        assert_eq!(find_transcript(home.path(), "../etc/passwd"), None);
        assert_eq!(find_transcript(home.path(), "a/b"), None);
        assert_eq!(find_transcript(home.path(), ""), None);
    }

    #[test]
    fn transcript_cwd_reads_the_first_cwd_field() {
        let home = temp_home();
        let file = home.path().join("t.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\",\"message\":\"hi\"}\n",
        )
        .unwrap();
        assert_eq!(transcript_cwd(&file), Some("/home/user/proj".to_string()));
        let empty = home.path().join("e.jsonl");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(transcript_cwd(&empty), None);
    }

    const SAMPLE_TRANSCRIPT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-transcript-sample.jsonl"
    ));
    const GOLDEN_SNAPSHOT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-snapshot-golden.json"
    ));

    #[test]
    fn builder_output_matches_the_golden_snapshot_fixture() {
        let built = build_claude_snapshot_json(
            "freshclaude",
            "44444444-4444-4444-8444-444444444444",
            SAMPLE_TRANSCRIPT,
            1753437600000,
        );
        let golden: serde_json::Value =
            serde_json::from_str(GOLDEN_SNAPSHOT).expect("golden parses");
        assert_eq!(built, golden);
    }

    #[test]
    fn user_turns_carry_role_user_and_literal_prompt_text() {
        // Load-bearing for the frozen client's local-echo clearing: claude's
        // send.accepted has no submittedTurnId, so the client matches prompt text
        // against role:'user' turns (freshAgentSlice fold).
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0);
        let turns = built["turns"].as_array().unwrap();
        let first = &turns[0];
        assert_eq!(first["role"], "user");
        assert_eq!(first["items"][0]["kind"], "text");
        assert_eq!(first["items"][0]["text"], "first question");
    }

    #[test]
    fn turn_ids_are_unique_and_ordering_is_transcript_order() {
        let built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0);
        assert_eq!(built["sessionType"], "kilroy");
        let turns = built["turns"].as_array().unwrap();
        let mut ids: Vec<&str> = turns
            .iter()
            .map(|t| t["turnId"].as_str().unwrap())
            .collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(
            ids.len(),
            before,
            "turnIds must be unique (historyBodies map key)"
        );
        assert_eq!(turns.len(), 6); // summary + malformed + isMeta lines skipped
        assert_eq!(built["latestTurnId"], turns[5]["turnId"]);
        // The dominant real prompt shape (object-with-string-content, ledger A5)
        // must yield a text turn -- local-echo clearing depends on it.
        assert_eq!(turns[3]["items"][0]["text"], "cli string content question");
    }

    /// Saves the named env vars on construction and restores them on drop (so the
    /// restore also runs on panic while the caller still holds `CLAUDE_ENV_LOCK` --
    /// locals drop in reverse declaration order, lock guard last).
    struct EnvVarsRestore {
        saved: Vec<(&'static str, Option<String>)>,
    }
    impl EnvVarsRestore {
        fn remove_all(keys: &[&'static str]) -> Self {
            let saved = keys
                .iter()
                .map(|k| {
                    let v = std::env::var(k).ok();
                    std::env::remove_var(k);
                    (*k, v)
                })
                .collect();
            Self { saved }
        }
    }
    impl Drop for EnvVarsRestore {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[tokio::test]
    async fn snapshot_with_no_resolvable_store_root_is_io_not_notfound() {
        // Cannot check => must not deny: with every store-root env var unset the
        // server cannot assert the session is gone, so the error must be Io (-> 500),
        // never NotFound (-> 404 FRESH_AGENT_LOST_SESSION). Env vars are
        // process-global -- serialize under the shared claude env lock.
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "HOME"]);
        assert!(claude_home_candidates().is_empty());
        let result =
            get_claude_snapshot("freshclaude", "55555555-5555-4555-8555-555555555555").await;
        match result {
            Err(ClaudeSnapshotError::Io(msg)) => {
                assert!(msg.contains("no claude store root resolvable"), "{msg}");
            }
            other => panic!("expected Io (cannot-check must not deny), got {other:?}"),
        }
    }

    fn exact_query(
        session_id: &str,
        cwd: Option<&Path>,
        materialization: MaterializationState,
    ) -> ExactRecoveryQuery {
        freshell_recovery::prepare_exact_recovery_query(
            "claude",
            &SessionLocator {
                provider: "claude".to_string(),
                session_id: session_id.to_string(),
            },
            cwd.map(Path::to_path_buf),
            materialization,
        )
        .expect("valid claude query")
    }

    fn write_owned_transcript(root: &Path, slug: &str, session_id: &str, cwd: &str) -> PathBuf {
        let project = root.join("projects").join(slug);
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("{session_id}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{}\n",
                json!({
                    "type": "summary",
                    "sessionId": session_id,
                    "cwd": cwd,
                })
            ),
        )
        .unwrap();
        path
    }

    fn state_for<'a>(
        snapshot: &'a freshell_recovery::ExactRecoveryProviderSnapshot,
        query: &ExactRecoveryQuery,
    ) -> &'a ExactRecoveryState {
        &snapshot.get(&query.key).expect("query result").state
    }

    #[test]
    fn claude_snapshot_exact_direct_transcript_proves_global_ownership() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000001";
        write_owned_transcript(
            root.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        let query = exact_query(
            session_id,
            Some(Path::new("/workspace/project")),
            MaterializationState::Observed,
        );

        let snapshot = lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query));
        let ExactRecoveryState::Present(proof) = state_for(&snapshot, &query) else {
            panic!("owned direct transcript must be present: {snapshot:?}");
        };
        assert_eq!(proof.owner_key.provider, "claude");
        assert_eq!(proof.owner_key.session_id, session_id);
        assert_eq!(proof.owner_key.provider_scope, None);
        assert!(proof.artifact_fingerprint.starts_with("claude:"));
    }

    #[test]
    fn claude_snapshot_subagent_only_artifact_never_proves_main_ownership() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000002";
        let subagents = root
            .path()
            .join("projects")
            .join("-workspace-project")
            .join(session_id)
            .join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        std::fs::write(
            subagents.join(format!("{session_id}.jsonl")),
            format!("{{\"sessionId\":\"{session_id}\"}}\n"),
        )
        .unwrap();
        let query = exact_query(session_id, None, MaterializationState::Observed);

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactMissing)
        ));
    }

    #[test]
    fn claude_snapshot_allocated_identity_without_a_file_is_not_loss() {
        let root = temp_home();
        std::fs::create_dir_all(root.path().join("projects")).unwrap();
        let session_id = "60000000-0000-4000-8000-000000000003";
        let query = exact_query(session_id, None, MaterializationState::Allocated);

        let snapshot = lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query));
        let ExactRecoveryState::AllocatedUnmaterialized(owner) = state_for(&snapshot, &query)
        else {
            panic!("allocated zero-turn identity must remain launchable: {snapshot:?}");
        };
        assert_eq!(owner.provider, "claude");
        assert_eq!(owner.session_id, session_id);
        assert_eq!(owner.provider_scope, None);
    }

    #[test]
    fn claude_snapshot_partial_identity_is_retryable() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000004";
        let project = root.path().join("projects").join("-workspace-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{session_id}.jsonl")),
            format!("{{\"sessionId\":\"{session_id}"),
        )
        .unwrap();
        let query = exact_query(
            session_id,
            Some(Path::new("/workspace/project")),
            MaterializationState::Observed,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
        ));
    }

    #[test]
    fn claude_snapshot_empty_transcript_is_retryable() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000050";
        let project = root.path().join("projects").join("-workspace-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join(format!("{session_id}.jsonl")), b"").unwrap();
        let query = exact_query(
            session_id,
            Some(Path::new("/workspace/project")),
            MaterializationState::Observed,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
        ));
    }

    #[test]
    fn claude_snapshot_mismatched_existing_artifact_cannot_use_allocation_exception() {
        let root = temp_home();
        let requested = "60000000-0000-4000-8000-00000000004a";
        let other = "60000000-0000-4000-8000-00000000004b";
        let project = root.path().join("projects").join("-workspace-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{requested}.jsonl")),
            format!("{{\"sessionId\":\"{other}\",\"cwd\":\"/workspace/project\"}}\n"),
        )
        .unwrap();
        let query = exact_query(
            requested,
            Some(Path::new("/workspace/project")),
            MaterializationState::Allocated,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::Unproved)
                | ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
        ));
    }

    #[test]
    fn claude_snapshot_direct_mode_mismatch_is_invalid_before_store_io() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000005";
        let mut query = exact_query(session_id, None, MaterializationState::Observed);
        query.mode = DurableRecoveryProvider::Codex;

        let started = std::time::Instant::now();
        let snapshot = lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query));
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        assert!(matches!(
            state_for(&snapshot, &query),
            ExactRecoveryState::Invalid(ExactRecoveryIssue::ProviderModeMismatch)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_expected_cwd_direct_hit_ignores_unrelated_project_error() {
        use std::os::unix::fs::symlink;

        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000006";
        write_owned_transcript(
            root.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        symlink(
            root.path().join("missing-project"),
            root.path().join("projects").join("-unrelated"),
        )
        .unwrap();
        let query = exact_query(
            session_id,
            Some(Path::new("/workspace/project")),
            MaterializationState::Observed,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Present(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_expected_cwd_uses_claudes_non_alphanumeric_project_slug() {
        use std::os::unix::fs::symlink;

        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-00000000004c";
        write_owned_transcript(
            root.path(),
            "-workspace-my-project",
            session_id,
            "/workspace/my.project",
        );
        symlink(
            root.path().join("missing-project"),
            root.path().join("projects").join("-unrelated"),
        )
        .unwrap();
        let query = exact_query(
            session_id,
            Some(Path::new("/workspace/my.project")),
            MaterializationState::Observed,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Present(_)
        ));
    }

    #[test]
    fn claude_snapshot_long_project_slug_matches_node_writer_contract() {
        let cwd = format!("/{}", "a".repeat(210));
        let expected = format!("-{}-djaaup", "a".repeat(199));

        assert_eq!(claude_project_slug(Path::new(&cwd)), expected);
    }

    #[test]
    fn claude_snapshot_windows_realpath_and_nfc_slug_match_node_shape() {
        let writer_path = normalize_windows_writer_realpath("\\\\?\\C:\\Users\\Dan\\cafe\u{301}");
        assert_eq!(writer_path, "C:\\Users\\Dan\\cafe\u{301}");
        assert_eq!(
            claude_project_location_from_writer_cwd(&writer_path).exact,
            "C--Users-Dan-caf-"
        );
        assert_eq!(
            normalize_windows_writer_realpath("\\\\?\\UNC\\server\\share\\project"),
            "\\\\server\\share\\project"
        );
        assert_eq!(
            claude_project_location_from_writer_cwd("c:\\windows").exact,
            "c--windows",
            "Node preserves ordinary Windows component spelling and case"
        );
    }

    #[test]
    fn claude_snapshot_windows_writer_normalizes_parent_segments_before_reparse_walk() {
        assert_eq!(
            windows_writer_lexical_path(r"C:\base\link\..\sibling")
                .unwrap()
                .to_string_lossy(),
            r"C:\base\sibling",
            "Node path.win32.resolve removes `link\\..` before fs.realpathSync can follow link"
        );
        assert_eq!(
            windows_writer_lexical_path(r"C:\resolved-link-one\link-two\..\sibling")
                .unwrap()
                .to_string_lossy(),
            r"C:\resolved-link-one\sibling",
            "the same lexical normalization is required after each nested link substitution"
        );
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_long_project_slug_accepts_unique_bun_hash_variant() {
        use std::os::unix::fs::symlink;

        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-00000000004d";
        let cwd = format!("/{}", "a".repeat(210));
        let native_prefix = format!("-{}", "a".repeat(199));
        write_owned_transcript(
            root.path(),
            &format!("{native_prefix}-bunhash"),
            session_id,
            &cwd,
        );
        symlink(
            root.path().join("missing-project"),
            root.path().join("projects").join("-unrelated"),
        )
        .unwrap();
        let query = exact_query(
            session_id,
            Some(Path::new(&cwd)),
            MaterializationState::Observed,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Present(_)
        ));
    }

    #[test]
    fn claude_snapshot_distinct_node_and_bun_long_slug_artifacts_conflict() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-00000000004f";
        let cwd = format!("/{}", "a".repeat(210));
        let native_prefix = format!("-{}", "a".repeat(199));
        write_owned_transcript(
            root.path(),
            &format!("{native_prefix}-djaaup"),
            session_id,
            &cwd,
        );
        write_owned_transcript(
            root.path(),
            &format!("{native_prefix}-bunhash"),
            session_id,
            &cwd,
        );
        let query = exact_query(
            session_id,
            Some(Path::new(&cwd)),
            MaterializationState::Observed,
        );

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Conflict
        ));
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_no_cwd_incomplete_enumeration_is_retryable() {
        use std::os::unix::fs::symlink;

        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000007";
        std::fs::create_dir_all(root.path().join("projects")).unwrap();
        symlink(
            root.path().join("missing-project"),
            root.path().join("projects").join("-unreadable"),
        )
        .unwrap();
        let query = exact_query(session_id, None, MaterializationState::Observed);

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
                | ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactIncomplete)
        ));
    }

    #[test]
    fn claude_snapshot_changed_path_identity_during_same_handle_read_is_retryable() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000008";
        let path = write_owned_transcript(
            root.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        let replacement = format!("{{\"sessionId\":\"{session_id}\",\"cwd\":\"/other\"}}\n");

        let result = inspect_claude_transcript_with_hook(&path, session_id, || {
            std::fs::rename(&path, path.with_extension("old")).unwrap();
            std::fs::write(&path, &replacement).unwrap();
        });
        assert!(matches!(result, Err(ExactRecoveryIssue::ArtifactChanged)));
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_parent_replacement_after_read_is_retryable() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000051";
        let path = write_owned_transcript(
            root.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        let project = path.parent().unwrap().to_path_buf();
        let old_project = project.with_extension("old");
        let evidence = ClaudeRootEvidence::resolve(root.path()).unwrap();

        let result =
            inspect_claude_transcript_under_root_with_hook(&evidence, &path, session_id, || {
                std::fs::rename(&project, &old_project).unwrap();
                std::fs::create_dir_all(&project).unwrap();
                std::fs::write(
                    &path,
                    format!("{{\"sessionId\":\"{session_id}\",\"cwd\":\"/other\"}}\n"),
                )
                .unwrap();
            });

        assert!(matches!(result, Err(ExactRecoveryIssue::ArtifactChanged)));
    }

    #[cfg(windows)]
    #[test]
    fn claude_snapshot_open_handle_blocks_parent_replacement_on_windows() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000051";
        let path = write_owned_transcript(
            root.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        let project = path.parent().unwrap().to_path_buf();
        let old_project = project.with_extension("old");
        let evidence = ClaudeRootEvidence::resolve(root.path()).unwrap();
        let mut rename_error = None;

        let result =
            inspect_claude_transcript_under_root_with_hook(&evidence, &path, session_id, || {
                rename_error = Some(std::fs::rename(&project, &old_project).unwrap_err());
            });

        assert_eq!(
            rename_error.unwrap().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(matches!(result, Ok(Some(_))));
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_fingerprint_is_stable_when_transcript_normally_grows() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-00000000004e";
        let path = write_owned_transcript(
            root.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        let query = exact_query(
            session_id,
            Some(Path::new("/workspace/project")),
            MaterializationState::Observed,
        );
        let fingerprint = |snapshot: &ExactRecoveryProviderSnapshot| {
            let ExactRecoveryState::Present(proof) = state_for(snapshot, &query) else {
                panic!("expected present proof: {snapshot:?}");
            };
            proof.artifact_fingerprint.clone()
        };
        let before = fingerprint(&lookup_claude_exact_many_in_root(
            root.path(),
            std::slice::from_ref(&query),
        ));
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new().append(true).open(path).unwrap(),
            "{{\"type\":\"assistant\",\"sessionId\":\"{session_id}\"}}"
        )
        .unwrap();
        let after = fingerprint(&lookup_claude_exact_many_in_root(
            root.path(),
            std::slice::from_ref(&query),
        ));

        assert_eq!(before, after);
    }

    #[test]
    fn claude_snapshot_only_child_effective_root_is_consulted() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.blocking_lock();
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "HOME"]);
        let winner = temp_home();
        let ignored = temp_home();
        let session_id = "60000000-0000-4000-8000-000000000009";
        std::fs::create_dir_all(winner.path().join("projects")).unwrap();
        write_owned_transcript(
            ignored.path(),
            "-workspace-project",
            session_id,
            "/workspace/project",
        );
        std::env::set_var("CLAUDE_CONFIG_DIR", winner.path());
        std::env::set_var("CLAUDE_HOME", ignored.path());
        let query = exact_query(session_id, None, MaterializationState::Observed);

        assert_eq!(effective_claude_home().as_deref(), Some(winner.path()));
        assert!(matches!(
            state_for(
                &lookup_claude_exact_many(std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactMissing)
        ));
    }

    #[test]
    fn claude_snapshot_relative_root_without_query_cwd_fails_closed() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.blocking_lock();
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "HOME"]);
        std::env::set_var("CLAUDE_CONFIG_DIR", "relative/claude");
        assert!(resolve_effective_claude_home_for_cwd(None).is_err());
        assert_eq!(effective_claude_home(), None);

        std::env::remove_var("CLAUDE_CONFIG_DIR");
        std::env::set_var("CLAUDE_HOME", "");
        assert!(resolve_effective_claude_home_for_cwd(None).is_err());
        assert_eq!(effective_claude_home(), None);
    }

    #[test]
    fn claude_snapshot_empty_and_relative_roots_follow_each_exact_query_cwd() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.blocking_lock();
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "HOME"]);
        let tree = temp_home();
        let first_cwd = tree.path().join("one/project");
        let second_cwd = tree.path().join("two/project");
        std::fs::create_dir_all(&first_cwd).unwrap();
        std::fs::create_dir_all(&second_cwd).unwrap();
        let first_id = "60000000-0000-4000-8000-000000000052";
        let second_id = "60000000-0000-4000-8000-000000000053";
        std::env::set_var("CLAUDE_CONFIG_DIR", "../claude");
        std::env::set_var("CLAUDE_HOME", "/ignored/compat");
        let first_root = first_cwd.parent().unwrap().join("claude");
        let second_root = second_cwd.parent().unwrap().join("claude");
        write_owned_transcript(
            &first_root,
            &claude_project_slug(&first_cwd),
            first_id,
            first_cwd.to_str().unwrap(),
        );
        write_owned_transcript(
            &second_root,
            &claude_project_slug(&second_cwd),
            second_id,
            second_cwd.to_str().unwrap(),
        );
        let first = exact_query(first_id, Some(&first_cwd), MaterializationState::Observed);
        let second = exact_query(second_id, Some(&second_cwd), MaterializationState::Observed);
        let snapshot = lookup_claude_exact_many(&[first.clone(), second.clone()]);

        assert!(matches!(
            state_for(&snapshot, &first),
            ExactRecoveryState::Present(_)
        ));
        assert!(matches!(
            state_for(&snapshot, &second),
            ExactRecoveryState::Present(_)
        ));

        std::env::set_var("CLAUDE_CONFIG_DIR", "");
        let empty_id = "60000000-0000-4000-8000-000000000054";
        write_owned_transcript(
            &first_cwd,
            &claude_project_slug(&first_cwd),
            empty_id,
            first_cwd.to_str().unwrap(),
        );
        let empty = exact_query(empty_id, Some(&first_cwd), MaterializationState::Observed);
        assert!(matches!(
            state_for(
                &lookup_claude_exact_many(std::slice::from_ref(&empty)),
                &empty
            ),
            ExactRecoveryState::Present(_)
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn claude_snapshot_selected_root_is_nfc_normalized() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.blocking_lock();
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "HOME"]);
        std::env::set_var("CLAUDE_CONFIG_DIR", "/tmp/cafe\u{301}");

        assert_eq!(
            resolve_effective_claude_home_for_cwd(None).unwrap(),
            Some(PathBuf::from("/tmp/caf\u{e9}"))
        );
    }

    #[test]
    fn claude_snapshot_windows_rooted_and_drive_relative_roots_fail_closed() {
        for selected in [r"\store", r"C:store", "C:"] {
            assert!(
                normalize_selected_claude_root_windows(selected, Some(r"C:\panes\work")).is_err(),
                "{selected:?} must not depend on hidden per-drive cwd state"
            );
        }
        assert_eq!(
            normalize_selected_claude_root_windows("", Some(r"C:\panes\work")).unwrap(),
            r"C:\panes\work"
        );
        assert_eq!(
            normalize_selected_claude_root_windows(
                r"..\stores\claude",
                Some(r"C:\panes\work")
            )
            .unwrap(),
            r"C:\panes\stores\claude"
        );
        assert_eq!(
            normalize_selected_claude_root_windows(
                "C:\\stores\\cafe\u{301}",
                Some(r"C:\panes\work")
            )
            .unwrap(),
            "C:\\stores\\caf\u{e9}"
        );
    }

    #[test]
    fn claude_snapshot_distinct_owned_main_artifacts_conflict_without_cwd() {
        let root = temp_home();
        let session_id = "60000000-0000-4000-8000-00000000000a";
        write_owned_transcript(root.path(), "-project-one", session_id, "/project/one");
        write_owned_transcript(root.path(), "-project-two", session_id, "/project/two");
        let query = exact_query(session_id, None, MaterializationState::Observed);

        assert!(matches!(
            state_for(
                &lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query)),
                &query
            ),
            ExactRecoveryState::Conflict
        ));
    }

    #[test]
    fn claude_snapshot_batch_builds_one_bounded_project_index() {
        let root = temp_home();
        let first_id = "60000000-0000-4000-8000-000000000055";
        let second_id = "60000000-0000-4000-8000-000000000056";
        write_owned_transcript(root.path(), "-project-one", first_id, "/project/one");
        write_owned_transcript(root.path(), "-project-two", second_id, "/project/two");
        let first = exact_query(first_id, None, MaterializationState::Observed);
        let second = exact_query(second_id, None, MaterializationState::Observed);
        let mut scans = 0usize;

        let snapshot = lookup_claude_exact_many_in_root_with_project_scan_hook(
            root.path(),
            &[first.clone(), second.clone()],
            || scans += 1,
        );

        assert_eq!(scans, 1, "one batch must enumerate projects only once");
        assert!(matches!(
            state_for(&snapshot, &first),
            ExactRecoveryState::Present(_)
        ));
        assert!(matches!(
            state_for(&snapshot, &second),
            ExactRecoveryState::Present(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn claude_snapshot_fifo_socket_symlink_and_device_return_promptly() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        let root = temp_home();
        let project = root.path().join("projects").join("-workspace-project");
        std::fs::create_dir_all(&project).unwrap();
        let ids = [
            "60000000-0000-4000-8000-00000000000b",
            "60000000-0000-4000-8000-00000000000c",
            "60000000-0000-4000-8000-00000000000d",
        ];
        let fifo = project.join(format!("{}.jsonl", ids[0]));
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        let socket = project.join(format!("{}.jsonl", ids[1]));
        let _listener = UnixListener::bind(&socket).unwrap();
        let symlink_path = project.join(format!("{}.jsonl", ids[2]));
        symlink("/dev/null", &symlink_path).unwrap();

        for session_id in ids {
            let query = exact_query(
                session_id,
                Some(Path::new("/workspace/project")),
                MaterializationState::Observed,
            );
            let started = std::time::Instant::now();
            let snapshot =
                lookup_claude_exact_many_in_root(root.path(), std::slice::from_ref(&query));
            assert!(
                started.elapsed() < std::time::Duration::from_millis(250),
                "non-regular transcript candidate must not block"
            );
            assert!(matches!(
                state_for(&snapshot, &query),
                ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed)
            ));
        }

        let started = std::time::Instant::now();
        assert!(matches!(
            inspect_claude_transcript(Path::new("/dev/null"), ids[0]),
            Err(ExactRecoveryIssue::StoreReadFailed)
        ));
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
    }
}

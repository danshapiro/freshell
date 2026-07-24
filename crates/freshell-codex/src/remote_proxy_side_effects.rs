//! codex remote-proxy **side-effect extraction** — pure, no-IO functions that pull thread
//! candidates, turn/lifecycle events, and repair triggers out of relayed JSON-RPC frames,
//! plus the two fork-request/response rewrite helpers. A faithful port of
//! `server/coding-cli/codex-app-server/json-rpc-side-effects.ts`.
//!
//! DEV-0006 Slice 1 (`docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` §5):
//! these are the extractors the Slice-2 remote proxy calls once
//! [`crate::remote_proxy_envelope::scan_json_rpc_envelope`] has told it a frame's method
//! warrants a closer look. NOT wired into the proxy/server yet — pure library code only.
//!
//! Output shapes mirror `CodexRemoteProxyCandidate` (`remote-proxy.ts:29-34`, the
//! `fs_changed` arm of `CodexRemoteProxyRepairTrigger`, `remote-proxy.ts:36-38`); the
//! `proxy_close` / `proxy_error` / `candidate_capture_timeout` repair-trigger variants are
//! proxy-lifecycle concerns (Slice 2), not something these pure extractors ever produce.

use std::path::Path;

use crate::json_scan::{
    self, decode_string_entry, find_entry, has_any_duplicate_key, has_duplicate_key,
    literal_equals, scan_object, ObjectEntry, ScanError, ScannedObject, ValueKind, BYTE_OPEN_BRACE,
    BYTE_OPEN_BRACKET,
};
use crate::remote_proxy_envelope::MAX_SCANNED_TOKEN_BYTES;

const MAX_SMALL_PARSE_BYTES: usize = 16 * 1024;
const MAX_FS_CHANGED_PATHS_BYTES: usize = 16 * 1024;
const TURN_STATUSES: &[&str] = &["completed", "interrupted", "failed", "inProgress"];

/// Why a side-effect extractor rejected a frame (`SideEffectFailureReason`,
/// `json-rpc-side-effects.ts:111-125`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SideEffectError {
    BatchUnsupported,
    EphemeralThread,
    IdNotPendingFork,
    IdNotPendingThreadStart,
    MalformedJson,
    MissingParentThreadId,
    MissingRolloutPath,
    MissingThread,
    PathAliasConflict,
    RelativeRolloutPath,
    SameAsParent,
    TokenTooLarge,
    UnsafeDuplicateKey,
    UnsupportedShape,
}

impl From<ScanError> for SideEffectError {
    fn from(error: ScanError) -> Self {
        match error {
            ScanError::MalformedJson => Self::MalformedJson,
            ScanError::TokenTooLarge => Self::TokenTooLarge,
        }
    }
}

type SideEffectResult<T> = Result<T, SideEffectError>;

/// A thread handle as captured off the wire (`CandidateThread`,
/// `json-rpc-side-effects.ts:22-26`).
#[derive(Clone, Debug, PartialEq)]
pub struct CandidateThread {
    pub id: String,
    pub path: Option<String>,
    pub ephemeral: bool,
}

/// Where a [`CandidateThread`] was captured from (`CodexRemoteProxyCandidate['source']`,
/// `remote-proxy.ts:33`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateSource {
    ThreadStartResponse,
    ThreadStartedNotification,
    ThreadForkResponse,
}

/// A captured thread candidate (`CodexRemoteProxyCandidate`, `remote-proxy.ts:31-34`).
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteProxyCandidate {
    pub source: CandidateSource,
    pub thread: CandidateThread,
}

/// A thread lifecycle side effect (`ThreadLifecycleEventExtractionResult['event']`,
/// `json-rpc-side-effects.ts:84-98`).
#[derive(Clone, Debug, PartialEq)]
pub enum ThreadLifecycleEvent {
    ThreadClosed {
        thread_id: String,
    },
    ThreadStatusChanged {
        thread_id: String,
        /// Always contains at least a non-empty `"type"` entry; additional passthrough
        /// keys are preserved only when the whole `status` object parses within
        /// [`MAX_SMALL_PARSE_BYTES`] (mirrors `extractThreadStatus`,
        /// `json-rpc-side-effects.ts:675-697`).
        status: serde_json::Map<String, serde_json::Value>,
    },
}

/// A turn lifecycle side effect (`TurnNotificationEventExtractionResult['event']`,
/// `json-rpc-side-effects.ts:66-82`).
#[derive(Clone, Debug, PartialEq)]
pub enum TurnEvent {
    Started {
        thread_id: String,
        turn_id: Option<String>,
    },
    Completed {
        thread_id: String,
        turn_id: Option<String>,
        status: Option<String>,
    },
}

/// The `fs/changed` repair trigger (`FsChangedRepairTriggerExtractionResult['trigger']`,
/// `json-rpc-side-effects.ts:100-109`).
#[derive(Clone, Debug, PartialEq)]
pub struct FsChangedRepairTrigger {
    pub watch_id: String,
    pub changed_paths: Vec<String>,
}

/// Pending-request-id options for [`extract_thread_start_response_candidate`], mirroring
/// `pendingThreadStartRequestIds` (`json-rpc-side-effects.ts:280`).
pub struct ThreadStartResponseOptions<'a> {
    pub pending_thread_start_request_ids: &'a std::collections::HashSet<crate::protocol::RequestId>,
}

/// Pending-request-id / parent-attribution options for [`extract_fork_response_candidate`],
/// mirroring `ForkResponseCandidateExtractionResult`'s options
/// (`json-rpc-side-effects.ts:308-314`).
pub struct ForkResponseOptions<'a> {
    pub parent_thread_id: Option<&'a str>,
    pub pending_fork_request_ids: &'a std::collections::HashSet<crate::protocol::RequestId>,
}

// ── shared frame scaffolding ─────────────────────────────────────────────────────────

/// `scanRootObject` (`json-rpc-side-effects.ts:711-721`): unlike the envelope scanner,
/// a non-object/non-array root is `unsupported_shape` here, not `non_object_root` — the
/// two files intentionally use different reason vocabularies for the same situation.
fn scan_root_object(raw: &[u8]) -> SideEffectResult<ScannedObject> {
    let start = json_scan::skip_whitespace(raw, 0);
    if start >= raw.len() {
        return Err(SideEffectError::MalformedJson);
    }
    if raw[start] == BYTE_OPEN_BRACKET {
        return Err(SideEffectError::BatchUnsupported);
    }
    if raw[start] != BYTE_OPEN_BRACE {
        return Err(SideEffectError::UnsupportedShape);
    }
    let object = scan_object(raw, start, MAX_SCANNED_TOKEN_BYTES)?;
    let trailing = json_scan::skip_whitespace(raw, object.end);
    if trailing != raw.len() {
        return Err(SideEffectError::MalformedJson);
    }
    Ok(object)
}

fn extract_method(raw: &[u8], entries: &[ObjectEntry]) -> SideEffectResult<String> {
    let entry = find_entry(entries, "method").ok_or(SideEffectError::UnsupportedShape)?;
    if entry.value_kind != ValueKind::String {
        return Err(SideEffectError::UnsupportedShape);
    }
    let value = decode_string_entry(raw, entry).map_err(|_| SideEffectError::UnsupportedShape)?;
    if value.is_empty() {
        return Err(SideEffectError::UnsupportedShape);
    }
    Ok(value)
}

fn extract_params_object(raw: &[u8], entries: &[ObjectEntry]) -> SideEffectResult<ScannedObject> {
    let params = find_entry(entries, "params").ok_or(SideEffectError::UnsupportedShape)?;
    if params.value_kind != ValueKind::Object {
        return Err(SideEffectError::UnsupportedShape);
    }
    Ok(scan_object(
        raw,
        params.value_start,
        MAX_SCANNED_TOKEN_BYTES,
    )?)
}

fn extract_required_string(
    raw: &[u8],
    entries: &[ObjectEntry],
    key: &str,
) -> SideEffectResult<String> {
    match extract_optional_string(raw, entries, key)? {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(SideEffectError::UnsupportedShape),
    }
}

fn extract_optional_string(
    raw: &[u8],
    entries: &[ObjectEntry],
    key: &str,
) -> SideEffectResult<Option<String>> {
    let Some(entry) = find_entry(entries, key) else {
        return Ok(None);
    };
    if entry.value_kind != ValueKind::String {
        return Err(SideEffectError::UnsupportedShape);
    }
    Ok(Some(
        decode_string_entry(raw, entry).map_err(|_| SideEffectError::UnsupportedShape)?,
    ))
}

fn extract_nullable_string(
    raw: &[u8],
    entries: &[ObjectEntry],
    key: &str,
) -> SideEffectResult<Option<String>> {
    let Some(entry) = find_entry(entries, key) else {
        return Ok(None);
    };
    if entry.value_kind == ValueKind::String {
        return Ok(Some(
            decode_string_entry(raw, entry).map_err(|_| SideEffectError::UnsupportedShape)?,
        ));
    }
    if literal_equals(raw, entry, b"null") {
        return Ok(None);
    }
    Err(SideEffectError::UnsupportedShape)
}

fn extract_optional_boolean(
    raw: &[u8],
    entries: &[ObjectEntry],
    key: &str,
) -> SideEffectResult<Option<bool>> {
    let Some(entry) = find_entry(entries, key) else {
        return Ok(None);
    };
    if literal_equals(raw, entry, b"true") {
        return Ok(Some(true));
    }
    if literal_equals(raw, entry, b"false") {
        return Ok(Some(false));
    }
    Err(SideEffectError::UnsupportedShape)
}

fn parse_small_json_value(raw: &[u8], entry: &ObjectEntry) -> SideEffectResult<serde_json::Value> {
    if entry.value_end - entry.value_start > MAX_SMALL_PARSE_BYTES {
        return Err(SideEffectError::TokenTooLarge);
    }
    serde_json::from_slice(&raw[entry.value_start..entry.value_end])
        .map_err(|_| SideEffectError::MalformedJson)
}

/// A JSON-RPC top-level `id` restricted to the shapes our OWN client ever mints
/// (`RequestId`) — used to match a frame's `id` against a pending-request-id set. This is
/// a narrower, precision-focused sibling of
/// [`crate::remote_proxy_envelope::JsonRpcEnvelopeId`] (see that type's docs): a numeric
/// token outside the `i64` range can never equal an id WE minted, so it is rejected as
/// `unsupported_shape` here rather than represented losslessly as `f64` — the two TS
/// files never share this logic either (`extractTopLevelId`, `json-rpc-side-effects.ts:606-621`,
/// is independent of envelope.ts's `scanTopLevelId`).
fn extract_top_level_id(
    raw: &[u8],
    entries: &[ObjectEntry],
) -> SideEffectResult<crate::protocol::RequestId> {
    let entry = find_entry(entries, "id").ok_or(SideEffectError::UnsupportedShape)?;
    match entry.value_kind {
        ValueKind::String => {
            let value =
                decode_string_entry(raw, entry).map_err(|_| SideEffectError::UnsupportedShape)?;
            if value.is_empty() {
                return Err(SideEffectError::UnsupportedShape);
            }
            Ok(crate::protocol::RequestId::Str(value))
        }
        ValueKind::Number => {
            let token = std::str::from_utf8(&raw[entry.value_start..entry.value_end])
                .map_err(|_| SideEffectError::UnsupportedShape)?;
            if token.contains('.') || token.contains('e') || token.contains('E') {
                return Err(SideEffectError::UnsupportedShape);
            }
            let value: i64 = token
                .parse()
                .map_err(|_| SideEffectError::UnsupportedShape)?;
            Ok(crate::protocol::RequestId::Int(value))
        }
        _ => Err(SideEffectError::UnsupportedShape),
    }
}

// ── thread extraction ────────────────────────────────────────────────────────────────

struct ExtractedThread {
    thread: CandidateThread,
    rollout_path_alias: Option<String>,
    rollout_path_snake_alias: Option<String>,
}

fn extract_thread(raw: &[u8], thread_entry: &ObjectEntry) -> SideEffectResult<ExtractedThread> {
    if thread_entry.value_kind != ValueKind::Object {
        return Err(SideEffectError::MissingThread);
    }
    let thread_object = scan_object(raw, thread_entry.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_any_duplicate_key(
        &thread_object.entries,
        &["id", "path", "ephemeral", "rolloutPath", "rollout_path"],
    ) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let id = extract_required_string(raw, &thread_object.entries, "id")
        .map_err(|_| SideEffectError::MissingThread)?;
    let path = extract_nullable_string(raw, &thread_object.entries, "path")?;
    let ephemeral =
        extract_optional_boolean(raw, &thread_object.entries, "ephemeral")?.unwrap_or(false);
    let rollout_path_alias = extract_optional_string(raw, &thread_object.entries, "rolloutPath")?;
    let rollout_path_snake_alias =
        extract_optional_string(raw, &thread_object.entries, "rollout_path")?;

    Ok(ExtractedThread {
        thread: CandidateThread {
            id,
            path,
            ephemeral,
        },
        rollout_path_alias,
        rollout_path_snake_alias,
    })
}

fn extract_result_thread(
    raw: &[u8],
    root_entries: &[ObjectEntry],
) -> SideEffectResult<ExtractedThread> {
    let result = find_entry(root_entries, "result").ok_or(SideEffectError::MissingThread)?;
    if result.value_kind != ValueKind::Object {
        return Err(SideEffectError::MissingThread);
    }
    let result_object = scan_object(raw, result.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_any_duplicate_key(&result_object.entries, &["thread"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let thread =
        find_entry(&result_object.entries, "thread").ok_or(SideEffectError::MissingThread)?;
    extract_thread(raw, thread)
}

// ── extractThreadStartResponseCandidate (json-rpc-side-effects.ts:277-306) ───────────

/// Extract a `thread/start` response candidate. The response's top-level `id` must be one
/// of `options.pending_thread_start_request_ids`.
pub fn extract_thread_start_response_candidate(
    raw: &[u8],
    options: &ThreadStartResponseOptions<'_>,
) -> SideEffectResult<RemoteProxyCandidate> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["id", "result"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let id = extract_top_level_id(raw, &root.entries)?;
    if !options.pending_thread_start_request_ids.contains(&id) {
        return Err(SideEffectError::IdNotPendingThreadStart);
    }

    let extracted = extract_result_thread(raw, &root.entries)?;
    Ok(RemoteProxyCandidate {
        source: CandidateSource::ThreadStartResponse,
        thread: extracted.thread,
    })
}

// ── extractForkResponseCandidate (json-rpc-side-effects.ts:308-358) ──────────────────

/// Extract a `thread/fork` response candidate, validating the forked thread is non-
/// ephemeral, has an absolute rollout path distinct from the parent, and that any
/// `rolloutPath`/`rollout_path` alias agrees with `path`.
pub fn extract_fork_response_candidate(
    raw: &[u8],
    options: &ForkResponseOptions<'_>,
) -> SideEffectResult<RemoteProxyCandidate> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["id", "result"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let id = extract_top_level_id(raw, &root.entries)?;
    if !options.pending_fork_request_ids.contains(&id) {
        return Err(SideEffectError::IdNotPendingFork);
    }
    let parent_thread_id = match options.parent_thread_id {
        Some(value) if !value.is_empty() => value,
        _ => return Err(SideEffectError::MissingParentThreadId),
    };

    let extracted = extract_result_thread(raw, &root.entries)?;
    if extracted.thread.id == parent_thread_id {
        return Err(SideEffectError::SameAsParent);
    }
    if extracted.thread.ephemeral {
        return Err(SideEffectError::EphemeralThread);
    }
    let path = match &extracted.thread.path {
        Some(path) if !path.is_empty() => path.clone(),
        _ => return Err(SideEffectError::MissingRolloutPath),
    };
    if !Path::new(&path).is_absolute() {
        return Err(SideEffectError::RelativeRolloutPath);
    }
    for alias in [
        extracted.rollout_path_alias.as_ref(),
        extracted.rollout_path_snake_alias.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if alias != &path {
            return Err(SideEffectError::PathAliasConflict);
        }
    }

    Ok(RemoteProxyCandidate {
        source: CandidateSource::ThreadForkResponse,
        thread: CandidateThread {
            id: extracted.thread.id,
            path: Some(path),
            ephemeral: extracted.thread.ephemeral,
        },
    })
}

// ── extractThreadStartedNotificationSideEffects (json-rpc-side-effects.ts:360-396) ───

/// The `lifecycle: { kind: 'thread_started', thread }` side effect of a `thread/started`
/// notification (`json-rpc-side-effects.ts:391-394`) — carries the FULL thread handle,
/// unlike [`ThreadLifecycleEvent`]'s `thread_closed`/`thread_status_changed` variants
/// (which only carry a `threadId`), so it gets its own type rather than overloading that
/// enum with a variant of a different shape.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadStartedLifecycle {
    pub thread: CandidateThread,
}

/// The candidate + lifecycle side effects of a `thread/started` notification.
pub struct ThreadStartedNotificationSideEffects {
    pub candidate: RemoteProxyCandidate,
    pub lifecycle: ThreadStartedLifecycle,
}

pub fn extract_thread_started_notification_side_effects(
    raw: &[u8],
) -> SideEffectResult<ThreadStartedNotificationSideEffects> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["method", "params"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let method = extract_method(raw, &root.entries)?;
    if method != "thread/started" {
        return Err(SideEffectError::UnsupportedShape);
    }

    let params = find_entry(&root.entries, "params").ok_or(SideEffectError::UnsupportedShape)?;
    if params.value_kind != ValueKind::Object {
        return Err(SideEffectError::UnsupportedShape);
    }
    let params_object = scan_object(raw, params.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_any_duplicate_key(&params_object.entries, &["thread"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let thread_entry =
        find_entry(&params_object.entries, "thread").ok_or(SideEffectError::MissingThread)?;
    if thread_entry.value_kind != ValueKind::Object {
        return Err(SideEffectError::MissingThread);
    }
    let extracted = extract_thread(raw, thread_entry)?;

    Ok(ThreadStartedNotificationSideEffects {
        candidate: RemoteProxyCandidate {
            source: CandidateSource::ThreadStartedNotification,
            thread: extracted.thread.clone(),
        },
        lifecycle: ThreadStartedLifecycle {
            thread: extracted.thread,
        },
    })
}

// ── extractTurnNotificationEvent (json-rpc-side-effects.ts:398-445) ──────────────────

pub fn extract_turn_notification_event(raw: &[u8]) -> SideEffectResult<TurnEvent> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["method", "params"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let method = extract_method(raw, &root.entries)?;
    if method != "turn/started" && method != "turn/completed" {
        return Err(SideEffectError::UnsupportedShape);
    }

    let params_object = extract_params_object(raw, &root.entries)?;
    if has_any_duplicate_key(
        &params_object.entries,
        &["threadId", "turnId", "turn", "status"],
    ) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let thread_id = extract_required_string(raw, &params_object.entries, "threadId")?;
    let turn_id = extract_optional_string(raw, &params_object.entries, "turnId")?;

    if method == "turn/started" {
        return Ok(TurnEvent::Started { thread_id, turn_id });
    }

    let status = extract_turn_completed_status(raw, &params_object.entries)?;
    Ok(TurnEvent::Completed {
        thread_id,
        turn_id,
        status,
    })
}

fn extract_turn_completed_status(
    raw: &[u8],
    params_entries: &[ObjectEntry],
) -> SideEffectResult<Option<String>> {
    if let Some(turn) = find_entry(params_entries, "turn") {
        if turn.value_kind != ValueKind::Object {
            return Err(SideEffectError::UnsupportedShape);
        }
        let turn_object = scan_object(raw, turn.value_start, MAX_SCANNED_TOKEN_BYTES)?;
        if has_any_duplicate_key(&turn_object.entries, &["status"]) {
            return Err(SideEffectError::UnsafeDuplicateKey);
        }
        if let Some(status) = extract_optional_string(raw, &turn_object.entries, "status")? {
            return validate_turn_status(status).map(Some);
        }
    }
    match extract_optional_string(raw, params_entries, "status")? {
        Some(status) => validate_turn_status(status).map(Some),
        None => Ok(None),
    }
}

fn validate_turn_status(status: String) -> SideEffectResult<String> {
    if TURN_STATUSES.contains(&status.as_str()) {
        Ok(status)
    } else {
        Err(SideEffectError::UnsupportedShape)
    }
}

// ── extractThreadLifecycleEvent (json-rpc-side-effects.ts:447-489) ───────────────────

pub fn extract_thread_lifecycle_event(raw: &[u8]) -> SideEffectResult<ThreadLifecycleEvent> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["method", "params"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let method = extract_method(raw, &root.entries)?;
    if method != "thread/closed" && method != "thread/status/changed" {
        return Err(SideEffectError::UnsupportedShape);
    }

    let params_object = extract_params_object(raw, &root.entries)?;
    if has_any_duplicate_key(&params_object.entries, &["threadId", "status"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let thread_id = extract_required_string(raw, &params_object.entries, "threadId")?;

    if method == "thread/closed" {
        return Ok(ThreadLifecycleEvent::ThreadClosed { thread_id });
    }

    let status = extract_thread_status(raw, &params_object.entries)?;
    Ok(ThreadLifecycleEvent::ThreadStatusChanged { thread_id, status })
}

fn extract_thread_status(
    raw: &[u8],
    params_entries: &[ObjectEntry],
) -> SideEffectResult<serde_json::Map<String, serde_json::Value>> {
    let status = find_entry(params_entries, "status").ok_or(SideEffectError::UnsupportedShape)?;
    if status.value_kind != ValueKind::Object {
        return Err(SideEffectError::UnsupportedShape);
    }
    let status_object = scan_object(raw, status.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_any_duplicate_key(&status_object.entries, &["type"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let ty = extract_required_string(raw, &status_object.entries, "type")?;

    if status.value_end - status.value_start <= MAX_SMALL_PARSE_BYTES {
        if let Ok(serde_json::Value::Object(map)) = parse_small_json_value(raw, status) {
            if map.get("type").and_then(|v| v.as_str()).is_some() {
                return Ok(map);
            }
        }
    }

    let mut fallback = serde_json::Map::new();
    fallback.insert("type".to_string(), serde_json::Value::String(ty));
    Ok(fallback)
}

// ── extractFsChangedRepairTrigger (json-rpc-side-effects.ts:491-538) ─────────────────

pub fn extract_fs_changed_repair_trigger(raw: &[u8]) -> SideEffectResult<FsChangedRepairTrigger> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["method", "params"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let method = extract_method(raw, &root.entries)?;
    if method != "fs/changed" {
        return Err(SideEffectError::UnsupportedShape);
    }

    let params_object = extract_params_object(raw, &root.entries)?;
    if has_any_duplicate_key(&params_object.entries, &["watchId", "changedPaths"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let watch_id = extract_required_string(raw, &params_object.entries, "watchId")?;

    let changed_paths_entry = find_entry(&params_object.entries, "changedPaths")
        .ok_or(SideEffectError::UnsupportedShape)?;
    if changed_paths_entry.value_kind != ValueKind::Array {
        return Err(SideEffectError::UnsupportedShape);
    }
    if changed_paths_entry.value_end - changed_paths_entry.value_start > MAX_FS_CHANGED_PATHS_BYTES
    {
        return Ok(FsChangedRepairTrigger {
            watch_id,
            changed_paths: Vec::new(),
        });
    }

    let parsed = parse_small_json_value(raw, changed_paths_entry)
        .map_err(|_| SideEffectError::UnsupportedShape)?;
    let serde_json::Value::Array(items) = parsed else {
        return Err(SideEffectError::UnsupportedShape);
    };
    let mut changed_paths = Vec::with_capacity(items.len());
    for item in items {
        match item {
            serde_json::Value::String(s) => changed_paths.push(s),
            _ => return Err(SideEffectError::UnsupportedShape),
        }
    }

    Ok(FsChangedRepairTrigger {
        watch_id,
        changed_paths,
    })
}

// ── rewriteThreadForkRequestExcludeTurns (json-rpc-side-effects.ts:193-242) ──────────

/// Rewrite a `thread/fork` REQUEST so `params.excludeTurns` is forced to `true` — the TUI
/// asks the app-server to omit full turn history from fork responses (`normalizeThreadForkResponseForTui`
/// undoes the omission for the TUI-facing copy). Byte-splices the raw frame rather than
/// re-serializing the whole thing (mirrors the reference's zero-full-JSON.stringify
/// approach, ported test: `json-rpc-side-effects.test.ts:151-179`).
pub fn rewrite_thread_fork_request_exclude_turns(raw: &[u8]) -> SideEffectResult<Vec<u8>> {
    let root = scan_root_object(raw)?;
    if has_duplicate_key(&root.entries, "params") {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let Some(params) = find_entry(&root.entries, "params") else {
        let prefix = if root.entries.is_empty() { "" } else { "," };
        return Ok(splice(
            raw,
            root.close_index,
            root.close_index,
            &format!("{prefix}\"params\":{{\"excludeTurns\":true}}"),
        ));
    };

    if params.value_kind != ValueKind::Object {
        return Err(SideEffectError::UnsupportedShape);
    }
    let params_object = scan_object(raw, params.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_duplicate_key(&params_object.entries, "excludeTurns") {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    let Some(exclude_turns) = find_entry(&params_object.entries, "excludeTurns") else {
        let prefix = if params_object.entries.is_empty() {
            ""
        } else {
            ","
        };
        return Ok(splice(
            raw,
            params_object.close_index,
            params_object.close_index,
            &format!("{prefix}\"excludeTurns\":true"),
        ));
    };

    if literal_equals(raw, exclude_turns, b"true") {
        return Ok(raw.to_vec());
    }
    if !literal_equals(raw, exclude_turns, b"false") && !literal_equals(raw, exclude_turns, b"null")
    {
        return Err(SideEffectError::UnsupportedShape);
    }

    Ok(splice(
        raw,
        exclude_turns.value_start,
        exclude_turns.value_end,
        "true",
    ))
}

// ── normalizeThreadForkResponseForTui (json-rpc-side-effects.ts:244-275) ─────────────

/// Ensure a `thread/fork` RESPONSE's `result.thread.turns` array is present (defaulting to
/// `[]`) before forwarding to the TUI, which expects the field even when the app-server
/// omitted it (the excludeTurns request rewrite above is what causes the omission).
pub fn normalize_thread_fork_response_for_tui(raw: &[u8]) -> SideEffectResult<Vec<u8>> {
    let root = scan_root_object(raw)?;
    if has_any_duplicate_key(&root.entries, &["result"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let result = find_entry(&root.entries, "result").ok_or(SideEffectError::UnsupportedShape)?;
    if result.value_kind != ValueKind::Object {
        return Err(SideEffectError::UnsupportedShape);
    }
    let result_object = scan_object(raw, result.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_any_duplicate_key(&result_object.entries, &["thread"]) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }
    let thread =
        find_entry(&result_object.entries, "thread").ok_or(SideEffectError::MissingThread)?;
    if thread.value_kind != ValueKind::Object {
        return Err(SideEffectError::MissingThread);
    }
    let thread_object = scan_object(raw, thread.value_start, MAX_SCANNED_TOKEN_BYTES)?;
    if has_any_duplicate_key(
        &thread_object.entries,
        &["id", "path", "ephemeral", "turns"],
    ) {
        return Err(SideEffectError::UnsafeDuplicateKey);
    }

    if let Some(turns) = find_entry(&thread_object.entries, "turns") {
        if turns.value_kind != ValueKind::Array {
            return Err(SideEffectError::UnsupportedShape);
        }
        return Ok(raw.to_vec());
    }

    let prefix = if thread_object.entries.is_empty() {
        ""
    } else {
        ","
    };
    Ok(splice(
        raw,
        thread_object.close_index,
        thread_object.close_index,
        &format!("{prefix}\"turns\":[]"),
    ))
}

fn splice(raw: &[u8], start: usize, end: usize, replacement: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() - (end - start) + replacement.len());
    out.extend_from_slice(&raw[..start]);
    out.extend_from_slice(replacement.as_bytes());
    out.extend_from_slice(&raw[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RequestId;
    use serde_json::json;
    use std::collections::HashSet;

    fn parse_rewritten(input: &[u8]) -> serde_json::Value {
        let rewritten =
            rewrite_thread_fork_request_exclude_turns(input).expect("expected rewrite to succeed");
        serde_json::from_slice(&rewritten).expect("rewritten frame should be valid JSON")
    }

    fn parse_normalized(input: &[u8]) -> serde_json::Value {
        let normalized =
            normalize_thread_fork_response_for_tui(input).expect("expected normalize to succeed");
        serde_json::from_slice(&normalized).expect("normalized frame should be valid JSON")
    }

    fn create_thread(id: &str, overrides: serde_json::Value) -> serde_json::Value {
        let mut thread = json!({ "id": id, "path": null, "ephemeral": false, "turns": [] });
        merge(&mut thread, overrides);
        thread
    }

    fn create_operation_result(thread: serde_json::Value) -> serde_json::Value {
        json!({
            "thread": thread,
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "cwd": "/repo",
            "model": "gpt-5",
            "modelProvider": "openai",
            "sandbox": "danger-full-access",
        })
    }

    fn create_huge_turn() -> serde_json::Value {
        json!({
            "id": "turn-huge",
            "items": [{ "type": "agentMessage", "id": "item-huge", "text": "x".repeat(256 * 1024) }],
            "status": "completed",
        })
    }

    fn merge(base: &mut serde_json::Value, overrides: serde_json::Value) {
        let (serde_json::Value::Object(base_map), serde_json::Value::Object(override_map)) =
            (base, overrides)
        else {
            return;
        };
        for (key, value) in override_map {
            base_map.insert(key, value);
        }
    }

    const ROLLOUT_PATH: &str = "/tmp/codex-child-rollout.jsonl";

    // ── ported: json-rpc-side-effects.test.ts:92-267 (rewriteThreadForkRequestExcludeTurns) ──

    #[test]
    fn changes_false_and_null_exclude_turns_values_to_true_while_preserving_true() {
        let a = parse_rewritten(
            br#"{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false}}"#,
        );
        assert_eq!(a["params"]["excludeTurns"], json!(true));

        let b = parse_rewritten(
            br#"{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":null}}"#,
        );
        assert_eq!(b["params"]["excludeTurns"], json!(true));

        let c = parse_rewritten(
            br#"{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":true}}"#,
        );
        assert_eq!(c["params"]["excludeTurns"], json!(true));
    }

    #[test]
    fn appends_exclude_turns_to_an_existing_params_object_that_lacks_it() {
        let result = parse_rewritten(
            br#"{"id":"fork-1","method":"thread/fork","params":{"threadId":"parent","cwd":"/repo"}}"#,
        );
        assert_eq!(
            result,
            json!({
                "id": "fork-1",
                "method": "thread/fork",
                "params": { "threadId": "parent", "cwd": "/repo", "excludeTurns": true },
            })
        );
    }

    #[test]
    fn creates_params_when_the_fork_request_omits_params() {
        let result = parse_rewritten(br#"{"id":"fork-1","method":"thread/fork"}"#);
        assert_eq!(
            result,
            json!({ "id": "fork-1", "method": "thread/fork", "params": { "excludeTurns": true } })
        );
    }

    #[test]
    fn preserves_unrelated_top_level_and_params_fields() {
        let raw = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "thread/fork",
            "meta": { "forwarded": true },
            "params": {
                "threadId": "thread-parent",
                "cwd": "/repo",
                "excludeTurns": false,
                "nested": { "excludeTurns": false },
            },
        })
        .to_string();
        let result = parse_rewritten(raw.as_bytes());
        assert_eq!(
            result,
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "thread/fork",
                "meta": { "forwarded": true },
                "params": {
                    "threadId": "thread-parent",
                    "cwd": "/repo",
                    "excludeTurns": true,
                    "nested": { "excludeTurns": false },
                },
            })
        );
    }

    #[test]
    fn rewrites_large_fork_requests_without_full_frame_parse() {
        let blob = "x".repeat(512 * 1024);
        let raw = format!(
            r#"{{"id":7,"method":"thread/fork","params":{{"threadId":"parent","excludeTurns":false,"blob":"{blob}"}},"tail":true}}"#
        );
        let rewritten = rewrite_thread_fork_request_exclude_turns(raw.as_bytes())
            .expect("large fork request should rewrite");
        let parsed: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(parsed["id"], json!(7));
        assert_eq!(parsed["params"]["threadId"], json!("parent"));
        assert_eq!(parsed["params"]["excludeTurns"], json!(true));
        assert_eq!(parsed["tail"], json!(true));
    }

    #[test]
    fn returns_structured_failures_for_malformed_frames_and_non_object_params_values() {
        assert_eq!(
            rewrite_thread_fork_request_exclude_turns(br#"{"id":1"#),
            Err(SideEffectError::MalformedJson)
        );
        for params in ["null", "[]", "\"bad\"", "7"] {
            let raw = format!(r#"{{"id":1,"method":"thread/fork","params":{params}}}"#);
            assert_eq!(
                rewrite_thread_fork_request_exclude_turns(raw.as_bytes()),
                Err(SideEffectError::UnsupportedShape)
            );
        }
    }

    #[test]
    fn returns_a_structured_failure_for_root_arrays_and_batches() {
        assert_eq!(
            rewrite_thread_fork_request_exclude_turns(
                br#"[{"id":1,"method":"thread/fork","params":{"threadId":"parent"}}]"#
            ),
            Err(SideEffectError::BatchUnsupported)
        );
    }

    #[test]
    fn decodes_escaped_params_and_exclude_turns_keys() {
        let result = parse_rewritten(
            br#"{"id":1,"method":"thread/fork","\u0070arams":{"threadId":"parent","exclude\u0054urns":false}}"#,
        );
        assert_eq!(result["params"]["threadId"], json!("parent"));
        assert_eq!(result["params"]["excludeTurns"], json!(true));
    }

    #[test]
    fn fails_closed_for_duplicate_params_or_duplicate_exclude_turns_keys() {
        assert_eq!(
            rewrite_thread_fork_request_exclude_turns(
                br#"{"id":1,"method":"thread/fork","params":{"threadId":"parent"},"params":{"excludeTurns":false}}"#
            ),
            Err(SideEffectError::UnsafeDuplicateKey)
        );
        assert_eq!(
            rewrite_thread_fork_request_exclude_turns(
                br#"{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false,"excludeTurns":true}}"#
            ),
            Err(SideEffectError::UnsafeDuplicateKey)
        );
    }

    // ── ported: json-rpc-side-effects.test.ts:269-641 (bounded side-effect extractors) ──

    #[test]
    fn extracts_a_thread_start_response_candidate_with_huge_turns() {
        let raw = json!({
            "result": create_operation_result(create_thread(
                "thread-start",
                json!({ "path": ROLLOUT_PATH, "turns": [create_huge_turn()] }),
            )),
            "id": "start-1",
        })
        .to_string();
        let mut pending = HashSet::new();
        pending.insert(RequestId::Str("start-1".into()));

        let extracted = extract_thread_start_response_candidate(
            raw.as_bytes(),
            &ThreadStartResponseOptions {
                pending_thread_start_request_ids: &pending,
            },
        )
        .expect("expected a candidate");

        assert_eq!(extracted.source, CandidateSource::ThreadStartResponse);
        assert_eq!(extracted.thread.id, "thread-start");
        assert_eq!(extracted.thread.path.as_deref(), Some(ROLLOUT_PATH));
        assert!(!extracted.thread.ephemeral);
    }

    #[test]
    fn extracts_a_thread_fork_response_candidate_using_result_thread_path() {
        let raw = json!({
            "result": create_operation_result(create_thread(
                "thread-child",
                json!({
                    "path": ROLLOUT_PATH,
                    "ephemeral": false,
                    "turns": [merge_turn(create_huge_turn(), json!({
                        "path": "/decoy/from-turns.jsonl",
                        "parentThreadId": "thread-parent",
                    }))],
                }),
            )),
            "id": 12,
        })
        .to_string();
        let mut pending = HashSet::new();
        pending.insert(RequestId::Int(12));

        let extracted = extract_fork_response_candidate(
            raw.as_bytes(),
            &ForkResponseOptions {
                parent_thread_id: Some("thread-parent"),
                pending_fork_request_ids: &pending,
            },
        )
        .expect("expected a candidate");

        assert_eq!(extracted.source, CandidateSource::ThreadForkResponse);
        assert_eq!(extracted.thread.id, "thread-child");
        assert_eq!(extracted.thread.path.as_deref(), Some(ROLLOUT_PATH));
    }

    fn merge_turn(mut turn: serde_json::Value, overrides: serde_json::Value) -> serde_json::Value {
        merge(&mut turn, overrides);
        turn
    }

    #[test]
    fn extracts_thread_started_notification_candidate_and_lifecycle() {
        let raw = json!({
            "params": {
                "thread": create_thread("thread-notified", json!({ "path": ROLLOUT_PATH, "turns": [create_huge_turn()] })),
            },
            "method": "thread/started",
        })
        .to_string();

        let extracted = extract_thread_started_notification_side_effects(raw.as_bytes())
            .expect("expected side effects");
        assert_eq!(
            extracted.candidate.source,
            CandidateSource::ThreadStartedNotification
        );
        assert_eq!(extracted.candidate.thread.id, "thread-notified");
        assert_eq!(
            extracted.candidate.thread.path.as_deref(),
            Some(ROLLOUT_PATH)
        );
        assert_eq!(extracted.lifecycle.thread.id, "thread-notified");
    }

    #[test]
    fn extracts_turn_started_and_completed_metadata_when_the_turn_body_is_huge() {
        let started_raw = json!({
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "input": [{ "type": "text", "text": "x".repeat(256 * 1024), "text_elements": [] }],
            },
            "method": "turn/started",
        })
        .to_string();
        let completed_raw = json!({
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "turn": create_huge_turn(),
                "status": "completed",
            },
            "method": "turn/completed",
        })
        .to_string();

        assert_eq!(
            extract_turn_notification_event(started_raw.as_bytes()).unwrap(),
            TurnEvent::Started {
                thread_id: "thread-1".into(),
                turn_id: Some("turn-1".into()),
            }
        );
        assert_eq!(
            extract_turn_notification_event(completed_raw.as_bytes()).unwrap(),
            TurnEvent::Completed {
                thread_id: "thread-1".into(),
                turn_id: Some("turn-1".into()),
                status: Some("completed".into()),
            }
        );
    }

    #[test]
    fn rejects_turn_completed_side_effects_with_malformed_status_values() {
        for status in TURN_STATUSES {
            let raw = json!({
                "method": "turn/completed",
                "params": { "threadId": "thread-1", "turnId": format!("turn-{status}"), "status": status },
            })
            .to_string();
            assert_eq!(
                extract_turn_notification_event(raw.as_bytes()).unwrap(),
                TurnEvent::Completed {
                    thread_id: "thread-1".into(),
                    turn_id: Some(format!("turn-{status}")),
                    status: Some(status.to_string()),
                }
            );
        }

        for params in [
            json!({ "threadId": "thread-1", "turnId": "turn-flat", "status": "bogus" }),
            json!({ "threadId": "thread-1", "turnId": "turn-nested", "turn": { "id": "turn-nested", "status": "bogus" } }),
        ] {
            let raw = json!({ "method": "turn/completed", "params": params }).to_string();
            assert_eq!(
                extract_turn_notification_event(raw.as_bytes()),
                Err(SideEffectError::UnsupportedShape)
            );
        }
    }

    #[test]
    fn extracts_thread_closed_and_thread_status_changed_lifecycle_metadata() {
        let closed_raw = json!({
            "params": { "threadId": "thread-1", "nested": { "threadId": "decoy" } },
            "method": "thread/closed",
        })
        .to_string();
        let status_raw = json!({
            "params": { "threadId": "thread-1", "status": { "type": "notLoaded", "reason": "evicted" } },
            "method": "thread/status/changed",
        })
        .to_string();

        assert_eq!(
            extract_thread_lifecycle_event(closed_raw.as_bytes()).unwrap(),
            ThreadLifecycleEvent::ThreadClosed {
                thread_id: "thread-1".into()
            }
        );
        let status_event = extract_thread_lifecycle_event(status_raw.as_bytes()).unwrap();
        match status_event {
            ThreadLifecycleEvent::ThreadStatusChanged { thread_id, status } => {
                assert_eq!(thread_id, "thread-1");
                assert_eq!(
                    status.get("type").and_then(|v| v.as_str()),
                    Some("notLoaded")
                );
                assert_eq!(
                    status.get("reason").and_then(|v| v.as_str()),
                    Some("evicted")
                );
            }
            other => panic!("expected ThreadStatusChanged, got {other:?}"),
        }
    }

    #[test]
    fn extracts_fs_changed_repair_triggers_and_collapses_oversized_changed_paths() {
        let bounded_raw = json!({
            "method": "fs/changed",
            "params": { "watchId": "watch-1", "changedPaths": ["/repo/a.ts", "/repo/b.ts"] },
        })
        .to_string();
        let oversized_paths: Vec<String> = (0..4096).map(|i| format!("/repo/{i}.ts")).collect();
        let oversized_raw = json!({
            "params": { "watchId": "watch-2", "changedPaths": oversized_paths },
            "method": "fs/changed",
        })
        .to_string();

        assert_eq!(
            extract_fs_changed_repair_trigger(bounded_raw.as_bytes()).unwrap(),
            FsChangedRepairTrigger {
                watch_id: "watch-1".into(),
                changed_paths: vec!["/repo/a.ts".into(), "/repo/b.ts".into()],
            }
        );
        assert_eq!(
            extract_fs_changed_repair_trigger(oversized_raw.as_bytes()).unwrap(),
            FsChangedRepairTrigger {
                watch_id: "watch-2".into(),
                changed_paths: Vec::new(),
            }
        );
    }

    #[test]
    fn does_not_use_nested_decoy_fields_over_owned_paths_and_fails_cleanly_on_malformed_frames() {
        let raw = json!({
            "params": {
                "decoy": { "threadId": "wrong-thread", "turnId": "wrong-turn" },
                "threadId": "thread-owned",
                "turnId": "turn-owned",
            },
            "method": "turn/started",
        })
        .to_string();
        assert_eq!(
            extract_turn_notification_event(raw.as_bytes()).unwrap(),
            TurnEvent::Started {
                thread_id: "thread-owned".into(),
                turn_id: Some("turn-owned".into()),
            }
        );
        assert_eq!(
            extract_turn_notification_event(br#"{"method":"turn/started","params":"#),
            Err(SideEffectError::MalformedJson)
        );
    }

    #[test]
    fn rejects_unsafe_fork_response_candidates() {
        let base = json!({ "id": "thread-child", "path": ROLLOUT_PATH, "ephemeral": false });
        let cases: Vec<(serde_json::Value, SideEffectError)> = vec![
            (
                merge_turn(base.clone(), json!({ "path": null })),
                SideEffectError::MissingRolloutPath,
            ),
            (
                merge_turn(base.clone(), json!({ "path": 7 })),
                SideEffectError::UnsupportedShape,
            ),
            (
                merge_turn(base.clone(), json!({ "path": "relative/rollout.jsonl" })),
                SideEffectError::RelativeRolloutPath,
            ),
            (
                merge_turn(base.clone(), json!({ "ephemeral": true })),
                SideEffectError::EphemeralThread,
            ),
            (
                merge_turn(base.clone(), json!({ "ephemeral": "true" })),
                SideEffectError::UnsupportedShape,
            ),
            (
                merge_turn(base.clone(), json!({ "id": "thread-parent" })),
                SideEffectError::SameAsParent,
            ),
            (
                merge_turn(
                    base.clone(),
                    json!({ "rolloutPath": format!("{ROLLOUT_PATH}.other") }),
                ),
                SideEffectError::PathAliasConflict,
            ),
        ];

        let mut pending = HashSet::new();
        pending.insert(RequestId::Int(12));
        for (thread, expected_reason) in cases {
            let raw = json!({ "id": 12, "result": create_operation_result(thread) }).to_string();
            assert_eq!(
                extract_fork_response_candidate(
                    raw.as_bytes(),
                    &ForkResponseOptions {
                        parent_thread_id: Some("thread-parent"),
                        pending_fork_request_ids: &pending,
                    }
                ),
                Err(expected_reason)
            );
        }
    }

    #[test]
    fn rejects_root_arrays_ambiguous_duplicate_keys_and_non_pending_ids() {
        let mut pending = HashSet::new();
        pending.insert(RequestId::Int(12));
        let opts = ForkResponseOptions {
            parent_thread_id: Some("thread-parent"),
            pending_fork_request_ids: &pending,
        };

        assert_eq!(
            extract_fork_response_candidate(
                br#"[{"id":12,"result":{"thread":{"id":"thread-child"}}}]"#,
                &opts
            ),
            Err(SideEffectError::BatchUnsupported)
        );

        for raw in [
            r#"{"id":12,"id":13,"result":{"thread":{"id":"thread-child","path":"/tmp/a.jsonl"}}}"#,
            r#"{"id":12,"result":{"thread":{"id":"thread-child","path":"/tmp/a.jsonl"}},"result":{"thread":{"id":"thread-child","path":"/tmp/b.jsonl"}}}"#,
            r#"{"id":12,"result":{"thread":{"id":"thread-child","path":"/tmp/a.jsonl"},"thread":{"id":"thread-child","path":"/tmp/b.jsonl"}}}"#,
            r#"{"id":12,"result":{"thread":{"id":"thread-child","id":"thread-other","path":"/tmp/a.jsonl"}}}"#,
            r#"{"id":12,"result":{"thread":{"id":"thread-child","path":"/tmp/a.jsonl","path":"/tmp/b.jsonl"}}}"#,
            r#"{"id":12,"result":{"thread":{"id":"thread-child","path":"/tmp/a.jsonl","ephemeral":false,"ephemeral":true}}}"#,
        ] {
            assert_eq!(
                extract_fork_response_candidate(raw.as_bytes(), &opts),
                Err(SideEffectError::UnsafeDuplicateKey),
                "expected unsafe_duplicate_key for {raw}"
            );
        }

        let raw = json!({
            "result": create_operation_result(create_thread(
                "thread-child",
                json!({
                    "path": ROLLOUT_PATH,
                    "turns": [merge_turn(create_huge_turn(), json!({ "requestId": 12, "path": "/tmp/decoy.jsonl" }))],
                }),
            )),
            "id": "not-pending",
        })
        .to_string();
        assert_eq!(
            extract_fork_response_candidate(raw.as_bytes(), &opts),
            Err(SideEffectError::IdNotPendingFork)
        );
    }

    #[test]
    fn uses_remembered_parent_attribution_and_refuses_missing_parent_ids() {
        let mut pending = HashSet::new();
        pending.insert(RequestId::Int(12));
        pending.insert(RequestId::Int(13));

        let raw_same_as_parent = json!({
            "id": 12,
            "result": create_operation_result(json!({ "id": "thread-parent", "path": ROLLOUT_PATH })),
        })
        .to_string();
        assert_eq!(
            extract_fork_response_candidate(
                raw_same_as_parent.as_bytes(),
                &ForkResponseOptions {
                    parent_thread_id: Some("thread-parent"),
                    pending_fork_request_ids: &pending,
                }
            ),
            Err(SideEffectError::SameAsParent)
        );

        let raw_missing_parent = json!({
            "id": 13,
            "result": create_operation_result(json!({ "id": "thread-child", "path": ROLLOUT_PATH })),
        })
        .to_string();
        assert_eq!(
            extract_fork_response_candidate(
                raw_missing_parent.as_bytes(),
                &ForkResponseOptions {
                    parent_thread_id: None,
                    pending_fork_request_ids: &pending,
                }
            ),
            Err(SideEffectError::MissingParentThreadId)
        );
    }

    // ── ported: json-rpc-side-effects.test.ts:644-699 (normalizeThreadForkResponseForTui) ──

    #[test]
    fn adds_result_thread_turns_when_upstream_omitted_it() {
        let raw = json!({
            "id": 12,
            "result": create_operation_result(create_thread("thread-child", json!({ "path": ROLLOUT_PATH }))),
        })
        .to_string();
        let normalized = parse_normalized(raw.as_bytes());
        assert_eq!(normalized["id"], json!(12));
        assert_eq!(normalized["result"]["thread"]["turns"], json!([]));
    }

    #[test]
    fn preserves_an_existing_bounded_turns_array_plus_unrelated_fields() {
        let raw = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "result": create_operation_result(create_thread("thread-child", json!({
                "path": ROLLOUT_PATH,
                "ephemeral": false,
                "preview": "hello",
                "turns": [{ "id": "turn-1", "items": [], "status": "completed" }],
            }))),
            "extra": { "keep": true },
        })
        .to_string();
        let normalized = parse_normalized(raw.as_bytes());
        assert_eq!(
            normalized["result"]["thread"]["turns"],
            json!([{ "id": "turn-1", "items": [], "status": "completed" }])
        );
        assert_eq!(normalized["extra"], json!({ "keep": true }));
    }

    #[test]
    fn normalize_rejects_root_arrays_and_duplicate_owned_keys() {
        assert_eq!(
            normalize_thread_fork_response_for_tui(
                br#"[{"id":12,"result":{"thread":{"id":"thread-child"}}}]"#
            ),
            Err(SideEffectError::BatchUnsupported)
        );
        assert_eq!(
            normalize_thread_fork_response_for_tui(
                br#"{"id":12,"result":{"thread":{"id":"thread-child","turns":[],"turns":[]}}}"#
            ),
            Err(SideEffectError::UnsafeDuplicateKey)
        );
    }

    // ── malformed-input robustness: every extractor must never panic ────────────────

    #[test]
    fn every_extractor_never_panics_on_arbitrary_or_malformed_bytes() {
        let inputs: &[&[u8]] = &[
            b"",
            b"   ",
            b"{",
            b"}",
            b"[",
            b"null",
            b"true",
            b"\"just a string\"",
            b"7",
            b"{\"method\":",
            b"{\"method\":\"thread/started\"",
            b"{\"method\":\"thread/started\",\"params\":",
            b"{\"method\":\"thread/started\",\"params\":{\"thread\":",
            b"{\"method\":\"turn/completed\",\"params\":{\"threadId\":",
            b"{\"method\":\"fs/changed\",\"params\":{\"changedPaths\":[1,2,3]}}",
            b"{\"method\":\"fs/changed\",\"params\":{\"watchId\":\"w\",\"changedPaths\":\"not-an-array\"}}",
            b"\xff\xfe\x00\x01",
            b"{\"id\":{},\"result\":{}}",
            b"{\"id\":[1,2],\"result\":{}}",
            &[b'{'; 4096],
            &[b'['; 4096],
        ];
        let empty_ids: HashSet<RequestId> = HashSet::new();
        let start_opts = ThreadStartResponseOptions {
            pending_thread_start_request_ids: &empty_ids,
        };
        let fork_opts = ForkResponseOptions {
            parent_thread_id: Some("thread-parent"),
            pending_fork_request_ids: &empty_ids,
        };

        for input in inputs {
            let _ = extract_thread_start_response_candidate(input, &start_opts);
            let _ = extract_fork_response_candidate(input, &fork_opts);
            let _ = extract_thread_started_notification_side_effects(input);
            let _ = extract_turn_notification_event(input);
            let _ = extract_thread_lifecycle_event(input);
            let _ = extract_fs_changed_repair_trigger(input);
            let _ = rewrite_thread_fork_request_exclude_turns(input);
            let _ = normalize_thread_fork_response_for_tui(input);
        }
    }

    #[test]
    fn extractors_never_panic_across_a_seeded_corpus_of_shuffled_json_fragments() {
        // A lightweight, deterministic "fuzzer": recombine well-formed JSON fragments in
        // arbitrary nestings/positions so most inputs are syntactically plausible but
        // semantically wrong for every extractor (missing fields, wrong types, wrong
        // methods) -- exactly the adversarial-but-plausible frames a misbehaving upstream
        // app-server could relay.
        let mut state: u32 = 0x5eed;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            state
        };
        let fragments = [
            "{}",
            "[]",
            "null",
            "true",
            "1",
            "\"thread-1\"",
            "{\"id\":1}",
            "{\"method\":\"turn/started\"}",
            "{\"method\":\"thread/started\",\"params\":{}}",
            "{\"threadId\":\"t\"}",
            "{\"watchId\":\"w\",\"changedPaths\":[]}",
        ];
        let empty_ids: HashSet<RequestId> = HashSet::new();
        let start_opts = ThreadStartResponseOptions {
            pending_thread_start_request_ids: &empty_ids,
        };
        let fork_opts = ForkResponseOptions {
            parent_thread_id: None,
            pending_fork_request_ids: &empty_ids,
        };

        for _ in 0..200 {
            let a = fragments[(next() as usize) % fragments.len()];
            let b = fragments[(next() as usize) % fragments.len()];
            let raw = format!("{{\"method\":{a},\"params\":{b},\"id\":{a},\"result\":{b}}}");
            let _ = extract_thread_start_response_candidate(raw.as_bytes(), &start_opts);
            let _ = extract_fork_response_candidate(raw.as_bytes(), &fork_opts);
            let _ = extract_thread_started_notification_side_effects(raw.as_bytes());
            let _ = extract_turn_notification_event(raw.as_bytes());
            let _ = extract_thread_lifecycle_event(raw.as_bytes());
            let _ = extract_fs_changed_repair_trigger(raw.as_bytes());
            let _ = rewrite_thread_fork_request_exclude_turns(raw.as_bytes());
            let _ = normalize_thread_fork_response_for_tui(raw.as_bytes());
        }
    }
}

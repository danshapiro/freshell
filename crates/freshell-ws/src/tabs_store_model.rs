//! Pure state model for the DURABLE tabs registry (PART B) — the
//! caps/hash/validation/maintenance slice of `server/tabs-registry/store.ts`
//! plus the record schema + pane-kind migration of `server/tabs-registry/types.ts`.
//!
//! Scope Decision 5 (validator-A2): canonical serialization for WRITING uses
//! BYTE-ORDER key sorting (`BTreeMap`), NOT Node's ICU `localeCompare`.
//! Cross-impl hash equality is asserted only for the reachable all-camelCase
//! payload-key inventory (the Step-1 Node fixture); for divergent-order map
//! keys (mixed-case base64url, `-`/`_` tabKey suffixes) only Rust's
//! self-consistent roundtrip and byte-order output are pinned (ledger A2-R1).

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map, Value};

/// `DAY_MS` (store.ts:9).
pub const DAY_MS: i64 = 86_400_000;
/// `MINUTE_MS` (store.ts:10).
pub const MINUTE_MS: i64 = 60_000;
/// `DEFAULT_CLOSED_RETENTION_DAYS` (store.ts:11).
pub const DEFAULT_CLOSED_RETENTION_DAYS: i64 = 30;
/// `DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES` (store.ts:12).
pub const DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES: i64 = 30;
/// `DEFAULT_DEVICE_DISPLAY_TTL_DAYS` (store.ts:13).
pub const DEFAULT_DEVICE_DISPLAY_TTL_DAYS: i64 = 7;

/// `TabsRegistryCaps` (store.ts:154-172), values per `DEFAULT_CAPS`
/// (store.ts:176-194).
#[derive(Clone, Debug)]
pub struct TabsStoreCaps {
    pub max_records_per_push: usize,                         // 500
    pub max_open_records_per_client_snapshot: usize,         // 500
    pub max_closed_records_per_push: usize,                  // 500
    pub max_panes_per_record: usize,                         // 20
    pub max_serialized_push_bytes: usize,                    // 1 MiB
    pub max_serialized_client_snapshot_object_bytes: usize,  // 512 KiB
    pub max_serialized_manifest_bytes: usize,                // 256 KiB
    pub max_serialized_closed_tombstone_object_bytes: usize, // 2 MiB
    pub max_serialized_device_metadata_object_bytes: usize, // 256 KiB (devices AND clientRevisions)
    pub max_compact_state_bytes: usize,                     // 5 MiB
    pub max_client_snapshot_refs: usize,                    // 200
    pub max_client_revision_watermarks: usize,              // 200
    pub max_devices: usize,                                 // 200
    pub max_closed_tombstones: usize,                       // 2000
    pub max_legacy_line_bytes: usize,                       // 256 KiB
    pub max_legacy_unique_tab_keys: usize,                  // 10_000
    pub max_migration_retained_bytes: usize,                // 5 MiB
}

/// `DEFAULT_CAPS` (store.ts:176-194).
pub fn default_caps() -> TabsStoreCaps {
    TabsStoreCaps {
        max_records_per_push: 500,
        max_open_records_per_client_snapshot: 500,
        max_closed_records_per_push: 500,
        max_panes_per_record: 20,
        max_serialized_push_bytes: 1024 * 1024,
        max_serialized_client_snapshot_object_bytes: 512 * 1024,
        max_serialized_manifest_bytes: 256 * 1024,
        max_serialized_closed_tombstone_object_bytes: 2 * 1024 * 1024,
        max_serialized_device_metadata_object_bytes: 256 * 1024,
        max_compact_state_bytes: 5 * 1024 * 1024,
        max_client_snapshot_refs: 200,
        max_client_revision_watermarks: 200,
        max_devices: 200,
        max_closed_tombstones: 2000,
        max_legacy_line_bytes: 256 * 1024,
        max_legacy_unique_tab_keys: 10_000,
        max_migration_retained_bytes: 5 * 1024 * 1024,
    }
}

/// `ClientOpenSnapshot` (store.ts:75-84). `snapshot_received_at` is the SERVER
/// receipt time (the open-snapshot TTL basis); `records` are the client's OPEN
/// records only, carried verbatim.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientOpenSnapshot {
    pub device_id: String,
    pub device_label: String,
    pub client_instance_id: String,
    pub snapshot_revision: i64,
    pub last_push_payload_hash: String,     // 64-hex, ALL records
    pub open_snapshot_payload_hash: String, // 64-hex, open records only
    pub snapshot_received_at: i64,          // SERVER receipt time (TTL basis)
    pub records: Vec<serde_json::Value>,    // open records only, verbatim
}

/// `ClientRevisionWatermark` (store.ts:86-91).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRevisionWatermark {
    pub device_id: String,
    pub client_instance_id: String,
    pub snapshot_revision: i64,
    pub last_seen_at: i64,
}

/// `RegistryDeviceEntry` (store.ts:69-73).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDeviceEntry {
    pub device_id: String,
    pub device_label: String,
    pub last_seen_at: i64,
}

/// The in-memory shape of `CompactTabsRegistryStateV1` (store.ts:93-103).
/// `version`/`openSnapshotTtlMinutes`/`deviceDisplayTtlDays` are schema-pinned
/// constants in the original (store.ts:220-221) and live as the module
/// constants above rather than as fields.
#[derive(Clone, Debug, Default)]
pub struct CompactState {
    pub saved_at: i64,
    pub max_closed_retention_days: i64, // 1..=30, default 30
    pub open_snapshots_by_client: std::collections::HashMap<String, ClientOpenSnapshot>,
    pub client_revisions_by_client: std::collections::HashMap<String, ClientRevisionWatermark>,
    pub closed_by_tab_key: std::collections::HashMap<String, serde_json::Value>,
    pub devices_by_id: std::collections::HashMap<String, RegistryDeviceEntry>,
}

/// `emptyState` (store.ts:397-409).
pub fn empty_state(now: i64, max_closed_retention_days: i64) -> CompactState {
    CompactState {
        saved_at: now,
        max_closed_retention_days,
        open_snapshots_by_client: HashMap::new(),
        client_revisions_by_client: HashMap::new(),
        closed_by_tab_key: HashMap::new(),
        devices_by_id: HashMap::new(),
    }
}

// ── Canonical serialization + hashing ────────────────────────────────────────

/// `stableStringify` (store.ts:320-329) with BYTE-ORDER key sorting (Scope
/// Decision 5): objects recurse with keys sorted via `BTreeMap`; arrays recurse
/// element-wise (order preserved); scalars serialize as-is. `null`s are KEPT —
/// Node drops only `undefined`, which `serde_json` cannot represent.
pub fn canonical_stringify(v: &serde_json::Value) -> String {
    serde_json::to_string(&canonicalize(v)).unwrap_or_default()
}

/// The `BTreeMap` re-key technique of `tabs_persist::canonicalize`
/// (tabs_persist.rs:51-63): this workspace enables `serde_json`'s
/// `preserve_order`, so a rebuilt sorted map serializes in sorted order.
fn canonicalize(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let sorted: BTreeMap<String, Value> = map
                .iter()
                .map(|(k, val)| (k.clone(), canonicalize(val)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// `sha256` (store.ts:316-318): the FULL 64-hex digest (NOT `tabs_persist`'s
/// truncated 128-bit form).
pub fn sha256_hex_full(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `Buffer.from(v, "utf-8").toString("base64url")`: standard alphabet with
/// `-`/`_` in slots 62/63, no padding. Hand-rolled — no new crate deps.
pub fn base64url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

/// `clientSnapshotKey` (store.ts:371-377):
/// `${base64url(deviceId)}:${base64url(clientInstanceId)}`; Err on
/// blank/whitespace ids.
pub fn client_snapshot_key(device_id: &str, client_instance_id: &str) -> Result<String, String> {
    if device_id.trim().is_empty() || client_instance_id.trim().is_empty() {
        return Err(
            "Tabs registry client snapshot requires non-empty deviceId and clientInstanceId"
                .to_string(),
        );
    }
    Ok(format!(
        "{}:{}",
        base64url_no_pad(device_id.as_bytes()),
        base64url_no_pad(client_instance_id.as_bytes())
    ))
}

/// `buildSnapshotPayloadHash` (store.ts:530-538).
pub fn build_snapshot_payload_hash(
    device_id: &str,
    device_label: &str,
    client_instance_id: &str,
    snapshot_revision: i64,
    records: &[serde_json::Value],
) -> String {
    let payload = json!({
        "deviceId": device_id,
        "deviceLabel": device_label,
        "clientInstanceId": client_instance_id,
        "snapshotRevision": snapshot_revision,
        "records": records,
    });
    sha256_hex_full(&canonical_stringify(&payload))
}

/// `archiveTimestamp` (store.ts:596-607): LOCAL-time `YYYYMMDD-HHMMSS`.
pub fn archive_timestamp(now_ms: i64) -> String {
    use chrono::{Datelike, TimeZone, Timelike};
    let dt = match chrono::Local.timestamp_millis_opt(now_ms) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => dt,
        chrono::LocalResult::None => return "00000000-000000".to_string(),
    };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

// ── Record validation (TabRegistryRecordSchema port, types.ts:57-83) ─────────

/// The eight legal pane kinds (`RegistryPaneKindSchema`, types.ts:7-16).
const PANE_KINDS: [&str; 8] = [
    "terminal",
    "browser",
    "editor",
    "picker",
    "host-stats",
    "claude-chat",
    "fresh-agent",
    "extension",
];

fn req_nonempty_str<'a>(rec: &'a Map<String, Value>, field: &str) -> Result<&'a str, String> {
    match rec.get(field).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err(format!(
            "Tabs registry record field '{field}' must be a non-empty string"
        )),
    }
}

fn req_nonneg_int(rec: &Map<String, Value>, field: &str) -> Result<i64, String> {
    match rec.get(field).and_then(Value::as_i64) {
        Some(n) if n >= 0 => Ok(n),
        _ => Err(format!(
            "Tabs registry record field '{field}' must be a non-negative integer"
        )),
    }
}

/// `TabRegistryRecordSchema` port (types.ts:57-83): required non-empty string
/// identity fields; `status` in `open|closed`; `closedAt` REQUIRED (int >= 0)
/// when closed; non-negative-int counters; `titleSetByUser` bool; `panes`
/// array of `{paneId, kind, payload}` with `kind` in the seven-kind enum.
/// Like the zod schema, unknown extra keys are permitted.
pub fn validate_registry_record(v: &serde_json::Value) -> Result<(), String> {
    let rec = v
        .as_object()
        .ok_or_else(|| "Tabs registry record must be an object".to_string())?;
    for field in [
        "tabKey",
        "tabId",
        "serverInstanceId",
        "deviceId",
        "deviceLabel",
        "tabName",
    ] {
        req_nonempty_str(rec, field)?;
    }
    // `clientInstanceId: z.string().min(1).optional()` (types.ts:63).
    if let Some(cid) = rec.get("clientInstanceId") {
        if cid.as_str().is_none_or(str::is_empty) {
            return Err("Tabs registry record clientInstanceId must be a non-empty string".into());
        }
    }
    let status = req_nonempty_str(rec, "status")?;
    if status != "open" && status != "closed" {
        return Err("Tabs registry record status must be 'open' or 'closed'".into());
    }
    for field in ["revision", "createdAt", "updatedAt", "paneCount"] {
        req_nonneg_int(rec, field)?;
    }
    // `closedAt` optional int >= 0, REQUIRED when closed (types.ts:75-83).
    match rec.get("closedAt") {
        Some(v) if v.as_i64().is_none_or(|n| n < 0) => {
            return Err("Tabs registry record closedAt must be a non-negative integer".into());
        }
        None if status == "closed" => {
            return Err("closedAt is required when status is closed".into());
        }
        _ => {}
    }
    if !rec.get("titleSetByUser").is_some_and(Value::is_boolean) {
        return Err("Tabs registry record titleSetByUser must be a boolean".into());
    }
    let panes = rec
        .get("panes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Tabs registry record panes must be an array".to_string())?;
    for pane in panes {
        let pane = pane
            .as_object()
            .ok_or_else(|| "Tabs registry pane must be an object".to_string())?;
        req_nonempty_str(pane, "paneId")?;
        let kind = req_nonempty_str(pane, "kind")?;
        if !PANE_KINDS.contains(&kind) {
            return Err(format!(
                "Tabs registry pane kind '{kind}' is not a legal pane kind"
            ));
        }
        if let Some(title) = pane.get("title") {
            if !title.is_string() {
                return Err("Tabs registry pane title must be a string".into());
            }
        }
        if !pane.get("payload").is_some_and(Value::is_object) {
            return Err("Tabs registry pane payload must be an object".into());
        }
    }
    Ok(())
}

// ── Legacy pane-kind migration (types.ts:28-54 + shared/fresh-agent.ts) ──────

/// The legacy keys `migrateLegacyFreshAgentContent` strips before rebuilding
/// (shared/fresh-agent.ts:220-229, 254-263, 306-315).
const LEGACY_CONTENT_KEYS: [&str; 7] = [
    "kind",
    "provider",
    "sessionRef",
    "resumeSessionId",
    "timelineSessionId",
    "cliSessionId",
    "restoreError",
];

/// The five legal `RestoreError.reason`s (shared/session-contract.ts:17-23).
const RESTORE_ERROR_REASONS: [&str; 5] = [
    "missing_canonical_identity",
    "invalid_legacy_restore_target",
    "dead_live_handle",
    "provider_runtime_failed",
    "durable_artifact_missing",
];

fn restore_error(reason: &str) -> Value {
    json!({ "code": "RESTORE_UNAVAILABLE", "reason": reason })
}

/// `normalizeFreshAgentSessionType` (shared/fresh-agent.ts:105-138).
fn normalize_session_type(v: Option<&Value>) -> Option<&'static str> {
    match v.and_then(Value::as_str) {
        Some("freshclaude") => Some("freshclaude"),
        Some("freshcodex") => Some("freshcodex"),
        Some("kilroy") => Some("kilroy"),
        Some("freshopencode") => Some("freshopencode"),
        _ => None,
    }
}

/// `resolveFreshAgentRuntimeProvider` (shared/fresh-agent.ts:77-120).
fn resolve_runtime_provider(session_type: Option<&str>) -> Option<&'static str> {
    match session_type {
        Some("freshclaude") | Some("kilroy") => Some("claude"),
        Some("freshcodex") => Some("codex"),
        Some("freshopencode") => Some("opencode"),
        _ => None,
    }
}

/// `isCanonicalClaudeSessionId` (shared/session-contract.ts:34,44-46): a
/// canonical UUID (version 1-5, variant 8/9/a/b), case-insensitive.
fn is_canonical_claude_session_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        14 => (b'1'..=b'5').contains(&c),
        19 => matches!(c.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
        _ => c.is_ascii_hexdigit(),
    })
}

/// `sanitizeSessionRef` (shared/session-contract.ts:55-62): `(provider,
/// sessionId)` when both are non-empty strings.
pub(crate) fn sanitize_session_ref(v: Option<&Value>) -> Option<(String, String)> {
    let obj = v?.as_object()?;
    let provider = obj.get("provider")?.as_str().filter(|s| !s.is_empty())?;
    let session_id = obj.get("sessionId")?.as_str().filter(|s| !s.is_empty())?;
    Some((provider.to_string(), session_id.to_string()))
}

/// `isDurableProviderSessionId` (shared/session-flavor.ts:65-77): a non-empty
/// id the provider minted durably — a canonical UUID for claude, `ses_`-prefixed
/// for opencode, anything not `freshcodex-`-prefixed for codex. Empty ids and
/// unknown providers are NEVER durable: a durability claim requires knowing
/// the provider's durable id shape.
pub(crate) fn is_durable_provider_session_id(provider: &str, session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    match provider {
        "claude" => is_canonical_claude_session_id(session_id),
        "opencode" => session_id.starts_with("ses_"),
        "codex" => !session_id.starts_with("freshcodex-"),
        _ => false,
    }
}

/// `isPlaceholderProviderSessionId` (shared/session-flavor.ts:86-98): a
/// non-empty id the provider did NOT mint durably (re-derived placeholders
/// such as `freshopencode-<createRequestId>`). Empty ids and unknown providers
/// are NOT placeholders: a placeholder claim requires knowing the provider's
/// durable id shape.
pub(crate) fn is_placeholder_provider_session_id(provider: &str, session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    match provider {
        "claude" => !is_canonical_claude_session_id(session_id),
        "opencode" => !session_id.starts_with("ses_"),
        "codex" => session_id.starts_with("freshcodex-"),
        _ => false,
    }
}

/// `readRestoreError` (shared/fresh-agent.ts:190-197): the validated reason.
pub(crate) fn read_restore_error(v: Option<&Value>) -> Option<&'static str> {
    let obj = v?.as_object()?;
    if obj.get("code").and_then(Value::as_str) != Some("RESTORE_UNAVAILABLE") {
        return None;
    }
    let reason = obj.get("reason")?.as_str()?;
    RESTORE_ERROR_REASONS
        .iter()
        .find(|r| **r == reason)
        .copied()
}

/// `migrateLegacyFreshAgentDurableState` (shared/fresh-agent.ts:140-188) with
/// `rejectNonCanonicalClaudeSessionRef: true` (the only call shape the pane
/// migration uses). Returns `(sessionRef, restoreError reason)`.
fn migrate_durable_state(
    provider: Option<&str>,
    session_ref: Option<&Value>,
    resume_session_id: Option<&str>,
) -> (Option<Value>, Option<&'static str>) {
    if let Some((ref_provider, ref_session_id)) = sanitize_session_ref(session_ref) {
        if ref_provider == "claude" && !is_canonical_claude_session_id(&ref_session_id) {
            return (None, Some("invalid_legacy_restore_target"));
        }
        return (
            Some(json!({ "provider": ref_provider, "sessionId": ref_session_id })),
            None,
        );
    }
    let (Some(provider), Some(resume)) = (provider, resume_session_id) else {
        return (None, None);
    };
    if provider == "claude" {
        if is_canonical_claude_session_id(resume) {
            (
                Some(json!({ "provider": "claude", "sessionId": resume })),
                None,
            )
        } else {
            (None, Some("invalid_legacy_restore_target"))
        }
    } else {
        (
            Some(json!({ "provider": provider, "sessionId": resume })),
            None,
        )
    }
}

/// `input` minus the legacy content keys (the `...rest` destructures).
fn strip_legacy_keys(input: &Map<String, Value>) -> Map<String, Value> {
    input
        .iter()
        .filter(|(k, _)| !LEGACY_CONTENT_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// The `resumeSessionId ?? timelineSessionId ?? cliSessionId` string chain
/// (shared/fresh-agent.ts:243-247, 287-291).
fn resume_id_chain(input: &Map<String, Value>) -> Option<&str> {
    input
        .get("resumeSessionId")
        .and_then(Value::as_str)
        .or_else(|| input.get("timelineSessionId").and_then(Value::as_str))
        .or_else(|| input.get("cliSessionId").and_then(Value::as_str))
}

/// `migrateLegacyFreshAgentContent` (shared/fresh-agent.ts:199-334) over a
/// compat object (`{ kind, ...payload }`). Non-agent kinds pass through.
fn migrate_legacy_fresh_agent_content(input: &Map<String, Value>) -> Map<String, Value> {
    match input.get("kind").and_then(Value::as_str) {
        Some("fresh-agent") => migrate_fresh_agent_kind(input),
        Some("agent-chat") => migrate_agent_chat_kind(input),
        _ => input.clone(),
    }
}

/// The `kind === 'fresh-agent'` branch (shared/fresh-agent.ts:206-277).
fn migrate_fresh_agent_kind(input: &Map<String, Value>) -> Map<String, Value> {
    let session_type = normalize_session_type(input.get("sessionType"))
        .or_else(|| normalize_session_type(input.get("provider")));
    let provider = match input.get("provider").and_then(Value::as_str) {
        Some(p @ ("claude" | "codex" | "opencode")) => Some(p),
        _ => resolve_runtime_provider(session_type),
    };
    let (Some(session_type), Some(provider)) = (session_type, provider) else {
        return input.clone();
    };
    let provider = provider.to_string();
    let resume_in = input
        .get("resumeSessionId")
        .and_then(Value::as_str)
        .map(String::from);

    let mut out = strip_legacy_keys(input);
    out.insert("kind".to_string(), json!("fresh-agent"));
    out.insert("provider".to_string(), json!(provider));
    out.insert("sessionType".to_string(), json!(session_type));

    if let Some(reason) = read_restore_error(input.get("restoreError")) {
        if reason != "invalid_legacy_restore_target" {
            if let Some(resume) = resume_in {
                out.insert("resumeSessionId".to_string(), json!(resume));
            }
        }
        out.insert("restoreError".to_string(), restore_error(reason));
        return out;
    }

    let (session_ref, reason) = migrate_durable_state(
        Some(&provider),
        input.get("sessionRef"),
        resume_id_chain(input),
    );
    match reason {
        Some(reason) => {
            out.insert("restoreError".to_string(), restore_error(reason));
        }
        None => {
            if let Some(resume) = resume_in {
                out.insert("resumeSessionId".to_string(), json!(resume));
            }
            if let Some(session_ref) = session_ref {
                out.insert("sessionRef".to_string(), session_ref);
            }
        }
    }
    out
}

/// The `kind === 'agent-chat'` branch (shared/fresh-agent.ts:279-334).
fn migrate_agent_chat_kind(input: &Map<String, Value>) -> Map<String, Value> {
    let legacy_provider = input.get("provider").and_then(Value::as_str);
    let session_type = normalize_session_type(input.get("provider"))
        .or_else(|| (legacy_provider == Some("claude")).then_some("freshclaude"));
    let provider = resolve_runtime_provider(session_type)
        .or_else(|| (legacy_provider == Some("claude")).then_some("claude"));
    let resume_in = input
        .get("resumeSessionId")
        .and_then(Value::as_str)
        .map(String::from);

    let (session_ref, durable_reason) =
        migrate_durable_state(provider, input.get("sessionRef"), resume_id_chain(input));
    let has_usable_identity = session_ref.is_some()
        || input
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
    let reason = read_restore_error(input.get("restoreError"))
        .or(durable_reason)
        .or_else(|| {
            (session_type.is_none() || provider.is_none() || !has_usable_identity)
                .then_some("invalid_legacy_restore_target")
        });

    let mut out = strip_legacy_keys(input);
    out.insert("kind".to_string(), json!("fresh-agent"));
    out.insert(
        "sessionType".to_string(),
        json!(session_type.unwrap_or("freshclaude")),
    );
    out.insert("provider".to_string(), json!(provider.unwrap_or("claude")));
    match reason {
        Some(reason) => {
            if reason != "invalid_legacy_restore_target" {
                if let Some(resume) = resume_in {
                    out.insert("resumeSessionId".to_string(), json!(resume));
                }
            }
            out.insert("restoreError".to_string(), restore_error(reason));
        }
        None => {
            if let Some(resume) = resume_in {
                out.insert("resumeSessionId".to_string(), json!(resume));
            }
            if let Some(session_ref) = session_ref {
                out.insert("sessionRef".to_string(), session_ref);
            }
        }
    }
    out
}

/// `normalizeRegistryPaneSnapshotInput` applied record-wide (types.ts:28-54):
/// each pane whose `kind` is `agent-chat`/`fresh-agent` runs the legacy
/// fresh-agent content migration over `{ kind, ...payload }`; when the result
/// is a `fresh-agent`, the pane's `kind` and `payload` are rewritten in place.
pub fn normalize_registry_pane_kinds(record: &mut serde_json::Value) {
    let Some(panes) = record.get_mut("panes").and_then(Value::as_array_mut) else {
        return;
    };
    for pane in panes {
        let Some(obj) = pane.as_object() else {
            continue;
        };
        let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind != "agent-chat" && kind != "fresh-agent" {
            continue;
        }
        // `{ kind: value.kind, ...payload }` — a `kind` INSIDE the payload
        // overrides the pane's own (JS spread semantics, types.ts:36-39).
        let mut compat = Map::new();
        compat.insert("kind".to_string(), json!(kind));
        if let Some(payload) = obj.get("payload").and_then(Value::as_object) {
            for (k, v) in payload {
                compat.insert(k.clone(), v.clone());
            }
        }
        let mut migrated = migrate_legacy_fresh_agent_content(&compat);
        if migrated.get("kind").and_then(Value::as_str) != Some("fresh-agent") {
            continue;
        }
        migrated.remove("kind");
        let obj = pane.as_object_mut().expect("checked above");
        obj.insert("kind".to_string(), json!("fresh-agent"));
        obj.insert("payload".to_string(), Value::Object(migrated));
    }
}

// ── Push-record caps (store.ts:418-436) ──────────────────────────────────────

/// `validateRecordPaneCaps` (store.ts:432-436): BOTH `panes.length` AND
/// `paneCount` are bounded.
fn validate_record_pane_caps(record: &Value, caps: &TabsStoreCaps) -> Result<(), String> {
    let pane_len = record
        .get("panes")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let pane_count = record.get("paneCount").and_then(Value::as_i64).unwrap_or(0);
    if pane_len > caps.max_panes_per_record || pane_count > caps.max_panes_per_record as i64 {
        return Err(format!(
            "Tabs registry record can contain at most {} panes",
            caps.max_panes_per_record
        ));
    }
    Ok(())
}

/// `validateRecordCaps` (store.ts:418-430): count cap, DUPLICATE tabKey
/// rejection, per-record pane caps.
pub fn validate_record_caps(
    records: &[serde_json::Value],
    caps: &TabsStoreCaps,
) -> Result<(), String> {
    if records.len() > caps.max_records_per_push {
        return Err(format!(
            "Tabs registry push can contain at most {} records",
            caps.max_records_per_push
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for record in records {
        let tab_key = record.get("tabKey").and_then(Value::as_str).unwrap_or("");
        if !seen.insert(tab_key.to_string()) {
            return Err(format!(
                "Tabs registry push contains duplicate tab key: {tab_key}"
            ));
        }
        validate_record_pane_caps(record, caps)?;
    }
    Ok(())
}

// ── Queued maintenance (store.ts:484-522) ────────────────────────────────────

pub(crate) fn closed_at_or_updated(record: &Value) -> i64 {
    record
        .get("closedAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| record_i64(record, "updatedAt"))
}

/// `applyQueuedMaintenance` (store.ts:484-522), in the original's exact order:
/// 1. open snapshots: TTL filter ONLY (30 min on `snapshot_received_at`; NO
///    count slice — overflow is REJECTED by [`validate_state_caps`] instead);
/// 2. client revisions: TTL (7d on `last_seen_at`) + LRU slice to
///    `max_client_revision_watermarks`;
/// 3. closed tombstones: retention filter (`closedAt ?? updatedAt`), sort
///    closed-desc, slice to `max_closed_tombstones`;
/// 4. devices: TTL (7d) + LRU slice to `max_devices`.
///
/// Where the original's stable JS sort falls back to insertion order on ties,
/// this port tiebreaks on the map key — `HashMap` has no insertion order, and
/// a deterministic tiebreak is the closest faithful deterministic choice.
pub fn apply_queued_maintenance(state: &mut CompactState, now: i64, caps: &TabsStoreCaps) {
    let open_cutoff = now - DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES * MINUTE_MS;
    let device_cutoff = now - DEFAULT_DEVICE_DISPLAY_TTL_DAYS * DAY_MS;

    state
        .open_snapshots_by_client
        .retain(|_, snapshot| snapshot.snapshot_received_at >= open_cutoff);

    let mut revisions: Vec<(String, ClientRevisionWatermark)> = state
        .client_revisions_by_client
        .drain()
        .filter(|(_, watermark)| watermark.last_seen_at >= device_cutoff)
        .collect();
    revisions.sort_by(|a, b| {
        b.1.last_seen_at
            .cmp(&a.1.last_seen_at)
            .then_with(|| a.0.cmp(&b.0))
    });
    revisions.truncate(caps.max_client_revision_watermarks);
    state.client_revisions_by_client = revisions.into_iter().collect();

    // `pruneClosedTombstones` (store.ts:470-482).
    let retention_cutoff = now - state.max_closed_retention_days * DAY_MS;
    let mut tombstones: Vec<Value> = state
        .closed_by_tab_key
        .drain()
        .map(|(_, record)| record)
        .filter(|record| closed_at_or_updated(record) >= retention_cutoff)
        .collect();
    tombstones
        .sort_by(|a, b| sort_by_closed_desc(a, b).then_with(|| source_key(a).cmp(&source_key(b))));
    tombstones.truncate(caps.max_closed_tombstones);
    state.closed_by_tab_key = tombstones
        .into_iter()
        .map(|record| {
            (
                record
                    .get("tabKey")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                record,
            )
        })
        .collect();

    let mut devices: Vec<(String, RegistryDeviceEntry)> = state
        .devices_by_id
        .drain()
        .filter(|(_, device)| device.last_seen_at >= device_cutoff)
        .collect();
    devices.sort_by(|a, b| {
        b.1.last_seen_at
            .cmp(&a.1.last_seen_at)
            .then_with(|| a.0.cmp(&b.0))
    });
    devices.truncate(caps.max_devices);
    state.devices_by_id = devices.into_iter().collect();

    state.saved_at = now;
}

// ── State-cap validation (store.ts:438-468) ──────────────────────────────────

fn component_bytes<T: serde::Serialize>(component: &T) -> usize {
    serde_json::to_value(component)
        .map(|v| canonical_stringify(&v).len())
        .unwrap_or(usize::MAX)
}

/// `validateStateCaps` (store.ts:438-468): snapshot-ref count, per-snapshot
/// open-record count (+ push-record caps), tombstone count, watermark count,
/// tombstone pane caps, device count, aggregate serialized state bytes. The
/// aggregate is the sum of `canonical_stringify(component).len()` over the
/// four components (this port's `CompactState` is not itself a JSON value).
pub fn validate_state_caps(state: &CompactState, caps: &TabsStoreCaps) -> Result<(), String> {
    if state.open_snapshots_by_client.len() > caps.max_client_snapshot_refs {
        return Err(format!(
            "Tabs registry can retain at most {} client snapshots",
            caps.max_client_snapshot_refs
        ));
    }
    for snapshot in state.open_snapshots_by_client.values() {
        if snapshot.records.len() > caps.max_open_records_per_client_snapshot {
            return Err(format!(
                "Tabs registry client snapshot can contain at most {} open records",
                caps.max_open_records_per_client_snapshot
            ));
        }
        validate_record_caps(&snapshot.records, caps)?;
    }
    if state.closed_by_tab_key.len() > caps.max_closed_tombstones {
        return Err(format!(
            "Tabs registry can retain at most {} closed tombstones",
            caps.max_closed_tombstones
        ));
    }
    if state.client_revisions_by_client.len() > caps.max_client_revision_watermarks {
        return Err(format!(
            "Tabs registry can retain at most {} client revision watermarks",
            caps.max_client_revision_watermarks
        ));
    }
    for record in state.closed_by_tab_key.values() {
        validate_record_pane_caps(record, caps)?;
    }
    if state.devices_by_id.len() > caps.max_devices {
        return Err(format!(
            "Tabs registry can retain at most {} devices",
            caps.max_devices
        ));
    }
    let state_bytes = component_bytes(&state.open_snapshots_by_client)
        .saturating_add(component_bytes(&state.client_revisions_by_client))
        .saturating_add(component_bytes(&state.closed_by_tab_key))
        .saturating_add(component_bytes(&state.devices_by_id));
    if state_bytes > caps.max_compact_state_bytes {
        return Err(format!(
            "Tabs registry compact state exceeds {} bytes",
            caps.max_compact_state_bytes
        ));
    }
    Ok(())
}

// ── Record field accessors + ordering (store.ts:341-365) ─────────────────────
// Moved here from `tabs.rs` (tabs.rs:443-508) so the in-memory registry and
// the durable store model share ONE implementation.

pub(crate) fn record_str(record: &Value, field: &str) -> Option<String> {
    record.get(field).and_then(Value::as_str).map(String::from)
}

pub(crate) fn record_status(record: &Value) -> String {
    record_str(record, "status").unwrap_or_default()
}

pub(crate) fn record_i64(record: &Value, field: &str) -> i64 {
    record.get(field).and_then(Value::as_i64).unwrap_or(0)
}

/// `sourceKey` (store.ts:341): the deterministic tiebreaker string.
pub(crate) fn source_key(record: &Value) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        record_str(record, "deviceId").unwrap_or_default(),
        record_str(record, "clientInstanceId").unwrap_or_default(),
        record_str(record, "tabKey").unwrap_or_default(),
        record_status(record),
        record_str(record, "tabId").unwrap_or_default(),
    )
}

/// `compareRegistryRecordsByEventTime` (store.ts:345): updatedAt, then
/// revision, then status (closed sorts *after* open), then sourceKey.
pub fn compare_by_event_time(a: &serde_json::Value, b: &serde_json::Value) -> std::cmp::Ordering {
    let ua = record_i64(a, "updatedAt");
    let ub = record_i64(b, "updatedAt");
    if ua != ub {
        return ua.cmp(&ub);
    }
    let ra = record_i64(a, "revision");
    let rb = record_i64(b, "revision");
    if ra != rb {
        return ra.cmp(&rb);
    }
    let sa = record_status(a);
    let sb = record_status(b);
    if sa != sb {
        return if sa == "closed" {
            Ordering::Greater
        } else {
            Ordering::Less
        };
    }
    source_key(a).cmp(&source_key(b))
}

/// `pickEventWinner` (store.ts:352) for two present records: the later record
/// wins; ties keep the incumbent (`a`).
pub fn pick_event_winner<'a>(
    a: &'a serde_json::Value,
    b: &'a serde_json::Value,
) -> &'a serde_json::Value {
    if compare_by_event_time(a, b).is_lt() {
        b
    } else {
        a
    }
}

/// `sortByUpdatedDesc` (store.ts:357).
pub(crate) fn sort_by_updated_desc(a: &Value, b: &Value) -> std::cmp::Ordering {
    record_i64(b, "updatedAt").cmp(&record_i64(a, "updatedAt"))
}

/// `sortByClosedDesc` (store.ts:361): `closedAt ?? updatedAt`, newest first.
pub(crate) fn sort_by_closed_desc(a: &Value, b: &Value) -> std::cmp::Ordering {
    closed_at_or_updated(b).cmp(&closed_at_or_updated(a))
}

#[cfg(test)]
mod tests;

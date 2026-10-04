//! Structural evidence and composition for Codex rollout continuations.
//!
//! The regular Codex parser is intentionally tolerant because it produces a
//! useful single-file display row from imperfect history. This module has a
//! stricter, separate scan: only a complete, owned file with known metadata
//! and a monotonic persisted-record interval can participate in a multi-file
//! session. The original per-file evidence stays in the directory-index
//! cache so a later refresh can reconsider the whole identity group.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use chrono::DateTime;
use serde_json::Value;

use crate::directory_index::IndexedSession;

const REQUIRED_METADATA: [&str; 6] = [
    "cwd",
    "source",
    "thread_source",
    "cli_version",
    "originator",
    "history_mode",
];

/// Codex 0.156's persisted `RolloutItemWire` variants. A continuation scan
/// must count every persisted record when establishing a complete interval,
/// even when the display parser does not interpret that record's payload.
const KNOWN_RECORD_TYPES: [&str; 12] = [
    "session_meta",
    "response_item",
    "inter_agent_communication",
    "inter_agent_communication_metadata",
    "compacted",
    "turn_context",
    "token_usage_record",
    "world_state",
    "retained_context",
    "security_risk_score",
    "event_msg",
    "realtime_item",
];

/// Per-file evidence retained in `FileEntry` independently of its renderable
/// `IndexedSession`. The id is sourced only from transcript metadata; a
/// filename-derived fallback is never continuation evidence.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CodexFileEvidence {
    /// The first known embedded id, even when ownership is incomplete. This
    /// lets the index quarantine a cwd-less or malformed sibling with its
    /// renderable same-id file.
    pub session_id: Option<String>,
    pub first_line_owned: bool,
    pub first_header_id: Option<Value>,
    pub first_header_session_id: Option<Value>,
    /// Exact structured values from the first session header. Missing values
    /// remain missing and therefore cannot be treated as matching evidence.
    pub required_metadata: BTreeMap<String, Value>,
    /// Every recognized fork, parent, subagent, and referenced-prefix marker
    /// from each top-level `session_meta` record, with its exact JSON value.
    pub lineage_markers: Vec<CodexLineageMarker>,
    pub header_count: usize,
    pub scan_complete: bool,
    pub record_count: usize,
    pub interval: Option<CodexRecordInterval>,
    /// A short, bounded set of structural reasons. This is internal cache
    /// evidence, never serialized into the client session-directory response.
    pub scan_errors: Vec<CodexSegmentScanError>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CodexLineageMarker {
    pub name: String,
    pub value: Value,
    pub header_index: usize,
}

/// Outer persisted-record bounds. Timestamps are stored as Unix nanoseconds
/// so millisecond ties and any supported sub-millisecond precision survive
/// cache serialization and strict cross-file comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CodexRecordInterval {
    pub start_nanos: i64,
    pub end_nanos: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "reason", content = "detail", rename_all = "snake_case")]
pub enum CodexSegmentScanError {
    MissingFinalNewline,
    EmptyRecord,
    MalformedJson,
    InvalidRecordShape,
    InvalidUtf8,
    UnknownRecordType(String),
    MissingTimestamp,
    InvalidTimestamp,
    TimestampRegression,
    InvalidOrdinal,
    OrdinalRegression,
}

/// Known-id members that could not be safely composed. All paths stay in the
/// Rust index; callers must not put them on the client wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexUnresolvedIdentity {
    pub session_id: String,
    pub paths: Vec<PathBuf>,
}

/// Result of applying the same composition policy to direct scans and the
/// cached session-index snapshot.
#[derive(Debug, Default)]
pub struct CodexComposition {
    pub items: Vec<IndexedSession>,
    pub unresolved_identities: Vec<CodexUnresolvedIdentity>,
    /// Chronological paths for accepted multi-file rows, keyed by canonical
    /// embedded id. This sidecar feeds bounded downstream search without
    /// changing `source_file`'s existing meaning.
    pub segment_paths: HashMap<String, Vec<PathBuf>>,
}

/// One per-file input to [`compose_codex_segments`].
#[derive(Debug, Clone)]
pub struct CodexSegmentEntry {
    pub path: PathBuf,
    pub item: Option<IndexedSession>,
    pub evidence: Option<CodexFileEvidence>,
}

/// Scan the complete JSONL stream for evidence suitable for continuation
/// composition. The display parser remains a separate, tolerant projection.
pub fn scan_codex_file_evidence(content: &str) -> CodexFileEvidence {
    let mut errors = Vec::new();
    let mut headers = Vec::<HeaderRecord>::new();
    let mut session_id = None;
    let mut min_record_nanos = None::<i64>;
    let mut max_record_nanos = None::<i64>;
    let mut previous_record_nanos = None::<i64>;
    let mut previous_ordinal = None::<u64>;
    let mut post_header_records = 0usize;

    if !content.ends_with('\n') {
        push_error(&mut errors, CodexSegmentScanError::MissingFinalNewline);
    }

    let lines: Vec<&str> = content
        .split_terminator('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();

    for (line_index, line) in lines.iter().enumerate() {
        if line.is_empty() {
            push_error(&mut errors, CodexSegmentScanError::EmptyRecord);
            continue;
        }

        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                push_error(&mut errors, CodexSegmentScanError::MalformedJson);
                continue;
            }
        };
        let Some(record) = value.as_object() else {
            push_error(&mut errors, CodexSegmentScanError::InvalidRecordShape);
            continue;
        };
        let Some(record_type) = record.get("type").and_then(Value::as_str) else {
            push_error(&mut errors, CodexSegmentScanError::InvalidRecordShape);
            continue;
        };
        if !KNOWN_RECORD_TYPES.contains(&record_type) {
            push_error(
                &mut errors,
                CodexSegmentScanError::UnknownRecordType(record_type.to_string()),
            );
        }

        let timestamp = match record.get("timestamp") {
            None => {
                push_error(&mut errors, CodexSegmentScanError::MissingTimestamp);
                None
            }
            Some(value) => match value.as_str().and_then(parse_rfc3339_nanos) {
                Some(nanos) => Some(nanos),
                None => {
                    push_error(&mut errors, CodexSegmentScanError::InvalidTimestamp);
                    None
                }
            },
        };

        if line_index == 0 {
            if let Some(timestamp) = timestamp {
                // The first session header timestamps creation, not a
                // persisted post-header write, so it is deliberately omitted
                // from the segment's chronology interval.
                let _header_timestamp_nanos = timestamp;
            }
        } else {
            post_header_records = post_header_records.saturating_add(1);
            if let Some(nanos) = timestamp {
                if previous_record_nanos.is_some_and(|previous| nanos < previous) {
                    push_error(&mut errors, CodexSegmentScanError::TimestampRegression);
                }
                previous_record_nanos = Some(nanos);
                min_record_nanos = Some(min_record_nanos.map_or(nanos, |min| min.min(nanos)));
                max_record_nanos = Some(max_record_nanos.map_or(nanos, |max| max.max(nanos)));
            }
        }

        if let Some(ordinal_value) = record.get("ordinal") {
            match ordinal_value.as_u64() {
                Some(ordinal) => {
                    if previous_ordinal.is_some_and(|previous| ordinal <= previous) {
                        push_error(&mut errors, CodexSegmentScanError::OrdinalRegression);
                    }
                    previous_ordinal = Some(ordinal);
                }
                None => push_error(&mut errors, CodexSegmentScanError::InvalidOrdinal),
            }
        }

        if record_type == "session_meta" {
            let payload = record.get("payload").and_then(Value::as_object);
            let header = payload.map(|payload| {
                let id = payload.get("id").cloned();
                let root_id = payload.get("session_id").cloned();
                let metadata = REQUIRED_METADATA
                    .iter()
                    .filter_map(|key| {
                        payload
                            .get(*key)
                            .cloned()
                            .map(|value| ((*key).to_string(), value))
                    })
                    .collect::<BTreeMap<_, _>>();
                let lineage_markers = collect_lineage_markers(payload, headers.len());
                let known_id = id
                    .as_ref()
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .or_else(|| {
                        root_id
                            .as_ref()
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                    })
                    .map(str::to_owned);
                if session_id.is_none() {
                    session_id = known_id;
                }
                HeaderRecord {
                    id,
                    session_id: root_id,
                    metadata,
                    lineage_markers,
                }
            });
            if let Some(header) = header {
                headers.push(header);
            } else {
                push_error(&mut errors, CodexSegmentScanError::InvalidRecordShape);
            }
        }
    }

    let first_header = headers.first();
    let first_line_owned = lines
        .first()
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .and_then(|record| {
            (record.get("type").and_then(Value::as_str) == Some("session_meta"))
                .then(|| record.get("payload").and_then(Value::as_object).is_some())
        })
        .unwrap_or(false);
    let first_header_id = first_header.and_then(|header| header.id.clone());
    let first_header_session_id = first_header.and_then(|header| header.session_id.clone());
    let identity_matches = first_header.is_some_and(|header| {
        header
            .id
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
            && header
                .session_id
                .as_ref()
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
            && header.id == header.session_id
    });
    if first_line_owned && !identity_matches {
        push_error(&mut errors, CodexSegmentScanError::InvalidRecordShape);
    }

    let required_metadata = first_header
        .map(|header| header.metadata.clone())
        .unwrap_or_default();
    let mut lineage_markers = Vec::new();
    for header in &headers {
        lineage_markers.extend(header.lineage_markers.iter().cloned());
    }

    let interval = match (post_header_records, min_record_nanos, max_record_nanos) {
        (count, Some(start_nanos), Some(end_nanos)) if count > 0 => Some(CodexRecordInterval {
            start_nanos,
            end_nanos,
        }),
        _ => None,
    };
    let scan_complete = errors.is_empty() && interval.is_some();

    CodexFileEvidence {
        session_id,
        first_line_owned,
        first_header_id,
        first_header_session_id,
        required_metadata,
        lineage_markers,
        header_count: headers.len(),
        scan_complete,
        record_count: lines.len(),
        interval,
        scan_errors: errors,
    }
}

/// Byte-oriented wrapper used for file reads. The display parser continues
/// to use lossy UTF-8 decoding, but replacement characters cannot certify a
/// complete persisted stream for composition.
pub fn scan_codex_file_bytes_evidence(bytes: &[u8]) -> CodexFileEvidence {
    match std::str::from_utf8(bytes) {
        Ok(content) => scan_codex_file_evidence(content),
        Err(_) => {
            let content = String::from_utf8_lossy(bytes);
            let mut evidence = scan_codex_file_evidence(&content);
            evidence.scan_complete = false;
            push_error(
                &mut evidence.scan_errors,
                CodexSegmentScanError::InvalidUtf8,
            );
            evidence
        }
    }
}

/// Compose only groups for which every discovered same-id member has
/// complete ownership, compatible required metadata, no recognized lineage
/// marker, and a strictly disjoint persisted-record interval. A failed group
/// keeps every renderable row and publishes every known member path for
/// quarantine.
pub fn compose_codex_segments(entries: Vec<CodexSegmentEntry>) -> CodexComposition {
    let mut groups = BTreeMap::<String, Vec<CodexSegmentEntry>>::new();
    let mut ungrouped = Vec::new();
    for entry in entries {
        if let Some(session_id) = entry
            .evidence
            .as_ref()
            .and_then(|evidence| evidence.session_id.clone())
        {
            groups.entry(session_id).or_default().push(entry);
        } else if let Some(item) = entry.item {
            ungrouped.push(item);
        }
    }

    let mut composition = CodexComposition {
        items: ungrouped,
        ..CodexComposition::default()
    };
    for (session_id, mut members) in groups {
        if members.len() == 1 {
            if let Some(item) = members.pop().and_then(|member| member.item) {
                composition.items.push(item);
            }
            continue;
        }

        let mut ordered = members;
        ordered.sort_by(|left, right| {
            let left_interval = left
                .evidence
                .as_ref()
                .and_then(|evidence| evidence.interval);
            let right_interval = right
                .evidence
                .as_ref()
                .and_then(|evidence| evidence.interval);
            left_interval
                .map(|interval| interval.start_nanos)
                .cmp(&right_interval.map(|interval| interval.start_nanos))
                .then_with(|| left.path.cmp(&right.path))
        });

        if can_compose_group(&session_id, &ordered) {
            let paths: Vec<PathBuf> = ordered.iter().map(|member| member.path.clone()).collect();
            let items: Vec<IndexedSession> = ordered
                .iter()
                .filter_map(|member| member.item.clone())
                .collect();
            composition.segment_paths.insert(session_id, paths);
            composition.items.push(merge_ordered_items(&ordered, items));
        } else {
            let mut paths: Vec<PathBuf> =
                ordered.iter().map(|member| member.path.clone()).collect();
            paths.sort();
            composition
                .unresolved_identities
                .push(CodexUnresolvedIdentity { session_id, paths });
            composition
                .items
                .extend(ordered.into_iter().filter_map(|member| member.item));
        }
    }
    composition
        .unresolved_identities
        .sort_by(|left, right| left.session_id.cmp(&right.session_id));
    composition
}

fn can_compose_group(session_id: &str, members: &[CodexSegmentEntry]) -> bool {
    let mut previous_end = None;
    let mut matching_metadata: Option<&BTreeMap<String, Value>> = None;

    for member in members {
        let Some(evidence) = member.evidence.as_ref() else {
            return false;
        };
        let Some(item) = member.item.as_ref() else {
            return false;
        };
        if !evidence.first_line_owned
            || evidence.header_count != 1
            || !evidence.scan_complete
            || evidence.session_id.as_deref() != Some(session_id)
            || evidence.first_header_id.as_ref().and_then(Value::as_str) != Some(session_id)
            || evidence
                .first_header_session_id
                .as_ref()
                .and_then(Value::as_str)
                != Some(session_id)
            || evidence.lineage_markers.len() > 0
            || item.provider != "codex"
            || item.session_id != session_id
            || item.is_subagent
        {
            return false;
        }
        if !REQUIRED_METADATA.iter().all(|key| {
            evidence
                .required_metadata
                .get(*key)
                .is_some_and(|value| match *key {
                    "cwd" | "cli_version" | "originator" => {
                        value.as_str().is_some_and(|text| !text.trim().is_empty())
                    }
                    "source" => supported_root_session_source(value),
                    // Only the reported user thread with paginated history
                    // certifies continuation; other classifications remain displayable.
                    "thread_source" => value.as_str() == Some("user"),
                    "history_mode" => value.as_str() == Some("paginated"),
                    _ => false,
                })
        }) {
            return false;
        }
        let Some(interval) = evidence.interval else {
            return false;
        };
        if previous_end.is_some_and(|end| end >= interval.start_nanos) {
            return false;
        }
        previous_end = Some(interval.end_nanos);

        if let Some(previous) = matching_metadata {
            if previous != &evidence.required_metadata {
                return false;
            }
        } else {
            matching_metadata = Some(&evidence.required_metadata);
        }
        if item.cwd.as_deref()
            != evidence
                .required_metadata
                .get("cwd")
                .and_then(Value::as_str)
        {
            return false;
        }
    }
    true
}

fn merge_ordered_items(
    members: &[CodexSegmentEntry],
    items: Vec<IndexedSession>,
) -> IndexedSession {
    let mut merged = items
        .last()
        .expect("a composable group has one renderable row per member")
        .clone();
    merged.created_at = items.iter().filter_map(|item| item.created_at).min();
    merged.last_activity_at = members
        .iter()
        .filter_map(|member| {
            member
                .evidence
                .as_ref()?
                .interval
                .map(|interval| nanos_to_millis(interval.end_nanos))
        })
        .chain(items.iter().map(|item| item.last_activity_at))
        .max()
        .unwrap_or(0);
    merged.first_user_message = items
        .iter()
        .find_map(|item| nonempty(item.first_user_message.as_ref()).cloned());
    merged.title = items
        .iter()
        .rev()
        .find_map(|item| nonempty(item.title.as_ref()).cloned());
    merged.summary = items
        .iter()
        .rev()
        .find_map(|item| nonempty(item.summary.as_ref()).cloned());
    merged.token_usage = items.iter().rev().find_map(|item| item.token_usage.clone());
    merged.source_file = members.last().map(|member| member.path.clone());
    merged
}

fn nonempty(value: Option<&String>) -> Option<&String> {
    value.filter(|value| !value.trim().is_empty())
}

/// Validate the 0.156 `SessionSource` shapes we can safely compare for root
/// Codex sessions. Unknown and internal/subagent sources do not certify a
/// user-visible continuation; custom sources are supported only in their
/// serialized enum form and are compared exactly across members.
fn supported_root_session_source(value: &Value) -> bool {
    match value {
        Value::String(source) => matches!(source.as_str(), "cli" | "vscode" | "exec" | "mcp"),
        Value::Object(fields) => {
            fields.len() == 1
                && fields
                    .get("custom")
                    .and_then(Value::as_str)
                    .is_some_and(|source| !source.trim().is_empty())
        }
        _ => false,
    }
}

fn collect_lineage_markers(
    payload: &serde_json::Map<String, Value>,
    header_index: usize,
) -> Vec<CodexLineageMarker> {
    const LINEAGE_FIELDS: [&str; 10] = [
        "forked_from_id",
        "forked_from_ordinal_exclusive",
        "parent_thread_id",
        "parent_id",
        "subagent_history_start_ordinal",
        "agent_nickname",
        "agent_role",
        "agent_path",
        "history_base",
        "is_subagent",
    ];

    let mut markers = Vec::new();
    for name in LINEAGE_FIELDS {
        if let Some(value) = payload.get(name) {
            markers.push(CodexLineageMarker {
                name: name.to_string(),
                value: value.clone(),
                header_index,
            });
        }
    }
    if let Some(source) = payload.get("source") {
        if let Some(subagent) = source.as_object().and_then(|source| source.get("subagent")) {
            markers.push(CodexLineageMarker {
                name: "source.subagent".to_string(),
                value: subagent.clone(),
                header_index,
            });
        }
    }
    markers
}

fn parse_rfc3339_nanos(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()?
        .timestamp_nanos_opt()
}

fn nanos_to_millis(nanos: i64) -> i64 {
    nanos.div_euclid(1_000_000)
}

fn push_error(errors: &mut Vec<CodexSegmentScanError>, error: CodexSegmentScanError) {
    const MAX_SCAN_ERRORS: usize = 8;
    if errors.len() < MAX_SCAN_ERRORS {
        errors.push(error);
    }
}

struct HeaderRecord {
    id: Option<Value>,
    session_id: Option<Value>,
    metadata: BTreeMap<String, Value>,
    lineage_markers: Vec<CodexLineageMarker>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_keeps_timestamp_precision_and_accepts_within_file_ties() {
        let content = concat!(
            "{\"timestamp\":\"2026-10-03T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"s\",\"session_id\":\"s\"}}\n",
            "{\"timestamp\":\"2026-10-03T00:00:01.123456Z\",\"type\":\"event_msg\",\"payload\":{}}\n",
            "{\"timestamp\":\"2026-10-03T00:00:01.123456Z\",\"type\":\"compacted\",\"payload\":{}}\n",
        );
        let evidence = scan_codex_file_evidence(content);
        assert!(evidence.scan_complete);
        let interval = evidence.interval.unwrap();
        assert_eq!(interval.start_nanos, interval.end_nanos);
        assert_eq!(interval.start_nanos % 1_000_000, 456_000);
    }

    #[test]
    fn record_scan_rejects_unknown_and_truncated_lines() {
        let unknown = concat!(
            "{\"timestamp\":\"2026-10-03T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"s\",\"session_id\":\"s\"}}\n",
            "{\"timestamp\":\"2026-10-03T00:00:01Z\",\"type\":\"future_variant\",\"payload\":{}}\n",
        );
        let evidence = scan_codex_file_evidence(unknown);
        assert!(!evidence.scan_complete);
        assert!(evidence
            .scan_errors
            .contains(&CodexSegmentScanError::UnknownRecordType(
                "future_variant".to_string()
            )));

        let truncated = unknown.trim_end();
        let evidence = scan_codex_file_evidence(truncated);
        assert!(!evidence.scan_complete);
        assert!(evidence
            .scan_errors
            .contains(&CodexSegmentScanError::MissingFinalNewline));
    }

    #[test]
    fn byte_scan_does_not_certify_lossy_utf8_replacements() {
        let mut bytes = concat!(
            "{\"timestamp\":\"2026-10-03T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"s\",\"session_id\":\"s\"}}\n",
            "{\"timestamp\":\"2026-10-03T00:00:01.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\""
        )
        .as_bytes()
        .to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(b"\"}}\n");

        let evidence = scan_codex_file_bytes_evidence(&bytes);
        assert_eq!(evidence.session_id.as_deref(), Some("s"));
        assert!(!evidence.scan_complete);
        assert!(evidence
            .scan_errors
            .contains(&CodexSegmentScanError::InvalidUtf8));
    }
}

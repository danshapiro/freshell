//! Read-only reconstruction of Codex's selected, referenced rollout history.
//!
//! Logical thread identities stay stable after revert. A history_base points
//! at a physical rollout UUID and inherits only its specified byte/ordinal
//! prefix. Never concatenate superseded tails or guess a different DB head.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::NaiveDateTime;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use uuid::Uuid;

use crate::codex_segments::{
    compose_codex_segments, scan_codex_file_bytes_evidence, supported_root_session_source,
    CodexComposition, CodexFileEvidence, CodexSegmentEntry, CodexUnresolvedIdentity,
};
use crate::directory_index::{parse_codex_content, IndexedSession};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CodexHistoryBoundary {
    pub end_byte_offset: u64,
    pub end_ordinal_exclusive: u64,
}

/// A selected physical file, optionally restricted to an inherited prefix.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CodexHistorySegment {
    pub path: PathBuf,
    pub end: Option<CodexHistoryBoundary>,
}

impl CodexHistorySegment {
    /// Read exactly the retained range, without touching its superseded tail.
    /// Validate it again because downstream search may run after discovery.
    pub fn read(&self) -> io::Result<Vec<u8>> {
        let bytes = self.read_bytes(None)?;
        if self.end.is_some() {
            validate_bytes(&bytes, self.end).map_err(|error| invalid_data(&error.detail))?;
        }
        Ok(bytes)
    }

    fn read_bytes(&self, snapshot_len: Option<u64>) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        let file = File::open(&self.path)?;
        let limit = match self.end {
            Some(end) => end.end_byte_offset,
            None => snapshot_len.unwrap_or(file.metadata()?.len()),
        };
        file.take(limit).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != limit {
            return Err(invalid_data(
                "source rollout is shorter than the selected byte range",
            ));
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    size: u64,
    modified_nanos: u128,
}

impl FileStamp {
    fn read(path: &Path) -> Result<Self, HistoryError> {
        let metadata = fs::metadata(path)
            .map_err(|error| HistoryError::at("source_unreadable", path, error))?;
        let modified_nanos = metadata
            .modified()
            .and_then(|time| time.duration_since(UNIX_EPOCH).map_err(io::Error::other))
            .map_err(|error| HistoryError::at("source_unreadable", path, error))?
            .as_nanos();
        Ok(Self {
            path: path.to_owned(),
            size: metadata.len(),
            modified_nanos,
        })
    }
}

#[derive(Debug, Clone)]
struct CachedHistory {
    item: IndexedSession,
    segments: Vec<CodexHistorySegment>,
    revision: u64,
    dependencies: Vec<FileStamp>,
    // Record physical bindings too: a newly introduced duplicate must not
    // evade validation merely because the selected bytes did not change.
    bindings: Vec<(Uuid, PathBuf)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HistoryError {
    reason: &'static str,
    detail: String,
}

impl HistoryError {
    fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
    fn at(reason: &'static str, path: &Path, error: impl std::fmt::Display) -> Self {
        Self::new(reason, format!("{}: {error}", path.display()))
    }
}

#[derive(Debug, Clone, Copy)]
struct RolloutName {
    logical: Uuid,
    physical: Uuid,
    timestamp: NaiveDateTime,
}

fn rollout_name(path: &Path) -> Option<RolloutName> {
    let name = path
        .file_name()?
        .to_str()?
        .strip_prefix("rollout-")?
        .strip_suffix(".jsonl")?;
    let timestamp = NaiveDateTime::parse_from_str(name.get(..19)?, "%Y-%m-%dT%H-%M-%S").ok()?;
    if name.get(19..20)? != "-" {
        return None;
    }
    let ids = name.get(20..)?;
    let (logical, physical) = ids.split_once('_').unwrap_or((ids, ids));
    Some(RolloutName {
        logical: Uuid::parse_str(logical).ok()?,
        physical: Uuid::parse_str(physical).ok()?,
        timestamp,
    })
}

#[derive(Default)]
struct Catalog {
    paths: HashMap<Uuid, Vec<PathBuf>>,
}

impl Catalog {
    fn add(&mut self, path: PathBuf) {
        if let Some(name) = rollout_name(&path) {
            let paths = self.paths.entry(name.physical).or_default();
            if !paths.contains(&path) {
                paths.push(path);
                paths.sort();
            }
        }
    }
    fn unique(&self, physical: Uuid) -> Result<PathBuf, HistoryError> {
        match self.paths.get(&physical).map(Vec::as_slice) {
            Some([path]) => Ok(path.clone()),
            Some(_) => Err(HistoryError::new(
                "ambiguous_rollout",
                format!("physical rollout {physical} has multiple files"),
            )),
            None => Err(HistoryError::new(
                "missing_reference",
                format!("physical rollout {physical} was not found"),
            )),
        }
    }
}

/// Stateful reconstruction cache owned by one Codex discovery source.
#[derive(Debug)]
pub struct CodexHistoryResolver {
    codex_home: PathBuf,
    cache: HashMap<String, CachedHistory>,
    warnings: HashMap<String, (String, String)>,
    #[cfg(test)]
    reads: usize,
    #[cfg(test)]
    after_read: Option<fn(&Path)>,
}

impl CodexHistoryResolver {
    pub fn new(codex_home: PathBuf) -> Self {
        Self {
            codex_home,
            cache: HashMap::new(),
            warnings: HashMap::new(),
            #[cfg(test)]
            reads: 0,
            #[cfg(test)]
            after_read: None,
        }
    }

    pub fn compose(&mut self, entries: Vec<CodexSegmentEntry>) -> CodexComposition {
        let db = self.database_selection();
        // Fork/subagent ancestry is outside root continuation reconstruction.
        // Preserve the old own-file projection for a single explicit child;
        // the conservative composer still quarantines same-id child groups.
        let child_ids: HashSet<String> = entries
            .iter()
            .filter_map(|entry| {
                let evidence = entry.evidence.as_ref()?;
                explicit_child_lineage(evidence)
                    .then(|| evidence.session_id.clone())
                    .flatten()
            })
            .collect();
        let mut referenced_ids: HashSet<String> = entries
            .iter()
            .filter_map(|entry| {
                let evidence = entry.evidence.as_ref()?;
                (evidence
                    .lineage_markers
                    .iter()
                    .any(|marker| marker.name == "history_base")
                    || (evidence
                        .required_metadata
                        .get("history_mode")
                        .and_then(Value::as_str)
                        == Some("paginated")
                        && rollout_name(&entry.path)
                            .is_some_and(|name| name.logical != name.physical)))
                .then(|| evidence.session_id.clone())
                .flatten()
            })
            .collect();
        if let Ok(rows) = &db {
            for entry in &entries {
                if let Some(id) = entry
                    .evidence
                    .as_ref()
                    .and_then(|evidence| evidence.session_id.as_ref())
                {
                    if rows.get(id).is_some_and(|row| {
                        row.history_mode == "paginated"
                            && (row.archived
                                || rollout_name(&row.path)
                                    .is_some_and(|name| name.logical != name.physical))
                    }) {
                        referenced_ids.insert(id.clone());
                    }
                }
            }
        }
        referenced_ids.retain(|id| !child_ids.contains(id));
        let mut ordinary = Vec::new();
        let mut groups = BTreeMap::<String, Vec<CodexSegmentEntry>>::new();
        let mut catalog = Catalog::default();
        for entry in entries {
            catalog.add(entry.path.clone());
            match entry
                .evidence
                .as_ref()
                .and_then(|evidence| evidence.session_id.as_ref())
            {
                Some(id) if referenced_ids.contains(id) => {
                    groups.entry(id.clone()).or_default().push(entry)
                }
                _ => ordinary.push(entry),
            }
        }
        self.cache.retain(|id, _| referenced_ids.contains(id));
        self.warnings.retain(|id, _| referenced_ids.contains(id));
        let mut result = compose_codex_segments(ordinary);
        if groups.is_empty() {
            return result;
        }
        let archive_result =
            add_archive_paths(&self.codex_home.join("archived_sessions"), &mut catalog);
        for (id, members) in groups {
            let resolved =
                self.selected_head(&id, &members, &db)
                    .and_then(|selected| match selected {
                        SelectedHead::Archived => Ok(None),
                        SelectedHead::Path(path) => validate_group_members(&id, &members)
                            .and_then(|_| archive_result.as_ref().map_err(Clone::clone))
                            .and_then(|_| self.resolve(&id, &path, &catalog).map(Some)),
                    });
            match resolved {
                Ok(Some(history)) => {
                    self.warnings.remove(&id);
                    result.segment_paths.insert(
                        id.clone(),
                        history
                            .segments
                            .iter()
                            .map(|segment| segment.path.clone())
                            .collect(),
                    );
                    result
                        .history_segments
                        .insert(id.clone(), history.segments.clone());
                    result
                        .history_revisions
                        .insert(id.clone(), history.revision);
                    result.items.push(history.item.clone());
                    self.cache.insert(id, history);
                }
                Ok(None) => {
                    self.warnings.remove(&id);
                    self.cache.remove(&id);
                }
                Err(error) => {
                    self.cache.remove(&id);
                    let signature = (error.reason.to_owned(), error.detail.clone());
                    if self.warnings.get(&id) != Some(&signature) {
                        tracing::warn!(event = "codex_history_unresolved", session_id = %id, reason = error.reason, detail = %error.detail,
                            "Codex selected history could not be reconstructed");
                        self.warnings.insert(id.clone(), signature);
                    }
                    let mut paths: Vec<_> =
                        members.iter().map(|member| member.path.clone()).collect();
                    paths.sort();
                    paths.dedup();
                    result.unresolved_identities.push(CodexUnresolvedIdentity {
                        session_id: id,
                        paths,
                    });
                    result
                        .items
                        .extend(members.into_iter().filter_map(|member| member.item));
                }
            }
        }
        result
            .unresolved_identities
            .sort_by(|left, right| left.session_id.cmp(&right.session_id));
        result
    }

    fn selected_head(
        &self,
        id: &str,
        members: &[CodexSegmentEntry],
        db: &Result<HashMap<String, DatabaseRow>, HistoryError>,
    ) -> Result<SelectedHead, HistoryError> {
        if let Some(row) = db.as_ref().map_err(Clone::clone)?.get(id) {
            if row.archived {
                return Ok(SelectedHead::Archived);
            }
            if row.history_mode != "paginated" {
                return Err(HistoryError::new(
                    "unsupported_history_mode",
                    "selected database row is not paginated",
                ));
            }
            let path = if row.path.is_absolute() {
                row.path.clone()
            } else {
                self.codex_home.join(&row.path)
            };
            if !path.is_file() {
                return Err(HistoryError::at(
                    "selected_head_missing",
                    &path,
                    "database-selected rollout does not exist",
                ));
            }
            return Ok(SelectedHead::Path(path));
        }
        let logical = Uuid::parse_str(id).map_err(|_| {
            HistoryError::new("invalid_identity", "logical thread id is not a UUID")
        })?;
        members
            .iter()
            .filter_map(|member| {
                let name = rollout_name(&member.path)?;
                (name.logical == logical).then_some((
                    name.timestamp,
                    name.physical,
                    member.path.clone(),
                ))
            })
            .max_by(|left, right| (left.0, left.1).cmp(&(right.0, right.1)))
            .map(|(_, _, path)| SelectedHead::Path(path))
            .ok_or_else(|| {
                HistoryError::new(
                    "invalid_filename",
                    "selected history has no canonical rollout filename",
                )
            })
    }

    fn database_selection(&self) -> Result<HashMap<String, DatabaseRow>, HistoryError> {
        let path = self.codex_home.join("state_5.sqlite");
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let read_error = |error| HistoryError::at("state_db_unreadable", &path, error);
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(read_error)?;
        let mut statement = connection
            .prepare("SELECT id, rollout_path, history_mode, archived FROM threads")
            .map_err(read_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    DatabaseRow {
                        path: PathBuf::from(row.get::<_, String>(1)?),
                        history_mode: row.get(2)?,
                        archived: row.get::<_, i64>(3)? != 0,
                    },
                ))
            })
            .map_err(read_error)?;
        rows.map(|row| row.map_err(read_error)).collect()
    }

    fn resolve(
        &mut self,
        id: &str,
        head: &Path,
        catalog: &Catalog,
    ) -> Result<CachedHistory, HistoryError> {
        if let Some(cached) = self.cache.get(id) {
            if cached.item.source_file.as_deref() == Some(head)
                && cached
                    .bindings
                    .iter()
                    .all(|(physical, path)| catalog.unique(*physical).as_ref() == Ok(path))
                && cached
                    .dependencies
                    .iter()
                    .all(|stamp| FileStamp::read(&stamp.path).as_ref() == Ok(stamp))
            {
                return Ok(cached.clone());
            }
        }
        let logical = Uuid::parse_str(id).map_err(|_| {
            HistoryError::new("invalid_identity", "logical thread id is not a UUID")
        })?;
        let mut path = head.to_owned();
        let mut end = None;
        let mut seen = HashSet::new();
        let mut segments = Vec::new();
        let mut bytes_by_segment = Vec::new();
        let mut dependencies = Vec::new();
        let mut bindings = Vec::new();
        let root_creation_ms = loop {
            let name = rollout_name(&path).ok_or_else(|| {
                HistoryError::at(
                    "invalid_filename",
                    &path,
                    "not a canonical plain rollout filename",
                )
            })?;
            if name.logical != logical {
                return Err(HistoryError::at(
                    "identity_mismatch",
                    &path,
                    "reference belongs to another logical thread",
                ));
            }
            if !seen.insert(name.physical) {
                return Err(HistoryError::new(
                    "cycle",
                    "history references contain a cycle",
                ));
            }
            let binding = catalog.unique(name.physical)?;
            if binding != path {
                return Err(HistoryError::at(
                    "identity_mismatch",
                    &path,
                    "selected path is not its physical rollout binding",
                ));
            }
            let before = FileStamp::read(&path)?;
            if end.is_some_and(|boundary: CodexHistoryBoundary| {
                boundary.end_byte_offset > before.size
            }) {
                return Err(HistoryError::at(
                    "invalid_boundary",
                    &path,
                    "cutoff byte offset is past the source rollout",
                ));
            }
            let segment = CodexHistorySegment {
                path: path.clone(),
                end,
            };
            #[cfg(test)]
            {
                self.reads += 1;
            }
            let bytes = segment
                .read_bytes(Some(before.size))
                .map_err(|error| HistoryError::at("source_unreadable", &path, error))?;
            #[cfg(test)]
            if let Some(after_read) = self.after_read {
                after_read(&path);
            }
            let after = FileStamp::read(&path)?;
            if before != after && after.size <= before.size {
                return Err(HistoryError::at(
                    "source_changed",
                    &path,
                    "rollout changed during reconstruction",
                ));
            }
            let header = validate_bytes(&bytes, end).map_err(|mut error| {
                error.detail = format!("{}: {}", path.display(), error.detail);
                error
            })?;
            validate_header_identity(&header.evidence, id, &path)?;
            let base = header.base;
            // Appends after the captured size do not invalidate a complete
            // snapshot. Keep its earlier stamp so the next refresh rereads
            // new records rather than caching old bytes as the newer file.
            dependencies.push(before);
            bindings.push((name.physical, path));
            segments.push(segment);
            bytes_by_segment.push(bytes);
            let Some(base) = base else {
                break header.creation_ms;
            };
            path = catalog.unique(base.physical)?;
            end = Some(base.boundary);
        };
        segments.reverse();
        bytes_by_segment.reverse();
        let head_bytes = bytes_by_segment
            .last()
            .expect("a reconstructed history contains its head");
        let head_header_end = head_bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("validated header is newline terminated")
            + 1;
        let mut effective = head_bytes[..head_header_end].to_vec();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for bytes in &bytes_by_segment {
            bytes.hash(&mut hasher);
            let body_start = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .expect("validated header is newline terminated")
                + 1;
            effective.extend_from_slice(&bytes[body_start..]);
        }
        let content =
            std::str::from_utf8(&effective).expect("each selected segment was validated as UTF-8");
        let mut item = parse_codex_content(content, head).ok_or_else(|| {
            HistoryError::new(
                "unrenderable_history",
                "selected history has no displayable session metadata",
            )
        })?;
        item.created_at = Some(root_creation_ms);
        Ok(CachedHistory {
            item,
            segments,
            revision: hasher.finish(),
            dependencies,
            bindings,
        })
    }
}

// Validate every candidate before consulting the selected-history cache: an
// unclassified same-id copy must remain visible in quarantine diagnostics.
// Canonical same-logical physical branches remain provider-selectable.
fn validate_group_members(id: &str, members: &[CodexSegmentEntry]) -> Result<(), HistoryError> {
    let logical = Uuid::parse_str(id)
        .map_err(|_| HistoryError::new("invalid_identity", "logical thread id is not a UUID"))?;
    let mut paths: Vec<_> = members.iter().map(|member| &member.path).collect();
    paths.sort();
    for path in paths {
        let name = rollout_name(path).ok_or_else(|| {
            HistoryError::at(
                "invalid_filename",
                path,
                "same-id member does not have a canonical rollout filename",
            )
        })?;
        if name.logical != logical {
            return Err(HistoryError::at(
                "identity_mismatch",
                path,
                "filename logical UUID does not match the embedded thread identity",
            ));
        }
    }
    Ok(())
}

fn explicit_child_lineage(evidence: &CodexFileEvidence) -> bool {
    evidence
        .lineage_markers
        .iter()
        .filter(|marker| marker.header_index == 0)
        .any(|marker| match marker.name.as_str() {
            "history_base" => false,
            "is_subagent" => marker.value.as_bool() == Some(true),
            _ => !marker.value.is_null(),
        })
}

enum SelectedHead {
    Path(PathBuf),
    Archived,
}
struct DatabaseRow {
    path: PathBuf,
    history_mode: String,
    archived: bool,
}
#[derive(Debug, Clone, Copy)]
struct HistoryBase {
    physical: Uuid,
    boundary: CodexHistoryBoundary,
}
struct Header {
    evidence: CodexFileEvidence,
    base: Option<HistoryBase>,
    creation_ms: i64,
}

fn validate_bytes(bytes: &[u8], end: Option<CodexHistoryBoundary>) -> Result<Header, HistoryError> {
    let content = std::str::from_utf8(bytes)
        .map_err(|_| HistoryError::new("invalid_utf8", "selected prefix is not UTF-8"))?;
    if !content.ends_with('\n') {
        return Err(HistoryError::new(
            "invalid_boundary",
            "selected prefix does not end at a JSONL record boundary",
        ));
    }
    let evidence = scan_codex_file_bytes_evidence(bytes);
    if !evidence.scan_errors.is_empty() || !evidence.first_line_owned || evidence.header_count != 1
    {
        return Err(HistoryError::new(
            "invalid_segment",
            format!(
                "selected prefix has invalid structural evidence: {:?}",
                evidence.scan_errors
            ),
        ));
    }
    let first = content
        .lines()
        .next()
        .ok_or_else(|| HistoryError::new("invalid_segment", "selected prefix is empty"))?;
    let header: Value = serde_json::from_str(first)
        .map_err(|_| HistoryError::new("invalid_segment", "invalid session header"))?;
    let payload = &header["payload"];
    let base = match payload.get("history_base") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let physical = value
                .get("thread_id")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())
                .ok_or_else(|| {
                    HistoryError::new(
                        "invalid_reference",
                        "history_base has no physical rollout UUID",
                    )
                })?;
            let end_byte_offset = value
                .get("end_byte_offset")
                .and_then(Value::as_u64)
                .filter(|offset| *offset > 0)
                .ok_or_else(|| {
                    HistoryError::new(
                        "invalid_boundary",
                        "history_base byte offset is missing or zero",
                    )
                })?;
            let end_ordinal_exclusive = value
                .get("end_ordinal_exclusive")
                .and_then(Value::as_u64)
                .filter(|ordinal| *ordinal > 0)
                .ok_or_else(|| {
                    HistoryError::new(
                        "invalid_boundary",
                        "history_base ordinal is missing or zero",
                    )
                })?;
            Some(HistoryBase {
                physical,
                boundary: CodexHistoryBoundary {
                    end_byte_offset,
                    end_ordinal_exclusive,
                },
            })
        }
    };
    let mut expected = base.map_or(0, |base| base.boundary.end_ordinal_exclusive);
    for line in content.lines() {
        let record: Value = serde_json::from_str(line)
            .map_err(|_| HistoryError::new("invalid_segment", "invalid JSONL record"))?;
        if record.get("ordinal").and_then(Value::as_u64) != Some(expected) {
            return Err(HistoryError::new(
                "invalid_ordinal",
                format!("selected record must have ordinal {expected}"),
            ));
        }
        if end.is_some_and(|end| expected >= end.end_ordinal_exclusive) {
            return Err(HistoryError::new(
                "invalid_boundary",
                "byte prefix includes a record at or beyond its exclusive ordinal",
            ));
        }
        expected = expected.checked_add(1).ok_or_else(|| {
            HistoryError::new("invalid_ordinal", "selected record ordinal overflow")
        })?;
    }
    if end.is_some_and(|end| expected != end.end_ordinal_exclusive) {
        return Err(HistoryError::new(
            "invalid_boundary",
            "byte and ordinal boundaries select different prefixes",
        ));
    }
    let creation_ms = header
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.timestamp_millis())
        .ok_or_else(|| {
            HistoryError::new(
                "invalid_segment",
                "session header has no valid outer timestamp",
            )
        })?;
    Ok(Header {
        evidence,
        base,
        creation_ms,
    })
}

fn validate_header_identity(
    evidence: &CodexFileEvidence,
    id: &str,
    path: &Path,
) -> Result<(), HistoryError> {
    if evidence.session_id.as_deref() != Some(id)
        || evidence.first_header_id.as_ref().and_then(Value::as_str) != Some(id)
        || evidence
            .first_header_session_id
            .as_ref()
            .and_then(Value::as_str)
            != Some(id)
    {
        return Err(HistoryError::at(
            "identity_mismatch",
            path,
            "header id and session_id must match the logical thread",
        ));
    }
    if evidence
        .lineage_markers
        .iter()
        .any(|marker| marker.name != "history_base")
    {
        return Err(HistoryError::at(
            "unsupported_lineage",
            path,
            "fork or subagent lineage cannot certify a root continuation",
        ));
    }
    let metadata = &evidence.required_metadata;
    if !["cwd", "cli_version", "originator"].iter().all(|key| {
        metadata
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    }) || !metadata
        .get("source")
        .is_some_and(supported_root_session_source)
        || metadata.get("thread_source").and_then(Value::as_str) != Some("user")
        || metadata.get("history_mode").and_then(Value::as_str) != Some("paginated")
    {
        return Err(HistoryError::at(
            "unsupported_metadata",
            path,
            "selected history is not a known paginated root user session",
        ));
    }
    Ok(())
}

fn add_archive_paths(root: &Path, catalog: &mut Catalog) -> Result<(), HistoryError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(HistoryError::at("archive_unreadable", root, error)),
    };
    for entry in entries {
        let entry = entry.map_err(|error| HistoryError::at("archive_unreadable", root, error))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| HistoryError::at("archive_unreadable", &path, error))?;
        if kind.is_dir() {
            add_archive_paths(&path, catalog)?;
        } else if kind.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        {
            catalog.add(path);
        }
    }
    Ok(())
}

fn invalid_data(detail: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail.to_owned())
}

#[cfg(test)]
#[path = "codex_history_tests.rs"]
mod tests;

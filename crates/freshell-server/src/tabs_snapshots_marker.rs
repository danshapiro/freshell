//! Write-ahead restore marker: the on-disk idempotency ledger for
//! `POST /api/tabs-sync/restore` (`tabs_snapshots.rs`). Split into its own
//! `#[path]`-included module to keep the handler file under the repo's
//! 1,000-line-per-file limit.
//!
//! FORMAT (v2, multi-source): one `last-restore.marker` per device dir holding
//! EVERY source's pane history:
//!
//! ```json
//! { "version": 2,
//!   "sources": { "<sourceId>": { "at": 123, "panes": {
//!       "<tabKey>#<paneId>": { "state": "in-progress|restored", "terminalId": null } } } } }
//! ```
//!
//! Keeping history per `(deviceId, sourceId)` (NOT a single last-source entry)
//! is what makes restore idempotent across source switches: restoring source
//! A, then B, then A again must still see A's `restored` panes and skip them
//! (`tabs_snapshots.rs:304`). A v1 single-source marker (top-level
//! `sourceId`/`panes`) is migrated on read.
//!
//! READS FAIL LOUD (`tabs_snapshots.rs:306`): this file is the SOLE
//! idempotency record, so an unreadable or unparsable marker is an `Err` the
//! handler surfaces as HTTP 409 with recovery instructions — NEVER an empty
//! marker (which would read as "nothing restored yet" and duplicate every
//! previously-restored tab on an ordinary rerun).

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use serde::ser::{SerializeMap, SerializeStruct};
use serde::Serialize;
use serde_json::Value;

pub(super) const RESTORE_MARKER: &str = "last-restore.marker"; // .marker ext -> invisible to *.json listing

/// In-flight temp filename for the atomic marker write. Deliberately `.new`,
/// NOT `.tmp`: freshell-ws's `sweep_orphan_tmp` reaps every `*.tmp` in this
/// SAME device dir. Marker IO now runs under the SHARED
/// `freshell_ws::tabs_persist::with_persist_lock`, so the sweep can no longer
/// run mid-write — the `.new` name stays as defense-in-depth (pinned by
/// `marker_in_flight_temp_is_invisible_to_the_ws_orphan_tmp_sweep` and the
/// freshell-ws sweep test).
pub(super) const RESTORE_MARKER_TMP: &str = ".last-restore.marker.new";
/// Bound the per-device restore history independently of source churn. This
/// matches the maximum number of retained generation files for one device, so
/// marker IO and disk usage cannot grow without limit.
pub(super) const MAX_RESTORE_MARKER_SOURCES: usize =
    freshell_ws::tabs_persist::MAX_SNAPSHOT_FILES_PER_DEVICE;
/// One device retains at most 40 MiB of snapshot-generation payload. Allow a
/// 64 MiB marker so ordinary ledger overhead fits while marker disk/memory use
/// remains explicitly bounded.
pub(super) const MAX_RESTORE_MARKER_BYTES: usize =
    64 * freshell_ws::tabs_persist::MAX_SNAPSHOT_BYTES;
/// A valid pane occupies more than 32 serialized bytes in its source snapshot,
/// so this accommodates every pane that could fit in all 40 retained files.
pub(super) const MAX_RESTORE_MARKER_PANES_PER_SOURCE: usize =
    freshell_ws::tabs_persist::MAX_SNAPSHOT_FILES_PER_DEVICE
        * (freshell_ws::tabs_persist::MAX_SNAPSHOT_BYTES / 32);
/// Content source ids are 32 hex bytes today; leave room for future digests.
pub(super) const MAX_RESTORE_MARKER_SOURCE_ID_BYTES: usize = 128;
/// Browser-generated tab/pane ids are short. 64 KiB is deliberately generous
/// while preventing repeated tab keys from amplifying one marker without bound.
pub(super) const MAX_RESTORE_MARKER_PANE_KEY_BYTES: usize = 64 * 1024;
/// Terminal ids are UUID-shaped today; leave room for future formats.
pub(super) const MAX_RESTORE_MARKER_TERMINAL_ID_BYTES: usize = 128;

/// One pane's marker state (`in-progress` = write-ahead, side-effect may exist,
/// delivery NOT yet confirmed; `restored` = delivery-acked). `terminal_id` is
/// recorded once the create returns, for crash reconciliation.
#[derive(Clone)]
pub(super) struct PaneMark {
    pub state: String,
    pub terminal_id: Option<String>,
}
/// paneKey -> mark, for ONE source.
pub(super) type Marker = HashMap<String, PaneMark>;
/// sourceId -> (at, panes): the whole on-disk ledger.
pub(super) type MarkerDoc = HashMap<String, (i64, Marker)>;

fn marker_limit(path: &Path, why: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("restore marker {} limit exceeded: {why}", path.display()),
    )
}

fn validate_identifier(
    path: &Path,
    name: &str,
    value: &str,
    max_bytes: usize,
) -> std::io::Result<()> {
    if value.is_empty() {
        return Err(marker_limit(path, format!("{name} must be non-empty")));
    }
    if value.len() > max_bytes {
        return Err(marker_limit(
            path,
            format!(
                "{name} identifier length limit is {max_bytes} bytes (got {})",
                value.len()
            ),
        ));
    }
    Ok(())
}

pub(super) fn validate_marker_pane_count(
    path: &Path,
    source_id: &str,
    pane_count: usize,
) -> std::io::Result<()> {
    if pane_count > MAX_RESTORE_MARKER_PANES_PER_SOURCE {
        return Err(marker_limit(
            path,
            format!(
                "source `{source_id}` pane-count limit is {MAX_RESTORE_MARKER_PANES_PER_SOURCE} (got {pane_count})"
            ),
        ));
    }
    Ok(())
}

fn parse_panes(path: &Path, source_id: &str, value: &Value) -> std::io::Result<Marker> {
    let map = value.as_object().ok_or_else(|| {
        corrupt(
            path,
            format!("source `{source_id}` `panes` is not an object"),
        )
    })?;
    validate_marker_pane_count(path, source_id, map.len())?;
    let mut out = Marker::new();
    for (key, pane) in map {
        validate_identifier(
            path,
            &format!("source `{source_id}` pane key"),
            key,
            MAX_RESTORE_MARKER_PANE_KEY_BYTES,
        )?;
        let pane = pane.as_object().ok_or_else(|| {
            corrupt(
                path,
                format!("source `{source_id}` pane `{key}` is not an object"),
            )
        })?;
        let state = pane
            .get("state")
            .and_then(Value::as_str)
            .filter(|state| matches!(*state, "in-progress" | "restored"))
            .ok_or_else(|| {
                corrupt(
                    path,
                    format!("source `{source_id}` pane `{key}` has an invalid or missing `state`"),
                )
            })?
            .to_string();
        let terminal_id = match pane.get("terminalId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => {
                validate_identifier(
                    path,
                    &format!("source `{source_id}` pane `{key}` terminal id"),
                    id,
                    MAX_RESTORE_MARKER_TERMINAL_ID_BYTES,
                )?;
                Some(id.clone())
            }
            Some(_) => {
                return Err(corrupt(
                    path,
                    format!(
                        "source `{source_id}` pane `{key}` `terminalId` must be null or a non-empty string"
                    ),
                ))
            }
        };
        out.insert(key.clone(), PaneMark { state, terminal_id });
    }
    Ok(out)
}

fn corrupt(path: &Path, why: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("corrupt restore marker {}: {why}", path.display()),
    )
}

/// Read the WHOLE marker ledger. A MISSING file is genuine absence
/// (`Ok(empty)`); an unreadable file or unparsable/unrecognized content is an
/// `Err` (fail LOUD — see module doc). Blocking fs — call via `spawn_blocking`
/// under `freshell_ws::tabs_persist::with_persist_lock`.
pub(super) fn read_marker_doc(device_dir: &Path) -> std::io::Result<MarkerDoc> {
    let path = device_dir.join(RESTORE_MARKER);
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_RESTORE_MARKER_BYTES as u64 => {
            return Err(marker_limit(
                &path,
                format!(
                    "serialized byte limit is {MAX_RESTORE_MARKER_BYTES} (got {})",
                    metadata.len()
                ),
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(MarkerDoc::new()),
        Err(error) => {
            return Err(std::io::Error::new(
                error.kind(),
                format!("unreadable restore marker {}: {error}", path.display()),
            ))
        }
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return Err(std::io::Error::new(
                e.kind(),
                format!("unreadable restore marker {}: {e}", path.display()),
            ))
        }
    };
    if text.len() > MAX_RESTORE_MARKER_BYTES {
        return Err(marker_limit(
            &path,
            "serialized byte limit changed during read",
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| corrupt(&path, e))?;
    let mut doc = MarkerDoc::new();
    if v.get("version").is_some() || v.get("sources").is_some() {
        if v.get("version").and_then(Value::as_i64) != Some(2) {
            return Err(corrupt(&path, "`version` must be exactly 2"));
        }
        let map = v
            .get("sources")
            .and_then(Value::as_object)
            .ok_or_else(|| corrupt(&path, "required `sources` is not an object"))?;
        for (sid, s) in map {
            validate_identifier(&path, "source id", sid, MAX_RESTORE_MARKER_SOURCE_ID_BYTES)?;
            let source = s
                .as_object()
                .ok_or_else(|| corrupt(&path, format!("source `{sid}` is not an object")))?;
            let at = source
                .get("at")
                .and_then(Value::as_i64)
                .ok_or_else(|| corrupt(&path, format!("source `{sid}` is missing integer `at`")))?;
            let panes = source
                .get("panes")
                .ok_or_else(|| corrupt(&path, format!("source `{sid}` is missing `panes`")))?;
            doc.insert(sid.clone(), (at, parse_panes(&path, sid, panes)?));
        }
        prune_marker_doc(&mut doc, None);
        validate_marker_doc(&path, &doc)?;
        return Ok(doc);
    }
    // v1 migration: a single top-level {sourceId, at, panes}.
    if let Some(sid) = v
        .get("sourceId")
        .and_then(Value::as_str)
        .filter(|sid| !sid.is_empty())
    {
        validate_identifier(&path, "source id", sid, MAX_RESTORE_MARKER_SOURCE_ID_BYTES)?;
        let at = v
            .get("at")
            .and_then(Value::as_i64)
            .ok_or_else(|| corrupt(&path, "v1 marker is missing integer `at`"))?;
        let panes = v
            .get("panes")
            .ok_or_else(|| corrupt(&path, "v1 marker is missing `panes`"))?;
        doc.insert(sid.to_string(), (at, parse_panes(&path, sid, panes)?));
        validate_marker_doc(&path, &doc)?;
        return Ok(doc);
    }
    Err(corrupt(
        &path,
        "unrecognized marker shape (no sources/sourceId)",
    ))
}

struct MarkerFile<'a>(&'a MarkerDoc);
struct MarkerSources<'a>(&'a MarkerDoc);
struct MarkerSource<'a> {
    at: i64,
    panes: &'a Marker,
}
struct MarkerPanes<'a> {
    at: i64,
    panes: &'a Marker,
}
struct MarkerPane<'a> {
    at: i64,
    mark: &'a PaneMark,
}

impl Serialize for MarkerFile<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut root = serializer.serialize_struct("RestoreMarker", 2)?;
        root.serialize_field("version", &2)?;
        root.serialize_field("sources", &MarkerSources(self.0))?;
        root.end()
    }
}

impl Serialize for MarkerSources<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (source_id, (at, panes)) in self.0 {
            map.serialize_entry(source_id, &MarkerSource { at: *at, panes })?;
        }
        map.end()
    }
}

impl Serialize for MarkerSource<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut source = serializer.serialize_struct("RestoreMarkerSource", 2)?;
        source.serialize_field("at", &self.at)?;
        source.serialize_field(
            "panes",
            &MarkerPanes {
                at: self.at,
                panes: self.panes,
            },
        )?;
        source.end()
    }
}

impl Serialize for MarkerPanes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.panes.len()))?;
        for (pane_key, mark) in self.panes {
            map.serialize_entry(pane_key, &MarkerPane { at: self.at, mark })?;
        }
        map.end()
    }
}

impl Serialize for MarkerPane<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut pane = serializer.serialize_struct("RestoreMarkerPane", 3)?;
        pane.serialize_field("state", &self.mark.state)?;
        pane.serialize_field("terminalId", &self.mark.terminal_id)?;
        pane.serialize_field("at", &self.at)?;
        pane.end()
    }
}

struct MarkerSizeWriter<'a> {
    path: &'a Path,
    bytes: usize,
}

impl Write for MarkerSizeWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next = self
            .bytes
            .checked_add(buffer.len())
            .ok_or_else(|| marker_limit(self.path, "serialized byte count overflow"))?;
        if next > MAX_RESTORE_MARKER_BYTES {
            return Err(marker_limit(
                self.path,
                format!(
                    "serialized byte limit is {MAX_RESTORE_MARKER_BYTES} (more than {MAX_RESTORE_MARKER_BYTES})"
                ),
            ));
        }
        self.bytes = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn validate_marker_doc(path: &Path, doc: &MarkerDoc) -> std::io::Result<()> {
    for (source_id, (_, panes)) in doc {
        validate_identifier(
            path,
            "source id",
            source_id,
            MAX_RESTORE_MARKER_SOURCE_ID_BYTES,
        )?;
        validate_marker_pane_count(path, source_id, panes.len())?;
        for (pane_key, mark) in panes {
            validate_identifier(
                path,
                &format!("source `{source_id}` pane key"),
                pane_key,
                MAX_RESTORE_MARKER_PANE_KEY_BYTES,
            )?;
            if !matches!(mark.state.as_str(), "in-progress" | "restored") {
                return Err(marker_limit(
                    path,
                    format!("source `{source_id}` pane `{pane_key}` has invalid state"),
                ));
            }
            if let Some(terminal_id) = &mark.terminal_id {
                validate_identifier(
                    path,
                    &format!("source `{source_id}` pane `{pane_key}` terminal id"),
                    terminal_id,
                    MAX_RESTORE_MARKER_TERMINAL_ID_BYTES,
                )?;
            }
        }
    }
    let mut writer = MarkerSizeWriter { path, bytes: 0 };
    serde_json::to_writer(&mut writer, &MarkerFile(doc)).map_err(|error| {
        marker_limit(
            path,
            format!("serialized byte limit validation failed: {error}"),
        )
    })
}

pub(super) fn validate_restore_projection(
    path: &Path,
    doc: &MarkerDoc,
    source_id: &str,
    captured_at: i64,
    force: bool,
    selected_panes: Option<&std::collections::HashSet<String>>,
    records: &[Value],
) -> std::io::Result<()> {
    let current = doc.get(source_id).map(|(_, panes)| panes);
    let mut projected = current.cloned().unwrap_or_default();
    for record in records {
        if record.get("status").and_then(Value::as_str) != Some("open") {
            continue;
        }
        let tab_key = record.get("tabKey").and_then(Value::as_str).unwrap_or("");
        for pane in record
            .get("panes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let pane_id = pane.get("paneId").and_then(Value::as_str).unwrap_or("");
            let key = super::pane_key(tab_key, pane_id);
            if selected_panes.is_some_and(|filter| !filter.contains(&key))
                || super::pane_to_create_body(record.get("tabName"), pane).is_err()
            {
                continue;
            }
            if !force
                && current
                    .and_then(|panes| panes.get(&key))
                    .is_some_and(|mark| mark.state == "restored")
            {
                continue;
            }
            let is_terminal = pane.get("kind").and_then(Value::as_str) == Some("terminal");
            projected
                .entry(key)
                .and_modify(|mark| {
                    mark.state = "in-progress".into();
                    if is_terminal
                        && mark
                            .terminal_id
                            .as_ref()
                            .is_none_or(|terminal_id| terminal_id.len() < 36)
                    {
                        mark.terminal_id = Some("00000000-0000-0000-0000-000000000000".to_string());
                    }
                })
                .or_insert_with(|| PaneMark {
                    state: "in-progress".into(),
                    terminal_id: is_terminal
                        .then(|| "00000000-0000-0000-0000-000000000000".to_string()),
                });
        }
    }
    let mut projected_doc = doc.clone();
    projected_doc.insert(source_id.to_string(), (captured_at, projected));
    prune_marker_doc(&mut projected_doc, Some(source_id));
    validate_marker_doc(path, &projected_doc)
}

/// Retain a deterministic newest-first source window. `keep_source_id` is the
/// source currently being restored; it is never evicted by older capturedAt
/// metadata while its write-ahead state is being updated.
pub(super) fn prune_marker_doc(doc: &mut MarkerDoc, keep_source_id: Option<&str>) {
    if doc.len() <= MAX_RESTORE_MARKER_SOURCES {
        return;
    }
    let mut ranked: Vec<(i64, String)> = doc
        .iter()
        .filter(|(source_id, _)| keep_source_id != Some(source_id.as_str()))
        .map(|(source_id, (at, _))| (*at, source_id.clone()))
        .collect();
    ranked.sort_by(|a, b| b.cmp(a));
    let other_limit = MAX_RESTORE_MARKER_SOURCES
        - usize::from(keep_source_id.is_some_and(|id| doc.contains_key(id)));
    let retained: std::collections::HashSet<String> = ranked
        .into_iter()
        .take(other_limit)
        .map(|(_, source_id)| source_id)
        .collect();
    doc.retain(|source_id, _| {
        keep_source_id == Some(source_id.as_str()) || retained.contains(source_id)
    });
}

/// Durable atomic write of the WHOLE ledger: the temporary file is synced,
/// renamed, and the parent directory is synced before success is reported.
/// Returns Err so the handler fails LOUDLY. Blocking fs — call via
/// `spawn_blocking` under `freshell_ws::tabs_persist::with_persist_lock`.
pub(super) fn write_marker_doc(device_dir: &Path, doc: &MarkerDoc) -> std::io::Result<()> {
    std::fs::create_dir_all(device_dir)?;
    let mut bounded = doc.clone();
    prune_marker_doc(&mut bounded, None);
    let destination = device_dir.join(RESTORE_MARKER);
    validate_marker_doc(&destination, &bounded)?;
    let bytes = serde_json::to_vec(&MarkerFile(&bounded))
        .map_err(|error| std::io::Error::other(format!("restore marker serialization: {error}")))?;
    debug_assert!(bytes.len() <= MAX_RESTORE_MARKER_BYTES);
    let tmp = device_dir.join(RESTORE_MARKER_TMP);
    freshell_ws::tabs_persist::atomic_write_durable(&destination, &tmp, &bytes)
}

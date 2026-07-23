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
use std::path::Path;

use serde_json::{json, Value};

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

fn parse_panes(path: &Path, source_id: &str, value: &Value) -> std::io::Result<Marker> {
    let map = value.as_object().ok_or_else(|| {
        corrupt(
            path,
            format!("source `{source_id}` `panes` is not an object"),
        )
    })?;
    let mut out = Marker::new();
    for (key, pane) in map {
        if key.is_empty() {
            return Err(corrupt(
                path,
                format!("source `{source_id}` has an empty pane key"),
            ));
        }
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
            Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
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
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(MarkerDoc::new()),
        Err(e) => {
            return Err(std::io::Error::new(
                e.kind(),
                format!("unreadable restore marker {}: {e}", path.display()),
            ))
        }
    };
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
            if sid.is_empty() {
                return Err(corrupt(&path, "source id must be non-empty"));
            }
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
        return Ok(doc);
    }
    // v1 migration: a single top-level {sourceId, at, panes}.
    if let Some(sid) = v
        .get("sourceId")
        .and_then(Value::as_str)
        .filter(|sid| !sid.is_empty())
    {
        let at = v
            .get("at")
            .and_then(Value::as_i64)
            .ok_or_else(|| corrupt(&path, "v1 marker is missing integer `at`"))?;
        let panes = v
            .get("panes")
            .ok_or_else(|| corrupt(&path, "v1 marker is missing `panes`"))?;
        doc.insert(sid.to_string(), (at, parse_panes(&path, sid, panes)?));
        return Ok(doc);
    }
    Err(corrupt(
        &path,
        "unrecognized marker shape (no sources/sourceId)",
    ))
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
    let sources: serde_json::Map<String, Value> = bounded
        .iter()
        .map(|(sid, (at, panes))| {
            let panes_json: serde_json::Map<String, Value> = panes
                .iter()
                .map(|(k, pm)| {
                    (
                        k.clone(),
                        json!({ "state": pm.state, "terminalId": pm.terminal_id, "at": at }),
                    )
                })
                .collect();
            (
                sid.clone(),
                json!({ "at": at, "panes": Value::Object(panes_json) }),
            )
        })
        .collect();
    let bytes =
        serde_json::to_vec_pretty(&json!({ "version": 2, "sources": Value::Object(sources) }))
            .unwrap_or_default();
    let tmp = device_dir.join(RESTORE_MARKER_TMP);
    freshell_ws::tabs_persist::atomic_write_durable(&device_dir.join(RESTORE_MARKER), &tmp, &bytes)
}

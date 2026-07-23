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

fn parse_panes(v: Option<&Value>) -> Marker {
    let mut out = Marker::new();
    if let Some(map) = v.and_then(Value::as_object) {
        for (k, pm) in map {
            out.insert(
                k.clone(),
                PaneMark {
                    state: pm
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("in-progress")
                        .to_string(),
                    terminal_id: pm
                        .get("terminalId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            );
        }
    }
    out
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
    if let Some(sources) = v.get("sources") {
        let map = sources
            .as_object()
            .ok_or_else(|| corrupt(&path, "`sources` is not an object"))?;
        for (sid, s) in map {
            let at = s.get("at").and_then(Value::as_i64).unwrap_or(0);
            doc.insert(sid.clone(), (at, parse_panes(s.get("panes"))));
        }
        return Ok(doc);
    }
    // v1 migration: a single top-level {sourceId, at, panes}.
    if let Some(sid) = v.get("sourceId").and_then(Value::as_str) {
        let at = v.get("at").and_then(Value::as_i64).unwrap_or(0);
        doc.insert(sid.to_string(), (at, parse_panes(v.get("panes"))));
        return Ok(doc);
    }
    Err(corrupt(
        &path,
        "unrecognized marker shape (no sources/sourceId)",
    ))
}

/// Atomic (tmp + rename) write of the WHOLE ledger. Returns Err so the handler
/// fails LOUDLY. Blocking fs — call via `spawn_blocking` under
/// `freshell_ws::tabs_persist::with_persist_lock`.
pub(super) fn write_marker_doc(device_dir: &Path, doc: &MarkerDoc) -> std::io::Result<()> {
    std::fs::create_dir_all(device_dir)?;
    let sources: serde_json::Map<String, Value> = doc
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
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, device_dir.join(RESTORE_MARKER))
}

//! Legacy `tabs-registry.jsonl` -> compact-state migration (PART B, Task 10):
//! the `migrateLegacyJsonl` slice of `server/tabs-registry/store.ts`
//! (store.ts:853-949) plus its bounded line reader (store.ts:608-638).
//!
//! Consumed by `DurableTabsStore::open`'s legacy arm, which commits the
//! returned state (publishing `manifestRevision: 1`) and only THEN archives
//! the legacy file — a crash between them replays harmlessly because the next
//! `open()` loads the manifest FIRST (store.ts:697-698).

use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;

use serde_json::{Map, Value};

use crate::tabs_store_model::{
    apply_queued_maintenance, build_snapshot_payload_hash, canonical_stringify,
    client_snapshot_key, empty_state, normalize_registry_pane_kinds, pick_event_winner,
    validate_record_caps, validate_registry_record, validate_state_caps, ClientOpenSnapshot,
    ClientRevisionWatermark, CompactState, RegistryDeviceEntry, TabsStoreCaps, DAY_MS,
};

/// The synthetic `clientInstanceId` every migrated snapshot and record
/// carries (store.ts:920-938).
const LEGACY_CLIENT_INSTANCE_ID: &str = "legacy-migration";

/// `migrateLegacyJsonl` (store.ts:853-949), the seven-clause Node contract:
/// bounded CRLF-tolerant line reads; silent skip of blank/malformed/
/// schema-invalid lines with HARD pane-cap errors; LWW per `tabKey` with
/// retained-byte + unique-key caps; retention-filtered tombstones; ONE
/// synthetic snapshot per device (first-label rewrite, both hashes = the
/// open-records hash, matching watermark); `devices_by_id` last-label-wins;
/// then queued maintenance + state-cap validation.
pub(crate) fn migrate_legacy_jsonl(
    legacy_path: &Path,
    migration_started_at: i64,
    caps: &TabsStoreCaps,
    max_closed_retention_days: i64,
) -> Result<CompactState, String> {
    let file = std::fs::File::open(legacy_path).map_err(|err| {
        format!(
            "Tabs registry legacy migration failed to open {}: {err}",
            legacy_path.display()
        )
    })?;
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);

    // `latestByTabKey` (store.ts:860) — `serde_json::Map` (preserve_order)
    // mirrors JS `Map` semantics: re-`insert` keeps the original position, so
    // device grouping and label rewrites see Node's iteration order.
    let mut latest_by_tab_key: Map<String, Value> = Map::new();
    let mut retained_bytes: usize = 0;

    while let Some(line) = read_bounded_line(&mut reader, caps.max_legacy_line_bytes)? {
        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(mut record) = serde_json::from_str::<Value>(trimmed) else {
            continue; // malformed JSON -> silent skip (store.ts:866-869)
        };
        // Pane kinds normalize BEFORE validation (Task 8 decision: Node's
        // `TabRegistryRecordSchema` transforms during parse).
        normalize_registry_pane_kinds(&mut record);
        if validate_registry_record(&record).is_err() {
            continue; // schema-invalid -> silent skip (store.ts:871-872)
        }
        // Pane-cap violation on an otherwise-VALID record is a HARD error
        // (store.ts:874), unlike the silent skips above.
        validate_record_caps(std::slice::from_ref(&record), caps)?;

        let tab_key = record
            .get("tabKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let winner_replaces = match latest_by_tab_key.get(&tab_key) {
            Some(current) => !std::ptr::eq(pick_event_winner(current, &record), current),
            None => true,
        };
        if winner_replaces {
            if let Some(current) = latest_by_tab_key.get(&tab_key) {
                retained_bytes = retained_bytes.saturating_sub(json_bytes(current));
            }
            retained_bytes += json_bytes(&record);
            if retained_bytes > caps.max_migration_retained_bytes {
                return Err(format!(
                    "Tabs registry legacy migration retained-byte cap exceeded: {}",
                    format_bytes(caps.max_migration_retained_bytes)
                ));
            }
            latest_by_tab_key.insert(tab_key, record);
        }
        if latest_by_tab_key.len() > caps.max_legacy_unique_tab_keys {
            return Err(format!(
                "Tabs registry legacy migration cap exceeded: more than {} unique tab keys",
                caps.max_legacy_unique_tab_keys
            ));
        }
    }

    let mut state = empty_state(migration_started_at, max_closed_retention_days);
    let closed_cutoff = migration_started_at - max_closed_retention_days * DAY_MS;
    // `openByDevice` (store.ts:892) — insertion-ordered like the JS `Map`:
    // first-seen device order drives the grouping loop below.
    let mut device_order: Vec<String> = Vec::new();
    let mut open_by_device: HashMap<String, Vec<Value>> = HashMap::new();

    for (tab_key, record) in &latest_by_tab_key {
        if record.get("status").and_then(Value::as_str) == Some("closed") {
            let closed_at = record
                .get("closedAt")
                .and_then(Value::as_i64)
                .or_else(|| record.get("updatedAt").and_then(Value::as_i64))
                .unwrap_or(0);
            if closed_at >= closed_cutoff {
                state
                    .closed_by_tab_key
                    .insert(tab_key.clone(), record.clone());
            }
            continue;
        }
        let device_id = record
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let device_label = record
            .get("deviceLabel")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        open_by_device
            .entry(device_id.clone())
            .or_insert_with(|| {
                device_order.push(device_id.clone());
                Vec::new()
            })
            .push(record.clone());
        // The LAST open record's label wins here (store.ts:904-908) — it can
        // DIFFER from the snapshot's first-label rewrite (validator-A8-A9).
        state.devices_by_id.insert(
            device_id.clone(),
            RegistryDeviceEntry {
                device_id,
                device_label,
                last_seen_at: migration_started_at,
            },
        );
    }

    for device_id in &device_order {
        // Faithful port: Node checks the TOTAL group count INSIDE the loop
        // (store.ts:912-914) — the first iteration hard-errors when over cap.
        if open_by_device.len() > caps.max_client_snapshot_refs {
            return Err(format!(
                "Tabs registry legacy migration cap exceeded: more than {} migrated open snapshots",
                caps.max_client_snapshot_refs
            ));
        }
        let records = &open_by_device[device_id];
        if records.len() > caps.max_open_records_per_client_snapshot {
            return Err(format!(
                "Tabs registry legacy migration cap exceeded: client snapshot has more than {} open records",
                caps.max_open_records_per_client_snapshot
            ));
        }
        // The group's FIRST label (or deviceId), rewritten onto every record
        // along with the synthetic clientInstanceId (store.ts:915-916).
        let device_label = records
            .first()
            .and_then(|record| record.get("deviceLabel").and_then(Value::as_str))
            .unwrap_or(device_id)
            .to_string();
        let snapshot_records: Vec<Value> = records
            .iter()
            .map(|record| {
                let mut rewritten = record.clone();
                rewritten["deviceLabel"] = Value::String(device_label.clone());
                rewritten["clientInstanceId"] =
                    Value::String(LEGACY_CLIENT_INSTANCE_ID.to_string());
                rewritten
            })
            .collect();
        let payload_hash = build_snapshot_payload_hash(
            device_id,
            &device_label,
            LEGACY_CLIENT_INSTANCE_ID,
            1,
            &snapshot_records,
        );
        let key = client_snapshot_key(device_id, LEGACY_CLIENT_INSTANCE_ID)?;
        state.open_snapshots_by_client.insert(
            key.clone(),
            ClientOpenSnapshot {
                device_id: device_id.clone(),
                device_label,
                client_instance_id: LEGACY_CLIENT_INSTANCE_ID.to_string(),
                snapshot_revision: 1,
                last_push_payload_hash: payload_hash.clone(),
                open_snapshot_payload_hash: payload_hash,
                snapshot_received_at: migration_started_at,
                records: snapshot_records,
            },
        );
        state.client_revisions_by_client.insert(
            key,
            ClientRevisionWatermark {
                device_id: device_id.clone(),
                client_instance_id: LEGACY_CLIENT_INSTANCE_ID.to_string(),
                snapshot_revision: 1,
                last_seen_at: migration_started_at,
            },
        );
    }

    apply_queued_maintenance(&mut state, migration_started_at, caps);
    validate_state_caps(&state, caps)?;
    Ok(state)
}

/// `readBoundedLegacyLines` (store.ts:608-638): accumulate bytes up to the
/// next `\n` with a hard per-line byte cap (content bytes, EXCLUDING the
/// newline — the cap check runs before any oversized segment is buffered);
/// one trailing `\r` is stripped (CRLF tolerance). `Ok(None)` = EOF. NOT
/// `BufRead::lines()`, which has no byte cap.
fn read_bounded_line(
    reader: &mut impl BufRead,
    max_line_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut line: Vec<u8> = Vec::new();
    let mut saw_bytes = false;
    loop {
        let chunk = reader
            .fill_buf()
            .map_err(|err| format!("Tabs registry legacy migration failed to read: {err}"))?;
        if chunk.is_empty() {
            if !saw_bytes {
                return Ok(None);
            }
            strip_trailing_cr(&mut line);
            return Ok(Some(line));
        }
        saw_bytes = true;
        if let Some(pos) = chunk.iter().position(|&byte| byte == b'\n') {
            if line.len() + pos > max_line_bytes {
                return Err(line_cap_error(max_line_bytes));
            }
            line.extend_from_slice(&chunk[..pos]);
            reader.consume(pos + 1);
            strip_trailing_cr(&mut line);
            return Ok(Some(line));
        }
        let chunk_len = chunk.len();
        if line.len() + chunk_len > max_line_bytes {
            return Err(line_cap_error(max_line_bytes));
        }
        line.extend_from_slice(chunk);
        reader.consume(chunk_len);
    }
}

fn strip_trailing_cr(line: &mut Vec<u8>) {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
}

fn line_cap_error(max_line_bytes: usize) -> String {
    format!(
        "Tabs registry legacy migration cap exceeded: line is larger than {}",
        format_bytes(max_line_bytes)
    )
}

/// `jsonBytes` (store.ts:331-333): the canonical serialization's UTF-8 byte
/// length (Rust strings measure UTF-8 bytes natively).
fn json_bytes(value: &Value) -> usize {
    canonical_stringify(value).len()
}

/// `formatBytes` (store.ts:335-339).
fn format_bytes(bytes: usize) -> String {
    if bytes.is_multiple_of(1024 * 1024) {
        format!("{} MiB", bytes / (1024 * 1024))
    } else if bytes.is_multiple_of(1024) {
        format!("{} KiB", bytes / 1024)
    } else {
        format!("{bytes} bytes")
    }
}

#[cfg(test)]
mod tests;

//! Live tabs registry — the `tabs.sync.*` slice of `server/ws-handler.ts`
//! (`tabs.sync.push` / `tabs.sync.query` / `tabs.sync.client.retire`) plus the
//! `POST /api/tabs-sync/client-retire` beacon, porting the observable
//! semantics of `server/tabs-registry/store.ts` at Node parity: record
//! validation + pane-kind migration, push caps, payload hashes
//! (idempotent-retry accept vs content-conflict rejection), revision
//! watermarks, TTL read-filters, and an optional durable backing store.
//!
//! ## Modes
//!
//! - [`TabsRegistry::new`] — memory-only (tests, no-home boot): the full Node
//!   mutation/query semantics minus the disk.
//! - [`TabsRegistry::with_persist_dir`] — memory-only plus the rolling
//!   snapshot generations of [`crate::tabs_persist`] (continuity trio).
//! - [`TabsRegistry::with_durable_store`] — hydrates from the durable store's
//!   [`CompactState`] and commits every accepted mutation through
//!   [`crate::tabs_store::DurableTabsStore::commit`] BEFORE exposing it.
//!
//! ## Lock discipline (validator-A6)
//!
//! In durable-backed mode the store mutex IS the mutation lock: every
//! mutation (push and retire, INCLUDING the idempotent-accept hash fast path)
//! runs its whole read → derive → commit → swap sequence under the
//! `Arc<Mutex<DurableTabsStore>>` — the Rust mirror of Node's
//! `enqueueMutation` (store.ts:1085-1089), which serializes the entire
//! read-clone-mutate-commit closure, not just the commit. All mutators run
//! inside `spawn_blocking` (see `terminal.rs` / `boot.rs`), so a
//! `std::sync::Mutex` is safe here — it is never held across an `await`. The
//! registry's `inner` lock stays IO-free: it is taken briefly to read the
//! current state and again to swap after a successful commit, so readers
//! never block on filesystem IO. On commit error the swap is skipped: the
//! caller sees the IO error and the registry keeps serving the last
//! durably-committed state (Node throws out of the mutation, store.ts:1189).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::tabs_store::DurableTabsStore;
use crate::tabs_store_model::{
    apply_queued_maintenance, build_snapshot_payload_hash, canonical_stringify,
    client_snapshot_key, closed_at_or_updated, compare_by_event_time, default_caps, empty_state,
    normalize_registry_pane_kinds, pick_event_winner, record_status, record_str,
    sort_by_closed_desc, sort_by_updated_desc, validate_record_caps, validate_registry_record,
    validate_state_caps, ClientOpenSnapshot, ClientRevisionWatermark, CompactState,
    RegistryDeviceEntry, TabsStoreCaps, DAY_MS, DEFAULT_CLOSED_RETENTION_DAYS,
    DEFAULT_DEVICE_DISPLAY_TTL_DAYS, DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES, MINUTE_MS,
};

/// `'Stale snapshot revision rejected...'` (store.ts:1140, 1149) — the
/// string-identical rejection both revision guards throw.
const STALE_REVISION_ERROR: &str =
    "Stale snapshot revision rejected for tabs registry client snapshot";

/// The result of a `tabs.sync.push` (`tabs.sync.ack` payload).
#[derive(Debug)]
pub struct PushAck {
    pub accepted: bool,
    pub open_records: i64,
    pub closed_records: i64,
    /// `Some(false)` when a persistence attempt did not durably write
    /// (oversize, invalid ids, io failure, cap unenforceable). `None` when
    /// persisted normally or when persistence was not attempted by design
    /// (empty push, persistence disabled — kata h9vt owns those semantics).
    pub persisted: Option<bool>,
    /// Machine-readable reason accompanying `persisted: Some(false)`.
    pub persist_reason: Option<String>,
}

/// Shared, cheaply-cloneable tabs registry. Lives in [`crate::WsState`] (so
/// every `/ws` connection shares it) and is cloned into the server's REST
/// surface (so the `client-retire` beacon reaches the same state).
#[derive(Clone)]
pub struct TabsRegistry {
    /// The live [`CompactState`] mirror — the SAME shape the durable store
    /// commits (`CompactTabsRegistryStateV1`, store.ts:93-103), keyed by
    /// [`client_snapshot_key`] (base64url, collision-free — replaces the old
    /// collidable `"{device}::{client}"` join).
    inner: Arc<Mutex<CompactState>>,
    /// Root of the on-disk snapshot-generation store (continuity trio,
    /// [`crate::tabs_persist`]). `None` keeps that side channel off.
    persist_dir: Option<Arc<PathBuf>>,
    /// The durable store, when attached ([`Self::with_durable_store`]). Its
    /// mutex is the mutation lock (module doc). `None` = memory-only.
    store: Option<Arc<Mutex<DurableTabsStore>>>,
    /// Push/state caps — the store's own caps in durable mode, `DEFAULT_CAPS`
    /// otherwise.
    caps: Arc<TabsStoreCaps>,
}

impl Default for TabsRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(empty_state(
                now_ms(),
                DEFAULT_CLOSED_RETENTION_DAYS,
            ))),
            persist_dir: None,
            store: None,
            caps: Arc::new(default_caps()),
        }
    }
}

impl TabsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry that ALSO persists each accepted non-empty client snapshot
    /// as a rolling on-disk generation under `dir` (see [`crate::tabs_persist`]).
    pub fn with_persist_dir(dir: PathBuf) -> Self {
        Self {
            persist_dir: Some(Arc::new(dir)),
            ..Self::default()
        }
    }

    /// A registry backed by an opened [`DurableTabsStore`]: hydrates the live
    /// state from the store's [`CompactState`] and keeps the store handle so
    /// every accepted mutation is committed before it becomes visible.
    pub fn with_durable_store(store: DurableTabsStore, persist_dir: Option<PathBuf>) -> Self {
        let caps = store.caps.clone();
        let state = store.state().clone();
        Self {
            inner: Arc::new(Mutex::new(state)),
            persist_dir: persist_dir.map(Arc::new),
            store: Some(Arc::new(Mutex::new(store))),
            caps: Arc::new(caps),
        }
    }

    /// `replaceClientSnapshot` (store.ts:1091-1192): validate + canonicalize
    /// the pushed records, guard revisions (stale rejection, idempotent-retry
    /// accept, content-conflict rejection), fold closed tombstones with the
    /// `findOpenWinnerForTab` guard, store the open snapshot + watermark +
    /// device, run maintenance, and (durable mode) commit before swapping.
    ///
    /// `server_instance_id` / `deviceId` / `deviceLabel` / `clientInstanceId`
    /// are stamped onto every record (`ws-handler.ts:3122-3132` +
    /// `store.ts:1104`); a record carrying its OWN device identity must match
    /// the envelope's (`assertSnapshotRecordOwnership`, store.ts:524-528).
    pub fn replace_client_snapshot(
        &self,
        server_instance_id: &str,
        device_id: &str,
        device_label: &str,
        client_instance_id: &str,
        snapshot_revision: i64,
        records: Vec<Value>,
    ) -> Result<PushAck, String> {
        let now = now_ms();
        // Pre-checks run OUTSIDE every lock (store.ts:1091-1107 run before
        // the mutation is enqueued).
        let prepared = prepare_push(
            server_instance_id,
            device_id,
            device_label,
            client_instance_id,
            snapshot_revision,
            records,
            &self.caps,
        )?;
        let mut ack = PushAck {
            accepted: true,
            open_records: prepared.open_records.len() as i64,
            closed_records: prepared.closed_records.len() as i64,
            persisted: None,
            persist_reason: None,
        };

        let mutated = match &self.store {
            Some(store) => {
                // The store mutex is the mutation lock (module doc): held
                // across read → derive → commit → swap, including the
                // idempotent fast path and both error returns.
                let mut store_guard = store.lock().expect("durable tabs store lock");
                let current = self.inner.lock().expect("tabs registry lock").clone();
                match derive_push_next(
                    &current,
                    &prepared,
                    device_id,
                    device_label,
                    client_instance_id,
                    snapshot_revision,
                    now,
                    &self.caps,
                )? {
                    None => false, // idempotent retry: accept WITHOUT commit
                    Some(next) => {
                        // Commit error → Err to the client, in-memory state
                        // unchanged (Node throws out of the mutation,
                        // store.ts:1189).
                        store_guard
                            .commit(next.clone(), now)
                            .map_err(|err| err.to_string())?;
                        *self.inner.lock().expect("tabs registry lock") = next;
                        true
                    }
                }
            }
            None => {
                let mut state = self.inner.lock().expect("tabs registry lock");
                match derive_push_next(
                    &state,
                    &prepared,
                    device_id,
                    device_label,
                    client_instance_id,
                    snapshot_revision,
                    now,
                    &self.caps,
                )? {
                    None => false,
                    Some(next) => {
                        *state = next;
                        true
                    }
                }
            }
        };

        // Best-effort snapshot generation (never fails the push), AFTER every
        // lock is released. Empty/idempotent pushes never overwrite the
        // last-good generation.
        if mutated && !prepared.open_records.is_empty() {
            if let Some(dir) = &self.persist_dir {
                match crate::tabs_persist::persist_generation(
                    dir,
                    server_instance_id,
                    device_id,
                    device_label,
                    client_instance_id,
                    snapshot_revision,
                    &prepared.open_records,
                    now,
                ) {
                    crate::tabs_persist::PersistOutcome::Persisted => {}
                    crate::tabs_persist::PersistOutcome::Skipped { reason } => {
                        ack.persisted = Some(false);
                        ack.persist_reason = Some(reason.to_string());
                    }
                    crate::tabs_persist::PersistOutcome::Failed { reason } => {
                        ack.persisted = Some(false);
                        ack.persist_reason = Some(reason);
                    }
                }
            }
        }

        Ok(ack)
    }

    /// `retireClientSnapshot` (store.ts:1194-1238): drop this client's open
    /// snapshot when the retire revision advances past it. BOTH branches
    /// write/refresh the revision watermark (with `last_seen_at`) so a late
    /// re-push cannot resurrect the snapshot, and refresh the device entry —
    /// from the STORED snapshot's label when removing a live snapshot.
    /// Returns `accepted`; in durable mode a failed commit leaves the state
    /// unchanged and reports `false`.
    pub fn retire_client_snapshot(
        &self,
        device_id: &str,
        client_instance_id: &str,
        snapshot_revision: i64,
    ) -> bool {
        let now = now_ms();
        let Ok(key) = client_snapshot_key(device_id, client_instance_id) else {
            return false;
        };
        match &self.store {
            Some(store) => {
                let mut store_guard = store.lock().expect("durable tabs store lock");
                let current = self.inner.lock().expect("tabs registry lock").clone();
                let Some(next) = derive_retire_next(
                    &current,
                    &key,
                    device_id,
                    client_instance_id,
                    snapshot_revision,
                    now,
                    &self.caps,
                ) else {
                    return false;
                };
                match store_guard.commit(next.clone(), now) {
                    Ok(()) => {
                        *self.inner.lock().expect("tabs registry lock") = next;
                        true
                    }
                    Err(err) => {
                        tracing::warn!(target: "freshell_ws::tabs", error = %err,
                            "tabs_retire_commit_failed");
                        false
                    }
                }
            }
            None => {
                let mut state = self.inner.lock().expect("tabs registry lock");
                match derive_retire_next(
                    &state,
                    &key,
                    device_id,
                    client_instance_id,
                    snapshot_revision,
                    now,
                    &self.caps,
                ) {
                    Some(next) => {
                        *state = next;
                        true
                    }
                    None => false,
                }
            }
        }
    }

    /// `query` (store.ts:1240-1296): merge every LIVE client's open records +
    /// the retained closed tombstones into a winner-per-`tabKey` view,
    /// partitioned relative to the asking `(deviceId, clientInstanceId)` into
    /// `localOpen` / `sameDeviceOpen` / `remoteOpen` / `closed`, plus the
    /// TTL-filtered device list. Read-filters (none of them mutate):
    ///
    /// - `closed_tab_retention_days` is validated (int 1..=30 → `Err`,
    ///   store.ts:411-416);
    /// - open snapshots older than 30 min (by `snapshot_received_at`) are
    ///   excluded;
    /// - tombstones are filtered by BOTH the server retention
    ///   (`max_closed_retention_days`) and the per-query retention;
    /// - `devices` is filtered by the 7-day display TTL (`listDevices`,
    ///   store.ts:1298-1304).
    pub fn query(
        &self,
        device_id: &str,
        client_instance_id: &str,
        closed_tab_retention_days: i64,
        now_ms: i64,
    ) -> Result<Value, String> {
        if !(1..=30).contains(&closed_tab_retention_days) {
            return Err("Closed tab retention must be an integer from 1 to 30 days".to_string());
        }
        let state = self.inner.lock().expect("tabs registry lock");
        let open_cutoff = now_ms - DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES * MINUTE_MS;
        let closed_display_cutoff = now_ms - closed_tab_retention_days * DAY_MS;
        let closed_server_cutoff = now_ms - state.max_closed_retention_days * DAY_MS;

        // winner tabKey -> (record, owning clientInstanceId if from an open snapshot)
        let mut winners: std::collections::HashMap<String, (Value, Option<String>)> =
            std::collections::HashMap::new();

        for snapshot in state.open_snapshots_by_client.values() {
            if snapshot.snapshot_received_at < open_cutoff {
                continue; // expired open snapshot (30-min TTL read-filter)
            }
            for record in &snapshot.records {
                let Some(tab_key) = record_tab_key(record) else {
                    continue;
                };
                let replace = match winners.get(&tab_key) {
                    None => true,
                    Some((cur, _)) => compare_by_event_time(cur, record).is_lt(),
                };
                if replace {
                    winners.insert(
                        tab_key,
                        (record.clone(), Some(snapshot.client_instance_id.clone())),
                    );
                }
            }
        }
        for record in state.closed_by_tab_key.values() {
            if closed_at_or_updated(record) < closed_server_cutoff {
                continue; // beyond the server-side retention window
            }
            let Some(tab_key) = record_tab_key(record) else {
                continue;
            };
            let replace = match winners.get(&tab_key) {
                None => true,
                Some((cur, _)) => compare_by_event_time(cur, record).is_lt(),
            };
            if replace {
                winners.insert(tab_key, (record.clone(), None));
            }
        }

        let mut local_open: Vec<Value> = Vec::new();
        let mut same_device_open: Vec<Value> = Vec::new();
        let mut remote_open: Vec<Value> = Vec::new();
        let mut closed: Vec<Value> = Vec::new();

        for (record, owner_client) in winners.into_values() {
            if record_status(&record) == "closed" {
                if closed_at_or_updated(&record) >= closed_display_cutoff {
                    closed.push(record);
                }
                continue;
            }
            let record_device = record_str(&record, "deviceId").unwrap_or_default();
            if record_device == device_id && owner_client.as_deref() == Some(client_instance_id) {
                local_open.push(record);
            } else if record_device == device_id {
                same_device_open.push(record);
            } else {
                remote_open.push(record);
            }
        }

        local_open.sort_by(sort_by_updated_desc);
        same_device_open.sort_by(sort_by_updated_desc);
        remote_open.sort_by(sort_by_updated_desc);
        closed.sort_by(sort_by_closed_desc);

        // `listDevices` (store.ts:1298-1304): the 7-day display TTL applies to
        // the QUERY's device list too, not only to `diagnostic_counts`.
        let device_cutoff = now_ms - DEFAULT_DEVICE_DISPLAY_TTL_DAYS * DAY_MS;
        let mut devices: Vec<&RegistryDeviceEntry> = state
            .devices_by_id
            .values()
            .filter(|device| device.last_seen_at >= device_cutoff)
            .collect();
        devices.sort_by_key(|d| std::cmp::Reverse(d.last_seen_at));
        let devices: Vec<Value> = devices
            .into_iter()
            .map(|d| {
                json!({
                    "deviceId": d.device_id,
                    "deviceLabel": d.device_label,
                    "lastSeenAt": d.last_seen_at,
                })
            })
            .collect();

        Ok(json!({
            "localOpen": local_open,
            "sameDeviceOpen": same_device_open,
            "remoteOpen": remote_open,
            "closed": closed,
            "devices": devices,
        }))
    }

    /// `(recordCount, deviceCount)` for `GET /api/debug`'s `tabsRegistry`
    /// field (legacy `debug-router.ts`: `tabsRegistryStore.count()` /
    /// `tabsRegistryStore.listDevices().length`).
    ///
    /// - `recordCount` mirrors `TabsRegistryStore.count()`
    ///   (server/tabs-registry/store.ts:1306-1309) EXACTLY: the RAW,
    ///   undeduplicated sum of `records.length` across every client's stored
    ///   open snapshot, PLUS the (already tabKey-deduped-by-construction)
    ///   closed-tombstone count — intentionally NOT `query()`'s
    ///   winner-per-tabKey collapse.
    /// - `deviceCount` mirrors `TabsRegistryStore.listDevices().length`
    ///   (store.ts:1298-1304): only devices seen within the last
    ///   [`DEFAULT_DEVICE_DISPLAY_TTL_DAYS`] days count.
    pub fn diagnostic_counts(&self) -> (usize, usize) {
        let state = self.inner.lock().expect("tabs registry lock");

        let record_count = state
            .open_snapshots_by_client
            .values()
            .map(|snapshot| snapshot.records.len())
            .sum::<usize>()
            + state.closed_by_tab_key.len();

        let cutoff = now_ms() - DEFAULT_DEVICE_DISPLAY_TTL_DAYS * DAY_MS;
        let device_count = state
            .devices_by_id
            .values()
            .filter(|device| device.last_seen_at >= cutoff)
            .count();

        (record_count, device_count)
    }
}

// ── Push pre-checks (store.ts:1091-1107 + ws-handler.ts:3122-3132) ──────────

/// Everything computable BEFORE the mutation lock: canonicalized records,
/// open/closed split, snapshot key, and the two payload hashes.
struct PreparedPush {
    key: String,
    open_records: Vec<Value>,
    closed_records: Vec<Value>,
    push_hash: String,
    open_snapshot_hash: String,
}

#[allow(clippy::too_many_arguments)]
fn prepare_push(
    server_instance_id: &str,
    device_id: &str,
    device_label: &str,
    client_instance_id: &str,
    snapshot_revision: i64,
    mut records: Vec<Value>,
    caps: &TabsStoreCaps,
) -> Result<PreparedPush, String> {
    for record in &mut records {
        {
            let map = record
                .as_object_mut()
                .ok_or_else(|| "Tabs registry record must be an object".to_string())?;
            // `assertSnapshotRecordOwnership` (store.ts:524-528): a record that
            // carries its own device identity must match the envelope's.
            for (field, expected) in [("deviceId", device_id), ("deviceLabel", device_label)] {
                if map
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| value != expected)
                {
                    return Err(
                        "Tabs registry record device metadata must match the snapshot device \
                         metadata"
                            .to_string(),
                    );
                }
            }
            // Authoritative identity stamping (ws-handler.ts:3122-3132) +
            // `clientInstanceId` canonicalization (store.ts:1104).
            map.insert("serverInstanceId".into(), json!(server_instance_id));
            map.insert("deviceId".into(), json!(device_id));
            map.insert("deviceLabel".into(), json!(device_label));
            map.insert("clientInstanceId".into(), json!(client_instance_id));
        }
        // `TabRegistryRecordSchema.parse` (store.ts:1092): pane-kind migration
        // + schema validation.
        normalize_registry_pane_kinds(record);
        validate_registry_record(record)?;
    }
    // Count / duplicate-tabKey / pane caps (store.ts:1093).
    validate_record_caps(&records, caps)?;
    // Serialized push byte cap (store.ts:1094-1097).
    let input = json!({
        "deviceId": device_id,
        "deviceLabel": device_label,
        "clientInstanceId": client_instance_id,
        "snapshotRevision": snapshot_revision,
        "records": records,
    });
    if canonical_stringify(&input).len() > caps.max_serialized_push_bytes {
        return Err(format!(
            "Tabs registry push payload exceeds {} bytes",
            caps.max_serialized_push_bytes
        ));
    }
    let records = match input {
        Value::Object(mut map) => match map.remove("records") {
            Some(Value::Array(records)) => records,
            _ => unreachable!("records array inserted above"),
        },
        _ => unreachable!("input built as an object above"),
    };
    // Open/closed split with per-partition caps (store.ts:1099-1107).
    let open_records: Vec<Value> = records
        .iter()
        .filter(|r| record_status(r) == "open")
        .cloned()
        .collect();
    let closed_records: Vec<Value> = records
        .iter()
        .filter(|r| record_status(r) == "closed")
        .cloned()
        .collect();
    if open_records.len() > caps.max_open_records_per_client_snapshot {
        return Err(format!(
            "Tabs registry client snapshot can contain at most {} open records",
            caps.max_open_records_per_client_snapshot
        ));
    }
    if closed_records.len() > caps.max_closed_records_per_push {
        return Err(format!(
            "Tabs registry push can contain at most {} closed records",
            caps.max_closed_records_per_push
        ));
    }
    let key = client_snapshot_key(device_id, client_instance_id)?;
    // `push_hash` covers ALL records; `open_snapshot_hash` the open ones only
    // (store.ts:1109-1123).
    let push_hash = build_snapshot_payload_hash(
        device_id,
        device_label,
        client_instance_id,
        snapshot_revision,
        &records,
    );
    let open_snapshot_hash = build_snapshot_payload_hash(
        device_id,
        device_label,
        client_instance_id,
        snapshot_revision,
        &open_records,
    );
    Ok(PreparedPush {
        key,
        open_records,
        closed_records,
        push_hash,
        open_snapshot_hash,
    })
}

// ── Mutation derivation (pure; shared by both modes) ────────────────────────

/// The revision guards + state fold of `replaceClientSnapshot`'s enqueued
/// mutation (store.ts:1135-1188). `Ok(None)` = idempotent-retry accept (same
/// revision, same `push_hash`) — no commit, no swap.
#[allow(clippy::too_many_arguments)]
fn derive_push_next(
    current: &CompactState,
    prepared: &PreparedPush,
    device_id: &str,
    device_label: &str,
    client_instance_id: &str,
    snapshot_revision: i64,
    now: i64,
    caps: &TabsStoreCaps,
) -> Result<Option<CompactState>, String> {
    let current_snapshot = current.open_snapshots_by_client.get(&prepared.key);
    let watermark = current.client_revisions_by_client.get(&prepared.key);

    // Revision monotonicity (store.ts:1136-1156): high water = max of the
    // live snapshot's and the watermark's revision.
    let high_water = current_snapshot
        .map_or(-1, |s| s.snapshot_revision)
        .max(watermark.map_or(-1, |w| w.snapshot_revision));
    if snapshot_revision < high_water {
        return Err(STALE_REVISION_ERROR.to_string());
    }
    if let Some(current_snapshot) = current_snapshot {
        if snapshot_revision == current_snapshot.snapshot_revision {
            if prepared.push_hash != current_snapshot.last_push_payload_hash {
                return Err(
                    "Duplicate snapshot revision has different tabs registry content".to_string(),
                );
            }
            return Ok(None); // idempotent retry of the exact same payload
        }
    } else if let Some(watermark) = watermark {
        if snapshot_revision <= watermark.snapshot_revision {
            // Non-resurrection: a retired client cannot re-push at or below
            // its watermark (store.ts:1148-1150).
            return Err(STALE_REVISION_ERROR.to_string());
        }
    }

    let mut next = current.clone();
    // Fold closed records, event-time winner per tabKey — but a closed record
    // LOSES to a newer open winner for that tabKey across ALL snapshots
    // (`findOpenWinnerForTab`, store.ts:556-568 + :1158-1164).
    for closed in &prepared.closed_records {
        let Some(tab_key) = record_tab_key(closed) else {
            continue;
        };
        if let Some(open_winner) = find_open_winner_for_tab(&next, &tab_key) {
            if compare_by_event_time(&open_winner, closed).is_gt() {
                continue;
            }
        }
        let winner = match next.closed_by_tab_key.get(&tab_key) {
            None => closed.clone(),
            Some(current_winner) => pick_event_winner(current_winner, closed).clone(),
        };
        next.closed_by_tab_key.insert(tab_key, winner);
    }
    // An open record newer than a tombstone clears it (store.ts:1166-1171).
    for open in &prepared.open_records {
        let Some(tab_key) = record_tab_key(open) else {
            continue;
        };
        if let Some(closed) = next.closed_by_tab_key.get(&tab_key) {
            if compare_by_event_time(closed, open).is_lt() {
                next.closed_by_tab_key.remove(&tab_key);
            }
        }
    }
    next.open_snapshots_by_client.insert(
        prepared.key.clone(),
        ClientOpenSnapshot {
            device_id: device_id.to_string(),
            device_label: device_label.to_string(),
            client_instance_id: client_instance_id.to_string(),
            snapshot_revision,
            last_push_payload_hash: prepared.push_hash.clone(),
            open_snapshot_payload_hash: prepared.open_snapshot_hash.clone(),
            snapshot_received_at: now,
            records: prepared.open_records.clone(),
        },
    );
    next.client_revisions_by_client.insert(
        prepared.key.clone(),
        ClientRevisionWatermark {
            device_id: device_id.to_string(),
            client_instance_id: client_instance_id.to_string(),
            snapshot_revision,
            last_seen_at: now,
        },
    );
    next.devices_by_id.insert(
        device_id.to_string(),
        RegistryDeviceEntry {
            device_id: device_id.to_string(),
            device_label: device_label.to_string(),
            last_seen_at: now,
        },
    );
    // Post-mutation maintenance + state-cap validation (store.ts:1186 +
    // commitState's validateStateCaps): violation rejects the push with the
    // state unchanged.
    apply_queued_maintenance(&mut next, now, caps);
    validate_state_caps(&next, caps)?;
    Ok(Some(next))
}

/// The two retire branches (store.ts:1198-1237). `None` = not accepted.
fn derive_retire_next(
    current: &CompactState,
    key: &str,
    device_id: &str,
    client_instance_id: &str,
    snapshot_revision: i64,
    now: i64,
    caps: &TabsStoreCaps,
) -> Option<CompactState> {
    match current.open_snapshots_by_client.get(key) {
        None => {
            // No live snapshot: only accept above the watermark, but STILL
            // write the watermark + refresh the device (store.ts:1200-1216) —
            // the device label comes from the existing entry when present.
            if let Some(watermark) = current.client_revisions_by_client.get(key) {
                if snapshot_revision <= watermark.snapshot_revision {
                    return None;
                }
            }
            let mut next = current.clone();
            next.client_revisions_by_client.insert(
                key.to_string(),
                ClientRevisionWatermark {
                    device_id: device_id.to_string(),
                    client_instance_id: client_instance_id.to_string(),
                    snapshot_revision,
                    last_seen_at: now,
                },
            );
            let device_label = current
                .devices_by_id
                .get(device_id)
                .map(|device| device.device_label.clone())
                .unwrap_or_else(|| device_id.to_string());
            next.devices_by_id.insert(
                device_id.to_string(),
                RegistryDeviceEntry {
                    device_id: device_id.to_string(),
                    device_label,
                    last_seen_at: now,
                },
            );
            apply_queued_maintenance(&mut next, now, caps);
            Some(next)
        }
        Some(current_snapshot) => {
            if snapshot_revision <= current_snapshot.snapshot_revision {
                return None;
            }
            // Remove the live snapshot; the watermark + device refresh take
            // their identity/label from the STORED snapshot (store.ts:1218-1236).
            let stored = current_snapshot.clone();
            let mut next = current.clone();
            next.open_snapshots_by_client.remove(key);
            next.client_revisions_by_client.insert(
                key.to_string(),
                ClientRevisionWatermark {
                    device_id: stored.device_id.clone(),
                    client_instance_id: stored.client_instance_id.clone(),
                    snapshot_revision,
                    last_seen_at: now,
                },
            );
            next.devices_by_id.insert(
                device_id.to_string(),
                RegistryDeviceEntry {
                    device_id: stored.device_id,
                    device_label: stored.device_label,
                    last_seen_at: now,
                },
            );
            apply_queued_maintenance(&mut next, now, caps);
            Some(next)
        }
    }
}

/// `findOpenWinnerForTab` (store.ts:556-568): the event-time winner for
/// `tab_key` across EVERY stored open snapshot, or `None`.
fn find_open_winner_for_tab(state: &CompactState, tab_key: &str) -> Option<Value> {
    let mut winner: Option<&Value> = None;
    for snapshot in state.open_snapshots_by_client.values() {
        for record in &snapshot.records {
            if record_str(record, "tabKey").as_deref() != Some(tab_key) {
                continue;
            }
            winner = Some(match winner {
                None => record,
                Some(current) => pick_event_winner(current, record),
            });
        }
    }
    winner.cloned()
}

fn record_tab_key(record: &Value) -> Option<String> {
    record_str(record, "tabKey")
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Extract the `records` array from a `tabs.sync.push` envelope (empty if absent).
pub fn envelope_records(value: &Value) -> Vec<Value> {
    value
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "tabs_tests.rs"]
mod tests;

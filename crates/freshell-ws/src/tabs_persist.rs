//! On-disk tabs-sync snapshot generations (continuity trio,
//! docs/plans/2026-07-22-continuity-safety-trio.md). Split out of `tabs.rs` to
//! keep that module under the port/AGENTS.md:81 1,000-line-per-file limit.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Max snapshot generations retained per (device, client) (oldest pruned).
pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;
/// Max snapshot files retained across ALL clients within ONE device dir. The
/// global-within-device bound that makes total disk independent of client-id
/// churn (a per-window clientInstanceId rotates freely, `tabRegistrySync.ts:38`).
pub const MAX_SNAPSHOT_FILES_PER_DEVICE: usize = 40;
/// Max device directories retained (LRU-by-newest-write eviction beyond this).
pub const MAX_SNAPSHOT_DEVICES: usize = 64;
/// A generation whose pretty-JSON exceeds this is skipped (never written).
pub const MAX_SNAPSHOT_BYTES: usize = 1_048_576;

/// INJECTIVE, containment-safe folder/name segment for a device OR client id.
/// Keeps ONLY `[A-Za-z0-9]`; escapes every other byte as `_<2-lower-hex>`
/// (so `-` -> `_2d`, `_` -> `_5f`, `/` -> `_2f`, `.` -> `_2e`). The output can
/// therefore never contain `.`, `/`, `\`, or `-`, so (a) `..`, `.`, `a/b`, and
/// absolute paths collapse to a single in-`<root>` child, (b) the `-` used as
/// the filename field delimiter is UNAMBIGUOUS (an encoded client id has no
/// hyphen, so client `a` cannot prefix-match client `a-b`'s files), and (c)
/// distinct ids never collide (URL-encode-style bijection). `None` for EMPTY.
pub fn encode_device_id(id: &str) -> Option<String> {
    if id.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(id.len());
    for b in id.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => out.push(b as char),
            _ => out.push_str(&format!("_{b:02x}")),
        }
    }
    Some(out)
}

/// Recursively rewrite `v` into a canonical form whose serialization is
/// INDEPENDENT of object key insertion order. This workspace enables
/// `serde_json`'s `preserve_order` (`Cargo.toml:33`), so two semantically-equal
/// objects built in different insertion orders otherwise serialize to different
/// bytes and hash apart. Objects → keys sorted (via `BTreeMap`); arrays recurse
/// element-wise (array ORDER is significant and preserved); scalars unchanged.
fn canonicalize(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<String, Value> = map
                .iter()
                .map(|(k, val)| (k.clone(), canonicalize(val)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// Stable, key-order-independent, COLLISION-RESISTANT content digest of a
/// snapshot: SHA-256 over the CANONICAL serialization of its `records`, truncated
/// to 32 lower-hex chars (128 bits). Used as a generation's `generationId`, the
/// restore marker's `sourceId`, and the restore-by-id key — so nothing is ever
/// referenced by a shifting positional index, two semantically-equal records
/// hash identically regardless of key order, and distinct content never collides
/// on a recovery-selection key (a 64-bit FNV digest over raw `preserve_order`
/// bytes was too weak AND not order-stable — both defects are fixed here).
pub fn snapshot_content_id(snap: &Value) -> String {
    use sha2::{Digest, Sha256};
    let records = snap.get("records").cloned().unwrap_or(Value::Null);
    let bytes = serde_json::to_vec(&canonicalize(&records)).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    digest[..16].iter().map(|b| format!("{b:02x}")).collect() // 16 bytes = 128 bits
}

/// The device dir, guaranteed to be a direct child of `<dir>` (belt-and-suspenders
/// containment: `encode_device_id` already strips separators).
fn device_dir_for(dir: &Path, device_id: &str) -> Option<PathBuf> {
    let enc = encode_device_id(device_id)?;
    let device_dir = dir.join(&enc);
    if device_dir.parent() != Some(dir) {
        return None;
    }
    Some(device_dir)
}

/// All generation FILES for one client, newest first (filename embeds a
/// zero-padded capturedAt then a zero-padded revision, so lexicographic
/// descending == chronological descending within a client; the encoded client
/// prefix has no `-`, so `client-a` never matches `client-a-b`'s files).
pub fn list_generations(dir: &Path, device_id: &str, client_instance_id: &str) -> Vec<PathBuf> {
    let Some(device_dir) = device_dir_for(dir, device_id) else {
        return Vec::new();
    };
    let Some(prefix) = encode_device_id(client_instance_id).map(|c| format!("{c}-")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&device_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
        })
        .collect();
    files.sort();
    files.reverse();
    files
}

/// Every generation file for a device across ALL clients, PARSED ONCE, newest
/// first. The single scan behind read_generation/read_generation_by_id/overview
/// (no per-index rescan). Sort: capturedAt desc, then filename desc — fully
/// deterministic even at equal capturedAt (filename embeds the padded revision).
/// FAIL-LOUD (`:480`): a MISSING device dir is absence (`Ok(empty)`); a `read_dir`
/// failure on an existing dir, or a `*.json` file that exists but cannot be read
/// or parsed, is an ERROR (`Err`) — a corrupt backup is never silently skipped.
fn all_generations_parsed(
    dir: &Path,
    device_id: &str,
) -> std::io::Result<Vec<(i64, PathBuf, Value)>> {
    let Some(device_dir) = device_dir_for(dir, device_id) else {
        return Ok(Vec::new());
    };
    let entries = match std::fs::read_dir(&device_dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut files: Vec<(i64, PathBuf, Value)> = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let text = std::fs::read_to_string(&path)?; // IO error on an existing file -> Err
        let v: Value = serde_json::from_str(&text).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("corrupt snapshot generation {}: {e}", path.display()),
            )
        })?;
        let captured = v.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);
        files.push((captured, path, v));
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    Ok(files)
}

/// The RAW device ids that have at least one persisted generation (read from
/// each device's stored `deviceId`, so the API never leaks the encoded folder
/// name). Sorted + deduped. FAIL-LOUD: a missing root is absence (`Ok(empty)`);
/// an unreadable dir or a corrupt device file is an ERROR (`Err`).
pub fn list_snapshot_devices(dir: &Path) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        let dpath = entry?.path();
        if !dpath.is_dir() {
            continue;
        }
        // First readable *.json in the device dir carries the raw deviceId.
        let first_json = std::fs::read_dir(&dpath)?
            .flatten()
            .map(|f| f.path())
            .find(|p| p.extension().is_some_and(|x| x == "json"));
        if let Some(p) = first_json {
            let text = std::fs::read_to_string(&p)?;
            let v: Value = serde_json::from_str(&text).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("corrupt snapshot generation {}: {e}", p.display()),
                )
            })?;
            if let Some(id) = v.get("deviceId").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// The Nth-newest single point-in-time FILE across the merged all-clients list
/// (0 = newest single file). A single-client file, NOT a coherent device
/// generation. `Ok(None)` if out of range, `Err` on IO/parse.
pub fn read_generation(
    dir: &Path,
    device_id: &str,
    generation: usize,
) -> std::io::Result<Option<Value>> {
    Ok(all_generations_parsed(dir, device_id)?
        .into_iter()
        .nth(generation)
        .map(|(_, _, v)| v))
}

/// The single point-in-time file whose content digest == `generation_id`
/// (stable across file additions/removals, unlike the positional index).
/// `Ok(None)` if no file matches, `Err` on IO/parse.
pub fn read_generation_by_id(
    dir: &Path,
    device_id: &str,
    generation_id: &str,
) -> std::io::Result<Option<Value>> {
    Ok(all_generations_parsed(dir, device_id)?
        .into_iter()
        .map(|(_, _, v)| v)
        .find(|v| snapshot_content_id(v) == generation_id))
}

/// Union of a SPECIFIC set of generations addressed by their stable ids — the
/// IMMUTABLE bundle the deploy capture recorded (`:2621`). Restores the SAME
/// coherent MULTI-CLIENT union the operator saw at capture time (the exact set of
/// per-client component generations), never a single client's slice. Runs the
/// SHARED `union_of_newest_per_client` over just the picked files, so a bundle of
/// each client's newest generation reproduces that capture's union exactly.
/// `Ok(None)` when NONE of the ids match; `Err` on IO/parse.
pub fn read_generations_union_by_ids(
    dir: &Path,
    device_id: &str,
    ids: &[String],
) -> std::io::Result<Option<Value>> {
    let want: std::collections::HashSet<String> = ids.iter().cloned().collect();
    let picked: Vec<(i64, PathBuf, Value)> = all_generations_parsed(dir, device_id)?
        .into_iter()
        .filter(|(_, _, v)| want.contains(&snapshot_content_id(v)))
        .collect();
    let Some((records, max_captured, max_rev, label_src)) = union_of_newest_per_client(&picked)
    else {
        return Ok(None);
    };
    Ok(Some(json!({
        "deviceId": label_src.get("deviceId").cloned().unwrap_or(Value::Null),
        "deviceLabel": label_src.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "snapshotRevision": max_rev, "capturedAt": max_captured, "records": records,
    })))
}

/// Newest generation file per client instance, deterministic even at equal
/// capturedAt (higher capturedAt wins; tie broken by the greater path — filename
/// embeds the padded revision). Returns (client -> parsed snapshot).
fn newest_per_client(parsed: &[(i64, PathBuf, Value)]) -> HashMap<String, (i64, PathBuf, Value)> {
    let mut newest: HashMap<String, (i64, PathBuf, Value)> = HashMap::new();
    for (captured, path, v) in parsed {
        let client = v
            .get("clientInstanceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let cand = (*captured, path.clone(), v.clone());
        newest
            .entry(client)
            .and_modify(|cur| {
                if (cand.0, &cand.1) > (cur.0, &cur.1) {
                    *cur = cand.clone();
                }
            })
            .or_insert(cand);
    }
    newest
}

/// THE ONE shared union routine (used by BOTH `read_device_union` and
/// `read_device_overview`, so they can never disagree — fixes the divergent
/// tie-break defect `:570`). Union of each client's NEWEST generation's records,
/// deduped by `tabKey` keeping the highest `(revision, updatedAt)`; when BOTH are
/// equal, the tie-break is the SOURCE generation's `(clientInstanceId,
/// generationId)` — components that ACTUALLY differ per candidate (the tab key
/// does NOT, so it can never break a tie). Returns
/// `(records, max_capturedAt, max_snapshotRevision, label_source)` or `None` when
/// the device has no generations. `deviceId`/`deviceLabel` come from the client
/// whose newest generation has the max `(capturedAt, generationId)` — never from
/// arbitrary iteration order.
fn union_of_newest_per_client(
    parsed: &[(i64, PathBuf, Value)],
) -> Option<(Vec<Value>, i64, i64, Value)> {
    let newest = newest_per_client(parsed);
    if newest.is_empty() {
        return None;
    }
    let label_src = newest
        .values()
        .max_by(|a, b| (a.0, snapshot_content_id(&a.2)).cmp(&(b.0, snapshot_content_id(&b.2))))
        .map(|(_, _, v)| v.clone())
        .unwrap_or(Value::Null);
    // A record's dedupe rank: `(revision, updatedAt, clientInstanceId, generationId)`.
    type Rank = (i64, i64, String, String);
    // tabKey -> (winning record, its rank tuple).
    let mut by_key: HashMap<String, (Value, Rank)> = HashMap::new();
    let (mut max_captured, mut max_rev) = (0i64, 0i64);
    for (_, _, snap) in newest.values() {
        max_captured =
            max_captured.max(snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0));
        max_rev = max_rev.max(
            snap.get("snapshotRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        );
        // Per-source tie-break components (constant within a generation).
        let src_client = snap
            .get("clientInstanceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let src_gen = snapshot_content_id(snap);
        for rec in snap
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let key = rec
                .get("tabKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let rev = rec.get("revision").and_then(Value::as_i64).unwrap_or(0);
            let upd = rec.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
            let rank = (rev, upd, src_client.clone(), src_gen.clone());
            let better = by_key.get(&key).is_none_or(|(_, cur)| &rank > cur);
            if better {
                by_key.insert(key, (rec, rank));
            }
        }
    }
    let mut records: Vec<Value> = by_key.into_values().map(|(rec, _)| rec).collect();
    records.sort_by_key(|r| {
        r.get("tabKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });
    Some((records, max_captured, max_rev, label_src))
}

/// The COHERENT device recovery snapshot (the shared union above). `Ok(None)`
/// when the device has no generations; `Err` on IO/parse (`:480`).
pub fn read_device_union(dir: &Path, device_id: &str) -> std::io::Result<Option<Value>> {
    let parsed = all_generations_parsed(dir, device_id)?;
    let Some((records, max_captured, max_rev, label_src)) = union_of_newest_per_client(&parsed)
    else {
        return Ok(None);
    };
    Ok(Some(json!({
        "deviceId": label_src.get("deviceId").cloned().unwrap_or(Value::Null),
        "deviceLabel": label_src.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "snapshotRevision": max_rev,
        "capturedAt": max_captured,
        "records": records,
    })))
}

/// SINGLE-scan device overview: `(union, generations_meta)` newest-first. The
/// list endpoint calls this ONCE per device (no per-index rescan/reparse). The
/// union comes from the SAME `union_of_newest_per_client` as `read_device_union`,
/// so the list view and the restore/read view agree. `Ok(None)` when absent,
/// `Err` on IO/parse (`:480`).
pub fn read_device_overview(
    dir: &Path,
    device_id: &str,
) -> std::io::Result<Option<(Value, Vec<Value>)>> {
    let parsed = all_generations_parsed(dir, device_id)?;
    if parsed.is_empty() {
        return Ok(None);
    }
    let meta: Vec<Value> = parsed
        .iter()
        .enumerate()
        .map(|(n, (captured, _, v))| {
            json!({
                "generation": n,
                "generationId": snapshot_content_id(v),
                "capturedAt": captured,
                "snapshotRevision": v.get("snapshotRevision").cloned().unwrap_or(Value::Null),
                "deviceLabel": v.get("deviceLabel").cloned().unwrap_or(Value::Null),
                "clientInstanceId": v.get("clientInstanceId").cloned().unwrap_or(Value::Null),
                "recordCount": v.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
            })
        })
        .collect();
    let (records, max_captured, max_rev, label_src) =
        union_of_newest_per_client(&parsed).unwrap_or((Vec::new(), 0, 0, Value::Null));
    let union = json!({
        "deviceId": label_src.get("deviceId").cloned().unwrap_or(Value::Null),
        "deviceLabel": label_src.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "snapshotRevision": max_rev, "capturedAt": max_captured, "records": records,
    });
    Ok(Some((union, meta)))
}

/// Process-wide serialization of ALL snapshot-directory mutation (write, prune,
/// device-file eviction, device-dir `remove_dir_all`). Held across the ENTIRE
/// read-plan-mutate cycle, so concurrent pushes to the SAME or DIFFERENT devices
/// can never race directory enumeration, eviction, or removal — the critical
/// data-loss defect (`:678`). `Mutex::new(())` is `const`, so this needs no
/// lazy init. Restores/pushes are low-frequency and this lock guards only the
/// filesystem cycle (in-memory registry work already dropped its own lock), so
/// contention is negligible and there is no nested acquisition to deadlock on.
static PERSIST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Remove any orphaned `.tmp` files a crashed write left behind in this device
/// dir. They are hidden dotfiles excluded from the `*.json` cap math, so an
/// un-reaped `.tmp` would silently consume disk OUTSIDE every cap and falsify the
/// hard 2.5 GiB bound. Reaped under `PERSIST_LOCK` (no other writer owns an
/// in-flight `.tmp` concurrently), BEFORE cap accounting, so caps see the true
/// on-disk footprint. Reap failures are LOGGED (never ignored).
fn sweep_orphan_tmp(device_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(device_dir) else {
        return;
    };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_some_and(|e| e == "tmp") {
            if let Err(err) = std::fs::remove_file(&path) {
                tracing::warn!(target: "freshell_ws::tabs", path = %path.display(),
                    error = %err, "tabs_snapshot_orphan_tmp_reap_failed");
            }
        }
    }
}

/// Write `<root>/<enc(device)>/<enc(client)>-<capturedAt:020>-r<rev:012>.json`
/// atomically (tmp + rename), then enforce every retention cap: oversize skip,
/// per-(device,client) generation cap, global-per-device file cap, device count
/// cap. The ENTIRE read-plan-mutate cycle runs under `PERSIST_LOCK` so it is
/// atomic w.r.t. any other push (`:678`). Best-effort: any failure is a WARN
/// with the full path + error, never an Err (a failed snapshot must never fail a
/// tabs push), and a partial-write failure leaves the last-good generations
/// intact (nothing is deleted before the new file is durably renamed into place).
#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_generation(
    dir: &Path,
    server_instance_id: &str,
    device_id: &str,
    device_label: &str,
    client_instance_id: &str,
    snapshot_revision: i64,
    open_records: &[Value],
    captured_at: i64,
) {
    // Serialize the whole filesystem cycle. Poison-tolerant: a prior panic
    // while persisting must not wedge all future pushes.
    let _guard = PERSIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let write = || -> std::io::Result<()> {
        let Some(device_dir) = device_dir_for(dir, device_id) else {
            return Ok(()); // empty/uncontainable device id -> never persist
        };
        let Some(client_enc) = encode_device_id(client_instance_id) else {
            return Ok(());
        };
        let snapshot = json!({
            "deviceId": device_id,
            "deviceLabel": device_label,
            "clientInstanceId": client_instance_id,
            "serverInstanceId": server_instance_id,
            "snapshotRevision": snapshot_revision,
            "capturedAt": captured_at,
            "records": open_records,
        });
        let bytes = serde_json::to_vec_pretty(&snapshot)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            tracing::warn!(target: "freshell_ws::tabs", device_id = %device_id,
                bytes = bytes.len(), "tabs_snapshot_skipped_oversize");
            return Ok(());
        }
        // Device cap: if this is a NEW device dir and we're at the cap, evict
        // the least-recently-written device (oldest max-capturedAt) first.
        enforce_device_cap(dir, &device_dir)?;
        std::fs::create_dir_all(&device_dir)?;
        // Reap orphaned `.tmp` BEFORE cap math so it reflects true disk use.
        sweep_orphan_tmp(&device_dir);
        let name = format!("{client_enc}-{captured_at:020}-r{snapshot_revision:012}.json");
        let tmp = device_dir.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, device_dir.join(&name))?;
        // Per-client prune: keep newest MAX_SNAPSHOT_GENERATIONS for THIS client.
        let mut client_files: Vec<PathBuf> = std::fs::read_dir(&device_dir)?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&format!("{client_enc}-")))
            })
            .collect();
        client_files.sort();
        while client_files.len() > MAX_SNAPSHOT_GENERATIONS {
            remove_file_logged(&client_files.remove(0));
        }
        // GLOBAL-per-device cap: bound total files across ALL clients so a
        // rotating clientInstanceId can't grow the dir without limit. Evict
        // the globally OLDEST files (by capturedAt embedded in the filename,
        // which sorts client-prefix-then-capturedAt) until at/under the cap.
        enforce_device_file_cap(&device_dir)?;
        Ok(())
    };
    if let Err(err) = write() {
        tracing::warn!(target: "freshell_ws::tabs", device_id = %device_id, dir = %dir.display(),
            error = %err, "tabs_snapshot_persist_failed: generation not written");
    }
}

/// Remove a file, logging (not swallowing) any failure.
fn remove_file_logged(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        tracing::warn!(target: "freshell_ws::tabs", path = %path.display(),
            error = %err, "tabs_snapshot_evict_file_failed");
    }
}

/// Enforce MAX_SNAPSHOT_FILES_PER_DEVICE across ALL clients in one device dir.
/// Removes the globally OLDEST files (by the capturedAt field embedded in the
/// filename `<client>-<capturedAt:020>-r<rev:012>.json`; `<client>` is escaped
/// and has no `-`, so the 2nd `-`-delimited field is always capturedAt) until
/// at/under the cap. Caller holds `PERSIST_LOCK`; the `.tmp` sweep already ran,
/// so only real `*.json` generations are in view. This is the global-within-
/// device bound that survives client-id rotation.
fn enforce_device_file_cap(device_dir: &Path) -> std::io::Result<()> {
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(device_dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?;
            let captured = name.split('-').nth(1)?.to_string(); // 020-padded -> lexicographic == numeric
            Some((captured, p))
        })
        .collect();
    if files.len() <= MAX_SNAPSHOT_FILES_PER_DEVICE {
        return Ok(());
    }
    files.sort(); // oldest capturedAt (then filename) first
    while files.len() > MAX_SNAPSHOT_FILES_PER_DEVICE {
        let (_, victim) = files.remove(0);
        remove_file_logged(&victim);
    }
    Ok(())
}

/// Enforce MAX_SNAPSHOT_DEVICES. If `target_dir` is NEW and the root is already
/// at the cap, remove the device dir with the OLDEST newest-generation capturedAt.
/// Caller holds `PERSIST_LOCK`, so no writer is populating a victim concurrently.
/// A missing root is absence (`Ok`); any other `read_dir` failure propagates so
/// the caller logs it rather than silently skipping the cap.
fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    if target_dir.exists() {
        return Ok(());
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let mut dirs: Vec<(i64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| {
            let newest = std::fs::read_dir(&p)
                .into_iter()
                .flatten()
                .flatten()
                .map(|f| f.path())
                .filter(|f| f.extension().is_some_and(|x| x == "json"))
                .filter_map(|f| {
                    serde_json::from_str::<Value>(&std::fs::read_to_string(&f).ok()?)
                        .ok()?
                        .get("capturedAt")
                        .and_then(Value::as_i64)
                })
                .max()
                .unwrap_or(0);
            (newest, p)
        })
        .collect();
    while dirs.len() >= MAX_SNAPSHOT_DEVICES {
        dirs.sort_by_key(|(c, _)| *c);
        let (_, victim) = dirs.remove(0);
        if let Err(err) = std::fs::remove_dir_all(&victim) {
            tracing::warn!(target: "freshell_ws::tabs", path = %victim.display(),
                error = %err, "tabs_snapshot_evict_device_failed");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabs::TabsRegistry;
    use serde_json::{json, Value};

    fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
        json!({ "tabKey": tab_key, "tabId": tab_key, "tabName": tab_name, "status": "open",
                "revision": updated_at, "updatedAt": updated_at, "paneCount": 0, "panes": [] })
    }
    fn codex_pane_record(tab_key: &str, session_id: &str, rev_updated: i64) -> Value {
        let mut rec = open_record(tab_key, "codex tab", rev_updated);
        rec["revision"] = json!(rev_updated);
        rec["panes"] = json!([{
            "paneId": "pane-1", "kind": "terminal",
            "payload": {
                "mode": "codex",
                "sessionRef": { "provider": "codex", "sessionId": session_id },
                "initialCwd": "/tmp/proj",
                "liveTerminal": { "terminalId": "term-1", "serverInstanceId": "srv-1" }
            }
        }]);
        rec
    }
    // Direct deterministic write (explicit captured_at + revision).
    fn put(
        dir: &std::path::Path,
        device: &str,
        client: &str,
        rev: i64,
        captured: i64,
        recs: Vec<Value>,
    ) {
        persist_generation(dir, "srv-1", device, "Dev", client, rev, &recs, captured);
    }
    // Result-unwrapping helpers so the tests read cleanly (readers are fail-loud).
    fn union(dir: &std::path::Path, device: &str) -> Option<Value> {
        read_device_union(dir, device).expect("read_device_union io")
    }
    fn gen_n(dir: &std::path::Path, device: &str, n: usize) -> Option<Value> {
        read_generation(dir, device, n).expect("read_generation io")
    }
    fn gen_by_id(dir: &std::path::Path, device: &str, id: &str) -> Option<Value> {
        read_generation_by_id(dir, device, id).expect("read_generation_by_id io")
    }
    fn devices(dir: &std::path::Path) -> Vec<String> {
        list_snapshot_devices(dir).expect("list_snapshot_devices io")
    }

    #[test]
    fn persisted_generation_written_with_session_ref_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
        reg.replace_client_snapshot(
            "srv-1",
            "dev a/1",
            "Device A",
            "client-a1",
            1,
            vec![codex_pane_record("dev-a:tab-1", "abc-123", 1000)],
        )
        .unwrap();
        let gens = list_generations(dir.path(), "dev a/1", "client-a1");
        assert_eq!(gens.len(), 1);
        let snap = union(dir.path(), "dev a/1").expect("newest generation");
        assert_eq!(snap["deviceId"], "dev a/1");
        assert_eq!(snap["snapshotRevision"], 1);
        assert_eq!(
            snap["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
            "abc-123"
        );
        // list_snapshot_devices returns the RAW id, not the encoded folder name.
        assert_eq!(devices(dir.path()), vec!["dev a/1".to_string()]);
    }

    #[test]
    fn encode_id_is_injective_containment_safe_escapes_hyphen_and_rejects_empty() {
        // No `.`, `/`, or `-` survives -> no traversal, no shared-dir collapse,
        // and `-` is reserved as the filename field delimiter.
        for raw in ["..", ".", "../../etc", "a/b", "a-b", "", "  "] {
            if let Some(enc) = encode_device_id(raw) {
                assert!(
                    !enc.contains('.')
                        && !enc.contains('/')
                        && !enc.contains('\\')
                        && !enc.contains('-'),
                    "{raw} -> {enc}"
                );
            }
        }
        assert_eq!(
            encode_device_id(""),
            None,
            "empty id is rejected (never persisted)"
        );
        assert_ne!(encode_device_id("dev a/1"), encode_device_id("dev_a_1"));
        assert_ne!(encode_device_id("a"), encode_device_id("a-b")); // hyphen collision pair maps apart
                                                                    // Containment incl. a NESTED external traversal id: `../../escape/deep`
                                                                    // resolves to a SINGLE direct child of <root> and writes nothing above it.
                                                                    // (<root> is nested one level INSIDE the tempdir so its parent is a dir
                                                                    // this test fully controls — scanning the raw tempdir parent would be
                                                                    // /tmp itself, where unrelated processes' *.json files live and would
                                                                    // make the stray-file assertion flaky.)
        let dir = tempfile::tempdir().unwrap();
        let nested_root = dir.path().join("snapshot-root");
        std::fs::create_dir(&nested_root).unwrap();
        let root = nested_root.as_path();
        let reg = TabsRegistry::with_persist_dir(root.to_path_buf());
        reg.replace_client_snapshot(
            "srv",
            "../../escape/deep",
            "x",
            "c1",
            1,
            vec![open_record("t:1", "t", 1)],
        )
        .unwrap();
        // The encoded dir is a DIRECT child of <root> (parent == root), so it
        // cannot escape; and <root> has exactly ONE device subdir.
        let device_dir = device_dir_for(root, "../../escape/deep").unwrap();
        assert_eq!(device_dir.parent(), Some(root));
        let subdirs: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        assert_eq!(
            subdirs.len(),
            1,
            "traversal id must not fan out or escape: {subdirs:?}"
        );
        // Nothing landed directly in <root>'s parent as a stray *.json.
        let parent = root.parent().unwrap();
        let stray: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
            .collect();
        assert!(
            stray.is_empty(),
            "traversal id wrote a stray json into the root's parent: {stray:?}"
        );
        assert_eq!(devices(root), vec!["../../escape/deep".to_string()]);
    }

    #[test]
    fn client_hyphen_ownership_is_unambiguous() {
        // Real client-id shapes: `client-a` is a PREFIX substring of `client-a-b`.
        // With `-` escaped, list_generations/prune for one never selects the other.
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "client-a",
            1,
            1000,
            vec![open_record("dev:t1", "a", 1)],
        );
        put(
            dir.path(),
            "dev",
            "client-a-b",
            1,
            1001,
            vec![open_record("dev:t2", "b", 1)],
        );
        assert_eq!(
            list_generations(dir.path(), "dev", "client-a").len(),
            1,
            "client-a must NOT match client-a-b's files"
        );
        assert_eq!(list_generations(dir.path(), "dev", "client-a-b").len(), 1);
    }

    #[test]
    fn generations_pruned_per_client_padded_ordering() {
        // EQUAL capturedAt for every write so ONLY the zero-padded revision can
        // decide order -> this actually proves r9 < r10 (not timestamp order).
        let dir = tempfile::tempdir().unwrap();
        for rev in 1..=(MAX_SNAPSHOT_GENERATIONS as i64 + 7) {
            put(
                dir.path(),
                "dev",
                "c1",
                rev,
                5000,
                vec![open_record("dev:t1", "x", rev)],
            );
        }
        let gens = list_generations(dir.path(), "dev", "c1");
        assert_eq!(gens.len(), MAX_SNAPSHOT_GENERATIONS);
        assert_eq!(
            gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"],
            MAX_SNAPSHOT_GENERATIONS as i64 + 7
        );
        let oldest = gen_n(dir.path(), "dev", MAX_SNAPSHOT_GENERATIONS - 1).unwrap();
        assert_eq!(
            oldest["snapshotRevision"],
            (MAX_SNAPSHOT_GENERATIONS as i64 + 7) - 4
        );
    }

    #[test]
    fn union_newest_per_client_tiebreak_is_deterministic_on_equal_capturedat() {
        // Same client, two files at the SAME capturedAt, revisions 9 and 10 ->
        // the newest-per-client pick must be r10 (padded revision, then filename),
        // never arbitrary read_dir order.
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "c1",
            9,
            7000,
            vec![codex_pane_record("dev:t", "sess-9", 9)],
        );
        put(
            dir.path(),
            "dev",
            "c1",
            10,
            7000,
            vec![codex_pane_record("dev:t", "sess-10", 10)],
        );
        let u = union(dir.path(), "dev").unwrap();
        assert_eq!(
            u["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
            "sess-10"
        );
    }

    #[test]
    fn content_id_is_key_order_independent_and_collision_distinct() {
        // `preserve_order` is enabled workspace-wide, so two records with the SAME
        // fields inserted in a DIFFERENT key order serialize to different bytes;
        // canonicalization must make them hash IDENTICALLY, and distinct content
        // must still hash apart (a real 256-bit digest, no accidental collisions).
        let a = json!({ "records": [ { "tabKey": "k", "revision": 1, "updatedAt": 2 } ] });
        let mut rec = serde_json::Map::new();
        rec.insert("updatedAt".into(), json!(2));
        rec.insert("revision".into(), json!(1));
        rec.insert("tabKey".into(), json!("k"));
        let b = json!({ "records": [ Value::Object(rec) ] });
        assert_eq!(
            snapshot_content_id(&a),
            snapshot_content_id(&b),
            "key insertion order must not change the content id"
        );
        assert_eq!(
            snapshot_content_id(&a).len(),
            32,
            "128-bit digest = 32 hex chars"
        );
        let c = json!({ "records": [ { "tabKey": "k", "revision": 1, "updatedAt": 3 } ] });
        assert_ne!(
            snapshot_content_id(&a),
            snapshot_content_id(&c),
            "distinct content hashes apart"
        );
    }

    #[test]
    fn union_exact_tie_equal_rev_and_updatedat_resolves_deterministically() {
        // Same tabKey, EQUAL revision AND equal updatedAt AND equal capturedAt but
        // different owning client + different sessionRef -> the (revision,
        // updatedAt) rank ties; the winner is decided by the SOURCE
        // (clientInstanceId, generationId) and MUST be identical on every read and
        // identical between the union and overview paths (they share one routine).
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "clientA",
            5,
            6000,
            vec![codex_pane_record("dev:shared", "sess-A", 5)],
        );
        put(
            dir.path(),
            "dev",
            "clientB",
            5,
            6000,
            vec![codex_pane_record("dev:shared", "sess-B", 5)],
        );
        let winner = union(dir.path(), "dev").unwrap()["records"][0]["panes"][0]["payload"]
            ["sessionRef"]["sessionId"]
            .clone();
        assert!(winner == "sess-A" || winner == "sess-B");
        for _ in 0..20 {
            assert_eq!(
                union(dir.path(), "dev").unwrap()["records"][0]["panes"][0]["payload"]
                    ["sessionRef"]["sessionId"],
                winner,
                "exact-tie winner must be deterministic across reads"
            );
        }
        let (ov_union, _) = read_device_overview(dir.path(), "dev").unwrap().unwrap();
        assert_eq!(
            ov_union["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], winner,
            "overview and union paths must agree on the tie winner"
        );
    }

    #[test]
    fn two_clients_same_device_equal_capturedat_union_keeps_both() {
        // FORCE equal capturedAt across the two clients.
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "clientA",
            1,
            8000,
            vec![codex_pane_record("dev:tabA", "sess-A", 1)],
        );
        put(
            dir.path(),
            "dev",
            "clientB",
            1,
            8000,
            vec![codex_pane_record("dev:tabB", "sess-B", 1)],
        );
        assert_eq!(list_generations(dir.path(), "dev", "clientA").len(), 1);
        assert_eq!(list_generations(dir.path(), "dev", "clientB").len(), 1);
        let u = union(dir.path(), "dev").unwrap();
        let keys: Vec<String> = u["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["tabKey"].as_str().unwrap().to_string())
            .collect();
        assert!(
            keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
            "union dropped a client's tabs: {keys:?}"
        );
    }

    #[test]
    fn union_dedupes_shared_tabkey_keeping_highest_revision() {
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "clientA",
            7,
            9000,
            vec![codex_pane_record("dev:shared", "sess-new", 7)],
        );
        put(
            dir.path(),
            "dev",
            "clientB",
            3,
            9000,
            vec![codex_pane_record("dev:shared", "sess-old", 3)],
        );
        let u = union(dir.path(), "dev").unwrap();
        let recs = u["records"].as_array().unwrap();
        assert_eq!(recs.len(), 1, "shared tabKey must dedupe");
        assert_eq!(
            recs[0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
            "sess-new"
        );
    }

    #[test]
    fn empty_snapshot_does_not_overwrite_last_good_generation() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
        reg.replace_client_snapshot(
            "srv-1",
            "dev",
            "Dev",
            "c1",
            1,
            vec![open_record("dev:t1", "good", 1000)],
        )
        .unwrap();
        reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 2, vec![])
            .unwrap();
        assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
    }

    #[test]
    fn stale_revision_persists_nothing_and_no_dir_persists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
        reg.replace_client_snapshot(
            "srv-1",
            "dev",
            "Dev",
            "c1",
            5,
            vec![open_record("dev:t1", "one", 10)],
        )
        .unwrap();
        assert!(reg
            .replace_client_snapshot("srv-1", "dev", "Dev", "c1", 4, vec![])
            .is_err());
        assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
        let plain = TabsRegistry::new(); // no persist dir -> Option path is a no-op
        plain
            .replace_client_snapshot(
                "srv-1",
                "dev",
                "Dev",
                "c1",
                1,
                vec![open_record("dev:t1", "one", 10)],
            )
            .unwrap();
    }

    #[test]
    fn device_cap_evicts_least_recently_written_device() {
        // Explicit ascending capturedAt -> the victim is deterministically dev-000.
        let dir = tempfile::tempdir().unwrap();
        for n in 0..=(MAX_SNAPSHOT_DEVICES) {
            let dev = format!("dev-{n:03}");
            put(
                dir.path(),
                &dev,
                "c1",
                1,
                1000 + n as i64,
                vec![open_record(&format!("{dev}:t"), "t", 1)],
            );
        }
        assert_eq!(devices(dir.path()).len(), MAX_SNAPSHOT_DEVICES);
        assert!(union(dir.path(), "dev-000").is_none());
        assert!(union(dir.path(), &format!("dev-{:03}", MAX_SNAPSHOT_DEVICES)).is_some());
    }

    #[test]
    fn global_per_device_cap_holds_across_rotating_client_ids() {
        // THE CRITICAL BOUND: a single device cycling many per-window client ids
        // must never accumulate more than MAX_SNAPSHOT_FILES_PER_DEVICE files.
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(MAX_SNAPSHOT_FILES_PER_DEVICE * 3) {
            let client = format!("client-{n}"); // rotates every write, like a new window
            put(
                dir.path(),
                "dev",
                &client,
                1,
                1000 + n as i64,
                vec![open_record("dev:t", "t", 1)],
            );
        }
        let enc = encode_device_id("dev").unwrap();
        let count = std::fs::read_dir(dir.path().join(enc))
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .count();
        assert!(
            count <= MAX_SNAPSHOT_FILES_PER_DEVICE,
            "global-per-device file cap breached: {count} > {MAX_SNAPSHOT_FILES_PER_DEVICE}"
        );
    }

    #[test]
    fn content_id_is_stable_and_selects_the_right_generation() {
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "c1",
            1,
            1000,
            vec![codex_pane_record("dev:t", "sess-old", 1)],
        );
        put(
            dir.path(),
            "dev",
            "c1",
            2,
            2000,
            vec![codex_pane_record("dev:t", "sess-new", 2)],
        );
        let old = gen_n(dir.path(), "dev", 1).unwrap();
        let id = snapshot_content_id(&old);
        // Stable: recomputing over the re-read file yields the same id.
        assert_eq!(
            id,
            snapshot_content_id(&gen_n(dir.path(), "dev", 1).unwrap())
        );
        // Selecting by id returns the OLD generation regardless of index shifts.
        let by_id = gen_by_id(dir.path(), "dev", &id).unwrap();
        assert_eq!(
            by_id["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
            "sess-old"
        );
    }

    #[test]
    fn oversize_snapshot_is_skipped_not_written() {
        let dir = tempfile::tempdir().unwrap();
        // Seed a good generation, then an oversize push must NOT overwrite/delete it.
        put(
            dir.path(),
            "dev",
            "c1",
            1,
            1000,
            vec![open_record("dev:t1", "good", 1)],
        );
        let big = "x".repeat(MAX_SNAPSHOT_BYTES + 10);
        let mut rec = open_record("dev:t1", "big", 2);
        rec["blob"] = json!(big);
        put(dir.path(), "dev", "c1", 2, 2000, vec![rec]);
        assert_eq!(
            list_generations(dir.path(), "dev", "c1").len(),
            1,
            "oversize generation must be skipped (WARN); last-good stays intact"
        );
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
    }

    #[test]
    fn concurrent_pushes_same_and_different_devices_stay_consistent() {
        // CONCURRENCY (`:678`): threads persist to the SAME device (distinct
        // clients) AND to DIFFERENT devices at once. The process-wide persist lock
        // must serialize the whole filesystem cycle so no read_dir/eviction race
        // corrupts state: every device stays readable and within its caps, and no
        // orphaned `.tmp` survives.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mut handles = Vec::new();
        for n in 0..24usize {
            let root = root.clone();
            handles.push(std::thread::spawn(move || {
                let device = if n % 2 == 0 {
                    "shared-dev".to_string()
                } else {
                    format!("dev-{n}")
                };
                let client = format!("client-{n}");
                for rev in 1..=6i64 {
                    persist_generation(
                        &root,
                        "srv",
                        &device,
                        "D",
                        &client,
                        rev,
                        &[open_record(&format!("{device}:t{n}"), "t", rev)],
                        1000 + rev,
                    );
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let enc = encode_device_id("shared-dev").unwrap();
        let device_dir = root.join(&enc);
        let json_count = std::fs::read_dir(&device_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .count();
        assert!(
            json_count <= MAX_SNAPSHOT_FILES_PER_DEVICE,
            "global-per-device cap breached under concurrency: {json_count}"
        );
        assert!(
            union(&root, "shared-dev").is_some(),
            "shared device union unreadable after concurrent writes"
        );
        let tmp_count = std::fs::read_dir(&device_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .count();
        assert_eq!(tmp_count, 0, "orphaned .tmp left after concurrent writes");
    }

    #[test]
    fn orphan_tmp_is_reaped_before_cap_math() {
        // FAILURE INJECTION (`:678`): a crashed write left a `.tmp`. The next
        // persist reaps it (it never lingers outside the caps), and reading the
        // device still returns the newest good generation.
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "c1",
            1,
            1000,
            vec![open_record("dev:t", "t", 1)],
        );
        let enc = encode_device_id("dev").unwrap();
        let device_dir = dir.path().join(&enc);
        std::fs::write(device_dir.join(".c1-orphan.tmp"), b"partial write").unwrap();
        put(
            dir.path(),
            "dev",
            "c1",
            2,
            2000,
            vec![open_record("dev:t", "t", 2)],
        );
        let tmp = std::fs::read_dir(&device_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .count();
        assert_eq!(tmp, 0, "orphan .tmp must be reaped before cap math");
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 2);
    }

    #[test]
    fn union_by_ids_restores_the_multi_client_bundle_not_a_single_client() {
        // Two clients, each newest generation is one bundle COMPONENT. The
        // union-by-ids of BOTH ids yields BOTH clients' tabs (:2621); a single
        // component id yields only that client's tab.
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "clientA",
            1,
            1000,
            vec![codex_pane_record("dev:tabA", "sess-A", 1)],
        );
        put(
            dir.path(),
            "dev",
            "clientB",
            1,
            1001,
            vec![codex_pane_record("dev:tabB", "sess-B", 1)],
        );
        let a_id = snapshot_content_id(&gen_by_id_scan(dir.path(), "dev", "clientA"));
        let b_id = snapshot_content_id(&gen_by_id_scan(dir.path(), "dev", "clientB"));
        let both = read_generations_union_by_ids(dir.path(), "dev", &[a_id.clone(), b_id.clone()])
            .unwrap()
            .unwrap();
        let keys: Vec<String> = both["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["tabKey"].as_str().unwrap().to_string())
            .collect();
        assert!(
            keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
            "bundle must union ALL components: {keys:?}"
        );
        let only_a = read_generations_union_by_ids(dir.path(), "dev", &[a_id])
            .unwrap()
            .unwrap();
        assert_eq!(
            only_a["records"].as_array().unwrap().len(),
            1,
            "single component = one client only"
        );
        assert!(
            read_generations_union_by_ids(dir.path(), "dev", &["nope".to_string()])
                .unwrap()
                .is_none()
        );
    }
    // Helper: the parsed generation owned by a given client (there is one each here).
    fn gen_by_id_scan(dir: &std::path::Path, device: &str, client: &str) -> Value {
        let path = list_generations(dir, device, client)
            .into_iter()
            .next()
            .unwrap();
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn corrupt_generation_file_reads_as_error_not_absence() {
        // FAIL-LOUD (`:480`): a present-but-unparseable generation is an ERROR,
        // never silently treated as "no backup". A device with NO dir is genuine
        // absence (Ok(None)).
        let dir = tempfile::tempdir().unwrap();
        put(
            dir.path(),
            "dev",
            "c1",
            1,
            1000,
            vec![open_record("dev:t", "t", 1)],
        );
        let enc = encode_device_id("dev").unwrap();
        let file = std::fs::read_dir(dir.path().join(&enc))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "json"))
            .unwrap();
        std::fs::write(&file, b"{ not valid json").unwrap();
        assert!(
            read_device_union(dir.path(), "dev").is_err(),
            "corrupt file -> Err, not Ok(None)"
        );
        assert!(read_generation(dir.path(), "dev", 0).is_err());
        assert!(list_snapshot_devices(dir.path()).is_err());
        assert!(
            read_device_union(dir.path(), "ghost").unwrap().is_none(),
            "absent device is Ok(None)"
        );
    }
}

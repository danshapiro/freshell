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
#[path = "tabs_persist_tests.rs"]
mod tests;

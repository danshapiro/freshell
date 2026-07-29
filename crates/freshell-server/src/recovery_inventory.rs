//! B3/P1.9 Task 1 — the PURE recovery-inventory builder: joins tabs-snapshot
//! device unions with pane-ledger binding rows into the `/api/recovery`
//! inventory shape. No I/O here — Task 2 (the HTTP route) feeds it from the
//! snapshot store, the ledger, and the terminal registry, and consumes
//! `select_foreign_recent_generation_ids` when composing each device's union.

use freshell_recovery::RecoveryOwnerKey;
use freshell_ws::pane_ledger::{BindingRow, RetiredReason, RowState};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct DeviceUnion {
    pub device_id: String,
    pub union_doc: Value,
}

const STALE_CLIENT_MS: u64 = 15 * 60 * 1000; // heartbeat cadence is 5 min (tabRegistrySync.ts:21, 475-477)

/// A15 staleness + A16 concurrent-client rules (D2): drop the requester's own
/// generations; drop clients ALL of whose retained generations postdate
/// `boot_cutoff_ms` (a client born after this browser session booted is a
/// concurrently-opened fresh window, never lost data — a lost client's pushes
/// all predate the fresh boot, so retention depth cannot misclassify it); then
/// drop clients whose newest generation is >15 min older than the device max
/// over the REMAINING clients (junk must never stale-out real recovery data).
pub fn select_foreign_recent_generation_ids(
    generations: &[Value],
    exclude_client: &str,
    boot_cutoff_ms: u64,
) -> Vec<String> {
    let foreign: Vec<&Value> = generations
        .iter()
        .filter(|g| g["clientInstanceId"].as_str() != Some(exclude_client))
        .collect();
    let mut oldest_by_client: HashMap<&str, u64> = HashMap::new();
    let mut newest_by_client: HashMap<&str, u64> = HashMap::new();
    for g in &foreign {
        let c = g["clientInstanceId"].as_str().unwrap_or("");
        let t = g["capturedAt"].as_u64().unwrap_or(0);
        let o = oldest_by_client.entry(c).or_insert(u64::MAX);
        if t < *o {
            *o = t;
        }
        let e = newest_by_client.entry(c).or_insert(0);
        if t > *e {
            *e = t;
        }
    }
    let pre_boot = |c: &str| oldest_by_client.get(c).copied().unwrap_or(u64::MAX) < boot_cutoff_ms;
    let device_max = newest_by_client
        .iter()
        .filter(|(c, _)| pre_boot(c))
        .map(|(_, t)| *t)
        .max()
        .unwrap_or(0);
    foreign
        .iter()
        .filter(|g| {
            let c = g["clientInstanceId"].as_str().unwrap_or("");
            pre_boot(c)
                && newest_by_client.get(c).copied().unwrap_or(0) + STALE_CLIENT_MS >= device_max
        })
        .filter_map(|g| g["generationId"].as_str().map(String::from))
        .collect()
}

fn owner_key(provider: &str, session_id: &str, provider_scope: Option<&str>) -> RecoveryOwnerKey {
    RecoveryOwnerKey {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        provider_scope: (provider == "amplifier")
            .then(|| provider_scope.map(str::to_string))
            .flatten(),
    }
}

enum Verdict {
    Bound(RecoveryOwnerKey),
    Closed,
    GcExpired,
    Unknown,
}

/// Resolve a snapshot's sessionRef claim to its EFFECTIVE identity per D4 by
/// walking the ledger's superseded chain (bounded — a cycle degrades to
/// `GcExpired`, never loops).
fn resolve(initial: &RecoveryOwnerKey, by_key: &HashMap<RecoveryOwnerKey, &BindingRow>) -> Verdict {
    let mut owner = initial.clone();
    for _ in 0..10 {
        match by_key.get(&owner) {
            None => {
                return if &owner == initial {
                    Verdict::Unknown
                } else {
                    Verdict::GcExpired
                }
            }
            Some(row) if row_is_bound(row) => return Verdict::Bound(row_owner(row)),
            Some(row) => match row_successor(row) {
                Some(next) => owner = next,
                None => {
                    return if row_reason_is_closed(row) {
                        Verdict::Closed
                    } else {
                        Verdict::GcExpired
                    }
                }
            },
        }
    }
    Verdict::GcExpired
}

pub fn build_inventory(
    device_unions: Vec<DeviceUnion>,
    bindings: Vec<BindingRow>,
    live_session_keys: HashSet<RecoveryOwnerKey>,
) -> Value {
    let by_key: HashMap<RecoveryOwnerKey, &BindingRow> =
        bindings.iter().map(|r| (row_owner(r), r)).collect();

    // sort newest-first; primary device = greatest capturedAt with >=1 record
    let mut unions = device_unions;
    unions.sort_by_key(|d| std::cmp::Reverse(d.union_doc["capturedAt"].as_u64().unwrap_or(0)));

    // Pass 1 - resolve EVERY pane in EVERY union (not just the primary): effective refs
    // feed the cross-device ledgerOnly rule (A4) and the contentId substance (A5/A6);
    // the primary union's tabs feed `device`.
    let mut referenced: HashSet<RecoveryOwnerKey> = HashSet::new();
    let mut substance: Vec<String> = Vec::new();
    let mut tabs_per_union: Vec<Vec<Value>> = Vec::new();
    for d in &unions {
        let doc = &d.union_doc;
        let device_id = d.device_id.clone();
        let tabs: Vec<Value> = doc["records"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|rec| {
                let panes: Vec<Value> = rec["panes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|pane| {
                        let payload = &pane["payload"];
                        let snap_ref = payload.get("sessionRef").filter(|v| !v.is_null()).cloned();
                        let (ledger_state, eff_owner, eff_ref) = match &snap_ref {
                            None => ("unknown", None, None),
                            Some(r) => {
                                let claimed_owner = owner_key(
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or(""),
                                    None,
                                );
                                match resolve(&claimed_owner, &by_key) {
                                    Verdict::Bound(owner) => {
                                        let session_ref = owner_session_ref(&owner);
                                        ("bound", Some(owner), Some(session_ref))
                                    }
                                    Verdict::Closed => ("closed", None, None),
                                    Verdict::GcExpired => {
                                        ("gc_expired", Some(claimed_owner), Some(r.clone()))
                                    }
                                    Verdict::Unknown => {
                                        ("unknown", Some(claimed_owner), Some(r.clone()))
                                    }
                                }
                            }
                        };
                        let eff_str = eff_owner
                            .as_ref()
                            .map(owner_substance)
                            .unwrap_or_else(|| "-".into());
                        let live = eff_owner
                            .as_ref()
                            .map(|owner| live_session_keys.contains(owner))
                            .unwrap_or(false);
                        if let Some(owner) = eff_owner {
                            referenced.insert(owner);
                        }
                        // TIMESTAMP-FREE substance line: capturedAt/updatedAt deliberately absent (D3)
                        substance.push(format!(
                            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
                            device_id,
                            rec["tabKey"].as_str().unwrap_or(""),
                            pane["paneId"].as_str().unwrap_or(""),
                            pane["kind"].as_str().unwrap_or(""),
                            eff_str
                        ));
                        json!({
                            "paneId": pane["paneId"], "kind": pane["kind"],
                            "mode": payload.get("mode").cloned().unwrap_or(Value::Null),
                            "shell": payload.get("shell").cloned().unwrap_or(Value::Null),
                            "cwd": payload.get("initialCwd").cloned().unwrap_or(Value::Null),
                            "payload": payload.clone(),
                            "sessionRef": eff_ref.unwrap_or(Value::Null),
                            "ledgerState": ledger_state,
                            "live": live,
                        })
                    })
                    .collect();
                json!({"tabKey": rec["tabKey"], "tabName": rec["tabName"], "panes": panes})
            })
            .collect();
        tabs_per_union.push(tabs);
    }

    let primary_idx = unions.iter().position(|d| {
        d.union_doc["records"]
            .as_array()
            .map(|r| !r.is_empty())
            .unwrap_or(false)
    });

    let device = primary_idx.map(|i| {
        let doc = &unions[i].union_doc;
        json!({"deviceId": doc["deviceId"], "deviceLabel": doc["deviceLabel"],
               "capturedAt": doc["capturedAt"], "tabs": tabs_per_union[i].clone()})
    });

    let other_devices: Vec<Value> = unions
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != primary_idx)
        .filter(|(_, d)| {
            d.union_doc["records"]
                .as_array()
                .map(|r| !r.is_empty())
                .unwrap_or(false)
        })
        .map(|(_, d)| {
            let pane_count: u64 = d.union_doc["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["panes"].as_array().map(|p| p.len() as u64).unwrap_or(0))
                .sum();
            json!({"deviceId": d.union_doc["deviceId"], "deviceLabel": d.union_doc["deviceLabel"],
                   "capturedAt": d.union_doc["capturedAt"], "paneCount": pane_count})
        })
        .collect();

    let ledger_only: Vec<Value> = bindings
        .iter()
        .filter(|r| row_is_bound(r))
        // vs effective refs across ALL unions (A4), not just the primary device
        .filter(|r| !referenced.contains(&row_owner(r)))
        // live rows are excluded: sessions still running are never offered for resume (D7)
        .filter(|r| !live_session_keys.contains(&row_owner(r)))
        .map(|r| {
            let mut entry = json!({"provider": row_provider(r), "sessionId": row_session_id(r),
                                   "mode": row_mode(r), "cwd": row_cwd(r)});
            if let Some(scope) = &row_owner(r).provider_scope {
                entry["providerScope"] = Value::String(scope.clone());
            }
            entry
        })
        .collect();

    // contentId: sha256 over the sorted TIMESTAMP-FREE substance (A5/A6, D3)
    substance.extend(ledger_only.iter().map(|e| {
        owner_substance(&owner_key(
            e["provider"].as_str().unwrap_or(""),
            e["sessionId"].as_str().unwrap_or(""),
            e.get("providerScope").and_then(Value::as_str),
        ))
    }));
    substance.sort();
    let content_id = digest16(&substance);

    let recoverable = device.is_some() || !ledger_only.is_empty();
    json!({"recoverable": recoverable, "contentId": content_id,
           "device": device.unwrap_or(Value::Null),
           "otherDevices": other_devices, "ledgerOnly": ledger_only})
}

// Thin accessors over the real `BindingRow` fields/enums
// (`crates/freshell-ws/src/pane_ledger.rs:93`) — single field accesses, no logic.

fn row_provider(r: &BindingRow) -> String {
    r.provider.clone()
}

fn row_session_id(r: &BindingRow) -> String {
    r.session_id.clone()
}

fn row_owner(r: &BindingRow) -> RecoveryOwnerKey {
    owner_key(&r.provider, &r.session_id, r.provider_scope.as_deref())
}

fn owner_session_ref(owner: &RecoveryOwnerKey) -> Value {
    json!({"provider": owner.provider, "sessionId": owner.session_id})
}

fn owner_substance(owner: &RecoveryOwnerKey) -> String {
    let scope = owner
        .provider_scope
        .as_deref()
        .map(|scope| format!("1{}:{scope}", scope.len()))
        .unwrap_or_else(|| "0".to_string());
    format!(
        "{}:{}{}:{}{scope}",
        owner.provider.len(),
        owner.provider,
        owner.session_id.len(),
        owner.session_id,
    )
}

fn row_is_bound(r: &BindingRow) -> bool {
    r.state == RowState::Bound
}

fn row_reason_is_closed(r: &BindingRow) -> bool {
    r.retired_reason == Some(RetiredReason::Closed)
}

fn row_successor(r: &BindingRow) -> Option<RecoveryOwnerKey> {
    r.superseded_by.clone()
}

fn row_mode(r: &BindingRow) -> String {
    r.mode.clone()
}

fn row_cwd(r: &BindingRow) -> Option<String> {
    r.cwd.clone()
}

/// The `contentId` digest: sha256 over the parts joined with `\u{1}`,
/// hex-encoded, truncated to 16 chars (the tabs-persist digest convention,
/// `crates/freshell-ws/src/tabs_persist.rs:82-87`, at half width).
fn digest16(parts: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(parts.join("\u{1}").as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

// ── Task 2: the `GET /api/recovery/inventory` route ───────────────────────────

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::boot::{is_authed, unauthorized};

/// State for the recovery-inventory read surface. `registry` is the SAME
/// shared `TerminalRegistry` the WS server state receives (`main.rs:249`) —
/// read-only here (the D7 liveness join).
#[derive(Clone)]
pub struct RecoveryInventoryState {
    pub auth_token: String,
    pub snapshots_dir: Option<std::path::PathBuf>,
    pub ledger: std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>,
    pub registry: freshell_terminal::TerminalRegistry,
    /// The SAME shared identity registry the WS state receives — read-only
    /// here (the wave-B widened D7 liveness join: locator-adopted terminals
    /// hold their session identity here, not on the registry row).
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryQuery {
    client_instance_id: Option<String>,
    boot_ago_ms: Option<u64>,
}

pub fn router(state: RecoveryInventoryState) -> Router {
    Router::new()
        .route("/api/recovery/inventory", get(inventory_handler))
        .with_state(state)
}

/// Epoch millis — the same convention the tabs-persist/tabs stores use
/// (`tabs.rs:549`), as `u64` because the A15/A16 cutoffs are unsigned.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Snapshot store present but unreadable, or the blocking read task failed:
/// fail LOUD (500) — never a silent empty inventory (the
/// `tabs_snapshots.rs:61` precedent).
fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "recovery inventory unavailable" })),
    )
        .into_response()
}

async fn inventory_handler(
    State(state): State<RecoveryInventoryState>,
    headers: HeaderMap,
    Query(q): Query<InventoryQuery>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let exclude = q.client_instance_id.unwrap_or_default();
    // D2/A16: anchor the concurrent-client filter to the requester's boot.
    // Missing param => 0 => boot_cutoff = now, so nothing that predates the
    // request is dropped.
    let boot_cutoff = now_ms().saturating_sub(q.boot_ago_ms.unwrap_or(0));
    let unions = match state.snapshots_dir.clone() {
        None => vec![],
        Some(dir) => {
            let job = tokio::task::spawn_blocking(move || {
                read_foreign_unions(&dir, &exclude, boot_cutoff)
            });
            match job.await {
                Ok(Ok(u)) => u,
                Ok(Err(e)) => {
                    tracing::error!(target: "freshell_server::recovery_inventory",
                        error = %e, "recovery inventory snapshot read failed");
                    return internal_error();
                }
                Err(e) => {
                    tracing::error!(target: "freshell_server::recovery_inventory",
                        error = %e, "recovery inventory join failed");
                    return internal_error();
                }
            }
        }
    };
    let bindings = state.ledger.list_bindings();
    let live = live_session_keys(&state.registry, &state.identity, &bindings);
    Json(build_inventory(unions, bindings, live)).into_response()
}

/// Read-only liveness join (D7), keyed by the same complete recovery owner as
/// the ledger. Global providers can fall back to `(mode, sessionId)`;
/// Amplifier needs a ledger row carrying its provider-normalized scope.
///
/// WAVE-B widening (B3 lane review): the D7 create-rung server guard checks
/// BOTH stores — the identity-registry owner (probed Running) AND the
/// registry-row scan. A locator-adopted terminal (codex/opencode/amplifier)
/// holds its session in the identity registry while the row's
/// `resume_session_id` stays unset, so the registry-row scan alone under-counts
/// live sessions: the inventory would offer them for resume and the accept
/// would die on the server guard. Join both stores here so the offer and the
/// guard agree.
fn live_session_keys(
    registry: &freshell_terminal::TerminalRegistry,
    identity: &freshell_ws::identity::TerminalIdentityRegistry,
    bindings: &[BindingRow],
) -> HashSet<RecoveryOwnerKey> {
    let running_rows = registry
        .directory()
        .into_iter()
        .filter(|row| row.status == freshell_protocol::TerminalRunStatus::Running)
        .collect::<Vec<_>>();
    let running_terminal_ids = running_rows
        .iter()
        .map(|row| row.terminal_id.as_str())
        .collect::<HashSet<_>>();
    let mut keys = bindings
        .iter()
        .filter(|row| row_is_bound(row))
        .filter(|row| {
            row.live_terminal_id
                .as_deref()
                .is_some_and(|terminal_id| running_terminal_ids.contains(terminal_id))
        })
        .map(row_owner)
        .collect::<HashSet<_>>();

    for row in running_rows {
        let Some(session_id) = row
            .resume_session_id
            .filter(|session_id| !session_id.is_empty())
        else {
            continue;
        };
        if row.mode != "amplifier" {
            keys.insert(owner_key(&row.mode, &session_id, None));
        }
    }

    // Identity-registry side of the join: live (non-retired) entries whose
    // owning terminal probes Running — mirrors the guard's
    // `identity_owner_live` arm.
    for entry in identity.list() {
        let (Some(provider), Some(session_id)) = (entry.provider, entry.session_id) else {
            continue;
        };
        if session_id.is_empty() {
            continue;
        }
        let owner_running = registry
            .probe(&entry.terminal_id)
            .is_some_and(|r| r.status == freshell_protocol::TerminalRunStatus::Running);
        if owner_running && provider != "amplifier" {
            keys.insert(owner_key(&provider, &session_id, None));
        }
    }
    keys
}

fn read_foreign_unions(
    dir: &std::path::Path,
    exclude_client: &str,
    boot_cutoff: u64,
) -> std::io::Result<Vec<DeviceUnion>> {
    use freshell_ws::tabs_persist::{
        list_snapshot_devices, read_device_overview, read_generations_union_by_ids, ComponentsUnion,
    };
    let mut out = vec![];
    if !dir.is_dir() {
        return Ok(out);
    }
    for device in list_snapshot_devices(dir)? {
        let Some((_, generations)) = read_device_overview(dir, &device)? else {
            continue;
        };
        // Task 1 helper: drops the requester's own generations, concurrent
        // post-boot clients (A16), AND stale clients (A15).
        let foreign =
            select_foreign_recent_generation_ids(&generations, exclude_client, boot_cutoff);
        if foreign.is_empty() {
            continue;
        }
        match read_generations_union_by_ids(dir, &device, &foreign)? {
            ComponentsUnion::Found(union_doc) => out.push(DeviceUnion {
                device_id: device,
                union_doc,
            }),
            // A component pruned between the overview scan and the union read:
            // zero surviving generations for this device — skip it.
            ComponentsUnion::Missing(_) => continue,
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "recovery_inventory_tests.rs"]
mod tests;

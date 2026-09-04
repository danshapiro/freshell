//! B3/P1.9 Task 1 — the PURE recovery-inventory builder: joins tabs-snapshot
//! device unions with pane-ledger binding rows into the `/api/recovery`
//! inventory shape. No I/O here — Task 2 (the HTTP route) feeds it from the
//! snapshot store, the ledger, and the terminal registry, and consumes
//! `select_foreign_recent_generation_ids` when composing each device's union.

use freshell_ws::pane_ledger::{BindingRow, PaneCloseRecord, PaneDetachClose, RetiredReason, RowState};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct DeviceUnion {
    pub device_id: String,
    pub union_doc: Value,
}

/// Delta-r6-r2 (focused-episode-6 round 1, Finding 1): the verdict join's
/// CLOSE evidence — both shapes a close takes when no binding row exists to
/// carry the verdict:
///
/// * `pane_closes`: the terminal lane's pane-keyed close records (a kill
///   that beat identity resolution). A snapshot pane is COVERED by a record
///   through its payload's `createRequestId` or `liveTerminal.terminalId`
///   (the keys the close knew), and a covered pane verdicts `closed` — the
///   pane ITSELF was deliberately closed; whatever later happened to its
///   session identities on other panes is irrelevant to it.
/// * `standing_kill_tombstones`: the fresh-agent lanes' identity-keyed
///   fences (fresh-claude/codex/opencode kills write no pane record — the
///   placeholder-keyed tombstone their `retire_closed` folds IS their
///   durable close). A pane whose snapshot claim resolves to NO row
///   anywhere and whose claimed key carries a standing fence was closed
///   before its identity ever landed as a row: verdict `closed`. A genuine
///   reopen CONSUMES its fences durably through the claim commit
///   (focused-episode-6 round 4, F1: the journal records' entries leave
///   with it), so a STANDING fence means the identity was never genuinely
///   reclaimed — and even beside residue a live/current association (a key
///   in the live-session set, or a claim resolving to a Bound row) always
///   wins over a fence.
pub struct CloseEvidence {
    pub standing_kill_tombstones: HashSet<(String, String)>,
    pub pane_closes: Vec<PaneCloseRecord>,
    /// Delta-round-7 (Finding F2) — the NON-RETIRING detach closes (the
    /// terminal pane X-close family, keyed by the pane's createRequestId):
    /// "this PANE was closed" evidence that never fences or retires the
    /// session. Coverage rules, by construction ([`PaneDetachClose`]):
    ///
    /// * snapshot PANES: the createRequestId arm ONLY — their terminal stays
    ///   RUNNING, so a terminalId arm would cover a later pane reattached to
    ///   it (the P2 false positive the kill lane can never produce: a killed
    ///   terminal is dead).
    /// * ledger ROWS: the createRequestId arm (the row the pane's create
    ///   stamped) OR the terminalId arm (the row whose live terminal IS the
    ///   closed pane's — relevant when a conn-less identity resolution wrote
    ///   the row without the advisory createRequestId). A covered row is
    ///   NEVER offered, whether live or dead; it stays Bound for sidebar
    ///   reattach.
    pub pane_detach_closes: Vec<PaneDetachClose>,
}

/// Focused-episode-6 round 5 (Finding F2): the D7 liveness evidence the
/// verdict join consumes, in two halves:
///
/// * `session_keys` (PRIMARY): `(provider = mode, sessionId)` for every
///   currently-Running terminal row plus every identity-registry live entry
///   whose owning terminal probes Running (the wave-B widened join). A pane
///   whose effective durable ref lands here verdicts `live` — as it always
///   has.
/// * `terminal_ids` (FALLBACK for unidentified shells): the Running
///   registry rows' terminal ids. A plain-shell pane has NO session identity
///   (no rows, no claims — the effective ref is null and the first half can
///   never fire for it), so pre-F2 it always read `live: false` and the
///   client dropped the saved terminal identity and spawned a DUPLICATE
///   beside the still-running PTY. Such a pane now claims liveness via its
///   snapshot's `payload.liveTerminal.terminalId` membership here. Only
///   `terminal` panes consult this half (the liveTerminal handle is a
///   terminal-pane shape), and a close-COVERED pane never reads live (the
///   close envelope lands before the kill's teardown, so a mid-teardown
///   terminal can still be Running beside a durably closed pane).
pub struct LiveEvidence {
    pub session_keys: HashSet<(String, String)>,
    pub terminal_ids: HashSet<String>,
}

#[cfg(test)]
impl CloseEvidence {
    /// The empty verdict join input (no closes recorded anywhere) — the test
    /// fixtures' default.
    pub fn none() -> Self {
        Self {
            standing_kill_tombstones: HashSet::new(),
            pane_closes: Vec::new(),
            pane_detach_closes: Vec::new(),
        }
    }
}

/// One device dir's A15/A16 survivor selection: the retained generation ids
/// to compose the union from, PLUS each surviving client's revision-first
/// WINNER generation's capturedAt (the D8 parent-relative judgment input) —
/// within the winner's final revision, the capturedAt of the FIRST matching
/// entry on the route's (revision, capturedAt)-descending feed: that
/// revision's freshest stamp, identical to the union composition's
/// `newest_per_client` winner key there (focused-ep4-r5 Finding 3), so
/// judgment and offered union can never disagree about the parent's clock.
pub struct ForeignSelection {
    pub selected_ids: Vec<String>,
    /// (client_instance_id, winner capturedAt) per surviving client, sorted
    /// by client id for deterministic output.
    pub winner_captured_at_by_client: Vec<(String, u64)>,
}

/// D8 parent evidence, per device: `[(client_instance_id, winner_captured_at)]`
/// for each client that survived that device dir's A15/A16 selection.
pub type DeviceEvidence = Vec<(String, Vec<(String, u64)>)>;

const STALE_CLIENT_MS: u64 = 15 * 60 * 1000; // heartbeat cadence is 5 min (tabRegistrySync.ts:21, 475-477)

/// D8 (restore-open-sessions-only): a Bound, unreferenced, not-live ledger
/// row is offered ONLY while its own stamped parent client's evidence cannot
/// yet have observed its absence — judged per row against that parent, never
/// against a cohort aggregate (an aggregate MIN inherits any older surviving
/// client's clock; a MAX drops a lost window's genuine kill-window rows
/// whenever a second window keeps pushing). Unattributed rows (headless
/// REST/MCP lineage, pre-upgrade rows) are never offered. The grace is one
/// 5s diff-push cadence + 2s slack, both stamps server-clock. A kill-window
/// row's bind postdates its parent's last retained push, so it keeps
/// unconditionally (the SIGKILL-within-5s contract). The parent's "newest" is
/// the capturedAt of its REVISION-FIRST winner generation — the same
/// `generation_rank` ordering the union composition applies — so the judgment
/// and the offered unions can never disagree about which generation is newest
/// (a raw capturedAt-max across revisions would, after a backward
/// server-clock step). Focused-ep4-r5 Finding 3 (equal-revision ties honor
/// the route's ordering contract): WITHIN the final revision the key is the
/// capturedAt of the FIRST matching entry on the route's (revision,
/// capturedAt)-descending feed — that revision's capturedAt-max, identical
/// to the union's `newest_per_client` winner key there, so judgment and
/// offered union cannot disagree; the superseded r4 rule kept the LAST entry
/// (the run's lowest stamp on that feed). A greater revision still wins
/// outright, so across a backward wall-clock step the client's first REAL
/// post-step push (revision-bumping) re-keys the clock immediately.
/// Residual (a reduction, not perfection): during such a jump a retained
/// PRE-step entry at the SAME final revision holds the key HIGH (union-
/// consistently) until that first real post-step push lands — a row judged
/// in the window can be dropped up to the skew magnitude EARLIER than the
/// client's true freshest assertion would allow. The r4 keep-side extension
/// is unchanged where it still lives: once the post-step revision lands, a
/// row within grace of the post-step stamp keeps until post-step pushes
/// outrun row_time + grace. And the ROW-side monotonic compare has the same
/// bounded wall-clock residual (focused-ep4-r5 Finding 2a, documented in
/// `pane_ledger.rs`): after a backward step a genuinely-later browser
/// assertion can compare as older and be rejected for up to the skew
/// magnitude — no sequence counter is built for either side.
///
/// The ROW's side of the comparison is its last-attribution time, never its
/// last write and never its row-creation metadata: delta-r4 Finding 1 —
/// `updated_at` advances on EVERY upsert, including conn-less `Inherit`
/// maintenance (the auto-resume respawn sweep, locator/resolution re-binds)
/// that re-asserts no browser provenance, so after the parent's evidence
/// froze such a refresh parked the row past the frozen newest generation and
/// re-offered a long-closed detached pane forever. `last_attributed_at`
/// advances only on a full-triple connection-scoped write, at the
/// ASSERTION's time — carried on the provenance value itself (focused-ep4-r2
/// Findings 1+2: captured ONCE at WS message receipt, so slow
/// create/spawn/fork work can never manufacture a later attribution;
/// focused-ep4-r3 Findings 1+2: application is also MONOTONE in that time —
/// an older delayed write never drags it back, and a tab-less re-assert
/// never refreshes it; a fork-chain `Inherit` child inherits the parent's
/// time), and, for a marker-stamped resolution, the consumed marker's
/// `asserted_at` field (focused-ep4; since the focused-ep4-r3 Finding 3
/// split the field is dedicated — the `spawned_at` fallback covers
/// intermediate-build markers). A marker-derived row's `created_at` IS the
/// resolution time and a fork child's is the fork time, so a `created_at`
/// floor would re-launder either — see pane_ledger.rs. Focused-ep4-r4
/// Finding 1 removes the last remnant of that floor: stamps and the field
/// were introduced TOGETHER in this branch, so a stamped-but-fieldless row
/// can only be an intermediate-branch-build dev artifact (with a possibly
/// invented-late `created_at`) — the judgment requires a PRESENT
/// `last_attributed_at` and excludes such rows exactly like unattributed
/// ones.
///
/// Placement clause (delta-r2 Finding 3, narrowed by focused-ep2-r1 Finding
/// 1): a kept row is offered ONLY when its stamped `tabKey` names an OPEN,
/// paned tab in the offer's union (the restored-tab set the client joins it
/// into): an unmatched/missing tabKey means the pane's whole TAB was created
/// and lost inside the sub-cadence push window, a CLOSED-but-retained record
/// means the tab was not open in the restored evidence, and a zero-pane
/// record has no client-side join target — in every case the row is
/// unplaceable and deliberately excluded (the pre-fix client-side
/// trailing-tab fallback restored such rows into an unrelated tab instead).
const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 7_000;

/// A15 staleness + A16 concurrent-client rules (D2): drop the requester's own
/// generations; drop clients ALL of whose retained generations postdate
/// `boot_cutoff_ms` (a client born after this browser session booted is a
/// concurrently-opened fresh window, never lost data — a lost client's pushes
/// all predate the fresh boot, so retention depth cannot misclassify it); then
/// drop clients whose newest generation is >15 min older than the device max
/// over the REMAINING clients (junk must never stale-out real recovery data).
/// Returns the surviving clients' generation ids PLUS each survivor's
/// revision-first-winner capturedAt for the D8 parent-relative judgment.
pub fn select_foreign_recent_generation_ids(
    generations: &[Value],
    exclude_client: &str,
    boot_cutoff_ms: u64,
) -> ForeignSelection {
    let foreign: Vec<&Value> = generations
        .iter()
        .filter(|g| g["clientInstanceId"].as_str() != Some(exclude_client))
        .collect();
    let mut oldest_by_client: HashMap<&str, u64> = HashMap::new();
    let mut newest_by_client: HashMap<&str, u64> = HashMap::new();
    // Revision-first winner per client — the SAME `generation_rank` ordering
    // the union composition applies, so the D8 evidence can never disagree
    // with the offered union about which generation is a client's newest (a
    // raw capturedAt-max across REVISIONS would, after a backward
    // server-clock step). Focused-ep4-r5 Finding 3 (equal-revision selection
    // honors the route's ordering contract): the production feed —
    // `read_device_overview`'s meta — supplies each client's generations
    // (revision, capturedAt)-DESCENDING (its `all_generations_parsed`
    // per-client queue sorts `generation_rank` descending), so the FIRST
    // matching entry of the final revision IS that revision's freshest
    // stamp: its capturedAt-max — identical to the union composition's
    // `newest_per_client` winner key ((revision, capturedAt)-max per client).
    // The superseded r4 rule (replace on equal revision, keeping the LAST
    // array entry) read the run's LOWEST stamp off the descending feed, so
    // the judgment and the offered union could disagree by construction
    // whenever a re-delivered push left two entries at one revision. Greater
    // revision still replaces outright, so the first REAL post-clock-step
    // push (every real push bumps `snapshotRevision`) re-keys the clock
    // immediately; array order only ever matters inside one revision. The
    // skew-window residual this leaves is recorded on the
    // [`UNSNAPSHOTTED_BINDING_GRACE_MS`] block.
    let mut winner_rank_by_client: HashMap<&str, (i64, i64)> = HashMap::new();
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
        let rank = freshell_ws::tabs_persist::generation_rank(g);
        let w = winner_rank_by_client.entry(c).or_insert(rank);
        // Greater revision replaces the winner outright; the SAME revision
        // never overwrites — the FIRST matching entry wins the tie, which on
        // the route's (revision, capturedAt)-descending feed is the run's
        // freshest stamp (== the union's winner key).
        if rank.0 > w.0 {
            *w = rank;
        }
    }
    let pre_boot = |c: &str| oldest_by_client.get(c).copied().unwrap_or(u64::MAX) < boot_cutoff_ms;
    let device_max = newest_by_client
        .iter()
        .filter(|(c, _)| pre_boot(c))
        .map(|(_, t)| *t)
        .max()
        .unwrap_or(0);
    let survives = |c: &str| {
        pre_boot(c) && newest_by_client.get(c).copied().unwrap_or(0) + STALE_CLIENT_MS >= device_max
    };
    let selected_ids: Vec<String> = foreign
        .iter()
        .filter(|g| survives(g["clientInstanceId"].as_str().unwrap_or("")))
        .filter_map(|g| g["generationId"].as_str().map(String::from))
        .collect();
    let mut winner_captured_at_by_client: Vec<(String, u64)> = winner_rank_by_client
        .iter()
        .filter(|(c, _)| survives(c))
        .map(|(c, (_, captured))| (c.to_string(), (*captured).max(0) as u64))
        .collect();
    winner_captured_at_by_client.sort();
    ForeignSelection {
        selected_ids,
        winner_captured_at_by_client,
    }
}

fn ref_key(provider: &str, session_id: &str) -> String {
    format!("{provider}\u{1}{session_id}")
}

enum Verdict {
    Bound(String, String),
    Closed,
    GcExpired,
    Unknown,
}

/// Resolve a snapshot's sessionRef claim to its EFFECTIVE identity per D4 by
/// walking the ledger's superseded chain (bounded — a cycle degrades to
/// `GcExpired`, never loops).
fn resolve(provider: &str, session_id: &str, by_key: &HashMap<String, &BindingRow>) -> Verdict {
    let (mut p, mut s) = (provider.to_string(), session_id.to_string());
    for _ in 0..10 {
        match by_key.get(&ref_key(&p, &s)) {
            None => {
                return if (p.as_str(), s.as_str()) == (provider, session_id) {
                    Verdict::Unknown
                } else {
                    Verdict::GcExpired
                }
            }
            Some(row) if row_is_bound(row) => {
                return Verdict::Bound(row_provider(row), row_session_id(row))
            }
            Some(row) => match row_successor(row) {
                Some((np, ns)) => {
                    p = np;
                    s = ns;
                }
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

/// Bind-by-correlation candidate rows for a snapshot pane WITHOUT a
/// sessionRef claim (focused-ep3): rows from whichever advisory index set the
/// caller passes (Bound rows for the restore-with-resume bind; RETIRED rows
/// for the focused-ep3-r3 ended-identity verdict) whose advisory
/// `create_request_id` equals the pane payload's `createRequestId` OR whose
/// advisory `live_terminal_id` equals the payload's
/// `liveTerminal.terminalId` (deduped by row identity — one row matching
/// BOTH ids is still one candidate) — PLUS coherence: terminal panes only
/// (fresh-agent panes snapshotted pre-association carry a PLACEHOLDER
/// sessionRef, not an absent one, and never reach this arm; the kind gate is
/// belt-and-suspenders), fresh-agent ROWS never (`pane_kind` is the row-side
/// discriminator, `pane_ledger.rs:121`), and the row's provider must equal
/// the pane's mode (an id correlation without provider/mode coherence is a
/// collision, not a match). Advisory ids that are absent, wrong-typed, or
/// empty simply name no rows.
fn correlation_candidates<'a>(
    pane: &Value,
    by_create_request_id: &HashMap<&'a str, Vec<&'a BindingRow>>,
    by_live_terminal_id: &HashMap<&'a str, Vec<&'a BindingRow>>,
) -> Vec<&'a BindingRow> {
    if pane["kind"].as_str() != Some("terminal") {
        return Vec::new();
    }
    let payload = &pane["payload"];
    let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("");
    let mut candidates: Vec<&BindingRow> = Vec::new();
    for rows in [
        payload
            .get("createRequestId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .and_then(|id| by_create_request_id.get(id)),
        payload
            .get("liveTerminal")
            .and_then(|live| live.get("terminalId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .and_then(|id| by_live_terminal_id.get(id)),
    ]
    .into_iter()
    .flatten()
    {
        for &row in rows {
            if row.pane_kind.is_none()
                && row.provider == mode
                && !candidates.iter().any(|existing| std::ptr::eq(*existing, row))
            {
                candidates.push(row);
            }
        }
    }
    candidates
}

/// Focused-ep5-r2 Finding 1 (retire-on-kill round 3; round-4 amended for
/// focused-ep5-r3 Finding 4) — the kill-tombstone dominance rule AT THE
/// OFFER BOUNDARY: `retire_closed` is two durable writes (tombstone, then
/// row retire) and a crash or failed second write can split them, leaving a
/// still-Bound row next to a surviving kill tombstone. The tombstone is the
/// author of truth: such a row is rewritten to Retired(Closed) BEFORE the
/// pure builder sees it, so it never reaches `ledgerOnly`, and a snapshot
/// pane that claims the identity gets the `closed` verdict (the retired
/// tier) instead of a spurious `bound`. One rule with the sweep: the
/// boot/periodic GC re-applies the same retirement durably
/// (`pane_ledger_scan.rs`); this read-side enforcement covers the window
/// BEFORE the sweep runs (including the no-restart process-lived-on case).
/// The caller's key set is the ledger's DOMINANT compute — TTL-free while
/// the row reads Bound (Finding 4: a post-outage dominance must not age
/// out), and excluding claim residue (a revived row that outranks its stale
/// tombstone IS the genuine live session). Rows that are already Retired
/// pass through untouched.
fn apply_kill_tombstone_dominance(
    bindings: Vec<BindingRow>,
    dominant: &HashSet<(String, String)>,
) -> Vec<BindingRow> {
    bindings
        .into_iter()
        .map(|mut row| {
            if row.state == RowState::Bound
                && dominant.contains(&(row.provider.clone(), row.session_id.clone()))
            {
                row.state = RowState::Retired;
                row.retired_reason = Some(RetiredReason::Closed);
            }
            row
        })
        .collect()
}

pub fn build_inventory(
    device_unions: Vec<DeviceUnion>,
    bindings: Vec<BindingRow>,
    live: LiveEvidence,
    evidence: &DeviceEvidence,
    closes: &CloseEvidence,
) -> Value {
    let by_key: HashMap<String, &BindingRow> = bindings
        .iter()
        .map(|r| (ref_key(&row_provider(r), &row_session_id(r)), r))
        .collect();
    let is_live = |p: &str, s: &str| live.session_keys.contains(&(p.to_string(), s.to_string()));
    // Delta-r6-r2 (Finding 1): the close-evidence joins. A pane is COVERED by
    // a pane close record through either advisory key its snapshot payload
    // carries (`createRequestId` / `liveTerminal.terminalId` — the same keys
    // the close knew at kill time... and the correlation indexes use).
    let mut close_by_terminal: HashMap<&str, &PaneCloseRecord> = HashMap::new();
    let mut close_by_crid: HashMap<&str, &PaneCloseRecord> = HashMap::new();
    for record in &closes.pane_closes {
        close_by_terminal
            .entry(record.terminal_id.as_str())
            .or_insert(record);
        if let Some(crid) = record.create_request_id.as_deref() {
            close_by_crid.entry(crid).or_insert(record);
        }
    }
    // Delta-round-7 (Finding F2) — the DETACH close joins. The createRequestId
    // arm MERGES with the kill records' (`covered_crids`): a close record of
    // EITHER family keys "this exact pane was closed". The terminalId arm is
    // deliberately SPLIT:
    //
    // * snapshot PANES consult the KILL set's terminal arm alone — a detached
    //   terminal stays RUNNING and a later pane legimately reattaches to it
    //   (fresh createRequestId): joining panes on a detach record's terminal
    //   id would cover that reattached pane (the P2 false positive the kill
    //   lane can never produce — killed terminals are dead).
    // * ledger ROWS additionally consult the DETACH terminal arm: a row whose
    //   live terminal IS the closed pane's terminal is that pane's row
    //   (terminal ids are never re-minted) — the arm that covers rows written
    //   without the advisory createRequestId (the conn-less resolution lane).
    let detach_terminal_ids: HashSet<&str> = closes
        .pane_detach_closes
        .iter()
        .filter_map(|d| d.terminal_id.as_deref())
        .filter(|id| !id.is_empty())
        .collect();
    let covered_crids: HashSet<&str> = close_by_crid
        .keys()
        .copied()
        .chain(
            closes
                .pane_detach_closes
                .iter()
                .map(|d| d.create_request_id.as_str())
                .filter(|id| !id.is_empty()),
        )
        .collect();
    let pane_covered_by_close = |pane: &Value| -> bool {
        let payload = &pane["payload"];
        let crid_hit = payload
            .get("createRequestId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .is_some_and(|id| covered_crids.contains(id));
        if crid_hit {
            return true;
        }
        payload
            .get("liveTerminal")
            .and_then(|live| live.get("terminalId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .is_some_and(|id| close_by_terminal.contains_key(id))
    };
    // Delta-round-7 (Finding F2): the ROW-side close coverage. A close record
    // (either family) that names the row's creation key proves the pane the
    // row belongs to was closed, so the row is never offered — while the row
    // itself stays Bound (the detach record is deliberately non-retiring) for
    // sidebar reattach. A genuine re-open lapses the coverage by
    // construction: resume creates re-stamp the row's createRequestId/
    // liveTerminalId wholesale (and a re-opened session's pane re-references
    // the row through the snapshot unions), so the offer returns exactly
    // when the session is genuinely open again.
    //
    // Delta-r7-round-2 (Finding F3): the DETACH terminal arm keys ONLY rows
    // with NO advisory createRequestId — the arm's own stated purpose (rows
    // the conn-less resolution lane wrote without it). A row whose
    // createRequestId is PRESENT and NOT covered belongs to a pane the
    // ledger has since re-keyed (the attach restamp: a new pane reattached
    // the SAME still-running terminal) — the old pane's close record covers
    // the OLD pane alone, and the terminal arm must never reach across to
    // the re-opened one (terminals are never re-minted, but they ARE
    // re-attached).
    // Delta-r7-round-3 (focused-episode-7 round-2, Finding F1): the close
    // coverage ALSO consults the row's ORIGIN lineage key. A pane closed
    // before `terminal.created` journals a CRID-only pane.closed record (the
    // client never learned the terminal id); the conn-less resolution lane
    // later writes the row with `create_request_id: None` — without the
    // origin consult neither arm matched and the deliberately closed session
    // was offered (record CRID == row CRID == row ORIGIN CRID: any equals).
    // The terminal-id fallback arm is now gated on the row being FULLY
    // lineage-less: a row carrying either pane key answers its keys alone —
    // that arm exists for the legacy residual (conn-less rows written by
    // builds that never stamped lineage), and an origin-keyed row must never
    // be covered by ANOTHER pane's terminal-keyed close record (two panes
    // sharing one terminal: closing only the sibling must not suppress this
    // pane's row).
    let row_close_covered = |r: &BindingRow| -> bool {
        let crid_hit = r
            .create_request_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .is_some_and(|id| covered_crids.contains(id))
            || r
                .origin_create_request_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .is_some_and(|id| covered_crids.contains(id));
        if crid_hit {
            return true;
        }
        let lineage_keyed = r
            .create_request_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
            || r
                .origin_create_request_id
                .as_deref()
                .is_some_and(|id| !id.is_empty());
        if lineage_keyed {
            return false; // a lineage-keyed row answers its keys alone (the reattach lapse)
        }
        r.live_terminal_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .is_some_and(|id| detach_terminal_ids.contains(id))
    };
    // Bind-by-correlation advisory secondary indices (focused-ep3), Bound
    // rows only. A codex/opencode CLI pane snapshotted INSIDE its
    // identity-association window persists with paneId/createRequestId/
    // liveTerminal.terminalId but NO sessionRef (the terminal payload
    // producer, tab-registry-snapshot.ts:17-31); the attributed Bound row
    // written at identity resolution would otherwise stay "unreferenced"
    // and the client plan would rebuild BOTH the ref-less snapshot leaf
    // (fresh, no resume) AND the row's resume leaf — two panes for one
    // originally-open pane. BOTH advisory ids are indexed:
    // `live_terminal_id` rides every terminal-row write
    // (`record_binding_locked`), `create_request_id` only the lanes that
    // carry it (the conn-less `ledger_resolve_identity` lane passes `None`),
    // so neither alone covers every association window.
    let mut by_create_request_id: HashMap<&str, Vec<&BindingRow>> = HashMap::new();
    let mut by_live_terminal_id: HashMap<&str, Vec<&BindingRow>> = HashMap::new();
    for row in bindings.iter().filter(|r| row_is_bound(r)) {
        if let Some(create_request_id) = row.create_request_id.as_deref() {
            by_create_request_id
                .entry(create_request_id)
                .or_default()
                .push(row);
        }
        if let Some(live_terminal_id) = row.live_terminal_id.as_deref() {
            by_live_terminal_id
                .entry(live_terminal_id)
                .or_default()
                .push(row);
        }
    }
    // Focused-ep3-r3: RETIRED rows keep their advisory ids at retirement
    // (`retire_closed`/`retire_missing`/supersession touch only state,
    // retired_reason, updated_at, superseded_by). A ref-less pane whose
    // identity was retired BETWEEN the snapshot and the server death would
    // otherwise correlate to nothing and report ledgerState "unknown" even
    // though the ledger authoritatively records that the identity ENDED (the
    // finding: an explicit terminal.kill -> Retired(Closed)). The retired
    // indices feed ONLY the ended-identity verdict arm below (closed-arm
    // parity with resolve()); retired rows never reach the ledgerOnly
    // pipeline (the row_is_bound pre-filter, unchanged) — the verdict can
    // never become an offer. All four retired reasons are indexed; the
    // per-reason disposition is resolve()'s own terminus semantics, applied
    // at verdict time (see the ref-less arm's retired branch).
    let mut retired_by_create_request_id: HashMap<&str, Vec<&BindingRow>> = HashMap::new();
    let mut retired_by_live_terminal_id: HashMap<&str, Vec<&BindingRow>> = HashMap::new();
    for row in bindings.iter().filter(|r| row_is_retired(r)) {
        if let Some(create_request_id) = row.create_request_id.as_deref() {
            retired_by_create_request_id
                .entry(create_request_id)
                .or_default()
                .push(row);
        }
        if let Some(live_terminal_id) = row.live_terminal_id.as_deref() {
            retired_by_live_terminal_id
                .entry(live_terminal_id)
                .or_default()
                .push(row);
        }
    }

    // sort newest-first; primary device = greatest capturedAt with >=1 record
    let mut unions = device_unions;
    unions.sort_by_key(|d| std::cmp::Reverse(d.union_doc["capturedAt"].as_u64().unwrap_or(0)));

    // Pass 1 - resolve EVERY pane in EVERY union (not just the primary): effective refs
    // feed the cross-device ledgerOnly rule (A4) and the contentId substance (A5/A6);
    // the primary union's tabs feed `device`. Ref-less panes attempt
    // bind-by-correlation (focused-ep3), then the retired-tier ended-identity
    // verdict (focused-ep3-r3), before falling back to "unknown".
    //
    // Correlation ambiguity census over that SAME every-union span (the rule
    // is symmetric): a pane binds ONLY a row that is its SOLE candidate AND
    // that NO other ref-less pane claims — any ambiguity (two rows correlate
    // to one pane, one row claimed by two panes) leaves the pane ref-less
    // and the row unreferenced (never guess).
    //
    // Focused-ep3-r2 Finding 1: ambiguity TAINTS the rows too, not just the
    // pane bind. Every row that PARTICIPATES in an ambiguous correlation —
    // any row in a multi-candidate pane's set (pane-side), or a row claimed
    // by two-or-more ref-less panes (row-side) — is excluded from
    // `ledgerOnly` for this inventory build (never correlated, NEVER
    // OFFERED: offering the candidates replays the finding's three-panes-
    // for-one-open shape). This is an offer-eligibility decision only: the
    // rows stay in the ledger (no retirement, no delete) and are counted
    // separately in the D8 judgment debug line (`ambiguous_suppressed`).
    let mut correlation_claims: HashMap<String, usize> = HashMap::new();
    let mut ambiguous_rows: HashSet<String> = HashSet::new();
    // Focused-ep3-r3: the retired tier keeps the bound tier's never-guess
    // discipline (sole candidate AND sole claimant), but its claim census
    // counts ONLY panes with NO bound candidates — a pane taking the bound
    // path never effectively claims a retired row, so its retired candidates
    // must not taint a sibling pane's verdict. Retired rows join NEITHER
    // `ambiguous_rows` nor the suppression filter: they never reach the
    // ledgerOnly pipeline at all (the row_is_bound pre-filter), so there is
    // no offer to suppress them from. An ambiguous retired correlation simply
    // leaves the pane at today's ("unknown", None) shape — never a coin flip
    // between two ended identities.
    let mut retired_claims: HashMap<String, usize> = HashMap::new();
    for d in &unions {
        for rec in d.union_doc["records"].as_array().into_iter().flatten() {
            for pane in rec["panes"].as_array().into_iter().flatten() {
                if pane["payload"]
                    .get("sessionRef")
                    .filter(|v| !v.is_null())
                    .is_some()
                {
                    continue; // the D4 authority chain owns panes WITH a snapshot claim
                }
                // Delta-r6-r2 (Finding 1): a pane the close record covers
                // claims NOTHING — counting its (would-be) candidates would
                // taint rows that are, post-close, on their own track.
                if pane_covered_by_close(pane) {
                    continue;
                }
                let candidates =
                    correlation_candidates(pane, &by_create_request_id, &by_live_terminal_id);
                if candidates.len() > 1 {
                    // Pane-side ambiguity: EVERY candidate participates.
                    for row in &candidates {
                        ambiguous_rows.insert(ref_key(&row.provider, &row.session_id));
                    }
                }
                let no_bound_candidates = candidates.is_empty();
                for row in candidates {
                    *correlation_claims
                        .entry(ref_key(&row.provider, &row.session_id))
                        .or_default() += 1;
                }
                if no_bound_candidates {
                    for row in correlation_candidates(
                        pane,
                        &retired_by_create_request_id,
                        &retired_by_live_terminal_id,
                    ) {
                        *retired_claims
                            .entry(ref_key(&row.provider, &row.session_id))
                            .or_default() += 1;
                    }
                }
            }
        }
    }
    // Row-side ambiguity: a row claimed by two-or-more ref-less panes
    // participates in ambiguity no matter how each claimant's own set looks.
    for (key, claims) in &correlation_claims {
        if *claims > 1 {
            ambiguous_rows.insert(key.clone());
        }
    }
    let mut correlated = 0usize;
    let mut ambiguous = 0usize;
    let mut retired_correlated = 0usize;
    let mut referenced: HashSet<String> = HashSet::new();
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
                        // Delta-r6-r2 (Finding 1) — the close consult sits at
                        // the TOP of the verdict: a pane the close record
                        // covers was deliberately closed pre-loss (kill
                        // inside the evidence window), whatever its
                        // identities did later on OTHER panes. Closed trumps
                        // every correlation/claim; the pane is never
                        // restored.
                        let covered = pane_covered_by_close(pane);
                        // Delta-r6-r4e (the kill-window e2e's actual payload
                        // shape), ordered by focused-episode-6 round 4
                        // (Findings F1+F2): claude panes snapshotted
                        // pre-association carry NO `sessionRef` — the
                        // placeholder rides the payload's `sessionKeys`
                        // (`provider:sessionId`, the cross-device rings
                        // stamp). The ref-less consult is ORDERED, and
                        // closedness never beats a live/current association:
                        //   1. a well-formed key in the supplied live-session
                        //      set ⇒ LIVE (the session is running now — the
                        //      offer must never spawn a second one on top);
                        //   2. a key resolving to a BOUND row (the claim
                        //      commit's genuine reopen — a re-fed residue
                        //      fence beside it is stale bookkeeping) ⇒ the
                        //      bound verdict off that row;
                        //   3. ONLY then does a standing fence close the
                        //      pane (the identity was killed and never
                        //      redeemed, and nothing live/current
                        //      contradicts it);
                        //   4. otherwise the ref-less tiers below run
                        //      unchanged. Panes WITH a snapshot claim take
                        //      the D4 chain directly (its closed corridors
                        //      carry the same never-beat-a-live-claim rule).
                        // Let bindings — flat, so the consult chain below
                        // keeps the pre-existing arms at their exact old
                        // nesting depth.
                        let session_keys: Vec<(String, String)> = if snap_ref.is_none() {
                            payload
                                .get("sessionKeys")
                                .and_then(Value::as_array)
                                .map(|keys| {
                                    keys.iter()
                                        .filter_map(Value::as_str)
                                        .filter_map(|k| {
                                            k.split_once(':')
                                                .filter(|(p, s)| !p.is_empty() && !s.is_empty())
                                                .map(|(p, s)| (p.to_string(), s.to_string()))
                                        })
                                        .collect()
                                })
                                .unwrap_or_default()
                        } else {
                            Vec::new()
                        };
                        let live_key = session_keys
                            .iter()
                            .find(|(p, s)| is_live(p, s))
                            .cloned();
                        let bound_key = if live_key.is_none() {
                            session_keys.iter().find_map(|(p, s)| {
                                match resolve(p, s, &by_key) {
                                    Verdict::Bound(bp, bs) => Some((bp, bs)),
                                    _ => None,
                                }
                            })
                        } else {
                            None
                        };
                        let fenced_key = live_key.is_none()
                            && bound_key.is_none()
                            && session_keys.iter().any(|(p, s)| {
                                closes
                                    .standing_kill_tombstones
                                    .contains(&(p.clone(), s.clone()))
                            });
                        let (ledger_state, eff_ref) = if covered {
                            ("closed", None)
                        } else if let Some((p, s)) = live_key {
                            (
                                "bound",
                                Some(json!({"provider": p, "sessionId": s})),
                            )
                        } else if let Some((bp, bs)) = bound_key {
                            (
                                "bound",
                                Some(json!({"provider": bp, "sessionId": bs})),
                            )
                        } else if fenced_key {
                            ("closed", None)
                        } else {
                        match &snap_ref {
                            None => {
                                // Focused-ep3 bind-by-correlation: the pane was
                                // snapshotted inside its identity-association
                                // window. Bind ONLY the unambiguous case — the
                                // pane's SOLE candidate row, claimed by NO other
                                // ref-less pane; the pane then behaves exactly
                                // as if the snapshot had claimed the row
                                // (bound state + the row's identity + live via
                                // the D7 join + referenced, keeping the row out
                                // of ledgerOnly). Any ambiguity stays today's
                                // shape (unknown/ref-less), and the TAINTED
                                // rows are suppressed from the offer below
                                // (focused-ep3-r2 Finding 1); the debug line
                                // below reports all three counters.
                                let candidates = correlation_candidates(
                                    pane,
                                    &by_create_request_id,
                                    &by_live_terminal_id,
                                );
                                match candidates.as_slice() {
                                    [row]
                                        if correlation_claims
                                            .get(&ref_key(&row.provider, &row.session_id))
                                            .copied()
                                            == Some(1) =>
                                    {
                                        correlated += 1;
                                        (
                                            "bound",
                                            Some(
                                                json!({"provider": row_provider(row), "sessionId": row_session_id(row)}),
                                            ),
                                        )
                                    }
                                    [] => {
                                        // Focused-ep3-r3 (closed-arm parity):
                                        // NO Bound row correlates, but a
                                        // RETIRED row keeping the pane's
                                        // advisory ids is the ledger's
                                        // authoritative record of where this
                                        // pane's identity ENDED. For the
                                        // unambiguous retired correlation
                                        // (sole candidate AND sole claimant),
                                        // emit the SAME verdict shape the
                                        // snapshot-claim arm's D4 chain
                                        // produces for this row's identity —
                                        // resolve() decides it, with the
                                        // row's identity standing in for the
                                        // absent claim:
                                        //   Closed terminus              => ("closed", None) — THE FINDING
                                        //   SessionMissing/GcExpired     => ("gc_expired", row
                                        //     identity) — the claim arm's
                                        //     keep-the-original-claim shape
                                        //   Superseded                   => the chain's own
                                        //     verdict (a Bound successor binds;
                                        //     a closed terminus => ("closed", None))
                                        // Any ambiguity stays today's
                                        // ("unknown", None) — never guess.
                                        let retired = correlation_candidates(
                                            pane,
                                            &retired_by_create_request_id,
                                            &retired_by_live_terminal_id,
                                        );
                                        match retired.as_slice() {
                                            [row]
                                                if retired_claims
                                                    .get(&ref_key(&row.provider, &row.session_id))
                                                    .copied()
                                                    == Some(1) =>
                                            {
                                                retired_correlated += 1;
                                                let identity = json!({"provider": row_provider(row), "sessionId": row_session_id(row)});
                                                match resolve(
                                                    &row.provider,
                                                    &row.session_id,
                                                    &by_key,
                                                ) {
                                                    Verdict::Bound(bp, bs) => (
                                                        "bound",
                                                        Some(
                                                            json!({"provider": bp, "sessionId": bs}),
                                                        ),
                                                    ),
                                                    Verdict::Closed => ("closed", None),
                                                    Verdict::GcExpired => {
                                                        ("gc_expired", Some(identity))
                                                    }
                                                    // Unreachable: the row
                                                    // comes from `bindings`,
                                                    // which `by_key` covers —
                                                    // resolve() can never miss
                                                    // the first hop. Claim-arm
                                                    // parity shape regardless.
                                                    Verdict::Unknown => ("unknown", Some(identity)),
                                                }
                                            }
                                            _ => {
                                                if !retired.is_empty() {
                                                    ambiguous += 1;
                                                }
                                                ("unknown", None)
                                            }
                                        }
                                    }
                                    _ => {
                                        ambiguous += 1;
                                        ("unknown", None)
                                    }
                                }
                            }
                            Some(r) => {
                                let (p, s) = (
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or(""),
                                );
                                match resolve(p, s, &by_key) {
                                    Verdict::Bound(bp, bs) => {
                                        ("bound", Some(json!({"provider": bp, "sessionId": bs})))
                                    }
                                    Verdict::Closed => ("closed", None),
                                    Verdict::GcExpired => ("gc_expired", Some(r.clone())),
                                    // Delta-r6-r2 (Finding 1), the fresh-agent
                                    // placeholder half: NO row carries this
                                    // identity anywhere, but its kill fence
                                    // stands — the pane was closed before its
                                    // identity ever landed as a row. A
                                    // STANDING fence means the close was
                                    // never redeemed — with ONE contradiction
                                    // rule (focused-episode-6 round 4, F1): a
                                    // claim in the live-session set is a
                                    // CURRENT association (the fence is
                                    // residue), so it never closes the pane.
                                    Verdict::Unknown => {
                                        if closes.standing_kill_tombstones.contains(&(
                                            p.to_string(),
                                            s.to_string(),
                                        )) && !is_live(p, s)
                                        {
                                            ("closed", None)
                                        } else {
                                            ("unknown", Some(r.clone()))
                                        }
                                    }
                                }
                            }
                        }
                        };
                        let eff_str = eff_ref
                            .as_ref()
                            .map(|r| {
                                format!(
                                    "{}:{}",
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or("")
                                )
                            })
                            .unwrap_or_else(|| "-".into());
                        // Finding F2 (focused-episode-6 round 5): durable-ref
                        // liveness stays PRIMARY; the terminal-id arm is the
                        // FALLBACK for panes with no session identity at all
                        // (a plain shell: no rows, no claims — its snapshot's
                        // `liveTerminal.terminalId` membership in the server's
                        // live-terminal set is its liveness claim). A closed
                        // verdict never reads live: the close envelope lands
                        // before the kill's teardown, so a mid-teardown
                        // terminal can still be Running beside a durably
                        // closed pane.
                        let ref_live = eff_ref
                            .as_ref()
                            .map(|r| {
                                is_live(
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or(""),
                                )
                            })
                            .unwrap_or(false);
                        let terminal_id_live = ledger_state != "closed"
                            && pane["kind"].as_str() == Some("terminal")
                            && payload
                                .get("liveTerminal")
                                .and_then(|handle| handle.get("terminalId"))
                                .and_then(Value::as_str)
                                .filter(|id| !id.is_empty())
                                .is_some_and(|id| live.terminal_ids.contains(id));
                        let pane_live = ref_live || terminal_id_live;
                        if let Some(er) = &eff_ref {
                            referenced.insert(ref_key(
                                er["provider"].as_str().unwrap_or(""),
                                er["sessionId"].as_str().unwrap_or(""),
                            ));
                        }
                        // TIMESTAMP-FREE substance line: capturedAt/updatedAt
                        // deliberately absent (D3). Focused-episode-6 round 5
                        // (Finding F3, Minor): the `live` flag is digest
                        // substance NOW that liveness materially changes the
                        // offer (live panes are included and restore by
                        // reattach/adopt — the F1 regime): a live→dead
                        // transition produces a materially different offer for
                        // the SAME panes, so the dismissal identity must
                        // re-key on it (a stale dismissal must never suppress
                        // panes that have since become resumable).
                        substance.push(format!(
                            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
                            device_id,
                            rec["tabKey"].as_str().unwrap_or(""),
                            pane["paneId"].as_str().unwrap_or(""),
                            pane["kind"].as_str().unwrap_or(""),
                            eff_str,
                            pane_live
                        ));
                        json!({
                            "paneId": pane["paneId"], "kind": pane["kind"],
                            "mode": payload.get("mode").cloned().unwrap_or(Value::Null),
                            "shell": payload.get("shell").cloned().unwrap_or(Value::Null),
                            "cwd": payload.get("initialCwd").cloned().unwrap_or(Value::Null),
                            "payload": payload.clone(),
                            "sessionRef": eff_ref.unwrap_or(Value::Null),
                            "ledgerState": ledger_state,
                            "live": pane_live,
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

    // D8 judgment inputs (see UNSNAPSHOTTED_BINDING_GRACE_MS): the primary
    // device's surviving-client evidence — the only cohort whose rows can be
    // offered at all — plus the primary union's placement whitelist, the
    // delta-r2 placement set (a kept row must rejoin a tab the offer actually
    // restores; anything else is unplaceable and excluded).
    let primary_device_id = primary_idx.map(|i| unions[i].device_id.as_str());
    let primary_clients = primary_device_id.and_then(|id| {
        evidence
            .iter()
            .find(|(device, _)| device == id)
            .map(|(_, clients)| clients.as_slice())
    });
    // Focused-ep2-r1 Finding 1 (whitelist membership): built from the primary
    // union's RAW records — where `status` is still visible (the projection
    // above discards it). A record joins the set ONLY when its status means
    // OPEN (`"open"`, or absent — the record's default per
    // server/tabs-registry/types.ts: `status` is `open|closed` with no third
    // value, the closed-but-retained shape always stamps `"closed"`, and the
    // persisted-generation read validation already requires `open` on real
    // disk data, so absent-as-open cannot launder a genuine tombstone) AND
    // its `panes` array is non-empty — the client's joinability gate
    // (`placeLedgerEntries`, build-recovery-plan.ts: rows join only tabs with
    // panes.length > 0) requires both, so admitting the key here would offer
    // a row the accept path could never place (offer count > accepted plan).
    let primary_tab_keys: Option<HashSet<String>> = primary_idx.map(|i| {
        unions[i]
            .union_doc
            .get("records")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|rec| {
                matches!(rec.get("status").and_then(Value::as_str), None | Some("open"))
                    && rec
                        .get("panes")
                        .and_then(Value::as_array)
                        .is_some_and(|panes| !panes.is_empty())
            })
            .filter_map(|rec| rec.get("tabKey").and_then(Value::as_str).map(String::from))
            .collect()
    });

    let mut d8_dropped = 0usize;
    let mut ambiguous_suppressed = 0usize;
    let mut close_covered = 0usize;
    // Row-side dismissal substance, pushed by the entry map below (F3 — see
    // the push site). TIMESTAMP-FREE by construction (the line names only
    // stable identity/placement handles).
    let mut ledger_row_substance: Vec<String> = Vec::new();
    let ledger_only: Vec<Value> = bindings
        .iter()
        .filter(|r| row_is_bound(r))
        // vs effective refs across ALL unions (A4), not just the primary device
        .filter(|r| !referenced.contains(&ref_key(&row_provider(r), &row_session_id(r))))
        // Delta-round-7 (Finding F2): a close-covered row is NEVER offered —
        // the pane it belongs to was deliberately closed (the terminal
        // DETACH lane journals the pane-close record now, answering "was
        // this PANE closed" within the grace window that cannot tell
        // created-then-closed from created-then-crashed). The row itself
        // stays Bound for sidebar reattach.
        .filter(|r| {
            let covered = row_close_covered(r);
            if covered {
                close_covered += 1;
            }
            !covered
        })
        // Delta-round-7 (Finding F1): LIVE rows are INCLUDED (reversing the
        // round-3 categorical exclusion, the finding's harm): an unreferenced
        // still-running session whose pane never reached a surviving snapshot
        // is genuinely open — liveness + attribution + placement are the
        // evidence. The row answers the SAME attribution/grace/placement
        // judgment as a dead row below; the `live` stamp (+ the row's
        // still-running terminal id) routes the client to reattach/adopt —
        // NEVER a respawn. Dead rows keep the pre-existing resume treatment;
        // dead/unattributed/unverifiable rows stay excluded by the same
        // gates that always owned them.
        //
        // Focused-ep3-r2 Finding 1 (offer-eligibility only): rows tainted by
        // an ambiguous correlation are never offered. Rows that do not
        // correlate at all are untouched — they fall through to the normal
        // D8 judgment below.
        .filter(|r| {
            let suppressed =
                ambiguous_rows.contains(&ref_key(&row_provider(r), &row_session_id(r)));
            if suppressed {
                ambiguous_suppressed += 1;
            }
            !suppressed
        })
        .filter(|r| {
            let keep = d8_parent_relative_keep(
                r,
                primary_device_id,
                primary_clients,
                primary_tab_keys.as_ref(),
            );
            if !keep {
                d8_dropped += 1;
            }
            keep
        })
        .map(|r| {
            let row_live = is_live(&row_provider(r), &row_session_id(r));
            // Delta-r7-round-3 (focused-episode-7 round-2, Finding F3) — the
            // dismissal contentId folds the row's PANE IDENTITY substance
            // (createRequestId + tabKey + liveTerminalId), the ledger-side
            // parity of the snapshot rows' placement keys (deviceId +
            // tabKey + paneId, line ~987): reattaching the same still-running
            // session changes its pane identity (and potentially its
            // destination tab and terminal handle), and a dismissal recorded
            // against the earlier offer must never suppress the materially
            // different one. Read from the ROW (not the entry) so the digest
            // never depends on the wire's live-only forwarding of the
            // terminal handle: identity churn re-keys even for dead rows.
            ledger_row_substance.push(format!(
                "{}:{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
                row_provider(r),
                row_session_id(r),
                row_live,
                r.create_request_id.as_deref().unwrap_or(""),
                r.tab_key.as_deref().unwrap_or(""),
                r.live_terminal_id.as_deref().unwrap_or("")
            ));
            let mut entry = json!({"provider": row_provider(r), "sessionId": row_session_id(r),
                   "mode": row_mode(r), "cwd": row_cwd(r), "live": row_live});
            // The REATTACH arm (F1): a LIVE row forwards its still-running
            // terminal id — the client's one-shot paneId→terminalId reattach
            // target (never a respawn). Dead rows forward no handle: they
            // restore by resume.
            if row_live {
                if let Some(live_terminal_id) = &r.live_terminal_id {
                    entry["liveTerminalId"] = json!(live_terminal_id);
                }
            }
            // D8: forward the stamped tabKey for the client-side original-tab join.
            if let Some(tab_key) = &r.tab_key {
                entry["tabKey"] = json!(tab_key);
            }
            // Fresh-agent rows forward their pane_kind so the client's plan
            // builder packages the row as a fresh-agent resume — never a
            // terminal shell (the row's mode is a fresh-agent session type).
            if let Some(pane_kind) = &r.pane_kind {
                entry["paneKind"] = json!(pane_kind);
            }
            // Focused-ep1 Finding B: forward the row's recorded resume settings
            // (when present) so a restored fresh-agent pane keeps its ORIGINAL
            // model/effort/sandbox/permissionMode instead of silently adopting
            // CURRENT defaults. Absent ⇒ the client keeps today's defaulting.
            if let Some(model) = &r.model {
                entry["model"] = json!(model);
            }
            if let Some(effort) = &r.effort {
                entry["effort"] = json!(effort);
            }
            if let Some(sandbox) = &r.sandbox {
                entry["sandbox"] = json!(sandbox);
            }
            if let Some(permission_mode) = &r.permission_mode {
                entry["permissionMode"] = json!(permission_mode);
            }
            entry
        })
        .collect();
    tracing::debug!(target: "freshell_server::recovery_inventory",
        dropped = d8_dropped,
        kept = ledger_only.len(),
        primary = primary_device_id.is_some(),
        correlated,
        ambiguous_correlations = ambiguous,
        retired_correlated,
        ambiguous_suppressed,
        close_covered,
        "D8 offer judgment");

    // contentId: sha256 over the sorted TIMESTAMP-FREE substance (A5/A6, D3).
    // Delta-round-7 (Finding F1): the row's `live` flag folds into the
    // substance for the same reason the pane verdict's does (focused-episode-6
    // round 5, Finding F3) — a live→dead transition is a materially different
    // offer (reattach vs resume), so the dismissal identity must RE-KEY on it
    // rather than suppress the now-dead row under the live offer's id.
    // Delta-r7-round-3 (Finding F3): the row substance lines (pushed by the
    // entry map at construction) additionally fold the row's pane identity —
    // createRequestId + tabKey + liveTerminalId — so a reattach/replacement
    // RE-KEYS the dismissal identity.
    substance.extend(ledger_row_substance);
    substance.sort();
    let content_id = digest16(&substance);

    let recoverable = device.is_some() || !ledger_only.is_empty();
    json!({"recoverable": recoverable, "contentId": content_id,
           "device": device.unwrap_or(Value::Null),
           "otherDevices": other_devices, "ledgerOnly": ledger_only})
}

/// D8 (restore-open-sessions-only): keep a Bound, unreferenced, not-live row
/// iff it is ATTRIBUTED (`client_instance_id` && `device_id` present), its
/// attributed device is the offer's primary device, its attributed client
/// survives in that device's evidence, the row carries a PRESENT
/// `last_attributed_at` (focused-ep4-r4 Finding 1: no `created_at` fallback
/// — stamps and the field were introduced together, so a fieldless stamped
/// row is an intermediate-build artifact with no clock key and is excluded
/// exactly like an unattributed one) AND that LAST-ATTRIBUTION time is
/// within [`UNSNAPSHOTTED_BINDING_GRACE_MS`] of that parent's
/// revision-first-winner capturedAt (the freshest stamp of the parent's
/// final revision — the FIRST matching entry on the route's (revision,
/// capturedAt)-descending feed, identical to the union's winner key;
/// focused-ep4-r5 Finding 3), AND (delta-r2 Finding 3 +
/// focused-ep2-r1 Finding 1) its stamped `tab_key` names an OPEN, paned tab
/// in the primary union — the restored-tab set the client joins it into.
/// Unattributed / fieldless / non-primary-device / no-surviving-parent /
/// unplaceable-tab rows are NEVER offered.
fn d8_parent_relative_keep(
    r: &BindingRow,
    primary_device_id: Option<&str>,
    primary_clients: Option<&[(String, u64)]>,
    primary_tab_keys: Option<&HashSet<String>>,
) -> bool {
    let (Some(client), Some(device)) = (r.client_instance_id.as_deref(), r.device_id.as_deref())
    else {
        return false; // unattributed (headless REST/MCP, pre-upgrade) rows are never offered
    };
    let (Some(primary), Some(clients), Some(tab_keys)) =
        (primary_device_id, primary_clients, primary_tab_keys)
    else {
        return false; // no primary device => no evidence at all to judge against
    };
    if device != primary {
        return false;
    }
    let Some(parent_newest) = clients
        .iter()
        .find(|(c, _)| c == client)
        .map(|(_, captured)| *captured)
    else {
        return false; // the row's parent client left no surviving evidence on this device
    };
    // Delta-r4 Finding 1 + focused-ep4/ep4-r2/ep4-r4 findings (judgment-time
    // composition): key on the row's last MEANINGFUL browser attribution
    // (`last_attributed_at`) and NOTHING else — NEVER `updated_at`: conn-less
    // `Inherit` upserts refresh `updated_at` without any browser re-asserting
    // the pane, which parked long-closed detached rows past the frozen parent
    // evidence. And never `created_at` either: the attribution time is
    // browser-ASSERTED (carried on the provenance value — a late-landing
    // write records the receipt time, not its own) and authoritative, while
    // `created_at` is row-keeping metadata — for marker-derived rows it IS
    // the conn-less resolution time (potentially long after the pane closed
    // and the evidence froze), so a `created_at` fallback would re-launder a
    // resolved-after-close pane into the offer.
    // Focused-ep4-r4 Finding 1 (no legacy fallback): stamps and the field
    // were introduced TOGETHER in this branch — a current-writer stamped row
    // ALWAYS carries it, so the only stamped-but-fieldless rows are
    // intermediate-branch-build dev rows (whose `created_at` can be invented
    // late). Such a row has no attribution clock key and is excluded exactly
    // like an unattributed one.
    let Some(attributed_at) = r.last_attributed_at else {
        return false;
    };
    let row_time = attributed_at.max(0) as u64;
    if row_time.saturating_add(UNSNAPSHOTTED_BINDING_GRACE_MS) < parent_newest {
        return false; // the parent's evidence already observed the row's absence
    }
    // Delta-r2 Finding 3 (placement exactness), narrowed by focused-ep2-r1
    // Finding 1: the stamped tabKey must name an OPEN, paned tab in the
    // offer's union (the whitelist above excludes closed-but-retained and
    // zero-pane union records). A pane whose whole TAB was created and lost
    // inside the sub-cadence push window, or whose tab is not genuinely
    // restorable, is unplaceable — no retained open data knows the tab — so
    // it is deliberately EXCLUDED here rather than dumped into an unrelated
    // tab by the client's old trailing-tab fallback.
    let Some(tab_key) = r.tab_key.as_deref() else {
        return false;
    };
    tab_keys.contains(tab_key)
}

// Thin accessors over the real `BindingRow` fields/enums
// (`crates/freshell-ws/src/pane_ledger.rs:93`) — single field accesses, no logic.

fn row_provider(r: &BindingRow) -> String {
    r.provider.clone()
}

fn row_session_id(r: &BindingRow) -> String {
    r.session_id.clone()
}

fn row_is_bound(r: &BindingRow) -> bool {
    r.state == RowState::Bound
}

fn row_is_retired(r: &BindingRow) -> bool {
    r.state == RowState::Retired
}

fn row_reason_is_closed(r: &BindingRow) -> bool {
    r.retired_reason == Some(RetiredReason::Closed)
}

fn row_successor(r: &BindingRow) -> Option<(String, String)> {
    r.superseded_by
        .as_ref()
        .map(|l| (l.provider.clone(), l.session_id.clone()))
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
    let (unions, evidence) = match state.snapshots_dir.clone() {
        None => (vec![], vec![]),
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
    let live = LiveEvidence {
        session_keys: live_session_keys(&state.registry, &state.identity),
        // Focused-episode-6 round 5 (Finding F2): the shell half of the D7
        // join — a plain shell carries no session identity, so its liveness
        // claim is its snapshot terminal's membership in the Running set.
        terminal_ids: live_terminal_ids(&state.registry),
    };
    // Focused-ep5-r2 Finding 1 (round-4 amended, focused-ep5-r3 Finding 4):
    // a still-Bound row dominated by a kill tombstone (the split-write crash
    // remnant) reads as Retired at inventory-build time — never offered.
    // Dominance NEVER expires while the row reads Bound: a close's tombstone
    // plus an unconverged Bound row outlive the 6h TTL, so a post-outage
    // offer can never resurrect an identity the user closed before the crash.
    let dominant_tombstones = state.ledger.dominant_kill_tombstone_keys();
    // Delta-r6-r2 (Finding 1): the verdict join's close evidence — memory-
    // fast reads against the write-through index, same as the dominance set.
    // Delta-round-7 (Finding F2): the non-retiring detach closes join too
    // (their own read model — never the kill lane's `list_pane_closes`).
    let closes = CloseEvidence {
        standing_kill_tombstones: state.ledger.all_kill_tombstone_keys(),
        pane_closes: state.ledger.list_pane_closes(),
        pane_detach_closes: state.ledger.list_pane_detach_closes(),
    };
    Json(build_inventory(
        unions,
        apply_kill_tombstone_dominance(state.ledger.list_bindings(), &dominant_tombstones),
        live,
        &evidence,
        &closes,
    ))
    .into_response()
}

/// Read-only liveness join (D7): `(provider = mode, sessionId)` for every
/// currently-Running terminal row — the same row fields the ladder's A13 guard
/// reads (`terminal.rs:1690-1745`: mode + resume session id, status ==
/// `TerminalRunStatus::Running`).
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
) -> HashSet<(String, String)> {
    let mut keys: HashSet<(String, String)> = registry
        .directory()
        .into_iter()
        .filter(|row| row.status == freshell_protocol::TerminalRunStatus::Running)
        .filter_map(|row| {
            row.resume_session_id
                .filter(|s| !s.is_empty())
                .map(|sid| (row.mode, sid))
        })
        .collect();
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
        if owner_running {
            keys.insert((provider, session_id));
        }
    }
    keys
}

/// The shell half of the D7 liveness join (focused-episode-6 round 5, Finding
/// F2): the terminal ids of every Running registry row — the same registry
/// read `live_session_keys` filters, projected onto the id alone. An
/// unidentified pane (a plain shell: no rows, no claims — the durable-ref
/// half can never fire for it) claims liveness by its snapshot's
/// `liveTerminal.terminalId` membership here.
fn live_terminal_ids(registry: &freshell_terminal::TerminalRegistry) -> HashSet<String> {
    registry
        .directory()
        .into_iter()
        .filter(|row| row.status == freshell_protocol::TerminalRunStatus::Running)
        .map(|row| row.terminal_id)
        .collect()
}

/// Test-only seam: simulate a concurrent `persist_generation` retention
/// prune landing BETWEEN the overview scan and the union read (each takes
/// the persist lock separately, so a `tabs.sync.push` from any reconnecting
/// client can delete a just-selected generation file in that window). Each
/// seeded batch is one such interleaved prune; batches are matched to the
/// store root so parallel tests on other tempdirs are unaffected. Production
/// builds compile this to a no-op.
#[cfg(test)]
static INJECTED_PRUNE_BATCHES: std::sync::Mutex<Vec<Vec<std::path::PathBuf>>> =
    std::sync::Mutex::new(Vec::new());

fn injected_prune_between_reads(_dir: &std::path::Path) {
    #[cfg(test)]
    {
        let mut batches = INJECTED_PRUNE_BATCHES.lock().unwrap();
        if let Some(position) = batches
            .iter()
            .position(|batch| batch.first().is_some_and(|path| path.starts_with(_dir)))
        {
            for path in batches.remove(position) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Bounded re-reads when a concurrent retention prune lands between the
/// overview scan and the union read. The two reads each take the tabs-persist
/// lock separately, so a `tabs.sync.push` — which every reconnecting client
/// fires at exactly the moment a fresh window fetches the inventory — can
/// delete a just-selected generation file in between (a client at its
/// retention cap prunes its oldest retained generation on every push, and
/// selection takes ALL retained generations of surviving clients). A fresh
/// overview re-selects from what actually survives, so one re-read converges
/// in the benign race; exhaustion means the store is churning or incoherent
/// under the reader and MUST fail loud (500, `:373`), never a clean 200
/// whose inventory silently omits the whole device.
const UNION_READ_ATTEMPTS: usize = 3;

fn read_foreign_unions(
    dir: &std::path::Path,
    exclude_client: &str,
    boot_cutoff: u64,
) -> std::io::Result<(Vec<DeviceUnion>, DeviceEvidence)> {
    use freshell_ws::tabs_persist::{
        list_snapshot_devices, read_device_overview, read_generations_union_by_ids, ComponentsUnion,
    };
    let mut out = vec![];
    let mut evidence: DeviceEvidence = vec![];
    if !dir.is_dir() {
        return Ok((out, evidence));
    }
    'devices: for device in list_snapshot_devices(dir)? {
        let mut last_missing: Vec<String> = Vec::new();
        for _attempt in 0..UNION_READ_ATTEMPTS {
            let Some((_, generations)) = read_device_overview(dir, &device)? else {
                continue 'devices; // genuinely absent (e.g. evicted) — skip
            };
            // Task 1 helper: drops the requester's own generations, concurrent
            // post-boot clients (A16), AND stale clients (A15).
            let selection =
                select_foreign_recent_generation_ids(&generations, exclude_client, boot_cutoff);
            if selection.selected_ids.is_empty() {
                continue 'devices;
            }
            injected_prune_between_reads(dir);
            match read_generations_union_by_ids(dir, &device, &selection.selected_ids)? {
                ComponentsUnion::Found(union_doc) => {
                    out.push(DeviceUnion {
                        device_id: device.clone(),
                        union_doc,
                    });
                    // D8: the judgment's parent evidence comes from the FINAL
                    // (successful) attempt's selection — the one whose ids
                    // produced this union.
                    evidence.push((device, selection.winner_captured_at_by_client));
                    continue 'devices;
                }
                // A component pruned between the overview scan and the union
                // read: re-run the WHOLE cycle so selection reflects what
                // actually survives — never a silent whole-device drop.
                ComponentsUnion::Missing(ids) => last_missing = ids,
            }
        }
        tracing::error!(
            target: "freshell_server::recovery_inventory",
            device = %device,
            missing = ?last_missing,
            attempts = UNION_READ_ATTEMPTS,
            "recovery_inventory_device_union_incoherent: selected generations kept \
             disappearing between the overview scan and the union read; failing loud \
             rather than silently omitting the device from the recovery offer"
        );
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "recovery inventory union read incoherent for device {device}: \
                 {last_missing:?} still missing after {UNION_READ_ATTEMPTS} attempts"
            ),
        ));
    }
    Ok((out, evidence))
}

#[cfg(test)]
#[path = "recovery_inventory_tests.rs"]
mod tests;

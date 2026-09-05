//! Unit tests for `crate::pane_ledger` (P1.8, spec §4.2). Kept in a sibling
//! file (the `tabs_persist_tests.rs` convention) to respect the ≤1K-lines
//! file limit as the ledger's test surface grows.

use super::*;
use std::collections::HashSet;
use std::path::PathBuf;

fn temp_root(label: &str) -> PathBuf {
    // Same atomic-counter + pid pattern as `opencode_association.rs`'s
    // `unique_temp_dir` — no tempfile dependency needed for a dir we
    // remove ourselves.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-test-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp root");
    dir
}

/// H1 diagnostic: on a lock-acquisition failure, `/proc/locks` names the
/// live holder pid(s) for this lock file (self vs foreign is the only
/// discrimination it can make: the pid column is the LOCKING tgid, so an
/// inheritance-window transient reports THIS test process's own pid, never
/// the forked child's). Match the hardened dev+ino token (format
/// `%02x:%02x:%d`, evidence-locked by validator PoC arm c).
#[cfg(unix)]
fn lock_holder_report(lock_path: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::metadata(lock_path) else {
        return "lock file itself unreadable".into();
    };
    let token = format!(
        "{:02x}:{:02x}:{}",
        libc::major(meta.dev()),
        libc::minor(meta.dev()),
        meta.ino()
    );
    match std::fs::read_to_string("/proc/locks") {
        Ok(body) => {
            let hits: Vec<&str> = body
                .lines()
                .filter(|l| l.split_whitespace().nth(5) == Some(token.as_str()))
                .collect();
            if hits.is_empty() {
                format!("no /proc/locks row for {token}")
            } else {
                hits.join("\n")
            }
        }
        Err(err) => format!("lock-holders unavailable: {err}"),
    }
}

fn write(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    now_ms: i64,
) -> BindingWrite<'static> {
    write_with_policy(
        provider,
        session_id,
        terminal_id,
        now_ms,
        ProvenancePolicy::Inherit,
    )
}

/// The conn-less lane ([`write`]'s default made explicit) and the
/// explicitly-headless lane share a constructor: only the policy differs.
fn write_with_policy(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    now_ms: i64,
    provenance: ProvenancePolicy<'static>,
) -> BindingWrite<'static> {
    // Leak the strings for test brevity — tests are short-lived.
    BindingWrite {
        provider: Box::leak(provider.to_string().into_boxed_str()),
        session_id: Box::leak(session_id.to_string().into_boxed_str()),
        terminal_id: Box::leak(terminal_id.to_string().into_boxed_str()),
        mode: Box::leak(provider.to_string().into_boxed_str()),
        cwd: Some("/tmp/proj"),
        create_request_id: Some("req-1"),
        origin_create_request_id: None,
        provenance,
        now_ms,
    }
}

/// D8 provenance variant of [`write`]: a connection-scoped create's stamps —
/// the WS connection's `(clientInstanceId, deviceId)` identity plus the
/// composed `tabKey` (`deviceId:tabId`) asserted via `Replace`, asserted at
/// the write's own `now_ms` (fresh creates: receipt ≈ spawn ≈ write).
fn write_provenance(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    now_ms: i64,
    client_instance_id: Option<&str>,
    device_id: Option<&str>,
    tab_key: Option<&str>,
) -> BindingWrite<'static> {
    write_provenance_at(
        provider,
        session_id,
        terminal_id,
        now_ms,
        client_instance_id,
        device_id,
        tab_key,
        now_ms,
    )
}

/// Focused-ep4-r2 Findings 1+2 twin of [`write_provenance`]: the provenance
/// value's assertion time differs from the write's `now_ms` — a slow
/// create/spawn/post-spawn write whose provenance was captured at receipt.
#[allow(clippy::too_many_arguments)]
fn write_provenance_at(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    now_ms: i64,
    client_instance_id: Option<&str>,
    device_id: Option<&str>,
    tab_key: Option<&str>,
    asserted_at: i64,
) -> BindingWrite<'static> {
    let leak = |s: Option<&str>| s.map(|v| &*Box::leak(v.to_string().into_boxed_str()));
    write_with_policy(
        provider,
        session_id,
        terminal_id,
        now_ms,
        ProvenancePolicy::Replace(ProvenanceStamps {
            client_instance_id: leak(client_instance_id),
            device_id: leak(device_id),
            tab_key: leak(tab_key),
            asserted_at,
        }),
    )
}

fn fa_write<'a>(provider: &'a str, session_id: &'a str, now_ms: i64) -> FreshAgentBindingWrite<'a> {
    FreshAgentBindingWrite {
        provider,
        session_id,
        mode: provider,
        cwd: Some("/tmp/proj"),
        create_request_id: None,
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        provenance: ProvenancePolicy::Inherit,
        now_ms,
    }
}

/// `fa_write` variant with connection-supplied stamps asserted (`Replace`),
/// asserted at the write's own `now_ms`.
fn fa_write_provenance<'a>(
    provider: &'a str,
    session_id: &'a str,
    now_ms: i64,
    client_instance_id: Option<&'a str>,
    device_id: Option<&'a str>,
    tab_key: Option<&'a str>,
) -> FreshAgentBindingWrite<'a> {
    fa_write_provenance_at(
        provider,
        session_id,
        now_ms,
        client_instance_id,
        device_id,
        tab_key,
        now_ms,
    )
}

/// Focused-ep4-r2 Findings 1+2 twin of [`fa_write_provenance`]: the value's
/// assertion time differs from the write's `now_ms` — a create whose binding
/// write lands long after the provenance was captured at message receipt
/// (e.g. the pane already closed mid-flight).
#[allow(clippy::too_many_arguments)]
fn fa_write_provenance_at<'a>(
    provider: &'a str,
    session_id: &'a str,
    now_ms: i64,
    client_instance_id: Option<&'a str>,
    device_id: Option<&'a str>,
    tab_key: Option<&'a str>,
    asserted_at: i64,
) -> FreshAgentBindingWrite<'a> {
    FreshAgentBindingWrite {
        provenance: ProvenancePolicy::Replace(ProvenanceStamps {
            client_instance_id,
            device_id,
            tab_key,
            asserted_at,
        }),
        ..fa_write(provider, session_id, now_ms)
    }
}

#[test]
fn bind_stamps_provenance_and_rebind_without_provenance_preserves_it() {
    // D8 (restore-open-sessions-only) merge rule: a connection-scoped create
    // stamps the row (Replace); a CONN-LESS re-bind of the same identity (the
    // shared resolution hook's `resolve_pending` shape, `Inherit`) must KEEP
    // every stamp — never erase them. This is the one hazard the terminal
    // upsert's historical REPLACE-semantics for advisory fields
    // (`create_request_id`) would otherwise inflict on the stamp fields.
    // (Delta-r2 Finding 2 test (b): the respawn/locator-style lane.)
    let root = temp_root("prov-keep");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    // Conn-less re-bind (respawn / locator/adoption resolution): asserts
    // nothing — `Inherit`.
    ledger
        .resolve_pending(&write("codex", "th-1", "t2", 5_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    assert_eq!(row.created_at, 1_000, "created_at is preserved on re-bind");
    assert_eq!(row.updated_at, 5_000, "updated_at advances on re-bind");
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "delta-r4 Finding 1: the attribution time survives the conn-less re-bind"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn headless_clear_rebind_erases_the_browser_stamps() {
    // Delta-r2 Finding 2, ledger arm of test (a): an explicitly-HEADLESS
    // re-bind (the REST/MCP lineage binder's policy) must ERASE the row's
    // browser stamps — never inherit them — so the rebound row becomes
    // unattributed and the D8 judgment correctly never offers it (the
    // refreshed `updated_at` can no longer launder a stale parent).
    let root = temp_root("prov-clear");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_binding(&write_with_policy(
            "codex",
            "th-1",
            "t2",
            5_000,
            ProvenancePolicy::Clear,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(
        row.client_instance_id, None,
        "Clear erases the clientInstanceId"
    );
    assert_eq!(row.device_id, None, "Clear erases the deviceId");
    assert_eq!(row.tab_key, None, "Clear erases the tabKey");
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "focused-ep4-r5 Finding 2: Clear RAISES the attribution floor \
         (max(1_000, clear_now = 5_000)) — it never erases the clock"
    );
    assert_eq!(row.created_at, 1_000, "created_at is preserved on re-bind");
    assert_eq!(
        row.updated_at, 5_000,
        "updated_at still refreshes (rewritten, unattributed)"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_with_newer_provenance_replaces_it() {
    // The other half of the D8 merge rule: a lane that KNOWS newer identity
    // (an adoption observed from a different client/tab) REPLACES the stamps —
    // keep-when-None must never pin stale provenance in place.
    let root = temp_root("prov-replace");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("c1"),
            Some("d1"),
            Some("d1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t2",
            2_000,
            Some("c2"),
            Some("d1"),
            Some("d1:tab-9"),
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("c2"));
    assert_eq!(row.device_id.as_deref(), Some("d1"));
    assert_eq!(row.tab_key.as_deref(), Some("d1:tab-9"));
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "a meaningful re-bind advances the attribution time"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_rebind_without_provenance_keeps_the_stamps() {
    // Same merge rule on the fresh-agent upsert body (where advisory
    // `create_request_id` already merges latest-observed): refresh lanes
    // (settings refresh, crash-recover, attach-resume) assert no provenance
    // (`Inherit`) and must never erase the create's stamps.
    let root = temp_root("fa-prov-keep");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "opencode",
            "ses_1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("opencode", "ses_1", 2_000))
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 2_000);
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "delta-r4 Finding 1: the conn-less fresh-agent refresh keeps the attribution time"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_clear_rebind_erases_stamps_and_never_inherits_the_parent() {
    // Delta-r2 Finding 2, fresh-agent body: `Clear` erases the row's stamps
    // wholesale, and a Clear fork-chain write (`supersedes: Some(parent)`)
    // must NOT inherit the superseded parent's stamps either — inheritance is
    // a conn-less-session-affiliated-lane behavior only. (Focused-ep4-r5
    // Finding 2: erasing the stamps no longer erases the attribution CLOCK —
    // `Clear` raises `last_attributed_at` to `max(prior, clear_now)`, carried
    // through the fork chain's `inherit` source like every other preserve.)
    let root = temp_root("fa-prov-clear");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "claude",
            "sess-1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provenance: ProvenancePolicy::Clear,
            ..fa_write("claude", "sess-1", 2_000)
        })
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(row.client_instance_id, None);
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "focused-ep4-r5 Finding 2: Clear raises the attribution floor \
         (max(1_000, clear_now = 2_000)) — the clock is floored, not erased"
    );
    assert_eq!(
        row.updated_at, 2_000,
        "updated_at refreshes; the stamps are gone"
    );

    // Fork-chain arm: Clear + supersedes -> no parent STAMP inheritance (the
    // attribution FLOOR carries through the chain: max(parent_floor, now)).
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            supersedes: Some("sess-1"),
            provenance: ProvenancePolicy::Clear,
            ..fa_write("claude", "sess-2", 3_000)
        })
        .unwrap();
    let sess2 = ledger
        .load_binding("claude", "sess-2")
        .expect("cleared child");
    assert_eq!(
        sess2.client_instance_id, None,
        "Clear never inherits a parent stamp"
    );
    assert_eq!(
        sess2.last_attributed_at,
        Some(3_000),
        "the floor rises to the child's own clear, bounded below by the parent's floor"
    );
    // Re-stamp the parent AFTER its retirement shape does not matter: seed a
    // fresh stamped parent and a Clear child instead, to pin inheritance-off.
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "claude",
            "sess-3",
            4_000,
            Some("client-9"),
            Some("device-9"),
            Some("device-9:tab-9"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            supersedes: Some("sess-3"),
            provenance: ProvenancePolicy::Clear,
            ..fa_write("claude", "sess-4", 5_000)
        })
        .unwrap();
    let child = ledger.load_binding("claude", "sess-4").expect("child row");
    assert_eq!(
        child.client_instance_id, None,
        "Clear never inherits the superseded parent"
    );
    assert_eq!(child.device_id, None);
    assert_eq!(child.tab_key, None);
    assert_eq!(
        child.last_attributed_at,
        Some(5_000),
        "the child floor is max(parent attribution 4_000, clear_now 5_000)"
    );
    let parent = ledger.load_binding("claude", "sess-3").expect("parent row");
    assert_eq!(
        parent.state,
        RowState::Retired,
        "supersession mechanics unchanged"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_rebind_with_newer_provenance_replaces_it() {
    let root = temp_root("fa-prov-replace");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "claude",
            "sess-1",
            1_000,
            Some("c1"),
            Some("d1"),
            Some("d1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "claude",
            "sess-1",
            2_000,
            Some("c2"),
            Some("d1"),
            Some("d1:tab-9"),
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("c2"));
    assert_eq!(row.device_id.as_deref(), Some("d1"));
    assert_eq!(row.tab_key.as_deref(), Some("d1:tab-9"));
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "a meaningful fresh-agent re-bind advances the attribution time"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_supersession_inherits_provenance_from_the_retired_parent() {
    // Fork-chain inheritance (claude rollback adoption, codex crash-respawn
    // re-mint): the child row is written with `supersedes: Some(parent)` and
    // `Inherit` provenance (conn-less lanes never invent provenance) under a
    // BRAND-NEW key — there is no same-key row to merge from, so the stamps
    // must come from the superseded parent row (the fork is, by construction,
    // the same pane).
    let root = temp_root("fa-prov-fork-inherit");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "claude",
            "parent-id",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            supersedes: Some("parent-id"),
            ..fa_write("claude", "child-id", 2_000)
        })
        .unwrap();
    let child = ledger
        .load_binding("claude", "child-id")
        .expect("child row");
    assert_eq!(child.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(child.device_id.as_deref(), Some("device-1"));
    assert_eq!(child.tab_key.as_deref(), Some("device-1:tab-1"));
    // The parent's retirement is unaffected (G3 chain intact).
    let parent = ledger
        .load_binding("claude", "parent-id")
        .expect("parent row");
    assert_eq!(parent.state, RowState::Retired);
    assert_eq!(parent.retired_reason, Some(RetiredReason::Superseded));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn legacy_row_without_stamps_reads_back_with_none_provenance() {
    // Pre-D8 rows carry no provenance keys at all (production probe: 72 of 75
    // live rows predate the last optional field and load fine). Hand-craft the
    // pre-D8 JSON shape in a temp dir, boot the ledger over it, and assert the
    // row loads Bound with None stamps and nothing is quarantined.
    let root = temp_root("prov-legacy");
    let dir = root.join("bindings").join("claude");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("s-legacy.json"),
        r#"{"ledgerVersion":1,"provider":"claude","sessionId":"s-legacy","mode":"claude","cwd":"/w","liveTerminalId":"t1","createRequestId":"req-1","createdAt":1,"updatedAt":2,"lastObservedAt":2,"state":"bound"}"#,
    )
    .unwrap();
    let ledger = PaneLedger::new(Some(root.clone()));
    let row = ledger
        .load_binding("claude", "s-legacy")
        .expect("legacy row loads");
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.client_instance_id, None);
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at, None,
        "pre-delta-r4 rows have no attribution time (creation-time key downstream)"
    );
    let report = ledger.boot_scan(10_000, &never_absent, Some(&no_snapshot_refs()));
    assert!(
        report.quarantined.is_empty(),
        "a legacy row is never quarantined by the D8 field addition"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Delta-r4 Finding 1: `last_attributed_at` writer dispositions ─────────────
// The judgment time is attribution time, never write time: a MEANINGFUL
// connection-scoped application (`Replace` with client+device both present)
// sets it; conn-less `Inherit` maintenance preserves it; `Clear` erases it.
// The merge bodies consume the ONE `advances_attribution` predicate.

#[test]
fn connection_scoped_write_stamps_the_attribution_time_durably() {
    // The WS create lanes' exact shape (`Replace` + the full stamp triple):
    // the row records WHEN the browser asserted this identity+tab — set from
    // the same `now_ms` as `updated_at`, and durable across a reboot (a fresh
    // ledger over the same root reads it back).
    let root = temp_root("attr-time-set");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.last_attributed_at, Some(1_000));
    assert_eq!(row.updated_at, 1_000);
    drop(ledger);
    let rebooted = PaneLedger::new(Some(root.clone()));
    let row = rebooted.load_binding("codex", "th-1").unwrap();
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the attribution time is durable (serde round-trip through disk)"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn conn_less_inherit_refresh_preserves_the_attribution_time() {
    // THE FINDING's lane, unit shape: the auto-resume respawn's conn-less
    // `Inherit` write refreshes `updated_at` (maintenance freshness) but must
    // NOT advance the attribution time — no browser re-asserted the pane. It
    // is exactly this decoupling that lets the D8 judgment ignore maintenance
    // churn after the parent's evidence froze.
    let root = temp_root("attr-time-keep");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t2", 5_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.updated_at, 5_000, "maintenance freshness still lands");
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the attribution time holds at the last genuine browser assertion"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn attributed_rebind_advances_the_attribution_time() {
    // The keep-side twin: a genuine attributed re-bind (a browser connection
    // re-asserts the identity) IS a fresh attribution and advances the key.
    let root = temp_root("attr-time-advance");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("c1"),
            Some("d1"),
            Some("d1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t2",
            5_000,
            Some("c2"),
            Some("d1"),
            Some("d1:tab-9"),
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.last_attributed_at, Some(5_000));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn headless_clear_erases_the_stamps_and_raises_the_attribution_floor() {
    // Focused-ep4-r5 Finding 2 (renamed from
    // `headless_clear_erases_the_attribution_time_too` — the flip the finding
    // mandates): `Clear` erases the IDENTITY stamps — the row is then
    // unattributed wholesale and unofferable while they are `None` — but it
    // RAISES the attribution-clock floor to `max(existing, clear_now)`, so a
    // delayed pre-Clear assertion can never pass an absent-time arm and
    // resurrect the cleared stamps.
    let root = temp_root("attr-time-clear");
    let ledger = PaneLedger::new(Some(root.clone()));
    // Arm 1: the ordinary ordering — the clear postdates the attribution.
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "th-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    ledger
        .record_binding(&write_with_policy(
            "codex",
            "th-1",
            "t2",
            5_000,
            ProvenancePolicy::Clear,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.client_instance_id, None);
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "the floor rises to the clear's time: max(1_000, clear_now = 5_000)"
    );
    assert_eq!(row.updated_at, 5_000, "still rewritten, just unattributed");
    // Arm 2: a clear whose WRITE lands late (clear_now < the row's recorded
    // attribution) — the floor is the MAX, never dragged down.
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "th-2",
            "t1",
            5_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            5_000,
        ))
        .unwrap();
    ledger
        .record_binding(&write_with_policy(
            "codex",
            "th-2",
            "t2",
            2_000,
            ProvenancePolicy::Clear,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-2").unwrap();
    assert_eq!(row.client_instance_id, None);
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "a late-landing clear never drags the floor down"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn weak_replace_leaves_the_attribution_fact_untouched() {
    // Focused-ep4-r3 Finding 2 (renamed from
    // `hollow_replace_never_advances_the_attribution_time` — the flip the
    // finding mandates): the attribution fact (stamps+time) is ATOMIC. A
    // partial `Replace` no longer merges its `Some` fields piecemeal: that
    // produced client/device/tab combinations NO single browser assertion
    // ever made, and (under the pre-fix predicate) refreshed the attribution
    // time against the row's kept, stale tab. Since focused-ep4-r5 Finding 1
    // the two gates are ATTACH (no prior attribution — needs exactly the
    // meaningful client+device halves; a legacy tab-less create/fork uses
    // this lane) and ADVANCE (a prior attribution exists — the full
    // client+device+tab triple with a not-older assertion, the finding-2
    // rule). The arms below fail BOTH (arm 1: half-initialized hello misses
    // device — nothing to attach; arm 2: a hollow re-assert over an
    // attributed row — nothing to advance into).
    let root = temp_root("attr-time-hollow");
    let ledger = PaneLedger::new(Some(root.clone()));
    // Arm 1: a partial Replace onto a FRESH row leaves it FULLY unattributed
    // (client without device is not MEANINGFUL — there is no attribution to
    // advance and nothing complete enough to attach).
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-partial",
            "t1",
            1_000,
            Some("client-1"),
            None,
            None,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-partial").unwrap();
    assert_eq!(row.client_instance_id, None);
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(row.last_attributed_at, None);
    // Arm 2: a partial Replace onto an attributed row PRESERVES the whole
    // attribution — stamps AND time.
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-2",
            "t2",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-2",
            "t3",
            5_000,
            Some("client-rotated"),
            None,
            None,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-2").unwrap();
    assert_eq!(
        row.client_instance_id.as_deref(),
        Some("client-1"),
        "the weaker write's client field does NOT piecemeal-merge"
    );
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "a hollow assertion is not an attribution"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn marker_stamped_resolution_stamps_the_attribution_time_from_the_markers_assertion() {
    // Delta-r3's marker provenance is spawn-time CONNECTION provenance, and
    // focused-ep4 Finding: the attribution TIME must be the marker's
    // ASSERTION time — carried on the marker's OWN `asserted_at` field since
    // the focused-ep4-r3 Finding 3 split — NOT the resolve write's `now` and
    // not the marker's write-time `spawned_at`: the browser asserted the pane
    // when it SPAWNED it, the marker may be written long after (a delayed
    // gated create), and the conn-less identity resolution merely lands the
    // marker's stamps later still (arbitrarily later for a codex/opencode
    // locator resolution — possibly after the pane already closed and the
    // parent's evidence froze, where resolve-time attribution would re-launder
    // the row into the D8 offer). A partially-stamped marker is hollow (never
    // an attribution).
    let root = temp_root("attr-time-marker");
    let ledger = PaneLedger::new(Some(root.clone()));
    // Distinct creation/assertion times (the Finding 3 split): asserted at
    // 1_000, the marker itself written at 1_500 (a delayed gated create).
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-1"),
                device_id: Some("device-1"),
                tab_key: Some("device-1:tab-1"),
                asserted_at: 1_000,
            },
            1_500,
        )
        .unwrap();
    let marker = ledger.pending_for_terminal("t1").expect("stamped marker");
    assert_eq!(
        marker.spawned_at, 1_500,
        "the marker's creation time is its own clock (retention)"
    );
    assert_eq!(
        marker.asserted_at, 1_000,
        "the assertion rides its own field"
    );
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the marker-derived application attributes at the marker's ASSERTION, \
         neither the marker's write nor the resolve"
    );
    assert_eq!(
        row.updated_at, 2_000,
        "the resolve write itself still lands at resolve time \
         (maintenance freshness is a separate clock)"
    );
    assert_eq!(
        row.created_at, 2_000,
        "the row is born at resolution — the judgment must not floor on it"
    );
    // Partial marker → hollow derived Replace → no attribution time.
    ledger
        .record_pending(
            "t2",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-1"),
                device_id: None,
                tab_key: None,
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-2", "t2", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-2").expect("binding row");
    assert_eq!(row.last_attributed_at, None, "a partial marker is hollow");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolution_of_a_legacy_marker_falls_back_to_spawned_at() {
    // Focused-ep4-r3 Finding 3 (legacy fallback): a marker persisted by an
    // INTERMEDIATE build (ep4-r2: for a STAMPED marker `spawned_at` WAS the
    // provenance's `asserted_at` — the split did not exist yet, so no
    // `assertedAt` field) deserializes with `asserted_at == 0`, and the
    // resolution sources the attribution time from `spawned_at` — exactly the
    // intermediate build's semantics, so its evidence survives the upgrade.
    let root = temp_root("marker-legacy-fallback");
    // Hand-craft the intermediate-build marker JSON ON DISK (the current code
    // would now also emit an `assertedAt` field), then construct the ledger
    // over it — the post-upgrade boot shape.
    let pending_dir = root.join("pending");
    std::fs::create_dir_all(&pending_dir).unwrap();
    std::fs::write(
        pending_dir.join("t-legacy.json"),
        r#"{"ledgerVersion":1,"terminalId":"t-legacy","mode":"codex","cwd":"/tmp/p","spawnedAt":1000,"clientInstanceId":"client-1","deviceId":"device-1","tabKey":"device-1:tab-1"}"#,
    )
    .unwrap();
    let ledger = PaneLedger::new(Some(root.clone()));
    let marker = ledger
        .pending_for_terminal("t-legacy")
        .expect("the legacy marker parses");
    assert_eq!(marker.spawned_at, 1_000);
    assert_eq!(
        marker.asserted_at, 0,
        "no field on disk ⇒ the 0 sentinel ⇒ the fallback is armed"
    );
    ledger
        .resolve_pending(&write("codex", "th-legacy", "t-legacy", 2_000))
        .unwrap();
    let row = ledger
        .load_binding("codex", "th-legacy")
        .expect("binding row");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the fallback is `spawned_at` — which the intermediate build set to \
         the assertion time, so its evidence resolves unchanged"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn post_spawn_write_records_the_provenances_assertion_time_not_the_writes() {
    // Focused-ep4-r2 Findings 1+2 (terminal body): the post-spawn binding
    // write (terminal.rs's `create_meta_record` arm) used to pass
    // `attributed_at: None` and stamp its OWN now_ms — a slow spawn or a
    // gated-restore queue wait would manufacture freshness for a pane that
    // already closed mid-flight. The provenance value carries the receipt
    // time: the write at T+30s must still attribute at T.
    let root = temp_root("attr-time-post-spawn");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t1",
            31_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the assertion time comes from the provenance value, never the write's now"
    );
    assert_eq!(
        row.updated_at, 31_000,
        "the write itself still lands at write time (maintenance clock)"
    );
    assert_eq!(
        row.created_at, 31_000,
        "row birth is row-keeping, not attribution"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_late_binding_write_records_the_provenances_assertion_time() {
    // Focused-ep4-r2 Findings 1+2 (fresh-agent body): the fresh-agent create
    // lane composes its provenance at WS receipt; the binding write lands only
    // after the sidecar spawn + SDK init — possibly long after the pane's tab
    // state moved on. Same rule: the value's `asserted_at` decides.
    let root = temp_root("attr-time-fa-late");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "opencode",
            "ses_1",
            31_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(row.last_attributed_at, Some(1_000));
    assert_eq!(row.updated_at, 31_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn marker_spawn_time_is_the_write_time_and_assertion_rides_its_own_field() {
    // Focused-ep4-r3 Finding 3 (renamed from
    // `stamped_markers_spawn_time_is_the_provenances_assertion_time` — the
    // split the finding mandates): `spawned_at` is the marker's ACTUAL
    // write/creation time — retention (the 30-day TTL, the 7-day orphan rule)
    // keys on it, so a delayed gated create can never arrive pre-aged; the
    // provenance value's assertion time rides the marker's OWN `asserted_at`
    // field, which a later resolution (not the GC) consumes.
    let root = temp_root("marker-spawn-is-asserted");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-1"),
                device_id: Some("device-1"),
                tab_key: Some("device-1:tab-1"),
                asserted_at: 900,
            },
            5_000,
        )
        .unwrap();
    let marker = ledger.pending_for_terminal("t1").expect("stamped marker");
    assert_eq!(
        marker.spawned_at, 5_000,
        "spawned_at is the marker's write/creation time (the retention clock)"
    );
    assert_eq!(
        marker.asserted_at, 900,
        "the provenance's assertion time rides its OWN field"
    );
    ledger
        .record_pending(
            "t2",
            "codex",
            None,
            None,
            ProvenanceStamps::default(),
            7_000,
        )
        .unwrap();
    let marker = ledger.pending_for_terminal("t2").expect("headless marker");
    assert_eq!(
        marker.spawned_at, 7_000,
        "an unstamped marker keeps its write-time spawn record"
    );
    assert_eq!(
        marker.asserted_at, 0,
        "a headless marker carries no assertion (the `0` sentinel)"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_conn_less_refresh_preserves_the_attribution_time() {
    // The fresh-agent body takes the same predicate: conn-less Inherit
    // refresh lanes (settings refresh, crash-recover, attach-resume) refresh
    // `updated_at` without touching the attribution time.
    let root = temp_root("fa-attr-time-keep");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "opencode",
            "ses_1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("opencode", "ses_1", 2_000))
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(row.updated_at, 2_000);
    assert_eq!(row.last_attributed_at, Some(1_000));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_supersession_inherits_the_parents_assertion_time() {
    // Focused-ep4-r2 Finding 1+2 (supersession arm): the provenance VALUE
    // carries its assertion time, and a fork-chain Inherit (claude rollback
    // adoption, codex crash-respawn) copies the parent's stamps AND that time
    // — the supersession chain keeps the TRUE assertion time. The judgment's
    // `created_at` floor that once made an inherited time unusable was
    // deleted by the ep4-r1 repair, so pane_ledger_tests.rs's old mis-pin
    // (`None` for the child) inverts: the child's judgment key IS the
    // parent's last browser assertion, never the child's conn-less fork
    // write. Only a connection-scoped fork-stamp `Replace` (a browser
    // asserting the fork) writes a FRESHER time.
    let root = temp_root("fa-attr-time-fork");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance(
            "claude",
            "parent-id",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            supersedes: Some("parent-id"),
            ..fa_write("claude", "child-id", 5_000)
        })
        .unwrap();
    let child = ledger
        .load_binding("claude", "child-id")
        .expect("child row");
    assert_eq!(
        child.client_instance_id.as_deref(),
        Some("client-1"),
        "stamps inherit (the fork is, by construction, the same pane)"
    );
    assert_eq!(
        child.last_attributed_at,
        Some(1_000),
        "the assertion time inherits too — supersession keeps the parent's \
         true browser-asserted time, never the conn-less fork write's now"
    );
    assert_eq!(
        child.created_at, 5_000,
        "the child row is still BORN at fork time (row-keeping metadata only)"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-ep4-r3 Findings 1+2: attribution is ONE atomic, MONOTONE fact ────
// The stamps+time move TOGETHER, and only from a FULL client+device+tab
// triple whose assertion time is >= the row's current attribution time. An
// older delayed write (assertion captured at message receipt, landing after
// gated/async create work) must never drag the attribution back — and a
// weaker assertion (any stamp half missing — e.g. a legacy client that
// cannot compose tabId) must never touch it at all.

#[test]
fn out_of_order_meaningful_replace_keeps_the_newer_attribution() {
    // Focused-ep4-r3 Finding 1 (terminal body): the row was attributed at T2
    // by the newer create (tab-9), then the T1<T2 delayed write lands at
    // 6_000 — the assertion was captured at ITS message receipt, before the
    // gated/async create work, so it is simply OLDER. The stamps+time stay at
    // T2; the write's OTHER fields still land (it is a real write — the pane
    // moved terminals, the row freshened).
    let root = temp_root("attr-mono-out-of-order");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t1",
            5_000,
            Some("client-2"),
            Some("device-1"),
            Some("device-1:tab-9"),
            5_000,
        ))
        .unwrap();
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t2",
            6_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(
        row.client_instance_id.as_deref(),
        Some("client-2"),
        "an older delayed assertion never re-stamps the client"
    );
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(
        row.tab_key.as_deref(),
        Some("device-1:tab-9"),
        "an older delayed assertion never re-places the pane into its own tab"
    );
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "the attribution time is monotonic in asserted_at — never dragged back"
    );
    assert_eq!(
        row.live_terminal_id.as_deref(),
        Some("t2"),
        "the write's other fields still land (row-keeping is not attribution)"
    );
    assert_eq!(row.updated_at, 6_000, "maintenance freshness still lands");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn equal_time_meaningful_replace_replaces_in_arrival_order() {
    // The exact-tie rule (`>=`): an arriving full-triple assertion AT the
    // row's current time still replaces — deterministic, and the only rule a
    // same-instant re-assertion (re-attach at the receipt moment the row
    // already carries) can satisfy without a tiebreak lottery.
    let root = temp_root("attr-mono-tie");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t1",
            5_000,
            Some("client-2"),
            Some("device-1"),
            Some("device-1:tab-9"),
            5_000,
        ))
        .unwrap();
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t2",
            6_000,
            Some("client-3"),
            Some("device-1"),
            Some("device-1:tab-3"),
            5_000,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-3"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-3"));
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "exact tie: the arriving assertion wins, the time holds"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn later_meaningful_replace_advances_normally() {
    // The keep-side twin: a genuinely NEWER full-triple assertion advances
    // the attribution exactly as before (T3 > T2).
    let root = temp_root("attr-mono-later");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t1",
            5_000,
            Some("client-2"),
            Some("device-1"),
            Some("device-1:tab-9"),
            5_000,
        ))
        .unwrap();
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t2",
            8_000,
            Some("client-3"),
            Some("device-1"),
            Some("device-1:tab-3"),
            7_000,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-3"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-3"));
    assert_eq!(
        row.last_attributed_at,
        Some(7_000),
        "a newer assertion advances"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_out_of_order_replace_keeps_the_newer_attribution() {
    // Focused-ep4-r3 Finding 1, fresh-agent mirror (`:837`): the fresh-agent
    // body's meaningful Replace obeys the same monotonic application — the
    // whole attribution fact (stamps+time) stays at the newer assertion while
    // the write's settings/row-keeping fields still land.
    let root = temp_root("fa-attr-mono-out-of-order");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "opencode",
            "ses_1",
            5_000,
            Some("client-2"),
            Some("device-1"),
            Some("device-1:tab-9"),
            5_000,
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            model: Some("m-late"),
            ..fa_write_provenance_at(
                "opencode",
                "ses_1",
                6_000,
                Some("client-1"),
                Some("device-1"),
                Some("device-1:tab-1"),
                1_000,
            )
        })
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-2"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-9"));
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "the fresh-agent body's attribution is monotonic in asserted_at too"
    );
    assert_eq!(
        row.model.as_deref(),
        Some("m-late"),
        "the settings snapshot still lands — only the attribution is gated"
    );
    assert_eq!(row.updated_at, 6_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn legacy_reassert_missing_tab_never_touches_the_attribution() {
    // Focused-ep4-r3 Finding 2 (terminal body): a LEGACY client that cannot
    // compose a tabId re-asserts client+device ONLY — under the pre-fix
    // predicate (client+device sufficed) that REFRESHED the attribution time
    // while the per-field replace kept the row's old tabKey, laundering
    // freshness onto a stale tab. Attribution advance now requires the FULL
    // triple: the weaker re-assertion updates the row's other fields but
    // leaves stamps+time untouched.
    let root = temp_root("attr-triple-legacy");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    // The legacy re-assert: no tabId on the wire (tab_key None), newer write.
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t2",
            5_000,
            Some("client-legacy"),
            Some("device-1"),
            None,
            5_000,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(
        row.client_instance_id.as_deref(),
        Some("client-1"),
        "a weaker re-assertion does not re-stamp ANY field — the attribution \
         fact is atomic"
    );
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the attribution time is NOT refreshed by a tab-less legacy re-assert"
    );
    assert_eq!(
        row.live_terminal_id.as_deref(),
        Some("t2"),
        "the row's other fields still update"
    );
    assert_eq!(row.updated_at, 5_000);
    // The "full triple ⇒ advances" half: a modern re-assertion (tab present)
    // IS a real attribution.
    ledger
        .record_binding(&write_provenance_at(
            "claude",
            "sess-1",
            "t3",
            6_000,
            Some("client-modern"),
            Some("device-1"),
            Some("device-1:tab-5"),
            6_000,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-modern"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-5"));
    assert_eq!(
        row.last_attributed_at,
        Some(6_000),
        "a full-triple re-assert advances the attribution"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_legacy_reassert_missing_tab_never_touches_the_attribution() {
    // Focused-ep4-r3 Finding 2, fresh-agent mirror: same triple rule in the
    // fresh-agent body — a tab-less re-assert updates the settings and the
    // row-keeping clocks but leaves stamps+time untouched.
    let root = temp_root("fa-attr-triple-legacy");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "codex",
            "ses_1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            model: Some("m-legacy"),
            ..fa_write_provenance_at(
                "codex",
                "ses_1",
                5_000,
                Some("client-legacy"),
                Some("device-1"),
                None,
                5_000,
            )
        })
        .unwrap();
    let row = ledger.load_binding("codex", "ses_1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the fresh-agent body's time is untouched by a tab-less re-assert"
    );
    assert_eq!(
        row.model.as_deref(),
        Some("m-legacy"),
        "settings still land"
    );
    assert_eq!(row.updated_at, 5_000);
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "codex",
            "ses_1",
            6_000,
            Some("client-modern"),
            Some("device-1"),
            Some("device-1:tab-5"),
            6_000,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "ses_1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-modern"));
    assert_eq!(
        row.last_attributed_at,
        Some(6_000),
        "full triple ⇒ advances"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-ep4-r5 Finding 1: provenance ATTACH needs no tab — the full ────
// triple gates only ADVANCE. A legacy client (`freshAgent.create`/
// `freshAgent.fork.tabId` are additive/optional, so older clients omit the
// tab) still composes client+device+assertion-time from its hello identity
// and the message receipt; when NO prior attribution exists (a fresh row, or
// a row whose lanes never stamped one — e.g. a conn-less-spawned fork parent)
// that provenance ATTACHES as-is, tab `None` and all. Without the attach half
// a genuinely-open legacy pane was born with no attribution at all and so was
// unrecoverable wholesale. The atomic+monotone full-triple regime (focused-
// ep4-r3 Findings 1+2) gates only ADVANCING an existing attribution — the
// legacy re-assert pins above stay exactly as they are and stay green.

#[test]
fn legacy_create_attaches_client_device_and_the_assertion_time_without_a_tab() {
    // Terminal body: a legacy client's create carries client+device (its
    // hello identity) and a receipt-time assertion, but no tabKey — the wire
    // field is additive/optional. On a FRESH row that weaker value ATTACHES
    // (there is no prior attribution to preserve or advance): the row records
    // exactly what the provenance asserts — client+device+the assertion time,
    // tab None.
    let root = temp_root("attr-attach-legacy-create");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "sess-1",
            "t1",
            1_000,
            Some("client-legacy"),
            Some("device-1"),
            None,
            1_000,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "sess-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-legacy"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(
        row.tab_key, None,
        "the legacy client never composed a tab: attach records what exists, nothing more"
    );
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the assertion time attaches with the stamps"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_legacy_create_and_fork_attach_their_provenance_without_a_tab() {
    // The finding's exact lane (fresh-agent body): `FreshAgentFork.tab_id` is
    // additive/optional, so a legacy client create/fork composes
    // client+device+the receipt-time assertion and NO tab.
    //  * create arm — a fresh row attaches the weaker value;
    //  * fork arm — the fork-chain first write (no same-key row) attaches the
    //    child even though an `inherit` source exists: the conn-less-spawned
    //    parent was never attributed (its `Inherit` write asserted nothing),
    //    so there is NO prior attribution to preserve or advance.
    let root = temp_root("attr-attach-fa-legacy");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "opencode",
            "ses_1",
            1_000,
            Some("client-legacy"),
            Some("device-1"),
            None,
            1_000,
        ))
        .unwrap();
    let created = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(created.client_instance_id.as_deref(), Some("client-legacy"));
    assert_eq!(created.device_id.as_deref(), Some("device-1"));
    assert_eq!(created.tab_key, None);
    assert_eq!(created.last_attributed_at, Some(1_000));
    // Fork arm: the never-attributed parent (a conn-less `Inherit` write on a
    // fresh row asserts nothing), then the legacy fork binding the child.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "ses_parent", 500))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            supersedes: Some("ses_parent"),
            ..fa_write_provenance_at(
                "claude",
                "ses_child",
                2_000,
                Some("client-legacy"),
                Some("device-1"),
                None,
                2_000,
            )
        })
        .unwrap();
    let child = ledger.load_binding("claude", "ses_child").unwrap();
    assert_eq!(child.client_instance_id.as_deref(), Some("client-legacy"));
    assert_eq!(child.device_id.as_deref(), Some("device-1"));
    assert_eq!(child.tab_key, None);
    assert_eq!(
        child.last_attributed_at,
        Some(2_000),
        "the fork child's row attaches the legacy provenance (the parent had none to preserve)"
    );
    assert_eq!(
        ledger
            .load_binding("claude", "ses_parent")
            .unwrap()
            .last_attributed_at,
        None,
        "the conn-less-spawned (never-stamped) parent stays attribution-less"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn legacy_marker_resolution_attaches_client_device_when_no_prior_attribution_exists() {
    // The marker lane rides the SAME attach rule: a legacy client's
    // connection-scoped create records client+device (+the assertion) on the
    // pending marker (no tabKey composed), and the conn-less identity
    // resolution derives the origin lane's `Replace` from it. With no prior
    // attribution that derived (weaker) provenance ATTACHES — the row is no
    // longer born attribution-less.
    let root = temp_root("attr-attach-marker-legacy");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-legacy"),
                device_id: Some("device-1"),
                tab_key: None,
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-legacy"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "the marker-derived attach attributes at the marker's assertion, not the resolve"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-ep4-r5 Finding 2: `Clear` RAISES the attribution floor — it ────
// never erases it. Erasing the time let a DELAYED pre-`Clear` assertion pass
// the absent-prior-time arm and resurrect the cleared stamps wholesale. The
// row's `last_attributed_at` after a `Clear` is `max(existing, clear_now)`;
// the identity stamps still clear, and the row stays unofferable while they
// are `None` (the D8 judgment gates on the stamps first). The monotonic
// compare then rejects the delayed assertion exactly like any other older
// one.

#[test]
fn clear_raises_the_attribution_floor_so_a_delayed_pre_clear_assertion_never_resurrects_the_stamps()
{
    // Terminal body: browser-stamped row, a headless Clear, then the delayed
    // gated create whose provenance was captured BEFORE the Clear landing
    // after it.
    let root = temp_root("attr-clear-floor");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "sess-1",
            "t1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    ledger
        .record_binding(&write_with_policy(
            "codex",
            "sess-1",
            "t2",
            5_000,
            ProvenancePolicy::Clear,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "sess-1").unwrap();
    assert_eq!(
        row.client_instance_id, None,
        "Clear still erases the identity stamps"
    );
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "Clear RAISES the attribution floor (max(existing, clear_now)), never erases it"
    );
    // The assertion captured at 4_000 — BEFORE the Clear — lands at 6_000:
    // the floor rejects it exactly like any older assertion.
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "sess-1",
            "t3",
            6_000,
            Some("client-stale"),
            Some("device-1"),
            Some("device-1:tab-9"),
            4_000,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "sess-1").unwrap();
    assert_eq!(
        row.client_instance_id, None,
        "a delayed pre-Clear assertion never resurrects the cleared stamps"
    );
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(row.last_attributed_at, Some(5_000), "the floor holds");
    assert_eq!(
        row.live_terminal_id.as_deref(),
        Some("t3"),
        "the write's other fields still land (row-keeping is not attribution)"
    );
    assert_eq!(row.updated_at, 6_000);
    // A genuinely POST-clear assertion is simply newer: it advances normally.
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "sess-1",
            "t4",
            7_000,
            Some("client-live"),
            Some("device-1"),
            Some("device-1:tab-7"),
            6_000,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "sess-1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-live"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-7"));
    assert_eq!(
        row.last_attributed_at,
        Some(6_000),
        "a post-clear assertion attaches/advances normally"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_clear_raises_the_attribution_floor_against_delayed_pre_clear_assertions() {
    // Fresh-agent mirror (the body's Clear arm + the inherit-sourced floor):
    // same floor-raise, same delayed-assertion rejection, with the settings
    // snapshot still landing on every write.
    let root = temp_root("fa-attr-clear-floor");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "opencode",
            "ses_1",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            1_000,
        ))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provenance: ProvenancePolicy::Clear,
            ..fa_write("opencode", "ses_1", 5_000)
        })
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(row.client_instance_id, None);
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "the floor rises to the clear"
    );
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            model: Some("m-stale"),
            ..fa_write_provenance_at(
                "opencode",
                "ses_1",
                6_000,
                Some("client-stale"),
                Some("device-1"),
                Some("device-1:tab-9"),
                4_000,
            )
        })
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(
        row.client_instance_id, None,
        "a delayed pre-Clear assertion never resurrects the cleared stamps"
    );
    assert_eq!(row.last_attributed_at, Some(5_000), "the floor holds");
    assert_eq!(
        row.model.as_deref(),
        Some("m-stale"),
        "the settings snapshot still lands — only the attribution is gated"
    );
    assert_eq!(row.updated_at, 6_000);
    ledger
        .record_fresh_agent_binding(&fa_write_provenance_at(
            "opencode",
            "ses_1",
            7_000,
            Some("client-live"),
            Some("device-1"),
            Some("device-1:tab-7"),
            6_000,
        ))
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_1").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-live"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-7"));
    assert_eq!(
        row.last_attributed_at,
        Some(6_000),
        "a post-clear assertion advances"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn marker_sourced_resolution_never_drags_a_newer_attribution_back() {
    // Focused-ep4-r3 Finding 1, marker arm — CLOSES the ep4-r2 documented
    // residual ("a marker-sourced SET still overwrites a later genuine
    // attribution"): an existing row attributed at 5_000 (a live connection's
    // newer re-assert) is resolved onto by a stamped marker whose pane was
    // asserted at 1_000. The resolution's derived stamps are the OLDER
    // assertion, so the row keeps its 5_000 attribution.
    let root = temp_root("attr-mono-marker");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance_at(
            "codex",
            "th-1",
            "t-live",
            5_000,
            Some("client-2"),
            Some("device-1"),
            Some("device-1:tab-9"),
            5_000,
        ))
        .unwrap();
    ledger
        .record_pending(
            "t-marker",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-1"),
                device_id: Some("device-1"),
                tab_key: Some("device-1:tab-1"),
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    // The conn-less resolution lane's exact write shape (`Inherit`).
    ledger
        .resolve_pending(&write("codex", "th-1", "t-marker", 6_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-2"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-9"));
    assert_eq!(
        row.last_attributed_at,
        Some(5_000),
        "the marker carries the OLDER assertion — the row's newer attribution \
         survives the resolution"
    );
    assert!(
        ledger.list_pending_raw().is_empty(),
        "the marker is still consumed (resolution itself is unchanged)"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn record_binding_roundtrips_all_fields() {
    let root = temp_root("roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .expect("write ok");
    let row = ledger.load_binding("claude", "sess-a").expect("row exists");
    assert_eq!(row.ledger_version, LEDGER_VERSION);
    assert_eq!(row.provider, "claude");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(row.mode, "claude");
    assert_eq!(row.cwd.as_deref(), Some("/tmp/proj"));
    assert_eq!(row.live_terminal_id.as_deref(), Some("t1"));
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 1_000);
    assert_eq!(row.last_observed_at, 1_000);
    assert_eq!(
        row.last_attributed_at, None,
        "a conn-less (Inherit) write attributes nothing — no attribution time"
    );
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    assert_eq!(row.superseded_by, None);
    assert!(ledger.ever_bound("claude", "sess-a"));
    assert!(!ledger.ever_bound("claude", "sess-other"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rewrite_preserves_created_at_and_bumps_updated_at() {
    let root = temp_root("rewrite");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 5_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 5_000);
    assert_eq!(row.last_observed_at, 5_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn disabled_ledger_is_a_silent_noop() {
    let ledger = PaneLedger::disabled();
    ledger
        .record_binding(&write("claude", "s", "t", 1))
        .expect("noop ok");
    assert_eq!(ledger.load_binding("claude", "s"), None);
    assert!(!ledger.ever_bound("claude", "s"));
    assert!(ledger.list_bindings().is_empty());
}

/// kata 1wxv delta-r1 F4 (disabled-mode honesty, durable-BEFORE-mutation): the
/// ONE write the disabled ledger must REFUSE is the rollback-record row — a
/// false "durable" answer would let providers destructively mutate history with
/// no surviving markers. Every OTHER write keeps its silent no-op policy (the
/// binding/pending identity lanes degrade gracefully).
#[test]
fn disabled_ledger_refuses_the_rollback_row_write_with_a_loud_error() {
    let ledger = PaneLedger::disabled();
    let payload = serde_json::json!({"version": 1, "entries": []});
    let err = ledger
        .record_rollback_row("claude", "sid", &payload, 1)
        .expect_err("a disabled ledger must never report a rollback 'durable' write as Ok");
    assert_eq!(err.kind(), std::io::ErrorKind::Other);
    assert!(
        err.to_string().contains("ledger DISABLED"),
        "the error names the disabled mode: {err}"
    );
    // Nothing was insta-indexed either.
    assert!(
        ledger.load_rollback_row("claude", "sid").is_none(),
        "a refused write lands nowhere"
    );
    // The other lanes keep their existing disabled policy (silent no-op).
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "claude",
            session_id: "sid",
            mode: "freshclaude",
            cwd: None,
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1,
        })
        .expect("binding writes keep their silent-no-op policy on a disabled ledger");
    ledger
        .record_pending(
            "ph",
            "freshclaude",
            None,
            None,
            ProvenanceStamps::default(),
            1,
        )
        .expect("pending writes keep their silent-no-op policy on a disabled ledger");
    ledger
        .delete_rollback_row("claude", "sid")
        .expect("a delete of a row that cannot exist stays a no-op");
}

#[test]
fn writes_are_atomic_sibling_temp_plus_rename() {
    // After a successful write no *.tmp-* residue remains, and the row file
    // is a direct child of bindings/<provider>/.
    let root = temp_root("atomic");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .unwrap();
    let provider_dir = root.join("bindings").join("claude");
    let entries: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["sess-a.json".to_string()]);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn key_encoding_is_path_safe_and_injective() {
    assert_eq!(encode_segment("claude"), "claude");
    assert_eq!(
        encode_segment("11111111-2222-3333-4444-555555555555"),
        "11111111-2222-3333-4444-555555555555"
    );
    assert_eq!(encode_segment("a/b"), "a%2Fb");
    assert_eq!(encode_segment("a%b"), "a%25b");
    assert_eq!(encode_segment(".."), "%2E%2E");
    assert_eq!(encode_segment("."), "%2E");
    assert_eq!(encode_segment(""), "%00");
    // Injective: distinct inputs never collide after encoding.
    assert_ne!(encode_segment("a/b"), encode_segment("a%2Fb"));
}

#[test]
fn index_loads_existing_rows_at_construction() {
    // The write-through index is seeded by ONE directory scan in new()
    // (V1.md read policy); a second instance over the same dir answers
    // from its own fresh load — the restart-equivalent shape.
    let root = temp_root("index-reload");
    {
        let gen1 = PaneLedger::new(Some(root.clone()));
        gen1.record_binding(&write("claude", "sess-a", "t1", 1_000))
            .unwrap();
    }
    let gen2 = PaneLedger::new(Some(root.clone()));
    assert!(gen2.ever_bound("claude", "sess-a"));
    assert_eq!(gen2.list_bindings().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

// ── tracing capture for the lock test's failure classification (delta-r2 M2) ──
//
// Adapted from the LogCapture/Visitor pattern in
// tests/pane_reconcile_freshagent.rs (~:761-845). Thread-local capture is
// sufficient HERE (no tokio involved): `new_locked` logs
// `pane_ledger_lock_unavailable` SYNCHRONOUSLY on the construction thread
// (pane_ledger.rs:248-254), and the `#[test]` body IS the construction
// thread, so a `tracing::subscriber::set_default` guard scopes the capture
// layer to exactly this thread. cfg(unix): the only consumer is the
// cfg(unix) lock test below.
#[cfg(unix)]
mod lock_log_capture {
    use std::sync::{Arc, Mutex};

    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;

    #[derive(Debug, Clone, Default)]
    pub struct CapturedEvent {
        pub message: String,
        /// The event's OWN fields (the lock-unavailable log records root +
        /// error on the event; no span merge needed).
        pub fields: std::collections::BTreeMap<String, String>,
    }

    #[derive(Default)]
    struct CapVisitor {
        message: String,
        fields: std::collections::BTreeMap<String, String>,
    }

    impl Visit for CapVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            let rendered = format!("{value:?}");
            if field.name() == "message" {
                self.message = rendered;
            } else {
                self.fields.insert(field.name().to_string(), rendered);
            }
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.message = value.to_string();
            } else {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }
    }

    struct LogCapture {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl<S> Layer<S> for LogCapture
    where
        S: Subscriber,
    {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = CapVisitor::default();
            event.record(&mut visitor);
            self.events
                .lock()
                .expect("capture lock")
                .push(CapturedEvent {
                    message: visitor.message,
                    fields: visitor.fields,
                });
        }
    }

    /// Install the thread-local capture layer; the returned guard restores the
    /// previous default dispatcher on drop.
    pub fn lock_failure_capture() -> (
        Arc<Mutex<Vec<CapturedEvent>>>,
        tracing::subscriber::DefaultGuard,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let layer = LogCapture {
            events: Arc::clone(&events),
        };
        let subscriber = tracing_subscriber::registry().with(layer);
        let guard = tracing::subscriber::set_default(subscriber);
        (events, guard)
    }
}

#[cfg(unix)]
#[test]
fn new_locked_degrades_to_disabled_when_another_holder_exists() {
    // Single-writer guard (V2.md): never two writers on one store. The
    // second locked construction logs a loud ERROR and comes up DISABLED;
    // dropping the holder frees the flock (kernel-released on death too).
    //
    // DEFLAKE (f3wp): this test flaked >=4 times under `cargo test
    // --workspace` load (fossils: /tmp/pane-ledger-test-lock-*-13; history:
    // docs/plans/2026-07-26-sidebar-registry-sync.md:1192-1207). Every fossil
    // held a complete durably-written s1.json, so the failure was the THIRD
    // constructor coming up blind -- and the errno that would name the
    // mechanism (EWOULDBLOCK: flock genuinely held, vs ENOSPC/EMFILE:
    // resource pressure, vs a silently-empty load_index) was dropped because
    // this binary installs no tracing subscriber. Per C1's reasoning we did
    // NOT retry-mask; instead every assertion below carries the on-disk and
    // errno evidence needed to diagnose the next occurrence on sight.
    //
    // DEFLAKE-2 (the-usual test-flake-hardening): the proven flake signature
    // is errno=11 EWOULDBLOCK at the re-acquire after `drop(holder)`: the
    // dropped holder's flock can remain kernel-held for a tick, and
    // `new_locked` swallows the errno into a DISABLED ledger
    // (pane_ledger.rs:1374-1384). The one-shot probe-2 acquire (which panicked
    // on exactly that signature) and the third construction are therefore
    // REPLACED by one bounded wait whose RETRY UNIT is the third construction
    // itself, with a TWO-BRANCH diagnosis per failed construction keyed on
    // `candidate.is_enabled()` (pane_ledger.rs:1447 — false only when the
    // candidate's own lock acquisition FAILED):
    //  - ENABLED but blind (the candidate holds the flock yet cannot see
    //    s1.json — load_index swallowed an I/O error, H2): panic
    //    IMMEDIATELY, never probed and never retried. A probe cannot
    //    diagnose this branch at all — it would misread the candidate's
    //    OWN still-held lock as the transient EWOULDBLOCK, and the
    //    resulting retry would silently mask the exact H2 regression C1
    //    requires to fail loudly.
    //  - DISABLED (the candidate's lock acquisition failed): classify from
    //    the `pane_ledger_lock_unavailable` tracing event captured AT the
    //    failure instant on this thread (`new_locked` logs it synchronously
    //    with the io error's Display string, pane_ledger.rs:248-254) —
    //    retry ONLY when the captured error text shows the proven transient
    //    ("os error 11" in EWOULDBLOCK's Display); ANY other captured error
    //    text panics immediately with it; NO captured event panics
    //    immediately (the disabled path failed to log the expected event —
    //    a third, real signal); budget expiry panics naming the last
    //    captured error text. A follow-up acquire_store_lock probe CANNOT
    //    classify the errno `new_locked` swallowed (delta-review r2 M2):
    //    the drop→probe window lets a released-holder probe succeed and
    //    mislabel the transient as H2, so NO probe calls remain — the
    //    transient loop is classified ONLY by evidence captured at the
    //    exact failure instant.
    // The loser-construction property and the on-disk evidence probe stay
    // one-shot and untouched — the C1 no-retry-masking decision holds for
    // everything the wait does not cover.
    // s52d addendum: production now absorbs this transient class — acquisition retries
    // EWOULDBLOCK-only on a fixed budget (LOCK_RETRY_MAX_ATTEMPTS / LOCK_RETRY_DELAY_MS,
    // pane_ledger.rs:150-152), so the DISABLED branch below first requires contention
    // that outlives the production ~275ms budget; persistent failures still panic with
    // full evidence (and the budget-expiry assert below now reports the /proc/locks
    // holder pid for this lock file — the s52d holder-identity deliverable).
    let root = temp_root("lock");
    let holder = PaneLedger::new_locked(Some(root.clone()));
    holder
        .record_binding(&write("claude", "s1", "t1", 1))
        .unwrap();
    let loser = PaneLedger::new_locked(Some(root.clone()));
    loser
        .record_binding(&write("claude", "s2", "t2", 2))
        .expect("disabled no-op");
    assert!(!loser.ever_bound("claude", "s2"), "loser is disabled");
    drop(holder);

    // Evidence probe 1: the on-disk truth the fossils always showed.
    let s1_on_disk = root
        .join("bindings")
        .join("claude")
        .join("s1.json")
        .exists();
    assert!(
        s1_on_disk,
        "holder's s1.json must be durably on disk before the re-acquire"
    );

    // Bounded wait whose retry UNIT is the third construction itself. Each
    // failed construction takes ONE of two branches keyed on
    // `candidate.is_enabled()`:
    //  - ENABLED but blind — the candidate holds the flock itself yet cannot
    //    see s1.json: fail IMMEDIATELY, never probed and never retried (a
    //    probe could misread the candidate's OWN lock as the benign
    //    EWOULDBLOCK transient and silently retry an H2 regression).
    //  - DISABLED — the candidate's lock acquisition failed: classify from
    //    the `pane_ledger_lock_unavailable` event the thread-local capture
    //    collected AT that failure instant — retry ONLY when the captured
    //    error text shows the proven flake signature (EWOULDBLOCK: flock
    //    still vapor-held after the holder's drop; its io Display contains
    //    "os error 11"); ANY other captured error text fails immediately
    //    with it; NO captured event fails immediately (the disabled path
    //    did not log the expected event — a third, real signal); budget
    //    expiry panics naming the last captured error text. NO
    //    acquire_store_lock probe calls remain (delta-review r2 M2: the
    //    drop→probe window could mislabel a released-holder transient as
    //    H2).
    // The loser-construction property above and the on-disk probe stay
    // one-shot and untouched.
    let (events, _trace_guard) = lock_log_capture::lock_failure_capture();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    // libc supplies EWOULDBLOCK's portable errno value (11 on Linux, 35 on
    // macOS), so the marker is derived from the compiled constant, not a literal.
    let would_block_marker = format!("(os error {})", libc::EWOULDBLOCK);
    // `next` is intentionally unused: the bounded wait's success IS the
    // assertion (a bare `next` binding would trip the repo's -D warnings gate);
    // the name documents that the loop value is the third construction.
    let _next = loop {
        let seen_before = events.lock().expect("capture lock").len();
        let candidate = PaneLedger::new_locked(Some(root.clone()));
        if candidate.ever_bound("claude", "s1") {
            break candidate;
        }
        // Branch 1 — ENABLED yet blind: the candidate ITSELF holds the flock
        // (the lock WAS free / was acquired by us) and s1.json is confirmed
        // on disk, so load_index swallowed an I/O error. This is the
        // provisional-final H2 shape: panic NOW — do NOT probe (the probe
        // could read our own lock as the transient EWOULDBLOCK) and do NOT
        // drop-and-retry (C1 no-retry-masking).
        if candidate.is_enabled() {
            panic!(
                "third new_locked came up ENABLED yet BLIND — the candidate \
                 itself holds the flock (lock WAS free/held by us) and \
                 s1.json is confirmed on disk by the on-disk probe above, so \
                 load_index swallowed an I/O error (H2, pane_ledger.rs:1583) \
                 — provisional-final, never retried"
            );
        }
        // Branch 2 — DISABLED: the candidate's lock acquisition failed, so
        // it holds nothing — and `new_locked` logged the failure
        // synchronously on THIS thread. Classify from THAT captured event
        // (never a later probe call).
        drop(candidate);
        // delta-r5 (finding 2): capture the first lock- OR scan-unavailable
        // event — after qzka's 9a3d74e09 lands, `new_locked` can also come up
        // DISABLED via the construction scan fault
        // (`pane_ledger_scan_unavailable`) while HOLDING the flock; that shape
        // must be named with its captured fields, never fall through to the
        // generic not-captured branch.
        let captured = {
            let log = events.lock().expect("capture lock");
            log[seen_before..]
                .iter()
                .find(|e| {
                    e.message.contains("pane_ledger_lock_unavailable")
                        || e.message.contains("pane_ledger_scan_unavailable")
                })
                .cloned()
        };
        match captured {
            // UNREACHABLE until qzka's 9a3d74e09 lands — today's pane_ledger.rs
            // logs ONLY pane_ledger_lock_unavailable, so no test targets this
            // arm today by design (delta-review r5 finding 2).
            Some(evt) if evt.message.contains("pane_ledger_scan_unavailable") => panic!(
                "candidate DISABLED via scan fault (pane_ledger_scan_unavailable): \
                 the construction scan failed under the HELD flock — the qzka \
                 scan-fault shape, NOT the EWOULDBLOCK lock transient; never \
                 retried; captured fields: {:?}",
                evt.fields
            ),
            // The proven flake signature: flock still vapor-held after the
            // holder's drop (EWOULDBLOCK's io error Display contains
            // "os error 11").
            Some(evt)
                if evt
                    .fields
                    .get("error")
                    .is_some_and(|e| e.contains(&would_block_marker)) =>
            {
                let err_text = evt.fields.get("error").cloned().unwrap_or_default();
                assert!(
                    std::time::Instant::now() < deadline,
                    "flock still EWOULDBLOCK after the 10s bounded wait — the \
                     proven flake signature persisted past the wait; last \
                     captured lock failure: {err_text}; holder report \
                     (/proc/locks names the LOCKING tgid — an inheritance-\
                     window transient reports THIS test process's own pid, a \
                     foreign holder reports a foreign pid): {} (fossils \
                     family: pane-ledger-test-lock-*)",
                    lock_holder_report(&root.join("lock"))
                );
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Some(evt) => panic!(
                "third new_locked came up DISABLED with a non-transient lock \
                 failure captured at the failure instant: {} \
                 (ENOSPC/EMFILE/EACCES => resource pressure, H1)",
                evt.fields.get("error").cloned().unwrap_or_default()
            ),
            None => panic!(
                "third new_locked came up DISABLED but neither the \
                 pane_ledger_lock_unavailable nor the pane_ledger_scan_unavailable \
                 event was captured — the disabled path did not log the failure \
                 (a third, real signal)"
            ),
        }
    };
    // The loop above breaks only when the third construction sees the binding —
    // the old trailing `assert!(next.ever_bound(...))` is subsumed by the loop's
    // success criterion and is removed (it would have been unreachable).
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn acquire_retries_through_a_transient_holder_release() {
    // H1 root-cause class: with LOCK_NB a single-shot acquire fails inside a
    // transient holder window (e.g. a forked child still carrying a dup of
    // the lock fd pre-exec). Production acquisition must ABSORB a window that
    // releases well inside the retry budget: the holder is dropped 50ms after
    // construction starts, far below the worst-case budget (~275ms).
    // Margin math: 50ms dropper vs ~275ms budget tolerates ~225ms of
    // scheduling overshoot (N4, proven structurally) — do NOT "tighten" the
    // 50ms toward the budget; that would reintroduce flakiness.
    let root = temp_root("lock-retry");
    let holder = PaneLedger::new_locked(Some(root.clone()));
    let rehome = root.clone();
    let dropper = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(holder);
    });
    let started = std::time::Instant::now();
    let candidate = PaneLedger::new_locked(Some(rehome));
    dropper.join().unwrap();
    assert!(
        candidate.is_enabled(),
        "bounded retry must absorb a transient holder window; ledger came up DISABLED"
    );
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(50),
        "acquisition must wait for the real holder release, not race past it"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn persistent_contention_still_degrades_disabled_within_a_bounded_budget() {
    // The single-writer contract is unchanged: a REAL second writer never
    // acquires. The retry budget only bounds degradation latency (~0.3s),
    // it never masks persistent contention.
    let root = temp_root("lock-persist");
    let _holder = PaneLedger::new_locked(Some(root.clone()));
    let started = std::time::Instant::now();
    let loser = PaneLedger::new_locked(Some(root.clone()));
    assert!(
        !loser.is_enabled(),
        "a persistent holder must still degrade"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "degradation is bounded by the fixed retry budget, never a spin"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn secondary_index_reads_by_terminal_and_request_id() {
    let root = temp_root("secondary");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-9", "t2", 2_000))
        .unwrap();
    let sref = ledger
        .bound_session_ref_for_terminal("t1")
        .expect("t1 bound");
    assert_eq!(sref.provider, "claude");
    assert_eq!(sref.session_id, "sess-a");
    assert_eq!(ledger.bound_session_ref_for_terminal("t-missing"), None);
    let row = ledger
        .lookup_by_create_request_id("claude", "req-1")
        .expect("by request id");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(
        ledger.lookup_by_create_request_id("claude", "req-none"),
        None
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_retires_old_row() {
    // Red test `rebind-retires-old-row` (spec §4.2 G3): a pane's binding
    // legitimately moves -> the writer retires the old row and writes the
    // new one; the old row records WHERE identity went.
    let root = temp_root("rebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-old", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-new", "t1", 2_000))
        .unwrap();

    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    let by = old.superseded_by.expect("supersededBy set");
    assert_eq!(by.provider, "codex");
    assert_eq!(by.session_id, "th-new");

    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    assert_eq!(new.live_terminal_id.as_deref(), Some("t1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn client_claims_superseded_ref_is_answered_from_the_chain_terminus() {
    // Red test `client-claims-superseded-ref` (ledger-API level; full
    // verdict wiring is Phase 3): a lookup for a superseded ref follows
    // `supersededBy` to the live bound row and reports corrected:true —
    // never returns the retired row as the answer.
    let root = temp_root("chain");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-2", "t1", 2_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-3", "t1", 3_000))
        .unwrap();

    let hit = ledger.lookup_by_session("codex", "th-1").expect("resolves");
    assert!(hit.corrected);
    assert_eq!(hit.row.session_id, "th-3");
    assert_eq!(hit.row.state, RowState::Bound);

    // A direct claim of the live terminus is NOT a correction.
    let direct = ledger.lookup_by_session("codex", "th-3").unwrap();
    assert!(!direct.corrected);

    // A retired row with no successor (e.g. closed) is returned as-is so
    // callers can apply their own reader rule — but never invents a bound.
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn pending_marker_roundtrips_and_reader_rule_prefers_binding() {
    let root = temp_root("pending");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "opencode",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    let marker = ledger.pending_for_terminal("t1").expect("marker readable");
    assert_eq!(marker.terminal_id, "t1");
    assert_eq!(marker.mode, "opencode");
    assert_eq!(marker.cwd.as_deref(), Some("/tmp/p"));
    assert_eq!(marker.spawned_at, 1_000);

    // Reader rule (spec §4.2): "binding row wins; a marker whose terminalId
    // already has a binding row is stale."
    ledger
        .record_binding(&write("opencode", "ses-1", "t1", 2_000))
        .unwrap();
    assert_eq!(ledger.pending_for_terminal("t1"), None);
    // The raw file still exists until the boot sweep (Task 4) removes it.
    assert_eq!(ledger.list_pending_raw().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_writes_binding_first_then_deletes_marker() {
    let root = temp_root("resolve");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    assert!(ledger.load_binding("codex", "th-1").is_some());
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn resolve_pending_marker_delete_failure_is_not_a_durability_error() {
    // The binding row (the durable identity) was written — a failed marker
    // delete is cleanup residue the boot sweep repairs, NOT a durability
    // failure. resolve_pending must return Ok(()) (logging at WARN), so the
    // caller never raises a false `durability.degraded` alarm.
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("marker-delete-fails");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    // Make the pending dir read-only so the marker unlink fails (EACCES).
    let pending_dir = root.join("pending");
    std::fs::set_permissions(&pending_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = ledger.resolve_pending(&write("codex", "th-1", "t1", 2_000));
    // Restore perms before asserting so cleanup always works.
    std::fs::set_permissions(&pending_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    result.expect("binding written durably; marker-delete failure must not propagate");
    // The durable identity IS recorded...
    assert!(ledger.load_binding("codex", "th-1").is_some());
    // ...and the stale marker survives (on disk and in the index) for the
    // boot sweep to repair.
    assert!(pending_dir.join("t1.json").exists());
    assert_eq!(ledger.list_pending_raw().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn pending_resolution_collision_is_idempotent() {
    // Red test `pending-resolution-collision` (spec §4.2 / decision 5): a
    // second racing resolution for the same terminalId finds the marker
    // gone or already-bound and no-ops — one binding row, no error.
    let root = temp_root("collision");
    let ledger = std::sync::Arc::new(PaneLedger::new(Some(root.clone())));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();

    // Sequential double-resolution.
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_001))
        .expect("second resolve no-ops");
    assert_eq!(
        ledger
            .list_bindings()
            .iter()
            .filter(|r| r.session_id == "th-1")
            .count(),
        1
    );

    // Concurrent resolution from two threads (the actual race shape).
    ledger
        .record_pending(
            "t2",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            3_000,
        )
        .unwrap();
    let a = std::sync::Arc::clone(&ledger);
    let b = std::sync::Arc::clone(&ledger);
    let ha = std::thread::spawn(move || a.resolve_pending(&write("codex", "th-2", "t2", 3_001)));
    let hb = std::thread::spawn(move || b.resolve_pending(&write("codex", "th-2", "t2", 3_002)));
    ha.join().unwrap().expect("racer A ok");
    hb.join().unwrap().expect("racer B ok");
    assert_eq!(
        ledger
            .list_bindings()
            .iter()
            .filter(|r| r.session_id == "th-2")
            .count(),
        1
    );
    assert!(ledger.pending_for_terminal("t2").is_none());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_sources_provenance_from_the_consumed_marker() {
    // Delta-r3 Finding 2 (the keep-side hole mirroring the original
    // over-offer bug): a dynamically-identified CLI pane (codex/opencode/
    // amplifier — no pre-spawn binding; only claude preallocates) leaves the
    // conn-less resolution hook (`ledger_resolve_identity`, `Inherit`) with
    // NO existing row to inherit FROM, so the spawn-time marker's stamps are
    // the only attribution that survives until the provider resolves the
    // session id. Resolution must write the binding row stamped FROM the
    // consumed marker — otherwise the D8 judgment rejects the row and a
    // genuinely-open CLI pane lost before the next snapshot is never offered.
    let root = temp_root("resolve-marker-prov");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-1"),
                device_id: Some("device-1"),
                tab_key: Some("device-1:tab-1"),
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    // The conn-less lane's exact write shape (`Inherit`).
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    assert_eq!(
        row.last_attributed_at,
        Some(1_000),
        "delta-r4 Finding 1 + focused-ep4 Finding: the marker-derived \
         application attributes at the marker's spawn, not the resolve"
    );
    assert!(
        ledger.list_pending_raw().is_empty(),
        "the marker was consumed (binding-first order)"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_prefers_the_resolve_calls_own_provenance_over_the_markers() {
    // Precedence, arm 1: a resolution that KNOWS fresher provenance
    // (`Replace`) asserts it — the consumed marker's spawn-time stamps never
    // pin a staler attribution in place.
    let root = temp_root("resolve-prefers-own");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-marker"),
                device_id: Some("device-marker"),
                tab_key: Some("device-marker:tab-marker"),
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write_provenance(
            "codex",
            "th-1",
            "t1",
            2_000,
            Some("client-resolve"),
            Some("device-resolve"),
            Some("device-resolve:tab-resolve"),
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-resolve"));
    assert_eq!(row.device_id.as_deref(), Some("device-resolve"));
    assert_eq!(row.tab_key.as_deref(), Some("device-resolve:tab-resolve"));
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "focused-ep4 Finding, keep side: a resolution asserting FRESH \
         connection provenance attributes at the resolve's own time — the \
         marker-time rule applies only when the stamps COME from the marker"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_from_a_partial_marker_leaves_the_attribution_untouched() {
    // Precedence, arm 2 (focused-ep4-r3 Finding 2 flip, renamed from
    // `resolve_pending_merges_marker_stamps_fieldwise_over_the_existing_row`):
    // a partially-stamped marker — e.g. a hello that carried
    // `clientInstanceId` but no `deviceId`, so `tabKey` never composed —
    // derives an INCOMPLETE triple, and the attribution fact is atomic: the
    // resolution leaves the EXISTING row's stamps+time untouched instead of
    // mixing marker and row stamps into a combination no single browser
    // assertion ever made (a session id previously bound from another pane
    // can already carry stamps when a fresh pane resolves to it).
    let root = temp_root("resolve-fieldwise");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t-prev",
            500,
            Some("client-old"),
            Some("device-old"),
            Some("device-old:tab-old"),
        ))
        .unwrap();
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-new"),
                device_id: None,
                tab_key: None,
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(
        row.client_instance_id.as_deref(),
        Some("client-old"),
        "a partial marker does not piecemeal-stamp the row"
    );
    assert_eq!(row.device_id.as_deref(), Some("device-old"));
    assert_eq!(row.tab_key.as_deref(), Some("device-old:tab-old"));
    assert_eq!(
        row.last_attributed_at,
        Some(500),
        "the attribution time is untouched too"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_from_a_headless_origin_stays_unattributed() {
    // Precedence, arm 3: the REST/headless lineage binder writes markers
    // WITHOUT stamps (`ProvenanceStamps::default()`), so a resolution whose
    // origin is headless still ends unattributed — the D8 judgment correctly
    // never offers the row. Focused-ep3-r2 Finding 2: an unstamped marker
    // derives `Clear`; with NO existing row there are no stamps to erase —
    // and (focused-ep4-r5 Finding 2) the derived `Clear` still raises the
    // attribution FLOOR to its own time, which never makes the row offerable
    // (the judgment gates on the stamps first) but does reject any delayed
    // pre-Clear assertion arriving later.
    let root = temp_root("resolve-headless");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id, None);
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "focused-ep4-r5 Finding 2: the headless resolution floors the attribution \
         clock at its own time even with no prior attribution — the stamps stay \
         None, so the row is never offered"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_from_a_headless_origin_clears_a_previously_stamped_row() {
    // Focused-ep3-r2 Finding 2 — the delta-r2 laundering class THROUGH the
    // marker transition: a Bound row stamped by a browser create, later
    // resolved onto by a dynamically-identified HEADLESS (REST/headless
    // lineage) terminal. The origin lane's pending marker is UNSTAMPED by
    // design (`pane_identity_binder.rs` passes `ProvenanceStamps::default()`
    // — its policy is `Clear`, exactly its binding-write policy), and the
    // resolution must honor that: stamps → `None` regardless of the marker
    // and regardless of the EXISTING row. Keeping them would attribute the
    // refreshed row to a stale browser parent, so the D8 grace judgment
    // would offer a session that was not open. Routed exactly the way
    // production reaches it: the conn-less `ledger_resolve_identity` hook's
    // write shape (`Inherit` + a create-time marker).
    let root = temp_root("resolve-headless-clears");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t-browser",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .expect("seed the browser-stamped row");
    ledger
        .record_pending(
            "t-rest",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(), // the headless binder's exact marker shape
            1_500,
        )
        .unwrap();
    ledger
        .resolve_pending(&write("codex", "th-1", "t-rest", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(
        row.client_instance_id, None,
        "a headless-origin resolution CLEARS the stale browser clientInstanceId"
    );
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "focused-ep4-r5 Finding 2: the derived Clear raises the attribution \
         floor to its own time (max(1_000, 2_000)) — the clock is floored, \
         not erased, so a delayed pre-Clear assertion can never resurrect \
         the cleared stamps"
    );
    assert_eq!(row.created_at, 1_000, "created_at is preserved on re-bind");
    assert_eq!(row.updated_at, 2_000, "updated_at still refreshes");
    assert!(
        ledger.list_pending_raw().is_empty(),
        "the consumed marker is gone (binding-first order)"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_clear_wins_over_a_stamped_marker() {
    // The tri-state policy of the RESOLVE stays authoritative: `Clear` (the
    // explicitly-headless re-bind arm) erases even when a stamped marker is
    // present — the marker fallback expands only the conn-less `Inherit` arm.
    let root = temp_root("resolve-clear-wins");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "codex",
            "th-1",
            "t-prev",
            500,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
        ))
        .unwrap();
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps {
                client_instance_id: Some("client-2"),
                device_id: Some("device-2"),
                tab_key: Some("device-2:tab-2"),
                asserted_at: 1_000,
            },
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&write_with_policy(
            "codex",
            "th-1",
            "t1",
            2_000,
            ProvenancePolicy::Clear,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.client_instance_id, None, "Clear erases browser stamps");
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "focused-ep4-r5 Finding 2: Clear raises the attribution floor \
         (max(500, clear_now = 2_000)) — never erases the clock"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Delta-r7-round-3 (focused-episode-7 round 2, Finding F1) — pane LINEAGE
// durable on the row: a row resolving from a pending marker records the
// marker's ORIGIN createRequestId, so a pane closed BEFORE its identity ever
// resolved (the CRID-only `pane.closed` journal shape) still covers the row
// the conn-less resolution lane later writes with `create_request_id: None`.
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn resolve_pending_records_the_markers_origin_create_request_id() {
    // THE FINDING'S WRITE-SIDE SHAPE: an in-flight codex create leaves a
    // pending marker keyed by the create's terminal id and carrying the
    // pane's createRequestId; the pane is X-closed (the CRID-only close
    // record lands); the conn-less resolution hook (`ledger_resolve_identity`
    // — `create_request_id: None` DELIBERATELY, D4) later resolves the
    // identity. The row must still carry the ORIGIN pane's lineage key so the
    // recovery inventory's close coverage can join record→row by lineage.
    let root = temp_root("origin-lineage");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            Some("req-origin"), // the pane's createRequestId (spawn-time create)
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&BindingWrite {
            create_request_id: None, // the conn-less lane's deliberate None
            origin_create_request_id: None,
            ..write("codex", "th-1", "t1", 2_000)
        })
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(
        row.create_request_id, None,
        "the dynamic-identity CRID rule is UNCHANGED: resolution never joins on it"
    );
    assert_eq!(
        row.origin_create_request_id.as_deref(),
        Some("req-origin"),
        "the row durable-records its ORIGIN pane's lineage key from the consumed marker"
    );
    // Durable across a reload (a second ledger over the same dir).
    drop(ledger);
    let reload = PaneLedger::new(Some(root.clone()));
    let row = reload.load_binding("codex", "th-1").expect("binding row");
    assert_eq!(row.origin_create_request_id.as_deref(), Some("req-origin"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn record_binding_origins_the_row_to_its_own_create_request_id() {
    // Uniform lineage: a conn-scoped create's binding write (the create's
    // createRequestId rides `create_request_id`) IS that row's origin — no
    // marker consultation exists on this lane, so the origin falls back to
    // the write's own pane key.
    let root = temp_root("origin-fallback");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-1", "t1", 1_000))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-1").expect("row");
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    assert_eq!(
        row.origin_create_request_id.as_deref(),
        Some("req-1"),
        "origin == the create's createRequestId on the conn-scoped lane"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_crid_less_rebind_preserves_the_rows_origin_lineage() {
    // A later conn-less write carrying NO pane identity (the mid-session
    // rebind shape — no marker in play) must not ERASE the lineage the row
    // already carries: lineage is a fact about the identity's pane ancestry,
    // and a re-asserting write that knows nothing of panes preserves it
    // (the advisory ids stay wholesale-replaced; the ORIGIN only ever moves
    // when a write KNOWS a new pane owns the row).
    let root = temp_root("origin-preserved");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            Some("req-origin"),
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&BindingWrite {
            create_request_id: None,
            origin_create_request_id: None,
            ..write("codex", "th-1", "t1", 2_000)
        })
        .unwrap();
    // Same key, conn-less, no marker left (consumed above): the rebind
    // rewrites the advisory ids (create_request_id wholesale → None) but
    // keeps the origin lineage.
    ledger
        .resolve_pending(&BindingWrite {
            create_request_id: None,
            origin_create_request_id: None,
            ..write("codex", "th-1", "t1", 3_000)
        })
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("row");
    assert_eq!(row.create_request_id, None);
    assert_eq!(
        row.origin_create_request_id.as_deref(),
        Some("req-origin"),
        "a pane-identity-less rebind NEVER erases the recorded origin lineage"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn note_pane_reattach_rekeys_the_origin_lineage_wholesale() {
    // The restamp (delta-r7-r2 Finding F3) moves the row onto the ATTACHING
    // pane COMPLETELY — lineage included: otherwise the OLD pane's close
    // record would still key the row through the new origin arm and a
    // genuinely re-opened session would stay suppressed (the reattach lapse
    // the restamp exists to restore).
    let root = temp_root("origin-restamp");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            Some("req-OLD-original"),
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .resolve_pending(&BindingWrite {
            create_request_id: None,
            origin_create_request_id: None,
            ..write("codex", "th-1", "t1", 2_000)
        })
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("row");
    assert_eq!(
        row.origin_create_request_id.as_deref(),
        Some("req-OLD-original")
    );
    // A new pane (fresh createRequestId) reattaches the still-running
    // terminal: the row's pane keys move wholesale — create_request_id AND
    // origin — leaving NO key the closed old pane's record can match.
    ledger
        .note_pane_reattach(&ReattachWrite {
            provider: "codex",
            session_id: "th-1",
            terminal_id: "t1",
            create_request_id: "req-NEW-pane",
            provenance: ProvenancePolicy::Inherit,
            now_ms: 3_000,
        })
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").expect("row");
    assert_eq!(row.create_request_id.as_deref(), Some("req-NEW-pane"));
    assert_eq!(
        row.origin_create_request_id.as_deref(),
        Some("req-NEW-pane"),
        "the origin lineage moves to the attaching pane wholesale"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn old_rows_and_markers_without_the_lineage_fields_still_deserialize() {
    // Serde-additive under LEDGER_VERSION 1 (the provenance-fields
    // precedent): rows and markers persisted by intermediate builds carry no
    // `originCreateRequestId` / `createRequestId` keys and parse to `None` —
    // their close coverage falls back to the pre-existing arms (the
    // conn-less CRID-less row + terminal-id arm, unchanged).
    let root = temp_root("origin-legacy-parse");
    let ledger_dir = root.join("bindings").join("codex");
    std::fs::create_dir_all(&ledger_dir).unwrap();
    std::fs::write(
        ledger_dir.join("th-legacy.json"),
        serde_json::json!({
            "ledgerVersion": LEDGER_VERSION,
            "provider": "codex",
            "sessionId": "th-legacy",
            "mode": "codex",
            "liveTerminalId": "t-legacy",
            "createdAt": 1_000i64,
            "updatedAt": 1_000i64,
            "lastObservedAt": 1_000i64,
            "state": "bound",
        })
        .to_string(),
    )
    .unwrap();
    let marker_dir = root.join("pending");
    std::fs::create_dir_all(&marker_dir).unwrap();
    std::fs::write(
        marker_dir.join("t-legacy-pending.json"),
        serde_json::json!({
            "ledgerVersion": LEDGER_VERSION,
            "terminalId": "t-legacy-pending",
            "mode": "codex",
            "spawnedAt": 1_000i64,
            "assertedAt": 1_000i64,
        })
        .to_string(),
    )
    .unwrap();
    let ledger = PaneLedger::new(Some(root.clone()));
    let row = ledger
        .load_binding("codex", "th-legacy")
        .expect("row parses");
    assert_eq!(
        row.origin_create_request_id, None,
        "legacy row: no origin key"
    );
    let marker = ledger
        .pending_for_terminal("t-legacy-pending")
        .expect("marker parses");
    assert_eq!(marker.create_request_id, None, "legacy marker: no crid key");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn stamped_marker_retention_keys_on_creation_time_never_assertion_time() {
    // The stamps are payload, not lifetime: retention reads only
    // `spawned_at` — the marker's ACTUAL creation time (focused-ep4-r3
    // Finding 3 renamed this test from `stamped_marker_retention_is_
    // unchanged`; the flip is that `spawned_at` no longer carries the
    // assertion). The creation/assertion times are DELIBERATELY far apart so
    // the two roles cannot be conflated: a marker born NOW whose browser
    // assertion is 30+ days stale (a long-gated create's parked provenance,
    // finally spawned) is RETAINED (creation is young — it did not arrive
    // pre-aged), while a marker CREATED past the TTL is swept whatever its
    // assertion says.
    let root = temp_root("stamped-marker-ttl");
    let ledger = PaneLedger::new(Some(root.clone()));
    let now = 2 * PENDING_MARKER_TTL_MS;
    let stamps_at = |asserted_at: i64| ProvenanceStamps {
        client_instance_id: Some("client-1"),
        device_id: Some("device-1"),
        tab_key: Some("device-1:tab-1"),
        asserted_at,
    };
    ledger
        .record_pending(
            "young-t",
            "codex",
            Some("/tmp/p"),
            None,
            stamps_at(1_000), // a 30+ days stale ASSERTION…
            now - 60_000,     // …but the marker itself was CREATED a minute ago
        )
        .unwrap();
    ledger
        .record_pending(
            "aged-t",
            "codex",
            Some("/tmp/p"),
            None,
            stamps_at(1_000),
            1_000,
        )
        .unwrap();
    let report = ledger.gc(now, &never_absent, None, Some(&no_snapshot_refs()));
    assert_eq!(
        report.stale_markers_removed,
        vec!["aged-t".to_string()],
        "only the marker whose CREATION is past the TTL is swept — the stale \
         assertion on a just-created marker must not pre-age it"
    );
    let young = ledger
        .pending_for_terminal("young-t")
        .expect("the young stamped marker is retained");
    assert_eq!(young.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(young.device_id.as_deref(), Some("device-1"));
    assert_eq!(young.tab_key.as_deref(), Some("device-1:tab-1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn old_markers_without_provenance_fields_still_deserialize() {
    // The stamps are additive under LEDGER_VERSION 1 (the BindingRow
    // precedent, `old_terminal_rows_without_settings_fields_still_deserialize`):
    // a pre-delta-r3 marker document has none of the new keys and parses to
    // all-`None` — a resolution over it behaves exactly as before.
    let json = r#"{"ledgerVersion":1,"terminalId":"t1","mode":"codex","spawnedAt":1000}"#;
    let marker: PendingMarker = serde_json::from_str(json).expect("old marker must parse");
    assert_eq!(marker.client_instance_id, None);
    assert_eq!(marker.device_id, None);
    assert_eq!(marker.tab_key, None);
    assert_eq!(
        marker.asserted_at, 0,
        "focused-ep4-r3 Finding 3: the split field is likewise additive — no \
         assertion recorded"
    );
    // The INTERMEDIATE (ep4-r2) shape: stamps present, `spawned_at` carrying
    // the assertion time, and no `assertedAt` — the split did not exist yet.
    // It parses with `asserted_at == 0`, which arms the resolution's
    // `spawned_at` fallback (`resolution_of_a_legacy_marker_falls_back_to_
    // spawned_at` pins the resolution side, end to end).
    let json = r#"{"ledgerVersion":1,"terminalId":"t2","mode":"codex","spawnedAt":1000,"clientInstanceId":"c","deviceId":"d","tabKey":"d:t"}"#;
    let marker: PendingMarker = serde_json::from_str(json).expect("intermediate marker must parse");
    assert_eq!(marker.spawned_at, 1_000);
    assert_eq!(marker.asserted_at, 0);
    assert_eq!(marker.tab_key.as_deref(), Some("d:t"));
}

#[test]
fn sigkill_inside_locator_window_leaves_a_durable_marker() {
    // Red test `SIGKILL-inside-locator-window` (unit shape): a marker
    // written pre-resolution survives "process death" (a second PaneLedger
    // instance over the same dir) so a restarted server can answer
    // "fresh by race, not by intent" instead of silent fresh.
    let root = temp_root("sigkill-window");
    {
        let gen1 = PaneLedger::new(Some(root.clone()));
        gen1.record_pending(
            "t1",
            "opencode",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
        // gen1 "dies" here — dropped without resolving.
    }
    let gen2 = PaneLedger::new(Some(root.clone()));
    let marker = gen2
        .pending_for_terminal("t1")
        .expect("marker survived the crash");
    assert_eq!(marker.mode, "opencode");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_pending_is_a_noop_when_missing() {
    let root = temp_root("del-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .delete_pending("never-existed")
        .expect("missing marker is Ok");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn deleted_binding_row_is_gone_for_recovery_readers() {
    // PIN 2 (Step 4b): a pre-spawn claude binding whose spawn then FAILED is
    // deleted so it can never surface as a ghost `ledgerOnly` recovery offer.
    // (The D8 parent-relative judgment already excludes unattributed rows and
    // anything outside its parent's grace window; the failed-prealloc row is
    // connection-stamped and bound inside that window, so the delete remains
    // the only guarantee.) `list_bindings` is THE reader that feeds the
    // recovery inventory (`recovery_inventory.rs` build_inventory), so "gone"
    // is judged there.
    let root = temp_root("del-binding");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-failed", "t1", 1_000))
        .expect("write ok");
    assert!(ledger
        .list_bindings()
        .iter()
        .any(|r| r.session_id == "sess-failed"));

    ledger
        .delete_binding("claude", "sess-failed")
        .expect("delete ok");

    // Gone for the recovery-inventory reader, the raw read, AND on disk
    // (a construction-time rescan must not resurrect it).
    assert!(!ledger
        .list_bindings()
        .iter()
        .any(|r| r.session_id == "sess-failed"));
    assert!(ledger.load_binding("claude", "sess-failed").is_none());
    let gen2 = PaneLedger::new(Some(root.clone()));
    assert!(gen2.load_binding("claude", "sess-failed").is_none());

    // Idempotent: deleting a missing row is Ok (mirror of delete_pending).
    ledger
        .delete_binding("claude", "sess-failed")
        .expect("missing row is Ok");
    std::fs::remove_dir_all(&root).ok();
}

/// The close-evidence retention gate input for the pre-F2 tests: a scanned
/// store that references NOTHING (the prune-when-unreferenced arm — the
/// pre-journal tests' raw-TTL behavior).
fn no_snapshot_refs() -> crate::tabs_persist::RetainedSnapshotReferences {
    crate::tabs_persist::RetainedSnapshotReferences::default()
}

fn never_absent(_p: &str, _s: &str) -> bool {
    false
}

#[test]
fn corrupt_ledger_boot_quarantines_per_row_never_per_store() {
    // Red test `corrupt-ledger-boot` (spec §4.2): an unparsable row is
    // renamed aside + logged, never silently dropped, and never causes
    // healthy rows to be skipped.
    let root = temp_root("corrupt");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-good", "t1", 1_000))
        .unwrap();
    let bad = root.join("bindings").join("claude").join("sess-bad.json");
    std::fs::write(&bad, b"{ not json").unwrap();
    // A future-versioned row is also quarantined (ledgerVersion gates
    // migration), never silently reinterpreted.
    let vnext = root.join("bindings").join("claude").join("sess-vnext.json");
    std::fs::write(
        &vnext,
        br#"{"ledgerVersion": 999, "someFutureShape": true}"#,
    )
    .unwrap();

    let report = ledger.boot_scan(2_000, &never_absent, Some(&no_snapshot_refs()));
    assert_eq!(report.quarantined.len(), 2);
    assert!(!bad.exists(), "corrupt row renamed aside");
    assert!(!vnext.exists(), "future-version row renamed aside");
    let provider_dir = root.join("bindings").join("claude");
    let quarantined: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".quarantined-"))
        .collect();
    assert_eq!(quarantined.len(), 2, "renamed aside, not deleted");
    // Healthy rows still served.
    assert!(ledger.load_binding("claude", "sess-good").is_some());
    assert_eq!(ledger.quarantined_rows().len(), 2, "surfaced via API");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn crash_between_binding_write_and_marker_delete_is_repaired_at_boot() {
    // Red test `crash-between-binding-write-and-marker-delete`: both rows
    // present (the safe crash shape the pinned order buys) -> the boot
    // sweep deletes the stale marker; the binding row wins throughout.
    let root = temp_root("crash-window");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    // (simulates: binding written, crash before marker delete)

    let report = ledger.boot_scan(3_000, &never_absent, Some(&no_snapshot_refs()));
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    assert!(ledger.load_binding("codex", "th-1").is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn boot_scan_never_sweeps_a_marker_merely_because_the_terminal_is_not_live() {
    // Spec §4.2: pending markers are GC'd only for terminals whose clean
    // exit was observed IN THIS PROCESS EPOCH — never swept at boot just
    // because the terminal isn't currently live. That would erase the
    // fresh-by-race breadcrumb at exactly the boot that needs it.
    let root = temp_root("marker-preserved");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "opencode",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    let report = ledger.boot_scan(2_000, &never_absent, Some(&no_snapshot_refs()));
    assert!(report.stale_markers_removed.is_empty());
    assert!(ledger.pending_for_terminal("t1").is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn aged_out_marker_is_swept_after_its_ttl() {
    // A8/V7: a marker can leak (e.g. its pane died with a dead server and
    // the terminal id is never re-minted). Lifetime is BOUNDED: a marker
    // older than PENDING_MARKER_TTL_MS is swept, loudly. Fresh-by-race
    // evidence matters at the boots NEAR the crash — a 30-day-old marker
    // is stale noise, not evidence.
    let root = temp_root("marker-ttl");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    let report = ledger.boot_scan(
        1_000 + PENDING_MARKER_TTL_MS + 1,
        &never_absent,
        Some(&no_snapshot_refs()),
    );
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn periodic_gc_sweeps_aged_markers_without_a_restart() {
    // The `gc` contract includes the aged-marker sweep (see the Interfaces
    // note and the PENDING_MARKER_TTL_MS doc): the leaked-marker lifetime
    // bound must hold on a LONG-RUNNING server, so the periodic path — not
    // just boot_scan — must sweep aged markers.
    let root = temp_root("marker-ttl-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "t1",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    // A fresh marker survives a GC pass (never swept merely for age < TTL)...
    let report = ledger.gc(2_000, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(report.stale_markers_removed.is_empty());
    assert!(ledger.pending_for_terminal("t1").is_some());
    // ...but an aged-out one is swept by gc() alone — no boot_scan involved.
    let report = ledger.gc(
        1_000 + PENDING_MARKER_TTL_MS + 1,
        &never_absent,
        None,
        Some(&no_snapshot_refs()),
    );
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn orphaned_pending_marker_is_gced_after_orphan_ttl() {
    // PERIODIC sweep semantics (live_terminal_ids = Some({"live-t"})):
    // marker: terminal "dead-t", spawned_at = now - (ORPHAN_TTL + 1h), no
    // binding row, terminal NOT in the live set -> deleted.
    // marker: terminal "live-t", same age, IS in the live set -> kept.
    // marker: terminal "young-t", spawned_at = now - 60_000, not live ->
    // kept (younger than the orphan TTL).
    let root = temp_root("orphan-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    let now = 2 * PENDING_MARKER_ORPHAN_TTL_MS;
    let orphan_age = now - (PENDING_MARKER_ORPHAN_TTL_MS + 60 * 60 * 1000);
    ledger
        .record_pending(
            "dead-t",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            orphan_age,
        )
        .unwrap();
    ledger
        .record_pending(
            "live-t",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            orphan_age,
        )
        .unwrap();
    ledger
        .record_pending(
            "young-t",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            now - 60_000,
        )
        .unwrap();
    let live: HashSet<String> = HashSet::from(["live-t".to_string()]);

    let report = ledger.gc(now, &never_absent, Some(&live), Some(&no_snapshot_refs()));
    assert_eq!(report.stale_markers_removed, vec!["dead-t".to_string()]);
    let mut remaining: Vec<String> = ledger
        .list_pending_raw()
        .into_iter()
        .map(|m| m.terminal_id)
        .collect();
    remaining.sort();
    assert_eq!(
        remaining,
        vec!["live-t".to_string(), "young-t".to_string()],
        "live marker and young marker are kept; only the dead+old orphan is swept"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn boot_path_never_runs_the_orphan_rule() {
    // BOOT sweep semantics (live_terminal_ids = None -- pre-serve, the
    // registry is empty, main.rs:603-630): a "dead-t"-shaped marker older
    // than ORPHAN_TTL with no binding row -> KEPT (otherwise every old
    // marker would be swept at every boot; only the pre-existing
    // PENDING_MARKER_TTL_MS 30-day rule applies at boot).
    let root = temp_root("orphan-boot");
    let ledger = PaneLedger::new(Some(root.clone()));
    let now = 2 * PENDING_MARKER_ORPHAN_TTL_MS;
    let orphan_age = now - (PENDING_MARKER_ORPHAN_TTL_MS + 60 * 60 * 1000);
    ledger
        .record_pending(
            "dead-t",
            "codex",
            Some("/tmp/p"),
            None,
            ProvenanceStamps::default(),
            orphan_age,
        )
        .unwrap();

    let report = ledger.boot_scan(now, &never_absent, Some(&no_snapshot_refs()));
    assert!(report.stale_markers_removed.is_empty());
    let remaining: Vec<String> = ledger
        .list_pending_raw()
        .into_iter()
        .map(|m| m.terminal_id)
        .collect();
    assert_eq!(
        remaining,
        vec!["dead-t".to_string()],
        "boot never sweeps by the orphan rule"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn crash_mid_supersession_two_bound_rows_repaired_by_updated_at_tiebreak() {
    // Red test `crash-mid-supersession-two-bound-rows`: the new bound row
    // was written but the crash landed before the old row was retired ->
    // two bound rows share a pane lineage (liveTerminalId). Boot repair:
    // newer updatedAt wins, older auto-retired as superseded, loudly.
    let root = temp_root("two-bound");
    // Forge the crash shape directly on disk (record_binding would retire
    // the old); the ledger is constructed AFTER, so its construction-time
    // index load sees the forged rows — the actual post-crash boot shape.
    for (sid, at) in [("th-old", 1_000i64), ("th-new", 2_000i64)] {
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: "codex".into(),
            session_id: sid.into(),
            mode: "codex".into(),
            cwd: None,
            live_terminal_id: Some("t1".into()),
            create_request_id: None,
            origin_create_request_id: None,
            created_at: at,
            updated_at: at,
            last_observed_at: at,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
            pane_kind: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            client_instance_id: None,
            device_id: None,
            tab_key: None,
            last_attributed_at: None,
        };
        write_row_atomic(
            &root
                .join("bindings")
                .join("codex")
                .join(format!("{sid}.json")),
            &row,
        )
        .unwrap();
    }
    // Constructed AFTER the forged rows, as promised above.
    let ledger = PaneLedger::new(Some(root.clone()));

    let report = ledger.boot_scan(3_000, &never_absent, Some(&no_snapshot_refs()));
    assert_eq!(report.supersession_repairs.len(), 1);
    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    assert_eq!(old.superseded_by.as_ref().unwrap().session_id, "th-new");
    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn gc_expires_unobserved_bound_rows_to_tombstones_never_deletion() {
    let root = temp_root("gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-old", "t1", 1_000))
        .unwrap();
    let now = 1_000 + BOUND_GC_TTL_MS + 1;
    let report = ledger.gc(now, &never_absent, None, Some(&no_snapshot_refs()));
    assert_eq!(report.gc_tombstoned.len(), 1);
    let row = ledger.load_binding("claude", "sess-old").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::GcExpired));
    // NOT deleted — a tombstone.
    assert!(ledger.ever_bound("claude", "sess-old"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn tombstone_deletion_is_conditioned_on_transcript_absence() {
    let root = temp_root("tombstone");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-x", "t1", 1_000))
        .unwrap();
    let expire_at = 1_000 + BOUND_GC_TTL_MS + 1;
    ledger.gc(expire_at, &never_absent, None, Some(&no_snapshot_refs()));
    let delete_at = expire_at + TOMBSTONE_GC_TTL_MS + 1;

    // Transcript still on disk (or unknown) -> tombstone survives forever.
    let report = ledger.gc(delete_at, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(report.tombstones_deleted.is_empty());
    assert!(ledger.ever_bound("claude", "sess-x"));

    // Definitively absent -> deletion is finally allowed.
    let report = ledger.gc(delete_at, &|_p, _s| true, None, Some(&no_snapshot_refs()));
    assert_eq!(report.tombstones_deleted.len(), 1);
    assert!(!ledger.ever_bound("claude", "sess-x"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn gc_expired_tombstone_rebinds_on_a_live_identity_event() {
    // Spec §4.2: `retired/gc_expired -> bound` is a LEGAL transition, taken
    // automatically (never-ask-when-we-can-act) and loudly logged.
    let root = temp_root("revive");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-x", "t1", 1_000))
        .unwrap();
    ledger.gc(
        1_000 + BOUND_GC_TTL_MS + 1,
        &never_absent,
        None,
        Some(&no_snapshot_refs()),
    );
    assert_eq!(
        ledger
            .load_binding("claude", "sess-x")
            .unwrap()
            .retired_reason,
        Some(RetiredReason::GcExpired)
    );
    let revive_at = 1_000 + BOUND_GC_TTL_MS + 2;
    ledger
        .record_binding(&write("claude", "sess-x", "t2", revive_at))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-x").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_binding_roundtrips_settings_and_pane_kind() {
    let root = temp_root("fresh-agent-roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "thread-1",
            mode: "freshcodex",
            cwd: Some("/home/u/proj"),
            create_request_id: Some("req-1"),
            model: Some("gpt-5.3-codex-spark"),
            sandbox: Some("workspace-write"),
            permission_mode: Some("on-request"),
            effort: Some("high"),
            supersedes: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();
    let row = ledger.load_binding("codex", "thread-1").expect("row");
    assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    assert_eq!(row.model.as_deref(), Some("gpt-5.3-codex-spark"));
    assert_eq!(row.sandbox.as_deref(), Some("workspace-write"));
    assert_eq!(row.permission_mode.as_deref(), Some("on-request"));
    assert_eq!(row.effort.as_deref(), Some("high"));
    assert_eq!(row.cwd.as_deref(), Some("/home/u/proj"));
    assert_eq!(row.created_at, 1_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_binding_upsert_preserves_created_at_and_refreshes_settings() {
    let root = temp_root("fresh-agent-upsert");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "opencode",
        session_id: "ses_abc",
        mode: "freshopencode",
        cwd: Some("/w"),
        create_request_id: None,
        model: Some("m1"),
        sandbox: None,
        permission_mode: None,
        effort: Some("low"),
        supersedes: None,
        provenance: ProvenancePolicy::Inherit,
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            model: Some("m2"),
            effort: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 2_000,
            ..base
        })
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_abc").expect("row");
    assert_eq!(row.created_at, 1_000, "upsert must preserve created_at");
    assert_eq!(row.updated_at, 2_000);
    assert_eq!(row.model.as_deref(), Some("m2"));
    assert_eq!(
        row.effort, None,
        "settings are a full snapshot, not a merge"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn supersedes_retires_the_old_row_and_links_the_chain() {
    // G3 supersession (V8/A14): codex crash-respawn must retire the OLD
    // thread row and link it to the new one — never leave two Bound rows.
    let root = temp_root("fresh-agent-supersedes");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "codex",
        session_id: "old-thread",
        mode: "freshcodex",
        cwd: Some("/w"),
        create_request_id: None,
        model: Some("m"),
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        provenance: ProvenancePolicy::Inherit,
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            session_id: "new-thread",
            supersedes: Some("old-thread"),
            provenance: ProvenancePolicy::Inherit,
            now_ms: 2_000,
            ..base
        })
        .unwrap();
    let old = ledger
        .load_binding("codex", "old-thread")
        .expect("old row kept");
    assert_eq!(
        old.state,
        RowState::Retired,
        "old row retired, never left Bound"
    );
    assert_eq!(
        old.superseded_by.as_ref().map(|l| l.session_id.as_str()),
        Some("new-thread"),
        "supersededBy links old → new"
    );
    let res = ledger
        .lookup_by_session("codex", "old-thread")
        .expect("chain resolves");
    assert!(
        res.corrected,
        "claiming the old id is a corrected resolution"
    );
    assert_eq!(
        res.row.session_id, "new-thread",
        "resolution lands at the terminus"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_upsert_preserves_advisory_create_request_id_when_absent() {
    // create_request_id is advisory, latest-observed (D4): a rewrite that
    // carries None must not erase the previously observed value.
    let root = temp_root("fresh-agent-req-id");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "codex",
        session_id: "thread-1",
        mode: "freshcodex",
        cwd: None,
        create_request_id: Some("req-1"),
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        provenance: ProvenancePolicy::Inherit,
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            create_request_id: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 2_000,
            ..base
        })
        .unwrap();
    let row = ledger.load_binding("codex", "thread-1").expect("row");
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn fresh_agent_settings_recorded_keys_off_settings_bearing_rows() {
    // Task 3's ledger predicate behind the identity sink's `was_recorded`
    // rekeying: a fresh-agent binding row counts as "recorded" only when it
    // carries a SETTINGS-BEARING snapshot — at least one of
    // model/sandbox/permission_mode/effort/cwd set (the exact complement of
    // the fresh-agent sink `load_settings` blank guard). Lineage-only rows
    // (all blank) answer false, so unconditional lineage writes never arm a
    // false SETTINGS_RESET. Schema-compatible: no migration; historical blank
    // rows flip to false (forward-looking tradeoff, accepted).
    let root = temp_root("fresh-agent-settings-recorded");
    let ledger = PaneLedger::new(Some(root.clone()));
    let base = FreshAgentBindingWrite {
        provider: "opencode",
        session_id: "ses_full",
        mode: "freshopencode",
        cwd: Some("/w"),
        create_request_id: Some("cr-1"),
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
        supersedes: None,
        provenance: ProvenancePolicy::Inherit,
        now_ms: 1_000,
    };
    // A cwd-only snapshot counts as settings-bearing (real creates always
    // carry at least cwd).
    ledger.record_fresh_agent_binding(&base).unwrap();
    assert!(ledger.fresh_agent_settings_recorded("opencode", "ses_full"));
    // A lineage-only row (every settings column blank) does NOT count.
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            session_id: "ses_lineage",
            cwd: None,
            ..base
        })
        .unwrap();
    assert!(!ledger.fresh_agent_settings_recorded("opencode", "ses_lineage"));
    // Terminal-pane rows (no pane_kind) never count, even with cwd set.
    ledger
        .record_binding(&write("claude", "sess-t", "t1", 2_000))
        .unwrap();
    assert!(!ledger.fresh_agent_settings_recorded("claude", "sess-t"));
    // Unknown keys answer false.
    assert!(!ledger.fresh_agent_settings_recorded("opencode", "nope"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn supersedes_of_a_missing_old_row_is_a_silent_noop() {
    let root = temp_root("fresh-agent-supersedes-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "new-thread",
            mode: "freshcodex",
            cwd: None,
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: Some("never-existed"),
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .expect("missing old row is a silent no-op, not an error");
    assert!(ledger.load_binding("codex", "never-existed").is_none());
    let row = ledger.load_binding("codex", "new-thread").expect("row");
    assert_eq!(row.state, RowState::Bound);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn old_terminal_rows_without_settings_fields_still_deserialize() {
    // A wave-A row serialized before this change has none of the new fields.
    let json = r#"{"ledgerVersion":1,"provider":"claude","sessionId":"s1","mode":"claude",
        "createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound"}"#;
    let row: BindingRow = serde_json::from_str(json).expect("old row must parse");
    assert_eq!(row.pane_kind, None);
    assert_eq!(row.model, None);
}

#[test]
fn resolve_identity_without_pending_marker_supersedes_prior_binding() {
    // The mid-session rebind path calls resolve_pending with NO pending
    // marker on disk (the pane bound long ago). The binding row must still
    // be written and the previous bound row retired as Superseded with
    // supersededBy -- and the absent marker delete must be a no-op, not an
    // error surfaced to the caller.
    let root = temp_root("resolve-no-marker");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .resolve_pending(&write("codex", "old-id", "t1", 1_000))
        .expect("first bind");
    ledger
        .resolve_pending(&write("codex", "new-id", "t1", 2_000))
        .expect("rebind without marker must succeed");
    let hit = ledger
        .lookup_by_session("codex", "old-id")
        .expect("old row remains, retired");
    assert!(
        hit.corrected,
        "stale claim answered from the chain terminus"
    );
    assert_eq!(hit.row.session_id, "new-id");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_to_the_same_identity_is_not_a_supersession() {
    let root = temp_root("samebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retire_missing_marks_bound_row_session_missing() {
    // Setup: a ledger with a Bound binding for ("amplifier", "stale-sid")
    let root = temp_root("retire-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("amplifier", "stale-sid", "t1", 1_000))
        .unwrap();

    // Act: retire the binding as missing
    let retired = ledger.retire_missing("amplifier", "stale-sid");

    // Assert: retirement succeeded
    assert!(retired);
    let row = ledger.load_binding("amplifier", "stale-sid").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::SessionMissing));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retire_missing_is_noop_without_binding() {
    // Fresh ledger, no rows.
    let root = temp_root("retire-missing-noop");
    let ledger = PaneLedger::new(Some(root.clone()));

    // Act: try to retire a non-existent binding
    let retired = ledger.retire_missing("amplifier", "never-seen");

    // Assert: no-op returns false
    assert!(!retired);
    // Verify no row was created
    assert_eq!(ledger.load_binding("amplifier", "never-seen"), None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retire_missing_does_not_reretire() {
    // Bound row retired once => true; second call => false; reason stays
    // SessionMissing; updated_at from the first retire is not clobbered
    // by the failed second call.
    let root = temp_root("retire-missing-reretire");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("amplifier", "sid", "t1", 1_000))
        .unwrap();

    // First retire should succeed
    let first = ledger.retire_missing("amplifier", "sid");
    assert!(first);
    let row_after_first = ledger.load_binding("amplifier", "sid").unwrap();
    let first_updated_at = row_after_first.updated_at;
    assert_eq!(row_after_first.state, RowState::Retired);
    assert_eq!(
        row_after_first.retired_reason,
        Some(RetiredReason::SessionMissing)
    );

    // Second retire should fail (already retired)
    let second = ledger.retire_missing("amplifier", "sid");
    assert!(!second);
    let row_after_second = ledger.load_binding("amplifier", "sid").unwrap();
    assert_eq!(row_after_second.state, RowState::Retired);
    assert_eq!(
        row_after_second.retired_reason,
        Some(RetiredReason::SessionMissing)
    );
    // Verify updated_at was not clobbered
    assert_eq!(row_after_second.updated_at, first_updated_at);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn session_missing_serde_round_trips() {
    // Test serialization
    let reason = RetiredReason::SessionMissing;
    let json = serde_json::to_string(&reason).expect("serialize");
    assert_eq!(json, r#""session_missing""#);

    // Test deserialization
    let deserialized: RetiredReason = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deserialized, RetiredReason::SessionMissing);
}

/// kata 1wxv Task 4: the claude fork-adoption re-key MOVES the rollback row
/// old→new — copy under the new id lands durably, and the old id's row is gone
/// from BOTH the on-disk file and the write-through index (a surviving stale
/// row would let the superseded id keep describing rollback state it no longer
/// owns).
#[test]
fn rollback_row_rekey_move_drops_the_old_durably() {
    let root = temp_root("rollback-rekey");
    let ledger = PaneLedger::new(Some(root.clone()));
    let payload_a = serde_json::json!({"version": 1, "entries": []});
    ledger
        .record_rollback_row("claude", "old-id", &payload_a, 1)
        .expect("seed write");
    let payload_old = ledger
        .load_rollback_row("claude", "old-id")
        .expect("seeded");
    // The re-key move: copy under the new id, then delete the old.
    ledger
        .record_rollback_row("claude", "new-id", &payload_old, 2)
        .expect("copy");
    ledger
        .delete_rollback_row("claude", "old-id")
        .expect("delete old");
    assert!(
        ledger.load_rollback_row("claude", "old-id").is_none(),
        "the old row is out of the write-through index"
    );
    assert_eq!(
        ledger.load_rollback_row("claude", "new-id"),
        Some(payload_a),
        "the moved row reads identically under the new id"
    );
    // A FRESH ledger over the same root proves the delete is durable (not index-only).
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert!(
        ledger2.load_rollback_row("claude", "old-id").is_none(),
        "the old row's FILE is gone"
    );
    assert!(ledger2.load_rollback_row("claude", "new-id").is_some());
    // A missing row/file is a silent no-op (never an error).
    ledger
        .delete_rollback_row("claude", "never-existed")
        .expect("no-op delete");
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-ep5-r1 Finding 2 — kill tombstones (retire-on-kill round 2) ─────
//
// The race these pin: a fresh-agent kill runs `retire_closed` while a
// consumer's binding write is ALREADY in flight (an aborted task's orphaned
// spawn_blocking closure — abort can never cancel it). The pre-repair code
// retired by row: the row did not exist yet, the retire was a no-op, and the
// orphan then wrote a fresh Bound row — the exact recovery ghost. The repair
// records a DURABLE kill tombstone at retire time; the binder consults it
// under the same index guard as the write (state, never task scheduling), so
// EVERY completion order converges to not-Bound.

/// Retire-on-kill round 5 (focused-ep5-r4 Finding 2): `row_is_bound` — the
/// claude alias-tombstone retention probe's raw row-state answer. A
/// fresh-agent Bound row answers true; a retired row and a never-written id
/// answer false (freeing their alias records to age out); a disabled ledger
/// answers false (no row provable).
#[test]
fn row_is_bound_answers_the_raw_row_state() {
    let root = temp_root("row-is-bound");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-rb", 1_000))
        .unwrap();
    assert!(
        ledger.row_is_bound("claude", "durable-rb"),
        "a Bound fresh-agent row answers true"
    );
    ledger.retire_closed("claude", "durable-rb", 2_000).unwrap();
    assert!(
        !ledger.row_is_bound("claude", "durable-rb"),
        "a retired row answers false (its alias records may age out)"
    );
    assert!(
        !ledger.row_is_bound("claude", "never-written"),
        "a missing row answers false"
    );
    assert!(
        !PaneLedger::disabled().row_is_bound("claude", "durable-rb"),
        "a disabled ledger proves nothing"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The kill's tombstone is DURABLE: `retire_closed` records it even when no
/// row exists yet (the kill beat the in-flight adoption write), a fresh
/// ledger over the same root loads it, and the binder refuses the late
/// write: a tombstoned identity never gains a Bound row from it.
#[test]
fn kill_tombstone_suppresses_a_late_binding_write_and_survives_reload() {
    let root = temp_root("kill-tombstone-suppress");
    let ledger = PaneLedger::new(Some(root.clone()));
    // The kill: no binding row yet (the consumer's adoption write is still in
    // flight) — retire_closed is a row no-op but must still record the
    // tombstone.
    ledger
        .retire_closed("claude", "durable-kt", 10_000)
        .unwrap();
    assert_eq!(
        ledger.kill_tombstone_at("claude", "durable-kt"),
        Some(10_000),
        "the kill must record a durable tombstone even with no row to retire"
    );
    // The orphaned write lands AFTER: suppressed — no row appears.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-kt", 10_005))
        .unwrap();
    assert!(
        ledger.load_binding("claude", "durable-kt").is_none(),
        "a kill-tombstoned identity must never gain a Bound row from a late write"
    );
    // A FRESH ledger over the same root (the post-restart shape) still
    // suppresses — the tombstone is durable, not in-memory.
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger2.kill_tombstone_at("claude", "durable-kt"),
        Some(10_000),
        "the tombstone is durable: a fresh load over the same root sees it"
    );
    ledger2
        .record_fresh_agent_binding(&fa_write("claude", "durable-kt", 10_500))
        .unwrap();
    assert!(
        ledger2.load_binding("claude", "durable-kt").is_none(),
        "the suppression survives the reload too"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Ordering independence the whole repair rests on: write-then-kill lands
/// exactly like kill-then-write — the row ends Retired, never Bound, and a
/// SECOND late write (a stale refresh) cannot re-Bound it either.
#[test]
fn kill_after_the_write_still_retires_and_a_following_write_stays_suppressed() {
    let root = temp_root("kill-tombstone-order");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-o", 9_000))
        .unwrap();
    assert_eq!(
        ledger.load_binding("claude", "durable-o").unwrap().state,
        RowState::Bound
    );
    ledger.retire_closed("claude", "durable-o", 10_000).unwrap();
    let row = ledger.load_binding("claude", "durable-o").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    // A later write for the tombstoned identity: suppressed — the Retired row
    // is untouched in state (never re-Bound).
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-o", 10_100))
        .unwrap();
    let row = ledger.load_binding("claude", "durable-o").unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "a kill-tombstoned row stays Retired under late writes"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    std::fs::remove_dir_all(&root).ok();
}

/// The crash-window shape the defensive arm closes: the tombstone file is
/// durably down but the row's retire never landed (server death slipped
/// between the two durable writes). A fresh boot loads a Bound row PLUS its
/// tombstone; the FIRST later write attempt for the identity must not
/// launder it back to life — the write is suppressed AND the stale Bound row
/// is force-retired Closed (self-heals the crash remnant).
#[test]
fn a_bound_row_with_a_tombstone_is_force_retired_by_the_next_write_attempt() {
    let root = temp_root("kill-tombstone-crash");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-c", 9_000))
        .unwrap();
    // Hand-craft the crash remnant: tombstone down, retire never landed.
    let tombstone = KillTombstone {
        ledger_version: LEDGER_VERSION,
        provider: "claude".to_string(),
        session_id: "durable-c".to_string(),
        killed_at_ms: 10_000,
    };
    write_row_atomic(
        &PaneLedger::kill_tombstone_path(&root, "claude", "durable-c"),
        &tombstone,
    )
    .unwrap();
    // A fresh boot loads BOTH.
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger2.kill_tombstone_at("claude", "durable-c"),
        Some(10_000)
    );
    assert_eq!(
        ledger2.load_binding("claude", "durable-c").unwrap().state,
        RowState::Bound,
        "fixture: the crash left the row Bound"
    );
    // The late write is suppressed, and the stale Bound row is force-retired.
    ledger2
        .record_fresh_agent_binding(&fa_write("claude", "durable-c", 11_000))
        .unwrap();
    let row = ledger2.load_binding("claude", "durable-c").unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "a Bound row with a fresh tombstone is force-retired by the suppressed write"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    // And the force-retire is durable (a fresh reload agrees).
    let ledger3 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger3.load_binding("claude", "durable-c").unwrap().state,
        RowState::Retired
    );
    std::fs::remove_dir_all(&root).ok();
}

/// TTL: an EXPIRED tombstone stops suppressing (the TTL bounds the tombstone's
/// protective lifetime) and the write it would have blocked sweeps it lazily —
/// stale protection can never wedge a later legitimate bind.
#[test]
fn an_expired_kill_tombstone_no_longer_suppresses_and_is_swept() {
    let root = temp_root("kill-tombstone-ttl");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .retire_closed("claude", "durable-ttl", 10_000)
        .unwrap();
    let later = 10_000 + KILL_TOMBSTONE_TTL_MS + 1;
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-ttl", later))
        .unwrap();
    let row = ledger.load_binding("claude", "durable-ttl").unwrap();
    assert_eq!(
        row.state,
        RowState::Bound,
        "an expired tombstone never blocks a genuine late bind"
    );
    assert_eq!(
        ledger.kill_tombstone_at("claude", "durable-ttl"),
        None,
        "the expired tombstone was swept by the consult"
    );
    assert!(
        !PaneLedger::kill_tombstone_path(&root, "claude", "durable-ttl").exists(),
        "the expired tombstone's FILE is gone too"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The lifecycle transition (Finding 2's clear-on-genuine-claim): an explicit
/// resume/attach of a killed session clears the tombstone, so the claim's own
/// binding write lands Bound again. The clear is idempotent (never-killed
/// identities clear to Ok) — claim lanes call it unconditionally.
#[test]
fn clear_kill_tombstone_reopens_the_identity_for_a_genuine_claim() {
    let root = temp_root("kill-tombstone-clear");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.retire_closed("claude", "durable-r", 10_000).unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-r", 10_100))
        .unwrap();
    assert!(
        ledger.load_binding("claude", "durable-r").is_none(),
        "pre-clear: the tombstone suppresses"
    );
    // The genuine claim clears the tombstone...
    ledger.clear_kill_tombstone("claude", "durable-r").unwrap();
    assert_eq!(ledger.kill_tombstone_at("claude", "durable-r"), None);
    assert!(
        !PaneLedger::kill_tombstone_path(&root, "claude", "durable-r").exists(),
        "the clear deletes the durable tombstone file"
    );
    // ...and its binding write lands Bound.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "durable-r", 10_200))
        .unwrap();
    assert_eq!(
        ledger.load_binding("claude", "durable-r").unwrap().state,
        RowState::Bound,
        "post-clear: the genuine claim binds Bound"
    );
    // Idempotent: re-clears (and clears of never-tombstoned ids) are Ok.
    ledger.clear_kill_tombstone("claude", "durable-r").unwrap();
    ledger
        .clear_kill_tombstone("claude", "never-tombstoned")
        .unwrap();
    std::fs::remove_dir_all(&root).ok();
}

/// The periodic GC pass bounds the close-evidence store: the journal-record
/// sweep drops a fully aged record (delta-r6-r4: fences live IN records —
/// the record's sweep drops the fence it fed with it, loudly reported) and
/// leaves a fresh record's fence alone.
#[test]
fn gc_sweeps_expired_kill_tombstones_and_keeps_fresh_ones() {
    let root = temp_root("kill-tombstone-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .retire_closed("claude", "durable-old", 10_000)
        .unwrap();
    let now = 10_000 + KILL_TOMBSTONE_TTL_MS + 60_000;
    ledger
        .retire_closed("codex", "thread-fresh", now - 1_000)
        .unwrap();
    let report = ledger.gc(now, &|_, _| false, None, Some(&no_snapshot_refs()));
    assert_eq!(
        ledger.kill_tombstone_at("claude", "durable-old"),
        None,
        "the expired fence drops WITH its aged record"
    );
    assert!(
        !PaneLedger::close_envelope_path(&root, "claude:durable-old").exists(),
        "the aged record's file is gone"
    );
    assert!(
        report
            .pane_closes_swept
            .iter()
            .any(|k| k == "claude:durable-old"),
        "the record sweep is loudly reported: {:?}",
        report.pane_closes_swept
    );
    assert_eq!(
        ledger.kill_tombstone_at("codex", "thread-fresh"),
        Some(now - 1_000),
        "a fresh close's fence is never swept"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Disabled-ledger honesty: every tombstone lane is a no-op mirror of the
/// ledger's existing disabled behavior (never an error).
#[test]
fn kill_tombstones_on_a_disabled_ledger_are_no_ops() {
    let ledger = PaneLedger::disabled();
    ledger.retire_closed("claude", "s", 1_000).unwrap();
    assert_eq!(ledger.kill_tombstone_at("claude", "s"), None);
    ledger.clear_kill_tombstone("claude", "s").unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "s", 1_001))
        .unwrap();
}

/// REAL-CONCURRENCY pin (no synchronous-install shortcut): the record and the
/// retire run on parallel threads against the ONE ledger through the same
/// production entry points an orphaned spawn_blocking closure and the kill
/// handler use. Whatever the interleaving, the identity must converge to
/// not-Bound — the consult-under-lock + durable-tombstone design makes the
/// outcome a function of lock order, never of task scheduling.
#[test]
fn record_vs_retire_closed_converges_to_never_bound_under_concurrent_interleavings() {
    for i in 0..64u32 {
        let root = temp_root("kill-tombstone-rr");
        let ledger = std::sync::Arc::new(PaneLedger::new(Some(root.clone())));
        let killed_at = 1_000_000 + i64::from(i) * 4_000;
        let record_at = killed_at + 1;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let l1 = std::sync::Arc::clone(&ledger);
        let b1 = std::sync::Arc::clone(&barrier);
        let rec = std::thread::spawn(move || {
            if i % 2 == 1 {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            b1.wait();
            l1.record_fresh_agent_binding(&fa_write("claude", "durable-x", record_at))
                .unwrap();
        });
        let l2 = std::sync::Arc::clone(&ledger);
        let b2 = std::sync::Arc::clone(&barrier);
        let ret = std::thread::spawn(move || {
            if i % 2 == 0 {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            b2.wait();
            l2.retire_closed("claude", "durable-x", killed_at).unwrap();
        });
        rec.join().expect("record thread");
        ret.join().expect("retire thread");
        let state = ledger.load_binding("claude", "durable-x").map(|r| r.state);
        assert!(
            state != Some(RowState::Bound),
            "iteration {i}: a killed identity must converge to not-Bound, got {state:?}"
        );
        assert_eq!(
            ledger.kill_tombstone_at("claude", "durable-x"),
            Some(killed_at),
            "iteration {i}: the kill's tombstone always landed"
        );
        // Reset for the next interleaving: the claim lane's clear + the
        // spawn-failure lane's delete (the only two row/tombstone exits).
        ledger.clear_kill_tombstone("claude", "durable-x").unwrap();
        ledger.delete_binding("claude", "durable-x").unwrap();
        std::fs::remove_dir_all(&root).ok();
    }
}

// ── Focused-ep5-r2 Finding 1 (retire-on-kill round 3) — tombstone dominance ──
//
// `retire_closed` is TWO durable writes (tombstone, then row retire). A crash
// (or a failed second write) between them leaves a surviving tombstone next
// to a still-Bound row. The tombstone is the author of truth: a fresh one
// DOMINATES the row, and the boot/periodic sweep re-applies the lost
// retirement durably. Pin domain: the hand-crafted remnant survives a
// reload; the sweep must then converge the ROW to Retired(Closed).

/// Hand-craft the crash remnant (the pattern
/// `a_bound_row_with_a_tombstone_is_force_retired_by_the_next_write_attempt`
/// established): the Bound row exists and its tombstone file is down, but the
/// row's retire write never landed. Written AFTER the constructing load, so
/// the caller reloads a fresh ledger to get the post-restart index state.
fn hand_craft_remnant(root: &std::path::Path, provider: &str, session_id: &str, killed_at: i64) {
    let tombstone = KillTombstone {
        ledger_version: LEDGER_VERSION,
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        killed_at_ms: killed_at,
    };
    write_row_atomic(
        &PaneLedger::kill_tombstone_path(root, provider, session_id),
        &tombstone,
    )
    .unwrap();
}

#[test]
fn boot_scan_retires_a_bound_row_dominated_by_a_fresh_kill_tombstone() {
    let root = temp_root("tombstone-dominance-boot");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "remnant-boot", 1_000))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "expired-boot", 1_000))
        .unwrap();
    // FRESH tombstone on the remnant row; the twin's tombstone is already
    // past the TTL at scan time — and focused-ep5-r3 Finding 4: dominance
    // NEVER expires while the row reads Bound, so BOTH converge now.
    let now = 21_701_000;
    hand_craft_remnant(&root, "claude", "remnant-boot", now - 1_000);
    hand_craft_remnant(&root, "claude", "expired-boot", 10_000);
    // A fresh boot loads the remnant as-is: Bound row + its tombstone.
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger2
            .load_binding("claude", "remnant-boot")
            .unwrap()
            .state,
        RowState::Bound,
        "fixture: the crash remnant loads Bound"
    );
    assert_eq!(
        ledger2.kill_tombstone_at("claude", "remnant-boot"),
        Some(now - 1_000)
    );

    ledger2.boot_scan(now, &never_absent, Some(&no_snapshot_refs()));
    let row = ledger2.load_binding("claude", "remnant-boot").unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "the boot scan re-applies the retirement the crash lost: a fresh tombstone dominates"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    // The repair is DURABLE — a fresh reload agrees (not an in-memory read patch).
    let ledger3 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger3
            .load_binding("claude", "remnant-boot")
            .unwrap()
            .state,
        RowState::Retired,
        "the boot-scan repair is durable on disk"
    );

    // Focused-ep5-r3 Finding 4: the expired-tombstone twin converges TOO —
    // a tombstone paired with a still-Bound row never outlives its dominance
    // (the TTL only prunes converged or never-Bound pairs). The pair then
    // prunes: row retired first, tombstone swept Expired.
    assert_eq!(
        ledger2
            .load_binding("claude", "expired-boot")
            .unwrap()
            .state,
        RowState::Retired,
        "a tombstone paired with a still-Bound row never expires (Finding 4)"
    );
    assert_eq!(
        ledger2
            .load_binding("claude", "expired-boot")
            .unwrap()
            .retired_reason,
        Some(RetiredReason::Closed)
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn periodic_gc_retires_a_bound_row_dominated_by_a_fresh_kill_tombstone() {
    let root = temp_root("tombstone-dominance-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "remnant-gc", 1_000))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "expired-gc", 1_000))
        .unwrap();
    let now = 21_701_000;
    hand_craft_remnant(&root, "claude", "remnant-gc", now - 1_000);
    hand_craft_remnant(&root, "claude", "expired-gc", 10_000);
    // The process-lived-on shape: a FRESH load would also see this, but the
    // periodic pass must converge the truth on the long-lived ledger too —
    // construct the successor view (the post-crash restart index) and sweep
    // that: identical re-read discipline, one helper for both schedules.
    let ledger2 = PaneLedger::new(Some(root.clone()));

    let report = ledger2.gc(now, &never_absent, None, Some(&no_snapshot_refs()));
    let row = ledger2.load_binding("claude", "remnant-gc").unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "the periodic sweep re-applies the retirement the failed second write lost"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    let ledger3 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger3.load_binding("claude", "remnant-gc").unwrap().state,
        RowState::Retired,
        "the periodic repair is durable on disk"
    );
    assert!(
        report
            .kill_tombstone_enforced_retires
            .iter()
            .any(|l| l.provider == "claude" && l.session_id == "remnant-gc"),
        "the re-applied retirement is loudly reported: {:?}",
        report.kill_tombstone_enforced_retires
    );
    assert!(
        report
            .kill_tombstones_swept
            .iter()
            .all(|l| !(l.provider == "claude" && l.session_id == "remnant-gc")),
        "the dominating tombstone is FRESH — never swept by the same pass"
    );

    // Focused-ep5-r3 Finding 4: the expired twin is dominated too (a
    // tombstone paired with a still-Bound row never expires) — same pass:
    // its row converges, and only THEN its tombstone is prunable.
    assert_eq!(
        ledger2.load_binding("claude", "expired-gc").unwrap().state,
        RowState::Retired,
        "a tombstone paired with a still-Bound row never expires (Finding 4)"
    );
    assert_eq!(
        ledger2
            .load_binding("claude", "expired-gc")
            .unwrap()
            .retired_reason,
        Some(RetiredReason::Closed)
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-ep5-r2 Findings 1+4 (retire-on-kill round 3) — read surface and revive ──

/// Focused-ep5-r3 Findings 3+4 (retire-on-kill round 4): the classification
/// table EVERY kill-tombstone consult shares — the dominance tie goes to the
/// kill, a Bound row that postdates the tombstone is claim residue (inert),
/// and TTL gates ONLY the no-Bound-row arms.
#[test]
fn kill_tombstone_classification_pins_the_four_verdicts() {
    let now = 10_000;
    // Dominant: the close is as new as or newer than the Bound row's
    // liveness — fresh or expired, identical answer (Finding 4).
    assert_eq!(
        classify_kill_tombstone(9_000, Some((RowState::Bound, 9_000)), now),
        KillTombstoneVerdict::Dominant,
        "the tie goes to the kill"
    );
    assert_eq!(
        classify_kill_tombstone(9_000, Some((RowState::Bound, 8_000)), now),
        KillTombstoneVerdict::Dominant
    );
    assert_eq!(
        classify_kill_tombstone(
            9_000,
            Some((RowState::Bound, 8_000)),
            9_000 + KILL_TOMBSTONE_TTL_MS + 1,
        ),
        KillTombstoneVerdict::Dominant,
        "dominance never expires while the row reads Bound"
    );
    // ClaimResidue: the Bound row visibly postdates the close (the committed
    // revive); expired or fresh, identical.
    assert_eq!(
        classify_kill_tombstone(9_000, Some((RowState::Bound, 9_001)), now),
        KillTombstoneVerdict::ClaimResidue
    );
    // Fresh / Expired: nothing Bound to dominate; the TTL gates.
    assert_eq!(
        classify_kill_tombstone(9_000, None, now),
        KillTombstoneVerdict::Fresh
    );
    assert_eq!(
        classify_kill_tombstone(9_000, Some((RowState::Retired, 9_500)), now),
        KillTombstoneVerdict::Fresh,
        "a Retired row's tombstone counts Fresh-or-Expired by the clock, never dominance"
    );
    assert_eq!(
        classify_kill_tombstone(9_000, None, 9_000 + KILL_TOMBSTONE_TTL_MS + 1),
        KillTombstoneVerdict::Expired
    );
}

#[test]
fn dominant_kill_tombstone_keys_answers_only_rows_a_close_outranks() {
    let root = temp_root("kill-tombstone-dominant-keys");
    let ledger = PaneLedger::new(Some(root.clone()));
    // A DOMINANT pair: Bound row's liveness predates the close.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "dominated", 9_000))
        .unwrap();
    hand_craft_remnant(&root, "claude", "dominated", 10_000);
    // A retired row: nothing Bound to dominate.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "contained", 9_000))
        .unwrap();
    ledger.retire_closed("claude", "contained", 10_000).unwrap();
    // A CLAIM-RESIDUE pair: the committed claim's row postdates the close.
    // Written as raw FILES + reload — the write consult would (correctly)
    // suppress a tombstoned refresh, so the residue pair is constructed the
    // way the crash leaves it.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "residue", 9_000))
        .unwrap();
    hand_craft_remnant(&root, "claude", "residue", 10_000);
    let mut residue_row = ledger.load_binding("claude", "residue").unwrap();
    residue_row.updated_at = 11_000;
    residue_row.last_observed_at = 11_000;
    write_row_atomic(
        &PaneLedger::binding_path(&root, "claude", "residue"),
        &residue_row,
    )
    .unwrap();
    // A tombstone with NO row: fenced orphans, not dominance.
    ledger.retire_closed("codex", "no-row", 10_000).unwrap();

    let ledger = PaneLedger::new(Some(root.clone())); // reload the crafted state
    let keys = ledger.dominant_kill_tombstone_keys();
    assert_eq!(
        keys.into_iter().collect::<Vec<_>>(),
        vec![("claude".to_string(), "dominated".to_string())],
        "only the dominated Bound row answers — dominance is TTL-free and residue/blanks are excluded"
    );
    // A disabled ledger answers empty (never an error).
    assert!(PaneLedger::disabled()
        .dominant_kill_tombstone_keys()
        .is_empty());
    std::fs::remove_dir_all(&root).ok();
}

/// Focused-ep5-r3 Finding 4 (the finding's exact shape): the tombstone write
/// landed, the row retire never did, and the restart comes AFTER the 6h TTL.
/// Dominance must still converge the Bound remnant — boot AND periodic
/// schedules — because the pair, not the clock, owns the pruning decision:
/// the tombstone prunes only once its row is converged/retired.
#[test]
fn a_post_ttl_dominant_pair_still_converges_and_only_then_prunes() {
    let root = temp_root("kill-tombstone-post-ttl-dominance");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "remnant-old", 1_000))
        .unwrap();
    // The split-write remnant (tombstone down, retire lost), both artifacts
    // far past the TTL at sweep time.
    hand_craft_remnant(&root, "claude", "remnant-old", 10_000);
    let now = 10_000 + KILL_TOMBSTONE_TTL_MS + 60_000;
    let ledger2 = PaneLedger::new(Some(root.clone())); // the post-restart load

    let report = ledger2.boot_scan(now, &never_absent, Some(&no_snapshot_refs()));
    let row = ledger2.load_binding("claude", "remnant-old").unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "a restart hours past the TTL still converges the split-write remnant — \
         the close never ages out while its row says Bound"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert!(
        report
            .kill_tombstone_enforced_retires
            .iter()
            .any(|l| l.provider == "claude" && l.session_id == "remnant-old"),
        "the post-TTL dominance retire is loudly reported: {:?}",
        report.kill_tombstone_enforced_retires
    );
    // Converged first, pruned second: the same sweep may prune the now-Retention
    // pair's tombstone (Expired over a Retired row) — but never BEFORE the row
    // converged (the caller's pass is row-then-tombstone ordered).
    assert_eq!(
        ledger2.kill_tombstone_at("claude", "remnant-old"),
        None,
        "the pair prunes only once the row is converged"
    );
    assert!(
        !PaneLedger::kill_tombstone_path(&root, "claude", "remnant-old").exists(),
        "the tombstone FILE pruned with it"
    );
    assert!(
        report
            .kill_tombstones_swept
            .iter()
            .any(|l| l.provider == "claude" && l.session_id == "remnant-old"),
        "the post-convergence prune is loudly reported"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Finding 4's binder-consult arm: an EXPIRED tombstone over a still-Bound
/// row (the remnant that survived hours past the TTL with the process
/// running) is STILL dominance — the next write attempt force-retires the
/// remnant and suppresses itself, exactly like a fresh one.
#[test]
fn a_post_ttl_tombstone_still_force_retires_the_remnant_and_suppresses_the_late_write() {
    let root = temp_root("kill-tombstone-post-ttl-write");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "remnant-w", 1_000))
        .unwrap();
    hand_craft_remnant(&root, "claude", "remnant-w", 10_000);
    let ledger = PaneLedger::new(Some(root.clone())); // the remnant as a fresh load sees it
    let later = 10_000 + KILL_TOMBSTONE_TTL_MS + 1;
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "remnant-w", later))
        .unwrap();
    let row = ledger.load_binding("claude", "remnant-w").unwrap();
    assert_eq!(
        row.state,
        RowState::Retired,
        "an expired tombstone over a Bound row still dominates — the write force-retires the remnant"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    // The tombstone SURVIVES the suppressed write (dominance prunes only via
    // the sweeps, after the row converges): it still fences a follow-up.
    assert_eq!(
        ledger.kill_tombstone_at("claude", "remnant-w"),
        Some(10_000)
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-ep5-r3 Findings 1+3 (retire-on-kill round 4) — the conditional claim commit ──
//
// The claim lanes' commit is ONE conditional durable transition: the
// dead-state condition (Finding 1) and the crash-atomic ordering (Finding 3,
// revive-write-first then tombstone-clear cleanup) live here in the ledger.

/// The CONDITION (Finding 1): a commit whose claim-start snapshot the
/// dead-state has NOT advanced past is refused wholesale — no clear, no
/// revive, no durable mutation of any kind — while an unchanged (or absent,
/// or older) dead-state commits the reopen in one transition.
#[test]
fn commit_claim_refuses_a_newer_close_and_commits_an_unchanged_dead_state() {
    let root = temp_root("claim-claim-conditional");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "d", 9_000))
        .unwrap();
    ledger.retire_closed("claude", "d", 10_000).unwrap();
    assert_eq!(ledger.kill_tombstone_at("claude", "d"), Some(10_000));

    // A NEWER close landed mid-claim (the tombstone advanced past the
    // snapshot): REFUSED — and NOTHING moves (the refusal's side-effect
    // freedom is the finding's exact requirement).
    let outcome = ledger
        .commit_claim("claude", "d", Some(9_500), 11_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::RefusedStale);
    assert_eq!(
        ledger.kill_tombstone_at("claude", "d"),
        Some(10_000),
        "the refusal never clears the newer fence"
    );
    let row = ledger.load_binding("claude", "d").unwrap();
    assert_eq!(row.state, RowState::Retired, "the refusal never revives");
    assert_eq!(row.updated_at, 10_000, "no durable mutation at all");
    // A null snapshot against a present tombstone also refuses (a close
    // landed on an identity the claim believed untouched).
    let outcome = ledger.commit_claim("claude", "d", None, 11_000).unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::RefusedStale);

    // The UNCHANGED snapshot commits: row back to Bound AND fence cleared,
    // durable across a reload (one transition, not a split pair).
    let outcome = ledger
        .commit_claim("claude", "d", Some(10_000), 11_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    let row = ledger.load_binding("claude", "d").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    assert_eq!(row.updated_at, 11_000);
    assert_eq!(
        row.created_at, 9_000,
        "the row's own keeping survives the flip"
    );
    assert_eq!(ledger.kill_tombstone_at("claude", "d"), None);
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger2.load_binding("claude", "d").unwrap().state,
        RowState::Bound,
        "the committed reopen is durable on disk"
    );
    // Focused-episode-6 round 4 (Finding F1): the commit's fence clear is a
    // DURABLE CONSUMPTION — the journal record's entry for `d` went with it,
    // so the reload re-derives NOTHING (no "claim residue" resurrection for
    // the class-agnostic consults to misread).
    assert_eq!(
        ledger2.kill_tombstone_at("claude", "d"),
        None,
        "the consumed fence never re-feeds from its record"
    );
    assert!(
        !ledger2
            .dominant_kill_tombstone_keys()
            .contains(&("claude".to_string(), "d".to_string())),
        "never dominant at the offer boundary"
    );
    // And a LATER claim-against-no-fence commits (its snapshot is stale but
    // the dead-state only ever READS the present: unchanged/absent ⇒ commits).
    let outcome = ledger2
        .commit_claim("claude", "d", Some(10_000), 12_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);

    // Never-killed identity: commits, changes nothing.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "never-killed", 12_000))
        .unwrap();
    let before = ledger.load_binding("claude", "never-killed").unwrap();
    let outcome = ledger
        .commit_claim("claude", "never-killed", None, 13_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    assert_eq!(
        ledger.load_binding("claude", "never-killed").unwrap(),
        before,
        "an unfenced re-claim never re-stamps the row"
    );

    // Kill-before-row (fence with no row): the commit clears the fence,
    // creates NOTHING (V7 no-laundering intact).
    ledger.retire_closed("opencode", "no-row", 14_000).unwrap();
    let outcome = ledger
        .commit_claim("opencode", "no-row", Some(14_000), 15_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    assert!(ledger.load_binding("opencode", "no-row").is_none());
    assert_eq!(ledger.kill_tombstone_at("opencode", "no-row"), None);

    // Disabled ledger: the polite Committed no-op.
    assert_eq!(
        PaneLedger::disabled()
            .commit_claim("claude", "x", None, 1)
            .unwrap(),
        ClaimCommitOutcome::Committed
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The round-3 revive narrowness, carried into `commit_claim`: ONLY a
/// Retired(Closed) row flips — Superseded / SessionMissing / GcExpired
/// verdicts are never rewritten by a claim.
#[test]
fn commit_claim_keeps_the_round_3_revive_narrowness() {
    let root = temp_root("claim-claim-narrowness");
    let ledger = PaneLedger::new(Some(root.clone()));

    // SessionMissing: never revived.
    ledger
        .record_binding(&write("amplifier", "sid-m", "t1", 1_000))
        .unwrap();
    assert!(ledger.retire_missing("amplifier", "sid-m"));
    ledger.retire_closed("amplifier", "sid-m", 10_000).unwrap(); // a kill's fence over the missing-marked row
    let outcome = ledger
        .commit_claim("amplifier", "sid-m", Some(10_000), 11_000)
        .unwrap();
    assert_eq!(
        outcome,
        ClaimCommitOutcome::Committed,
        "the fence still clears"
    );
    assert_eq!(ledger.kill_tombstone_at("amplifier", "sid-m"), None);
    let row = ledger.load_binding("amplifier", "sid-m").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(
        row.retired_reason,
        Some(RetiredReason::SessionMissing),
        "the missing verdict is never rewritten by a claim"
    );

    // Superseded: chain linkage untouched.
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "parent-s", 9_000))
        .unwrap();
    let mut child = fa_write("claude", "child-s", 9_100);
    child.supersedes = Some("parent-s");
    ledger.record_fresh_agent_binding(&child).unwrap();
    ledger.retire_closed("claude", "parent-s", 10_000).unwrap();
    let outcome = ledger
        .commit_claim("claude", "parent-s", Some(10_000), 11_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    assert_eq!(
        ledger
            .load_binding("claude", "parent-s")
            .unwrap()
            .retired_reason,
        Some(RetiredReason::Superseded),
        "a superseded row is never revived back over its chain"
    );
    assert_eq!(
        ledger.load_binding("claude", "parent-s").unwrap().state,
        RowState::Retired
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The claim-commit's transition over a JOURNAL-FED fence (delta-r6-r4),
/// retargeted by focused-episode-6 round 4 (Finding F1): the commit's fence
/// clear is a DURABLE CONSUMPTION — the single-kill agent record that fed
/// the fence is deleted outright (emptied, no pane linkage) — so the reload
/// re-derives NOTHING. No "claim residue" can ever seed a class-agnostic
/// read (the inventory's verdict join) that would mis-close the reopened
/// identity.
#[test]
fn commit_claim_consumes_the_journal_fed_fence_durably() {
    let root = temp_root("claim-journal-consume");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "d-crash", 9_000))
        .unwrap();
    ledger.retire_closed("claude", "d-crash", 10_000).unwrap();
    let outcome = ledger
        .commit_claim("claude", "d-crash", Some(10_000), 11_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    let row = ledger.load_binding("claude", "d-crash").unwrap();
    assert_eq!(row.state, RowState::Bound, "the revive landed durably");
    assert_eq!(
        ledger.kill_tombstone_at("claude", "d-crash"),
        None,
        "the accepted commit cleared the fence in-process"
    );
    assert!(
        !PaneLedger::close_envelope_path(&root, "claude:d-crash").exists(),
        "the emptied agent record's file is deleted with the consumption"
    );
    // The reload re-derives NO fence: the consumed record is gone.
    let ledger2 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger2.kill_tombstone_at("claude", "d-crash"),
        None,
        "nothing re-feeds from disk — the fence was consumed, not just cleared in memory"
    );
    assert_eq!(
        ledger2.load_binding("claude", "d-crash").unwrap().state,
        RowState::Bound,
        "the committed row is Bound across the restart"
    );
    // The claim's own later write is never suppressed (no fence anywhere).
    ledger2
        .record_fresh_agent_binding(&fa_write("claude", "d-crash", 12_000))
        .unwrap();
    assert_eq!(
        ledger2.load_binding("claude", "d-crash").unwrap().state,
        RowState::Bound
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Finding 3's other arm: the REVIVE write itself impeded (the bindings
/// directory went read-only) — the commit ERRORS and the close is untouched
/// (fence intact, row still Closed): no half-committed durable state exists.
#[test]
fn commit_claim_mid_revive_failure_leaves_the_close_untouched() {
    let root = temp_root("claim-mid-revive-failure");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "d-crash2", 9_000))
        .unwrap();
    ledger.retire_closed("claude", "d-crash2", 10_000).unwrap();
    let bind_dir = PaneLedger::binding_path(&root, "claude", "d-crash2")
        .parent()
        .unwrap()
        .to_path_buf();
    let mut perms = std::fs::metadata(&bind_dir).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o555);
    }
    std::fs::set_permissions(&bind_dir, perms).unwrap();

    let outcome = ledger.commit_claim("claude", "d-crash2", Some(10_000), 11_000);
    let mut perms = std::fs::metadata(&bind_dir).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
    }
    std::fs::set_permissions(&bind_dir, perms).unwrap();

    assert!(
        outcome.is_err(),
        "the impeded revive write fails the commit loudly"
    );
    let row = ledger.load_binding("claude", "d-crash2").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert_eq!(
        ledger.kill_tombstone_at("claude", "d-crash2"),
        Some(10_000),
        "the fence stands untouched"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── focused-ep5-r5 Finding 2 (retire-on-kill round 6): durable alias tombstones ──

/// The persisted placeholder→durable alias records round-trip across the
/// restart boundary (a fresh `PaneLedger` over the same root IS one): the
/// consult serves the reloaded records (freshest stamp per durable), and the
/// claim lifecycle's `clear_alias_tombstones_for_durable` consumes every
/// placeholder's record for the claimed durable (files deleted when emptied,
/// rewritten when only partially consumed).
#[test]
fn persisted_alias_tombstones_survive_a_restart_and_clear_per_durable() {
    let root = temp_root("alias-tombstone-persist");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_alias_tombstone("claude", "ph-1", "d-a", 1_000)
        .unwrap();
    ledger
        .record_alias_tombstone("claude", "ph-1", "d-b", 2_000)
        .unwrap();
    ledger
        .record_alias_tombstone("claude", "ph-2", "d-a", 3_000)
        .unwrap();
    // UPSERT: an existing (placeholder, durable) record refreshes its stamp.
    ledger
        .record_alias_tombstone("claude", "ph-1", "d-a", 4_000)
        .unwrap();

    // The restart boundary: a fresh ledger over the same root.
    let ledger2 = PaneLedger::new(Some(root.clone()));
    let mut records = ledger2.alias_tombstone_records("claude", "ph-1");
    records.sort();
    assert_eq!(
        records,
        vec![("d-a".to_string(), 4_000), ("d-b".to_string(), 2_000)],
        "the persisted records survive the reload (freshest stamp kept)"
    );
    assert!(
        ledger2
            .alias_tombstone_records("claude", "ph-none")
            .is_empty(),
        "an unknown placeholder answers empty"
    );
    assert!(
        ledger2.alias_tombstone_records("codex", "ph-1").is_empty(),
        "the records are provider-namespaced"
    );

    // The claim consumption: d-a's every record is consumed (across ph-1 AND
    // ph-2, sorted for a stable contract); d-b's stands.
    let cleared = ledger2
        .clear_alias_tombstones_for_durable("claude", "d-a")
        .unwrap();
    assert_eq!(cleared, vec!["ph-1".to_string(), "ph-2".to_string()]);
    assert_eq!(
        ledger2.alias_tombstone_records("claude", "ph-1"),
        vec![("d-b".to_string(), 2_000)],
        "the partially-consumed placeholder keeps its other durable (rewritten file)"
    );
    assert!(
        ledger2.alias_tombstone_records("claude", "ph-2").is_empty(),
        "the fully-consumed placeholder is gone"
    );
    assert!(
        !PaneLedger::alias_tombstone_path(&root, "claude", "ph-2").exists(),
        "the emptied record's FILE is deleted"
    );

    // The consumption is durable too: one more restart sees the same shape.
    let ledger3 = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        ledger3.alias_tombstone_records("claude", "ph-1"),
        vec![("d-b".to_string(), 2_000)]
    );
    assert!(ledger3.alias_tombstone_records("claude", "ph-2").is_empty());
    std::fs::remove_dir_all(&root).ok();
}

/// The alias record lifetime IS the row lifetime (the round-5 discipline,
/// now durable): the sweep drops a record past the TTL only when its durable
/// row is already Retired-or-GC'd; a still-Bound row's record answers at ANY
/// age. A partial expiry REWRITES the placeholder's file (dropping the dead
/// half, keeping the live); a fully-expired placeholder's file is deleted.
#[test]
fn the_alias_tombstone_sweep_drops_only_records_whose_rows_are_gone() {
    let root = temp_root("alias-tombstone-gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "d-bound", 1_000))
        .unwrap();
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "d-gone", 1_000))
        .unwrap();
    ledger.retire_closed("claude", "d-gone", 2_000).unwrap();
    ledger
        .record_alias_tombstone("claude", "ph-live", "d-bound", 3_000)
        .unwrap();
    ledger
        .record_alias_tombstone("claude", "ph-live", "d-gone", 3_000)
        .unwrap();
    ledger
        .record_alias_tombstone("claude", "ph-dead", "d-gone", 3_000)
        .unwrap();

    let now = 3_000 + ALIAS_TOMBSTONE_TTL_MS + 60_000; // every record past TTL
    let report = ledger.gc(now, &|_, _| false, None, Some(&no_snapshot_refs()));

    assert_eq!(
        ledger.alias_tombstone_records("claude", "ph-live"),
        vec![("d-bound".to_string(), 3_000)],
        "the half whose row is still Bound is kept at ANY age; the Retired half is pruned"
    );
    assert!(
        PaneLedger::alias_tombstone_path(&root, "claude", "ph-live").exists(),
        "the partially-kept placeholder's file was rewritten, not deleted"
    );
    assert!(
        ledger
            .alias_tombstone_records("claude", "ph-dead")
            .is_empty(),
        "a placeholder whose every record's row is gone is swept whole"
    );
    assert!(
        !PaneLedger::alias_tombstone_path(&root, "claude", "ph-dead").exists(),
        "its file is deleted"
    );
    assert!(
        report
            .alias_tombstones_swept
            .iter()
            .any(|l| l.provider == "claude" && l.session_id == "ph-dead"),
        "the whole-record sweep is loudly reported: {:?}",
        report.alias_tombstones_swept
    );

    // The kept half ages out only once its row is gone (retire it now; the
    // next sweep at the same clock prunes it).
    ledger.retire_closed("claude", "d-bound", now).unwrap();
    let report2 = ledger.gc(now, &|_, _| false, None, Some(&no_snapshot_refs()));
    assert!(ledger
        .alias_tombstone_records("claude", "ph-live")
        .is_empty());
    assert!(
        report2
            .alias_tombstones_swept
            .iter()
            .any(|l| l.provider == "claude" && l.session_id == "ph-live"),
        "now its row is gone, the aged record sweeps too"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The commit's PLACEHOLDER-fence consult (Finding 2's second half): a fence
/// recorded under ANY placeholder the claim rides blocks the commit exactly
/// like one recorded under the durable id — refusal is side-effect-free on
/// every axis (no fence clear, no row mutation) and loudly logged; an
/// unfenced placeholder commits through the ordinary durable compare.
#[test]
fn commit_claim_aliased_refuses_on_a_placeholder_fence_and_commits_past_a_clean_one() {
    let root = temp_root("commit-claim-aliased");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_fresh_agent_binding(&fa_write("claude", "d", 9_000))
        .unwrap();
    // No durable close — the durable compare is CLEAN; the close fence lives
    // only under the pane seat the claim rides.
    ledger.retire_closed("claude", "seat-ph", 10_000).unwrap();

    let outcome = ledger
        .commit_claim_aliased("claude", "d", None, &["seat-ph".to_string()], 11_000)
        .unwrap();
    assert_eq!(
        outcome,
        ClaimCommitOutcome::RefusedStale,
        "a fence under the placeholder blocks the commit exactly like one under the durable"
    );
    assert_eq!(
        ledger.kill_tombstone_at("claude", "seat-ph"),
        Some(10_000),
        "the refusal never clears the placeholder's fence"
    );
    let row = ledger.load_binding("claude", "d").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.updated_at, 9_000, "the refusal never touches the row");

    // The UNFENCED seat commits through the ordinary durable compare (kill
    // then claim — the genuine reopen shape, carried from round 4).
    ledger.retire_closed("claude", "d", 12_000).unwrap();
    let outcome = ledger
        .commit_claim_aliased(
            "claude",
            "d",
            Some(12_000),
            &["seat-clean".to_string()],
            13_000,
        )
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    let row = ledger.load_binding("claude", "d").unwrap();
    assert_eq!(row.state, RowState::Bound, "the commit revived the row");
    assert_eq!(ledger.kill_tombstone_at("claude", "d"), None);
    // ...never touching the refused placeholder's fence (two identities).
    assert_eq!(ledger.kill_tombstone_at("claude", "seat-ph"), Some(10_000));
    std::fs::remove_dir_all(&root).ok();
}

/// The new subtree participates in per-row quarantine (typed row, version
/// gate): a corrupt alias record is renamed aside loudly, never crashes the
/// boot, and never shadows the healthy records around it.
#[test]
fn a_corrupt_alias_tombstone_row_quarantines_loudly() {
    let root = temp_root("alias-tombstone-corrupt");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_alias_tombstone("claude", "ph-good", "d-a", 1_000)
        .unwrap();
    let bad = PaneLedger::alias_tombstone_path(&root, "claude", "ph-bad");
    std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
    std::fs::write(&bad, b"{ not json").unwrap();

    let report = ledger.boot_scan(2_000, &never_absent, Some(&no_snapshot_refs()));
    assert_eq!(
        report.quarantined.len(),
        1,
        "the corrupt row is quarantined"
    );
    assert!(!bad.exists(), "renamed aside, not deleted");
    assert_eq!(
        ledger.alias_tombstone_records("claude", "ph-good"),
        vec![("d-a".to_string(), 1_000)],
        "the healthy record is still served"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Delta-r6-r4 (focused-episode-6 round 3, Finding 3): the close's failure classes,
// replacing the delta-r6-r2 phase-attribedpair model — ONE journal record, never
// a tombstone/retire split pair to compensate. ──

/// The close is ONE journal record: a fence that stands with it is the close
/// itself (durable across a reload), and the row's flip is its projection
/// (arm the projection write to fail: the close still answers `Ok`, the row
/// reads dominated-never-offered, and the sweep converges it once writes
/// heal). There is no partial pair to repair — the pre-journal
/// tombstone-landed/retire-missed shape cannot exist.
#[test]
fn a_close_is_one_record_and_a_failed_row_projection_is_dominance_covered_hygiene() {
    let root = temp_root("one-record-close");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-one", "term-one", 1_000))
        .unwrap();
    // The projection's write fails once (transient fs fault). The RECORD is
    // the close: it must answer Ok and stand durably.
    ledger.fail_next_binding_writes(1);
    ledger
        .retire_closed("codex", "sess-one", 2_000)
        .expect("the journal record lands; the projection is hygiene");
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-one"), Some(2_000));
    let row = ledger.load_binding("codex", "sess-one").unwrap();
    assert_eq!(
        row.state,
        RowState::Bound,
        "the projection missed: raw Bound, masked by dominance (never offered)"
    );
    assert!(
        ledger
            .dominant_kill_tombstone_keys()
            .contains(&("codex".to_string(), "sess-one".to_string())),
        "the fence-dominated Bound row reads closed at every offer boundary"
    );
    // The fence is durable (it lives IN the record, durable on disk).
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(disk.kill_tombstone_at("codex", "sess-one"), Some(2_000));
    // The sweep converges the remnant once writes heal (the knob is spent).
    let report = ledger.gc(3_000, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report
            .kill_tombstone_enforced_retires
            .iter()
            .any(|s| s.session_id == "sess-one"),
        "the sweep re-applied the retirement durably: {report:?}"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        disk.load_binding("codex", "sess-one").unwrap().state,
        RowState::Retired
    );
    std::fs::remove_dir_all(&root).ok();
}

/// A close whose RECORD write fails reports a clean failure — nothing
/// durable (row Bound, no fence, nothing on disk) and a retried close
/// succeeds idempotently. (The pre-journal model needed compensation to
/// approach this; the single record has no partial state by construction.)
#[test]
fn a_close_whose_record_write_fails_is_a_clean_failure_with_no_residue() {
    let root = temp_root("clean-failure");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-cf", "term-cf", 1_000))
        .unwrap();
    ledger.fail_next_close_envelope_writes(1);
    let err = ledger
        .retire_closed("codex", "sess-cf", 2_000)
        .expect_err("the record write failure surfaces");
    assert!(!err.is_persisted(), "nothing landed: a CLEAN failure");
    assert_eq!(
        ledger.load_binding("codex", "sess-cf").unwrap().state,
        RowState::Bound,
        "the row was never touched"
    );
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-cf"), None);
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        disk.load_binding("codex", "sess-cf").unwrap().state,
        RowState::Bound
    );
    assert_eq!(disk.kill_tombstone_at("codex", "sess-cf"), None);
    // Retry succeeds idempotently (the knob is spent).
    ledger
        .retire_closed("codex", "sess-cf", 3_000)
        .expect("the retried close lands");
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-cf"), Some(3_000));
    std::fs::remove_dir_all(&root).ok();
}

/// F1: a close records the pane identity durably — the `close-records`
/// subtree survives a restart, keeps the createRequestId lineage, and lists
/// every identity the close retired.
#[test]
fn a_close_pane_records_the_close_under_the_pane_identity_and_survives_a_restart() {
    let root = temp_root("pane-close-roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&BindingWrite {
            create_request_id: Some("cr-close-1"),
            ..write("codex", "sess-pc", "term-pc", 1_000)
        })
        .unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-pc".to_string(),
            create_request_id: Some("cr-close-1".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-pc".into(),
            }],
            now_ms: 2_000,
        })
        .unwrap();

    let row = ledger.load_binding("codex", "sess-pc").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-pc"), Some(2_000));

    // The record is durable: a fresh ledger over the same root serves it.
    let disk = PaneLedger::new(Some(root.clone()));
    let closes = disk.list_pane_closes();
    assert_eq!(closes.len(), 1, "exactly one pane close record");
    let record = &closes[0];
    assert_eq!(record.terminal_id, "term-pc");
    assert_eq!(record.create_request_id.as_deref(), Some("cr-close-1"));
    assert_eq!(
        record
            .kills
            .iter()
            .map(|k| (k.provider.as_str(), k.session_id.as_str(), k.at_ms))
            .collect::<Vec<_>>(),
        vec![("codex", "sess-pc", 2_000)]
    );
    assert!(
        disk.pane_close_for_terminal("term-pc").is_some(),
        "the verdict consult finds the close by terminal id"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// F1+F2: the close retires by PANE identity under the ledger's own
/// serialization — a row bound to this terminal is retired even when the kill
/// captured no in-memory sessionRef (the identity registry had not been
/// upserted / the resolver had not run when the kill started).
#[test]
fn a_close_pane_retires_rows_by_pane_identity_when_no_identity_was_captured() {
    let root = temp_root("pane-close-bytid");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("opencode", "sess-late-bind", "term-bytid", 1_000))
        .unwrap();
    // The kill captured NOTHING (`resolved` empty) — the row is discovered
    // under the guard by its pane owner (live_terminal_id).
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-bytid".to_string(),
            create_request_id: Some("cr-bytid".to_string()),
            resolved: vec![],
            now_ms: 2_000,
        })
        .unwrap();
    let row = ledger.load_binding("opencode", "sess-late-bind").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    let record = ledger
        .pane_close_for_terminal("term-bytid")
        .expect("close record");
    assert!(
        record
            .kills
            .iter()
            .any(|k| k.provider == "opencode" && k.session_id == "sess-late-bind"),
        "the record lists the discovered identity: {record:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// F2 (order A): the close lands FIRST; the resolver running afterwards must
/// consult the close record — the row lands Retired(Closed), never Bound,
/// the identity's kill fence folds, and the record gains the now-known
/// identity key.
#[test]
fn a_resolve_pending_after_a_close_pane_lands_the_row_retired_never_bound() {
    let root = temp_root("close-then-resolve");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "term-cr",
            "codex",
            Some("/tmp/proj"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-cr".to_string(),
            create_request_id: Some("cr-cr".to_string()),
            resolved: vec![],
            now_ms: 2_000,
        })
        .unwrap();
    // The late resolver (locator/signal lane) makes the identity durable.
    ledger
        .resolve_pending(&write("codex", "sess-resolved-late", "term-cr", 3_000))
        .unwrap();
    let row = ledger
        .load_binding("codex", "sess-resolved-late")
        .expect("the row exists — as retired evidence, never Bound");
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert_eq!(row.live_terminal_id.as_deref(), Some("term-cr"));
    assert_eq!(
        ledger.kill_tombstone_at("codex", "sess-resolved-late"),
        Some(3_000),
        "the resolve folds the identity's kill fence"
    );
    assert!(
        !ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == "term-cr"),
        "the marker is consumed by the resolve"
    );
    let record = ledger.pane_close_for_terminal("term-cr").expect("record");
    assert!(
        record
            .kills
            .iter()
            .any(|k| k.provider == "codex" && k.session_id == "sess-resolved-late"),
        "the pane close record gained the now-known identity: {record:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// F2 (order B — the finding's exact interleave): the resolver is SUSPENDED
/// mid-write (inside `resolve_pending`, before its close-record consult sees
/// anything) while the kill's durable phase queues behind the ledger guard.
/// The resolver writes the row Bound; the kill — whose whole point is that it
/// retires under the ledger's own serialization — retires the just-written
/// row when it runs.
#[test]
fn a_close_pane_parked_behind_a_mid_write_resolve_retires_the_row_the_resolver_wrote() {
    let root = temp_root("resolve-then-close");
    let ledger = std::sync::Arc::new(PaneLedger::new(Some(root.clone())));
    ledger
        .record_pending(
            "term-rc",
            "opencode",
            Some("/tmp/proj"),
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();

    let gate = ledger.arm_resolve_pending_gate();
    let resolve_ledger = std::sync::Arc::clone(&ledger);
    let resolver = std::thread::spawn(move || {
        resolve_ledger
            .resolve_pending(&write("opencode", "sess-raced", "term-rc", 2_000))
            .expect("resolve completes")
    });
    gate.entered
        .recv_timeout(std::time::Duration::from_secs(15))
        .expect("the resolver entered resolve_pending (guard held, consult not yet run)");

    // The kill's durable phase queues on the guard while the resolver is
    // suspended: the row does not exist yet — the kill's captured identity
    // set is EMPTY, exactly the finding's shape.
    let close_ledger = std::sync::Arc::clone(&ledger);
    let closer = std::thread::spawn(move || {
        close_ledger
            .close_pane(&PaneCloseWrite {
                terminal_id: "term-rc".to_string(),
                create_request_id: Some("cr-rc".to_string()),
                resolved: vec![],
                now_ms: 3_000,
            })
            .expect("close completes")
    });
    // Release the resolver: it writes the row Bound (no close record was
    // consultable at its consult instant), then the queued close runs and
    // must retire what the resolver just wrote.
    gate.release.send(()).expect("release the resolver");
    resolver.join().expect("resolver done");
    closer.join().expect("closer done");

    let row = ledger
        .load_binding("opencode", "sess-raced")
        .expect("the resolved row exists");
    assert_eq!(
        row.state,
        RowState::Retired,
        "the kill retired the row the resolver wrote mid-race (never a Bound orphan)"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    let record = ledger.pane_close_for_terminal("term-rc").expect("record");
    assert!(
        record
            .kills
            .iter()
            .any(|k| k.provider == "opencode" && k.session_id == "sess-raced"),
        "the pane close record lists the raced identity: {record:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// F6 for the pane close: when EVERY write fails, the close reports failure
/// and leaves nothing durable — no tombstone, untouched row, no record.
#[cfg(unix)]
#[test]
fn a_close_pane_whose_writes_all_fail_leaves_nothing_durable() {
    use std::os::unix::fs::PermissionsExt;
    fn deny_recursive(path: &std::path::Path) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o555)).unwrap();
        if path.is_dir() {
            for entry in std::fs::read_dir(path).unwrap().flatten() {
                deny_recursive(&entry.path());
            }
        }
    }
    fn allow_recursive(path: &std::path::Path) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        if path.is_dir() {
            for entry in std::fs::read_dir(path).unwrap().flatten() {
                if entry.path().is_dir() {
                    allow_recursive(&entry.path());
                } else {
                    std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o644))
                        .ok();
                }
            }
        }
    }
    let root = temp_root("pane-close-allfail");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-nofail", "term-nofail", 1_000))
        .unwrap();
    ledger
        .record_pending(
            "term-nofail",
            "codex",
            None,
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    // Baseline: the marker exists before the close attempt.
    assert!(ledger
        .list_pending_raw()
        .iter()
        .any(|m| m.terminal_id == "term-nofail"));

    deny_recursive(&root);
    let err = ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-nofail".to_string(),
            create_request_id: Some("cr-nofail".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-nofail".into(),
            }],
            now_ms: 2_000,
        })
        .expect_err("a fully broken store fails the close");
    allow_recursive(&root);
    assert!(
        !err.is_persisted(),
        "the record provably never landed: a CLEAN failure (nothing durable)"
    );
    assert!(!err.to_string().is_empty());
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        disk.load_binding("codex", "sess-nofail").unwrap().state,
        RowState::Bound,
        "the row stands (the kill reports failure; nothing mis-restores)"
    );
    assert_eq!(disk.kill_tombstone_at("codex", "sess-nofail"), None);
    assert!(
        disk.list_pane_closes().is_empty(),
        "no pane close record was written"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The boot/periodic sweep drops a pane close record only once its newest
/// stamp aged past the protective TTL; a recent record always survives.
#[test]
fn the_pane_close_sweep_drops_only_fully_aged_records() {
    let root = temp_root("pane-close-sweep");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-old".to_string(),
            create_request_id: Some("cr-old".to_string()),
            resolved: vec![],
            now_ms: 1_000,
        })
        .unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-fresh".to_string(),
            create_request_id: Some("cr-fresh".to_string()),
            resolved: vec![],
            now_ms: 10_000,
        })
        .unwrap();
    let now = 1_000 + KILL_TOMBSTONE_TTL_MS + 1; // only term-old's record aged out
    let report = ledger.gc(now, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report
            .pane_closes_swept
            .contains(&"pane:term-old".to_string()),
        "the aged record was swept (record keys carry the lane prefix): {report:?}"
    );
    assert!(ledger.pane_close_for_terminal("term-old").is_none());
    assert!(
        ledger.pane_close_for_terminal("term-fresh").is_some(),
        "the fresh record survives"
    );
    // And the sweep's pair is durable: a reloaded ledger answers the same.
    let disk = PaneLedger::new(Some(root.clone()));
    assert!(disk.pane_close_for_terminal("term-old").is_none());
    std::fs::remove_dir_all(&root).ok();
}

/// BOTH close-record subtrees participate in per-row quarantine (typed rows,
/// version gate), exactly like the other ledger subtrees: the legacy
/// `close-records/` pane records and the close-envelope journal files.
#[test]
fn a_corrupt_pane_close_record_quarantines_loudly() {
    let root = temp_root("pane-close-corrupt");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-good".to_string(),
            create_request_id: Some("cr-good".to_string()),
            resolved: vec![],
            now_ms: 1_000,
        })
        .unwrap();
    let bad_legacy = PaneLedger::pane_close_path(&root, "term-bad");
    std::fs::create_dir_all(bad_legacy.parent().unwrap()).unwrap();
    std::fs::write(&bad_legacy, b"{ not json").unwrap();
    let bad_envelope = PaneLedger::close_envelope_path(&root, "claude:bad-key");
    std::fs::create_dir_all(bad_envelope.parent().unwrap()).unwrap();
    std::fs::write(&bad_envelope, b"{ not json").unwrap();
    let report = ledger.boot_scan(2_000, &never_absent, Some(&no_snapshot_refs()));
    assert_eq!(
        report.quarantined.len(),
        2,
        "the corrupt records in BOTH subtrees are quarantined: {:?}",
        report.quarantined
    );
    assert!(!bad_legacy.exists(), "renamed aside, not deleted");
    assert!(!bad_envelope.exists(), "renamed aside, not deleted");
    assert!(
        ledger.pane_close_for_terminal("term-good").is_some(),
        "the healthy record is still served"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ── Delta-r6-r4 (focused-episode-6 round 3, Finding 3): ONE journal record per close ──

/// The continuing-failure staging the pre-journal model could not survive
/// honestly: the identity's provider bindings dir is read-only, so the Bound
/// row's Retired projection can NEVER land. Under the single-record close
/// envelope the close is STILL durable — the journal record IS the close;
/// the row flip is a projection — so `close_pane` reports `Ok`, the close
/// fence stands, the still-Bound row reads dominated (never offerable), and
/// a later sweep with the dir healed converges it durably. NEVER the
/// pre-fix shape this round's Finding 3 names: `Err` reported as though the
/// rollback had completed, with durable Closed evidence left over a session
/// the killer then kept live.
#[cfg(unix)]
#[test]
fn a_close_whose_row_projection_fails_still_closes_durably_and_converges_at_the_sweep() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("projection-fails");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-pj", "term-pj", 1_000))
        .unwrap();
    let codex_rows = PaneLedger::bindings_dir(&root).join(encode_segment("codex"));
    std::fs::set_permissions(&codex_rows, std::fs::Permissions::from_mode(0o555)).unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-pj".to_string(),
            create_request_id: Some("cr-pj".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-pj".into(),
            }],
            now_ms: 2_000,
        })
        .expect("the journal record lands; the unwritable row projection is hygiene, not a close failure");
    std::fs::set_permissions(&codex_rows, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        ledger.kill_tombstone_at("codex", "sess-pj"),
        Some(2_000),
        "the close fence stands (fed by the journal record)"
    );
    let row = ledger.load_binding("codex", "sess-pj").unwrap();
    assert!(
        ledger
            .dominant_kill_tombstone_keys()
            .contains(&("codex".to_string(), "sess-pj".to_string())),
        "the unconverged Bound row is dominated — it reads closed at every offer boundary"
    );
    assert_eq!(
        row.state,
        RowState::Bound,
        "the projection never landed: the row is raw Bound, masked by dominance (never offered)"
    );
    // The sweep converges the remnant durably once the dir healed.
    let report = ledger.gc(3_000, &|_, _| false, None, Some(&no_snapshot_refs()));
    assert!(
        report
            .kill_tombstone_enforced_retires
            .iter()
            .any(|s| s.session_id == "sess-pj"),
        "the sweep re-applied the retirement durably: {report:?}"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        disk.load_binding("codex", "sess-pj").unwrap().state,
        RowState::Retired,
        "converged across a restart"
    );
    assert_eq!(disk.kill_tombstone_at("codex", "sess-pj"), Some(2_000));
    std::fs::remove_dir_all(&root).ok();
}

/// The "doesn't exist" side of the journal-write failure: the envelope
/// record can never land (read-only close-envelope dir), so the close reports
/// a CLEAN failure — no record, no fence, no row flip, no marker consumed —
/// and a retried close after the dir heals succeeds idempotently.
#[cfg(unix)]
#[test]
fn a_close_envelope_whose_record_write_fails_reports_clean_and_leaves_nothing_durable() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("envelope-clean");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-cl", "term-cl", 1_000))
        .unwrap();
    ledger
        .record_pending(
            "term-cl",
            "codex",
            None,
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    let env_dir = PaneLedger::close_envelope_dir(&root);
    std::fs::create_dir_all(&env_dir).unwrap();
    std::fs::set_permissions(&env_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let err = ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-cl".to_string(),
            create_request_id: Some("cr-cl".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-cl".into(),
            }],
            now_ms: 2_000,
        })
        .expect_err("the record write fails");
    assert!(
        !err.is_persisted(),
        "the record provably never landed: a CLEAN failure, not persisted-close"
    );
    std::fs::set_permissions(&env_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-cl"), None);
    assert_eq!(
        ledger.load_binding("codex", "sess-cl").unwrap().state,
        RowState::Bound,
        "no projection ran behind a failed close"
    );
    assert!(ledger.pane_close_for_terminal("term-cl").is_none());
    assert!(
        ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == "term-cl"),
        "the marker is consumed only by a durable close"
    );
    // Heal + retry: the close completes idempotently.
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-cl".to_string(),
            create_request_id: Some("cr-cl".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-cl".into(),
            }],
            now_ms: 3_000,
        })
        .expect("the retried close completes");
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-cl"), Some(3_000));
    assert_eq!(
        ledger.load_binding("codex", "sess-cl").unwrap().state,
        RowState::Retired
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Rollback-target side B: the journal write LANDS but reports failure (the
/// rename-committed / post-rename-fsync / EINTR class — staged by the
/// land-then-error knob). With no prior record at the key the rollback is
/// exactly "delete the one file": it succeeds, the caller hears a CLEAN
/// failure, and NO prior durable close state survives (no record, no fence,
/// no row flip).
#[test]
fn a_close_envelope_reported_failed_after_landing_rolls_back_to_nothing() {
    let root = temp_root("envelope-rollback-delete");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-rd", "term-rd", 1_000))
        .unwrap();
    ledger.land_then_fail_next_close_envelope_writes(1);
    let err = ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-rd".to_string(),
            create_request_id: Some("cr-rd".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-rd".into(),
            }],
            now_ms: 2_000,
        })
        .expect_err("the write reports failure although the record landed");
    assert!(
        !err.is_persisted(),
        "the rollback delete succeeded: NOTHING of the envelope survives"
    );
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-rd"), None);
    assert_eq!(
        ledger.load_binding("codex", "sess-rd").unwrap().state,
        RowState::Bound
    );
    assert!(ledger.pane_close_for_terminal("term-rd").is_none());
    let disk = PaneLedger::new(Some(root.clone()));
    assert!(disk.pane_close_for_terminal("term-rd").is_none());
    assert_eq!(disk.kill_tombstone_at("codex", "sess-rd"), None);
    // A retried kill re-attempts idempotently.
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-rd".to_string(),
            create_request_id: Some("cr-rd".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-rd".into(),
            }],
            now_ms: 3_000,
        })
        .expect("the retry lands the close");
    std::fs::remove_dir_all(&root).ok();
}

/// Rollback-target side C — the finding's continuing failure AT the rollback
/// target: the write landed-then-failed AND the rollback delete cannot remove
/// the file. The journal record then provably STANDS: the caller's error
/// reports PERSISTED-close (never the pre-fix "Err as though rollback had
/// completed"), the index models the durable state (fence fed), the close
/// is durable across a restart, and the kill lane's contract (end the
/// session so live state stays consistent with the durable close; answer a
/// VISIBLE failure) is what the error class drives.
#[test]
fn a_close_envelope_whose_rollback_delete_fails_reports_persisted_close() {
    let root = temp_root("envelope-persisted");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-pe", "term-pe", 1_000))
        .unwrap();
    ledger
        .record_pending(
            "term-pe",
            "codex",
            None,
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger.land_then_fail_next_close_envelope_writes(1);
    ledger.fail_next_close_envelope_deletes(1);
    let err = ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-pe".to_string(),
            create_request_id: Some("cr-pe".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-pe".into(),
            }],
            now_ms: 2_000,
        })
        .expect_err("the write reported failure and the rollback delete failed too");
    assert!(
        err.is_persisted(),
        "the record stands: the error MUST report persisted-close"
    );
    assert_eq!(
        ledger.kill_tombstone_at("codex", "sess-pe"),
        Some(2_000),
        "the index models the durable close (the fence is fed)"
    );
    let record = ledger
        .pane_close_for_terminal("term-pe")
        .expect("the record stands in the index");
    assert!(
        record
            .kills
            .iter()
            .any(|k| k.provider == "codex" && k.session_id == "sess-pe"),
        "the record covers the close: {record:?}"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    assert!(
        disk.pane_close_for_terminal("term-pe").is_some(),
        "the journal record is durable across a reload"
    );
    assert_eq!(
        disk.kill_tombstone_at("codex", "sess-pe"),
        Some(2_000),
        "the fence re-derives from the record"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The agent lane's envelope (`close_identities`) rides the SAME journal
/// protocol: a clean failure leaves nothing durable; the batched fence set
/// lands with the ONE record; markers delete only once the close is durable.
#[test]
fn a_close_identities_envelope_is_one_journal_record() {
    let root = temp_root("agents-envelope");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("opencode", "ses-a", "term-a", 1_000))
        .unwrap();
    ledger
        .record_pending(
            "ph-x",
            "opencode",
            None,
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    // Side A: the write never lands — clean failure, nothing durable.
    ledger.fail_next_close_envelope_writes(1);
    let err = ledger
        .close_identities(
            "opencode",
            &["ses-a".to_string(), "ph-x".to_string()],
            &["ph-x".to_string()],
            2_000,
        )
        .expect_err("the armed write failure fails the envelope");
    assert!(!err.is_persisted());
    assert_eq!(ledger.kill_tombstone_at("opencode", "ses-a"), None);
    assert_eq!(ledger.kill_tombstone_at("opencode", "ph-x"), None);
    assert_eq!(
        ledger.load_binding("opencode", "ses-a").unwrap().state,
        RowState::Bound
    );
    assert!(
        ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == "ph-x"),
        "markers delete only once the close is durable"
    );
    // Success: ONE record carries the whole set; the flip lands; the marker goes.
    ledger
        .close_identities(
            "opencode",
            &["ses-a".to_string(), "ph-x".to_string()],
            &["ph-x".to_string()],
            3_000,
        )
        .expect("the envelope lands");
    assert_eq!(ledger.kill_tombstone_at("opencode", "ses-a"), Some(3_000));
    assert_eq!(ledger.kill_tombstone_at("opencode", "ph-x"), Some(3_000));
    assert_eq!(
        ledger.load_binding("opencode", "ses-a").unwrap().state,
        RowState::Retired
    );
    assert!(ledger
        .list_pending_raw()
        .iter()
        .all(|m| m.terminal_id != "ph-x"));
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(disk.kill_tombstone_at("opencode", "ph-x"), Some(3_000));
    std::fs::remove_dir_all(&root).ok();
}

// ── Delta-r6-r3 (focused-episode-6 round 2): fail-fast phases + ONE close envelope ──

/// Delta-r6-r4 supersedes the fail-fast phase pair: there IS no tombstone
/// write separate from the row flip — the whole close is ONE journal record,
/// and the row flip is its projection. A failed record write reports a clean
/// failure with NOTHING durable (pin:
/// `a_close_whose_record_write_fails_is_a_clean_failure_with_no_residue`,
/// `a_close_envelope_whose_record_write_fails_reports_clean_and_leaves_nothing_durable`);
/// a failed projection is dominance-covered hygiene that never fails the
/// close (pin: `a_close_is_one_record_and_a_failed_row_projection_is_dominance_covered_hygiene`,
/// `a_close_whose_row_projection_fails_still_closes_durably_and_converges_at_the_sweep`).
/// The inverse hazard those replaced tests guarded — durable Closed evidence
/// riding beside a kill that reports failure — is what
/// `a_close_envelope_whose_rollback_delete_fails_reports_persisted_close`
/// now pins honestly (the caller hears persisted-close and ends the session).
///
/// F2 (ordering): the pending marker is deleted only AFTER the pane close
/// RECORD persists. For a pre-resolution close (no rows, no captured
/// identity) the marker is the only pre-existing evidence tying the pane to
/// the attempted creation; deleting it before the record write means a
/// record-write failure (or interruption) leaves NEITHER artifact, and a
/// stale snapshot receives no closed verdict.
#[cfg(unix)]
#[test]
fn a_close_pane_writes_the_close_record_before_the_pending_marker_is_deleted() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("record-before-marker");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_pending(
            "term-rbm",
            "codex",
            None,
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    assert!(ledger
        .list_pending_raw()
        .iter()
        .any(|m| m.terminal_id == "term-rbm"));
    // The close-envelope dir is read-only: the record write fails. Nothing
    // else may have been consumed by then — above all NOT the marker.
    let closes_dir = PaneLedger::close_envelope_dir(&root);
    std::fs::create_dir_all(&closes_dir).unwrap();
    std::fs::set_permissions(&closes_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let err = ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-rbm".to_string(),
            create_request_id: Some("cr-rbm".to_string()),
            resolved: vec![],
            now_ms: 2_000,
        })
        .expect_err("a read-only close-records dir fails the close");
    assert!(!err.to_string().is_empty());
    assert!(
        ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == "term-rbm"),
        "the pending marker must OUTLIVE a failed close-record write — it is the \
         only pre-existing evidence for a pre-resolution close"
    );
    assert!(
        ledger.list_pane_closes().is_empty(),
        "no close record landed"
    );
    // Heal and retry: the close completes idempotently — record written,
    // marker deleted.
    std::fs::set_permissions(&closes_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-rbm".to_string(),
            create_request_id: Some("cr-rbm".to_string()),
            resolved: vec![],
            now_ms: 3_000,
        })
        .expect("the retried close completes");
    assert!(
        !ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == "term-rbm"),
        "a complete close deletes the marker"
    );
    let record = ledger.pane_close_for_terminal("term-rbm").expect("record");
    assert_eq!(record.create_request_id.as_deref(), Some("cr-rbm"));
    std::fs::remove_dir_all(&root).ok();
}

/// Two Bound rows close in one `close_pane`; the SECOND identity's row
/// projection can never land (read-only bindings dir). Delta-r6-r4: the
/// record carries BOTH identities atomically — the close answers `Ok` (the
/// projection is hygiene, never a close failure), the failed identity's row
/// stays raw-Bound but dominated (never offerable), and the healed sweep
/// converges it durably. NEVER the pre-journal shape: a reported failure
/// with durable Closed residue beside a session the killer kept live.
#[cfg(unix)]
#[test]
fn a_close_pane_whose_projection_fails_for_one_identity_still_closes_the_whole_set_durably() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("envelope-projection");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-first", "term-env-a", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("opencode", "sess-second", "term-env-b", 1_000))
        .unwrap();
    std::fs::create_dir_all(PaneLedger::bindings_dir(&root).join(encode_segment("opencode")))
        .unwrap();
    // The second identity's projection cannot land (read-only provider
    // bindings dir); everything else is writable.
    let opencode_rows = PaneLedger::bindings_dir(&root).join(encode_segment("opencode"));
    std::fs::set_permissions(&opencode_rows, std::fs::Permissions::from_mode(0o555)).unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-env".to_string(),
            create_request_id: Some("cr-env".to_string()),
            resolved: vec![
                SessionLocator {
                    provider: "codex".into(),
                    session_id: "sess-first".into(),
                },
                SessionLocator {
                    provider: "opencode".into(),
                    session_id: "sess-second".into(),
                },
            ],
            now_ms: 2_000,
        })
        .expect("the journal record carries BOTH identities atomically; projections are hygiene");
    std::fs::set_permissions(&opencode_rows, std::fs::Permissions::from_mode(0o755)).unwrap();
    // First identity: record + projection both landed.
    let first = ledger.load_binding("codex", "sess-first").unwrap();
    assert_eq!(first.state, RowState::Retired);
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-first"), Some(2_000));
    // Second identity: fence stands (record-fed); its row is dominated Bound
    // (never offerable) until the sweep converges it.
    assert_eq!(
        ledger.kill_tombstone_at("opencode", "sess-second"),
        Some(2_000),
        "the close fence for the failed-projection identity stands with the record"
    );
    let second = ledger.load_binding("opencode", "sess-second").unwrap();
    assert_eq!(second.state, RowState::Bound, "the projection never landed");
    assert!(
        ledger
            .dominant_kill_tombstone_keys()
            .contains(&("opencode".to_string(), "sess-second".to_string())),
        "dominated: reads closed at the offer boundary, never restored over the kill"
    );
    let record = ledger.pane_close_for_terminal("term-env").expect("record");
    for (p, s) in [("codex", "sess-first"), ("opencode", "sess-second")] {
        assert!(
            record
                .kills
                .iter()
                .any(|k| k.provider == p && k.session_id == s),
            "the ONE record covers ({p}, {s}): {record:?}"
        );
    }
    // The healed sweep converges the remnant durably.
    let report = ledger.gc(3_000, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(report
        .kill_tombstone_enforced_retires
        .iter()
        .any(|s| s.session_id == "sess-second"));
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        disk.load_binding("opencode", "sess-second").unwrap().state,
        RowState::Retired,
        "converged across a restart"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The batched identity close (`close_identities`), success: every listed id
/// gets its tombstone + row Retired(Closed) in one guarded op, the pending
/// markers delete LAST, and the whole batch is durable across a restart.
#[test]
fn a_close_identities_batch_closes_every_identity_and_deletes_markers_last() {
    let root = temp_root("close-batch");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "term-a", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("claude", "sess-b", "term-b", 1_000))
        .unwrap();
    ledger
        .record_pending(
            "ph-a",
            "claude",
            None,
            None,
            ProvenanceStamps::default(),
            1_000,
        )
        .unwrap();
    ledger
        .close_identities(
            "claude",
            &[
                "sess-a".to_string(),
                "sess-b".to_string(),
                "sess-unknown".to_string(), // unknown ids are idempotent
                "sess-a".to_string(),       // duplicates dedupe
            ],
            &["ph-a".to_string()],
            2_000,
        )
        .unwrap();
    for id in ["sess-a", "sess-b", "sess-unknown"] {
        assert_eq!(ledger.kill_tombstone_at("claude", id), Some(2_000));
    }
    for id in ["sess-a", "sess-b"] {
        let row = ledger.load_binding("claude", id).unwrap();
        assert_eq!(row.state, RowState::Retired);
        assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    }
    assert!(
        !ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == "ph-a"),
        "the marker deleted"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    for id in ["sess-a", "sess-b"] {
        assert_eq!(
            disk.load_binding("claude", id).unwrap().state,
            RowState::Retired,
            "durable across restart: {id}"
        );
        assert_eq!(disk.kill_tombstone_at("claude", id), Some(2_000));
    }
    std::fs::remove_dir_all(&root).ok();
}

/// Focused-episode-6 round 4 (Finding F4) — the envelope COVERAGE gate: a
/// failed envelope write over a key whose PRIOR record does NOT cover the
/// new close's full identity set is a CLEAN failure (this op landed nothing
/// durable — the caller's kill FAILS, no teardown authority), never a
/// "persisted" answer carried on the strength of the covering-less prior.
/// The prior record itself is NEVER this op's to erase: it stands exactly as
/// before, and a healed retry merges the widened close set into the same
/// record.
#[test]
fn a_close_envelope_widening_whose_rewrite_fails_reports_clean_and_denies_teardown_authority() {
    let root = temp_root("prior-record");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-x", "term-x", 1_000))
        .unwrap();
    // The prior close: covers ONLY sess-x.
    ledger
        .close_identities("claude", &["sess-x".to_string()], &[], 2_000)
        .unwrap();
    assert_eq!(ledger.kill_tombstone_at("claude", "sess-x"), Some(2_000));
    assert_eq!(
        ledger.load_binding("claude", "sess-x").unwrap().state,
        RowState::Retired
    );
    // A widened close (a later kill naming the same wire id, now also
    // carrying a late-resolved identity) whose write cannot land — the prior
    // record covers sess-x but NOT sess-late, so NOTHING of this close is
    // durable.
    ledger.fail_next_close_envelope_writes(1);
    let err = ledger
        .close_identities(
            "claude",
            &["sess-x".to_string(), "sess-late".to_string()],
            &[],
            3_000,
        )
        .expect_err("the armed write failure surfaces");
    assert!(
        !err.is_persisted(),
        "a covering-less prior must NOT masquerade as persisted-close: the kill fails, \
         no row teardown is authorized (F4)"
    );
    // sess-late keeps its Bound row (never torn down): the failed close
    // projected nothing.
    let late = ledger.load_binding("claude", "sess-late");
    assert!(
        late.as_ref().map(|r| r.state) != Some(RowState::Retired),
        "no row retire without the durable close: {late:?}"
    );
    // The PRIOR record is untouched: it still covers exactly sess-x at its
    // own stamp; the failed write added nothing durable for sess-late.
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(disk.kill_tombstone_at("claude", "sess-x"), Some(2_000));
    assert_eq!(
        disk.kill_tombstone_at("claude", "sess-late"),
        None,
        "the widening never landed: no fence for the late identity"
    );
    // The healed retry merges the full set into the same record.
    ledger
        .close_identities(
            "claude",
            &["sess-x".to_string(), "sess-late".to_string()],
            &[],
            4_000,
        )
        .expect("the retry lands the widened close");
    assert_eq!(ledger.kill_tombstone_at("claude", "sess-x"), Some(4_000));
    assert_eq!(ledger.kill_tombstone_at("claude", "sess-late"), Some(4_000));
    std::fs::remove_dir_all(&root).ok();
}

/// The other arm of the F4 coverage gate: a failed write over a key whose
/// PRIOR record COVERS this close's whole identity set (a re-kill re-stamping
/// the same identities) IS persisted-close — the close evidence the caller
/// relies on is durable, so the lane ends its session consistently while
/// reporting the failure.
#[test]
fn a_close_envelope_failure_over_a_prior_record_that_covers_the_whole_set_reports_persisted() {
    let root = temp_root("prior-record-covers");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .close_identities(
            "claude",
            &["sess-x".to_string(), "sess-y".to_string()],
            &[],
            2_000,
        )
        .unwrap();
    // A re-close of the SAME identity set (re-stamped) whose write cannot
    // land: the standing record already fences every identity this close
    // carries.
    ledger.fail_next_close_envelope_writes(1);
    let err = ledger
        .close_identities(
            "claude",
            &["sess-x".to_string(), "sess-y".to_string()],
            &[],
            3_000,
        )
        .expect_err("the armed write failure surfaces");
    assert!(
        err.is_persisted(),
        "the prior record covers the whole close set: persisted-close (the kill ends its \
         session consistently): {err}"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(disk.kill_tombstone_at("claude", "sess-x"), Some(2_000));
    assert_eq!(disk.kill_tombstone_at("claude", "sess-y"), Some(2_000));
    std::fs::remove_dir_all(&root).ok();
}

// ── Delta-round-7 (round-7 Finding F2): the non-retiring DETACH pane close ──

/// The terminal pane's deliberate X-close is a DETACH (the session keeps
/// running server-side — the sidebar-reattach feature) AND, since round 7, a
/// durable pane-close act: one close-envelope journal record keyed by the
/// pane's `createRequestId` (`pane-detach:<crid>` — the kill lane keys
/// `pane:<terminalId>`, so the two lanes never merge). It answers "was this
/// PANE closed", never "is the session dead": kills are EMPTY (no fence is
/// fed) and no row is touched — the row stays Bound for sidebar reattach.
/// Because its terminal stays live, the record must NOT surface in the
/// kill-lane pane read model (`list_pane_closes`): its terminalId arm would
/// otherwise cover a later pane REATTACHED to the same (still-running)
/// terminal. The recovery inventory reads it through
/// `list_pane_detach_closes` only (crid + terminal arms on ledger ROWS and
/// the crid arm on snapshot PANES), and `resolve_pending`/`close_pane` are
/// untouched (a late identity resolution legitimately lands Bound — the
/// session lives on).
#[test]
fn a_detach_close_records_the_pane_close_without_retiring_or_fencing_anything() {
    let root = temp_root("detach-close");
    let ledger = PaneLedger::new(Some(root.clone()));
    // The closed pane's Bound row (the sidebar-reattach evidence).
    ledger
        .record_binding(&BindingWrite {
            provider: "claude",
            session_id: "sess-det",
            terminal_id: "term-det",
            mode: "claude",
            cwd: Some("/tmp/proj"),
            create_request_id: Some("req-det"),
            origin_create_request_id: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();

    ledger
        .close_pane_detached("req-det", Some("term-det"), 2_000)
        .expect("the detach close persists");

    // NOTHING is fenced and NO row is touched: no tombstone, the row is
    // byte-identical Bound (even `updated_at` — no write happened at all).
    assert!(
        ledger.all_kill_tombstone_keys().is_empty(),
        "a detach close feeds no kill fence"
    );
    let row = ledger.load_binding("claude", "sess-det").expect("row");
    assert_eq!(
        row.state,
        RowState::Bound,
        "the row stays Bound (sidebar reattach)"
    );
    assert_eq!(row.retired_reason, None);
    assert_eq!(
        row.updated_at, 1_000,
        "the detach close never rewrites the row"
    );
    assert_eq!(row.create_request_id.as_deref(), Some("req-det"));
    assert_eq!(row.live_terminal_id.as_deref(), Some("term-det"));

    // The recovery read model sees EXACTLY the detach linkage — and the
    // kill-lane surfaces do NOT (the terminal stays live; a reattached pane
    // must never read covered through the terminal id).
    assert_eq!(
        ledger.list_pane_detach_closes(),
        vec![PaneDetachClose {
            create_request_id: "req-det".to_string(),
            terminal_id: Some("term-det".to_string()),
        }]
    );
    assert!(
        ledger.list_pane_closes().is_empty(),
        "the kill-lane pane read model never surfaces a (still-live) detach close"
    );
    assert!(
        ledger.pane_close_for_terminal("term-det").is_none(),
        "resolve_pending's kill consult never sees a detach close"
    );

    // Idempotent: a repeated detach close keeps ONE record (re-stamped).
    ledger
        .close_pane_detached("req-det", Some("term-det"), 3_000)
        .expect("idempotent repeat");
    assert_eq!(ledger.list_pane_detach_closes().len(), 1);
    assert!(ledger.all_kill_tombstone_keys().is_empty());

    // Durable across a restart reload (the SIGKILL premise).
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        disk.list_pane_detach_closes(),
        vec![PaneDetachClose {
            create_request_id: "req-det".to_string(),
            terminal_id: Some("term-det".to_string()),
        }],
        "the detach close reloads from the journal"
    );
    assert!(disk.list_pane_closes().is_empty());

    // A LATER kill of the same terminal is an ordinary close_pane: an
    // independent record at its own key, the fence lands, the row retires —
    // the two record families coexist without interference.
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-det".to_string(),
            create_request_id: Some("req-det".to_string()),
            resolved: vec![SessionLocator {
                provider: "claude".into(),
                session_id: "sess-det".into(),
            }],
            now_ms: 4_000,
        })
        .expect("the later kill lands");
    assert_eq!(ledger.kill_tombstone_at("claude", "sess-det"), Some(4_000));
    assert_eq!(
        ledger.load_binding("claude", "sess-det").unwrap().state,
        RowState::Retired,
        "the kill retires what the detach deliberately left Bound"
    );
    assert_eq!(
        ledger.list_pane_detach_closes().len(),
        1,
        "the detach record stands beside the kill record"
    );
    assert_eq!(
        ledger.list_pane_closes().len(),
        1,
        "the kill record surfaces alone"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Round-7 F2 retention: the detach record's natural reference arm (a
/// retained snapshot carrying the crid/terminal id) does not cover the
/// finding's own shape — the pane was created AND closed inside the push
/// cadence, so no retained generation ever references it. The record's life
/// is therefore REFERENCE-TIME over the LEDGER too: it must outlive any
/// binding row still carrying its createRequestId (a Bound row it excludes
/// from the recovery offer), exactly the dominance-keep principle ("a close's
/// evidence plus an unconverged row outlive the 6h TTL"). Once the row is
/// gone (retired and pruned by its own rules), a fully-aged record prunes.
#[test]
fn a_fully_aged_detach_close_survives_while_a_row_carries_its_create_request_id() {
    let root = temp_root("detach-retention");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&BindingWrite {
            provider: "claude",
            session_id: "sess-kept",
            terminal_id: "term-kept",
            mode: "claude",
            cwd: Some("/tmp/proj"),
            create_request_id: Some("req-kept"),
            origin_create_request_id: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();
    ledger
        .close_pane_detached("req-kept", Some("term-kept"), 1_500)
        .unwrap();
    let aged = 1_500 + KILL_TOMBSTONE_TTL_MS + 60_000;
    // No retained snapshot references it (the within-cadence create+close):
    // the BOUND row carrying the crid is the keep.
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report.pane_closes_swept.is_empty(),
        "a row-covered detach close never prunes: {report:?}"
    );
    assert_eq!(ledger.list_pane_detach_closes().len(), 1);
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(disk.list_pane_detach_closes().len(), 1);

    // Delete the row (the ledger's own lifecycle) and the next pass prunes
    // the orphaned record.
    ledger.delete_binding("claude", "sess-kept").unwrap();
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report
            .pane_closes_swept
            .contains(&"pane-detach:req-kept".to_string()),
        "with no row and no snapshot referencing it, the aged record prunes: {report:?}"
    );
    assert!(ledger.list_pane_detach_closes().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-episode-7 round 3 ──
//
// Finding F1 (the whole-tab close is ONE envelope): `panes.closed` carries the
// tab's full pane-identity set and journals a SINGLE non-retiring envelope
// record (`pane-detach-batch:<tabId>`, the SAME close-envelope machinery), so
// a mid-set write failure can never leave PART of the tab's close durable —
// either the whole close is durable or nothing is.
//
// Finding F2 (the durable open re-assertion): a committed close whose
// acknowledgement was lost (socket down / half-open) leaves durable closed
// evidence under a STILL-OPEN pane. The client's `pane.opened` re-assertion
// consumes the standing record durably (the claim-consumes-fences discipline
// carried to the detach family), so the recovery judgment and the server
// state re-agree with the layout the client is displaying.
//
// Finding F3 (retention IS the recovery predicate): the retention sweep keeps
// close evidence while ANY row it covers stands, judged by the ONE shared
// coverage predicate (`close_record_covers_row`), never by a narrower
// raw-CRID equality — a lineage-only (origin CRID) record + a standing row
// survives past the TTL edge.

/// One full batch close, ONE journal record: the read model flattens every
/// carried linkage, no fence is fed, no row is touched, a repeated close of
/// the SAME tab is an idempotent merge under the one key, and the envelope is
/// durable across a restart reload.
#[test]
fn a_tab_close_journals_one_batch_envelope_covering_the_whole_pane_set() {
    let root = temp_root("batch-close");
    let ledger = PaneLedger::new(Some(root.clone()));
    for (session_id, terminal_id, crid) in [
        ("sess-b1", "term-b1", "req-b1"),
        ("sess-b2", "term-b2", "req-b2"),
    ] {
        ledger
            .record_binding(&BindingWrite {
                provider: "claude",
                session_id,
                terminal_id,
                mode: "claude",
                cwd: Some("/tmp/proj"),
                create_request_id: Some(crid),
                origin_create_request_id: None,
                provenance: ProvenancePolicy::Inherit,
                now_ms: 1_000,
            })
            .unwrap();
    }

    // THE BATCH CLOSE: the tab's full pane set — pane 2 closed mid-create
    // (CRID-only; the client never learned the terminal id).
    ledger
        .close_panes_detached(
            "tab-batch",
            &[
                PaneCloseLinkage {
                    create_request_id: "req-b1".to_string(),
                    terminal_id: Some("term-b1".to_string()),
                },
                PaneCloseLinkage {
                    create_request_id: "req-b2".to_string(),
                    terminal_id: None,
                },
            ],
            2_000,
        )
        .expect("the batch close persists");

    // ONE record under the batch key — the per-pane keys were never written.
    let batch_path = PaneLedger::close_envelope_path(
        &root,
        &PaneLedger::pane_detach_batch_envelope_key("tab-batch"),
    );
    assert!(
        batch_path.exists(),
        "the batch envelope is one journal file"
    );
    for crid in ["req-b1", "req-b2"] {
        assert!(
            !PaneLedger::close_envelope_path(&root, &PaneLedger::pane_detach_envelope_key(crid))
                .exists(),
            "no per-pane record exists beside the batch envelope for {crid}"
        );
    }

    // The recovery read model flattens the set — downstream coverage needs no
    // knowledge of the batch shape at all.
    let mut closes = ledger.list_pane_detach_closes();
    closes.sort_by(|a, b| a.create_request_id.cmp(&b.create_request_id));
    assert_eq!(
        closes,
        vec![
            PaneDetachClose {
                create_request_id: "req-b1".to_string(),
                terminal_id: Some("term-b1".to_string()),
            },
            PaneDetachClose {
                create_request_id: "req-b2".to_string(),
                terminal_id: None,
            },
        ]
    );
    // Nothing fenced, nothing retired — the batch is the same NON-retiring
    // family (the kill-lane read model never surfaces it either).
    assert!(ledger.all_kill_tombstone_keys().is_empty());
    assert!(ledger.list_pane_closes().is_empty());
    for (session_id, terminal_id, crid) in [
        ("sess-b1", "term-b1", "req-b1"),
        ("sess-b2", "term-b2", "req-b2"),
    ] {
        let row = ledger.load_binding("claude", session_id).unwrap();
        assert_eq!(row.state, RowState::Bound);
        assert_eq!(row.updated_at, 1_000);
        let _ = (terminal_id, crid);
    }

    // The gate retry / cross-device shape: a repeated close of the same tab
    // re-journals under the ONE key — still one record, same flattened view.
    ledger
        .close_panes_detached(
            "tab-batch",
            &[
                PaneCloseLinkage {
                    create_request_id: "req-b2".to_string(),
                    terminal_id: None,
                },
                PaneCloseLinkage {
                    create_request_id: "req-b1".to_string(),
                    terminal_id: Some("term-b1".to_string()),
                },
            ],
            3_000,
        )
        .expect("the repeated close re-journals idempotently");
    assert_eq!(ledger.list_pane_detach_closes().len(), 2);

    // Durable across a restart reload (the SIGKILL premise).
    let disk = PaneLedger::new(Some(root.clone()));
    let mut disk_closes = disk.list_pane_detach_closes();
    disk_closes.sort_by(|a, b| a.create_request_id.cmp(&b.create_request_id));
    assert_eq!(disk_closes.len(), 2);
    assert_eq!(disk_closes[0].create_request_id, "req-b1");
    assert_eq!(disk_closes[1].create_request_id, "req-b2");

    // Retention is coverage-keyed over the whole set (F3): while EITHER
    // covered row stands, the envelope outlives the TTL.
    let aged = 3_000 + KILL_TOMBSTONE_TTL_MS + 60_000;
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report.pane_closes_swept.is_empty(),
        "row-covered batch evidence never prunes: {report:?}"
    );
    ledger.delete_binding("claude", "sess-b1").unwrap();
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report.pane_closes_swept.is_empty(),
        "the surviving sibling linkage's row still covers it: {report:?}"
    );
    ledger.delete_binding("claude", "sess-b2").unwrap();
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report
            .pane_closes_swept
            .contains(&PaneLedger::pane_detach_batch_envelope_key("tab-batch")),
        "with no covered row standing, the aged envelope prunes: {report:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Focused-episode-7 round 4 (Finding F1) — the batch envelope's
/// SNAPSHOT-side retention: the record's carried per-pane identities (its
/// `panes` list — a batch record's top-level crid/terminal ids are None) must
/// reach the retained-snapshot reference check exactly as the top-level
/// fields do for the single-pane shape. Pre-fix the check consulted only the
/// top-level fields, so a snapshot-only batch close (NO binding row — a
/// plain shell or pre-association pane never stamped one) pruned past the
/// six-hour TTL while a retained generation still referenced its pane — the
/// recovery offer then resurrected a pane the user deliberately closed. The
/// ROW-side half (a surviving row retains the envelope) is pinned by the
/// batch test above; this pins the snapshot-only + no-row case past the TTL
/// edge.
#[test]
fn a_snapshot_referenced_batch_close_never_prunes_past_the_ttl() {
    let root = temp_root("batch-close-snapshot-retained");
    let ledger = PaneLedger::new(Some(root.clone()));
    // NO binding rows — the finding's exact shape (plain shell /
    // pre-association panes never stamp one).
    ledger
        .close_panes_detached(
            "tab-snap",
            &[
                PaneCloseLinkage {
                    create_request_id: "req-s1".to_string(),
                    terminal_id: Some("term-s1".to_string()),
                },
                PaneCloseLinkage {
                    create_request_id: "req-s2".to_string(),
                    terminal_id: None,
                },
            ],
            2_000,
        )
        .expect("the batch close persists");
    let batch_key = PaneLedger::pane_detach_batch_envelope_key("tab-snap");
    let aged = 2_000 + KILL_TOMBSTONE_TTL_MS + 60_000;

    // A retained generation naming a carried createRequestId retains it.
    let mut refs = crate::tabs_persist::RetainedSnapshotReferences::default();
    refs.create_request_ids.insert("req-s2".to_string());
    let report = ledger.gc(aged, &never_absent, None, Some(&refs));
    assert!(
        report.pane_closes_swept.is_empty(),
        "a snapshot-referenced batch close outlives the TTL (crid arm): {report:?}"
    );

    // So does one naming a carried TERMINAL id.
    let mut refs = crate::tabs_persist::RetainedSnapshotReferences::default();
    refs.terminal_ids.insert("term-s1".to_string());
    let report = ledger.gc(aged, &never_absent, None, Some(&refs));
    assert!(
        report.pane_closes_swept.is_empty(),
        "a snapshot-referenced batch close outlives the TTL (terminal-id arm): {report:?}"
    );

    // Control: referenced by NO retained generation and covered by NO row,
    // the aged envelope prunes (the pre-existing row-backed test's tail).
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report.pane_closes_swept.contains(&batch_key),
        "unreferenced and row-less, the aged batch close prunes: {report:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The durable open re-assertion (F2): a committed close whose ack was lost
/// leaves the record standing under a still-open pane. `pane.opened` consumes
/// the pane's linkage from every DETACH-family record — deleting a record
/// whose whole linkage it was, rewriting a batch record down to its surviving
/// linkages — DURABLY (a restart never re-feeds it), while advancing the
/// still-open pane's row attribution to the assertion's own clock (the claim
/// lifecycle's "consume the fence on a genuine open" carried to this family).
#[test]
fn a_pane_open_re_assertion_consumes_the_detach_close_durably() {
    let root = temp_root("pane-opened");
    let ledger = PaneLedger::new(Some(root.clone()));
    // The still-open pane's row: attributed at 1_000 to dev1/c1/tab t9.
    ledger
        .record_binding(&write_provenance(
            "claude",
            "sess-open",
            "term-open",
            1_000,
            Some("c1"),
            Some("dev1"),
            Some("dev1:tab-x"),
        ))
        .unwrap();
    // THE COMMITTED CLOSE (its ack was then lost — the visible pane stayed).
    ledger
        .close_pane_detached("req-1", Some("term-open"), 2_000)
        .expect("the committed close lands");
    assert_eq!(ledger.list_pane_detach_closes().len(), 1);

    // THE RE-ASSERTION, at the assertion's own clock time.
    ledger
        .note_pane_opened(
            "req-1",
            ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("dev1"),
                tab_key: Some("dev1:tab-x"),
                asserted_at: 3_000,
            }),
            3_000,
        )
        .expect("the re-assertion lands");

    // The record is GONE — index AND disk (a restart never re-feeds it).
    assert!(ledger.list_pane_detach_closes().is_empty());
    let disk = PaneLedger::new(Some(root.clone()));
    assert!(
        disk.list_pane_detach_closes().is_empty(),
        "consumed durably: a reload never resurrects the close"
    );
    // …and the still-open pane's row was never retired by the close (the
    // non-retiring family) and now advanced its attribution to the asserted
    // time — the row and the displayed layout agree again.
    let row = disk.load_binding("claude", "sess-open").expect("row");
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(
        row.last_attributed_at,
        Some(3_000),
        "the assertion advances the attribution clock (monotone)"
    );
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));

    // Idempotent: no-row/no-record re-assertions are no-op Oks (the client
    // re-flushes until landed; re-flush after consumption must stay cheap).
    ledger
        .note_pane_opened(
            "req-1",
            ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("dev1"),
                tab_key: Some("dev1:tab-x"),
                asserted_at: 3_000,
            }),
            3_000,
        )
        .unwrap();
    ledger
        .note_pane_opened("req-never-existed", ProvenancePolicy::Inherit, 4_000)
        .unwrap();

    // The batch cousin: a tab-wide envelope is rewritten DOWN to its
    // surviving linkages when ONE pane re-asserts — the sibling's close
    // evidence stands byte-for-byte (and survives a reload).
    ledger
        .close_panes_detached(
            "tab-y",
            &[
                PaneCloseLinkage {
                    create_request_id: "req-gone".to_string(),
                    terminal_id: Some("term-gone".to_string()),
                },
                PaneCloseLinkage {
                    create_request_id: "req-kept".to_string(),
                    terminal_id: Some("term-kept".to_string()),
                },
            ],
            4_000,
        )
        .unwrap();
    ledger
        .note_pane_opened("req-gone", ProvenancePolicy::Inherit, 5_000)
        .unwrap();
    assert_eq!(
        ledger.list_pane_detach_closes(),
        vec![PaneDetachClose {
            create_request_id: "req-kept".to_string(),
            terminal_id: Some("term-kept".to_string()),
        }],
        "the re-assertion consumes exactly its own linkage — the sibling stays closed"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    assert_eq!(disk.list_pane_detach_closes().len(), 1);
    assert_eq!(
        disk.list_pane_detach_closes()[0].create_request_id,
        "req-kept"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// F3's pin: a record past the 6h TTL whose ONLY join to a standing row is
/// the ORIGIN lineage arm (the conn-less resolution lane's row shape: an
/// in-flight `pane.closed` journaled CRID-only; the resolve then wrote the
/// row with `create_request_id: None` and the ORIGIN crid) must survive
/// retention exactly as long as the row does — the pre-shared-predicate sweep
/// required raw `create_request_id` equality and pruned it, so the supposedly
/// closed session could be offered and restored days later.
#[test]
fn a_fully_aged_detach_close_survives_while_a_row_carries_only_its_origin_lineage() {
    let root = temp_root("retention-origin");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "sess-origin",
            terminal_id: "term-origin",
            mode: "codex",
            cwd: Some("/tmp/proj"),
            create_request_id: None, // the deliberate conn-less lane shape
            origin_create_request_id: Some("req-origin"),
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();
    ledger
        .close_pane_detached("req-origin", None, 1_500)
        .unwrap();
    let aged = 1_500 + KILL_TOMBSTONE_TTL_MS + 60_000;
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report.pane_closes_swept.is_empty(),
        "the ORIGIN arm covers the row ⇒ the record outlives the TTL while the row stands: {report:?}"
    );
    assert_eq!(ledger.list_pane_detach_closes().len(), 1);

    // And once the row is gone the aged record prunes (the keep lapses).
    ledger.delete_binding("codex", "sess-origin").unwrap();
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        report
            .pane_closes_swept
            .contains(&"pane-detach:req-origin".to_string()),
        "no covered row ⇒ the aged record prunes on schedule: {report:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// F3's terminal-arm half: a FULLY lineage-less legacy row (neither pane key)
/// whose live terminal IS the closed pane's is covered by the record, so the
/// record outlives the TTL while that row stands. Control (the sibling-shared
/// -terminal overreach the inventory's gating already pins): a LINEAGE-KEYED
/// row answering its own keys alone must NOT retain ANOTHER pane's close
/// record via a shared terminal id.
#[test]
fn a_fully_aged_detach_close_survives_while_a_lineage_less_row_names_its_terminal() {
    let root = temp_root("retention-terminal-arm");
    let ledger = PaneLedger::new(Some(root.clone()));
    // The legacy conn-less row shape: NEITHER pane key — only the terminal id.
    ledger
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "sess-legacy",
            terminal_id: "term-legacy",
            mode: "codex",
            cwd: Some("/tmp/proj"),
            create_request_id: None,
            origin_create_request_id: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();
    // A lineage-keyed surviving row on a DIFFERENT (shared) terminal: this
    // pane stayed OPEN — it must never anchor the sibling's close record.
    ledger
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "sess-survivor",
            terminal_id: "term-shared",
            mode: "codex",
            cwd: Some("/tmp/proj"),
            create_request_id: Some("req-survivor"),
            origin_create_request_id: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();
    ledger
        .close_pane_detached("req-legacy-close", Some("term-legacy"), 1_500)
        .unwrap();
    // The closed SIBLING's record, naming the shared terminal.
    ledger
        .close_pane_detached("req-sibling", Some("term-shared"), 1_500)
        .unwrap();
    let aged = 1_500 + KILL_TOMBSTONE_TTL_MS + 60_000;
    let report = ledger.gc(aged, &never_absent, None, Some(&no_snapshot_refs()));
    assert!(
        !report
            .pane_closes_swept
            .contains(&"pane-detach:req-legacy-close".to_string()),
        "the lineage-less row's terminal names the closed pane ⇒ kept: {report:?}"
    );
    assert!(
        report
            .pane_closes_swept
            .contains(&"pane-detach:req-sibling".to_string()),
        "a lineage-keyed row answers its keys alone — the sibling's record prunes: {report:?}"
    );
    assert_eq!(
        ledger.list_pane_detach_closes(),
        vec![PaneDetachClose {
            create_request_id: "req-legacy-close".to_string(),
            terminal_id: Some("term-legacy".to_string()),
        }]
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The ONE shared coverage predicate (F3) — consumed by BOTH the inventory
/// verdict computation and the scan-retention pruning: the CRID arm consults
/// EITHER pane key (advisory + origin lineage, non-empty only); a lineage-
/// keyed row answers its keys ALONE (the detach terminal arm must never reach
/// across to a closed SIBLING's record); only a fully lineage-less row
/// consults the terminal fallback.
#[test]
fn close_record_covers_row_is_the_shared_recovery_predicate() {
    fn row(
        create_request_id: Option<&str>,
        origin_create_request_id: Option<&str>,
        live_terminal_id: Option<&str>,
    ) -> BindingRow {
        BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: "claude".to_string(),
            session_id: "sess-shared".to_string(),
            mode: "claude".to_string(),
            cwd: None,
            live_terminal_id: live_terminal_id.map(str::to_string),
            create_request_id: create_request_id.map(str::to_string),
            origin_create_request_id: origin_create_request_id.map(str::to_string),
            created_at: 1_000,
            updated_at: 1_000,
            last_observed_at: 1_000,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
            pane_kind: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            client_instance_id: None,
            device_id: None,
            tab_key: None,
            last_attributed_at: None,
        }
    }
    let crid = |id: &str| id == "req-closed";
    let tid = |id: &str| id == "term-closed";
    let none = |_: &str| false;

    // The advisory-crid arm and the origin-lineage arm each cover alone.
    assert!(close_record_covers_row(
        &row(Some("req-closed"), None, None),
        &crid,
        &none
    ));
    assert!(close_record_covers_row(
        &row(None, Some("req-closed"), None),
        &crid,
        &none
    ));
    // The terminal arm covers ONLY the fully lineage-less row…
    assert!(close_record_covers_row(
        &row(None, None, Some("term-closed")),
        &none,
        &tid
    ));
    // …never a lineage-keyed one (an empty-string key is not lineage).
    assert!(!close_record_covers_row(
        &row(Some("req-other"), None, Some("term-closed")),
        &none,
        &tid
    ));
    assert!(!close_record_covers_row(
        &row(None, Some("req-other"), Some("term-closed")),
        &none,
        &tid
    ));
    // Nothing covers when no arm matches; empty-string keys are never
    // lineage (an empty advisory crid does NOT take the row out of the
    // terminal arm — only a real pane key does).
    assert!(!close_record_covers_row(
        &row(Some("req-other"), None, Some("term-closed")),
        &crid,
        &none
    ));
    assert!(!close_record_covers_row(
        &row(Some(""), None, Some("term-closed")),
        &none,
        &none
    ));
    assert!(close_record_covers_row(
        &row(Some(""), None, Some("term-closed")),
        &none,
        &tid
    ));
    assert!(!close_record_covers_row(
        &row(None, None, None),
        &crid,
        &tid
    ));
}

// ── Delta-r6-r4 (focused-episode-6 round 3, Finding 2): reference-time close-evidence retention ──

/// The finding: the 6h TTL deleted the only closed verdict while stale
/// open-pane snapshots (pruned by COUNT, never by age) still referenced the
/// pane — reopening past the TTL re-offered a pane the user had closed.
/// Reference-time rule (the alias-tombstones' lifetime discipline carried to
/// the close evidence): a record past the TTL is pruned ONLY when NO
/// retained snapshot generation can reference its pane identity — by
/// terminal id, by createRequestId, or by a sessionRef claim matching one of
/// its kills.
#[test]
fn a_fully_aged_close_record_survives_while_a_retained_snapshot_references_it() {
    let root = temp_root("reference-time");
    let ledger = PaneLedger::new(Some(root.clone()));
    // The terminal-lane close, keyed by terminal id + createRequestId.
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-ref".to_string(),
            create_request_id: Some("cr-ref".to_string()),
            resolved: vec![],
            now_ms: 1_000,
        })
        .unwrap();
    // The fresh-agent placeholder close (the F1 shape), claim-referenced.
    ledger
        .close_identities("opencode", &["freshopencode-cr-z".to_string()], &[], 1_000)
        .unwrap();
    let aged = 1_000 + KILL_TOMBSTONE_TTL_MS + 60_000;

    // A retained snapshot references the pane's createRequestId and the
    // placeholder claim: BOTH records survive across the TTL edge, fences
    // included (and durable across a reload).
    let mut refs = crate::tabs_persist::RetainedSnapshotReferences::default();
    refs.create_request_ids.insert("cr-ref".to_string());
    refs.claims
        .insert(("opencode".to_string(), "freshopencode-cr-z".to_string()));
    let report = ledger.gc(aged, &never_absent, None, Some(&refs));
    assert!(
        report.pane_closes_swept.is_empty(),
        "referenced evidence never prunes: {report:?}"
    );
    assert!(ledger.pane_close_for_terminal("term-ref").is_some());
    assert_eq!(
        ledger.kill_tombstone_at("opencode", "freshopencode-cr-z"),
        Some(1_000),
        "the referenced placeholder fence survives (the verdict join's arm)"
    );
    let disk = PaneLedger::new(Some(root.clone()));
    assert!(disk.pane_close_for_terminal("term-ref").is_some());
    assert_eq!(
        disk.kill_tombstone_at("opencode", "freshopencode-cr-z"),
        Some(1_000)
    );

    // The terminal-id arm as well (a snapshot's liveTerminal.terminalId).
    let mut refs = crate::tabs_persist::RetainedSnapshotReferences::default();
    refs.terminal_ids.insert("term-ref".to_string());
    let report = ledger.gc(aged, &never_absent, None, Some(&refs));
    assert!(report
        .pane_closes_swept
        .iter()
        .all(|k| k != "pane:term-ref"));
    assert!(ledger.pane_close_for_terminal("term-ref").is_some());

    // And when NOTHING references them anymore (a scanned store that
    // genuinely holds no such generation): the pre-existing TTL prune runs.
    let empty = crate::tabs_persist::RetainedSnapshotReferences::default();
    let report = ledger.gc(aged, &never_absent, None, Some(&empty));
    assert!(
        report
            .pane_closes_swept
            .contains(&"pane:term-ref".to_string()),
        "unreferenced + fully aged prunes: {report:?}"
    );
    assert!(ledger.pane_close_for_terminal("term-ref").is_none());
    assert_eq!(
        ledger.kill_tombstone_at("opencode", "freshopencode-cr-z"),
        None
    );

    // The sessionKeys arm (focused-episode-6 round 4, Finding F3): a close
    // whose identity a retained generation claims ONLY through the rings
    // stamp (the ref-less pre-association payload shape) is referenced too —
    // TTL GC must not sweep it out from under that snapshot.
    ledger
        .close_identities("claude", &["ph-sk-gc".to_string()], &[], 1_000)
        .unwrap();
    let mut refs = crate::tabs_persist::RetainedSnapshotReferences::default();
    refs.session_keys
        .insert(("claude".to_string(), "ph-sk-gc".to_string()));
    let report = ledger.gc(aged, &never_absent, None, Some(&refs));
    assert!(
        report
            .pane_closes_swept
            .iter()
            .all(|k| k != "claude:ph-sk-gc"),
        "a sessionKeys-referenced close survives the TTL edge: {report:?}"
    );
    assert_eq!(ledger.kill_tombstone_at("claude", "ph-sk-gc"), Some(1_000));
    // …and once that shape also stops referencing it, it prunes.
    let report = ledger.gc(aged, &never_absent, None, Some(&empty));
    assert!(
        report
            .pane_closes_swept
            .contains(&"claude:ph-sk-gc".to_string()),
        "unreferenced sessionKeys-only close evidence prunes: {report:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The conservative arm: when the reference set is UNKNOWN (the snapshot
/// scan failed — the error arm is mapped to `None` by the caller), NOTHING
/// prunes. Over-deleting evidence on a read error is never acceptable.
#[test]
fn an_unknown_reference_set_never_prunes_close_evidence() {
    let root = temp_root("unknown-refs");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-unk".to_string(),
            create_request_id: Some("cr-unk".to_string()),
            resolved: vec![],
            now_ms: 1_000,
        })
        .unwrap();
    let aged = 1_000 + KILL_TOMBSTONE_TTL_MS + 60_000;
    let report = ledger.gc(aged, &never_absent, None, None);
    assert!(
        report.pane_closes_swept.is_empty(),
        "unknown references prune nothing: {report:?}"
    );
    assert!(ledger.pane_close_for_terminal("term-unk").is_some());
    std::fs::remove_dir_all(&root).ok();
}

// ── Focused-episode-6 round 4 (Finding F1) — claims consume their fences DURABLY ──
//
// The claim lifecycle clears the close fence in memory; before this finding
// the fence re-derived from its close-envelope journal record at the next
// load (the record is append-only, never edited), so a restart resurrected a
// consumed fence — and the recovery inventory's class-agnostic consult read
// the reopened identity as closed. The commit's fence clear now CONSUMES the
// journal entries durably (the record is rewritten without the identity, or
// deleted when nothing else justifies it) in the same ledger op.

/// The commit consumes the claimed identity's fence entries across EVERY
/// standing record, in the same durable transition as the revive: after a
/// reload nothing re-feeds — the "claim residue" resurrection is gone. The
/// record's OTHER identities (the pane-seat placeholder fence) stay fenced.
#[test]
fn a_claim_commit_consumes_the_fences_it_clears_durably_a_restart_never_refed_them() {
    let root = temp_root("claim-consume");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "durable-1", "term-c1", 1_000))
        .unwrap();
    // The kill's envelope: the pane-seat placeholder + the durable id.
    ledger
        .close_identities(
            "claude",
            &["ph-c1".to_string(), "durable-1".to_string()],
            &[],
            2_000,
        )
        .unwrap();
    assert_eq!(
        ledger.load_binding("claude", "durable-1").unwrap().state,
        RowState::Retired
    );
    // The genuine reopen: the commit revives the row AND consumes the
    // durable identity's fence durably.
    let outcome = ledger
        .commit_claim("claude", "durable-1", Some(2_000), 3_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    assert_eq!(ledger.kill_tombstone_at("claude", "durable-1"), None);
    assert_eq!(
        ledger.kill_tombstone_at("claude", "ph-c1"),
        Some(2_000),
        "the pane-seat fence the commit did not claim stays standing"
    );
    // The journal record was REWRITTEN (not erased): it still carries the
    // placeholder entry at its original stamp.
    let reload = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        reload.kill_tombstone_at("claude", "durable-1"),
        None,
        "durable consumption: the reload must NOT re-feed the consumed fence"
    );
    assert_eq!(reload.kill_tombstone_at("claude", "ph-c1"), Some(2_000));
    assert!(
        !reload
            .all_kill_tombstone_keys()
            .contains(&("claude".to_string(), "durable-1".to_string())),
        "the class-agnostic verdict read (the inventory's join) never sees the consumed fence"
    );
    // The revive is durable too (unchanged commit half).
    assert_eq!(
        reload.load_binding("claude", "durable-1").unwrap().state,
        RowState::Bound
    );
    std::fs::remove_dir_all(&root).ok();
}

/// A record the consumption EMPTIED — an agent-keyed envelope whose only
/// entry was the claimed identity — is deleted outright (it carried no pane
/// linkage; an empty agent record is forensic noise). The claim lane's
/// alias-fence clear ([`PaneLedger::clear_kill_tombstone`]) consumes the same
/// way.
#[test]
fn consuming_the_last_entry_of_an_agent_record_deletes_it_durably() {
    let root = temp_root("claim-consume-empty");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "durable-2", "term-c2", 1_000))
        .unwrap();
    ledger
        .close_identities("claude", &["durable-2".to_string()], &[], 2_000)
        .unwrap();
    assert!(PaneLedger::close_envelope_path(&root, "claude:durable-2").exists());
    let outcome = ledger
        .commit_claim("claude", "durable-2", Some(2_000), 3_000)
        .unwrap();
    assert_eq!(outcome, ClaimCommitOutcome::Committed);
    assert!(
        !PaneLedger::close_envelope_path(&root, "claude:durable-2").exists(),
        "the emptied agent record's file is deleted with the consumption"
    );
    let reload = PaneLedger::new(Some(root.clone()));
    assert!(reload.all_kill_tombstone_keys().is_empty());
    // Idempotent: a second clear against no evidence is a no-op Ok.
    ledger.clear_kill_tombstone("claude", "durable-2").unwrap();
    std::fs::remove_dir_all(&root).ok();
}

/// The claim lane's explicit clear ([`PaneLedger::clear_kill_tombstone`] —
/// the consumed ALIAS fences) consumes journal entries durably too, so the
/// reopened placeholder never re-fences across a restart.
#[test]
fn clear_kill_tombstone_consumes_journal_entries_durably() {
    let root = temp_root("clear-consume");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .close_identities("claude", &["ph-c3".to_string()], &[], 2_000)
        .unwrap();
    assert_eq!(ledger.kill_tombstone_at("claude", "ph-c3"), Some(2_000));
    ledger.clear_kill_tombstone("claude", "ph-c3").unwrap();
    assert_eq!(ledger.kill_tombstone_at("claude", "ph-c3"), None);
    let reload = PaneLedger::new(Some(root.clone()));
    assert_eq!(
        reload.kill_tombstone_at("claude", "ph-c3"),
        None,
        "the reload must NOT re-feed the consumed alias fence"
    );
    assert!(!PaneLedger::close_envelope_path(&root, "claude:ph-c3").exists());
    std::fs::remove_dir_all(&root).ok();
}

/// A PANE-keyed record whose last close fence is consumed KEEPS the record:
/// its terminal/crid linkage is the pane-cover verdict independent of its
/// kills. Only the identity entry leaves it.
#[test]
fn consuming_a_fence_from_a_pane_record_keeps_the_pane_cover() {
    let root = temp_root("consume-pane-cover");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "sess-pc", "term-pc", 1_000))
        .unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-pc".to_string(),
            create_request_id: Some("cr-pc".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-pc".into(),
            }],
            now_ms: 2_000,
        })
        .unwrap();
    assert_eq!(ledger.kill_tombstone_at("codex", "sess-pc"), Some(2_000));
    // The session is genuinely re-claimed on ANOTHER pane: the pane-cover
    // close stands for the CLOSED pane, but the identity's fence leaves it.
    ledger.clear_kill_tombstone("codex", "sess-pc").unwrap();
    let reload = PaneLedger::new(Some(root.clone()));
    assert_eq!(reload.kill_tombstone_at("codex", "sess-pc"), None);
    let record = reload
        .pane_close_for_terminal("term-pc")
        .expect("the pane-cover record survives the fence consumption");
    assert!(
        record.kills.is_empty(),
        "only its kills were consumed: {record:?}"
    );
    std::fs::remove_dir_all(&root).ok();
}

// ────────────────────────────────────────────────────────────────────────────
// Delta-r7-r2 (Finding F3) — the attach restamp: `note_pane_reattach`. A pane
// attaching to a live terminal (the sidebar reattach; the recovery-offer
// reattach arm; any viewport attach) carries its createRequestId + tab and the
// ledger re-stamps the Bound row onto THAT pane's identity — so a close record
// keyed by the OLD pane's createRequestId keeps covering only the old pane.
// ────────────────────────────────────────────────────────────────────────────

fn reattach_write<'a>(
    provider: &'a str,
    session_id: &'a str,
    terminal_id: &'a str,
    create_request_id: &'a str,
    now_ms: i64,
) -> ReattachWrite<'a> {
    ReattachWrite {
        provider,
        session_id,
        terminal_id,
        create_request_id,
        provenance: ProvenancePolicy::Inherit,
        now_ms,
    }
}

/// The conn-scoped variant: what the WS attach handler passes — the
/// connection's hello identity plus the attach-carried tab, asserted at the
/// attach's receipt time.
#[allow(clippy::too_many_arguments)]
fn reattach_write_replace_at(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    create_request_id: &str,
    now_ms: i64,
    client_instance_id: Option<&str>,
    device_id: Option<&str>,
    tab_key: Option<&str>,
    asserted_at: i64,
) -> ReattachWrite<'static> {
    let leak = |s: Option<&str>| s.map(|v| &*Box::leak(v.to_string().into_boxed_str()));
    ReattachWrite {
        provider: Box::leak(provider.to_string().into_boxed_str()),
        session_id: Box::leak(session_id.to_string().into_boxed_str()),
        terminal_id: Box::leak(terminal_id.to_string().into_boxed_str()),
        create_request_id: Box::leak(create_request_id.to_string().into_boxed_str()),
        provenance: ProvenancePolicy::Replace(ProvenanceStamps {
            client_instance_id: leak(client_instance_id),
            device_id: leak(device_id),
            tab_key: leak(tab_key),
            asserted_at,
        }),
        now_ms,
    }
}

/// The finding's shape end to end: the pane's create stamps the row (CRID
/// req-OLD, tab device-1:tab-OLD at t=1_000); the pane X-closes; the SAME
/// session's background terminal is REATTACHED by a NEW pane (CRID req-NEW,
/// tab device-1:tab-NEW at t=2_000). The row must carry the NEW pane's key,
/// terminal, and the attach's advanced attribution (the full-triple advance
/// rule) — while the record proves `created_at` never moves and `mode`/`cwd`
/// ride untouched.
#[test]
fn reattach_restamps_the_bound_rows_pane_identity_and_advances_attribution() {
    let root = temp_root("reattach-restamp");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write_provenance(
            "claude",
            "sess-rt",
            "term-rt",
            1_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-OLD"),
        ))
        .unwrap();
    let stamped = ledger
        .note_pane_reattach(&reattach_write_replace_at(
            "claude",
            "sess-rt",
            "term-rt",
            "req-NEW",
            2_050,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-NEW"),
            2_000,
        ))
        .unwrap();
    assert!(stamped, "a Bound row with a different CRID restamps");
    let row = ledger.load_binding("claude", "sess-rt").unwrap();
    assert_eq!(row.create_request_id.as_deref(), Some("req-NEW"));
    assert_eq!(row.live_terminal_id.as_deref(), Some("term-rt"));
    assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
    assert_eq!(row.device_id.as_deref(), Some("device-1"));
    assert_eq!(
        row.tab_key.as_deref(),
        Some("device-1:tab-NEW"),
        "the attribution ADVANCES to the attach's true tab"
    );
    assert_eq!(
        row.last_attributed_at,
        Some(2_000),
        "the assertion time advances to the attach's receipt"
    );
    assert_eq!(row.created_at, 1_000, "row-keeping metadata never moves");
    assert_eq!(row.mode, "claude");
    assert_eq!(row.cwd.as_deref(), Some("/tmp/proj"));
    assert_eq!(row.state, RowState::Bound, "the restamp never retires");
    assert_eq!(
        row.updated_at, 2_050,
        "a genuine re-observation stamps the write's now"
    );
    assert_eq!(row.last_observed_at, 2_050);
    // Durable: the restamp survives a reload.
    let reload = PaneLedger::new(Some(root.clone()));
    let row = reload.load_binding("claude", "sess-rt").unwrap();
    assert_eq!(row.create_request_id.as_deref(), Some("req-NEW"));
    assert_eq!(row.last_attributed_at, Some(2_000));
    std::fs::remove_dir_all(&root).ok();
}

/// The keepalive case: an attach naming the row's CURRENT createRequestId
/// must not pay a durable write at all (no-op) — every keepalive/viewport
/// attach would otherwise fsync the row.
#[test]
fn reattach_with_the_rows_current_crid_writes_nothing() {
    let root = temp_root("reattach-noop");
    let ledger = PaneLedger::new(Some(root.clone()));
    let mut w = write_provenance(
        "claude",
        "sess-same",
        "term-same",
        1_000,
        Some("client-1"),
        Some("device-1"),
        Some("device-1:tab-1"),
    );
    w.create_request_id = Some("req-same");
    ledger.record_binding(&w).unwrap();
    let stamped = ledger
        .note_pane_reattach(&reattach_write_replace_at(
            "claude",
            "sess-same",
            "term-same",
            "req-same",
            9_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-1"),
            8_900,
        ))
        .unwrap();
    assert!(!stamped, "same-CRID attach: nothing to restamp");
    let row = ledger.load_binding("claude", "sess-same").unwrap();
    assert_eq!(row.updated_at, 1_000, "no write happened");
    assert_eq!(row.last_attributed_at, Some(1_000));
    std::fs::remove_dir_all(&root).ok();
}

/// The restamp NEVER manufactures or resurrects rows: no row, or a Retired
/// one (a genuinely-killed identity), answers no-op — attach is not a create
/// lane and never undoes a close.
#[test]
fn reattach_is_a_no_op_without_a_bound_row_and_never_resurrects_a_retired_one() {
    let root = temp_root("reattach-no-row");
    let ledger = PaneLedger::new(Some(root.clone()));
    let stamped = ledger
        .note_pane_reattach(&reattach_write(
            "claude",
            "sess-absent",
            "term-x",
            "req-n1",
            1_000,
        ))
        .unwrap();
    assert!(!stamped, "no row to restamp");
    assert!(ledger.load_binding("claude", "sess-absent").is_none());

    // A retired (killed) identity stays Retired: kill the pane, then a stale
    // attach lands (e.g. a kill racing an in-flight attach) — the close wins.
    ledger
        .record_binding(&write("codex", "sess-killed", "term-killed", 1_000))
        .unwrap();
    ledger
        .close_pane(&PaneCloseWrite {
            terminal_id: "term-killed".to_string(),
            create_request_id: Some("req-killed".to_string()),
            resolved: vec![SessionLocator {
                provider: "codex".into(),
                session_id: "sess-killed".into(),
            }],
            now_ms: 2_000,
        })
        .unwrap();
    let stamped = ledger
        .note_pane_reattach(&reattach_write(
            "codex",
            "sess-killed",
            "term-killed",
            "req-n2",
            3_000,
        ))
        .unwrap();
    assert!(!stamped, "a Retired row is never restamped");
    let row = ledger.load_binding("codex", "sess-killed").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(
        row.create_request_id.as_deref(),
        Some("req-1"),
        "the no-op restamp never touches the retired row (the `write()` helper seeds req-1)"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Provenance discipline on the restamp is EXACTLY the existing attribution
/// rules: a tab-less legacy attach carries no full triple, so over an
/// already-attributed row it never advances stamps+time (it only re-keys the
/// pane identity); on a never-attributed row the meaningful halves ATTACH.
#[test]
fn reattach_provenance_follows_the_attach_and_advance_gates() {
    let root = temp_root("reattach-gates");
    let ledger = PaneLedger::new(Some(root.clone()));

    // ADVANCE gate: tab-less attach over an attributed row — pane identity
    // moves, stamps+time stay.
    let mut w = write_provenance(
        "claude",
        "sess-adv",
        "term-adv",
        1_000,
        Some("client-1"),
        Some("device-1"),
        Some("device-1:tab-1"),
    );
    w.create_request_id = Some("req-old-adv");
    ledger.record_binding(&w).unwrap();
    ledger
        .note_pane_reattach(&reattach_write_replace_at(
            "claude",
            "sess-adv",
            "term-adv",
            "req-new-adv",
            5_000,
            Some("client-1"),
            Some("device-1"),
            None, // no tab: a legacy attach cannot compose the triple
            4_900,
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-adv").unwrap();
    assert_eq!(row.create_request_id.as_deref(), Some("req-new-adv"));
    assert_eq!(
        row.tab_key.as_deref(),
        Some("device-1:tab-1"),
        "no triple => no advance (never launder freshness onto a stale tab)"
    );
    assert_eq!(row.last_attributed_at, Some(1_000));

    // ATTACH gate: the row was born headless/conn-less (no stamps at all) —
    // the attach's meaningful halves attach (client+device, plus tab when
    // present), WITH the assertion time.
    ledger
        .record_binding(&write("codex", "sess-attach", "term-attach", 1_000))
        .unwrap();
    ledger
        .note_pane_reattach(&reattach_write_replace_at(
            "codex",
            "sess-attach",
            "term-attach",
            "req-attach",
            2_000,
            Some("client-2"),
            Some("device-2"),
            Some("device-2:tab-2"),
            1_950,
        ))
        .unwrap();
    let row = ledger.load_binding("codex", "sess-attach").unwrap();
    assert_eq!(row.client_instance_id.as_deref(), Some("client-2"));
    assert_eq!(row.device_id.as_deref(), Some("device-2"));
    assert_eq!(row.tab_key.as_deref(), Some("device-2:tab-2"));
    assert_eq!(row.last_attributed_at, Some(1_950));
    std::fs::remove_dir_all(&root).ok();
}

/// The restamp's stamp-advance is MONOTONE (focused-ep4-r3 Finding 1, applied
/// to the attach lane): a delayed/older attach assertion never drags the
/// row's attribution back.
#[test]
fn reattach_never_moves_attribution_backwards() {
    let root = temp_root("reattach-monotone");
    let ledger = PaneLedger::new(Some(root.clone()));
    let mut w = write_provenance(
        "claude",
        "sess-mono",
        "term-mono",
        5_000,
        Some("client-1"),
        Some("device-1"),
        Some("device-1:tab-5"),
    );
    w.create_request_id = Some("req-old-mono");
    ledger.record_binding(&w).unwrap();
    ledger
        .note_pane_reattach(&reattach_write_replace_at(
            "claude",
            "sess-mono",
            "term-mono",
            "req-new-mono",
            6_000,
            Some("client-1"),
            Some("device-1"),
            Some("device-1:tab-4"),
            4_000, // an OLDER assertion than the row's 5_000
        ))
        .unwrap();
    let row = ledger.load_binding("claude", "sess-mono").unwrap();
    assert_eq!(row.create_request_id.as_deref(), Some("req-new-mono"));
    assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-5"));
    assert_eq!(row.last_attributed_at, Some(5_000));
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn load_index_dir_io_errors_are_loud_not_silently_empty() {
    // H2 (kata s52d companion): an I/O failure while listing the store must
    // NEVER surface as a silently-empty index. `bindings` forged as a
    // REGULAR FILE makes read_dir deterministic-ENOTDIR on any uid (chmod
    // tricks are root-skip-flaky); same for `pending`.
    let root = temp_root("load-loud-dir");
    std::fs::write(root.join("bindings"), b"not a dir").unwrap();
    std::fs::write(root.join("pending"), b"not a dir").unwrap();
    let (events, guard) = crate::invariants::capture::capture();
    let ledger = PaneLedger::new(Some(root.clone()));
    drop(guard);
    let events = events.lock().unwrap();
    let hits: Vec<_> = events
        .iter()
        .filter(|e| {
            e.target == "freshell_ws::pane_ledger"
                && e.message.contains("pane_ledger_load_index_dir_unreadable")
        })
        .collect();
    assert_eq!(
        hits.len(),
        2,
        "one ERROR per unreadable top-level dir (bindings + pending); got: {events:?}"
    );
    assert!(hits.iter().all(|h| h.fields.contains_key("path")));
    drop(events);
    assert!(
        !ledger.ever_bound("claude", "anything"),
        "index correctly empty; loudness is the contract"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn load_index_row_io_errors_are_loud_per_row() {
    // Same H2 lane, per-ROW: an entry ending in .json that is a DIRECTORY
    // makes the row read deterministic-EISDIR (uid-independent). Parse
    // errors of REAL rows stay silent-by-contract here (boot-scan quarantine
    // owns loudness) — this test must NOT flip that: only Io arms the event.
    let root = temp_root("load-loud-row");
    std::fs::create_dir_all(root.join("bindings").join("claude").join("ghost.json")).unwrap();
    let (events, guard) = crate::invariants::capture::capture();
    let ledger = PaneLedger::new(Some(root.clone()));
    drop(guard);
    let events = events.lock().unwrap();
    let hits: Vec<_> = events
        .iter()
        .filter(|e| {
            e.target == "freshell_ws::pane_ledger"
                && e.message.contains("pane_ledger_load_index_row_unreadable")
        })
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "one ERROR for the unreadable row; got: {events:?}"
    );
    let want_path = format!(
        "{}",
        root.join("bindings")
            .join("claude")
            .join("ghost.json")
            .display()
    );
    assert_eq!(hits[0].fields.get("path"), Some(&want_path));
    drop(events);
    assert!(ledger.list_bindings().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

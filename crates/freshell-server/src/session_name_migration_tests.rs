//! Task 7 behavioral tests — the one-time legacy-name consolidation.
//!
//! Every test drives REAL temp config/metadata/snapshot files, the REAL
//! `SessionNames` store and the REAL consolidation runner: no mocks of the
//! transaction, the store, or the settings ladder. The behaviors protected
//! here are the plan's consolidation contract:
//!
//! * deterministic conflict resolution — rank, proven rename recency and
//!   scope pick the same winner in every import order; among equal
//!   candidates the incumbent stays (window/device ids never decide);
//! * classification — a proven explicit session rename is manual; an old
//!   protected flag (automation→manual-flag path included) is
//!   `legacy_protected` with `legacyOrigin:"unknown"`, never manual, never
//!   a fabricated renamedAt/manualRevision; a known automatic label without
//!   old protection stays automatic;
//! * trustworthy explicit times order proven-manual candidates; generic
//!   updatedAt/mtime/`time.updated` never count as rename recency;
//! * backups are immutable and create-once (server.json + per-importId
//!   import backups); a backup failure retains every original;
//! * the receipt commits winners, winning evidence and acknowledged ids in
//!   ONE commit; a fault after the commit leaves the receipt standing and
//!   the next boot idempotently finishes the cleanup;
//! * scope-only cleanup never deletes summary/archive/delete/description
//!   rows and never touches unsupported providers;
//! * late/repeated/browser-only imports cannot beat a post-migration
//!   manual or accepted-Freshell-AI name; once the consolidation completed
//!   they are acknowledged without any effect (name-reliability Task 3);
//! * unresolved/ambiguous evidence stays recovery-only;
//! * an initial fallback installation never blocks a later explicit legacy
//!   import.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use freshell_freshagent::naming::SessionNaming;
use freshell_protocol::session_names::{
    legacy_name_candidate_id, LegacyCandidateIdInput, LegacyCandidateScope, LegacyEvidenceEnvelope,
    LegacyNameCandidate, LegacyNameImport, LegacyNameTarget, LegacyProtectionEvidence, NameIntent,
    NameSource, NamedProvider, SessionNameRef, SessionNameUpdate,
};
use freshell_ws::identity::TerminalIdentityRegistry;
use serde_json::{json, Map, Value};

use crate::session_metadata::SessionMetadataStore;
use crate::session_name_migration::{
    run_session_name_consolidation, SessionNameConsolidationInputs,
};
use crate::session_names::{SessionNames, NAME_MIGRATION_BOOT_IMPORT_ID, NAME_MIGRATION_DIR_NAME};
use crate::settings_store::SettingsStore;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn seed_config(dir: &Path, session_overrides: Value, terminal_overrides: Value) {
    let mut doc = json!({
        "version": 1,
        "settings": { "codingCli": {
            "enabledProviders": ["claude", "codex", "opencode"],
            "knownProviders": ["claude", "codex", "opencode"],
            "providers": {},
            "mcpServer": true
        } },
        "recentDirectories": ["/a"],
        "zzFutureKey": { "a": 1 },
        "sessionOverrides": session_overrides,
        "terminalOverrides": terminal_overrides,
        "projectColors": {}
    });
    doc["completedMigrations"] = json!([]);
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    std::fs::write(
        dir.join(".freshell").join("config.json"),
        serde_json::to_string_pretty(&doc).unwrap(),
    )
    .unwrap();
}

fn store_at(dir: &Path) -> SettingsStore {
    SettingsStore::load(
        Some(dir),
        vec![
            "claude".into(),
            "codex".into(),
            "opencode".into(),
            "amplifier".into(),
        ],
    )
}

fn read_config(dir: &Path) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
    )
    .unwrap()
}

/// A minimal home: config.json with empty overrides.
fn fresh_home() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    seed_config(&home, json!({}), json!({}));
    (tmp, home)
}

/// The consolidation inputs over a seeded home; `data_dir` is
/// `<home>/.freshell` (where the name document and backups live) and
/// `snapshots_dir` is `<home>/.freshell/tabs-registry`.
fn consolidation_inputs(
    home: &Path,
    names: Arc<SessionNames>,
    settings: Arc<SettingsStore>,
    metadata: Arc<SessionMetadataStore>,
    identity: TerminalIdentityRegistry,
) -> SessionNameConsolidationInputs {
    SessionNameConsolidationInputs {
        names,
        settings,
        metadata,
        identity,
        data_dir: home.join(".freshell"),
        snapshots_dir: Some(home.join(".freshell").join("tabs-registry")),
    }
}

async fn open_store(home: &Path) -> Arc<SessionNames> {
    SessionNames::open(home.join(".freshell")).unwrap()
}

async fn open_metadata(home: &Path) -> Arc<SessionMetadataStore> {
    Arc::new(SessionMetadataStore::new(home.join(".freshell")))
}

async fn record_of(
    names: &SessionNames,
    provider: NamedProvider,
    session_id: &str,
) -> Option<SessionNameUpdate> {
    let updates = names
        .get(vec![SessionNameRef::Session {
            provider,
            session_id: session_id.to_string(),
        }])
        .await
        .unwrap();
    updates.into_iter().next()
}

fn seed_snapshot_device(home: &Path, device: &str, records: Vec<Value>) {
    let dir = home.join(".freshell").join("tabs-registry");
    std::fs::create_dir_all(&dir).unwrap();
    // One valid generation file per device, exactly as `persist_generation`
    // writes them: `<enc(device)>/<enc(client)>-<capturedAt:020>-r<rev:012>.json`.
    let client = format!("{device}-client");
    let payload = json!({
        "deviceId": device,
        "deviceLabel": device,
        "clientInstanceId": client,
        "serverInstanceId": "srv",
        "snapshotRevision": 1,
        "capturedAt": 1,
        "records": records,
    });
    let encoded = freshell_ws::tabs_persist::encode_device_id(device).unwrap();
    let client_enc = freshell_ws::tabs_persist::encode_device_id(&client).unwrap();
    let device_dir = dir.join(encoded);
    std::fs::create_dir_all(&device_dir).unwrap();
    let gen_path = device_dir.join(format!(
        "{client_enc}-00000000000000000001-r000000000001.json"
    ));
    std::fs::write(&gen_path, serde_json::to_string_pretty(&payload).unwrap()).unwrap();
}

fn scoped_pane_payload(session_id: &str) -> Value {
    json!({
        "kind": "terminal",
        "mode": "claude",
        "terminalId": format!("term-{session_id}"),
        "createRequestId": format!("req-{session_id}"),
        "sessionRef": { "provider": "claude", "sessionId": session_id },
    })
}

fn candidate(
    id: &str,
    target: LegacyNameTarget,
    name: &str,
    source: NameSource,
    scope: LegacyCandidateScope,
    evidence_key: &str,
    protection: LegacyProtectionEvidence,
) -> LegacyNameCandidate {
    LegacyNameCandidate {
        id: id.to_string(),
        target,
        name: name.to_string(),
        source,
        scope,
        explicit_rename_at: None,
        evidence_key: evidence_key.to_string(),
        protection_evidence: protection,
    }
}

fn session_target(provider: NamedProvider, session_id: &str) -> LegacyNameTarget {
    LegacyNameTarget::Canonical(SessionNameRef::Session {
        provider,
        session_id: session_id.to_string(),
    })
}

/// A late browser-shaped import envelope (the untrusted HTTP lane).
fn browser_import(import_id: &str, candidates: Vec<LegacyNameCandidate>) -> LegacyNameImport {
    LegacyNameImport {
        version: 1,
        import_id: import_id.to_string(),
        evidence: vec![LegacyEvidenceEnvelope {
            storage_key: format!("freshell.layout.v3.test-{import_id}"),
            raw: json!({ "version": 4, "tabs": { "tabs": [] }, "panes": {} }).to_string(),
        }],
        candidates,
    }
}

/// Seed `count` scoped session-override rows (`claude:s{index}` at accepted
/// Freshell-AI rank — `titleSource:"ai"`), the object shape `seed_config`
/// takes for `config.sessionOverrides`.
fn seed_ai_override_rows(count: usize) -> Value {
    let mut rows = serde_json::Map::new();
    for index in 0..count {
        rows.insert(
            format!("claude:s{index}"),
            json!({ "titleOverride": format!("AI {index}"), "titleSource": "ai" }),
        );
    }
    Value::Object(rows)
}

/// The candidate `gather_session_overrides` mints for one seeded
/// `claude:s{index}` accepted-Freshell-AI row — the stable id tuple a
/// resumed boot must acknowledge, never re-apply.
fn gathered_override_candidate(index: usize) -> LegacyNameCandidate {
    let session_id = format!("s{index}");
    let name = format!("AI {index}");
    LegacyNameCandidate {
        id: legacy_name_candidate_id(LegacyCandidateIdInput {
            storage_key: "config.sessionOverrides",
            device_id: None,
            tab_id: None,
            pane_id: None,
            scope: LegacyCandidateScope::Session,
            provider: Some("claude"),
            session_id: Some(&session_id),
            name: &name,
            source: NameSource::FreshellAi,
            protection_evidence: LegacyProtectionEvidence::None,
            explicit_rename_at: None,
        }),
        target: session_target(NamedProvider::Claude, &session_id),
        name,
        source: NameSource::FreshellAi,
        scope: LegacyCandidateScope::Session,
        explicit_rename_at: None,
        evidence_key: format!("session-override:claude:{session_id}"),
        protection_evidence: LegacyProtectionEvidence::None,
    }
}

// ---------------------------------------------------------------------------
// Classification and the deterministic total order
// ---------------------------------------------------------------------------

/// Contradictory evidence across scopes for one session resolves by the
/// total order — the SAME winner regardless of candidate order, and both
/// permutation imports agree on text/source.
#[tokio::test]
async fn proven_manual_session_rename_beats_every_legacy_flag_in_any_order() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            // A proven explicit user rename (the old durable ladder)…
            "claude:s1": { "titleOverride": "My Session", "titleSource": "user",
                           "summaryOverride": "keep me", "archived": true },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    let identity = TerminalIdentityRegistry::new();

    let run = || {
        let inputs = consolidation_inputs(
            &home,
            names.clone(),
            settings.clone(),
            metadata.clone(),
            identity.clone(),
        );
        run_session_name_consolidation(inputs)
    };

    // A late browser import claiming a legacy-flag pane title for the same
    // session — delivered BEFORE the boot consolidation in one permutation
    // and after it in the other.
    let flagged_pane = candidate(
        "browser-1",
        session_target(NamedProvider::Claude, "s1"),
        "Pane Flag Title",
        NameSource::ProviderAi,
        LegacyCandidateScope::Pane,
        "freshell.layout.v3.w1#t1#p1",
        LegacyProtectionEvidence::LegacyFlag,
    );

    // Permutation A: browser import first, boot consolidation second.
    names
        .import_legacy(browser_import("browser-a", vec![flagged_pane.clone()]))
        .await
        .unwrap();
    run().await;
    let a = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();

    // Permutation B (fresh home): boot consolidation first, browser import
    // after. The same inputs must choose the same winner.
    let (tmp_b, home_b) = fresh_home();
    seed_config(
        &home_b,
        json!({
            "claude:s1": { "titleOverride": "My Session", "titleSource": "user",
                           "summaryOverride": "keep me", "archived": true },
        }),
        json!({}),
    );
    let settings_b = Arc::new(store_at(&home_b));
    let names_b = open_store(&home_b).await;
    let metadata_b = open_metadata(&home_b).await;
    run_session_name_consolidation(consolidation_inputs(
        &home_b,
        names_b.clone(),
        settings_b.clone(),
        metadata_b.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    names_b
        .import_legacy(browser_import("browser-b", vec![flagged_pane.clone()]))
        .await
        .unwrap();
    let b = record_of(&names_b, NamedProvider::Claude, "s1")
        .await
        .unwrap();

    assert_eq!(a.record.name, "My Session");
    assert_eq!(b.record.name, "My Session");
    assert_eq!(a.record.source, NameSource::Manual);
    assert_eq!(b.record.source, NameSource::Manual);
    // A proven manual rename carries its manual revision and NO fabricated
    // rename time (the legacy row had no trustworthy timestamp).
    assert!(a.record.manual_revision.is_some());
    assert_eq!(a.record.renamed_at, None);
    assert_eq!(a.record.legacy_origin, None);
    drop(tmp);
    drop(tmp_b);
}

/// The old automation→manual-flag path: a user-set flag keeps its label
/// protected but NEVER gains manual source or an invented
/// renamedAt/manualRevision.
#[tokio::test]
async fn legacy_flag_installs_legacy_protected_with_unknown_origin() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            // Unsourced old override (the automation→manual-flag path):
            // lossy provenance — protected, never human-claimed.
            "claude:s1": { "titleOverride": "Flagged Old Label" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Flagged Old Label");
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    assert_eq!(
        update.record.legacy_origin,
        Some(freshell_protocol::session_names::LegacyOrigin::Unknown)
    );
    // No fabricated rename evidence.
    assert_eq!(update.record.renamed_at, None);
    assert_eq!(update.record.manual_revision, None);
    drop(tmp);
}

/// A known automatic label without old protection stays automatic — the
/// migration never adds protection to an unprotected label.
#[tokio::test]
async fn known_automatic_rows_keep_their_source() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Freshell Made This", "titleSource": "ai" },
            "claude:s2": { "titleOverride": "From the first message", "titleSource": "first-message" },
            "claude:s3": { "titleOverride": "my-project", "titleSource": "dir" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    let s1 = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(s1.record.source, NameSource::FreshellAi);
    assert_eq!(s1.record.legacy_origin, None);
    let s2 = record_of(&names, NamedProvider::Claude, "s2")
        .await
        .unwrap();
    assert_eq!(s2.record.source, NameSource::FirstMessage);
    let s3 = record_of(&names, NamedProvider::Claude, "s3")
        .await
        .unwrap();
    assert_eq!(s3.record.source, NameSource::Directory);
    drop(tmp);
}

// ---------------------------------------------------------------------------
// Delta-review round 4, finding 1 — kilroy-mode rows stay in the legacy lane
// ---------------------------------------------------------------------------

/// A KILROY-MODE override row (the metadata store types its session kilroy;
/// the row's provider string is `claude`) stays in the legacy lane: the
/// consolidation never imports it into a canonical record — never the
/// Global Constraint's forbidden competing Kilroy record — and never makes
/// it a cleanup target, so the title fields the sweep still writes for
/// kilroy keep serving kilroy's existing UI verbatim.
#[tokio::test]
async fn kilroy_mode_override_rows_stay_legacy_never_imported_or_cleaned() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:k1": { "titleOverride": "Kilroy Label", "titleSource": "user",
                           "summaryOverride": "keep", "archived": true },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    metadata
        .set("claude", "k1", "kilroy", Some("explicit"))
        .await
        .unwrap();
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    // Never a competing kilroy record.
    assert!(
        record_of(&names, NamedProvider::Claude, "k1")
            .await
            .is_none(),
        "a kilroy-mode row never enters the naming authority"
    );
    // The legacy row survives verbatim — title fields intact (never a
    // cleanup target), non-title fields untouched.
    let row = settings
        .session_overrides()
        .get("claude:k1")
        .cloned()
        .expect("the kilroy row survives the consolidation");
    assert_eq!(row["titleOverride"], json!("Kilroy Label"));
    assert_eq!(row["titleSource"], json!("user"));
    assert_eq!(row["summaryOverride"], json!("keep"));
    assert_eq!(row["archived"], json!(true));
    drop(tmp);
}

/// The singular-name half (the plan's Global Constraint): a session the
/// metadata ALSO types kilroy, but whose canonical record already exists
/// through the claude mode (the dual-mode scenario — here the record a
/// landed earlier path left), still migrates its legacy row exactly like
/// any scoped row: the user title wins into the ONE canonical record, the
/// migrated title fields are cleaned, and the exclusion can never be
/// per-underlying-session — only per kilroy-ONLY evidence.
#[tokio::test]
async fn a_dual_mode_session_with_a_canonical_record_still_migrates_its_legacy_row() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:d1": { "titleOverride": "Dual Mode Rename", "titleSource": "user",
                           "summaryOverride": "keep" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    // The canonical record through the claude mode (the index-adopted
    // hydration path), BEFORE the boot consolidation runs — the operative
    // dual-mode evidence at migration time.
    names
        .hydrate_indexed(
            crate::session_name_generation::IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: "d1".to_string(),
                cwd: Some("/p".to_string()),
                first_user_message: Some("Scoped first".to_string()),
                provider_title: None,
            },
            false,
        )
        .await
        .unwrap();
    metadata
        .set("claude", "d1", "kilroy", Some("explicit"))
        .await
        .unwrap();
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    // The legacy row still migrated: the proven user rename won into the
    // ONE canonical record...
    let record = record_of(&names, NamedProvider::Claude, "d1")
        .await
        .expect("the canonical record keeps owning the dual-mode session");
    assert_eq!(record.record.name, "Dual Mode Rename");
    assert_eq!(record.record.source, NameSource::Manual);
    // ...the migrated title fields were cleaned (the existing suppression
    // logic still works)...
    let row = settings
        .session_overrides()
        .get("claude:d1")
        .cloned()
        .expect("the row itself survives (never a whole-row delete)");
    assert!(row.get("titleOverride").is_none(), "cleaned row: {row}");
    assert!(row.get("titleSource").is_none(), "cleaned row: {row}");
    // ...and the never-migrated fields survive.
    assert_eq!(row["summaryOverride"], json!("keep"));
    drop(tmp);
}

/// The boot-loop half of the same defect: the sweep still writes
/// legacy-ladder titles for kilroy-only sessions, so after the receipt
/// commits a FRESH kilroy title is post-migration evidence. The next
/// boot's re-consolidation must not absorb it as "late legacy evidence" —
/// no backup-and-wipe, the row stays live in the legacy lane.
#[tokio::test]
async fn post_migration_kilroy_titles_survive_the_late_evidence_pass() {
    let (tmp, home) = fresh_home();
    seed_config(&home, json!({}), json!({}));
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    metadata
        .set("claude", "k1", "kilroy", Some("explicit"))
        .await
        .unwrap();
    let run = || {
        run_session_name_consolidation(consolidation_inputs(
            &home,
            names.clone(),
            settings.clone(),
            metadata.clone(),
            TerminalIdentityRegistry::new(),
        ))
    };
    run().await;
    assert!(
        names.migration_completed(),
        "the receipt committed on the first boot"
    );

    // The sweep's legacy ladder writes a fresh kilroy title
    // POST-migration (kilroy keeps its existing behavior).
    settings
        .patch_session_override(
            "claude:k1",
            &[
                ("titleOverride", Some(json!("Fresh Kilroy Title"))),
                ("titleSource", Some(json!("first-message"))),
            ],
        )
        .await;

    // The next boot must NOT treat it as late legacy evidence.
    run().await;
    let row = settings
        .session_overrides()
        .get("claude:k1")
        .cloned()
        .expect("the kilroy title survives the late-evidence pass");
    assert_eq!(row["titleOverride"], json!("Fresh Kilroy Title"));
    assert_eq!(row["titleSource"], json!("first-message"));
    let late_dir = home
        .join(".freshell")
        .join(NAME_MIGRATION_DIR_NAME)
        .join("late-legacy-evidence");
    assert!(
        !late_dir.exists(),
        "a kilroy-mode row is never late legacy evidence"
    );
    assert!(
        record_of(&names, NamedProvider::Claude, "k1")
            .await
            .is_none(),
        "the late pass never mints a canonical record either"
    );
    drop(tmp);
}

/// Scope tie-break: session > pane > source_tab > terminal > derived — the
/// same winner from either import order.
#[tokio::test]
async fn same_rank_conflicts_resolve_deterministically_across_orders() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;

    let pane = candidate(
        "c-pane",
        session_target(NamedProvider::Claude, "s1"),
        "Pane Label",
        NameSource::ProviderAi,
        LegacyCandidateScope::Pane,
        "envelope-a#tab#pane-1",
        LegacyProtectionEvidence::None,
    );
    let source_tab = candidate(
        "c-tab",
        session_target(NamedProvider::Claude, "s1"),
        "Tab Label",
        NameSource::ProviderAi,
        LegacyCandidateScope::SourceTab,
        "envelope-a#tab",
        LegacyProtectionEvidence::None,
    );

    // Order 1: pane then tab.
    names
        .import_legacy(browser_import(
            "order-1",
            vec![pane.clone(), source_tab.clone()],
        ))
        .await
        .unwrap();
    let first = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(
        first.record.name, "Pane Label",
        "pane scope outranks source_tab"
    );

    // Order 2 on a fresh store: tab then pane — same winner.
    let names2 = SessionNames::open(home.join(".freshell").join("order2")).unwrap();
    names2
        .import_legacy(browser_import(
            "order-2",
            vec![source_tab.clone(), pane.clone()],
        ))
        .await
        .unwrap();
    let second = record_of(&names2, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(second.record.name, "Pane Label");
    drop(tmp);
}

/// Trustworthy explicit-rename times order proven-manual candidates (later
/// first, dated ahead of undated) — while generic layout `updatedAt`,
/// file mtime and record `revision` never become explicitRenameAt.
#[tokio::test]
async fn explicit_rename_times_order_manual_candidates_and_generic_times_do_not() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;

    let earlier = LegacyNameCandidate {
        id: "m-early".into(),
        target: session_target(NamedProvider::Claude, "s1"),
        name: "Earlier Rename".into(),
        source: NameSource::Manual,
        scope: LegacyCandidateScope::Session,
        explicit_rename_at: Some(1_000),
        evidence_key: "session-override:claude:s1".into(),
        protection_evidence: LegacyProtectionEvidence::ExplicitRename,
    };
    let later = LegacyNameCandidate {
        id: "m-late".into(),
        target: session_target(NamedProvider::Claude, "s1"),
        name: "Later Rename".into(),
        source: NameSource::Manual,
        scope: LegacyCandidateScope::Session,
        explicit_rename_at: Some(2_000),
        evidence_key: "session-override:claude:s1".into(),
        protection_evidence: LegacyProtectionEvidence::ExplicitRename,
    };

    // Both are untrusted imports: the store must not honor the explicit-
    // rename claims from the HTTP lane at all — both become legacy
    // protected, and the claimed times never order them (the equal
    // candidates keep whichever installed first).
    let result = names
        .import_legacy(browser_import(
            "times-1",
            vec![earlier.clone(), later.clone()],
        ))
        .await
        .unwrap();
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    assert!(result.acknowledged.contains(&"m-early".to_string()));
    assert!(result.acknowledged.contains(&"m-late".to_string()));

    // The trusted boot lane honors the times: the LATER rename wins.
    let names2 = SessionNames::open(home.join(".freshell").join("times2")).unwrap();
    let boot = LegacyNameImport {
        version: 1,
        import_id: NAME_MIGRATION_BOOT_IMPORT_ID.to_string(),
        evidence: vec![],
        candidates: vec![earlier, later],
    };
    names2.import_legacy(boot).await.unwrap();
    let update = record_of(&names2, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Later Rename");
    assert_eq!(update.record.source, NameSource::Manual);

    // A snapshot record's generic updatedAt never orders as rename recency:
    // the seeded record below carries a huge updatedAt, but its tab label
    // is classified by flag/scope only (no explicitRenameAt is ever set).
    let (tmp2, home2) = fresh_home();
    seed_config(&home2, json!({}), json!({}));
    seed_snapshot_device(
        &home2,
        "device-1",
        vec![json!({
            "tabKey": "claude:snap-1",
            "tabId": "tab-1",
            "serverInstanceId": "srv",
            "deviceId": "device-1",
            "deviceLabel": "device-1",
            "tabName": "Snapshot Tab",
            "status": "open",
            "revision": 999999,
            "createdAt": 1,
            "updatedAt": 9_999_999_999i64,
            "paneCount": 1,
            "titleSetByUser": true,
            "panes": [{ "paneId": "p1", "kind": "terminal", "title": "Pane Mirror",
                        "payload": scoped_pane_payload("snap-1") }],
        })],
    );
    let settings2 = Arc::new(store_at(&home2));
    let names3 = open_store(&home2).await;
    let metadata2 = open_metadata(&home2).await;
    run_session_name_consolidation(consolidation_inputs(
        &home2,
        names3.clone(),
        settings2.clone(),
        metadata2.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    let update = record_of(&names3, NamedProvider::Claude, "snap-1")
        .await
        .unwrap();
    // The flagged tab label won as legacy_protected — no rename time
    // anywhere on the record.
    assert_eq!(update.record.name, "Snapshot Tab");
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    assert_eq!(update.record.renamed_at, None);
    assert_eq!(update.record.manual_revision, None);
    drop(tmp);
    drop(tmp2);
}

// ---------------------------------------------------------------------------
// Backups, receipts, cleanup
// ---------------------------------------------------------------------------

/// The immutable server backup is written once, byte-stable across boots,
/// and never rewritten by a later boot.
#[tokio::test]
async fn server_backup_is_written_once_and_preserves_original_content() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Precious Old Name", "titleSource": "user" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    let backup_path = home
        .join(".freshell")
        .join(NAME_MIGRATION_DIR_NAME)
        .join("server.json");
    let first_bytes = std::fs::read(&backup_path).unwrap();
    assert!(
        serde_json::from_slice::<Value>(&first_bytes)
            .unwrap()
            .get("sources")
            .and_then(|s| s.get("config.sessionOverrides"))
            .and_then(|v| v.get("claude:s1"))
            .and_then(|row| row.get("titleOverride"))
            == Some(&json!("Precious Old Name")),
        "the backup preserves byte-equivalent original content"
    );

    // A second boot (receipt completed, cleanup retry) must not rewrite it.
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    assert_eq!(
        std::fs::read(&backup_path).unwrap(),
        first_bytes,
        "the server backup is create-once"
    );
    drop(tmp);
}

/// Round-2 carried finding F3 (adjudicated): after the consolidation
/// receipt commits, a side-by-side LEGACY writer (an old binary sharing
/// this Freshell home) can still write a scoped `titleOverride` to the
/// config. The next new-server boot gathers it as fresh evidence, skips
/// the import (receipt closed), and the idempotent cleanup deletes it —
/// with the create-once `server.json` already frozen and the import path
/// never seeing it. The late value must still get a recovery copy before
/// suppression, mirroring the late BROWSER import's per-import backup:
/// never reactivating the alias, never losing the string.
#[tokio::test]
async fn post_migration_legacy_title_fields_get_a_late_recovery_copy() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Original Name", "titleSource": "user" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    assert!(names.migration_completed());
    assert!(
        settings
            .session_overrides()
            .get("claude:s1")
            .unwrap()
            .get("titleOverride")
            .is_none(),
        "boot 1 cleaned the migrated field"
    );

    // The side-by-side legacy writer: an old binary writes a NEW scoped
    // titleOverride straight into the config, post-migration.
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Post-Migration Legacy Title", "titleSource": "user" },
        }),
        json!({}),
    );

    // Boot 2 (fresh process): the receipt is complete, so the import is
    // skipped and the cleanup suppresses the late field — but a content-
    // addressed late-evidence backup preserves it first.
    let names2 = open_store(&home).await;
    let settings2 = Arc::new(store_at(&home));
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names2.clone(),
        settings2.clone(),
        open_metadata(&home).await,
        TerminalIdentityRegistry::new(),
    ))
    .await;
    assert!(
        settings2
            .session_overrides()
            .get("claude:s1")
            .unwrap()
            .get("titleOverride")
            .is_none(),
        "the late legacy field is still suppressed (no reactivated alias)"
    );
    assert!(
        read_config(&home)["sessionOverrides"]["claude:s1"]
            .get("titleOverride")
            .is_none(),
        "the suppression flushed"
    );

    // The recovery copy: one late-evidence file under the migration dir,
    // preserving the late title verbatim.
    let late_dir = home
        .join(".freshell")
        .join(NAME_MIGRATION_DIR_NAME)
        .join("late-legacy-evidence");
    let mut late_files: Vec<_> = std::fs::read_dir(&late_dir)
        .unwrap_or_else(|e| panic!("the late-evidence backup dir exists: {e}"))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    late_files.sort();
    assert!(
        !late_files.is_empty(),
        "a late legacy writer's title gets a recovery copy before suppression"
    );
    let mut found = false;
    for path in &late_files {
        let body: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        if body
            .get("sources")
            .and_then(|s| s.get("config.sessionOverrides"))
            .and_then(|v| v.get("claude:s1"))
            .and_then(|row| row.get("titleOverride"))
            == Some(&json!("Post-Migration Legacy Title"))
        {
            found = true;
        }
    }
    assert!(
        found,
        "the late recovery copy preserves the post-migration title verbatim: {late_files:?}"
    );

    // The recovery copy is create-once per content: a THIRD boot with the
    // fields already cleaned writes nothing new.
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names2.clone(),
        settings2.clone(),
        open_metadata(&home).await,
        TerminalIdentityRegistry::new(),
    ))
    .await;
    let late_files_after: Vec<_> = std::fs::read_dir(&late_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert_eq!(
        late_files_after.len(),
        late_files.len(),
        "an already-clean boot adds no late backups"
    );
    drop(tmp);
}

/// Scope-only cleanup: title fields leave the scoped rows; summary, archive
/// and delete data survive; unsupported providers keep everything.
#[tokio::test]
async fn cleanup_removes_only_title_fields_and_preserves_row_data() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Renamed", "titleSource": "user",
                           "summaryOverride": "keep me", "archived": true },
            "claude:s2": { "titleOverride": "Deleted row title", "titleSource": "ai",
                           "deleted": true },
            "amplifier:a1": { "titleOverride": "Amplifier Stays", "titleSource": "ai" },
        }),
        json!({
            "t-unresolvable": { "titleOverride": "Terminal Stays", "descriptionOverride": "d" },
        }),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    let cfg = read_config(&home);
    let s1 = &cfg["sessionOverrides"]["claude:s1"];
    assert!(s1.get("titleOverride").is_none(), "{s1}");
    assert!(s1.get("titleSource").is_none(), "{s1}");
    assert_eq!(s1["summaryOverride"], json!("keep me"));
    assert_eq!(s1["archived"], json!(true));
    let s2 = &cfg["sessionOverrides"]["claude:s2"];
    assert!(s2.get("titleOverride").is_none());
    assert!(s2.get("titleSource").is_none());
    assert_eq!(s2["deleted"], json!(true), "the delete field survives");
    // Unsupported provider rows are untouched.
    assert_eq!(
        cfg["sessionOverrides"]["amplifier:a1"]["titleOverride"],
        json!("Amplifier Stays")
    );
    // An unresolved terminal override stays (its terminal is not scoped).
    assert_eq!(
        cfg["terminalOverrides"]["t-unresolvable"]["titleOverride"],
        json!("Terminal Stays")
    );
    assert_eq!(
        cfg["terminalOverrides"]["t-unresolvable"]["descriptionOverride"],
        json!("d")
    );
    // The winner survived the cleanup in the canonical store.
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Renamed");
    assert_eq!(update.record.source, NameSource::Manual);
    drop(tmp);
}

/// Fault after the canonical commit before cleanup: the receipt stands, a
/// later boot finishes the cleanup idempotently, and no duplicate
/// consolidation runs.
#[cfg(unix)]
#[tokio::test]
async fn fault_after_commit_before_cleanup_finishes_idempotently() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Committed Name", "titleSource": "user" },
        }),
        json!({}),
    );
    // The name document and the migration backups live in their own
    // writable data dir; the CONFIG dir is made read-only so boot 1's
    // cleanup cannot flush (patch_* clears memory, persist fails).
    let data_dir = home.join("name-store");
    std::fs::create_dir_all(&data_dir).unwrap();
    let names = SessionNames::open(data_dir.clone()).unwrap();
    let settings = Arc::new(store_at(&home));
    let metadata = open_metadata(&home).await;

    let fdir = home.join(".freshell");
    use std::os::unix::fs::PermissionsExt;
    let mut ro = std::fs::metadata(&fdir).unwrap().permissions();
    ro.set_mode(0o555);
    std::fs::set_permissions(&fdir, ro).unwrap();
    if std::fs::write(fdir.join("probe"), b"x").is_err() {
        let _ = std::fs::remove_file(fdir.join("probe"));
        run_session_name_consolidation(SessionNameConsolidationInputs {
            names: names.clone(),
            settings: settings.clone(),
            metadata: metadata.clone(),
            identity: TerminalIdentityRegistry::new(),
            data_dir: data_dir.clone(),
            snapshots_dir: None,
        })
        .await;
        // The receipt committed and this process's in-memory override map
        // already stopped consulting the migrated fields.
        assert!(names.migration_completed());
        let in_memory = settings.session_overrides();
        assert!(in_memory
            .get("claude:s1")
            .unwrap()
            .get("titleOverride")
            .is_none());
        // Disk still holds the fields (cleanup could not flush).
        assert!(
            read_config(&home)["sessionOverrides"]["claude:s1"]["titleOverride"]
                == json!("Committed Name")
        );

        // Boot 2 (writable): a fresh process's stores — the receipt is
        // already committed (no re-consolidation), the cleanup retry
        // finishes from the on-disk rows.
        let mut rw = std::fs::metadata(&fdir).unwrap().permissions();
        rw.set_mode(0o755);
        std::fs::set_permissions(&fdir, rw).unwrap();
        let names2 = SessionNames::open(data_dir.clone()).unwrap();
        let settings2 = Arc::new(store_at(&home));
        run_session_name_consolidation(SessionNameConsolidationInputs {
            names: names2.clone(),
            settings: settings2.clone(),
            metadata: open_metadata(&home).await,
            identity: TerminalIdentityRegistry::new(),
            data_dir,
            snapshots_dir: None,
        })
        .await;
        assert!(
            read_config(&home)["sessionOverrides"]["claude:s1"]
                .get("titleOverride")
                .is_none(),
            "the idempotent cleanup retry finished"
        );
        let update = record_of(&names2, NamedProvider::Claude, "s1")
            .await
            .unwrap();
        assert_eq!(update.record.name, "Committed Name");
        assert_eq!(update.record.source, NameSource::Manual);
    } else {
        let _ = std::fs::remove_file(fdir.join("probe"));
        // The precondition is the test: a chmod 0o555 dir is still
        // writable for root, so under root the read-only enforcement this
        // fault injection depends on CANNOT hold. Refuse to silently
        // self-skip — fail loudly instead (run the suite as a non-root
        // user) so the pinned fault behavior can never quietly not run.
        panic!(
            "fault_after_commit_before_cleanup: cannot enforce the read-only \
             config dir in this environment (running as root?); rerun as a \
             non-root user so the cleanup-flush fault injection actually fires"
        );
    }
    drop(tmp);
}

/// Late/repeated/browser-only imports cannot beat a post-migration manual
/// rename or a newly accepted Freshell AI name.
#[tokio::test]
async fn late_legacy_imports_cannot_beat_post_migration_names() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "Old Consolidated", "titleSource": "user" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    // A post-migration explicit user rename.
    names
        .rename(freshell_freshagent::naming::RenameNameInput {
            target: SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: "s1".into(),
            },
            name: "Fresh User Rename".into(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
        .unwrap();

    // A late offline browser device arrives with an old flagged label.
    let late = candidate(
        "late-1",
        session_target(NamedProvider::Claude, "s1"),
        "Stale Old Device Label",
        NameSource::Manual,
        LegacyCandidateScope::Pane,
        "envelope-late#tab#pane",
        LegacyProtectionEvidence::ExplicitRename,
    );
    let result = names
        .import_legacy(browser_import("late-device", vec![late]))
        .await
        .unwrap();
    assert_eq!(result.acknowledged, vec!["late-1".to_string()]);
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Fresh User Rename");
    assert_eq!(update.record.source, NameSource::Manual);

    // A newly accepted Freshell AI name on another session is equally
    // protected from a later legacy candidate. (Index hydration installs
    // the session's base record the accepted answer upgrades.)
    names
        .hydrate_indexed(
            crate::session_name_generation::IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: "s2".into(),
                cwd: None,
                first_user_message: None,
                provider_title: None,
            },
            false,
        )
        .await
        .unwrap();
    names
        .offer(
            SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: "s2".into(),
            },
            "Accepted AI Name".into(),
            NameSource::FreshellAi,
        )
        .await
        .unwrap();
    names
        .import_legacy(browser_import(
            "late-device-2",
            vec![candidate(
                "late-2",
                session_target(NamedProvider::Claude, "s2"),
                "Stale Flagged Label",
                NameSource::Manual,
                LegacyCandidateScope::Pane,
                "envelope-late-2#tab#pane",
                LegacyProtectionEvidence::LegacyFlag,
            )],
        ))
        .await
        .unwrap();
    let update = record_of(&names, NamedProvider::Claude, "s2")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Accepted AI Name");
    assert_eq!(update.record.source, NameSource::FreshellAi);
    drop(tmp);
}

/// An initial fallback installation never blocks a higher-rank legacy
/// candidate that arrives BEFORE the consolidation completes: a boot chunk
/// that installed only a low-rank fallback (the boot was interrupted before
/// its receipt committed) still accepts a late device's flagged label.
#[tokio::test]
async fn initial_fallback_installation_does_not_block_later_legacy_import() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;

    // The interrupted boot's chunk: the gathered `titleSource:"dir"`
    // fallback for claude:s1, imported under the trusted boot lane without
    // the completion receipt.
    names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: NAME_MIGRATION_BOOT_IMPORT_ID.to_string(),
            evidence: vec![],
            candidates: vec![candidate(
                "boot-dir-1",
                session_target(NamedProvider::Claude, "s1"),
                "dir-name",
                NameSource::Directory,
                LegacyCandidateScope::Session,
                "session-override:claude:s1",
                LegacyProtectionEvidence::None,
            )],
        })
        .await
        .unwrap();
    assert!(!names.migration_completed());
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.source, NameSource::Directory);

    // A late device's flagged pane label upgrades the fallback.
    names
        .import_legacy(browser_import(
            "late-upgrade",
            vec![candidate(
                "up-1",
                session_target(NamedProvider::Claude, "s1"),
                "User Flagged Pane",
                NameSource::Manual,
                LegacyCandidateScope::Pane,
                "envelope-up#tab#pane",
                LegacyProtectionEvidence::LegacyFlag,
            )],
        ))
        .await
        .unwrap();
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "User Flagged Pane");
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    drop(tmp);
}

/// Name-reliability Task 3: once the real consolidation runner has
/// completed, a late device's import is acknowledged and changes nothing —
/// the installed fallback stays for the normal naming flows to replace.
#[tokio::test]
async fn a_late_device_import_after_consolidation_leaves_the_fallback_unchanged() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({
            "claude:s1": { "titleOverride": "dir-name", "titleSource": "dir" },
        }),
        json!({}),
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    assert!(names.migration_completed());
    let installed = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(installed.record.name, "dir-name");
    assert_eq!(installed.record.source, NameSource::Directory);

    let result = names
        .import_legacy(browser_import(
            "late-after-completion",
            vec![candidate(
                "up-1",
                session_target(NamedProvider::Claude, "s1"),
                "User Flagged Pane",
                NameSource::Manual,
                LegacyCandidateScope::Pane,
                "envelope-up#tab#pane",
                LegacyProtectionEvidence::LegacyFlag,
            )],
        ))
        .await
        .unwrap();
    assert_eq!(result.acknowledged, vec!["up-1".to_string()]);
    assert!(result.names.is_empty());
    let after = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(after.record.name, "dir-name");
    assert_eq!(after.record.source, NameSource::Directory);
    assert_eq!(after.record.revision, installed.record.revision);
    drop(tmp);
}

/// Simultaneous imports serialize under the strict transaction: racing two
/// imports (different devices, same target, equal rank and scope) both
/// acknowledge and leave a single coherent winner — whichever transaction
/// landed first. The other device's equal candidate never replaces it
/// (window/device ids never decide a name, Task 3).
#[tokio::test]
async fn simultaneous_imports_serialize_and_converge() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;

    let device_a = candidate(
        "race-a",
        session_target(NamedProvider::Claude, "s1"),
        "Device A Label",
        NameSource::Manual,
        LegacyCandidateScope::Pane,
        "envelope-a#tab#pane",
        LegacyProtectionEvidence::LegacyFlag,
    );
    let device_b = candidate(
        "race-b",
        session_target(NamedProvider::Claude, "s1"),
        "Device B Label",
        NameSource::Manual,
        LegacyCandidateScope::Pane,
        "envelope-b#tab#pane",
        LegacyProtectionEvidence::LegacyFlag,
    );

    let import_a = names.import_legacy(browser_import("race-import-a", vec![device_a.clone()]));
    let import_b = names.import_legacy(browser_import("race-import-b", vec![device_b.clone()]));
    let (a, b) = tokio::join!(import_a, import_b);
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.acknowledged, vec!["race-a".to_string()]);
    assert_eq!(b.acknowledged, vec!["race-b".to_string()]);

    // Both are legacy_protected pane candidates for the same target: the
    // first install allocated the store's first revision, and the second
    // (equal) candidate was acknowledged without a replacement.
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert!(
        ["Device A Label", "Device B Label"].contains(&update.record.name.as_str()),
        "one device's label won: {:?}",
        update.record.name
    );
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    assert_eq!(
        update.record.revision, 1,
        "exactly one install: the equal candidate never replaced it"
    );

    // Re-delivering both imports (either order) keeps the same winner.
    for import in [
        browser_import("race-import-b", vec![device_b]),
        browser_import("race-import-a", vec![device_a]),
    ] {
        names.import_legacy(import).await.unwrap();
        let again = record_of(&names, NamedProvider::Claude, "s1")
            .await
            .unwrap();
        assert_eq!(again.record.name, update.record.name);
        assert_eq!(again.record.revision, update.record.revision);
    }
    drop(tmp);
}

/// Corrupted optional evidence (an unparseable raw envelope / a candidate
/// naming an empty name) is retained by the immutable backup and
/// acknowledged, never applied and never blocking the healthy candidates.
#[tokio::test]
async fn corrupted_optional_evidence_is_retained_not_applied() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;

    let bad_name = candidate(
        "bad-name",
        session_target(NamedProvider::Claude, "s1"),
        "   ",
        NameSource::ProviderAi,
        LegacyCandidateScope::Pane,
        "envelope#tab#pane",
        LegacyProtectionEvidence::None,
    );
    let unresolved_terminal = candidate(
        "bad-terminal",
        LegacyNameTarget::legacy_terminal("t-gone", "srv-old"),
        "Ghost Terminal",
        NameSource::Manual,
        LegacyCandidateScope::Terminal,
        "envelope#terminal",
        LegacyProtectionEvidence::LegacyFlag,
    );
    let healthy = candidate(
        "good-1",
        session_target(NamedProvider::Claude, "s1"),
        "Healthy Label",
        NameSource::ProviderAi,
        LegacyCandidateScope::Pane,
        "envelope#tab#pane-2",
        LegacyProtectionEvidence::None,
    );

    let result = names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: "mixed-import".into(),
            evidence: vec![LegacyEvidenceEnvelope {
                storage_key: "freshell.layout.v3.corrupt".into(),
                raw: "{not json".into(),
            }],
            candidates: vec![bad_name, unresolved_terminal, healthy.clone()],
        })
        .await
        .unwrap();

    // Per-candidate acknowledgment: all three, including the bad ones.
    assert_eq!(result.acknowledged.len(), 3);
    assert!(result.acknowledged.contains(&"bad-name".to_string()));
    assert!(result.acknowledged.contains(&"bad-terminal".to_string()));
    // The healthy candidate still applied.
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Healthy Label");

    // The immutable import backup retained the corrupted raw bytes.
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(b"mixed-import");
        format!("{:x}", hasher.finalize())
    };
    let backup = home
        .join(".freshell")
        .join(NAME_MIGRATION_DIR_NAME)
        .join("imports")
        .join(format!("{digest}.json"));
    let body: Value = serde_json::from_slice(&std::fs::read(&backup).unwrap()).unwrap();
    assert_eq!(body["evidence"][0]["raw"], json!("{not json"));

    // A repeated delivery of the same import is a pure no-op (Write-free).
    let again = names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: "mixed-import".into(),
            evidence: vec![],
            candidates: vec![healthy.clone()],
        })
        .await
        .unwrap();
    assert!(again.acknowledged.contains(&"good-1".to_string()));
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Healthy Label");
    drop(tmp);
}

/// A backup failure retains every original and acknowledges nothing.
#[tokio::test]
async fn backup_failure_retains_originals_and_acks_nothing() {
    // Break the backup dir by making it a FILE: create_dir_all fails.
    let (tmp, home) = fresh_home();
    let home2 = home.clone();
    let imports_dir2 = home2
        .join(".freshell")
        .join(NAME_MIGRATION_DIR_NAME)
        .join("imports");
    std::fs::create_dir_all(imports_dir2.parent().unwrap()).unwrap();
    std::fs::write(&imports_dir2, b"not a dir").unwrap();
    let names2 = SessionNames::open(home2.join(".freshell")).unwrap();

    let result = names2
        .import_legacy(browser_import(
            "no-backup",
            vec![candidate(
                "nb-1",
                session_target(NamedProvider::Claude, "s1"),
                "Never Applied",
                NameSource::Manual,
                LegacyCandidateScope::Pane,
                "envelope#tab#pane",
                LegacyProtectionEvidence::LegacyFlag,
            )],
        ))
        .await;
    assert!(result.is_err(), "a failed backup must fail the import");
    // Nothing was applied and nothing acknowledged.
    let update = record_of(&names2, NamedProvider::Claude, "s1").await;
    assert!(update.is_none());
    drop(tmp);
}

/// Per-candidate acknowledgment — never an early whole-import shortcut: a
/// multi-candidate import acknowledges exactly its candidates, and an
/// oversized envelope is refused.
#[tokio::test]
async fn per_candidate_acknowledgment_and_batch_limit() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;

    let mut candidates = Vec::new();
    for index in 0..100 {
        candidates.push(candidate(
            &format!("batch-{index}"),
            session_target(NamedProvider::Claude, &format!("s{index}")),
            "Label {index}",
            NameSource::ProviderAi,
            LegacyCandidateScope::Pane,
            &format!("envelope#tab#pane-{index}"),
            LegacyProtectionEvidence::None,
        ));
    }
    let result = names
        .import_legacy(browser_import("batch-1", candidates.clone()))
        .await
        .unwrap();
    assert_eq!(result.acknowledged.len(), 100);
    assert_eq!(result.names.len(), 100);

    candidates.push(candidate(
        "batch-100",
        session_target(NamedProvider::Claude, "s-over"),
        "One Too Many",
        NameSource::ProviderAi,
        LegacyCandidateScope::Pane,
        "envelope#tab#pane-over",
        LegacyProtectionEvidence::None,
    ));
    assert!(names
        .import_legacy(browser_import("batch-2", candidates))
        .await
        .is_err());
    drop(tmp);
}

/// Task 7 review I1: a home with more than 100 gathered candidates (the
/// long-lived multi-device install) consolidates fully. The boot import
/// honors the plan's own batching rule — at most 100 candidates per
/// envelope/importId — so >100 candidates arrive as sequential chunk
/// imports; every session (including the tail chunk's) lands with its
/// saved name, and candidates competing for one target ACROSS a chunk
/// boundary still resolve by the deterministic total order.
#[tokio::test]
async fn a_boot_with_more_than_100_candidates_consolidates_fully() {
    let (tmp, home) = fresh_home();
    // 149 filler rows + one competed row whose session ALSO carries a
    // snapshot pane mirror and source-tab label — lower-ranked provider-AI
    // candidates that sort into the tail chunk.
    let mut rows = match seed_ai_override_rows(149) {
        Value::Object(rows) => rows,
        _ => unreachable!("seeded as an object"),
    };
    rows.insert(
        "claude:s-competed".to_string(),
        json!({ "titleOverride": "Override Won", "titleSource": "ai" }),
    );
    seed_config(&home, Value::Object(rows), json!({}));
    seed_snapshot_device(
        &home,
        "device-big",
        vec![json!({
            "tabKey": "claude:s-competed", "tabId": "tab-c", "serverInstanceId": "srv",
            "deviceId": "device-big", "deviceLabel": "device-big",
            "tabName": "Snapshot Tab Label", "status": "open", "revision": 1,
            "createdAt": 1, "updatedAt": 2, "paneCount": 1, "titleSetByUser": false,
            "panes": [{ "paneId": "p1", "kind": "terminal", "title": "Pane Mirror",
                        "payload": scoped_pane_payload("s-competed") }],
        })],
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;

    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    assert!(
        names.migration_completed(),
        "the >100-candidate boot must consolidate instead of being refused"
    );
    // Chunk 0 landed: the lexicographically-first filler keeps its name.
    let first = record_of(&names, NamedProvider::Claude, "s0")
        .await
        .unwrap();
    assert_eq!(first.record.name, "AI 0");
    // The tail chunk landed: "claude:s99" sorts last among the fillers, so
    // its candidate rides the second chunk.
    let tail = record_of(&names, NamedProvider::Claude, "s99")
        .await
        .unwrap();
    assert_eq!(tail.record.name, "AI 99");
    // Cross-chunk competition resolves by the total order: the session
    // override (accepted Freshell AI) beats the snapshot pane mirror and
    // source-tab label (provider AI) that arrived in the other chunk.
    let competed = record_of(&names, NamedProvider::Claude, "s-competed")
        .await
        .unwrap();
    assert_eq!(competed.record.name, "Override Won");
    assert_eq!(competed.record.source, NameSource::FreshellAi);
    // The receipt really completed: the cleanup cleared the migrated rows.
    let config = read_config(&home);
    assert!(config["sessionOverrides"]["claude:s99"]
        .as_object()
        .unwrap()
        .get("titleOverride")
        .is_none());
    // The plan's batching rule held: one immutable backup per chunk import.
    let imports_dir = home
        .join(".freshell")
        .join(NAME_MIGRATION_DIR_NAME)
        .join("imports");
    let backups = std::fs::read_dir(&imports_dir)
        .map(|entries| entries.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    assert_eq!(backups, 2, "152 gathered candidates batch into two chunks");
    drop(tmp);
}

/// Task 7 review I1 (sequencing): a boot-lane import acknowledges its
/// candidates WITHOUT completing the receipt — completion is the
/// consolidation runner's FINAL step — so a boot interrupted between
/// chunks leaves the receipt open, and the next boot resumes it: the
/// per-candidate acknowledgment makes the landed chunks no-ops (the
/// record keeps its revision), the remaining chunks land, and only then
/// does the receipt commit.
#[tokio::test]
async fn a_partial_boot_import_resumes_and_completes_on_the_next_boot() {
    let (tmp, home) = fresh_home();
    seed_config(&home, seed_ai_override_rows(150), json!({}));
    let names = open_store(&home).await;

    // An interrupted boot landed its first chunk only: 100 of the gathered
    // candidates imported under the trusted boot lane.
    let chunk: Vec<LegacyNameCandidate> = (0..100).map(gathered_override_candidate).collect();
    names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: NAME_MIGRATION_BOOT_IMPORT_ID.to_string(),
            evidence: vec![],
            candidates: chunk,
        })
        .await
        .unwrap();
    assert!(
        !names.migration_completed(),
        "a boot-lane import acknowledges candidates without completing the receipt"
    );
    let landed = record_of(&names, NamedProvider::Claude, "s0")
        .await
        .unwrap();
    assert_eq!(landed.record.name, "AI 0");
    let landed_revision = landed.record.revision;

    // The next boot resumes: the receipt was open, so the runner re-imports
    // every chunk — the acknowledged candidates are no-ops — and only then
    // completes.
    let settings = Arc::new(store_at(&home));
    let metadata = open_metadata(&home).await;
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    assert!(names.migration_completed(), "the resumed boot completes");
    let unchanged = record_of(&names, NamedProvider::Claude, "s0")
        .await
        .unwrap();
    assert_eq!(
        unchanged.record.revision, landed_revision,
        "an acknowledged candidate never re-applies"
    );
    for session in ["s99", "s100", "s149"] {
        let update = record_of(&names, NamedProvider::Claude, session)
            .await
            .unwrap();
        assert_eq!(update.record.name, format!("AI {}", &session[1..]));
    }
    // The resumed boot's cleanup cleared the migrated rows.
    let config = read_config(&home);
    assert!(config["sessionOverrides"]["claude:s149"]
        .as_object()
        .unwrap()
        .get("titleOverride")
        .is_none());
    drop(tmp);
}

/// Session-metadata `derivedTitle` fields: a genuinely active one becomes a
/// provider-AI fallback candidate and is cleaned from the metadata entry
/// (the entry's other fields survive); an inactive one is untouched.
#[tokio::test]
async fn metadata_derived_titles_migrate_and_clean_up() {
    let (tmp, home) = fresh_home();
    seed_config(&home, json!({}), json!({}));
    // Seed the metadata file BEFORE any store opens it (the store caches).
    {
        let path = home.join(".freshell").join("session-metadata.json");
        let doc = json!({
            "version": 1,
            "sessions": {
                "claude": {
                    "s1": { "sessionType": "freshclaude", "sessionTypeSource": "explicit",
                            "derivedTitle": "Parsed Provider Title" },
                    "s2": { "sessionType": "claude", "sessionTypeSource": "explicit",
                            "derivedTitle": "" }
                }
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    }
    let metadata = open_metadata(&home).await;

    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Parsed Provider Title");
    assert_eq!(update.record.source, NameSource::ProviderAi);

    let path = home.join(".freshell").join("session-metadata.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(doc["sessions"]["claude"]["s1"]
        .get("derivedTitle")
        .is_none());
    assert_eq!(
        doc["sessions"]["claude"]["s1"]["sessionType"],
        json!("freshclaude"),
        "the entry's other fields survive the cleanup"
    );
    drop(tmp);
}

/// Terminal overrides resolve through the identity ledger (live or
/// retired entries, name_ref first) into terminal-scope legacy-protected
/// candidates; unresolvable ones stay recovery-only with their overrides
/// untouched.
#[tokio::test]
async fn terminal_overrides_resolve_through_the_identity_ledger() {
    let (tmp, home) = fresh_home();
    seed_config(
        &home,
        json!({}),
        json!({
            "t-live": { "titleOverride": "Live Terminal Label" },
            "t-gone": { "titleOverride": "Ghost Terminal Label" },
        }),
    );
    let identity = TerminalIdentityRegistry::new();
    // A live scoped terminal with a durable identity (nameRef is minted by
    // the Task 2 create/bind lanes; upsert seeds the raw association the
    // resolver's fallback consumes).
    identity.upsert("t-live", Some("claude"), Some("s1"), None, 1);

    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        identity,
    ))
    .await;

    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Live Terminal Label");
    assert_eq!(update.record.source, NameSource::LegacyProtected);

    let cfg = read_config(&home);
    assert!(cfg["terminalOverrides"]["t-live"]
        .as_object()
        .unwrap()
        .get("titleOverride")
        .is_none());
    assert_eq!(
        cfg["terminalOverrides"]["t-gone"]["titleOverride"],
        json!("Ghost Terminal Label"),
        "an unresolved terminal's override is untouched"
    );
    drop(tmp);
}

/// One source-tab label maps only to its resolved naming-source session: a
/// mixed tab whose first pane is a shell never leaks its label onto a
/// later agent pane, and an explicitly session-named record's tab label
/// follows the persisted `nameSource` pane.
#[tokio::test]
async fn source_tab_label_maps_only_to_its_naming_source_session() {
    let (tmp, home) = fresh_home();
    seed_config(&home, json!({}), json!({}));
    seed_snapshot_device(
        &home,
        "device-mixed",
        vec![
            json!({
                "tabKey": "shell-first", "tabId": "tab-shell-first", "serverInstanceId": "srv",
                "deviceId": "device-mixed", "deviceLabel": "device-mixed",
                "tabName": "Shell Tab Label", "status": "open", "revision": 3,
                "createdAt": 1, "updatedAt": 9, "paneCount": 2,
                "titleSetByUser": true,
                "panes": [
                    { "paneId": "p-shell", "kind": "terminal",
                      "payload": { "kind": "terminal", "mode": "shell",
                                   "terminalId": "t-shell", "createRequestId": "r1" } },
                    { "paneId": "p-agent", "kind": "terminal", "title": "Agent Pane Mirror",
                      "payload": scoped_pane_payload("s-agent") },
                ],
            }),
            json!({
                "tabKey": "agent-owned", "tabId": "tab-agent", "serverInstanceId": "srv",
                "deviceId": "device-mixed", "deviceLabel": "device-mixed",
                "tabName": "Agent Tab Label", "status": "open", "revision": 3,
                "createdAt": 1, "updatedAt": 9, "paneCount": 1,
                "titleSetByUser": true,
                "nameSource": { "kind": "session", "paneId": "p-agent" },
                "panes": [
                    { "paneId": "p-agent", "kind": "terminal",
                      "payload": scoped_pane_payload("s-agent2") },
                ],
            }),
        ],
    );
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;

    // The shell-first tab's label never applied to the agent pane's
    // session — only the agent pane's own mirror title did.
    let agent = record_of(&names, NamedProvider::Claude, "s-agent")
        .await
        .unwrap();
    assert_eq!(agent.record.name, "Agent Pane Mirror");
    // The session-named record's tab label followed its nameSource pane.
    let agent2 = record_of(&names, NamedProvider::Claude, "s-agent2")
        .await
        .unwrap();
    assert_eq!(agent2.record.name, "Agent Tab Label");
    assert_eq!(agent2.record.source, NameSource::LegacyProtected);
    drop(tmp);
}

/// Missing files mean no evidence: a clean home consolidates to an empty
/// receipt without candidates, backups, or cleanup churn.
#[tokio::test]
async fn clean_home_consolidates_to_an_empty_completed_receipt() {
    let (tmp, home) = fresh_home();
    let settings = Arc::new(store_at(&home));
    let names = open_store(&home).await;
    let metadata = open_metadata(&home).await;
    run_session_name_consolidation(consolidation_inputs(
        &home,
        names.clone(),
        settings.clone(),
        metadata.clone(),
        TerminalIdentityRegistry::new(),
    ))
    .await;
    assert!(names.migration_completed());
    let config = read_config(&home);
    assert_eq!(config["sessionOverrides"], json!({}));
    drop(tmp);
}

/// The HTTP route's reserved-id guard: the boot import id is refused from
/// the untrusted lane (see the route tests for the endpoint contract).
#[tokio::test]
async fn untrusted_imports_cannot_honor_explicit_rename_claims() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;
    // Even a candidate claiming explicit_rename + manual through the
    // untrusted lane is downgraded to legacy-protected with unknown origin.
    names
        .import_legacy(browser_import(
            "untrusted",
            vec![candidate(
                "u-1",
                session_target(NamedProvider::Claude, "s1"),
                "Claimed Human Rename",
                NameSource::Manual,
                LegacyCandidateScope::Session,
                "envelope#session",
                LegacyProtectionEvidence::ExplicitRename,
            )],
        ))
        .await
        .unwrap();
    let update = record_of(&names, NamedProvider::Claude, "s1")
        .await
        .unwrap();
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    assert_eq!(
        update.record.legacy_origin,
        Some(freshell_protocol::session_names::LegacyOrigin::Unknown)
    );
    assert_eq!(update.record.manual_revision, None);
    assert_eq!(update.record.renamed_at, None);
    drop(tmp);
}

/// A pending legacy-pane target: the import installs the pending record so
/// the pre-durable name exists before identity, and a later verified bind
/// transfers it atomically (the Task 2 machinery).
#[tokio::test]
async fn pending_targets_install_and_transfer_on_bind() {
    let (tmp, home) = fresh_home();
    let names = open_store(&home).await;
    names
        .import_legacy(browser_import(
            "pending-1",
            vec![candidate(
                "pend-1",
                LegacyNameTarget::Canonical(SessionNameRef::Pending {
                    id: "legacy-pending-handle".into(),
                }),
                "Named Before Identity",
                NameSource::Manual,
                LegacyCandidateScope::Pane,
                "envelope#tab#pane",
                LegacyProtectionEvidence::LegacyFlag,
            )],
        ))
        .await
        .unwrap();
    let updates = names
        .get(vec![SessionNameRef::Pending {
            id: "legacy-pending-handle".into(),
        }])
        .await
        .unwrap();
    let pending = updates.first().unwrap();
    assert_eq!(pending.record.name, "Named Before Identity");
    assert_eq!(pending.record.source, NameSource::LegacyProtected);

    // A verified bind transfers the migrated name to the durable identity.
    names
        .bind_pending(freshell_freshagent::naming::BindNameInput {
            pending: SessionNameRef::Pending {
                id: "legacy-pending-handle".into(),
            },
            target: SessionNameRef::Session {
                provider: NamedProvider::Claude,
                session_id: "durable-1".into(),
            },
            acquisition: freshell_protocol::native_location::NativeAcquisition {
                location: freshell_protocol::native_location::NativeLocation::Claude {
                    config_root: "/tmp/claude-root".to_string(),
                    transcript_path: None,
                    project_directory_key: None,
                    transcript_cwd: None,
                    effective_project_key_override: None,
                },
                evidence: freshell_protocol::native_location::NativeEvidenceKind::PersistedMetadata,
                persistence: freshell_protocol::native_location::NativePersistence::Verified,
            },
        })
        .await
        .unwrap();
    let update = record_of(&names, NamedProvider::Claude, "durable-1")
        .await
        .unwrap();
    assert_eq!(update.record.name, "Named Before Identity");
    assert_eq!(update.record.source, NameSource::LegacyProtected);
    drop(tmp);
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/// The Rust migration envelope round-trips the exact TS wire shapes.
#[test]
fn migration_envelope_round_trips_the_ts_wire_shape() {
    let body = json!({
        "version": 1,
        "importId": "import-1",
        "evidence": [ { "storageKey": "freshell.layout.v3.w1", "raw": "{\"version\":4}" } ],
        "candidates": [
            {
                "id": "[\"freshell.layout.v3.w1\",null,\"t1\",\"p1\",\"pane\",\"claude\",\"s1\",\"Label\",\"legacy_protected\",\"legacy_flag\",null]",
                "target": { "kind": "session", "provider": "claude", "sessionId": "s1" },
                "name": "Label",
                "source": "legacy_protected",
                "scope": "pane",
                "evidenceKey": "freshell.layout.v3.w1#t1#p1",
                "protectionEvidence": "legacy_flag"
            },
            {
                "id": "[\"config\",null,null,null,\"session\",\"codex\",\"s2\",\"Old\",\"manual\",\"explicit_rename\",null]",
                "target": {
                    "kind": "legacy_session",
                    "sessionRef": { "provider": "codex", "sessionId": "s2" },
                    "cwd": "/work"
                },
                "name": "Old",
                "source": "manual",
                "scope": "session",
                "explicitRenameAt": 1234,
                "evidenceKey": "session-override:codex:s2",
                "protectionEvidence": "explicit_rename"
            },
            {
                "id": "[\"config\",null,null,null,\"terminal\",null,null,\"T\",\"legacy_protected\",\"legacy_flag\",null]",
                "target": { "kind": "legacy_terminal", "terminalId": "t-1", "serverInstanceId": "srv" },
                "name": "T",
                "source": "legacy_protected",
                "scope": "terminal",
                "evidenceKey": "terminal-override:t-1",
                "protectionEvidence": "legacy_flag"
            },
        ],
    });
    let parsed: LegacyNameImport = serde_json::from_value(body).unwrap();
    assert_eq!(parsed.import_id, "import-1");
    assert_eq!(parsed.candidates.len(), 3);
    assert!(matches!(
        parsed.candidates[0].target,
        LegacyNameTarget::Canonical(SessionNameRef::Session { .. })
    ));
    assert!(matches!(
        parsed.candidates[1].target,
        LegacyNameTarget::LegacySession { .. }
    ));
    assert_eq!(parsed.candidates[1].explicit_rename_at, Some(1234));
    assert!(matches!(
        parsed.candidates[2].target,
        LegacyNameTarget::LegacyTerminal { .. }
    ));
    // And the result serializes back to the TS shape.
    let result = freshell_protocol::session_names::LegacyImportResult {
        acknowledged: vec!["a".into()],
        names: vec![],
    };
    let out = serde_json::to_value(&result).unwrap();
    assert_eq!(out["acknowledged"], json!(["a"]));
    assert_eq!(out["names"], json!([]));
}

// Silence unused warnings for the fixture map kept for future tests.
#[allow(dead_code)]
fn _unused(_: &HashMap<String, Value>, _: &Map<String, Value>) {}
